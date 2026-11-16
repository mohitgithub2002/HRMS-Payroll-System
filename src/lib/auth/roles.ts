/**
 * The simple way of working names people by role instead of ticked permissions. A role is only a ready-made set of
 * the same permissions (PRD §2), so a Board can move between the simple and the two-step way without touching its
 * users. Pure module — used by the Users screen, the shell and the tests.
 */
import type { LoginType, Permission } from "@/generated/prisma/enums";

export type SimpleRole = "ADMIN" | "IT" | "HR" | "ACCOUNTS" | "HR_ACCOUNTS" | "EMPLOYEE" | "OFFICER";

export const ROLE_DEFS: Record<SimpleRole, { loginType: LoginType; permissions: Permission[] }> = {
  // Approver + Pay bill signer: in the simple way this login sees and manages everything.
  ADMIN: { loginType: "ADMIN", permissions: ["APPROVER", "PAY_BILL_SIGNER"] },
  IT: { loginType: "ADMIN", permissions: ["USER_SETTINGS_MANAGER"] },
  HR: { loginType: "HR_ACCOUNTS", permissions: ["HR"] },
  ACCOUNTS: { loginType: "HR_ACCOUNTS", permissions: ["PAYROLL", "PENSION"] },
  HR_ACCOUNTS: { loginType: "HR_ACCOUNTS", permissions: ["HR", "PAYROLL", "PENSION"] },
  EMPLOYEE: { loginType: "EMPLOYEE", permissions: [] },
  OFFICER: { loginType: "EMPLOYEE", permissions: ["REPORTING_OFFICER"] },
};

export const SIMPLE_ROLES = Object.keys(ROLE_DEFS) as SimpleRole[];

/** The roles a login of this type can hold (the login type of a user never changes). */
export function rolesForLogin(loginType: LoginType): SimpleRole[] {
  return SIMPLE_ROLES.filter((r) => ROLE_DEFS[r].loginType === loginType);
}

/**
 * The role a login plays, read from its permissions; "OTHER" when they fit no role (for example a Checker-only
 * login made in the two-step way).
 */
export function roleOf(loginType: LoginType, permissions: readonly Permission[]): SimpleRole | "OTHER" {
  const has = (p: Permission) => permissions.includes(p);
  if (loginType === "ADMIN") return has("APPROVER") ? "ADMIN" : has("USER_SETTINGS_MANAGER") ? "IT" : "OTHER";
  if (loginType === "EMPLOYEE") return has("REPORTING_OFFICER") ? "OFFICER" : "EMPLOYEE";
  if (has("HR") && has("PAYROLL")) return "HR_ACCOUNTS";
  if (has("HR")) return "HR";
  if (has("PAYROLL") || has("PENSION")) return "ACCOUNTS";
  return "OTHER";
}
