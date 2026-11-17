/** Ask AI: a few questions to start from, chosen by what the login can read. Pure module. */
import type { AskScope } from "./scope";

export const ASK_SUGGESTIONS = [
  "myLeave", "mySalary", "myAttendance", "holidays", "leaveRule", "myPension", "lifeCertificate", "teamLeave", "headcount", "retiring", "onLeaveToday", "vacant",
  "payrollTotal", "loans", "tdsTotal", "pensioners", "logins", "auditToday",
] as const;
export type AskSuggestion = (typeof ASK_SUGGESTIONS)[number];

export function suggestionsFor(scope: AskScope, max = 6): AskSuggestion[] {
  const r = scope.reach;
  const out: AskSuggestion[] = [];
  const add = (when: boolean, ...keys: AskSuggestion[]) => {
    if (when) for (const k of keys) if (!out.includes(k)) out.push(k);
  };
  // The desk's own work first, then the person's own record.
  add(r.payroll === "all", "payrollTotal");
  add(r.people === "all", "headcount", "retiring");
  add(r.leave === "all", "onLeaveToday");
  add(r.loans === "all", "loans");
  add(r.statutory === "all", "tdsTotal");
  add(r.pension === "all", "pensioners");
  add(r.people === "all", "vacant");
  add(r.users === "all", "logins");
  add(r.audit !== "none", "auditToday");
  add(r.leave === "section", "teamLeave");
  add(r.leave === "own" || r.leave === "section", "myLeave");
  add(r.payroll === "own", "mySalary");
  add(r.attendance === "own" || r.attendance === "section", "myAttendance");
  add(r.pension === "own", "myPension", "lifeCertificate");
  add(true, "holidays", "leaveRule");
  return out.slice(0, max);
}
