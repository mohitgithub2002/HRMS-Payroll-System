"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ApiError, api } from "@/lib/http";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Mode = "simple" | "twoStep";

/** Settings → How work is approved: the simple way (one person per desk) or the two-step way (maker and checker). */
export function WorkflowCard({ initial, readOnly }: { initial: Mode; readOnly: boolean }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initial);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api("/api/v1/settings/workflow", { method: "PUT", body: { mode } });
      toast(t("easy.workflow.saved"));
      // The menu, the wording and everyone's rights follow the choice: load the page afresh.
      window.location.reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "error");
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <Card className="mb-6" data-testid="workflow-card">
      <CardHeader title={t("easy.workflow.title")} description={readOnly ? t("easy.workflow.readOnly") : t("easy.workflow.help")} icon={<Workflow className="size-4.5" aria-hidden="true" />} />
      <CardBody>
        <fieldset className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <legend className="sr-only">{t("easy.workflow.title")}</legend>
          {(["simple", "twoStep"] as const).map((m) => (
            <label key={m} className={cn("flex cursor-pointer gap-3 rounded-xl border px-4 py-3 transition-colors", mode === m ? "border-brand-500 bg-brand-50/60 ring-2 ring-brand-100" : "border-ink-200 hover:border-ink-300", readOnly && "pointer-events-none")}>
              <input type="radio" name="workflow" className="mt-1 accent-brand-700" checked={mode === m} disabled={readOnly} onChange={() => setMode(m)} />
              <span>
                <span className="block text-sm font-semibold text-ink-900">{t(`easy.workflow.${m}`)}</span>
                <span className="block text-sm text-ink-600">{t(`easy.workflow.${m}Help`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </CardBody>
      {!readOnly && (
        <CardFooter>
          <Button variant="primary" loading={busy} disabled={mode === initial} onClick={save}>
            {t("common.save")}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
