import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { cache } from "react";
import type { EmployeeStatus, LoginType, Permission, UserStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";
import { todayIST, toISODate } from "@/lib/dates";
import { secureCookies } from "@/lib/env";
import { getRequestMeta } from "@/lib/request-meta";
import type { Principal } from "./access";
import { accessState } from "./access-state";
import { pensionView } from "./pensioner";
import { rememberWorkflow } from "@/modules/settings/workflow";

export const SESSION_COOKIE = "dcb_session";
/** PRD §2 rule 7 / §16: sessions time out after 15 minutes idle. */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** Hard limit even for an active session — one working day. */
const ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** lastSeenAt is written at most this often to keep the database quiet. */
const TOUCH_INTERVAL_MS = 30 * 1000;

/** Everything a service needs to know about who is acting. */
export interface Actor extends Principal {
  userId: string;
  sessionId: string;
  boardId: string;
  loginId: string;
  name: string;
  nameHi: string | null;
  loginType: LoginType;
  permissions: Permission[];
  employeeId: string | null;
  /** The pension this login sees, once the person is a pensioner (PN-12). */
  pensionerId: string | null;
  /** Section of the person's own employee record — the reporting officer's scope (PRD §2 rule 5). */
  sectionId: string | null;
  language: "en" | "hi";
  mustChangePassword: boolean;
  ip: string | null;
  userAgent: string | null;
}

export async function createSession(userId: string, meta: { ip: string | null; userAgent: string | null }) {
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = new Date(now + ABSOLUTE_LIFETIME_MS);
  await db.session.create({
    data: { id: sha256(token), userId, expiresAt, ip: meta.ip, userAgent: meta.userAgent },
  });
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * The signed-in person for this request, or null. Checks revocation, the 15-minute idle limit,
 * the absolute lifetime, the login's status and whether the person's access has ended.
 * Cached per request so layouts, pages and services share one lookup.
 */
export const getActor = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const id = sha256(token);
  // Every page and API call starts here, so it is one round trip to the database: the session with its login, the
  // person's employee record, the pension the login sees and the Board's way of working.
  const rows = await db.$queryRaw<SessionRow[]>`
    SELECT s.id, s."revokedAt" AS "revokedAt", s."expiresAt" AS "expiresAt", s."lastSeenAt" AS "lastSeenAt",
           u.id AS "userId", u."boardId" AS "boardId", u."loginId" AS "loginId", u."displayName" AS "displayName",
           u."displayNameHi" AS "displayNameHi", u."loginType"::text AS "loginType", u.permissions::text[] AS permissions,
           u.status::text AS "userStatus", u.language, u."mustChangePassword" AS "mustChangePassword",
           u."employeeId" AS "employeeId", u."pensionerId" AS "userPensionerId",
           e."sectionId" AS "sectionId", e.status::text AS "employeeStatus", e."exitDate" AS "exitDate", e."dateOfRetirement" AS "dateOfRetirement",
           pen.id AS "pensionId", pen."startDate" AS "pensionStart", pen."endDate" AS "pensionEnd",
           w.value AS workflow
    FROM "Session" s
    JOIN "User" u ON u.id = s."userId"
    LEFT JOIN "Employee" e ON e.id = u."employeeId"
    LEFT JOIN LATERAL (
      SELECT p.id, p."startDate", p."endDate" FROM "Pensioner" p
      WHERE u."loginType" = 'EMPLOYEE'
        AND ((u."pensionerId" IS NOT NULL AND p.id = u."pensionerId")
          OR (u."pensionerId" IS NULL AND u."employeeId" IS NOT NULL AND p."employeeId" = u."employeeId" AND p.relation = 'SELF'))
      ORDER BY p."startDate" DESC
      LIMIT 1
    ) pen ON true
    LEFT JOIN "Setting" w ON w."boardId" = u."boardId" AND w.key = 'workflow'
    WHERE s.id = ${id}`;
  const row = rows[0];
  if (!row || row.revokedAt) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() <= now || now - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) {
    await db.session.update({ where: { id }, data: { revokedAt: new Date() } }).catch(() => undefined);
    return null;
  }

  const pension = row.loginType === "EMPLOYEE" ? pensionView(row.pensionId ? { id: row.pensionId, startDate: row.pensionStart!, endDate: row.pensionEnd } : null) : null;
  const state = accessState(
    {
      userStatus: row.userStatus,
      loginType: row.loginType,
      employee: row.employeeStatus
        ? {
            status: row.employeeStatus,
            exitDate: row.exitDate ? toISODate(row.exitDate) : null,
            dateOfRetirement: row.dateOfRetirement ? toISODate(row.dateOfRetirement) : null,
          }
        : null,
      pensionFrom: pension?.from ?? null,
    },
    todayIST(),
  );
  if (!state.allowed) return null;

  // The idle clock: written at most every 30 seconds, after the response, so no page waits for it.
  if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const touch = () => db.session.update({ where: { id }, data: { lastSeenAt: new Date(now) } }).then(() => undefined, () => undefined);
    try {
      after(touch);
    } catch {
      await touch(); // outside a request (scripts)
    }
  }

  const meta = await getRequestMeta();
  return {
    userId: row.userId,
    sessionId: id,
    boardId: row.boardId,
    loginId: row.loginId,
    name: row.displayName,
    nameHi: row.displayNameHi,
    loginType: row.loginType,
    permissions: row.permissions,
    employeeId: row.employeeId,
    pensionerId: state.isPensioner ? pension!.id : null,
    sectionId: row.sectionId,
    isEmployee: state.isEmployee,
    isPensioner: state.isPensioner,
    simple: rememberWorkflow(row.boardId, row.workflow),
    language: row.language === "hi" ? "hi" : "en",
    mustChangePassword: row.mustChangePassword,
    ip: meta.ip,
    userAgent: meta.userAgent,
  };
});

interface SessionRow {
  id: string;
  revokedAt: Date | null;
  expiresAt: Date;
  lastSeenAt: Date;
  userId: string;
  boardId: string;
  loginId: string;
  displayName: string;
  displayNameHi: string | null;
  loginType: LoginType;
  permissions: Permission[];
  userStatus: UserStatus;
  language: string;
  mustChangePassword: boolean;
  employeeId: string | null;
  userPensionerId: string | null;
  sectionId: string | null;
  employeeStatus: EmployeeStatus | null;
  exitDate: Date | null;
  dateOfRetirement: Date | null;
  pensionId: string | null;
  pensionStart: Date | null;
  pensionEnd: Date | null;
  workflow: unknown;
}

/** For pages and layouts: the actor, or a redirect to the sign-in screen. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) {
    // A cookie that no longer works means the session ended (idle timeout, sign-out elsewhere).
    const hadSession = (await cookies()).has(SESSION_COOKIE);
    redirect(hadSession ? "/login?reason=timeout" : "/login");
  }
  return actor;
}

export async function revokeSession(sessionId: string) {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  await db.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}
