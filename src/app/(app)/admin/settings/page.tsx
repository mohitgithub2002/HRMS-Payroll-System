import type { Metadata } from "next";
import { Plug } from "lucide-react";
import { NoAccess } from "@/components/no-access";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { can, canManageKnowledge, canManageUsers, isFullAdmin } from "@/lib/auth/access";
import { requireActor } from "@/lib/auth/session";
import { CONNECTORS } from "@/lib/connectors/types";
import { env } from "@/lib/env";
import { getT } from "@/lib/i18n/server";
import { askConfigured } from "@/modules/ask/model";
import { askRoleReady } from "@/modules/ask/runner";
import { getAllSettings } from "@/modules/settings/service";
import { AskCard } from "./ask-card";
import { SettingsForms } from "./settings-forms";
import { WorkflowCard } from "./workflow-card";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const actor = await requireActor();
  if (!can(actor, "users_settings", "view")) return <NoAccess />;
  const { t } = await getT();
  const settings = await getAllSettings(actor.boardId);
  const canEdit = canManageUsers(actor);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t("settings.title")} description={t("settings.subtitle")} />
      <WorkflowCard initial={settings.workflow.mode} readOnly={!canEdit && !isFullAdmin(actor)} />
      <AskCard initial={settings.ask.audience} readOnly={!canEdit && !isFullAdmin(actor)} configured={askConfigured()} roleReady={await askRoleReady()} canWriteDocs={canManageKnowledge(actor)} />
      <SettingsForms initial={settings} readOnly={!canEdit} smsForcedConsole={env().SMS_PROVIDER === "console"} />

      <Card className="mt-6">
        <CardHeader title={t("settings.connectors")} description={t("settings.connectorsHint")} icon={<Plug className="size-4.5" aria-hidden="true" />} />
        <Table>
          <THead>
            <tr>
              <Th>{t("settings.system")}</Th>
              <Th>{t("settings.release1")}</Th>
              <Th>{t("settings.later")}</Th>
            </tr>
          </THead>
          <tbody>
            {CONNECTORS.map((c) => (
              <Tr key={c.id}>
                <Td className="font-medium text-ink-900">{c.name}</Td>
                <Td>
                  <Badge tone={c.mode === "api" ? "green" : "blue"}>{c.mode === "api" ? t("settings.liveApi") : t("settings.file")}</Badge>
                </Td>
                <Td className="text-ink-600">{c.later ?? "—"}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <p className="mt-4 text-sm text-ink-500">{t("settings.secretsNote")}</p>
    </div>
  );
}
