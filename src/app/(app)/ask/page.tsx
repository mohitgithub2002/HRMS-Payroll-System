import type { Metadata } from "next";
import { Lock, Sparkles } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { canManageKnowledge, canUseAsk } from "@/lib/auth/access";
import { requireActor } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { askScope } from "@/modules/ask/scope";
import { askStatus } from "@/modules/ask/service";
import { suggestionsFor } from "@/modules/ask/suggestions";
import { AskChat } from "./ask-chat";

export const metadata: Metadata = { title: "Ask AI" };

/** The hour in India, for the greeting. */
function istHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "numeric", hourCycle: "h23" }).format(now));
}

function Blocked({ icon, title, help, home, goHome }: { icon: React.ReactNode; title: string; help: string; home: boolean; goHome: string }) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-4 py-10">
      <div className="w-full max-w-md text-center">
        <span className="ask-mark mx-auto flex size-14 items-center justify-center rounded-2xl text-white" aria-hidden="true">
          {icon}
        </span>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-ink-900">{title}</h1>
        <p className="mt-2 text-[0.95rem] leading-relaxed text-ink-600">{help}</p>
        {home && (
          <div className="mt-6">
            <LinkButton href="/home">{goHome}</LinkButton>
          </div>
        )}
      </div>
    </div>
  );
}

/** Ask AI: questions in plain words, answered from what the person may already see. The screen fills the page. */
export default async function AskPage() {
  const actor = await requireActor();
  const { t, locale } = await getT();
  const status = await askStatus(actor);
  if (!status.allowed || !canUseAsk(actor, status.audience)) {
    return <Blocked icon={<Lock className="size-6" />} title={t("ask.notAllowedTitle")} help={t("ask.notAllowedHelp")} home goHome={t("common.goHome")} />;
  }
  if (!status.configured) {
    return <Blocked icon={<Sparkles className="size-6" />} title={t("ask.notSetUpTitle")} help={t("ask.notSetUpHelp")} home={false} goHome="" />;
  }
  const hour = istHour();
  const firstName = (locale === "hi" && actor.nameHi ? actor.nameHi : actor.name).trim().split(/\s+/)[0] ?? "";
  const greeting = t(hour < 12 ? "home.goodMorning" : hour < 17 ? "home.goodAfternoon" : "home.goodEvening", { name: firstName });
  return (
    <AskChat
      suggestions={suggestionsFor(askScope(actor))}
      practice={status.practice}
      greeting={greeting}
      service={t(`ask.service.${status.provider}`)}
      canWriteDocs={canManageKnowledge(actor)}
    />
  );
}
