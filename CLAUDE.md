@AGENTS.md

# DCB HRMS & Payroll — working notes

- **Source of truth:** the Release 1 PRD. Build order and PRD IDs: `PLAN.md`. What is done / pending / decided: `PROGRESS.md`.
  Read both before starting work and update both when a module or feature lands.
- **Stack:** Next.js 16 (App Router, `src/proxy.ts` instead of middleware), TypeScript strict, Tailwind v4, Prisma 7 + PostgreSQL 16.
- **Layers:** `src/modules/<module>/service.ts` holds business rules and permission checks; `src/app/api/v1/**` are thin REST wrappers
  (`apiRoute`); pages read through the same services. Every write: audit (`lib/audit.ts`) + outbox (`lib/outbox.ts`) in the same transaction;
  maker-checker through `lib/approvals`.
- **Permissions:** `lib/auth/access.ts` is PRD §14 as data — never hard-code role checks in pages. Menus: `lib/auth/menu.ts` (≤ 8 items;
  the Admin's tools collapse into `/admin` — `adminTools()` — when they do not fit).
- **Two ways of working** (Settings → How work is approved; `modules/settings/workflow.ts`, on the actor as `actor.simple`):
  **Simple** (default) — the Admin sees and manages everything, the HR manager decides everything about people, the
  Accounts manager works out and pays salaries; what staff enter counts at once (`approveDirectly` in the approvals
  engine, run by `apiRoute` after each request; `lib/approvals/areas.ts` says whose desk each kind is). **Two steps** —
  the PRD's maker-checker and OTP, untouched. Rights for both live in `access.ts` (`ownFns`, `holds`, `canManageUsers`);
  roles are names for permission sets (`lib/auth/roles.ts`). Simple payroll is `payroll/simple.ts` (work out → review →
  pay → finish) with its own panel on the shared run screen. Wording that differs is in `lib/i18n/simple.ts`
  (overrides) and `easy.en.ts` / `easy.hi.ts` (new screens). Tests build actors without `simple`, i.e. two-step,
  unless they set it; the browser checks run two-step first and `e2e/simple.simple.spec.ts` last.
- **Text:** every visible string lives in `lib/i18n/en.ts` and `hi.ts` (same keys — a unit test enforces it). Simple words.
- **Money:** `lib/money.ts` (paise maths, rupee rounding). **Dates:** `lib/dates.ts` (ISO strings, India time).
- **Checks before commit:** `npm run typecheck && npm run lint && npm test && npm run build`; browser checks: `npm run test:e2e` (after a build — it rebuilds and seeds `E2E_DATABASE_URL` and starts its own server on :3100).
- **Phone layout:** wide tables use `<Table stack>` with `<Td label>` so they become cards; `e2e/layout.phone.spec.ts` fails if a page scrolls sideways.
- **Browser checks sign in once per login** (`e2e/helpers.ts` saves the session; `fresh: true` forces the real screen) because the app allows 5 OTPs per login in 10 minutes.
- **Attendance:** rules are pure (`modules/attendance/rules.ts`) and shared by service, screens, seed and tests; punches are stored raw and a day's status is worked out when shown — only decisions are saved.
- **Payroll:** the pay engine is pure (`modules/payroll/engine.ts`); `compute.ts` reads the records and saves a run (no "server-only", the seed uses it);
  `run.ts` is the five stages, `pay.ts` the bank / return files and close, `outputs.ts` the PDFs. A month uses the rates and matrix in force on the 1st.
- **Statutory & tax:** pure rules in `modules/statutory/` (`tax-rules.ts`, `gpf-rules.ts`, `formats.ts`, `calendar.ts`); TDS is projected
  inside `computeRun` (`tds-projection.ts`, no "server-only") — never a pay item; `gpf-posting.ts` posts GPF from approved bills;
  `stat-build.ts` builds the monthly files (seed-safe). Worked-out deductions (LOAN, GPF_REFUND, IT, PT) pass to the engine in `items`.
- **Leaving service (client add-on):** `employees/separation.ts` records suspensions and exits (Checker → Admin) and
  moves people off the rolls after the last day (`applyExits`, daily); the full and final settlement is
  `payroll/settlement.ts` (statement, approvals, receipts) on pure rules in `settlement-rules.ts`; the settlement bill
  is a SUPPLEMENTARY run with source `SETTLEMENT` built and closed by `settlement-bill.ts` (hooked into `run.ts`).
- **Pension:** pure rules in `modules/pension/rules.ts` (a month's pension, restoration, additional pension, life
  certificate dates) and `calculator.ts` (the case); `compute.ts` works out the pension bill (pay group PENSION, called
  from `computeRun`, seed-safe) with catch-up of unpaid months and the system hold; `case-facts.ts` reads a case's facts
  (seed-safe); `bills.ts` arrears and benefits bills; `cases.ts`, `events.ts` (retirements, deaths), `pensioners.ts`,
  `life-certificates.ts`, `tables.ts`, `ppo.ts`. Pension bills reuse the payroll run screen (`payroll/[id]/run-screen.tsx`)
  under `/pension/bills`; rights follow `fnOf(payGroup)`. Every pension slip carries `pensionerId`; salary-side readers
  filter `pensionerId: null`.
- **Ask AI (client add-on):** `modules/ask/` — a person asks in plain words; a language model writes SELECTs; the system decides
  what they may read. `scope.ts` (pure) turns the §14 matrix into a reach per area; `catalog.ts` (pure) lists the views
  of the `ask` schema and for whom — it is both the guard's allowlist and the model's description; `sql-guard.ts`
  checks every statement with PostgreSQL's own parser (allowlists: add a function or node type there, never loosen the
  walk); `runner.ts` writes a 30-second pass (`AskGrant`) and runs the statement through `ask.run()` as the role
  `dcb_ask`; `knowledge.ts` / `passages.ts` are the Board's documents; `service.ts` is the question loop and the
  audit entry. The AI service is the Board's choice (Settings → Ask): `model.ts` (pure) is the neutral conversation
  format; `model-gemini.ts` (the default), `model-openai.ts` (Responses API) and `model-claude.ts` are the adapters on
  the official SDKs — each hands the service's own turn back unchanged (`raw`), which its reasoning needs;
  `model-scripted.ts` is a stand-in for tests and practice copies; `config.ts` holds the choice and the API keys
  (encrypted, in the settings row `askKeys` that the settings API cannot read; the environment is the fallback).
  **The views are the access control**: a new table reaches Ask only through a view that filters by the pass — add it
  in a new migration that carries the whole `ask_views` file (it drops and rebuilds the schema), list it in
  `catalog.ts`, and add its reach to `tests/integration/ask.test.ts`. Never put an identity or account number in a
  view. A migration that drops a column a view reads must drop the `ask` schema first and rebuild it after.
