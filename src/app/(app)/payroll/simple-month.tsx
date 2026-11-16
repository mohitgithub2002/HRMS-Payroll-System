import Link from "next/link";
import { ArrowRight, Banknote, CheckCircle2, CircleAlert, Download, History, Play } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { LinkButton, buttonClass } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { RowLink } from "@/components/ui/row-link";
import { Stepper } from "@/components/ui/stepper";
import { Table, Td, Th, THead } from "@/components/ui/table";
import { formatMonth } from "@/lib/dates";
import type { TFunction } from "@/lib/i18n";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { SIMPLE_STAGE_KEYS, type RunStatus } from "@/modules/payroll/present";
import type { payrollOverview } from "@/modules/payroll/run";
import { MonthAction } from "./month-actions";

type Overview = Awaited<ReturnType<typeof payrollOverview>>;
type Bill = { id: string; status: RunStatus; employees: number; net: number; openExceptions: number; bankFileId: string | null; label: string; help?: string };

function stateOf(b: Pick<Bill, "status" | "openExceptions">, t: TFunction): { label: string; tone: Tone } {
  if (b.status === "DRAFT") return b.openExceptions ? { label: t("easy.payroll.state.toFix", { count: b.openExceptions }), tone: "amber" } : { label: t("easy.payroll.state.ready"), tone: "blue" };
  if (b.status === "CHECKING" || b.status === "APPROVING") return { label: t("easy.payroll.state.waiting"), tone: "violet" };
  if (b.status === "APPROVED") return { label: t("easy.payroll.state.approved"), tone: "amber" };
  if (b.status === "PAID") return { label: t("easy.payroll.state.paid"), tone: "gold" };
  return { label: t("easy.payroll.state.closed"), tone: "green" };
}

/**
 * The simple way of working: the month's salaries on one screen. A large card says where the month stands and
 * offers the one next step; under it, one line per bill.
 */
export function SimpleMonth({ data, locale, t }: { data: Overview; locale: "en" | "hi"; t: TFunction }) {
  const monthName = formatMonth(data.month, locale);
  const bills: Bill[] = [
    ...data.groups.flatMap(({ group, run }) => (run ? [{ ...run, status: run.status as RunStatus, label: t(`payroll.groups.${group}`), help: t(`payroll.groupHelp.${group}`) }] : [])),
    ...data.supplementary.map((r) => ({ ...r, status: r.status as RunStatus, label: locale === "hi" ? r.titleHi : r.title })),
  ];
  const notRun = data.groups.filter((g) => !g.run);
  const drafts = bills.filter((b) => b.status === "DRAFT" || b.status === "CHECKING" || b.status === "APPROVING");
  const toFix = drafts.reduce((s, b) => s + b.openExceptions, 0);
  const ready = bills.filter((b) => b.status === "DRAFT" && b.openExceptions === 0 && b.employees > 0);
  const sent = bills.filter((b) => b.status === "APPROVED" || b.status === "PAID");
  const people = bills.reduce((s, b) => s + b.employees, 0);
  const net = bills.reduce((s, b) => s + b.net, 0);
  const step = bills.length === 0 ? 0 : drafts.length ? 1 : sent.length ? 2 : 3;
  const firstToFix = drafts.find((b) => b.openExceptions > 0) ?? drafts[0];
  const tone = step === 1 && toFix > 0 ? "fix" : step === 3 ? "done" : "go";

  const title = step === 0 ? t("easy.payroll.heroNone", { month: monthName }) : step === 1 ? (toFix ? t("easy.payroll.heroFix", { count: toFix }) : t("easy.payroll.heroReady")) : step === 2 ? t("easy.payroll.heroPay") : t("easy.payroll.heroDone", { month: monthName });
  const help = step === 0 ? t("easy.payroll.heroNoneHelp") : step === 1 ? (toFix ? t("easy.payroll.heroFixHelp") : t("easy.payroll.heroReadyHelp")) : step === 2 ? t("easy.payroll.heroPayHelp") : t("easy.payroll.heroDoneHelp");
  const HeroIcon = step === 0 ? Play : step === 3 ? CheckCircle2 : tone === "fix" ? CircleAlert : Banknote;

  return (
    <div>
      <section data-testid="payroll-hero" className={cn("overflow-hidden rounded-3xl border shadow-card", tone === "fix" ? "border-amber-200 bg-amber-50/60" : "border-brand-200 bg-white")}>
        <div className="border-b border-ink-100/80 bg-white/70 px-5 py-4 sm:px-8">
          <Stepper steps={SIMPLE_STAGE_KEYS.map((k) => t(`easy.payroll.steps.${k}`))} current={step} label={t("payroll.title")} className="max-w-xl" />
        </div>
        <div className="flex flex-col gap-6 px-5 py-6 sm:px-8 sm:py-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-2xl", tone === "fix" ? "bg-amber-100 text-amber-800" : "bg-brand-100 text-brand-800")} aria-hidden="true">
              <HeroIcon className="size-6" />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight text-ink-950 sm:text-2xl">{title}</h2>
              <p className="mt-1.5 max-w-2xl text-[0.9375rem] text-ink-600">{help}</p>
              {bills.length > 0 && (
                <dl className="mt-5 flex flex-wrap gap-x-10 gap-y-3">
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{t("easy.payroll.people")}</dt>
                    <dd className="tabular mt-0.5 text-2xl font-semibold text-ink-950">{people}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{t("easy.payroll.net")}</dt>
                    <dd className="tabular mt-0.5 text-2xl font-semibold text-ink-950" data-testid="month-net">
                      {formatINR(net)}
                    </dd>
                  </div>
                </dl>
              )}
            </div>
          </div>
          {data.canRun && (
            <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">
              {step === 0 && <MonthAction month={data.month} action="workOut" />}
              {step === 1 && <MonthAction month={data.month} action="workOut" again />}
              {step === 1 && toFix > 0 && firstToFix && (
                <LinkButton href={`/payroll/${firstToFix.id}`} variant="primary" size="lg" icon={<ArrowRight className="size-5" />}>
                  {t("easy.payroll.review")}
                </LinkButton>
              )}
              {step === 1 && toFix === 0 && ready.length > 0 && <MonthAction month={data.month} action="pay" people={ready.reduce((s, b) => s + b.employees, 0)} net={formatINR(ready.reduce((s, b) => s + b.net, 0))} />}
              {step === 2 && notRun.length > 0 && <MonthAction month={data.month} action="workOut" again />}
              {step === 2 && sent.some((b) => b.status === "PAID") && <MonthAction month={data.month} action="finish" />}
            </div>
          )}
        </div>
      </section>

      {bills.length > 0 && (
        <Card className="mt-6">
          <CardHeader title={t("easy.payroll.billsTitle")} description={t("easy.payroll.billsHelp")} />
          <ul className="divide-y divide-ink-100">
            {bills.map((b) => {
              const state = stateOf(b, t);
              return (
                <li key={b.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:px-6" data-testid="bill-row">
                  <div className="min-w-0 flex-1">
                    <Link href={`/payroll/${b.id}`} className="font-semibold text-ink-900 hover:text-brand-700">
                      {b.label}
                    </Link>
                    {b.help && <p className="text-sm text-ink-500">{b.help}</p>}
                  </div>
                  <dl className="flex items-center gap-6 text-sm sm:gap-8">
                    <div>
                      <dt className="text-xs text-ink-500">{t("easy.payroll.people")}</dt>
                      <dd className="tabular font-semibold text-ink-900">{b.employees}</dd>
                    </div>
                    <div className="min-w-[6.5rem]">
                      <dt className="text-xs text-ink-500">{t("easy.payroll.net")}</dt>
                      <dd className="tabular font-semibold text-ink-900">{formatINR(b.net)}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2 sm:w-[21rem] sm:justify-end">
                    <Badge tone={state.tone} dot>
                      {state.label}
                    </Badge>
                    {(b.status === "PAID" || b.status === "CLOSED") && b.bankFileId && (
                      <a href={`/api/v1/files/${b.bankFileId}/download`} download className={buttonClass("secondary", "sm")}>
                        <Download className="size-4" aria-hidden="true" /> {t("easy.payroll.bankFile")}
                      </a>
                    )}
                    <LinkButton href={`/payroll/${b.id}`} size="sm" variant={b.status === "DRAFT" ? "subtle" : "secondary"}>
                      {b.status === "DRAFT" ? t("easy.payroll.review") : t("easy.payroll.open")}
                    </LinkButton>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader title={t("payroll.history")} icon={<History className="size-4.5" aria-hidden="true" />} />
        {data.history.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-600">{t("payroll.noHistory")}</p>
          </CardBody>
        ) : (
          <Table stack>
            <THead>
              <tr>
                <Th>{t("payroll.month")}</Th>
                <Th align="right">{t("easy.payroll.people")}</Th>
                <Th align="right">{t("easy.payroll.gross")}</Th>
                <Th align="right">{t("easy.payroll.net")}</Th>
                <Th>{t("payroll.columns.status")}</Th>
              </tr>
            </THead>
            <tbody>
              {monthsOf(data.history).map((m) => (
                <RowLink key={m.month} href={`/payroll?month=${m.month}`}>
                  <Td className="font-medium text-ink-900">
                    <Link href={`/payroll?month=${m.month}`} className="hover:text-brand-700">
                      {formatMonth(m.month, locale)}
                    </Link>
                  </Td>
                  <Td label={t("easy.payroll.people")} align="right">
                    {m.people}
                  </Td>
                  <Td label={t("easy.payroll.gross")} align="right">
                    {formatINR(m.gross)}
                  </Td>
                  <Td label={t("easy.payroll.net")} align="right" className="font-semibold text-ink-900">
                    {formatINR(m.net)}
                  </Td>
                  <Td label={t("payroll.columns.status")}>
                    <Badge tone={m.done ? "green" : "amber"} dot>
                      {m.done ? t("easy.payroll.state.closed") : t("easy.payroll.steps.pay")}
                    </Badge>
                  </Td>
                </RowLink>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

/** Earlier months, one line each (every bill of the month together). */
function monthsOf(history: Overview["history"]) {
  const by = new Map<string, { month: string; people: number; gross: number; net: number; done: boolean }>();
  for (const r of history) {
    const m = by.get(r.month) ?? { month: r.month, people: 0, gross: 0, net: 0, done: true };
    if (r.kind === "REGULAR") m.people += r.employees;
    m.gross += r.gross;
    m.net += r.net;
    if (r.status !== "CLOSED") m.done = false;
    by.set(r.month, m);
  }
  return [...by.values()].sort((a, b) => b.month.localeCompare(a.month));
}
