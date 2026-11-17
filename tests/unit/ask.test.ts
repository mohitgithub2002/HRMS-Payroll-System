import { beforeAll, describe, expect, it } from "vitest";
import type { LoginType, Permission } from "@/generated/prisma/enums";
import { canManageKnowledge, canUseAsk, knowledgeAudiences } from "@/lib/auth/access";
import { ASK_VIEW_NAMES, ASK_VIEWS, describeViews, viewsFor } from "@/modules/ask/catalog";
import { findPassages, partsOf, words } from "@/modules/ask/passages";
import { buildSystemPrompt } from "@/modules/ask/prompt";
import { askScope, hasAnyReach, type AskPrincipal } from "@/modules/ask/scope";
import { checkSql, loadSqlParser, MAX_SQL_LENGTH } from "@/modules/ask/sql-guard";

/**
 * Ask AI: how far each login's questions reach (PRD §14), which views are listed for it, and the guard every
 * statement written by the model passes. The same rules on a real database: tests/integration/ask.test.ts.
 */
const who = (loginType: LoginType, permissions: Permission[], extra: Partial<AskPrincipal> = {}): AskPrincipal => ({
  loginType,
  permissions,
  isEmployee: loginType === "EMPLOYEE",
  isPensioner: false,
  boardId: "b1",
  userId: "u1",
  employeeId: loginType === "EMPLOYEE" ? "e1" : null,
  sectionId: loginType === "EMPLOYEE" ? "s1" : null,
  pensionerId: null,
  ...extra,
});

const employee = who("EMPLOYEE", []);
const officer = who("EMPLOYEE", ["REPORTING_OFFICER"]);
const pensioner = who("EMPLOYEE", [], { isEmployee: false, isPensioner: true, pensionerId: "p1" });
const hr = who("HR_ACCOUNTS", ["HR"]);
const payroll = who("HR_ACCOUNTS", ["PAYROLL"]);
const pension = who("HR_ACCOUNTS", ["PENSION"]);
const checker = who("HR_ACCOUNTS", ["CHECKER"]);
const approver = who("ADMIN", ["APPROVER"]);
const itSupport = who("ADMIN", ["USER_SETTINGS_MANAGER"]);

describe("how far a login's questions reach (two steps — PRD §14)", () => {
  it("an employee: their own record and nothing else", () => {
    const s = askScope(employee);
    expect(s.reach).toEqual({
      people: "own", service: "own", attendance: "own", leave: "own", payroll: "own", loans: "own", statutory: "own",
      pension: "none", rates: "none", recruitment: "none", users: "none", audit: "none",
    });
    expect(s.sensitive).toBe(true);
    expect(s.employeeId).toBe("e1");
  });

  it("a section head: the section for people, attendance and leave — pay stays their own", () => {
    const s = askScope(officer);
    expect(s.reach.people).toBe("section");
    expect(s.reach.attendance).toBe("section");
    expect(s.reach.leave).toBe("section");
    expect(s.reach.payroll).toBe("own");
    expect(s.reach.loans).toBe("own");
    expect(s.reach.statutory).toBe("own");
    expect(s.reach.service).toBe("own");
  });

  it("a section head without a section falls back to their own record", () => {
    expect(askScope({ ...officer, sectionId: null }).reach.people).toBe("own");
    expect(askScope({ ...officer, sectionId: null }).reach.leave).toBe("own");
  });

  it("a pensioner: the pension only — not the old employee record", () => {
    const s = askScope({ ...pensioner, employeeId: "e9", sectionId: "s9" });
    expect(s.reach.pension).toBe("own");
    for (const area of ["people", "service", "attendance", "leave", "payroll", "loans", "statutory", "rates", "recruitment", "users", "audit"] as const) expect(s.reach[area], area).toBe("none");
    expect(s.employeeId).toBeNull();
    expect(s.sectionId).toBeNull();
  });

  it("HR: everyone's records, attendance and leave — no pay, loans, tax or pension", () => {
    const s = askScope(hr);
    expect(s.reach.people).toBe("all");
    expect(s.reach.service).toBe("all");
    expect(s.reach.attendance).toBe("all");
    expect(s.reach.leave).toBe("all");
    expect(s.reach.recruitment).toBe("all");
    expect(s.reach.rates).toBe("all");
    for (const area of ["payroll", "loans", "statutory", "pension", "users", "audit"] as const) expect(s.reach[area], area).toBe("none");
  });

  it("HR with their own employee record also reads their own payslips, like on My payslips", () => {
    expect(askScope({ ...hr, employeeId: "e5" }).reach.payroll).toBe("own");
  });

  it("Payroll: pay, loans, tax — not pension", () => {
    const s = askScope(payroll);
    expect(s.reach.payroll).toBe("all");
    expect(s.reach.loans).toBe("all");
    expect(s.reach.statutory).toBe("all");
    expect(s.reach.pension).toBe("none");
    expect(s.reach.leave).toBe("all");
  });

  it("Pension: pensions and people — not salaries", () => {
    const s = askScope(pension);
    expect(s.reach.pension).toBe("all");
    expect(s.reach.people).toBe("all");
    expect(s.reach.payroll).toBe("none");
    expect(s.reach.leave).toBe("none");
  });

  it("a Checker sees what is checked — and no leave, which the matrix does not give", () => {
    const s = askScope(checker);
    expect(s.reach.payroll).toBe("all");
    expect(s.reach.pension).toBe("all");
    expect(s.reach.leave).toBe("none");
    expect(s.reach.rates).toBe("none");
  });

  it("the Approver sees every area", () => {
    const s = askScope(approver);
    for (const area of Object.keys(s.reach) as (keyof typeof s.reach)[]) expect(s.reach[area], area).toBe("all");
  });

  it("the User & settings manager: logins and system events — never pay, bank or people (PRD §2 rule 3)", () => {
    const s = askScope(itSupport);
    expect(s.sensitive).toBe(false);
    expect(s.reach.users).toBe("all");
    expect(s.reach.audit).toBe("system");
    for (const area of ["people", "service", "attendance", "leave", "payroll", "loans", "statutory", "pension", "rates", "recruitment"] as const) expect(s.reach[area], area).toBe("none");
    // Even with an employee record of their own: money areas stay closed.
    const own = askScope({ ...itSupport, employeeId: "e7", sectionId: "s7" });
    for (const area of ["payroll", "loans", "statutory", "pension"] as const) expect(own.reach[area], area).toBe("none");
  });

  it("a login with nothing ticked reads nothing", () => {
    expect(hasAnyReach(askScope(who("HR_ACCOUNTS", [])))).toBe(false);
  });
});

describe("how far a login's questions reach (the simple way of working)", () => {
  const simple = (p: AskPrincipal): AskPrincipal => ({ ...p, simple: true });

  it("the Admin sees everything, pay included", () => {
    const s = askScope(simple(who("ADMIN", ["APPROVER", "PAY_BILL_SIGNER"])));
    for (const area of Object.keys(s.reach) as (keyof typeof s.reach)[]) expect(s.reach[area], area).toBe("all");
    expect(s.sensitive).toBe(true);
  });

  it("the HR manager: people — still no pay", () => {
    const s = askScope(simple(hr));
    expect(s.reach.people).toBe("all");
    expect(s.reach.leave).toBe("all");
    for (const area of ["payroll", "loans", "statutory", "pension"] as const) expect(s.reach[area], area).toBe("none");
  });

  it("the Accounts manager: pay and pension", () => {
    const s = askScope(simple(who("HR_ACCOUNTS", ["PAYROLL", "PENSION"])));
    for (const area of ["payroll", "loans", "statutory", "pension", "rates"] as const) expect(s.reach[area], area).toBe("all");
  });

  it("IT support still sees no pay and no people", () => {
    const s = askScope(simple(itSupport));
    expect(s.sensitive).toBe(false);
    expect(s.reach.people).toBe("none");
    expect(s.reach.payroll).toBe("none");
  });

  it("employees and section heads are as before", () => {
    expect(askScope(simple(employee)).reach).toEqual(askScope(employee).reach);
    expect(askScope(simple(officer)).reach).toEqual(askScope(officer).reach);
  });
});

describe("the views listed for a login", () => {
  const names = (p: AskPrincipal) => viewsFor(askScope(p)).map((v) => v.view.name);

  it("an employee is not told about bills, other people's pay, rates, hiring, logins or the audit trail", () => {
    const list = names(employee);
    for (const v of ["me", "employees", "payslips", "payslip_lines", "leave_balances", "attendance_days", "holidays", "leave_types", "loans", "gpf_balances", "tax_slabs"]) expect(list, v).toContain(v);
    for (const v of ["payroll_runs", "payroll_checks", "pay_items", "pay_rates", "pay_matrix", "vacancies", "applicants", "users", "audit_log", "pensioners", "separations", "sanctioned_posts", "tds_challans"]) expect(list, v).not.toContain(v);
  });

  it("says whose rows a view holds for this login", () => {
    const rows = (p: AskPrincipal, view: string) => viewsFor(askScope(p)).find((v) => v.view.name === view)?.rows;
    expect(rows(employee, "payslips")).toBe("the user's own record only");
    expect(rows(officer, "employees")).toBe("the staff of the user's own section (and the user)");
    expect(rows(officer, "family_members")).toBe("the user's own record only");
    expect(rows(payroll, "payslips")).toBe("everyone of the Board");
    expect(rows(payroll, "payroll_runs")).toBe("salary bills (not pension bills)");
    expect(rows(pension, "payroll_runs")).toBe("pension bills only");
    expect(rows(itSupport, "audit_log")).toBe("system events only (logins, users, settings)");
  });

  it("HR has no pay views; IT support has logins and the audit trail only", () => {
    expect(names(hr)).not.toContain("payslips");
    expect(names(hr)).not.toContain("loans");
    expect(names(hr)).toContain("employees");
    expect(names(itSupport).sort()).toEqual(["audit_log", "holidays", "leave_types", "me", "posts", "sections", "users"]);
  });

  it("a pensioner has the pension views", () => {
    const list = names(pensioner);
    for (const v of ["pensioners", "pension_slips", "pension_slip_lines", "life_certificates"]) expect(list).toContain(v);
    expect(list).not.toContain("employees");
    expect(list).not.toContain("payslips");
  });

  it("no view exposes a column that identifies a person or an account", () => {
    const columns = ASK_VIEWS.flatMap((v) => v.columns.map((c) => c.name));
    const risky = /aadhaar|(^|_)pan(_|$)|pran|(^|_)uan(_|$)|esic|gpf_number|bank_account|account_n|ifsc|password|token|otp|hash|_enc$|last4/;
    // Only ever as "is it on file".
    for (const c of columns) if (risky.test(c)) expect(c, c).toMatch(/^has_/);
    expect(columns).toContain("has_aadhaar");
  });

  it("the model is told only about the listed views", () => {
    const text = describeViews(askScope(employee));
    expect(text).toContain("payslips —");
    expect(text).not.toContain("payroll_runs");
    expect(text).not.toContain("audit_log");
    expect(text).not.toContain("pay_rates —");
  });

  it("the instructions name the person, their reach and the documents they may read", () => {
    const prompt = buildSystemPrompt({
      boardName: "Delhi Cantonment Board",
      today: "2026-11-16",
      financialYear: "2026-27",
      user: { name: "Asha Verma", loginId: "DCB10010", loginLabel: "Employee", employeeCode: "DCB10010", sectionName: "Health", language: "hi" },
      scope: askScope(employee),
      documents: [{ id: "d1", title: "Leave policy", category: "POLICY", reference: "DCB/ADM/12" }],
    });
    expect(prompt).toContain("Asha Verma");
    expect(prompt).toContain("salary and payslips: their own record only");
    expect(prompt).toContain("logins: no access");
    expect(prompt).toContain("[d1] Leave policy (DCB/ADM/12)");
    expect(prompt).toContain("uses the system in Hindi");
    expect(prompt).not.toContain("payroll_runs —");
  });
});

describe("the guard on statements written by the model", () => {
  beforeAll(async () => {
    await loadSqlParser();
  });
  const allowed = new Set(viewsFor(askScope(employee)).map((v) => v.view.name));
  const check = (sql: string) => checkSql(sql, allowed, ASK_VIEW_NAMES);
  const ok = (sql: string) => {
    const r = check(sql);
    expect(r.ok, r.ok ? "" : `${sql} → ${r.reason}`).toBe(true);
    return r as Extract<typeof r, { ok: true }>;
  };
  const refused = (sql: string, why?: RegExp) => {
    const r = check(sql);
    expect(r.ok, sql).toBe(false);
    if (why && !r.ok) expect(r.reason, sql).toMatch(why);
  };

  it("lets ordinary questions through", () => {
    ok("SELECT leave_code, balance_days FROM leave_balances WHERE employee_id = (SELECT employee_id FROM me) ORDER BY leave_code");
    ok("select month, net from payslips where run_kind = 'REGULAR' and run_status in ('PAID','CLOSED') order by month desc limit 3;");
    ok("SELECT head_name, sum(amount) AS total FROM payslip_lines WHERE month >= '2026-04' AND head_kind = 'DEDUCTION' GROUP BY head_name HAVING sum(amount) > 0 ORDER BY total DESC");
    ok("WITH last AS (SELECT max(month) AS m FROM payslips) SELECT p.net, round(p.net / 12.0, 2) FROM payslips p JOIN last ON p.month = last.m");
    ok("SELECT holiday_name, to_char(holiday_date, 'DD Mon YYYY') FROM holidays WHERE holiday_date BETWEEN CURRENT_DATE AND make_date(2026, 12, 31) AND kind = 'GAZETTED'");
    ok("SELECT d::date AS day FROM generate_series(date_trunc('month', CURRENT_DATE), CURRENT_DATE, interval '1 day') AS g(d) WHERE extract(dow from d) NOT IN (0, 6)");
    ok("SELECT e.name, count(*) FILTER (WHERE a.status = 'LATE') AS late FROM ask.employees e LEFT JOIN attendance_days a ON a.employee_id = e.employee_id GROUP BY e.name");
    ok("SELECT name, age(CURRENT_DATE, date_of_birth) FROM employees WHERE name ILIKE '%arun%' AND coalesce(status, '') <> 'DRAFT'");
    ok("SELECT month, net, lag(net) OVER (ORDER BY month) AS before, rank() OVER w FROM payslips WINDOW w AS (ORDER BY net DESC)");
    ok("SELECT leave_code FROM leave_types UNION SELECT leave_code FROM leave_balances");
    ok("SELECT CASE WHEN net > 50000 THEN 'high' ELSE 'low' END, (gross - deductions)::numeric(12,2) FROM payslips WHERE NOT (net IS NULL)");
  });

  it("reports the views a statement reads", () => {
    expect(ok("SELECT 1 FROM payslips p JOIN employees e ON e.employee_id = p.employee_id").views).toEqual(["employees", "payslips"]);
    expect(ok("WITH x AS (SELECT * FROM holidays) SELECT * FROM x").views).toEqual(["holidays"]);
  });

  it("refuses a view that is not listed for the person, and says they have no access", () => {
    refused("SELECT * FROM payroll_runs", /not available to this user/);
    refused("SELECT * FROM ask.audit_log", /not available to this user/);
    refused("SELECT count(*) FROM users", /not available to this user/);
    refused("SELECT * FROM pay_rates WHERE rate_key = 'DA_PERCENT'", /not available to this user/);
  });

  it("refuses the tables behind the views, the pass and the catalogue", () => {
    refused('SELECT * FROM "Employee"', /no view/i);
    refused('SELECT * FROM public."Payslip"', /not available/);
    refused('SELECT "aadhaarEnc" FROM public."Employee"');
    refused("SELECT * FROM ask.ctx");
    refused("SELECT * FROM ctx");
    refused("SELECT * FROM emp");
    refused('SELECT token FROM "AskGrant"');
    refused("SELECT * FROM pg_catalog.pg_class");
    refused("SELECT * FROM pg_roles");
    refused("SELECT * FROM pg_stat_activity");
    refused("SELECT * FROM information_schema.tables");
    refused("SELECT * FROM pg_settings");
    refused("SELECT * FROM otherdb.ask.employees");
  });

  it("refuses anything but one SELECT", () => {
    refused("UPDATE employees SET name = 'x'", /Only SELECT/);
    refused("DELETE FROM payslips", /Only SELECT/);
    refused("INSERT INTO holidays VALUES (1)", /Only SELECT/);
    refused('DROP TABLE "Employee"', /Only SELECT/);
    refused("SELECT 1; SELECT 2", /exactly one/);
    refused("SELECT 1; DROP SCHEMA ask CASCADE", /exactly one/);
    refused("SET ROLE hrms", /Only SELECT/);
    refused("RESET ROLE", /Only SELECT/);
    refused("SET ask.token = 'x'", /Only SELECT/);
    refused("COPY employees TO '/tmp/x'", /Only SELECT/);
    refused("COPY (SELECT 1) TO PROGRAM 'id'", /Only SELECT/);
    refused("DO $$ BEGIN PERFORM 1; END $$", /Only SELECT/);
    refused("CALL something()", /Only SELECT/);
    refused("EXPLAIN SELECT 1", /Only SELECT/);
    refused("CREATE TABLE x AS SELECT * FROM employees", /Only SELECT/);
    refused("SELECT * INTO copy FROM employees", /INTO/);
    refused("SELECT * FROM employees FOR UPDATE", /FOR UPDATE/);
    refused("WITH d AS (DELETE FROM employees RETURNING *) SELECT * FROM d");
    refused("WITH u AS (UPDATE employees SET name = 'x' RETURNING *) SELECT 1");
    refused("WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t) SELECT * FROM t", /RECURSIVE/);
    refused("", /empty/);
    refused("not sql at all", /could not read/);
    refused(`SELECT '${"x".repeat(MAX_SQL_LENGTH)}'`, /too long/);
  });

  it("refuses functions that reach outside the views", () => {
    refused("SELECT set_config('ask.token', 'abc', true)", /set_config/);
    refused("SELECT set_config('role', 'hrms', true)", /set_config/);
    refused("SELECT current_setting('ask.token')", /current_setting/);
    refused("SELECT pg_catalog.set_config('ask.token', 'abc', true)", /set_config/);
    refused("SELECT * FROM employees WHERE set_config('ask.token', employee_id, true) IS NOT NULL");
    refused("SELECT pg_read_file('/etc/passwd')");
    refused("SELECT pg_ls_dir('.')");
    refused("SELECT pg_sleep(60)");
    refused("SELECT lo_import('/etc/passwd')");
    refused("SELECT dblink('host=x', 'select 1')");
    refused("SELECT query_to_xml('select * from \"Employee\"', true, true, '')");
    refused("SELECT * FROM query_to_xml('select 1', true, true, '') q");
    refused("SELECT version()");
    refused("SELECT current_database()");
    refused("SELECT pg_backend_pid()");
    refused("SELECT has_table_privilege('Employee', 'select')");
    refused("SELECT nextval('x')");
    refused("SELECT ask.can('all', true, true)");
    refused("SELECT public.something(1)");
    refused("SELECT txid_current()");
    refused("SELECT pg_advisory_lock(1)");
    refused("SELECT pg_terminate_backend(1)");
    refused("SELECT repeat('x', 1000000000)");
    refused("SELECT encode(sha256('x'), 'hex')");
    refused("SELECT row_to_json(e) FROM employees e");
    refused("SELECT count(*) FROM employees WHERE name ~ (SELECT string_agg(usename, '') FROM pg_user)");
  });

  it("refuses names, casts and operators that reach the catalogue or other roles", () => {
    refused("SELECT current_user", /CURRENT_DATE/);
    refused("SELECT session_user");
    refused("SELECT current_schema");
    refused("SELECT 'pg_class'::regclass");
    refused("SELECT 'Employee'::regclass::oid");
    refused("SELECT 1::oid");
    refused("SELECT '{}'::jsonb");
    refused("SELECT '<a/>'::xml");
    refused("SELECT name::public.citext FROM employees");
    refused("SELECT 1 OPERATOR(pg_catalog.+) 1");
    refused("SELECT $1");
    refused("SELECT name COLLATE \"C\" FROM employees");
    refused("SELECT * FROM employees TABLESAMPLE SYSTEM (10)");
    refused("SELECT xmlelement(name a)");
    refused("SELECT * FROM json_to_recordset('[]') AS x(a int)");
    refused("SELECT * FROM generate_series(1, 3) AS g, LATERAL (SELECT * FROM pg_class) c");
  });

  it("refuses a WITH name that hides a view or the catalogue", () => {
    refused("WITH payroll_runs AS (SELECT 1) SELECT * FROM payroll_runs", /another WITH name/);
    refused("WITH pg_class AS (SELECT 1) SELECT * FROM pg_class", /another WITH name/);
    refused("WITH ctx AS (SELECT 1) SELECT * FROM ctx", /another WITH name/);
    // A WITH name defined inside one sub-query does not open the same name elsewhere.
    refused("SELECT * FROM (WITH pg_roles AS (SELECT 1 AS x) SELECT * FROM pg_roles) a, pg_roles b");
  });

  it("checks sub-queries, set operations and every corner of the statement", () => {
    refused("SELECT * FROM employees WHERE employee_id IN (SELECT id FROM \"User\")");
    refused("SELECT (SELECT count(*) FROM users)");
    refused("SELECT 1 UNION ALL SELECT count(*) FROM audit_log");
    refused("SELECT name FROM employees ORDER BY (SELECT max(net) FROM payroll_runs)");
    refused("SELECT name FROM employees LIMIT (SELECT count(*) FROM users)");
    refused("SELECT CASE WHEN EXISTS (SELECT 1 FROM pay_items) THEN 1 END");
    refused("SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM vacancies)) FROM employees");
    refused("SELECT sum(net) OVER (PARTITION BY (SELECT 1 FROM users)) FROM payslips");
    refused("SELECT * FROM employees e JOIN applicants a ON true");
    refused("VALUES ((SELECT count(*) FROM users))");
    refused("TABLE users");
  });

  it("is not fooled by comments, quoting or case", () => {
    refused("SELECT 1 /* harmless */; DELETE FROM employees");
    refused("SELECT * FROM PAYROLL_RUNS");
    refused('SELECT * FROM "payroll_runs"');
    refused("SELECT * FROM ask . audit_log");
    refused("SELECT * FROM employees -- \n ; DROP TABLE x");
    refused("SELECT SET_CONFIG('ask.token', 'x', true)");
    refused('SELECT "set_config"(\'ask.token\', \'x\', true)');
    refused("SELECT * FROM U&\"\\0070g_class\"");
    ok("SELECT '; DROP TABLE x; --' AS harmless_text FROM me");
    ok("SELECT 'select * from users' AS words FROM me /* a comment */");
  });
});

describe("finding passages in the Board's documents", () => {
  const docs = [
    { id: "leave", title: "Leave policy 2026", category: "POLICY", reference: "DCB/ADM/2026/14", body: "Casual leave: eight days in a calendar year. Not more than five days of casual leave may be taken at a time.\n\nEarned leave is credited twice a year, fifteen days on 1 January and 1 July." },
    { id: "time", title: "Office timings", category: "ORDER", reference: null, body: "The office opens at 9:00 a.m. and closes at 5:30 p.m. Lunch is from 1:00 to 1:30 p.m.\n\nStaff reaching after 9:15 a.m. are marked late." },
    { id: "hi", title: "वर्दी भत्ता", category: "CIRCULAR", reference: null, body: "सफाई कर्मचारियों को हर वर्ष वर्दी भत्ता दिया जाएगा। भत्ता अप्रैल के वेतन के साथ मिलेगा।" },
  ];

  it("finds the passage that answers the question, the best first", () => {
    const found = findPassages("How many days of casual leave can I take at a time?", docs);
    expect(found[0]?.docId).toBe("leave");
    expect(found[0]?.text).toContain("five days");
    expect(findPassages("when does the office open", docs)[0]?.docId).toBe("time");
  });

  it("matches Hindi words whole, matras included", () => {
    expect(findPassages("वर्दी भत्ता कब मिलेगा", docs)[0]?.docId).toBe("hi");
    expect(words("वर्दी भत्ता")).toEqual(["वर्दी", "भत्ता"]);
  });

  it("returns nothing when no word matches — the model then says the documents do not cover it", () => {
    expect(findPassages("parking for visitors", docs)).toEqual([]);
    expect(findPassages("the of and", docs)).toEqual([]);
  });

  it("cuts a long document into parts and keeps every word", () => {
    const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ${"Rule text here. ".repeat(12)}`).join("\n\n");
    const parts = partsOf(body);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.join("\n\n").replace(/\s+/g, " ")).toBe(body.replace(/\s+/g, " ").trim());
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(2000);
  });
});

describe("who may use Ask, read which documents and write them", () => {
  it("the Board's switch: off, office staff, or everyone", () => {
    for (const p of [employee, pensioner, hr, approver]) expect(canUseAsk(p, "off")).toBe(false);
    expect(canUseAsk(employee, "staff")).toBe(false);
    expect(canUseAsk(pensioner, "staff")).toBe(false);
    expect(canUseAsk(hr, "staff")).toBe(true);
    expect(canUseAsk(itSupport, "staff")).toBe(true);
    for (const p of [employee, pensioner, hr, approver]) expect(canUseAsk(p, "everyone")).toBe(true);
  });

  it("documents are read by audience", () => {
    expect(knowledgeAudiences(employee)).toEqual(["EVERYONE"]);
    expect(knowledgeAudiences(pensioner)).toEqual(["EVERYONE"]);
    expect(knowledgeAudiences(hr)).toEqual(["EVERYONE", "STAFF"]);
    expect(knowledgeAudiences(itSupport)).toEqual(["EVERYONE", "STAFF"]);
    expect(knowledgeAudiences(approver)).toEqual(["EVERYONE", "STAFF", "ADMIN"]);
  });

  it("documents are written by the Admin — and by the HR manager in the simple way", () => {
    expect(canManageKnowledge(approver)).toBe(true);
    expect(canManageKnowledge(hr)).toBe(false);
    expect(canManageKnowledge({ ...hr, simple: true })).toBe(true);
    expect(canManageKnowledge({ ...payroll, simple: true })).toBe(false);
    expect(canManageKnowledge(itSupport)).toBe(false);
    expect(canManageKnowledge({ ...itSupport, simple: true })).toBe(false);
    expect(canManageKnowledge(employee)).toBe(false);
  });
});
