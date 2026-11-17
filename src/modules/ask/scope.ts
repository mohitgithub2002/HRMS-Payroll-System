/**
 * Ask AI: how far a person's questions may reach — PRD §14 turned into the "pass" the database views read.
 *
 * One reach per area: the whole Board, the person's section, their own record, or nothing. It comes from the same
 * matrix as every screen (lib/auth/access.ts), plus the "own record" rule the services apply (a person always sees
 * their own leave, attendance, payslips, funds and tax). Nothing here is decided by the language model.
 *
 * Pure module: used by the service, the prompt and the tests.
 */
import { canSeeSensitive, scopeFor, type Fn, type Principal } from "@/lib/auth/access";

export type Reach = "all" | "section" | "own" | "system" | "none";

export const ASK_AREAS = ["people", "service", "attendance", "leave", "payroll", "loans", "statutory", "pension", "rates", "recruitment", "users", "audit"] as const;
export type AskArea = (typeof ASK_AREAS)[number];

/** The parts of an Actor the scope needs (an Actor fits). */
export interface AskPrincipal extends Principal {
  boardId: string;
  userId: string;
  employeeId: string | null;
  sectionId: string | null;
  pensionerId: string | null;
}

export interface AskScope {
  boardId: string;
  userId: string;
  employeeId: string | null;
  sectionId: string | null;
  pensionerId: string | null;
  reach: Record<AskArea, Reach>;
  /** False for the User & settings manager: no pay, bank or identity value (PRD §2 rule 3). */
  sensitive: boolean;
}

const view = (p: Principal, fn: Fn) => scopeFor(p, fn, "view");

export function askScope(p: AskPrincipal): AskScope {
  // Someone on the rolls, or office staff with their own employee record (an HR clerk reading their own payslip).
  // A pensioner's login reads the pension, not the old employee record.
  const self = Boolean(p.employeeId) && (p.loginType !== "EMPLOYEE" || p.isEmployee);
  const sensitive = canSeeSensitive(p);

  /** all → all; a section reach needs a section; an own reach needs an employee record. */
  const staff = (fn: Fn, opts: { section?: boolean; ownAlways?: boolean } = {}): Reach => {
    const s = view(p, fn);
    if (s === "all") return "all";
    if (s === "section" && opts.section && p.sectionId && self) return "section";
    if ((s === "own" || s === "section" || opts.ownAlways) && self) return "own";
    return "none";
  };
  const whole = (fn: Fn): Reach => (view(p, fn) === "all" ? "all" : "none");
  /** Money: never without the right to see pay. */
  const money = (r: Reach): Reach => (sensitive ? r : "none");

  const audit = view(p, "audit_trail");
  const pension = view(p, "pension");

  return {
    boardId: p.boardId,
    userId: p.userId,
    employeeId: self ? p.employeeId : null,
    sectionId: self ? p.sectionId : null,
    pensionerId: p.pensionerId,
    sensitive,
    reach: {
      people: staff("employee_master", { section: true }),
      service: staff("service_book", { ownAlways: true }),
      attendance: staff("attendance", { section: true, ownAlways: true }),
      leave: staff("leave", { section: true, ownAlways: true }),
      payroll: money(staff("payroll", { ownAlways: true })),
      loans: money(staff("arrears_loans")),
      statutory: money(staff("statutory", { ownAlways: true })),
      pension: money(pension === "all" ? "all" : p.pensionerId && p.isPensioner ? "own" : "none"),
      rates: whole("rates_rules"),
      recruitment: whole("recruitment"),
      users: whole("users_settings"),
      audit: audit === "all" ? "all" : audit === "system" ? "system" : "none",
    },
  };
}

/** The pass as it is stored: only what the views read. */
export function scopeJson(scope: AskScope): Record<AskArea, Reach> {
  return { ...scope.reach };
}

/** True when the person can read anything at all through Ask AI's records (documents are separate). */
export function hasAnyReach(scope: AskScope): boolean {
  return ASK_AREAS.some((a) => scope.reach[a] !== "none");
}
