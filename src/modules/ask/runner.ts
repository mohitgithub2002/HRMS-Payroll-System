import "server-only";
import { randomBytes } from "node:crypto";
import pg from "pg";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ASK_VIEW_NAMES, viewsFor } from "./catalog";
import { scopeJson, type AskScope } from "./scope";
import { checkSql, loadSqlParser } from "./sql-guard";

/**
 * Ask AI: runs one checked SELECT for one person.
 *
 * 1. The statement passes the guard (sql-guard.ts): one SELECT over the views listed for the person.
 * 2. A pass is written for a few seconds: whose question it is and how far each area reaches (scope.ts).
 * 3. On a separate connection, in a read-only transaction with a time limit, the application steps down to the role
 *    "dcb_ask" — which can read the "ask" views and nothing else — sets the pass's token and hands the statement to
 *    the database function ask.run(), which executes as dcb_ask and inside which PostgreSQL refuses any change of
 *    role. The views show only the rows of the pass. At most MAX_ROWS rows come back; the transaction is always
 *    rolled back; the pass is removed.
 *
 * ASK_DATABASE_URL, when set, is a database login that already is (or belongs to) dcb_ask: then not even the
 * connection could read a table. Without it the application's own login is used and steps down for the statement.
 */
export const ASK_ROLE = "dcb_ask";
export const MAX_ROWS = 200;
const STATEMENT_TIMEOUT_MS = 8_000;
const PASS_SECONDS = 30;
const MAX_CELL = 400;

export interface AskColumnOut {
  name: string;
  /** How the screen lines the column up. */
  kind: "text" | "number" | "boolean";
}

export type AskCell = string | number | boolean | null;

export type SqlOutcome =
  | { ok: true; sql: string; views: string[]; columns: AskColumnOut[]; rows: AskCell[][]; truncated: boolean; ms: number }
  | { ok: false; sql: string; refused: boolean; reason: string };

const store = globalThis as unknown as { __dcbAskPool?: pg.Pool };

/** A small pool of its own: values come back as text (no time-zone surprises), and a slow question never takes a connection from the screens. */
function pool(): pg.Pool {
  if (!store.__dcbAskPool) {
    const connectionString = process.env.ASK_DATABASE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    store.__dcbAskPool = new pg.Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      types: { getTypeParser: () => (value: string) => value } as unknown as pg.CustomTypesConfig,
    });
    store.__dcbAskPool.on("error", (e) => console.error("[ask] database connection error", e.message));
  }
  return store.__dcbAskPool;
}

/** Tests only: closes the pool so the process can end. */
export async function closeAskPool() {
  await store.__dcbAskPool?.end();
  store.__dcbAskPool = undefined;
}

function cell(value: unknown): AskCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
}

/** Writes the pass, runs `fn` with its token and removes the pass — also when `fn` fails. */
async function withPass<T>(scope: AskScope, fn: (token: string) => Promise<T>): Promise<T> {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  await db.askGrant.create({
    data: {
      token,
      boardId: scope.boardId,
      userId: scope.userId,
      employeeId: scope.employeeId,
      sectionId: scope.sectionId,
      pensionerId: scope.pensionerId,
      scopes: scopeJson(scope) as unknown as Prisma.InputJsonValue,
      sensitive: scope.sensitive,
      expiresAt: new Date(now + PASS_SECONDS * 1000),
    },
  });
  try {
    return await fn(token);
  } finally {
    // This pass, and any left behind by a process that stopped half-way (they had expired anyway).
    await db.askGrant.deleteMany({ where: { OR: [{ token }, { expiresAt: { lt: new Date(now - 60_000) } }] } }).catch(() => undefined);
  }
}

/**
 * Runs a statement exactly as given, as dcb_ask with the person's pass. No guard — exported for the tests that prove
 * the database itself refuses what the guard would have refused. The application calls runAskSql.
 */
export async function runAsAskRole(scope: AskScope, sql: string, opts: { token?: string } = {}): Promise<{ columns: AskColumnOut[]; rows: AskCell[][]; truncated: boolean }> {
  const run = async (token: string) => {
    const client = await pool().connect();
    let broken = false;
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query("SELECT set_config('ask.token', $1, true)", [token]);
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      await client.query("SET LOCAL lock_timeout = 2000");
      await client.query(`SET LOCAL ROLE ${ASK_ROLE}`);
      const who = await client.query("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su");
      if (who.rows[0]?.u !== ASK_ROLE || who.rows[0]?.su === "t") throw new Error("Ask AI could not step down to its read-only role");
      // Each row comes back as a JSON list of [column, value] pairs, in the statement's own column order.
      const res = await client.query<{ r: string }>("SELECT r FROM ask.run($1, $2) AS r", [sql, MAX_ROWS + 1]);
      const all = res.rows.map((row) => JSON.parse(row.r) as [string, unknown][]);
      const shown = all.slice(0, MAX_ROWS);
      const rows = shown.map((pairs) => pairs.map(([, v]) => cell(v)));
      const columns: AskColumnOut[] = (shown[0] ?? []).map(([name], i) => {
        const sample = rows.find((r) => r[i] !== null)?.[i];
        return { name, kind: typeof sample === "number" ? "number" : typeof sample === "boolean" ? "boolean" : "text" };
      });
      return { columns, rows, truncated: all.length > MAX_ROWS };
    } catch (e) {
      // A connection that failed outside a statement is not put back.
      broken = !(e instanceof pg.DatabaseError);
      throw e;
    } finally {
      // Always rolled back: nothing a question does is kept, and the role and the token end with the transaction.
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      client.release(broken ? true : undefined);
    }
  };
  return opts.token ? run(opts.token) : withPass(scope, run);
}

/** A database error as the model may read it: the message, never the connection details. */
function dbReason(e: unknown): string {
  if (e instanceof pg.DatabaseError) {
    if (e.code === "57014") return "The statement took too long and was stopped. Ask for less: fewer rows, a narrower period, or totals instead of every row.";
    if (e.code === "42501") return "That information is not available to this user.";
    return `PostgreSQL: ${e.message}${e.hint ? ` (${e.hint})` : ""}`;
  }
  return "The statement could not be run.";
}

/** The application's way in: guard, then run. Never throws for a bad statement — the outcome says why. */
export async function runAskSql(scope: AskScope, rawSql: unknown): Promise<SqlOutcome> {
  await loadSqlParser();
  const allowed = new Set(viewsFor(scope).map((v) => v.view.name));
  const checked = checkSql(rawSql, allowed, ASK_VIEW_NAMES);
  const shown = typeof rawSql === "string" ? rawSql.trim().slice(0, 6000) : "";
  if (!checked.ok) return { ok: false, sql: shown, refused: true, reason: checked.reason };
  const started = Date.now();
  try {
    const out = await runAsAskRole(scope, checked.sql);
    return { ok: true, sql: checked.sql, views: checked.views, ...out, ms: Date.now() - started };
  } catch (e) {
    if (!(e instanceof pg.DatabaseError)) console.error("[ask] statement failed", e);
    return { ok: false, sql: checked.sql, refused: false, reason: dbReason(e) };
  }
}

/** Is the read-only role there and usable? (Shown to the Admin when it is not.) A yes is remembered for a while. */
export async function askRoleReady(): Promise<boolean> {
  const memo = globalThis as unknown as { __dcbAskRoleOk?: number };
  if (memo.__dcbAskRoleOk && Date.now() - memo.__dcbAskRoleOk < 10 * 60_000) return true;
  const ok = await checkAskRole();
  if (ok) memo.__dcbAskRoleOk = Date.now();
  return ok;
}

async function checkAskRole(): Promise<boolean> {
  try {
    const client = await pool().connect();
    try {
      // The honest test: step down and come back.
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL ROLE ${ASK_ROLE}`);
      await client.query("SELECT 1 FROM ask.me LIMIT 1");
      return true;
    } catch {
      return false;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  } catch {
    return false;
  }
}
