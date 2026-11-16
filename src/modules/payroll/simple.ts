import "server-only";
import { approveDirectly } from "@/lib/approvals/engine";
import { audit } from "@/lib/audit";
import { canAll, isFullAdmin } from "@/lib/auth/access";
import type { Actor } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { isMonth, todayIST } from "@/lib/dates";
import { AppError, badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import { formatINR } from "@/lib/money";
import { emit } from "@/lib/outbox";
import { recordGpf, undoGpf } from "@/modules/statutory/gpf-posting";
import { fnOf, recordLoanRecoveries, RUN_GROUPS, titleOf, undoLoanRecoveries } from "./compute";
import { buildSalaryBankFile, closeRun, markAllCredited } from "./pay";
import { sendPayslipNotices } from "./payslips";
import { runPayroll } from "./run";
import { onSettlementBillApproved, onSettlementBillReopened } from "./settlement-bill";

/**
 * The simple way of working (Settings → How work is approved → Simple): the Accounts manager does the month alone,
 * in three steps.
 *
 *   1 Work out   every pay group of the month in one go (`workOutMonth`), as often as needed.
 *   2 Review     the pre-checks are settled with one click each (hold the pay, or pay it).
 *   3 Pay        `payRun` approves the bill, makes the bank file and releases it — no Checker, no OTP. Until the
 *                month is finished it can be taken back (`takeBackRun`) if the file has not gone to the bank.
 *                `finishRun` records that the money reached everyone, sends the payslips and closes the bill.
 *
 * The bills, the pay engine, the prints, the bank file and the books are the same as in the two-step way; only who
 * presses the buttons differs. Failed credits keep the usual tools (return file, re-pay file).
 */

const num = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

function assertSimple(actor: Actor) {
  if (!actor.simple) throw forbidden("payroll.errors.simpleOnly");
}

async function loadOwnRun(actor: Actor, runId: string) {
  const run = await db.payrollRun.findFirst({ where: { id: runId, boardId: actor.boardId } });
  if (!run) throw notFound();
  if (!canAll(actor, fnOf(run.payGroup), "create")) throw forbidden();
  return run;
}

/** Step 1: works out every staff pay group of the month that is not yet approved. Groups with nobody are left out. */
export async function workOutMonth(actor: Actor, month: string) {
  assertSimple(actor);
  if (!canAll(actor, "payroll", "create")) throw forbidden();
  if (!isMonth(month)) throw badRequest("errors.validation", { month: "validation.invalid" });
  if (month > todayIST().slice(0, 7)) throw badRequest("errors.validation", { month: "payroll.errors.futureMonth" });
  const existing = await db.payrollRun.findMany({ where: { boardId: actor.boardId, month, kind: "REGULAR", payGroup: { in: [...RUN_GROUPS] } }, select: { payGroup: true, status: true } });
  const done: { payGroup: string; id: string }[] = [];
  for (const group of RUN_GROUPS) {
    const run = existing.find((r) => r.payGroup === group);
    if (run && run.status !== "DRAFT") continue;
    try {
      const saved = await runPayroll(actor, { payGroup: group, month });
      done.push({ payGroup: group, id: saved.id });
    } catch (e) {
      // A pay group with nobody on its rolls is not an error for the month.
      if (e instanceof AppError && e.key === "payroll.errors.nobody") continue;
      throw e;
    }
  }
  if (!done.length && !existing.length) throw badRequest("payroll.errors.nobody");
  return { runs: done };
}

/** Step 3: approve and pay in one step. The bank file is ready to download when this returns. */
export async function payRun(actor: Actor, runId: string) {
  assertSimple(actor);
  const before = await loadOwnRun(actor, runId);
  // A bill approved a moment ago whose bank file could not be made (a missing bank account) carries on from there.
  if (before.status !== "DRAFT" && before.status !== "APPROVED") throw conflict("payroll.errors.notDraft");
  if (before.status === "DRAFT") {
    await db.$transaction(
      async (tx) => {
        const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
        if (run.status !== "DRAFT") throw conflict("payroll.errors.notDraft");
        const open = await tx.payrollException.count({ where: { runId, resolution: null } });
        if (open) throw badRequest("payroll.errors.openExceptions", undefined, { count: open });
        if (run.employees === 0) throw badRequest("payroll.errors.nobody");
        const now = new Date();
        await tx.payrollRun.update({
          where: { id: runId },
          data: { status: "APPROVED", submittedAt: now, checkedById: actor.userId, checkedByName: actor.name, approvedById: actor.userId, approvedByName: actor.name, approvedAt: now },
        });
        await recordLoanRecoveries(tx, runId);
        await recordGpf(tx, runId, actor.userId);
        await onSettlementBillApproved(tx, run, actor);
        await audit(tx, actor, { action: "APPROVE", entityType: "PayrollRun", entityId: runId, summary: `Approved for payment: ${titleOf(run)} (net ${formatINR(num(run.net))})` });
        await emit(tx, run.boardId, "payroll.approved", { type: "PayrollRun", id: runId }, { month: run.month, payGroup: run.payGroup, net: num(run.net) });
      },
      { timeout: 60_000 },
    );
  }
  // The bank file is built and released at once: its release marks the bill as paid (the usual hook).
  const existing = before.bankFileId ? await db.fileRecord.findUnique({ where: { id: before.bankFileId } }) : null;
  let waiting = existing && existing.status !== "REJECTED" ? existing : null;
  if (waiting && waiting.status === "PREVIEW" && waiting.createdById !== actor.userId && !isFullAdmin(actor)) {
    // A file somebody else built in the two-step way and nobody released: this person's own takes its place.
    const stale = waiting.id;
    await db.$transaction(async (tx) => {
      await tx.fileRecord.update({ where: { id: stale }, data: { status: "REJECTED" } });
      await tx.approvalTask.updateMany({ where: { entityType: "FileRecord", entityId: stale, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: new Date() } });
    });
    waiting = null;
  }
  const file = waiting ?? (await buildSalaryBankFile(actor, runId));
  const task = await db.approvalTask.findFirst({ where: { boardId: actor.boardId, entityType: "FileRecord", entityId: file.id, status: "PENDING" }, select: { id: true } });
  if (task) await approveDirectly(actor, [task.id]);
  return { id: runId, bankFileId: file.id };
}

/**
 * Takes a paid bill back to a draft — for a mistake seen before the bank file went to the bank. Possible until the
 * month is finished; nothing has gone out to employees yet (payslips are sent when the month is finished).
 */
export async function takeBackRun(actor: Actor, runId: string) {
  assertSimple(actor);
  await loadOwnRun(actor, runId);
  return db.$transaction(async (tx) => {
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status === "CHECKING" || run.status === "APPROVING") {
      // A bill left half-way in the two-step way: its waiting step is withdrawn.
      await tx.approvalTask.updateMany({ where: { boardId: run.boardId, entityType: "PayrollRun", entityId: runId, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: new Date() } });
      await tx.payrollRun.update({ where: { id: runId }, data: { status: "DRAFT", submittedAt: null, checkedById: null, checkedByName: null } });
      await audit(tx, actor, { action: "REOPEN", entityType: "PayrollRun", entityId: runId, summary: `Took back ${titleOf(run)} to review it again` });
      return;
    }
    if ((run.status !== "APPROVED" && run.status !== "PAID") || run.returnAt) throw conflict("payroll.errors.cannotTakeBack");
    if (run.bankFileId) {
      await tx.fileRecord.update({ where: { id: run.bankFileId }, data: { status: "REJECTED" } });
      await tx.approvalTask.updateMany({ where: { entityType: "FileRecord", entityId: run.bankFileId, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: new Date() } });
    }
    await undoLoanRecoveries(tx, runId);
    await undoGpf(tx, runId);
    await onSettlementBillReopened(tx, run);
    await tx.payrollRun.update({
      where: { id: runId },
      data: { status: "DRAFT", reopenedAt: new Date(), reopenNote: null, approvedById: null, approvedByName: null, approvedAt: null, submittedAt: null, checkedById: null, checkedByName: null, bankFileId: null, paidAt: null },
    });
    await audit(tx, actor, { action: "REOPEN", entityType: "PayrollRun", entityId: runId, summary: `Took back ${titleOf(run)} before the bank file was used` });
    await emit(tx, actor.boardId, "payroll.reopened", { type: "PayrollRun", id: runId }, { note: "taken back" });
  });
}

/**
 * The money has reached everyone: records it, sends the payslips (SMS link and email) and closes the bill with its
 * accounting summary. A bill with failed credits is finished from the bank's return file instead.
 */
export async function finishRun(actor: Actor, runId: string) {
  assertSimple(actor);
  const run = await loadOwnRun(actor, runId);
  if (run.status !== "PAID") throw conflict("payroll.errors.wrongStage");
  if (!run.returnAt) await markAllCredited(actor, runId);
  const summary = await closeRun(actor, runId);
  const task = await db.approvalTask.findFirst({ where: { boardId: actor.boardId, entityType: "FileRecord", entityId: summary.id, status: "PENDING" }, select: { id: true } });
  if (task) await approveDirectly(actor, [task.id]);
  await sendPayslipNotices(run.boardId, runId).catch((e) => console.error("[payroll] payslip notices failed", e));
  return { id: runId };
}

/** Pays every bill of the month that is ready (worked out, nothing left to fix). */
export async function payMonth(actor: Actor, month: string) {
  assertSimple(actor);
  if (!canAll(actor, "payroll", "create")) throw forbidden();
  const runs = await db.payrollRun.findMany({ where: { boardId: actor.boardId, month, status: "DRAFT", payGroup: { in: [...RUN_GROUPS] }, employees: { gt: 0 } }, orderBy: [{ kind: "asc" }, { payGroup: "asc" }, { seq: "asc" }] });
  const paid: string[] = [];
  for (const r of runs) {
    if (await db.payrollException.count({ where: { runId: r.id, resolution: null } })) continue;
    await payRun(actor, r.id);
    paid.push(r.id);
  }
  if (!paid.length) throw badRequest("payroll.errors.nothingReady");
  return { paid: paid.length };
}

/** Finishes every paid bill of the month that has no failed credit waiting. */
export async function finishMonth(actor: Actor, month: string) {
  assertSimple(actor);
  if (!canAll(actor, "payroll", "create")) throw forbidden();
  const runs = await db.payrollRun.findMany({ where: { boardId: actor.boardId, month, status: "PAID", payGroup: { in: [...RUN_GROUPS] } } });
  let finished = 0;
  for (const r of runs) {
    if (await db.payslip.count({ where: { runId: r.id, creditStatus: "FAILED", repayFileId: null } })) continue;
    await finishRun(actor, r.id);
    finished++;
  }
  if (!finished) throw badRequest("payroll.errors.nothingReady");
  return { finished };
}
