import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { countInbox } from "@/lib/approvals";
import { canUseAsk, scopeFor } from "@/lib/auth/access";
import { hasApprovalsInbox, menuFor } from "@/lib/auth/menu";
import { roleOf } from "@/lib/auth/roles";
import { IDLE_TIMEOUT_MS, requireActor } from "@/lib/auth/session";
import { MARK } from "@/lib/brand";
import { askConfig } from "@/modules/ask/config";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const path = (await headers()).get("x-pathname") ?? "";
  // First sign-in with a temporary password: set your own before doing anything else.
  if (actor.mustChangePassword && !path.startsWith("/profile")) redirect("/profile?setup=1");

  // Both at once: each is a trip to the database, and every page waits for the layout.
  const [inbox, askSetup] = await Promise.all([hasApprovalsInbox(actor) ? countInbox(actor) : Promise.resolve(null), askConfig(actor.boardId)]);
  // Ask AI: shown when the Board has opened it for this login. Admins also see it before a key is set, with what to do.
  const ask = canUseAsk(actor, askSetup.audience) && (askSetup.ready || actor.loginType === "ADMIN");
  return (
    <AppShell
      menu={menuFor(actor)}
      user={{
        name: actor.name,
        nameHi: actor.nameHi,
        loginId: actor.loginId,
        loginType: actor.isPensioner && !actor.isEmployee ? "PENSIONER" : actor.loginType,
        permissions: actor.permissions,
        // The simple way of working names people by role (HR manager, Accounts manager …).
        roleKey: actor.simple && !(actor.isPensioner && !actor.isEmployee) ? `easy.roles.${roleOf(actor.loginType, actor.permissions)}` : undefined,
      }}
      inboxCount={inbox}
      logo={MARK}
      idleTimeoutMs={IDLE_TIMEOUT_MS}
      mobileBottomNav={actor.loginType === "EMPLOYEE"}
      employeeSearch={actor.loginType !== "EMPLOYEE" && Boolean(scopeFor(actor, "employee_master", "view"))}
      ask={ask}
    >
      {children}
    </AppShell>
  );
}
