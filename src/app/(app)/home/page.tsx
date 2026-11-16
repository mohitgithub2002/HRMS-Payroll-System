import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftRight, ArrowRight, BadgeCheck, BarChart3, Briefcase, ChevronDown, Database, Receipt, UsersRound, CalendarClock, CalendarHeart, CheckCircle2, Clock, Fingerprint, HandCoins, History, Hourglass, IdCard, Inbox, IndianRupee, Landmark, LayoutGrid, Lock, Send, TriangleAlert, TrendingUp, UserPlus, Users, Wallet } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import { can, canAll, canManageUsers } from "@/lib/auth/access";
import { roleOf } from "@/lib/auth/roles";
import { requireActor, type Actor } from "@/lib/auth/session";
import type { TFunction } from "@/lib/i18n";
import type { Tile, WorkItem } from "@/modules/home/service";
import { formatDate, formatDateTime, todayIST } from "@/lib/dates";
import { tDynamic } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import { adminPanel, homeTiles, myWork } from "@/modules/home/service";
import { AdminPanel } from "./admin-panel";

export const metadata: Metadata = { title: "Home" };

const TILE_ICONS = { users: Users, sections: LayoutGrid, employees: IdCard, history: History, inbox: Inbox, probation: Hourglass, joining: UserPlus, attendance: Fingerprint, lock: Lock, leave: CalendarHeart, payroll: Wallet, statutory: Landmark, pension: HandCoins, certificate: BadgeCheck, cost: IndianRupee, retire: CalendarClock, alert: TriangleAlert, request: Send, increment: TrendingUp, joiners: ArrowLeftRight, migration: Database };

function greetingKey(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(now));
  return hour < 12 ? "home.goodMorning" : hour < 17 ? "home.goodAfternoon" : "home.goodEvening";
}

/** The simple way of working: the few things each desk does most, one tap from Home. */
function quickActions(actor: Actor) {
  const all = [
    canAll(actor, "payroll", "create") && { key: "runPayroll", href: "/payroll", icon: Wallet },
    canAll(actor, "employee_master", "create") && { key: "addEmployee", href: "/employees/new", icon: UserPlus },
    canAll(actor, "leave", "approve") && { key: "decideLeave", href: "/leave/manage", icon: CalendarHeart },
    canAll(actor, "attendance", "create") && { key: "markAttendance", href: "/attendance", icon: Fingerprint },
    canAll(actor, "recruitment", "approve") && { key: "hire", href: "/recruitment", icon: Briefcase },
    canAll(actor, "payroll", "view") && { key: "payslips", href: "/payroll/payslips", icon: Receipt },
    canAll(actor, "arrears_loans", "create") && { key: "loans", href: "/payroll/loans", icon: HandCoins },
    canManageUsers(actor) && { key: "users", href: "/admin/users", icon: UsersRound },
    can(actor, "reports", "view") && { key: "reports", href: "/reports", icon: BarChart3 },
  ] as const;
  return all.filter((a): a is Exclude<(typeof all)[number], false> => Boolean(a)).slice(0, 6);
}

function WorkList({ work, t, locale }: { work: WorkItem[]; t: TFunction; locale: "en" | "hi" }) {
  return (
    <ul className="divide-y divide-ink-100">
      {work.map((item) => (
        <li key={item.key}>
          <Link href={item.href} className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-brand-50/40 sm:px-6">
            <span className={item.tone === "red" ? "flex size-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-700" : "flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700"}>
              <Clock className="size-4.5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.95rem] font-medium text-ink-900">{locale === "hi" && item.titleHi ? item.titleHi : item.title}</span>
              <span className="mt-0.5 block text-xs text-ink-500">
                {item.meta && t("approvals.raisedBy", { name: item.meta })}
                {item.at && ` · ${formatDateTime(item.at, locale)}`}
              </span>
            </span>
            <ArrowRight className="size-4 text-ink-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-600" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Tiles({ tiles, t, locale }: { tiles: Tile[]; t: TFunction; locale: "en" | "hi" }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => {
        const Icon = TILE_ICONS[tile.icon];
        return <StatTile key={tile.key} label={tDynamic(t, `home.${tile.key}`)} value={tile.value} href={tile.href} tone={tile.tone} hint={locale === "hi" ? (tile.hintHi ?? tile.hint) : tile.hint} icon={<Icon className="size-4.5" aria-hidden="true" />} />;
      })}
    </div>
  );
}

export default async function HomePage() {
  const actor = await requireActor();
  const { t, locale } = await getT();
  const [work, tiles, panel] = await Promise.all([myWork(actor), homeTiles(actor), adminPanel(actor)]);
  const firstName = (locale === "hi" && actor.nameHi ? actor.nameHi : actor.name).split(" ")[0];

  // The simple way of working, for the Admin and the HR and Accounts managers: greeting, what to do, what is waiting.
  if (actor.simple && actor.loginType !== "EMPLOYEE") {
    const quick = quickActions(actor);
    const role = roleOf(actor.loginType, actor.permissions);
    // The four figures each desk looks at first; the others are under "More figures".
    const first = role === "ACCOUNTS" ? ["approvalsWaiting", "payrollMonth", "payrollExceptions", "statutoryDue"] : role === "HR" ? ["approvalsWaiting", "leaveWaiting", "presentToday", "employeesCount"] : ["approvalsWaiting", "salaryCost", "employeesCount", "presentToday"];
    const rank = (key: string) => (first.includes(key) ? first.indexOf(key) : first.length);
    const ordered = [...tiles].sort((a, b) => rank(a.key) - rank(b.key));
    const top = ordered.slice(0, 4);
    const rest = ordered.slice(4);
    return (
      <div className="space-y-6">
        <section className="brand-gradient relative overflow-hidden rounded-3xl px-6 py-7 text-white shadow-raised sm:px-8 sm:py-9">
          <div className="grid-pattern pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
          <div className="relative flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-brand-100">{formatDate(todayIST(), locale)}</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{tDynamic(t, greetingKey(), { name: firstName })}</h1>
              <p className="mt-2 text-[0.9375rem] text-brand-50">{work.length ? `${t("easy.home.todo")}: ${work.length}` : t("easy.home.todoEmpty")}</p>
            </div>
            <span className="rounded-full bg-white/15 px-3 py-1 text-sm font-medium text-white ring-1 ring-inset ring-white/25">{tDynamic(t, `easy.roles.${role}`)}</span>
          </div>
          {quick.length > 0 && (
            <nav aria-label={t("easy.home.quick")} className="relative mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {quick.map((a) => (
                <Link key={a.key} href={a.href} className="group flex items-center gap-3 rounded-2xl bg-white px-4 py-3.5 text-ink-900 shadow-card transition-shadow hover:shadow-raised" data-testid={`quick-${a.key}`}>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                    <a.icon className="size-4.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 text-sm font-semibold leading-tight">{tDynamic(t, `easy.home.${a.key}`)}</span>
                </Link>
              ))}
            </nav>
          )}
        </section>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader
              title={t("easy.home.todo")}
              icon={<Inbox className="size-4.5" aria-hidden="true" />}
              actions={
                work.length ? (
                  <Link href="/approvals" className="text-sm font-medium text-brand-700 hover:underline">
                    {t("common.viewAll")}
                  </Link>
                ) : undefined
              }
            />
            {work.length === 0 ? <EmptyState icon={<CheckCircle2 className="size-6" aria-hidden="true" />} title={t("easy.home.todoEmpty")} /> : <WorkList work={work} t={t} locale={locale} />}
          </Card>
          <section aria-labelledby="glance" className="space-y-4">
            <h2 id="glance" className="sr-only">
              {t("home.atAGlance")}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">
              {top.map((tile) => {
                const Icon = TILE_ICONS[tile.icon];
                return <StatTile key={tile.key} label={tDynamic(t, `home.${tile.key}`)} value={tile.value} href={tile.href} tone={tile.tone} hint={locale === "hi" ? (tile.hintHi ?? tile.hint) : tile.hint} icon={<Icon className="size-4.5" aria-hidden="true" />} />;
              })}
            </div>
          </section>
        </div>

        {rest.length > 0 && (
          <details className="group rounded-2xl border border-ink-200/80 bg-white shadow-card">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-[0.95rem] font-semibold text-ink-900 sm:px-6 [&::-webkit-details-marker]:hidden">
              {t("easy.home.more")}
              <ChevronDown className="size-4 text-ink-400 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="border-t border-ink-100 px-5 py-5 sm:px-6">
              <Tiles tiles={rest} t={t} locale={locale} />
            </div>
          </details>
        )}

        {panel && <AdminPanel panel={panel} t={t} locale={locale} />}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-brand-700">{formatDate(todayIST(), locale)}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-950 sm:text-3xl">
            {tDynamic(t, greetingKey(), { name: firstName })}
          </h1>
        </div>
      </div>

      {tiles.length > 0 && (
        <section aria-labelledby="glance">
          <h2 id="glance" className="sr-only">
            {t("home.atAGlance")}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {tiles.map((tile) => {
              const Icon = TILE_ICONS[tile.icon];
              return (
                <StatTile
                  key={tile.key}
                  label={tDynamic(t, `home.${tile.key}`)}
                  value={tile.value}
                  href={tile.href}
                  tone={tile.tone}
                  hint={locale === "hi" ? (tile.hintHi ?? tile.hint) : tile.hint}
                  icon={<Icon className="size-4.5" aria-hidden="true" />}
                />
              );
            })}
          </div>
        </section>
      )}

      {panel && <AdminPanel panel={panel} t={t} locale={locale} />}

      <Card>
        <CardHeader
          title={t("home.myWork")}
          description={work.length ? t("home.approvalsWaitingHint") : undefined}
          icon={<Inbox className="size-4.5" aria-hidden="true" />}
          actions={
            work.length ? (
              <Link href="/approvals" className="text-sm font-medium text-brand-700 hover:underline">
                {t("common.viewAll")}
              </Link>
            ) : undefined
          }
        />
        {work.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="size-6" aria-hidden="true" />} title={t("home.myWorkEmpty")} description={t("home.setupNote")} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {work.map((item) => (
              <li key={item.key}>
                <Link href={item.href} className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-brand-50/40 sm:px-6">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
                    <Clock className="size-4.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.95rem] font-medium text-ink-900">
                      {locale === "hi" && item.titleHi ? item.titleHi : item.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-500">
                      {item.meta && t("approvals.raisedBy", { name: item.meta })}
                      {item.at && ` · ${formatDateTime(item.at, locale)}`}
                    </span>
                  </span>
                  <ArrowRight className="size-4 text-ink-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-600" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
