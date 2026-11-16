"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Banknote, CheckCircle2, CircleAlert, Clock, Download, FileUp, RefreshCw, Undo2 } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, apiForm } from "@/lib/http";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { RunStatus } from "@/modules/payroll/present";

interface FileInfo {
  id: string;
  status: string;
  fileName: string;
}

interface Props {
  runId: string;
  status: RunStatus;
  can: { run: boolean; pay: boolean; takeBack: boolean; finish: boolean; returnFile: boolean; repay: boolean };
  open: number;
  failed: number;
  people: number;
  net: string;
  bankFile: FileInfo | null;
  files: (FileInfo & { kind: string })[];
  closedAt: string | null;
  returnAt: string | null;
  pension: boolean;
}

/**
 * The simple way of working: what to do next with this bill, in one card — work it out again, pay it, download the
 * bank file, finish. One dark button at a time.
 */
export function SimplePanel(p: Props) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"pay" | "finish" | "takeBack" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function call(key: string, url: string, body: unknown, ok: string) {
    setBusy(key);
    try {
      await api(url, { body });
      toast(ok);
      setConfirm(null);
      router.refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "error");
      // A bill approved whose bank file could not be made shows its next step.
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function uploadReturn(file: File) {
    setBusy("return");
    const form = new FormData();
    form.set("file", file);
    try {
      const res = await apiForm<{ failed: number; credited: number }>(`/api/v1/payroll/runs/${p.runId}/return-file`, form);
      toast(t("payroll.actions.returnRead", { failed: res.failed, credited: res.credited }));
      router.refresh();
    } catch (err) {
      toast(err instanceof ApiError ? (err.fields.file ?? err.message) : t("errors.generic"), "error");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const base = `/api/v1/payroll/runs/${p.runId}`;
  const rerun = p.can.run && (
    <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === "rerun"} onClick={() => call("rerun", `${base}/rerun`, {}, p.pension ? t("pension.bills.runDone") : t("easy.payroll.workedOut"))}>
      {t("easy.payroll.workOutAgain")}
    </Button>
  );
  const takeBack = p.can.takeBack && (
    <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setConfirm("takeBack")}>
      {t("easy.payroll.takeBack")}
    </Button>
  );
  const downloadHref = p.bankFile && (p.bankFile.status === "APPROVED" || p.bankFile.status === "DOWNLOADED") ? `/api/v1/files/${p.bankFile.id}/download` : null;

  let tone: "ready" | "fix" | "wait" | "done" = "wait";
  let title = "";
  let help = "";
  let actions: React.ReactNode = null;
  let extra: React.ReactNode = null;

  if (p.status === "DRAFT") {
    if (!p.can.run) {
      title = t("easy.payroll.notYours");
    } else if (p.open > 0) {
      tone = "fix";
      title = t("easy.payroll.draftFixTitle", { count: p.open });
      help = t("easy.payroll.draftFixHelp");
      actions = rerun;
    } else {
      tone = "ready";
      title = t("easy.payroll.draftReadyTitle");
      help = t("easy.payroll.draftReadyHelp");
      actions = (
        <>
          {rerun}
          <Button variant="primary" size="lg" icon={<Banknote className="size-5" />} disabled={!p.can.pay} onClick={() => setConfirm("pay")} data-testid="pay-button">
            {t("easy.payroll.payAll")}
          </Button>
        </>
      );
    }
  } else if (p.status === "CHECKING" || p.status === "APPROVING") {
    title = t("easy.payroll.waitingTitle");
    help = p.can.takeBack ? t("easy.payroll.waitingHelp") : "";
    actions = p.can.takeBack && (
      <Button variant="primary" icon={<Undo2 className="size-4" />} loading={busy === "takeBack"} onClick={() => call("takeBack", `${base}/take-back`, {}, t("easy.payroll.takenBack"))}>
        {t("easy.payroll.takeBack")}
      </Button>
    );
  } else if (p.status === "APPROVED") {
    tone = "fix";
    title = t("easy.payroll.approvedTitle");
    help = t("easy.payroll.approvedHelp");
    actions = (
      <>
        {takeBack}
        {p.can.pay && (
          <Button variant="primary" icon={<Banknote className="size-4" />} loading={busy === "pay"} onClick={() => call("pay", `${base}/pay`, {}, t("easy.payroll.paidToast"))}>
            {t("easy.payroll.makeBank")}
          </Button>
        )}
      </>
    );
  } else if (p.status === "PAID") {
    tone = p.failed > 0 ? "fix" : "ready";
    title = t("easy.payroll.paidTitle");
    help = p.failed > 0 ? t("easy.payroll.failedCount", { count: p.failed }) : t("easy.payroll.paidHelp");
    const repayFiles = p.files.filter((f) => f.kind === "bank.repay" && (f.status === "APPROVED" || f.status === "DOWNLOADED"));
    actions = (
      <>
        {takeBack}
        {downloadHref && (
          <a href={downloadHref} download className={buttonClass("secondary", "lg")} data-testid="bank-download">
            <Download className="size-5" aria-hidden="true" /> {t("easy.payroll.download")}
          </a>
        )}
        {p.failed > 0 && p.can.repay ? (
          <Button variant="primary" size="lg" icon={<Banknote className="size-5" />} loading={busy === "repay"} onClick={() => call("repay", `${base}/repay-file`, {}, t("payroll.actions.repayMade"))}>
            {t("easy.payroll.repay")}
          </Button>
        ) : (
          <Button variant="primary" size="lg" icon={<CheckCircle2 className="size-5" />} disabled={!p.can.finish} onClick={() => setConfirm("finish")} data-testid="finish-button">
            {t("easy.payroll.finish")}
          </Button>
        )}
      </>
    );
    extra = (
      <>
        {repayFiles.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-2">
            {repayFiles.map((f) => (
              <li key={f.id}>
                <a href={`/api/v1/files/${f.id}/download`} download className={buttonClass("secondary", "sm")}>
                  <Download className="size-4" aria-hidden="true" /> {f.fileName}
                </a>
              </li>
            ))}
          </ul>
        )}
        {p.can.returnFile && (
          <details className="mt-4 rounded-xl border border-ink-200 bg-white/70 px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-ink-800">{t("easy.payroll.failedOpen")}</summary>
            <p className="mt-2 text-ink-600">{t("easy.payroll.failedHelp")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input ref={fileInput} type="file" accept=".csv,.xlsx" className="sr-only" id="return-file" onChange={(e) => e.target.files?.[0] && uploadReturn(e.target.files[0])} />
              <label htmlFor="return-file" className={buttonClass("secondary", "sm", busy === "return" ? "pointer-events-none opacity-60" : "cursor-pointer")}>
                <FileUp className="size-4" aria-hidden="true" /> {t("payroll.actions.returnUpload")}
              </label>
              <a href="/api/v1/payroll/return-template" download className={buttonClass("ghost", "sm")}>
                <Download className="size-4" aria-hidden="true" /> {t("payroll.actions.returnTemplate")}
              </a>
            </div>
          </details>
        )}
      </>
    );
  } else {
    tone = "done";
    title = t("easy.payroll.closedTitle");
    help = p.closedAt ? t("easy.payroll.closedHelp", { date: p.closedAt }) : "";
    const summary = p.files.find((f) => f.kind === "accounts.summary" && (f.status === "APPROVED" || f.status === "DOWNLOADED"));
    actions = (
      <>
        {downloadHref && (
          <a href={downloadHref} download className={buttonClass("secondary")}>
            <Download className="size-4" aria-hidden="true" /> {t("easy.payroll.bankFile")}
          </a>
        )}
        {summary && (
          <a href={`/api/v1/files/${summary.id}/download`} download className={buttonClass("secondary")}>
            <Download className="size-4" aria-hidden="true" /> {t("easy.payroll.summary")}
          </a>
        )}
      </>
    );
  }

  const Icon = tone === "done" ? CheckCircle2 : tone === "fix" ? CircleAlert : tone === "ready" ? Banknote : Clock;
  return (
    <section
      data-testid="simple-panel"
      className={cn(
        "rounded-2xl border px-5 py-5 shadow-card sm:px-6",
        tone === "fix" ? "border-amber-200 bg-amber-50/70" : tone === "ready" ? "border-brand-200 bg-brand-50/60" : tone === "done" ? "border-brand-200 bg-white" : "border-ink-200 bg-white",
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className={cn("mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl", tone === "fix" ? "bg-amber-100 text-amber-800" : tone === "wait" ? "bg-ink-100 text-ink-600" : "bg-brand-100 text-brand-800")} aria-hidden="true">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink-950">{title}</h2>
            {help && <p className="mt-0.5 max-w-2xl text-sm text-ink-700">{help}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">{actions}</div>}
      </div>
      {extra}

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        closeLabel={t("common.close")}
        title={confirm === "pay" ? t("easy.payroll.payConfirmTitle") : confirm === "finish" ? t("easy.payroll.finishConfirmTitle") : t("easy.payroll.takeBack")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </Button>
            {confirm === "pay" && (
              <Button variant="primary" icon={<Banknote className="size-4" />} loading={busy === "pay"} onClick={() => call("pay", `${base}/pay`, {}, t("easy.payroll.paidToast"))} data-testid="pay-confirm">
                {t("easy.payroll.payAll")}
              </Button>
            )}
            {confirm === "finish" && (
              <Button variant="primary" icon={<CheckCircle2 className="size-4" />} loading={busy === "finish"} onClick={() => call("finish", `${base}/finish`, {}, t("easy.payroll.finishedToast"))} data-testid="finish-confirm">
                {t("easy.payroll.finish")}
              </Button>
            )}
            {confirm === "takeBack" && (
              <Button variant="danger" icon={<Undo2 className="size-4" />} loading={busy === "takeBack"} onClick={() => call("takeBack", `${base}/take-back`, {}, t("easy.payroll.takenBack"))}>
                {t("easy.payroll.takeBack")}
              </Button>
            )}
          </>
        }
      >
        <p className="text-sm text-ink-700">
          {confirm === "pay" ? t("easy.payroll.payConfirm", { people: p.people, net: p.net }) : confirm === "finish" ? t("easy.payroll.finishConfirm") : t("easy.payroll.takeBackConfirm")}
        </p>
      </Dialog>
    </section>
  );
}
