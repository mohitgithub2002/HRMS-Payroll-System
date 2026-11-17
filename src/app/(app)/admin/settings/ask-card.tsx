"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleCheck, FileText, KeyRound, Sparkles, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, api } from "@/lib/http";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Audience = "off" | "staff" | "everyone";
type Provider = "gemini" | "openai" | "claude";

interface Service {
  provider: Provider;
  model: string;
  source: "settings" | "env" | "none";
  hint: string | null;
}

interface Config {
  audience: Audience;
  provider: Provider;
  services: Service[];
  practice: boolean;
  ready: boolean;
}

type TestResult = { ok: true; model: string; ms: number } | { ok: false; kind: string; message: string };

/**
 * Settings → Ask: who may ask, which AI service answers (Gemini, GPT or Claude) with which model, and each service's
 * key. A key is saved encrypted and never comes back to the browser — the card only knows where a key comes from.
 * What each person can be told is decided by their login, not here.
 */
export function AskCard({ initial, readOnly, roleReady, canWriteDocs }: { initial: Config; readOnly: boolean; roleReady: boolean; canWriteDocs: boolean }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const [saved, setSaved] = useState({ audience: initial.audience, provider: initial.provider, models: Object.fromEntries(initial.services.map((s) => [s.provider, s.model])) as Record<Provider, string> });
  const [audience, setAudience] = useState<Audience>(initial.audience);
  const [provider, setProvider] = useState<Provider>(initial.provider);
  const [models, setModels] = useState(saved.models);
  const [services, setServices] = useState(initial.services);
  const [keys, setKeys] = useState<Record<Provider, string>>({ gemini: "", openai: "", claude: "" });
  const [tests, setTests] = useState<Partial<Record<Provider, TestResult>>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const dirty = audience !== saved.audience || provider !== saved.provider || services.some((s) => models[s.provider] !== saved.models[s.provider]);
  const chosen = services.find((s) => s.provider === saved.provider);
  const fail = (err: unknown) => toast(err instanceof ApiError ? err.message : t("errors.generic"), "error");

  async function save() {
    setBusy("save");
    try {
      await api("/api/v1/settings/ask", { method: "PUT", body: { audience, provider, models } });
      setSaved({ audience, provider, models });
      toast(t("ask.setting.saved"));
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function saveKey(p: Provider) {
    setBusy(`key-${p}`);
    try {
      const res = await api<{ hint: string }>(`/api/v1/ask/keys/${p}`, { method: "PUT", body: { key: keys[p] } });
      setServices((all) => all.map((s) => (s.provider === p ? { ...s, source: "settings", hint: res.hint } : s)));
      setKeys((k) => ({ ...k, [p]: "" }));
      setTests((x) => ({ ...x, [p]: undefined }));
      toast(t("ask.setting.keySavedToast"));
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function removeKey(p: Provider) {
    setBusy(`key-${p}`);
    try {
      await api(`/api/v1/ask/keys/${p}`, { method: "DELETE" });
      // A key in the server's environment, if there is one, is used again: ask the server what is in force.
      const fresh = await api<Config>("/api/v1/ask/config");
      setServices(fresh.services);
      setTests((x) => ({ ...x, [p]: undefined }));
      toast(t("ask.setting.keyRemoved"));
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function test(p: Provider) {
    setBusy(`test-${p}`);
    try {
      const res = await api<TestResult>(`/api/v1/ask/keys/${p}/test`, { method: "POST", body: {} });
      setTests((x) => ({ ...x, [p]: res }));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
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
      <CardBody className="space-y-6">
        {!initial.practice && (chosen?.source === "none" || !roleReady) && (
          <p className="flex items-start gap-2 rounded-xl border border-gold-500/30 bg-gold-50 px-3 py-2 text-sm text-gold-600" role="status" data-testid="ask-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{chosen?.source === "none" ? t("ask.setting.keyMissing") : t("ask.setting.roleMissing")}</span>
          </p>
        )}

        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-ink-900">{t("ask.setting.whoTitle")}</legend>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {(["everyone", "staff", "off"] as const).map((a) => (
              <label key={a} className={cn("flex cursor-pointer gap-3 rounded-xl border px-4 py-3 transition-colors", audience === a ? "border-brand-500 bg-brand-50/60 ring-2 ring-brand-100" : "border-ink-200 hover:border-ink-300", readOnly && "pointer-events-none")}>
                <input type="radio" name="ask-audience" className="mt-1 accent-brand-700" checked={audience === a} disabled={readOnly} onChange={() => setAudience(a)} />
                <span>
                  <span className="block text-sm font-semibold text-ink-900">{t(`ask.setting.${a}`)}</span>
                  <span className="block text-sm text-ink-600">{t(`ask.setting.${a}Help`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-ink-900">{t("ask.setting.serviceTitle")}</legend>
          <p className="mb-3 mt-0.5 text-sm text-ink-600">{t("ask.setting.serviceHelp")}</p>
          <div className="space-y-3">
            {services.map((s) => {
              const p = s.provider;
              const result = tests[p];
              return (
                <div key={p} className={cn("rounded-xl border px-4 py-4 transition-colors", provider === p ? "border-brand-500 bg-brand-50/40 ring-2 ring-brand-100" : "border-ink-200")} data-testid={`ask-service-${p}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className={cn("flex cursor-pointer items-center gap-3", readOnly && "pointer-events-none")}>
                      <input type="radio" name="ask-provider" className="accent-brand-700" checked={provider === p} disabled={readOnly} onChange={() => setProvider(p)} />
                      <span className="text-sm font-semibold text-ink-900">{t(`ask.setting.provider.${p}`)}</span>
                    </label>
                    <span className="flex flex-wrap items-center gap-2">
                      {saved.provider === p && <Badge tone="green">{t("ask.setting.inUse")}</Badge>}
                      <span className={cn("inline-flex items-center gap-1.5 text-xs", s.source === "none" ? "text-ink-500" : "text-ink-700")} data-testid={`ask-key-status-${p}`}>
                        <KeyRound className="size-3.5" aria-hidden="true" />
                        {s.source === "settings" ? t("ask.setting.keySaved", { hint: `…${s.hint ?? ""}` }) : s.source === "env" ? t("ask.setting.keyEnv", { hint: s.hint ?? "" }) : t("ask.setting.keyNone")}
                      </span>
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Input label={t("ask.setting.model")} hint={t("ask.setting.modelHint")} value={models[p]} maxLength={80} disabled={readOnly} spellCheck={false} onChange={(e) => setModels((m) => ({ ...m, [p]: e.target.value.trim() }))} />
                    {!readOnly && (
                      <Input
                        label={t("ask.setting.keyLabel")}
                        hint={t("ask.setting.keyHelp")}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t("ask.setting.keyPlaceholder")}
                        value={keys[p]}
                        maxLength={400}
                        onChange={(e) => setKeys((k) => ({ ...k, [p]: e.target.value }))}
                      />
                    )}
                  </div>
                  {!readOnly && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button size="sm" loading={busy === `key-${p}`} disabled={keys[p].trim().length < 12 || busy !== null} onClick={() => saveKey(p)}>
                        {t("ask.setting.saveKey")}
                      </Button>
                      <Button size="sm" variant="ghost" loading={busy === `test-${p}`} disabled={s.source === "none" || busy !== null} onClick={() => test(p)}>
                        {t("ask.setting.test")}
                      </Button>
                      {s.source === "settings" && (
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => removeKey(p)}>
                          {t("ask.setting.removeKey")}
                        </Button>
                      )}
                    </div>
                  )}
                  {result && (
                    <p className={cn("mt-3 flex items-start gap-2 break-words text-sm", result.ok ? "text-brand-800" : "text-red-700")} role="status" data-testid={`ask-test-${p}`}>
                      {result.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
                      <span className="min-w-0">{result.ok ? t("ask.setting.testOk", { model: result.model, ms: result.ms }) : t("ask.setting.testFail", { message: result.message })}</span>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      </CardBody>
      {!readOnly && (
        <CardFooter>
          <Button loading={busy === "save"} disabled={!dirty || busy !== null || services.some((s) => !models[s.provider])} onClick={save}>
            {t("common.save")}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
