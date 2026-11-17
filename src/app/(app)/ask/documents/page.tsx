import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/ui/page-header";
import { canManageKnowledge } from "@/lib/auth/access";
import { requireActor } from "@/lib/auth/session";
import { formatDate, toISODate } from "@/lib/dates";
import { getT } from "@/lib/i18n/server";
import { listKnowledge, MAX_DOC_CHARS } from "@/modules/ask/knowledge";
import { DocumentsManager } from "./documents-manager";

export const metadata: Metadata = { title: "The Board's documents" };

/** The Board's own words for Ask AI: policies, orders, circulars — and who may read each. */
export default async function AskDocumentsPage() {
  const actor = await requireActor();
  if (!canManageKnowledge(actor)) return <NoAccess />;
  const { t, locale } = await getT();
  const docs = await listKnowledge(actor);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t("ask.knowledge.title")} description={t("ask.knowledge.subtitle")} breadcrumbs={[{ label: t("ask.title"), href: "/ask" }, { label: t("ask.knowledge.title") }]} />
      <DocumentsManager
        maxChars={MAX_DOC_CHARS}
        docs={docs.map((d) => ({
          id: d.id,
          title: d.title,
          category: d.category,
          reference: d.reference,
          audience: d.audience,
          isActive: d.isActive,
          chars: d.chars,
          updated: formatDate(toISODate(d.updatedAt), locale),
          by: d.updatedByName ?? d.createdByName,
        }))}
      />
    </div>
  );
}
