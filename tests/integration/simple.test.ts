import { beforeAll, describe, expect, it } from "vitest";
import { collectSubmitted } from "@/lib/approvals/direct";
import { approveDirectly, countInbox, decide } from "@/lib/approvals/engine";
import "@/lib/approvals";
import { FILE_RELEASE, KIND_FN } from "@/lib/approvals/areas";
import { listApprovalKinds } from "@/lib/approvals/registry";
import { seal } from "@/lib/crypto";
import { db } from "@/lib/db";
import { datesOfMonth, shiftMonth, todayIST } from "@/lib/dates";
import { addServiceEntry, submitSelfRequest } from "@/modules/employees/records";
import { proposePayItem, proposeRate } from "@/modules/payroll/rates";
import { getRun, resolveException } from "@/modules/payroll/run";
import { finishRun, payRun, takeBackRun, workOutMonth } from "@/modules/payroll/simple";
import { getSetting, updateSetting } from "@/modules/settings/service";
import { isSimpleWorkflow } from "@/modules/settings/workflow";
import { seedPayrollRules } from "../../prisma/seed-payroll";
import { actorFor, hasTestDb, makeBoard, makeEmployee, makePost, makeSection, makeUser } from "../support/factory";

type Actor = Awaited<ReturnType<typeof actorFor>>;

/** What a request does: run the service, then finish what the person may decide themselves (lib/api/route.ts). */
async function asRequest<T>(actor: Actor, work: () => Promise<T>) {
  const { result, taskIds } = await collectSubmitted(work);
  const applied = await approveDirectly(actor, taskIds);
  return { result, applied };
}

describe.skipIf(!hasTestDb)("the simple way of working (Settings → How work is approved)", () => {
  const simple = (a: Actor): Actor => ({ ...a, simple: true });
  let boardId: string;
  let sectionId: string;
  let postId: string;
  let admin: Actor;
  let hr: Actor;
  let accounts: Actor;
  let it_: Actor;
  let month = "";
  const paid: string[] = [];

  async function paidEmployee(key: string, bank: string) {
    const b = seal("bank", bank);
    const e = await db.employee.create({
      data: {
        boardId,
        employeeCode: `SMP${key}${Date.now().toString(36).toUpperCase()}`,
        type: "PERMANENT_OPS",
        status: "ACTIVE",
        firstName: "Simple",
        lastName: key,
        gender: "F",
        dateOfBirth: new Date("1986-06-06T00:00:00Z"),
        dateOfJoining: new Date("2013-01-01T00:00:00Z"),
        dateOfRetirement: new Date("2046-06-30T00:00:00Z"),
        sectionId,
        postId,
        payLevel: "6",
        payCell: 1,
        bankAccountEnc: b.enc,
        bankAccountHash: b.hash,
        bankAccountLast4: b.last4,
        ifsc: "SBIN0001234",
        mobile: null,
      },
    });
    paid.push(e.id);
    return e;
  }

  beforeAll(async () => {
    boardId = (await makeBoard()).id;
    await seedPayrollRules(db, boardId);
    sectionId = (await makeSection(boardId)).id;
    postId = (await makePost(boardId, "6")).id;
    // Bank accounts are unique across the Board, and every test file shares it.
    const stamp = String(Date.now()).slice(-9);
    const own = await paidEmployee("A", `41${stamp}01`);
    await paidEmployee("B", `41${stamp}02`);
    admin = simple(await actorFor((await makeUser(boardId, "ADMIN", ["APPROVER", "PAY_BILL_SIGNER"], own.id)).id));
    hr = simple(await actorFor((await makeUser(boardId, "HR_ACCOUNTS", ["HR"])).id));
    accounts = simple(await actorFor((await makeUser(boardId, "HR_ACCOUNTS", ["PAYROLL", "PENSION"], paid[1])).id));
    it_ = simple(await actorFor((await makeUser(boardId, "ADMIN", ["USER_SETTINGS_MANAGER"])).id));
    // A month no other test has run for this pay group.
    month = shiftMonth(todayIST().slice(0, 7), -2);
    while (await db.payrollRun.findFirst({ where: { boardId, month, payGroup: "OPS" } })) month = shiftMonth(month, -1);
    const last = shiftMonth(month, -1);
    const dim = datesOfMonth(last).length;
    await db.attendanceLock.upsert({ where: { boardId_sectionId_month: { boardId, sectionId, month: last } }, create: { boardId, sectionId, month: last, lockedById: "test", lockedByName: "Test" }, update: {} });
    for (const id of paid) {
      await db.attendanceMonth.create({ data: { boardId, employeeId: id, sectionId, month: last, daysInMonth: dim, daysOnRoll: dim, present: dim, late: 0, halfDays: 0, onDuty: 0, leave: 0, holidays: 0, weeklyOffs: 0, diesNon: 0, payableDays: dim, workedDays: dim } });
    }
  });

  it("is the default, and the Admin can switch to two steps and back", async () => {
    expect((await getSetting(boardId, "workflow")).mode).toBe("simple");
    expect(await isSimpleWorkflow(boardId)).toBe(true);
    await expect(updateSetting(hr, "workflow", { mode: "twoStep" })).rejects.toMatchObject({ status: 403 });
    await updateSetting({ ...admin, simple: false }, "workflow", { mode: "twoStep" });
    expect(await isSimpleWorkflow(boardId)).toBe(false);
    await updateSetting(it_, "workflow", { mode: "simple" });
    expect(await isSimpleWorkflow(boardId)).toBe(true);
  });

  it("knows whose desk every kind of approval belongs to", () => {
    const kinds = listApprovalKinds();
    expect(kinds.length).toBeGreaterThan(40);
    for (const kind of kinds) expect(kind === FILE_RELEASE || kind in KIND_FN, kind).toBe(true);
    for (const kind of Object.keys(KIND_FN)) expect(kinds, kind).toContain(kind);
  });

  it("what the HR manager enters counts at once — a promotion passes both of its steps", async () => {
    const e = await makeEmployee(boardId, { sectionId, postId });
    const { result: entry, applied } = await asRequest(hr, () => addServiceEntry(hr, e.id, { event: "PROMOTION", eventDate: "2026-07-01", orderNumber: "DCB/EST/91", details: "Promoted" }));
    expect(applied).toBe(2);
    expect((await db.serviceBookEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe("APPROVED");
    const tasks = await db.approvalTask.findMany({ where: { entityId: entry.id } });
    expect(tasks.map((t) => t.status)).toEqual(["APPROVED", "APPROVED"]);
    expect(tasks.every((t) => t.deciderId === hr.userId)).toBe(true);
  });

  it("in the two-step way the same entry waits for a Checker", async () => {
    const e = await makeEmployee(boardId, { sectionId, postId });
    const twoStep = { ...hr, simple: false };
    const { result: entry, applied } = await asRequest(twoStep, () => addServiceEntry(twoStep, e.id, { event: "PROMOTION", eventDate: "2026-07-01", orderNumber: "DCB/EST/92", details: "Promoted" }));
    expect(applied).toBe(0);
    expect((await db.serviceBookEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe("PENDING");
    const task = await db.approvalTask.findFirstOrThrow({ where: { entityId: entry.id, status: "PENDING" } });
    await expect(decide(twoStep, task.id, "APPROVE")).rejects.toMatchObject({ key: "errors.forbidden" });
  });

  it("an employee's request waits for the HR manager, whose approval is the last word", async () => {
    const e = await makeEmployee(boardId, { sectionId, postId });
    const staff = simple(await actorFor((await makeUser(boardId, "EMPLOYEE", [], e.id)).id));
    const before = await countInbox(hr);
    const asked = await asRequest(staff, () => submitSelfRequest(staff, { kind: "bank", bankAccount: `52${String(Date.now()).slice(-8)}9999`, ifsc: "SBIN0001234", bankName: "SBI" }));
    expect(asked.applied).toBe(0);
    expect(await countInbox(hr)).toBe(before + 1);
    const task = await db.approvalTask.findFirstOrThrow({ where: { kind: "employee.self_request", subjectEmployeeId: e.id, status: "PENDING" } });
    // HR approves: the bank change's second step (a Checker in the two-step way) is decided there and then.
    const decided = await asRequest(hr, () => decide(hr, task.id, "APPROVE"));
    expect(decided.applied).toBe(1);
    expect((await db.employee.findUniqueOrThrow({ where: { id: e.id } })).bankAccountLast4).toBe("9999");
    // The Accounts manager does not decide requests about employee records.
    expect(await db.approvalTask.count({ where: { subjectEmployeeId: e.id, status: "PENDING" } })).toBe(0);
  });

  it("what is not a manager's own desk still waits for the one whose desk it is", async () => {
    const proposed = await asRequest(hr, () => proposeRate(hr, { key: "HRA_PERCENT", value: 27, effectiveFrom: "2027-01-01", note: "HRA order" }));
    expect(proposed.applied).toBe(0);
    await expect(decide(hr, proposed.result.id, "APPROVE")).rejects.toMatchObject({ status: 403 });
    await decide(accounts, proposed.result.id, "APPROVE");
    expect(await db.payRate.count({ where: { boardId, key: "HRA_PERCENT", value: 27 } })).toBe(1);
  });

  it("only the Admin decides about their own pay", async () => {
    const m = todayIST().slice(0, 7);
    await expect(proposePayItem(accounts, { employeeId: paid[1], headCode: "LICENCE", amount: 500, fromMonth: m })).rejects.toMatchObject({ key: "errors.ownPay" });
    const mine = await asRequest(admin, () => proposePayItem(admin, { employeeId: paid[0], headCode: "LICENCE", amount: 500, fromMonth: m }));
    expect(mine.applied).toBe(1);
    expect(await db.employeePayItem.count({ where: { employeeId: paid[0], headCode: "LICENCE" } })).toBe(1);
    // The other person's pay item is the Accounts manager's own entry: it counts at once.
    const other = await asRequest(accounts, () => proposePayItem(accounts, { employeeId: paid[0], headCode: "SOCIETY", amount: 300, fromMonth: m }));
    expect(other.applied).toBe(1);
  });

  it("the Accounts manager works out, pays, takes back and finishes a month alone", async () => {
    const worked = await workOutMonth(accounts, month);
    const runId = worked.runs.find((r) => r.payGroup === "OPS")!.id;
    // Everything the pre-checks ask about people of other tests is settled with one choice each.
    for (const r of worked.runs) {
      const data = await getRun(accounts, r.id);
      for (const x of data.exceptions.filter((x) => !x.resolution)) {
        const mine = x.employeeId && paid.includes(x.employeeId);
        await resolveException(admin, r.id, x.id, { resolution: mine ? x.allowed[0] : x.allowed.includes("WITHHELD") ? "WITHHELD" : x.allowed[0], note: "Settled for the test" });
      }
    }
    const draft = await getRun(accounts, runId);
    expect(draft.can).toMatchObject({ simple: true, pay: true, finish: false });
    expect(draft.people.filter((p) => paid.includes(p.employeeId) && p.status === "INCLUDED")).toHaveLength(2);

    // Not in the two-step way: there the bill goes to a Checker and an Admin signs it with an OTP.
    await expect(payRun({ ...accounts, simple: false }, runId)).rejects.toMatchObject({ key: "payroll.errors.simpleOnly" });
    await expect(payRun(hr, runId)).rejects.toMatchObject({ status: 403 });

    await payRun(accounts, runId);
    let run = await db.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: "PAID", approvedById: accounts.userId, payslipsSentAt: null });
    const file = await db.fileRecord.findUniqueOrThrow({ where: { id: run.bankFileId! } });
    expect(file.status).toBe("APPROVED");
    expect(await db.approvalTask.count({ where: { entityType: "PayrollRun", entityId: runId } })).toBe(0);

    // A mistake seen before the file went to the bank: back to a draft, the file cancelled.
    await takeBackRun(accounts, runId);
    run = await db.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: "DRAFT", bankFileId: null, approvedById: null });
    expect((await db.fileRecord.findUniqueOrThrow({ where: { id: file.id } })).status).toBe("REJECTED");

    await payRun(accounts, runId);
    const paidView = await getRun(accounts, runId);
    expect(paidView.can).toMatchObject({ pay: false, takeBack: true, finish: true });
    await finishRun(accounts, runId);
    run = await db.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("CLOSED");
    expect(run.payslipsSentAt).not.toBeNull();
    expect((await db.fileRecord.findUniqueOrThrow({ where: { id: run.summaryFileId! } })).status).toBe("APPROVED");
    expect(await db.payslip.count({ where: { runId, status: "INCLUDED", creditStatus: "CREDITED" } })).toBe(run.employees);
    await expect(takeBackRun(accounts, runId)).rejects.toMatchObject({ key: "payroll.errors.cannotTakeBack" });
  });
});
