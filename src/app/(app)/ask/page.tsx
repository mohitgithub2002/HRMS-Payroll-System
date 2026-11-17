import type { Metadata } from "next";
import { FileText, Lock, Sparkles } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { canManageKnowledge } from "@/lib/auth/access";
import { requireActor } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { askScope } from "@/modules/ask/scope";
import { askStatus } from "@/modules/ask/service";
import { suggestionsFor } from "@/modules/ask/suggestions";
import { AskChat } from "./ask-chat";

export const metadata: Metadata = { title: "Ask" };

/** Ask AI: questions in plain words, answered from what the person may already see. */
export default async function AskPage() {
  const actor = await requireActor();
  const { t } = await getT();
  const status = await askStatus(actor);
  const docs = canManageKnowledge(actor) ? (
    <LinkButton href="/ask/documents" icon={<FileText className="size-4" aria-hidden="true" />}>
      {t("ask.knowledge.title")}
    </LinkButton>
  ) : undefined;

  if (!status.allowed) {
    return (
      <Card className="mx-auto max-w-xl">
        <EmptyState icon={<Lock className="size-6" aria-hidden="true" />} title={t("ask.notAllowedTitle")} description={t("ask.notAllowedHelp")} action={<LinkButton href="/home">{t("common.goHome")}</LinkButton>} />
      </Card>
    );
  }
  return (
    <div>
      <PageHeader title={t("ask.title")} description={t("ask.subtitle")} actions={docs} />
      {status.configured ? (
        <AskChat suggestions={suggestionsFor(askScope(actor))} practice={status.practice} phoneNav={actor.loginType === "EMPLOYEE"} />
      ) : (
        <Card className="mx-auto max-w-xl">
          <EmptyState icon={<Sparkles className="size-6" aria-hidden="true" />} title={t("ask.notSetUpTitle")} description={t("ask.notSetUpHelp")} />
        </Card>
      )}
    </div>
  );
}
