import { describe, expect, it } from "vitest";
import type { LoginType, Permission } from "@/generated/prisma/enums";
import { decidesKind, KIND_FN, kindsDecidedBy } from "@/lib/approvals/areas";
import { ACCOUNTS_FNS, can, canAll, canManageUsers, canSeeSensitive, holds, HR_FNS, isFullAdmin, permissionConflicts, scopeFor, type Action, type Fn, type Principal } from "@/lib/auth/access";
import { adminTools, hasApprovalsInbox, MAX_MENU_ITEMS, menuFor } from "@/lib/auth/menu";
import { ROLE_DEFS, roleOf, rolesForLogin, SIMPLE_ROLES } from "@/lib/auth/roles";
import { simpleStageIndex } from "@/modules/payroll/present";

/**
 * The simple way of working (Settings → How work is approved → Simple): the Admin sees and manages everything,
 * the HR manager everything about people, the Accounts manager everything about pay. The two-step matrix of
 * PRD §14 (access.test.ts) is untouched when the switch is off.
 */
const who = (loginType: LoginType, permissions: Permission[], simple = true): Principal => ({ loginType, permissions, isEmployee: loginType === "EMPLOYEE", isPensioner: false, simple });
const admin = who("ADMIN", ["APPROVER", "PAY_BILL_SIGNER"]);
const it_ = who("ADMIN", ["USER_SETTINGS_MANAGER"]);
const hr = who("HR_ACCOUNTS", ["HR"]);
const accounts = who("HR_ACCOUNTS", ["PAYROLL", "PENSION"]);
const employee = who("EMPLOYEE", []);
const officer = who("EMPLOYEE", ["REPORTING_OFFICER"]);
const ALL_FNS: Fn[] = ["employee_master", "service_book", "recruitment", "attendance", "leave", "payroll", "arrears_loans", "statutory", "pension", "rates_rules", "reports", "audit_trail", "users_settings", "migration"];
const ACTIONS: Action[] = ["view", "create", "check", "approve", "sign", "lock"];

describe("rights in the simple way of working", () => {
  it("the Admin sees and manages everything", () => {
    for (const fn of ALL_FNS) for (const action of ACTIONS) expect(scopeFor(admin, fn, action), `${fn} ${action}`).toBe("all");
    expect(isFullAdmin(admin)).toBe(true);
    expect(canSeeSensitive(admin)).toBe(true);
    expect(canManageUsers(admin)).toBe(true);
    expect(holds(admin, "CHECKER") && holds(admin, "PAYROLL") && holds(admin, "USER_SETTINGS_MANAGER")).toBe(true);
    expect(holds(admin, "REPORTING_OFFICER")).toBe(false);
  });

  it("the HR manager does everything about people, and nothing about pay", () => {
    for (const fn of HR_FNS) for (const action of ACTIONS) expect(scopeFor(hr, fn, action), `${fn} ${action}`).toBe("all");
    for (const fn of ["payroll", "arrears_loans", "statutory", "pension"] as Fn[]) for (const action of ACTIONS) expect(can(hr, fn, action), `${fn} ${action}`).toBe(false);
    expect(can(hr, "rates_rules", "approve")).toBe(false);
    expect(canManageUsers(hr)).toBe(false);
  });

  it("the Accounts manager does everything about pay, and only reads employee records", () => {
    for (const fn of ACCOUNTS_FNS) for (const action of ACTIONS) expect(scopeFor(accounts, fn, action), `${fn} ${action}`).toBe("all");
    expect(scopeFor(accounts, "employee_master", "view")).toBe("all");
    for (const action of ["create", "check", "approve"] as Action[]) expect(can(accounts, "employee_master", action), action).toBe(false);
    expect(can(accounts, "leave", "approve")).toBe(false);
    // A pension clerk alone runs pension bills, not salaries.
    const pension = who("HR_ACCOUNTS", ["PENSION"]);
    expect(canAll(pension, "pension", "approve")).toBe(true);
    expect(can(pension, "payroll", "create")).toBe(false);
  });

  it("IT support keeps users and settings only, and still never sees pay", () => {
    expect(isFullAdmin(it_)).toBe(false);
    expect(canManageUsers(it_)).toBe(true);
    expect(canSeeSensitive(it_)).toBe(false);
    expect(can(it_, "payroll", "view")).toBe(false);
    expect(can(it_, "employee_master", "view")).toBe(false);
  });

  it("employees and section heads are as before", () => {
    for (const p of [employee, officer]) {
      expect(scopeFor(p, "payroll", "view")).toBe("own");
      expect(scopeFor(p, "leave", "create")).toBe("own");
      expect(can(p, "payroll", "create")).toBe(false);
    }
    expect(scopeFor(officer, "leave", "approve")).toBe("section");
    // Permissions from another login never help, simple or not.
    expect(can(who("EMPLOYEE", ["APPROVER"]), "payroll", "approve")).toBe(false);
  });

  it("changes nothing when the Board works in two steps", () => {
    const strict = who("ADMIN", ["APPROVER", "PAY_BILL_SIGNER"], false);
    expect(can(strict, "payroll", "create")).toBe(false);
    expect(can(strict, "employee_master", "create")).toBe(false);
    expect(canManageUsers(strict)).toBe(false);
    expect(holds(strict, "CHECKER")).toBe(false);
    expect(can(who("HR_ACCOUNTS", ["HR"], false), "leave", "approve")).toBe(false);
    expect(permissionConflicts(["USER_SETTINGS_MANAGER", "APPROVER"])).toBe("settings_manager_conflict");
    expect(permissionConflicts(["USER_SETTINGS_MANAGER", "APPROVER"], true)).toBeNull();
  });
});

describe("who decides what in the simple way of working", () => {
  it("each kind of approval belongs to a function of the access matrix", () => {
    for (const [kind, fn] of Object.entries(KIND_FN)) expect(ALL_FNS, kind).toContain(fn);
  });

  it("HR decides requests about people, Accounts about pay, the Admin all of them", () => {
    expect(decidesKind(hr, "leave.apply")).toBe(true);
    expect(decidesKind(hr, "employee.self_request")).toBe(true);
    expect(decidesKind(hr, "service_book.entry")).toBe(true);
    expect(decidesKind(hr, "loan.sanction")).toBe(false);
    expect(decidesKind(hr, "rate.change")).toBe(false);
    expect(decidesKind(accounts, "loan.sanction")).toBe(true);
    expect(decidesKind(accounts, "tax.declaration")).toBe(true);
    expect(decidesKind(accounts, "pension.lifecert")).toBe(true);
    expect(decidesKind(accounts, "leave.apply")).toBe(false);
    expect(kindsDecidedBy(admin).sort()).toEqual(Object.keys(KIND_FN).sort());
  });

  it("nobody decides by desk in the two-step way, and an employee never does", () => {
    expect(kindsDecidedBy(who("HR_ACCOUNTS", ["HR"], false))).toEqual([]);
    expect(decidesKind(who("ADMIN", ["APPROVER"], false), "leave.apply")).toBe(false);
    expect(kindsDecidedBy(officer)).toEqual([]);
  });
});

describe("menus in the simple way of working", () => {
  const keys = (p: Principal) => menuFor(p).map((m) => m.key);

  it("the Admin's menu follows the Board's work; the tools are behind More", () => {
    expect(keys(admin)).toEqual(["home", "employees", "recruitment", "attendanceLeave", "payroll", "pension", "reports", "admin"]);
    expect(adminTools(admin).map((m) => m.key)).toEqual(["approvals", "statutory", "users", "rates", "settings", "migration", "audit"]);
    expect(hasApprovalsInbox(admin)).toBe(true);
  });

  it("HR sees people and hiring; Accounts sees pay — not each other's screens", () => {
    expect(keys(hr)).toEqual(["home", "employees", "recruitment", "attendanceLeave", "reports"]);
    expect(keys(accounts)).toEqual(["home", "employees", "attendanceLeave", "payroll", "statutory", "pension", "reports"]);
    expect(keys(who("HR_ACCOUNTS", ["HR", "PAYROLL", "PENSION"]))).toEqual(["home", "employees", "recruitment", "attendanceLeave", "payroll", "statutory", "pension", "reports"]);
  });

  it("IT support and employees keep their menus, and no menu is longer than 8", () => {
    expect(keys(it_)).toEqual(["home", "users", "settings", "migration", "audit"]);
    expect(keys(employee)).toEqual(["home", "payslips", "leave", "attendance", "myRecord", "requests"]);
    for (const p of [admin, it_, hr, accounts, employee, officer]) expect(keys(p).length).toBeLessThanOrEqual(MAX_MENU_ITEMS);
  });
});

describe("roles (the Users screen in the simple way of working)", () => {
  it("every role is a set of permissions its login may hold, and reads back as itself", () => {
    for (const role of SIMPLE_ROLES) {
      const def = ROLE_DEFS[role];
      expect(roleOf(def.loginType, def.permissions), role).toBe(role);
      expect(rolesForLogin(def.loginType)).toContain(role);
      // A role never mixes "users and settings" with approving pay, so it is valid in the two-step way too.
      expect(permissionConflicts(def.permissions), role).toBeNull();
    }
  });

  it("names logins made in the two-step way", () => {
    expect(roleOf("ADMIN", ["APPROVER"])).toBe("ADMIN");
    expect(roleOf("HR_ACCOUNTS", ["HR", "CHECKER"])).toBe("HR");
    expect(roleOf("HR_ACCOUNTS", ["PAYROLL"])).toBe("ACCOUNTS");
    expect(roleOf("HR_ACCOUNTS", ["PENSION"])).toBe("ACCOUNTS");
    expect(roleOf("HR_ACCOUNTS", ["CHECKER"])).toBe("OTHER");
    expect(roleOf("EMPLOYEE", [])).toBe("EMPLOYEE");
  });
});

describe("payroll in three steps", () => {
  it("work out, review, pay", () => {
    expect([null, "DRAFT", "CHECKING", "APPROVING", "APPROVED", "PAID", "CLOSED"].map((s) => simpleStageIndex(s as never))).toEqual([0, 1, 1, 1, 2, 2, 3]);
  });
});
