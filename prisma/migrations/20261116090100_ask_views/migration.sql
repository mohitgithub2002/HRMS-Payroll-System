-- Ask AI: what a question may read.
--
-- The SQL a language model writes runs as the role "dcb_ask", which can read nothing but the views below. Each view
-- shows only the rows the person asking may see: the application writes a short-lived pass ("AskGrant") saying how far
-- each area reaches for that person (the whole Board, their section, their own record or nothing — PRD §14, worked out
-- in modules/ask/scope.ts) and sets the pass's random token on the connection. No token, a wrong token or an expired
-- pass: every view is empty. Numbers that identify a person or an account (Aadhaar, PAN, bank account, PRAN, UAN, ESIC,
-- GPF) are not in any view.
--
-- The statement is run by ask.run(), a function that executes as dcb_ask: inside it PostgreSQL refuses any change of
-- role, so a statement cannot climb back to the application's own login even on the same connection.
--
-- To change a view: add a new migration with this whole file (it drops and rebuilds the schema) and keep
-- modules/ask/catalog.ts in step — tests/integration/ask.test.ts compares the two. A migration that drops or renames a
-- column read here must drop the schema first ("DROP SCHEMA IF EXISTS ask CASCADE") and rebuild it afterwards.

DROP SCHEMA IF EXISTS ask CASCADE;
CREATE SCHEMA ask;

-- ─── The role ───────────────────────────────────────────────────────────────────────────────────────────────────
-- Roles belong to the whole database server, so the role may be there already (test and training copies).
-- A database user that may not create roles: ask the database administrator to run scripts/ask-role.sql once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dcb_ask') THEN
    CREATE ROLE dcb_ask NOLOGIN NOINHERIT;
  END IF;
EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
  RAISE NOTICE 'Ask AI: the role dcb_ask could not be created here — run scripts/ask-role.sql as a database administrator.';
END $$;

-- The application signs in as the owner of the tables and steps down to dcb_ask for each question.
DO $$
BEGIN
  -- PostgreSQL 16: whoever creates a role may manage it but not act as it until that is granted.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dcb_ask')
     AND NOT pg_has_role(current_user, 'dcb_ask', CASE WHEN current_setting('server_version_num')::int >= 160000 THEN 'SET' ELSE 'MEMBER' END) THEN
    IF current_setting('server_version_num')::int >= 160000 THEN
      EXECUTE format('GRANT dcb_ask TO %I WITH SET TRUE, INHERIT FALSE', current_user);
    ELSE
      EXECUTE format('GRANT dcb_ask TO %I', current_user);
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Ask AI: could not let % act as dcb_ask (%) — run scripts/ask-role.sql as a database administrator.', current_user, SQLERRM;
END $$;

-- ─── Helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

/* Stored times are UTC; people read India time. */
CREATE FUNCTION ask.ist(t timestamp) RETURNS timestamp
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN (t AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata';

/* May a row about one employee be seen with this reach? */
CREATE FUNCTION ask.can(reach text, is_me boolean, in_my_section boolean) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN reach = 'all' OR (reach = 'section' AND in_my_section) OR (reach IN ('section', 'own') AND is_me);

/* The pass of this connection: one row, or none. Not readable by dcb_ask. */
CREATE VIEW ask.ctx AS
SELECT g."boardId" AS board_id,
       g."userId" AS user_id,
       g."employeeId" AS my_employee_id,
       g."sectionId" AS my_section_id,
       g."pensionerId" AS my_pensioner_id,
       COALESCE(g.scopes ->> 'people', 'none') AS r_people,
       COALESCE(g.scopes ->> 'service', 'none') AS r_service,
       COALESCE(g.scopes ->> 'attendance', 'none') AS r_attendance,
       COALESCE(g.scopes ->> 'leave', 'none') AS r_leave,
       COALESCE(g.scopes ->> 'payroll', 'none') AS r_payroll,
       COALESCE(g.scopes ->> 'loans', 'none') AS r_loans,
       COALESCE(g.scopes ->> 'statutory', 'none') AS r_statutory,
       COALESCE(g.scopes ->> 'pension', 'none') AS r_pension,
       COALESCE(g.scopes ->> 'rates', 'none') AS r_rates,
       COALESCE(g.scopes ->> 'recruitment', 'none') AS r_recruitment,
       COALESCE(g.scopes ->> 'users', 'none') AS r_users,
       COALESCE(g.scopes ->> 'audit', 'none') AS r_audit,
       g.sensitive
FROM public."AskGrant" g
WHERE g.token = current_setting('ask.token', true)
  AND g."expiresAt" > now();

/* Every employee of the Board of the pass, with the pass alongside. Not readable by dcb_ask. */
CREATE VIEW ask.emp AS
SELECT e.id,
       e."employeeCode" AS code,
       concat_ws(' ', e."firstName", e."middleName", e."lastName") AS name,
       e."nameHi" AS name_hi,
       e.type::text AS employee_type,
       e.status::text AS status,
       s.id AS section_id,
       s.code AS section_code,
       s.name AS section_name,
       p.code AS post_code,
       p.name AS post_name,
       (c.my_employee_id IS NOT NULL AND e.id = c.my_employee_id) AS is_me,
       (c.my_section_id IS NOT NULL AND e."sectionId" = c.my_section_id) AS in_my_section,
       c.*
FROM public."Employee" e
JOIN public."Section" s ON s.id = e."sectionId"
JOIN public."Post" p ON p.id = e."postId"
JOIN ask.ctx c ON c.board_id = e."boardId";

-- ─── Who is asking ──────────────────────────────────────────────────────────────────────────────────────────────

CREATE VIEW ask.me WITH (security_barrier = true) AS
SELECT u."loginId" AS login_id,
       u."displayName" AS name,
       u."loginType"::text AS login_type,
       c.my_employee_id AS employee_id,
       e."employeeCode" AS employee_code,
       s.code AS section_code,
       s.name AS section_name,
       c.my_pensioner_id AS pensioner_id
FROM ask.ctx c
JOIN public."User" u ON u.id = c.user_id
LEFT JOIN public."Employee" e ON e.id = c.my_employee_id
LEFT JOIN public."Section" s ON s.id = e."sectionId";

-- ─── The Board: sections, posts, holidays ───────────────────────────────────────────────────────────────────────

CREATE VIEW ask.sections WITH (security_barrier = true) AS
SELECT s.code AS section_code, s.name AS section_name, s."nameHi" AS section_name_hi, s."isActive" AS is_active,
       s."attendanceMode"::text AS attendance_mode
FROM public."Section" s JOIN ask.ctx c ON c.board_id = s."boardId";

CREATE VIEW ask.posts WITH (security_barrier = true) AS
SELECT p.code AS post_code, p.name AS post_name, p."nameHi" AS post_name_hi, p."payLevel" AS pay_level,
       p."group" AS post_group, p."retirementAge" AS retirement_age, p."isActive" AS is_active
FROM public."Post" p JOIN ask.ctx c ON c.board_id = p."boardId";

CREATE VIEW ask.holidays WITH (security_barrier = true) AS
SELECT h.date AS holiday_date, h.name AS holiday_name, h."nameHi" AS holiday_name_hi, h.kind::text AS kind
FROM public."Holiday" h JOIN ask.ctx c ON c.board_id = h."boardId";

-- ─── People ─────────────────────────────────────────────────────────────────────────────────────────────────────

/* A section head sees the staff list of the section (name, post, type, mobile); the rest of a record is for those who
   see the whole Board, and for the person themself. Pay level and pay need `sensitive` as well. */
CREATE VIEW ask.employees WITH (security_barrier = true) AS
SELECT e.id AS employee_id,
       e.code AS employee_code,
       e.name,
       e.name_hi,
       e.employee_type,
       e.status,
       e.section_code,
       e.section_name,
       e.post_code,
       e.post_name,
       x.mobile,
       CASE WHEN f.whole THEN x.email END AS email,
       CASE WHEN f.whole THEN x.gender END AS gender,
       CASE WHEN f.whole THEN x."dateOfBirth" END AS date_of_birth,
       CASE WHEN f.whole THEN x."dateOfJoining" END AS date_of_joining,
       CASE WHEN f.whole THEN x."dateOfRetirement" END AS date_of_retirement,
       CASE WHEN f.whole THEN x."exitDate" END AS exit_date,
       CASE WHEN f.whole THEN x."exitReason" END AS exit_reason,
       CASE WHEN f.whole THEN x."fatherOrSpouseName" END AS father_or_spouse_name,
       CASE WHEN f.whole THEN x.category END AS category,
       CASE WHEN f.whole THEN x."maritalStatus" END AS marital_status,
       CASE WHEN f.whole THEN x."bloodGroup" END AS blood_group,
       CASE WHEN f.whole THEN x."isDisabled" END AS is_disabled,
       CASE WHEN f.whole THEN x."presentAddress" ->> 'city' END AS city,
       CASE WHEN f.whole THEN x."presentAddress" ->> 'district' END AS district,
       CASE WHEN f.whole THEN x."presentAddress" ->> 'state' END AS state,
       CASE WHEN f.whole THEN x."probationEndDate" END AS probation_end_date,
       CASE WHEN f.whole THEN x."confirmationDate" END AS confirmation_date,
       CASE WHEN f.whole THEN x."agencyName" END AS agency_name,
       CASE WHEN f.whole THEN x."contractStart" END AS contract_start,
       CASE WHEN f.whole THEN x."contractEnd" END AS contract_end,
       CASE WHEN f.pay THEN x."payLevel" END AS pay_level,
       CASE WHEN f.pay THEN x."payCell" END AS pay_cell,
       CASE WHEN f.pay THEN (
         SELECT (m.levels -> x."payLevel" ->> (x."payCell" - 1))::numeric
         FROM public."PayMatrix" m
         WHERE m."boardId" = e.board_id AND m."effectiveFrom" <= CURRENT_DATE
         ORDER BY m."effectiveFrom" DESC
         LIMIT 1
       ) END AS basic_pay,
       CASE WHEN f.pay THEN x."incrementMonth" END AS increment_month,
       CASE WHEN f.pay THEN x."wageRate" END AS wage_rate,
       CASE WHEN f.pay THEN x."wageBasis" END AS wage_basis,
       CASE WHEN f.pay THEN x."bankName" END AS bank_name,
       CASE WHEN f.pay THEN x."bankAccountEnc" IS NOT NULL END AS has_bank_account,
       CASE WHEN f.pay THEN x."panEnc" IS NOT NULL END AS has_pan,
       CASE WHEN f.pay THEN x."aadhaarEnc" IS NOT NULL END AS has_aadhaar,
       CASE WHEN f.pay THEN x.pran IS NOT NULL END AS has_pran,
       CASE WHEN f.pay THEN x.uan IS NOT NULL END AS has_uan
FROM ask.emp e
JOIN public."Employee" x ON x.id = e.id
CROSS JOIN LATERAL (SELECT (e.r_people = 'all' OR e.is_me) AS whole, ((e.r_people = 'all' OR e.is_me) AND e.sensitive) AS pay) f
WHERE ask.can(e.r_people, e.is_me, e.in_my_section);

CREATE VIEW ask.family_members WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       m.name AS member_name, m.relation, m.gender, m."dateOfBirth" AS date_of_birth,
       m."isDependent" AS is_dependent, m."isDisabled" AS is_disabled, m."isAlive" AS is_alive
FROM public."FamilyMember" m JOIN ask.emp e ON e.id = m."employeeId"
WHERE e.r_people = 'all' OR (e.r_people <> 'none' AND e.is_me);

CREATE VIEW ask.nominees WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       n.scheme::text AS scheme, m.name AS nominee_name, m.relation, n."sharePercent" AS share_percent
FROM public."Nominee" n
JOIN public."FamilyMember" m ON m.id = n."familyMemberId"
JOIN ask.emp e ON e.id = n."employeeId"
WHERE e.r_people = 'all' OR (e.r_people <> 'none' AND e.is_me);

CREATE VIEW ask.employee_documents WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       d.category, d.title, ask.ist(d."createdAt")::date AS uploaded_on
FROM public."EmployeeDocument" d JOIN ask.emp e ON e.id = d."employeeId"
WHERE d."deletedAt" IS NULL AND (e.r_people = 'all' OR (e.r_people <> 'none' AND e.is_me));

/* The person themself sees approved entries only. */
CREATE VIEW ask.service_book WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name, e.section_name,
       b.event::text AS event, b."eventDate" AS event_date, b."orderNumber" AS order_number, b."orderDate" AS order_date,
       b.details, b.status::text AS status
FROM public."ServiceBookEntry" b JOIN ask.emp e ON e.id = b."employeeId"
WHERE e.r_service = 'all' OR (e.r_service = 'own' AND e.is_me AND b.status = 'APPROVED');

CREATE VIEW ask.pay_history WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       h."effectiveFrom" AS effective_from, h."payLevel" AS pay_level, h."payCell" AS pay_cell, h.reason::text AS reason,
       (SELECT (m.levels -> h."payLevel" ->> (h."payCell" - 1))::numeric
        FROM public."PayMatrix" m
        WHERE m."boardId" = e.board_id AND m."effectiveFrom" <= GREATEST(h."effectiveFrom", (SELECT min(m2."effectiveFrom") FROM public."PayMatrix" m2 WHERE m2."boardId" = e.board_id))
        ORDER BY m."effectiveFrom" DESC
        LIMIT 1) AS basic_pay
FROM public."PayHistory" h JOIN ask.emp e ON e.id = h."employeeId"
WHERE e.sensitive AND (e.r_payroll = 'all' OR e.r_service = 'all' OR ((e.r_payroll = 'own' OR e.r_service = 'own') AND e.is_me));

CREATE VIEW ask.separations WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name, e.section_name,
       s.kind::text AS kind, s.status::text AS status, s."effectiveDate" AS effective_date,
       s."orderNumber" AS order_number, s."orderDate" AS order_date, s.reason, s."endDate" AS end_date,
       s."settlementStatus"::text AS settlement_status, ask.ist(s."settledAt")::date AS settled_on
FROM public."Separation" s JOIN ask.emp e ON e.id = s."employeeId"
WHERE e.r_people = 'all';

CREATE VIEW ask.sanctioned_posts WITH (security_barrier = true) AS
SELECT s.code AS section_code, s.name AS section_name, p.code AS post_code, p.name AS post_name,
       sp.sanctioned,
       f.filled,
       sp.sanctioned - f.filled AS vacant
FROM public."SanctionedPost" sp
JOIN ask.ctx c ON c.board_id = sp."boardId"
JOIN public."Section" s ON s.id = sp."sectionId"
JOIN public."Post" p ON p.id = sp."postId"
CROSS JOIN LATERAL (
  SELECT count(*)::int AS filled
  FROM public."Employee" e
  WHERE e."boardId" = sp."boardId" AND e."sectionId" = sp."sectionId" AND e."postId" = sp."postId"
    AND e.status IN ('ACTIVE', 'SUSPENDED') AND e.type IN ('PERMANENT_OPS', 'PERMANENT_NPS', 'DEPUTATION')
) f
WHERE c.r_people = 'all';

-- ─── Hiring ─────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE VIEW ask.vacancies WITH (security_barrier = true) AS
SELECT v."referenceNo" AS reference_no, s.code AS section_code, s.name AS section_name, p.code AS post_code, p.name AS post_name,
       v."payLevel" AS pay_level, v.seats,
       COALESCE((v.reservation ->> 'GEN')::int, 0) AS seats_gen,
       COALESCE((v.reservation ->> 'OBC')::int, 0) AS seats_obc,
       COALESCE((v.reservation ->> 'SC')::int, 0) AS seats_sc,
       COALESCE((v.reservation ->> 'ST')::int, 0) AS seats_st,
       COALESCE((v.reservation ->> 'EWS')::int, 0) AS seats_ews,
       v."advertNumber" AS advert_number, v."advertDate" AS advert_date, v."lastDate" AS last_date,
       v.status::text AS status, v."selectionStatus"::text AS selection_status,
       (SELECT count(*)::int FROM public."Applicant" a WHERE a."vacancyId" = v.id) AS applicants
FROM public."Vacancy" v
JOIN ask.ctx c ON c.board_id = v."boardId"
JOIN public."Section" s ON s.id = v."sectionId"
JOIN public."Post" p ON p.id = v."postId"
WHERE c.r_recruitment = 'all';

CREATE VIEW ask.applicants WITH (security_barrier = true) AS
SELECT v."referenceNo" AS vacancy_reference_no, a."applicationNo" AS application_no, a.name, a.gender,
       a."dateOfBirth" AS date_of_birth, a.category, a.qualification, a.score, a."meritRank" AS merit_rank,
       a.status::text AS status, a."appointmentLetterNo" AS appointment_letter_no, a."appointmentLetterDate" AS appointment_letter_date
FROM public."Applicant" a
JOIN public."Vacancy" v ON v.id = a."vacancyId"
JOIN ask.ctx c ON c.board_id = v."boardId"
WHERE c.r_recruitment = 'all';

CREATE VIEW ask.joinings WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name, e.section_name, e.post_name,
       v."referenceNo" AS vacancy_reference_no, j.status::text AS status,
       ask.ist(j."createdAt")::date AS started_on, ask.ist(j."completedAt")::date AS completed_on
FROM public."Joining" j
JOIN ask.emp e ON e.id = j."employeeId"
LEFT JOIN public."Vacancy" v ON v.id = j."vacancyId"
WHERE e.r_recruitment = 'all';

-- ─── Attendance ─────────────────────────────────────────────────────────────────────────────────────────────────

CREATE VIEW ask.attendance_monthly WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name, e.section_name,
       m.month, m."daysInMonth" AS days_in_month, m."daysOnRoll" AS days_on_roll, m.present, m.late AS late_days,
       m."halfDays" AS half_days, m."onDuty" AS on_duty_days, m.leave AS leave_days, m.holidays, m."weeklyOffs" AS weekly_offs,
       m."diesNon" AS dies_non_days, m."halfPayLeave" AS half_pay_leave_days, m."noPayLeave" AS no_pay_leave_days,
       m."payableDays" AS payable_days, m."workedDays" AS worked_days
FROM public."AttendanceMonth" m JOIN ask.emp e ON e.id = m."employeeId"
WHERE ask.can(e.r_attendance, e.is_me, e.in_my_section);

CREATE VIEW ask.attendance_days WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name, e.section_name,
       d.date AS day, d.status::text AS status, ask.ist(d."firstIn")::time(0) AS first_in, ask.ist(d."lastOut")::time(0) AS last_out,
       d."workedMinutes" AS worked_minutes, d.source::text AS source, d."leaveCode" AS leave_code, d.half AS half_day, d.note
FROM public."AttendanceDay" d JOIN ask.emp e ON e.id = d."employeeId"
WHERE ask.can(e.r_attendance, e.is_me, e.in_my_section);

CREATE VIEW ask.attendance_punches WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name, e.section_name,
       ask.ist(p.at)::date AS punch_date, ask.ist(p.at)::time(0) AS punch_time
FROM public."AttendancePunch" p JOIN ask.emp e ON e.id = p."employeeId"
WHERE ask.can(e.r_attendance, e.is_me, e.in_my_section);

CREATE VIEW ask.attendance_requests WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name, e.section_name,
       r.date AS day, r.type::text AS request_type, r."inTime" AS in_time, r."outTime" AS out_time, r.reason,
       r.status::text AS status, ask.ist(r."createdAt")::date AS requested_on, ask.ist(r."decidedAt")::date AS decided_on
FROM public."AttendanceRequest" r JOIN ask.emp e ON e.id = r."employeeId"
WHERE ask.can(e.r_attendance, e.is_me, e.in_my_section);

CREATE VIEW ask.attendance_locks WITH (security_barrier = true) AS
SELECT s.code AS section_code, s.name AS section_name, l.month, l."lockedByName" AS locked_by,
       ask.ist(l."lockedAt")::date AS locked_on, l."unlockedAt" IS NULL AS is_locked, ask.ist(l."unlockedAt")::date AS reopened_on
FROM public."AttendanceLock" l
JOIN ask.ctx c ON c.board_id = l."boardId"
JOIN public."Section" s ON s.id = l."sectionId"
WHERE c.r_attendance = 'all' OR (c.r_attendance IN ('section', 'own') AND c.my_section_id IS NOT NULL AND l."sectionId" = c.my_section_id);

-- ─── Leave ──────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE VIEW ask.leave_types WITH (security_barrier = true) AS
SELECT t.code AS leave_code, t.name AS leave_name, t."nameHi" AS leave_name_hi, t.pay::text AS pay, t."creditMode"::text AS credit_mode,
       t."creditDays" AS credit_days, t.cap AS max_balance, t."lapsesAtYearEnd" AS lapses_at_year_end,
       t."debitFrom" AS debit_from, t."debitFactor" AS debit_factor, t."countsOffDays" AS counts_holidays_inside,
       t."halfDayAllowed" AS half_day_allowed, t."needsCertificate" AS needs_certificate, t."restrictedOnly" AS restricted_holidays_only,
       t.gender AS only_for_gender, array_to_string(t."employeeTypes"::text[], ', ') AS employee_types,
       t."officerLimitDays" AS section_head_limit_days, t."isActive" AS is_active
FROM public."LeaveType" t JOIN ask.ctx c ON c.board_id = t."boardId";

CREATE VIEW ask.leave_balances WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name, e.section_name,
       b.leave_code, b.balance_days,
       COALESCE((SELECT sum(a."debitDays") FROM public."LeaveApplication" a
                 WHERE a."employeeId" = e.id AND a."debitCode" = b.leave_code AND a.status = 'PENDING'), 0) AS pending_days
FROM ask.emp e
JOIN LATERAL (
  SELECT l."leaveCode" AS leave_code, sum(l.days) AS balance_days
  FROM public."LeaveLedger" l
  WHERE l."employeeId" = e.id
  GROUP BY l."leaveCode"
) b ON true
WHERE ask.can(e.r_leave, e.is_me, e.in_my_section);

CREATE VIEW ask.leave_ledger WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       l."leaveCode" AS leave_code, l.date AS entry_date, l.kind::text AS kind, l.days, l.period, l.note
FROM public."LeaveLedger" l JOIN ask.emp e ON e.id = l."employeeId"
WHERE ask.can(e.r_leave, e.is_me, e.in_my_section);

CREATE VIEW ask.leave_applications WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name, e.section_name,
       a."leaveCode" AS leave_code, a."fromDate" AS from_date, a."toDate" AS to_date, a."halfDay" AS half_day, a.days,
       a.reason, a.status::text AS status, a."onBehalf" AS entered_by_hr,
       ask.ist(a."createdAt")::date AS applied_on, ask.ist(a."decidedAt")::date AS decided_on, ask.ist(a."cancelledAt")::date AS cancelled_on
FROM public."LeaveApplication" a JOIN ask.emp e ON e.id = a."employeeId"
WHERE ask.can(e.r_leave, e.is_me, e.in_my_section);

-- ─── Pay ────────────────────────────────────────────────────────────────────────────────────────────────────────

/* Pension bills follow the pension reach, every other bill the payroll reach. */
CREATE VIEW ask.payroll_runs WITH (security_barrier = true) AS
SELECT r.id AS run_id, r."payGroup"::text AS pay_group, r.month, r.kind::text AS run_kind, r.seq AS bill_no, r.title,
       r.status::text AS run_status, r.employees AS people, r.gross, r.deductions, r.net, r.employer AS employer_share,
       r."runByName" AS worked_out_by, ask.ist(r."runAt")::date AS worked_out_on, r."checkedByName" AS checked_by,
       r."approvedByName" AS approved_by, ask.ist(r."approvedAt")::date AS approved_on,
       ask.ist(r."paidAt")::date AS paid_on, ask.ist(r."closedAt")::date AS closed_on
FROM public."PayrollRun" r JOIN ask.ctx c ON c.board_id = r."boardId"
WHERE c.sensitive AND ((r."payGroup" <> 'PENSION' AND c.r_payroll = 'all') OR (r."payGroup" = 'PENSION' AND c.r_pension = 'all'));

/* Salary slips. The person themself sees a slip once the bill is paid, like on "My payslips". */
CREATE VIEW ask.payslips WITH (security_barrier = true) AS
SELECT s.id AS payslip_id, s."runId" AS run_id, e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       sec.name AS section_name, s.month, s."payGroup"::text AS pay_group, r.kind::text AS run_kind, r.status::text AS run_status,
       s."payLevel" AS pay_level, s."payCell" AS pay_cell, s.status::text AS slip_status, s."withheldReason" AS withheld_reason,
       s."daysInMonth" AS days_in_month, s."daysOnRoll" AS days_on_roll, s."lossDays" AS unpaid_days, s."halfPayDays" AS half_pay_days,
       s.gross, s.deductions, s.net, s.employer AS employer_share, s."creditStatus"::text AS bank_credit_status
FROM public."Payslip" s
JOIN public."PayrollRun" r ON r.id = s."runId"
JOIN public."Section" sec ON sec.id = s."sectionId"
JOIN ask.emp e ON e.id = s."employeeId"
WHERE s."pensionerId" IS NULL AND e.sensitive
  AND (e.r_payroll = 'all' OR (e.r_payroll = 'own' AND e.is_me AND s.status = 'INCLUDED' AND r.status IN ('PAID', 'CLOSED')));

CREATE VIEW ask.payslip_lines WITH (security_barrier = true) AS
SELECT s.id AS payslip_id, e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       s.month, r.kind::text AS run_kind, r.status::text AS run_status,
       l.line ->> 'code' AS head_code, l.line ->> 'name' AS head_name, l.line ->> 'kind' AS head_kind,
       (l.line ->> 'amount')::numeric AS amount
FROM public."Payslip" s
JOIN public."PayrollRun" r ON r.id = s."runId"
JOIN ask.emp e ON e.id = s."employeeId"
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.lines) = 'array' THEN s.lines ELSE '[]'::jsonb END) AS l(line)
WHERE s."pensionerId" IS NULL AND e.sensitive
  AND (e.r_payroll = 'all' OR (e.r_payroll = 'own' AND e.is_me AND s.status = 'INCLUDED' AND r.status IN ('PAID', 'CLOSED')));

CREATE VIEW ask.payroll_checks WITH (security_barrier = true) AS
SELECT r.month, r."payGroup"::text AS pay_group, r.kind::text AS run_kind, e.code AS employee_code, e.name AS employee_name,
       x.code AS check_code, x.severity::text AS severity, x.resolution::text AS resolution, x.note, x."resolvedByName" AS resolved_by
FROM public."PayrollException" x
JOIN public."PayrollRun" r ON r.id = x."runId"
JOIN ask.ctx c ON c.board_id = r."boardId"
LEFT JOIN ask.emp e ON e.id = x."employeeId"
WHERE c.sensitive AND ((r."payGroup" <> 'PENSION' AND c.r_payroll = 'all') OR (r."payGroup" = 'PENSION' AND c.r_pension = 'all'));

CREATE VIEW ask.pay_items WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       i."headCode" AS head_code, i.amount, i."fromMonth" AS from_month, i."toMonth" AS to_month, i.note
FROM public."EmployeePayItem" i JOIN ask.emp e ON e.id = i."employeeId"
WHERE e.sensitive AND e.r_payroll = 'all';

CREATE VIEW ask.loans WITH (security_barrier = true) AS
SELECT l.id AS loan_id, e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       l.type::text AS loan_type, l.purpose, l.principal, l."interestRate" AS interest_rate_percent, l.instalments,
       l."instalmentAmount" AS instalment_amount, l."sanctionDate" AS sanction_date, l."startMonth" AS start_month,
       l.status::text AS status, l."closedMonth" AS closed_month,
       rec.principal_recovered, rec.interest_recovered, rec.instalments_recovered,
       GREATEST(l.principal - rec.principal_recovered, 0) AS principal_outstanding
FROM public."Loan" l
JOIN ask.emp e ON e.id = l."employeeId"
CROSS JOIN LATERAL (
  SELECT COALESCE(sum(r.principal), 0) AS principal_recovered, COALESCE(sum(r.interest), 0) AS interest_recovered, count(*)::int AS instalments_recovered
  FROM public."LoanRecovery" r WHERE r."loanId" = l.id
) rec
WHERE e.sensitive AND (e.r_loans = 'all' OR (e.r_loans = 'own' AND e.is_me));

CREATE VIEW ask.loan_recoveries WITH (security_barrier = true) AS
SELECT l.id AS loan_id, e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       l.type::text AS loan_type, r.month, r.principal, r.interest
FROM public."LoanRecovery" r
JOIN public."Loan" l ON l.id = r."loanId"
JOIN ask.emp e ON e.id = l."employeeId"
WHERE e.sensitive AND (e.r_loans = 'all' OR (e.r_loans = 'own' AND e.is_me));

-- ─── Tax and funds ──────────────────────────────────────────────────────────────────────────────────────────────

CREATE VIEW ask.gpf_entries WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       g.month, g.fy AS financial_year, g.kind::text AS kind, g.amount, g.note
FROM public."GpfEntry" g JOIN ask.emp e ON e.id = g."employeeId"
WHERE e.sensitive AND (e.r_statutory = 'all' OR (e.r_statutory = 'own' AND e.is_me));

CREATE VIEW ask.gpf_balances WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name, b.balance, b.last_month
FROM ask.emp e
JOIN LATERAL (
  SELECT sum(g.amount) AS balance, max(g.month) AS last_month
  FROM public."GpfEntry" g WHERE g."employeeId" = e.id
  HAVING count(*) > 0
) b ON true
WHERE e.sensitive AND (e.r_statutory = 'all' OR (e.r_statutory = 'own' AND e.is_me));

CREATE VIEW ask.gpf_advances WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       a.kind::text AS kind, a.purpose, a.amount, a.instalments, a."instalmentAmount" AS instalment_amount,
       a."sanctionDate" AS sanction_date, a."startMonth" AS start_month, a.status::text AS status, a."closedMonth" AS closed_month
FROM public."GpfAdvance" a JOIN ask.emp e ON e.id = a."employeeId"
WHERE e.sensitive AND (e.r_statutory = 'all' OR (e.r_statutory = 'own' AND e.is_me));

CREATE VIEW ask.tax_declarations WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       d.fy AS financial_year, d.regime, d.status::text AS status,
       COALESCE((d.items ->> 'sec80C')::numeric, 0) AS sec_80c,
       COALESCE((d.items ->> 'sec80D')::numeric, 0) AS sec_80d,
       COALESCE((d.items ->> 'sec80CCD1B')::numeric, 0) AS sec_80ccd_1b,
       COALESCE((d.items ->> 'homeLoanInterest')::numeric, 0) AS home_loan_interest,
       COALESCE((d.items ->> 'rentPaid')::numeric, 0) AS rent_paid,
       COALESCE((d.items ->> 'otherIncome')::numeric, 0) AS other_income,
       d.remarks, ask.ist(d."submittedAt")::date AS submitted_on, ask.ist(d."verifiedAt")::date AS verified_on
FROM public."TaxDeclaration" d JOIN ask.emp e ON e.id = d."employeeId"
WHERE e.sensitive AND (e.r_statutory = 'all' OR (e.r_statutory = 'own' AND e.is_me));

CREATE VIEW ask.tds_challans WITH (security_barrier = true) AS
SELECT t.fy AS financial_year, t.month, t."challanNo" AS challan_no, t."depositedOn" AS deposited_on, t.tax, t.cess, t.interest
FROM public."TdsChallan" t JOIN ask.ctx c ON c.board_id = t."boardId"
WHERE c.sensitive AND c.r_statutory = 'all';

/* The person themself sees a Form 16 once it is published. */
CREATE VIEW ask.form16 WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       f.fy AS financial_year, f."partAKey" IS NOT NULL AS has_part_a, f."partBKey" IS NOT NULL AS has_part_b,
       ask.ist(f."publishedAt")::date AS published_on
FROM public."Form16" f JOIN ask.emp e ON e.id = f."employeeId"
WHERE e.sensitive AND (e.r_statutory = 'all' OR (e.r_statutory = 'own' AND e.is_me AND f."publishedAt" IS NOT NULL));

CREATE VIEW ask.tax_rules WITH (security_barrier = true) AS
SELECT t.fy AS financial_year, t.regime, t."standardDeduction" AS standard_deduction,
       t."rebateIncomeLimit" AS rebate_income_limit, t."rebateMax" AS rebate_max, t."cessPercent" AS cess_percent
FROM public."TaxRule" t JOIN ask.ctx c ON c.board_id = t."boardId"
WHERE c.r_rates = 'all' OR c.r_statutory <> 'none';

CREATE VIEW ask.tax_slabs WITH (security_barrier = true) AS
SELECT t.fy AS financial_year, t.regime, s.n::int AS slab_no, (s.slab ->> 'upTo')::numeric AS income_up_to, (s.slab ->> 'rate')::numeric AS rate_percent
FROM public."TaxRule" t
JOIN ask.ctx c ON c.board_id = t."boardId"
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.slabs) = 'array' THEN t.slabs ELSE '[]'::jsonb END) WITH ORDINALITY AS s(slab, n)
WHERE c.r_rates = 'all' OR c.r_statutory <> 'none';

-- ─── Pension ────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE VIEW ask.pensioners WITH (security_barrier = true) AS
SELECT p.id AS pensioner_id, p."ppoNumber" AS ppo_number, p.type::text AS pension_type, p.status::text AS status,
       p.relation, p."payeeName" AS payee_name, p."payeeDob" AS payee_date_of_birth,
       e."employeeCode" AS employee_code, concat_ws(' ', e."firstName", e."middleName", e."lastName") AS employee_name,
       p."basicPension" AS basic_pension, p."reducedPension" AS reduced_pension, p."reducedFrom" AS reduced_from,
       p."commutedAmount" AS commuted_amount, p."commutationDate" AS commutation_date,
       p."fmaEligible" AS gets_medical_allowance, p."startDate" AS start_date, p."endDate" AS end_date, p."endReason" AS end_reason,
       p."bankName" AS bank_name, p."bankAccountEnc" IS NOT NULL AS has_bank_account
FROM public."Pensioner" p
JOIN ask.ctx c ON c.board_id = p."boardId"
JOIN public."Employee" e ON e.id = p."employeeId"
WHERE c.sensitive AND (c.r_pension = 'all' OR (c.r_pension = 'own' AND c.my_pensioner_id IS NOT NULL AND p.id = c.my_pensioner_id));

CREATE VIEW ask.pension_slips WITH (security_barrier = true) AS
SELECT s.id AS payslip_id, s."runId" AS run_id, p.id AS pensioner_id, p."ppoNumber" AS ppo_number, p."payeeName" AS payee_name,
       s.month, r.kind::text AS run_kind, r.status::text AS run_status, s.status::text AS slip_status, s."withheldReason" AS withheld_reason,
       s.gross, s.deductions, s.net, s."creditStatus"::text AS bank_credit_status
FROM public."Payslip" s
JOIN public."PayrollRun" r ON r.id = s."runId"
JOIN public."Pensioner" p ON p.id = s."pensionerId"
JOIN ask.ctx c ON c.board_id = s."boardId"
WHERE c.sensitive
  AND (c.r_pension = 'all' OR (c.r_pension = 'own' AND c.my_pensioner_id IS NOT NULL AND p.id = c.my_pensioner_id AND s.status = 'INCLUDED' AND r.status IN ('PAID', 'CLOSED')));

CREATE VIEW ask.pension_slip_lines WITH (security_barrier = true) AS
SELECT s.id AS payslip_id, p.id AS pensioner_id, p."ppoNumber" AS ppo_number, p."payeeName" AS payee_name,
       s.month, r.kind::text AS run_kind, r.status::text AS run_status,
       l.line ->> 'code' AS head_code, l.line ->> 'name' AS head_name, l.line ->> 'kind' AS head_kind,
       (l.line ->> 'amount')::numeric AS amount
FROM public."Payslip" s
JOIN public."PayrollRun" r ON r.id = s."runId"
JOIN public."Pensioner" p ON p.id = s."pensionerId"
JOIN ask.ctx c ON c.board_id = s."boardId"
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.lines) = 'array' THEN s.lines ELSE '[]'::jsonb END) AS l(line)
WHERE c.sensitive
  AND (c.r_pension = 'all' OR (c.r_pension = 'own' AND c.my_pensioner_id IS NOT NULL AND p.id = c.my_pensioner_id AND s.status = 'INCLUDED' AND r.status IN ('PAID', 'CLOSED')));

CREATE VIEW ask.life_certificates WITH (security_barrier = true) AS
SELECT p.id AS pensioner_id, p."ppoNumber" AS ppo_number, p."payeeName" AS payee_name,
       l.source::text AS source, l.status::text AS status, l."certifiedOn" AS certified_on, ask.ist(l."verifiedAt")::date AS verified_on, l.note
FROM public."LifeCertificate" l
JOIN public."Pensioner" p ON p.id = l."pensionerId"
JOIN ask.ctx c ON c.board_id = l."boardId"
WHERE c.r_pension = 'all' OR (c.r_pension = 'own' AND c.my_pensioner_id IS NOT NULL AND p.id = c.my_pensioner_id);

CREATE VIEW ask.pension_cases WITH (security_barrier = true) AS
SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
       pc.type::text AS pension_type, pc."retirementDate" AS retirement_date, pc.status::text AS status,
       pc."ppoNumber" AS ppo_number, ask.ist(pc."approvedAt")::date AS approved_on
FROM public."PensionCase" pc JOIN ask.emp e ON e.id = pc."employeeId"
WHERE e.sensitive AND e.r_pension = 'all';

-- ─── Rates and rules ────────────────────────────────────────────────────────────────────────────────────────────

CREATE VIEW ask.pay_rates WITH (security_barrier = true) AS
SELECT r.key AS rate_key, r.value, r."effectiveFrom" AS effective_from, r.note
FROM public."PayRate" r JOIN ask.ctx c ON c.board_id = r."boardId"
WHERE c.r_rates = 'all';

CREATE VIEW ask.pay_matrix WITH (security_barrier = true) AS
SELECT m.name AS matrix_name, m."effectiveFrom" AS effective_from, l.key AS pay_level, x.n::int AS pay_cell, (x.basic)::numeric AS basic_pay
FROM public."PayMatrix" m
JOIN ask.ctx c ON c.board_id = m."boardId"
CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(m.levels) = 'object' THEN m.levels ELSE '{}'::jsonb END) AS l(key, cells)
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(l.cells) = 'array' THEN l.cells ELSE '[]'::jsonb END) WITH ORDINALITY AS x(basic, n)
WHERE c.r_rates = 'all';

CREATE VIEW ask.pay_heads WITH (security_barrier = true) AS
SELECT h.code AS head_code, h.name AS head_name, h."nameHi" AS head_name_hi, h.kind::text AS head_kind, h.calc::text AS calculation,
       h.value, array_to_string(h."postCodes", ', ') AS post_codes, h.prorate AS reduced_for_unpaid_days,
       h."countsForDa" AS counts_for_da, h.taxable, h."accountHead" AS account_head, h."isActive" AS is_active
FROM public."PayHead" h JOIN ask.ctx c ON c.board_id = h."boardId"
WHERE c.r_rates = 'all';

CREATE VIEW ask.filing_due_dates WITH (security_barrier = true) AS
SELECT d.code AS filing_code, d.name AS filing_name, d.kind AS frequency, d.day AS day_of_month, array_to_string(d.dates, ', ') AS dates_mm_dd
FROM public."DueRule" d JOIN ask.ctx c ON c.board_id = d."boardId"
WHERE c.r_rates = 'all' OR c.r_statutory = 'all';

-- ─── Logins and the audit trail ─────────────────────────────────────────────────────────────────────────────────

CREATE VIEW ask.users WITH (security_barrier = true) AS
SELECT u."loginId" AS login_id, u."displayName" AS name, u."loginType"::text AS login_type,
       array_to_string(u.permissions::text[], ', ') AS permissions, u.status::text AS status,
       e."employeeCode" AS employee_code, ask.ist(u."lastLoginAt") AS last_login_at, ask.ist(u."createdAt")::date AS created_on
FROM public."User" u
JOIN ask.ctx c ON c.board_id = u."boardId"
LEFT JOIN public."Employee" e ON e.id = u."employeeId"
WHERE c.r_users = 'all';

/* What happened and who did it — never the old and new values. The User & settings manager: system events only. */
CREATE VIEW ask.audit_log WITH (security_barrier = true) AS
SELECT ask.ist(a.at) AS happened_at, a."userName" AS user_name, a."loginType"::text AS login_type, a.action,
       a."entityType" AS record_type, a.summary, a.category::text AS category
FROM public."AuditLog" a JOIN ask.ctx c ON c.board_id = a."boardId"
WHERE (c.r_audit = 'all' AND (c.sensitive OR NOT a."isSensitive"))
   OR (c.r_audit = 'system' AND a.category = 'SYSTEM' AND NOT a."isSensitive");

-- ─── What dcb_ask may read: the views above and nothing else ────────────────────────────────────────────────────
DO $$
DECLARE
  v record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dcb_ask') THEN
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA ask TO dcb_ask;
  FOR v IN SELECT viewname FROM pg_views WHERE schemaname = 'ask' AND viewname NOT IN ('ctx', 'emp') LOOP
    EXECUTE format('GRANT SELECT ON ask.%I TO dcb_ask', v.viewname);
  END LOOP;
END $$;

-- ─── Running a statement ────────────────────────────────────────────────────────────────────────────────────────
/* Runs one statement as dcb_ask and returns at most max_rows rows, each as a JSON list of [column, value] pairs (the
   order and any repeated column names are kept). Because the function is SECURITY DEFINER and owned by dcb_ask:
   - the statement has dcb_ask's rights only, whoever calls;
   - PostgreSQL refuses SET ROLE / set_config('role', …) / SET SESSION AUTHORIZATION inside it. */
CREATE FUNCTION ask.run(stmt text, max_rows integer) RETURNS SETOF json
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ask, pg_catalog, pg_temp
AS $fn$
BEGIN
  RETURN QUERY EXECUTE format(
    'SELECT (SELECT COALESCE(json_agg(json_build_array(j.key, j.value)), ''[]''::json) FROM json_each(row_to_json(q)) AS j) FROM (%s) AS q LIMIT %s',
    stmt, GREATEST(max_rows, 0));
END
$fn$;

REVOKE ALL ON FUNCTION ask.run(text, integer) FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dcb_ask') THEN
    RETURN;
  END IF;
  -- The application's login may call it; nobody else.
  EXECUTE format('GRANT EXECUTE ON FUNCTION ask.run(text, integer) TO %I', current_user);
  -- Handing the function to dcb_ask needs that role to hold CREATE on the schema for a moment.
  GRANT CREATE ON SCHEMA ask TO dcb_ask;
  ALTER FUNCTION ask.run(text, integer) OWNER TO dcb_ask;
  REVOKE CREATE ON SCHEMA ask FROM dcb_ask;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Ask AI: ask.run could not be handed to dcb_ask (%) — run scripts/ask-role.sql as a database administrator.', SQLERRM;
END $$;
