"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Banknote, CheckCircle2, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError, api } from "@/lib/http";
import { useT } from "@/lib/i18n/client";

type Action = "workOut" | "pay" | "finish";

/** The simple way of working: the month's one big button — work out, pay or finish — with a question before money moves. */
export function MonthAction({ month, action, again, people, net, size = "lg" }: { month: string; action: Action; again?: boolean; people?: number; net?: string; size?: "md" | "lg" }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);

  async function go() {
    setBusy(true);
    try {
      await api("/api/v1/payroll/month", { body: { month, action } });
      toast(action === "workOut" ? t("easy.payroll.workedOut") : action === "pay" ? t("easy.payroll.paidToast") : t("easy.payroll.finishedToast"));
      setAsk(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "error");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const label = action === "workOut" ? (again ? t("easy.payroll.workOutAgain") : t("easy.payroll.workOut")) : action === "pay" ? t("easy.payroll.payAll") : t("easy.payroll.finishAll");
  const icon = action === "workOut" ? again ? <RefreshCw className="size-4" /> : <Play className="size-5" /> : action === "pay" ? <Banknote className="size-5" /> : <CheckCircle2 className="size-5" />;
  return (
    <>
      <Button variant={again ? "secondary" : "primary"} size={again ? "md" : size} icon={icon} loading={busy && !ask} onClick={() => (action === "workOut" ? go() : setAsk(true))} data-testid={`month-${action}`}>
        {label}
      </Button>
      {action !== "workOut" && (
        <Dialog
          open={ask}
          onClose={() => setAsk(false)}
          closeLabel={t("common.close")}
          title={action === "pay" ? t("easy.payroll.payConfirmTitle") : t("easy.payroll.finishConfirmTitle")}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsk(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" icon={icon} loading={busy} onClick={go} data-testid={`month-${action}-confirm`}>
                {label}
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-700">{action === "pay" ? t("easy.payroll.payConfirm", { people: people ?? 0, net: net ?? "" }) : t("easy.payroll.finishConfirm")}</p>
        </Dialog>
      )}
    </>
  );
}
