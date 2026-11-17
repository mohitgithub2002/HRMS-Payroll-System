"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FilePlus2, FileText, Pencil, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, api } from "@/lib/http";
import { useT } from "@/lib/i18n/client";
import { tDynamic } from "@/lib/i18n";

const CATEGORIES = ["POLICY", "ORDER", "CIRCULAR", "RULES", "HOWTO", "OTHER"] as const;
const AUDIENCES = ["EVERYONE", "STAFF", "ADMIN"] as const;

interface DocRow {
  id: string;
  title: string;
  category: string;
  reference: string | null;
  audience: string;
  isActive: boolean;
  chars: number;
  updated: string;
  by: string;
}

interface Form {
  id: string | null;
  title: string;
  category: string;
  reference: string;
  audience: string;
  body: string;
  isActive: boolean;
}

const blank: Form = { id: null, title: "", category: "POLICY", reference: "", audience: "EVERYONE", body: "", isActive: true };

export function DocumentsManager({ docs, maxChars }: { docs: DocRow[]; maxChars: number }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<DocRow | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  async function open(doc: DocRow) {
    try {
      const full = await api<{ id: string; title: string; category: string; reference: string | null; audience: string; body: string; isActive: boolean }>(`/api/v1/ask/knowledge/${doc.id}`);
      setErrors({});
      setForm({ id: full.id, title: full.title, category: full.category, reference: full.reference ?? "", audience: full.audience, body: full.body, isActive: full.isActive });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "error");
    }
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    setErrors({});
    try {
      const body = { title: form.title, category: form.category, reference: form.reference, audience: form.audience, body: form.body, isActive: form.isActive };
      if (form.id) await api(`/api/v1/ask/knowledge/${form.id}`, { method: "PUT", body });
      else await api("/api/v1/ask/knowledge", { body });
      toast(t("ask.knowledge.saved"));
      setForm(null);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        toast(err.message, "error");
      } else toast(t("errors.generic"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api(`/api/v1/ask/knowledge/${removing.id}`, { method: "DELETE" });
      toast(t("ask.knowledge.removed"));
      setRemoving(null);
      router.refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "error");
    } finally {
      setBusy(false);
    }
  }

  /** A plain text file read in the browser; nothing is uploaded until the document is saved. */
  async function loadFile(file: File | undefined) {
    if (!file) return;
    const plain = file.type.startsWith("text/") || /\.(txt|md|csv)$/i.test(file.name);
    if (!plain || file.size > maxChars * 4) {
      toast(t("ask.knowledge.fileTooBig"), "error");
      return;
    }
    const text = (await file.text()).slice(0, maxChars);
    setForm((f) => (f ? { ...f, body: text, title: f.title || file.name.replace(/\.[^.]+$/, "") } : f));
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button
          variant="primary"
          icon={<FilePlus2 className="size-4" aria-hidden="true" />}
          onClick={() => {
            setErrors({});
            setForm({ ...blank });
          }}
        >
          {t("ask.knowledge.add")}
        </Button>
      </div>

      {docs.length === 0 ? (
        <Card>
          <EmptyState icon={<FileText className="size-6" aria-hidden="true" />} title={t("ask.knowledge.empty")} description={t("ask.knowledge.emptyHelp")} />
        </Card>
      ) : (
        <ul className="space-y-3" data-testid="knowledge-list">
          {docs.map((d) => (
            <li key={d.id}>
              <Card className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
                <div className="min-w-0 flex-1">
                  <p className="break-words font-semibold text-ink-900">{d.title}</p>
                  <p className="mt-0.5 break-words text-sm text-ink-600">
                    {tDynamic(t, `ask.knowledge.category.${d.category}`)}
                    {d.reference ? ` · ${d.reference}` : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge tone={d.audience === "EVERYONE" ? "green" : d.audience === "STAFF" ? "blue" : "gold"}>{tDynamic(t, `ask.knowledge.audience.${d.audience}`)}</Badge>
                    {!d.isActive && <Badge tone="gray">{t("ask.knowledge.inactive")}</Badge>}
                    <span className="text-xs text-ink-500">
                      {t("ask.knowledge.chars", { count: d.chars.toLocaleString("en-IN") })} · {t("ask.knowledge.updated", { date: d.updated })} {t("ask.knowledge.by", { name: d.by })}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" icon={<Pencil className="size-4" aria-hidden="true" />} onClick={() => open(d)}>
                    {t("common.edit")}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" aria-hidden="true" />} onClick={() => setRemoving(d)}>
                    {t("ask.knowledge.remove")}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={form !== null}
        onClose={() => setForm(null)}
        size="xl"
        title={form?.id ? t("ask.knowledge.edit") : t("ask.knowledge.add")}
        closeLabel={t("common.cancel")}
        footer={
          <>
            <Button onClick={() => setForm(null)}>{t("common.cancel")}</Button>
            <Button variant="primary" loading={busy} onClick={save}>
              {t("ask.knowledge.save")}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <Input label={t("ask.knowledge.fieldTitle")} hint={t("ask.knowledge.fieldTitleHint")} required value={form.title} maxLength={150} error={errors.title} onChange={(e) => set("title", e.target.value)} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select label={t("ask.knowledge.fieldCategory")} value={form.category} onChange={(e) => set("category", e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`ask.knowledge.category.${c}`)}
                  </option>
                ))}
              </Select>
              <Select label={t("ask.knowledge.fieldAudience")} hint={tDynamic(t, `ask.knowledge.audienceHelp.${form.audience}`)} value={form.audience} onChange={(e) => set("audience", e.target.value)}>
                {AUDIENCES.map((a) => (
                  <option key={a} value={a}>
                    {t(`ask.knowledge.audience.${a}`)}
                  </option>
                ))}
              </Select>
            </div>
            <Input label={t("ask.knowledge.fieldReference")} hint={t("ask.knowledge.fieldReferenceHint")} value={form.reference} maxLength={120} error={errors.reference} onChange={(e) => set("reference", e.target.value)} />
            <Textarea
              label={t("ask.knowledge.fieldBody")}
              hint={`${t("ask.knowledge.fieldBodyHint", { max: maxChars.toLocaleString("en-IN") })} ${t("ask.knowledge.chars", { count: form.body.length.toLocaleString("en-IN") })}`}
              required
              rows={12}
              value={form.body}
              maxLength={maxChars}
              error={errors.body}
              onChange={(e) => set("body", e.target.value)}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Checkbox label={t("ask.knowledge.active")} description={t("ask.knowledge.activeHint")} checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  void loadFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <Button size="sm" icon={<Upload className="size-4" aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
                {t("ask.knowledge.loadFile")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title={t("ask.knowledge.removeTitle")}
        description={removing ? t("ask.knowledge.removeConfirm", { title: removing.title }) : undefined}
        closeLabel={t("common.cancel")}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={busy} onClick={remove}>
              {t("ask.knowledge.remove")}
            </Button>
          </>
        }
      />
    </div>
  );
}
