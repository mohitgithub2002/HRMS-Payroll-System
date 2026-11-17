"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileText, Sparkles, TriangleAlert } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ApiError, api } from "@/lib/http";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Audience = "off" | "staff" | "everyone";

/** Settings → Ask: who may ask questions in plain words. What each person can be told is decided by their login, not here. */
export function AskCard({ initial, readOnly, configured, roleReady, canWriteDocs }: { initial: Audience; readOnly: boolean; configured: boolean; roleReady: boolean; canWriteDocs: boolean }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const [audience, setAudience] = useState<Audience>(initial);
  const [saved, setSaved] = useState<Audience>(initial);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api("/api/v1/settings/ask", { method: "PUT", body: { audience } });
      setSaved(audience);
      toast(t("ask.setting.saved"));
      router.refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6" data-testid="ask-card">
      <CardHeader
        title={t("ask.setting.title")}
        description={readOnly ? t("ask.setting.readOnly") : t("ask.setting.help")}
        icon={<Sparkles className="size-4.5" aria-hidden="true" />}
        actions={
          canWriteDocs ? (
            <LinkButton href="/ask/documents" size="sm" icon={<FileText className="size-4" aria-hidden="true" />}>
              {t("ask.setting.documents")}
            </LinkButton>
          ) : undefined
        }
      />
      <CardBody>
        {(!configured || !roleReady) && (
          <p className="mb-4 flex items-start gap-2 rounded-xl border border-gold-500/30 bg-gold-50 px-3 py-2 text-sm text-gold-600" role="status">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{!configured ? t("ask.setting.keyMissing") : t("ask.setting.roleMissing")}</span>
          </p>
        )}
        <fieldset className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <legend className="sr-only">{t("ask.setting.title")}</legend>
          {(["everyone", "staff", "off"] as const).map((a) => (
            <label key={a} className={cn("flex cursor-pointer gap-3 rounded-xl border px-4 py-3 transition-colors", audience === a ? "border-brand-500 bg-brand-50/60 ring-2 ring-brand-100" : "border-ink-200 hover:border-ink-300", readOnly && "pointer-events-none")}>
              <input type="radio" name="ask-audience" className="mt-1 accent-brand-700" checked={audience === a} disabled={readOnly} onChange={() => setAudience(a)} />
              <span>
                <span className="block text-sm font-semibold text-ink-900">{t(`ask.setting.${a}`)}</span>
                <span className="block text-sm text-ink-600">{t(`ask.setting.${a}Help`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </CardBody>
      {!readOnly && (
        <CardFooter>
          <Button loading={busy} disabled={audience === saved} onClick={save}>
            {t("common.save")}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
