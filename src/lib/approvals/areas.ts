/**
 * Which function (PRD §14 row) each kind of approval belongs to. In the simple way of working the person who looks
 * after that function decides it — and what they enter themselves counts at once. Pure, so the access tests can
 * read it and so the inbox can turn a login's rights into a list of kinds.
 */
import { canAll, type Fn, type Principal } from "@/lib/auth/access";

export const KIND_FN: Record<string, Fn> = {
  "attendance.muster": "attendance",
  "attendance.request": "attendance",
  "attendance.unlock": "attendance",
  "holiday.calendar": "attendance",
  "employee.create": "employee_master",
  "employee.bulk_create": "employee_master",
  "employee.update": "employee_master",
  "employee.family": "employee_master",
  "employee.self_request": "employee_master",
  "sanctioned.update": "employee_master",
  "service_book.entry": "service_book",
  "separation.record": "service_book",
  "separation.reinstate": "service_book",
  "vacancy.approve": "recruitment",
  "selection.approve": "recruitment",
  "joining.complete": "recruitment",
  "leave.apply": "leave",
  "leave.entry": "leave",
  "leave.rule": "leave",
  "leave.opening": "leave",
  "payroll.check": "payroll",
  "payroll.approve": "payroll",
  "payitem.change": "payroll",
  "increment.batch": "arrears_loans",
  "pay.fixation": "arrears_loans",
  "loan.sanction": "arrears_loans",
  "separation.settlement": "arrears_loans",
  "rate.change": "rates_rules",
  "payhead.change": "rates_rules",
  "matrix.add": "rates_rules",
  "tax.rule": "rates_rules",
  "due.rule": "rates_rules",
  "pension.table": "rates_rules",
  "tax.declaration": "statutory",
  "tax.carryin": "statutory",
  "gpf.advance": "statutory",
  "gpf.interest": "statutory",
  "form16.publish": "statutory",
  "pension.record": "pension",
  "pension.lifecert": "pension",
  "pension.case": "pension",
  "pension.death": "pension",
  "migration.load": "migration",
  "migration.cutover": "migration",
};

/** A file waiting for release belongs to whoever built it (bank file, statutory file, registration file). */
export const FILE_RELEASE = "file.release";

/** Simple way of working: the kinds this login decides because it looks after their function. */
export function kindsDecidedBy(p: Principal): string[] {
  if (!p.simple || p.loginType === "EMPLOYEE") return [];
  return Object.entries(KIND_FN)
    .filter(([, fn]) => canAll(p, fn, "approve"))
    .map(([kind]) => kind);
}

/** Simple way of working: may this login decide a task of this kind because of the function it belongs to? */
export function decidesKind(p: Principal, kind: string): boolean {
  if (!p.simple || p.loginType === "EMPLOYEE") return false;
  const fn = KIND_FN[kind];
  return fn ? canAll(p, fn, "approve") : false;
}
