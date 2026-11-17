/**
 * Ask AI: the check every SQL statement written by the model passes before it runs.
 *
 * The statement is parsed with PostgreSQL's own parser (libpg-query, the server's grammar compiled to WebAssembly)
 * and the tree is walked with allowlists: one SELECT; only the views listed for this person (or the query's own WITH
 * names); only the node types, functions, operators and types named here. Anything not named is refused — a new
 * PostgreSQL feature is closed until someone opens it.
 *
 * This is the first of three walls. The statement then runs as a database role that can read nothing but the "ask"
 * views (runner.ts), and each view shows only the rows of the person's pass (the views migration).
 */
import { loadModule, parseSync } from "libpg-query";

export const MAX_SQL_LENGTH = 6000;

export type GuardResult = { ok: true; sql: string; views: string[] } | { ok: false; reason: string };

class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason);
};

const ALLOWED_NODES = new Set([
  "SelectStmt",
  "ResTarget",
  "ColumnRef",
  "A_Const",
  "A_Expr",
  "A_Star",
  "A_ArrayExpr",
  "A_Indirection",
  "A_Indices",
  "BoolExpr",
  "NullTest",
  "BooleanTest",
  "CaseExpr",
  "CaseWhen",
  "CoalesceExpr",
  "MinMaxExpr",
  "RowExpr",
  "TypeCast",
  "FuncCall",
  "SQLValueFunction",
  "SubLink",
  "JoinExpr",
  "RangeVar",
  "RangeSubselect",
  "RangeFunction",
  "Alias",
  "SortBy",
  "WindowDef",
  "GroupingSet",
  "CommonTableExpr",
  "List",
  "String",
  "Integer",
  "Float",
  "Boolean",
]);

/** Functions a question about records needs. Nothing that reads settings, files, other sessions or the catalogue. */
const ALLOWED_FUNCTIONS = new Set([
  // totals
  "count", "sum", "avg", "min", "max", "string_agg", "array_agg", "bool_and", "bool_or", "every", "percentile_cont", "percentile_disc", "mode",
  // ranking
  "row_number", "rank", "dense_rank", "percent_rank", "ntile", "lag", "lead", "first_value", "last_value", "nth_value",
  // text
  "lower", "upper", "initcap", "length", "char_length", "btrim", "ltrim", "rtrim", "substring", "substr", "left", "right", "replace", "concat", "concat_ws", "split_part",
  "position", "strpos", "to_char", "starts_with", "translate", "reverse", "like_escape",
  // numbers
  "round", "ceil", "ceiling", "floor", "abs", "trunc", "mod", "power", "sqrt", "sign", "div", "to_number",
  // dates
  "now", "date_trunc", "date_part", "extract", "age", "to_date", "to_timestamp", "make_date", "make_interval", "timezone", "justify_days", "justify_interval",
  // lists
  "generate_series", "unnest", "array_length", "cardinality", "array_to_string", "string_to_array",
]);

const ALLOWED_OPERATORS = new Set([
  "=", "<>", "!=", "<", ">", "<=", ">=", "+", "-", "*", "/", "%", "^", "||",
  "~~", "!~~", "~~*", "!~~*", "~", "~*", "!~", "!~*", "&&", "@>", "<@",
  "BETWEEN", "NOT BETWEEN", "BETWEEN SYMMETRIC", "NOT BETWEEN SYMMETRIC",
]);

const ALLOWED_TYPES = new Set([
  "text", "varchar", "bpchar", "int2", "int4", "int8", "numeric", "float4", "float8", "bool", "date", "time", "timestamp", "timestamptz", "interval",
]);

const ALLOWED_VALUE_FUNCTIONS = new Set([
  "SVFOP_CURRENT_DATE",
  "SVFOP_CURRENT_TIME",
  "SVFOP_CURRENT_TIME_N",
  "SVFOP_CURRENT_TIMESTAMP",
  "SVFOP_CURRENT_TIMESTAMP_N",
  "SVFOP_LOCALTIME",
  "SVFOP_LOCALTIME_N",
  "SVFOP_LOCALTIMESTAMP",
  "SVFOP_LOCALTIMESTAMP_N",
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNodeKey = (k: string) => /^[A-Z]/.test(k);

/** A dotted name as the parser gives it: [{ String: { sval } }, …]. */
function nameParts(list: unknown, what: string): string[] {
  if (!Array.isArray(list) || list.length === 0) return refuse(`A ${what} has no name.`);
  return list.map((item) => {
    const s = isObj(item) && isObj(item.String) ? item.String.sval : undefined;
    return typeof s === "string" ? s : refuse(`A ${what} name is not plain text.`);
  });
}

/** `name` or `pg_catalog.name` — nothing from another schema. */
function plainName(list: unknown, what: string): string {
  const parts = nameParts(list, what);
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2 && parts[0] === "pg_catalog") return parts[1]!;
  return refuse(`The ${what} ${parts.join(".")} is not available.`);
}

interface Walk {
  allowed: ReadonlySet<string>;
  /** Every view name there is, allowed or not — a WITH name may not hide one. */
  reserved: ReadonlySet<string>;
  ctes: Set<string>;
  used: Set<string>;
}

function collectCtes(v: unknown, w: Walk): void {
  if (Array.isArray(v)) return v.forEach((x) => collectCtes(x, w));
  if (!isObj(v)) return;
  if (isObj(v.CommonTableExpr)) {
    const name = v.CommonTableExpr.ctename;
    if (typeof name !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(name)) return refuse("A WITH name must be a simple lower-case name.");
    if (name.startsWith("pg_") || w.reserved.has(name) || name === "ctx" || name === "emp") return refuse(`Choose another WITH name than "${name}" — it is the name of a view.`);
    w.ctes.add(name);
  }
  for (const x of Object.values(v)) collectCtes(x, w);
}

function checkType(t: unknown): void {
  if (!isObj(t)) return refuse("A cast has no type.");
  if (t.setof || t.pct_type || t.typeOid) return refuse("That type is not available.");
  const name = plainName(t.names, "type");
  if (!ALLOWED_TYPES.has(name)) return refuse(`The type ${name} is not available. Use text, numeric, integer, date, time, timestamp, interval or boolean.`);
  // typmods (numeric(10,2), varchar(20)) and array bounds are constants; still walked below.
}

function visit(v: unknown, w: Walk): void {
  if (Array.isArray(v)) return v.forEach((x) => visit(x, w));
  if (!isObj(v)) return;
  const keys = Object.keys(v);
  if (keys.length === 0) return;
  if (keys.length === 1 && isNodeKey(keys[0]!)) return visitNode(keys[0]!, v[keys[0]!], w);
  visitFields(v, null, w);
}

function visitNode(type: string, body: unknown, w: Walk): void {
  if (!ALLOWED_NODES.has(type)) return refuse(`${type} is not allowed here. Write one plain SELECT over the listed views.`);
  if (!isObj(body)) return;
  switch (type) {
    case "RangeVar": {
      const name = body.relname;
      if (typeof name !== "string") return refuse("A table has no name.");
      if (body.catalogname) return refuse("Name views without a database name.");
      if (body.schemaname !== undefined && body.schemaname !== "ask") return refuse(`${String(body.schemaname)}.${name} is not available. Use only the listed views.`);
      const isCte = body.schemaname === undefined && w.ctes.has(name);
      if (!isCte) {
        if (!w.allowed.has(name)) {
          return refuse(
            w.reserved.has(name)
              ? `The view "${name}" is not available to this user — they do not have access to that information. Do not try another way to reach it; tell them it is outside what they can see.`
              : `There is no view "${name}". Use only the listed views.`,
          );
        }
        w.used.add(name);
      }
      break;
    }
    case "FuncCall": {
      const fn = plainName(body.funcname, "function");
      if (!ALLOWED_FUNCTIONS.has(fn)) return refuse(`The function ${fn}() is not available. Available: ${[...ALLOWED_FUNCTIONS].join(", ")}.`);
      break;
    }
    case "A_Expr": {
      const parts = nameParts(body.name, "operator");
      if (parts.length !== 1 || !ALLOWED_OPERATORS.has(parts[0]!)) return refuse(`The operator ${parts.join(".")} is not available.`);
      break;
    }
    case "SQLValueFunction": {
      if (typeof body.op !== "string" || !ALLOWED_VALUE_FUNCTIONS.has(body.op)) return refuse("Only CURRENT_DATE, CURRENT_TIME and CURRENT_TIMESTAMP are available.");
      break;
    }
    case "CommonTableExpr": {
      if (!isObj(body.ctequery) || !isObj(body.ctequery.SelectStmt)) return refuse("A WITH query must be a SELECT.");
      break;
    }
    default:
      break;
  }
  visitFields(body, type, w);
}

function visitFields(obj: Obj, type: string | null, w: Walk): void {
  for (const [key, value] of Object.entries(obj)) {
    if (isNodeKey(key)) return refuse("The statement could not be read safely.");
    if (key === "intoClause") return refuse("SELECT … INTO is not allowed.");
    if (key === "lockingClause") return refuse("FOR UPDATE / FOR SHARE is not allowed.");
    if (key === "recursive" && value) return refuse("WITH RECURSIVE is not allowed.");
    if (key === "relname" && type !== "RangeVar") return refuse("The statement could not be read safely.");
    if (key === "funcname" && type !== "FuncCall") return refuse("The statement could not be read safely.");
    if (key === "names") return refuse("The statement could not be read safely.");
    if (key === "typeName") {
      checkType(value);
      if (isObj(value)) {
        visit(value.typmods, w);
        visit(value.arrayBounds, w);
      }
      continue;
    }
    visit(value, w);
  }
}

let ready: Promise<void> | undefined;

/** Loads the parser once (a few milliseconds). */
export function loadSqlParser(): Promise<void> {
  return (ready ??= loadModule());
}

/**
 * Checks one statement. `allowed`: the views listed for this person; `reserved`: every view name there is.
 * The reason of a refusal is written for the model, so it can correct itself or tell the person it has no access.
 */
export function checkSql(raw: unknown, allowed: ReadonlySet<string>, reserved: ReadonlySet<string> = allowed): GuardResult {
  if (typeof raw !== "string") return { ok: false, reason: "The SQL must be text." };
  const sql = raw.trim().replace(/;+\s*$/, "").trim();
  if (!sql) return { ok: false, reason: "The SQL is empty." };
  if (sql.length > MAX_SQL_LENGTH) return { ok: false, reason: `The SQL is too long (over ${MAX_SQL_LENGTH} characters). Ask for less in one statement.` };
  if (sql.includes("\0")) return { ok: false, reason: "The SQL has a character that is not allowed." };

  let tree: { stmts?: unknown };
  try {
    tree = parseSync(sql) as { stmts?: unknown };
  } catch (e) {
    return { ok: false, reason: `PostgreSQL could not read the statement: ${e instanceof Error ? e.message : "syntax error"}` };
  }
  const stmts = tree.stmts;
  if (!Array.isArray(stmts) || stmts.length !== 1) return { ok: false, reason: "Send exactly one SELECT statement." };
  const stmt = isObj(stmts[0]) ? stmts[0].stmt : undefined;
  if (!isObj(stmt) || !isObj(stmt.SelectStmt) || Object.keys(stmt).length !== 1) return { ok: false, reason: "Only SELECT statements are allowed — the records cannot be changed from here." };

  const w: Walk = { allowed, reserved, ctes: new Set(), used: new Set() };
  try {
    collectCtes(stmt, w);
    visit(stmt, w);
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.message };
    throw e;
  }
  return { ok: true, sql, views: [...w.used].sort() };
}
