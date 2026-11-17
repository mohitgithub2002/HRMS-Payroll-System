/**
 * Ask AI: the views a question may read (schema "ask", built in prisma/migrations/*_ask_views) — what each holds and
 * for whom it is listed. The same list is the allowlist of the SQL guard and the description given to the model, so
 * the model is never told about a view the person cannot use, and cannot use one it was not told about.
 *
 * Listing a view is a courtesy, not the control: every view filters its own rows from the person's pass, in the
 * database. Pure module. An integration test checks the columns here against the database.
 */
import type { AskArea, AskScope, Reach } from "./scope";

type ColType = "text" | "number" | "date" | "time" | "timestamp" | "boolean";
const TYPES: Record<string, ColType> = { s: "text", n: "number", d: "date", t: "time", ts: "timestamp", b: "boolean" };

export interface AskColumn {
  name: string;
  type: ColType;
}

export interface AskView {
  name: string;
  /** What the view holds, with the values of its coded columns. */
  about: string;
  /** Whose rows the person sees — a sentence for the model — or null when the view is not for this person. */
  rows: (s: AskScope) => string | null;
  columns: AskColumn[];
}

const cols = (spec: string): AskColumn[] =>
  spec
    .trim()
    .split(/\s+/)
    .map((c) => {
      const [name, t] = c.split(":");
      return { name: name!, type: TYPES[t!]! };
    });

/** Rows about employees: the whole Board, the section, or the person's own. */
const staffRows =
  (area: AskArea, opts: { sensitive?: boolean; sectionAsOwn?: boolean } = {}) =>
  (s: AskScope): string | null => {
    if (opts.sensitive && !s.sensitive) return null;
    const r: Reach = s.reach[area];
    if (r === "all") return "everyone of the Board";
    if (r === "section") return opts.sectionAsOwn ? "the user's own record only" : "the staff of the user's own section (and the user)";
    if (r === "own") return "the user's own record only";
    return null;
  };

const allOnly =
  (area: AskArea, opts: { sensitive?: boolean } = {}) =>
  (s: AskScope): string | null =>
    s.reach[area] === "all" && (!opts.sensitive || s.sensitive) ? "the whole Board" : null;

const everyone = () => "the whole Board";

const EMP = "employee_id:s employee_code:s employee_name:s";

export const ASK_VIEWS: AskView[] = [
  {
    name: "me",
    about: "One row: the person asking. employee_id is their own row in the other views (null when the login has no employee record).",
    rows: () => "the user",
    columns: cols("login_id:s name:s login_type:s employee_id:s employee_code:s section_code:s section_name:s pensioner_id:s"),
  },
  {
    name: "sections",
    about: "The Board's sections (departments). attendance_mode: DEVICE (biometric) or MANUAL (muster).",
    rows: everyone,
    columns: cols("section_code:s section_name:s section_name_hi:s is_active:b attendance_mode:s"),
  },
  {
    name: "posts",
    about: "Posts (designations) with the pay level, group (A, B, C) and retirement age.",
    rows: everyone,
    columns: cols("post_code:s post_name:s post_name_hi:s pay_level:s post_group:s retirement_age:n is_active:b"),
  },
  {
    name: "holidays",
    about: "The holiday calendar. kind: GAZETTED (office closed) or RESTRICTED (optional, taken as RH leave).",
    rows: everyone,
    columns: cols("holiday_date:d holiday_name:s holiday_name_hi:s kind:s"),
  },
  {
    name: "employees",
    about:
      "One row per person. employee_type: PERMANENT_OPS, PERMANENT_NPS, CONTRACT, DAILY_WAGE, REEMPLOYED, DEPUTATION. " +
      "status: DRAFT (not yet approved), ACTIVE, SUSPENDED, RETIRED, RESIGNED, TRANSFERRED, TERMINATED, DECEASED — 'on the rolls' means ACTIVE or SUSPENDED. " +
      "gender: M, F, T. category: GEN, OBC, SC, ST, EWS. basic_pay is today's basic for the pay level and cell (rupees a month). " +
      "increment_month: 1 or 7. has_* say whether the number is on file; the numbers themselves are never available here. " +
      "For people the user sees only as section staff, every column after mobile is null.",
    rows: staffRows("people"),
    columns: cols(
      "employee_id:s employee_code:s name:s name_hi:s employee_type:s status:s section_code:s section_name:s post_code:s post_name:s mobile:s email:s gender:s " +
        "date_of_birth:d date_of_joining:d date_of_retirement:d exit_date:d exit_reason:s father_or_spouse_name:s category:s marital_status:s blood_group:s is_disabled:b " +
        "city:s district:s state:s probation_end_date:d confirmation_date:d agency_name:s contract_start:d contract_end:d pay_level:s pay_cell:n basic_pay:n increment_month:n " +
        "wage_rate:n wage_basis:s bank_name:s has_bank_account:b has_pan:b has_aadhaar:b has_pran:b has_uan:b",
    ),
  },
  {
    name: "family_members",
    about: "Family of an employee. relation: SPOUSE, SON, DAUGHTER, FATHER, MOTHER, BROTHER, SISTER, OTHER.",
    rows: staffRows("people", { sectionAsOwn: true }),
    columns: cols(`${EMP} member_name:s relation:s gender:s date_of_birth:d is_dependent:b is_disabled:b is_alive:b`),
  },
  {
    name: "nominees",
    about: "Nominees per scheme (GPF, GRATUITY, GROUP_INSURANCE, FAMILY_PENSION, NPS) with the share in percent.",
    rows: staffRows("people", { sectionAsOwn: true }),
    columns: cols(`${EMP} scheme:s nominee_name:s relation:s share_percent:n`),
  },
  {
    name: "employee_documents",
    about: "Which papers are on a person's file (category such as APPOINTMENT_ORDER, ID_PROOF, BANK_PROOF, SERVICE_BOOK, PHOTO) — titles and dates only, not the files.",
    rows: staffRows("people", { sectionAsOwn: true }),
    columns: cols(`${EMP} category:s title:s uploaded_on:d`),
  },
  {
    name: "service_book",
    about:
      "Service book entries. event: APPOINTMENT, CONFIRMATION, INCREMENT, PROMOTION, MACP, PAY_FIXATION, TRANSFER, LEAVE, PENALTY, REWARD, RETIREMENT, SUSPENSION, REINSTATEMENT, EXIT, OTHER. " +
      "status: PENDING, APPROVED, REJECTED.",
    rows: staffRows("service"),
    columns: cols(`${EMP} section_name:s event:s event_date:d order_number:s order_date:d details:s status:s`),
  },
  {
    name: "pay_history",
    about: "Pay level and cell from a date, with the basic pay then. reason: INITIAL, INCREMENT, PROMOTION, MACP, CORRECTION.",
    rows: (s) => {
      if (!s.sensitive) return null;
      if (s.reach.payroll === "all" || s.reach.service === "all") return "everyone of the Board";
      if (s.reach.payroll === "own" || s.reach.service === "own") return "the user's own record only";
      return null;
    },
    columns: cols(`${EMP} effective_from:d pay_level:s pay_cell:n reason:s basic_pay:n`),
  },
  {
    name: "separations",
    about:
      "Suspensions and leaving service (other than retirement and death). kind: SUSPENSION, RESIGNATION, REMOVAL, DISMISSAL, TERMINATION, CONTRACT_END, TRANSFER_OUT. " +
      "status: PENDING, APPROVED, REJECTED, ENDED. settlement_status: NONE, CHECKING, APPROVED, SETTLED.",
    rows: allOnly("people"),
    columns: cols(`${EMP} section_name:s kind:s status:s effective_date:d order_number:s order_date:d reason:s end_date:d settlement_status:s settled_on:d`),
  },
  {
    name: "sanctioned_posts",
    about: "Sanctioned strength per section and post, how many are filled (permanent staff on the rolls) and vacant.",
    rows: allOnly("people"),
    columns: cols("section_code:s section_name:s post_code:s post_name:s sanctioned:n filled:n vacant:n"),
  },
  {
    name: "vacancies",
    about: "Vacancies advertised. status: DRAFT, PENDING_APPROVAL, APPROVED, ADVERTISED, CLOSED, CANCELLED, REJECTED. selection_status: OPEN, PENDING_APPROVAL, APPROVED.",
    rows: allOnly("recruitment"),
    columns: cols(
      "reference_no:s section_code:s section_name:s post_code:s post_name:s pay_level:s seats:n seats_gen:n seats_obc:n seats_sc:n seats_st:n seats_ews:n advert_number:s advert_date:d last_date:d status:s selection_status:s applicants:n",
    ),
  },
  {
    name: "applicants",
    about: "Applicants for a vacancy (join on vacancies.reference_no). status: APPLIED, ELIGIBLE, SHORTLISTED, SELECTED, WAITLISTED, REJECTED.",
    rows: allOnly("recruitment"),
    columns: cols("vacancy_reference_no:s application_no:s name:s gender:s date_of_birth:d category:s qualification:s score:n merit_rank:n status:s appointment_letter_no:s appointment_letter_date:d"),
  },
  {
    name: "joinings",
    about: "People being taken on. status: IN_PROGRESS, SUBMITTED, COMPLETED, CANCELLED.",
    rows: allOnly("recruitment"),
    columns: cols(`${EMP} section_name:s post_name:s vacancy_reference_no:s status:s started_on:d completed_on:d`),
  },
  {
    name: "attendance_monthly",
    about: "Month totals per person, saved when the section locks the month (month is 'YYYY-MM'). A month that is not locked has no row here.",
    rows: staffRows("attendance"),
    columns: cols(
      `${EMP} section_name:s month:s days_in_month:n days_on_roll:n present:n late_days:n half_days:n on_duty_days:n leave_days:n holidays:n weekly_offs:n dies_non_days:n half_pay_leave_days:n no_pay_leave_days:n payable_days:n worked_days:n`,
    ),
  },
  {
    name: "attendance_days",
    about:
      "A person's day where it has been recorded: every day of a locked month, and in an open month only leave, muster entries and approved requests. " +
      "status: PRESENT, LATE, HALF_DAY, ABSENT, MISSED_PUNCH, ON_DUTY, LEAVE, HOLIDAY, WEEKLY_OFF, DIES_NON. A day without a row in an open month is not 'absent' — read attendance_punches for it.",
    rows: staffRows("attendance"),
    columns: cols(`${EMP} section_name:s day:d status:s first_in:t last_out:t worked_minutes:n source:s leave_code:s half_day:b note:s`),
  },
  {
    name: "attendance_punches",
    about: "Every biometric punch, in India time. The first punch of a day is the time in, the last the time out.",
    rows: staffRows("attendance"),
    columns: cols(`${EMP} section_name:s punch_date:d punch_time:t`),
  },
  {
    name: "attendance_requests",
    about: "Missed-punch and on-duty requests. request_type: MISSED_PUNCH, ON_DUTY. status: PENDING, APPROVED, REJECTED, RETURNED, CANCELLED.",
    rows: staffRows("attendance"),
    columns: cols(`${EMP} section_name:s day:d request_type:s in_time:s out_time:s reason:s status:s requested_on:d decided_on:d`),
  },
  {
    name: "attendance_locks",
    about: "Which sections have locked which month (month is 'YYYY-MM').",
    rows: (s) => (s.reach.attendance === "all" ? "every section" : s.reach.attendance !== "none" && s.sectionId ? "the user's own section" : null),
    columns: cols("section_code:s section_name:s month:s locked_by:s locked_on:d is_locked:b reopened_on:d"),
  },
  {
    name: "leave_types",
    about:
      "The leave rules in force. pay: FULL, HALF, NONE. credit_mode: HALF_YEARLY (1 Jan and 1 Jul), YEARLY (1 Jan), SPELL (per spell), SERVICE (in the whole service), NONE. " +
      "section_head_limit_days: the section head may sanction up to this many days.",
    rows: everyone,
    columns: cols(
      "leave_code:s leave_name:s leave_name_hi:s pay:s credit_mode:s credit_days:n max_balance:n lapses_at_year_end:b debit_from:s debit_factor:n counts_holidays_inside:b half_day_allowed:b needs_certificate:b " +
        "restricted_holidays_only:b only_for_gender:s employee_types:s section_head_limit_days:n is_active:b",
    ),
  },
  {
    name: "leave_balances",
    about: "Leave balance today per person and leave_code (CL, EL, HPL …). pending_days: days asked for and not yet decided.",
    rows: staffRows("leave"),
    columns: cols(`${EMP} section_name:s leave_code:s balance_days:n pending_days:n`),
  },
  {
    name: "leave_ledger",
    about: "Every credit (+) and debit (−) of leave. kind: OPENING, CREDIT, DEBIT, LAPSE, REVERSAL.",
    rows: staffRows("leave"),
    columns: cols(`${EMP} leave_code:s entry_date:d kind:s days:n period:s note:s`),
  },
  {
    name: "leave_applications",
    about: "Leave asked for. status: PENDING, APPROVED, REJECTED, RETURNED, CANCELLED. A person is on leave on a day when an APPROVED row has from_date <= day <= to_date.",
    rows: staffRows("leave"),
    columns: cols(`${EMP} section_name:s leave_code:s from_date:d to_date:d half_day:b days:n reason:s status:s entered_by_hr:b applied_on:d decided_on:d cancelled_on:d`),
  },
  {
    name: "payroll_runs",
    about:
      "Pay bills with their totals (rupees). pay_group: OPS, NPS, CONTRACT, PENSION. run_kind: REGULAR (the month's bill) or SUPPLEMENTARY (arrears, withheld pay, settlement). " +
      "run_status: DRAFT, CHECKING, APPROVING, APPROVED, PAID, CLOSED — a bill counts as paid from PAID. month is 'YYYY-MM'.",
    rows: (s) => {
      if (!s.sensitive) return null;
      const pay = s.reach.payroll === "all";
      const pen = s.reach.pension === "all";
      return pay && pen ? "every bill" : pay ? "salary bills (not pension bills)" : pen ? "pension bills only" : null;
    },
    columns: cols(
      "run_id:s pay_group:s month:s run_kind:s bill_no:n title:s run_status:s people:n gross:n deductions:n net:n employer_share:n worked_out_by:s worked_out_on:d checked_by:s approved_by:s approved_on:d paid_on:d closed_on:d",
    ),
  },
  {
    name: "payslips",
    about:
      "One person's salary in one bill (rupees): gross, deductions, net, the Board's share. slip_status: INCLUDED or WITHHELD. " +
      "run_kind: REGULAR (the month's bill) or SUPPLEMENTARY (arrears, withheld pay, settlement). run_status: DRAFT, CHECKING, APPROVING, APPROVED, PAID, CLOSED. " +
      "For a month's salary use run_kind = 'REGULAR'; unless asked about work in progress use run_status IN ('APPROVED','PAID','CLOSED'). The newest month is max(month).",
    rows: staffRows("payroll", { sensitive: true, sectionAsOwn: true }),
    columns: cols(
      `payslip_id:s run_id:s ${EMP} section_name:s month:s pay_group:s run_kind:s run_status:s pay_level:s pay_cell:n slip_status:s withheld_reason:s days_in_month:n days_on_roll:n unpaid_days:n half_pay_days:n gross:n deductions:n net:n employer_share:n bank_credit_status:s`,
    ),
  },
  {
    name: "payslip_lines",
    about:
      "The lines of a salary slip. head_kind: EARNING, DEDUCTION, EMPLOYER. head_code examples: BASIC, DA, HRA, TA, NPA, WAGES (earnings); NPS, GPF, GIS, EPF, IT (income tax / TDS), LOAN, LICENCE, SOCIETY (deductions); NPS_ER, EPF_ER (the Board's share).",
    rows: staffRows("payroll", { sensitive: true, sectionAsOwn: true }),
    columns: cols(`payslip_id:s ${EMP} month:s run_kind:s run_status:s head_code:s head_name:s head_kind:s amount:n`),
  },
  {
    name: "payroll_checks",
    about: "Points raised when a bill was worked out. severity: BLOCK or WARN. resolution: EXPLAINED, WITHHELD, WAIVED, or null while open.",
    rows: (s) => (s.sensitive && (s.reach.payroll === "all" || s.reach.pension === "all") ? "the bills the user can see" : null),
    columns: cols("month:s pay_group:s run_kind:s employee_code:s employee_name:s check_code:s severity:s resolution:s note:s resolved_by:s"),
  },
  {
    name: "pay_items",
    about: "Standing allowances and deductions of one person (head_code as in pay_heads), from_month to to_month ('YYYY-MM', to_month null = still running).",
    rows: allOnly("payroll", { sensitive: true }),
    columns: cols(`${EMP} head_code:s amount:n from_month:s to_month:s note:s`),
  },
  {
    name: "loans",
    about: "Loans and advances. loan_type: HBA, VEHICLE, COMPUTER, FESTIVAL, OTHER. status: PENDING, RUNNING, CLOSED, REJECTED. Amounts in rupees.",
    rows: staffRows("loans", { sensitive: true, sectionAsOwn: true }),
    columns: cols(
      `loan_id:s ${EMP} loan_type:s purpose:s principal:n interest_rate_percent:n instalments:n instalment_amount:n sanction_date:d start_month:s status:s closed_month:s principal_recovered:n interest_recovered:n instalments_recovered:n principal_outstanding:n`,
    ),
  },
  {
    name: "loan_recoveries",
    about: "Instalments recovered through the pay bills, month by month.",
    rows: staffRows("loans", { sensitive: true, sectionAsOwn: true }),
    columns: cols(`loan_id:s ${EMP} loan_type:s month:s principal:n interest:n`),
  },
  {
    name: "gpf_entries",
    about: "GPF account entries (credit +, debit −). kind: OPENING, SUBSCRIPTION, REFUND, ADVANCE, WITHDRAWAL, INTEREST. financial_year like '2026-27'.",
    rows: staffRows("statutory", { sensitive: true, sectionAsOwn: true }),
    columns: cols(`${EMP} month:s financial_year:s kind:s amount:n note:s`),
  },
  {
    name: "gpf_balances",
    about: "GPF balance today per person (only people with a GPF account).",
    rows: staffRows("statutory", { sensitive: true, sectionAsOwn: true }),
    columns: cols(`${EMP} balance:n last_month:s`),
  },
  {
    name: "gpf_advances",
    about: "GPF advances and withdrawals. kind: ADVANCE, WITHDRAWAL. status: PENDING, RUNNING, CLOSED, REJECTED.",
    rows: staffRows("statutory", { sensitive: true, sectionAsOwn: true }),
    columns: cols(`${EMP} kind:s purpose:s amount:n instalments:n instalment_amount:n sanction_date:d start_month:s status:s closed_month:s`),
  },
  {
    name: "tax_declarations",
    about: "Income-tax declaration per person and financial year. regime: NEW or OLD. status: DRAFT, SUBMITTED, VERIFIED, RETURNED. Amounts declared, in rupees.",
    rows: staffRows("statutory", { sensitive: true, sectionAsOwn: true }),
    columns: cols(`${EMP} financial_year:s regime:s status:s sec_80c:n sec_80d:n sec_80ccd_1b:n home_loan_interest:n rent_paid:n other_income:n remarks:s submitted_on:d verified_on:d`),
  },
  {
    name: "tds_challans",
    about: "TDS challans deposited, per month.",
    rows: allOnly("statutory", { sensitive: true }),
    columns: cols("financial_year:s month:s challan_no:s deposited_on:d tax:n cess:n interest:n"),
  },
  {
    name: "form16",
    about: "Form 16 per person and financial year: whether Part A and Part B are there and when it was published.",
    rows: staffRows("statutory", { sensitive: true, sectionAsOwn: true }),
    columns: cols(`${EMP} financial_year:s has_part_a:b has_part_b:b published_on:d`),
  },
  {
    name: "tax_rules",
    about: "Income-tax rules per financial year and regime (NEW, OLD): standard deduction, rebate and cess.",
    rows: (s) => (s.reach.rates === "all" || s.reach.statutory !== "none" ? "the whole Board" : null),
    columns: cols("financial_year:s regime:s standard_deduction:n rebate_income_limit:n rebate_max:n cess_percent:n"),
  },
  {
    name: "tax_slabs",
    about: "Income-tax slabs: income up to income_up_to (null = above the last slab) is taxed at rate_percent.",
    rows: (s) => (s.reach.rates === "all" || s.reach.statutory !== "none" ? "the whole Board" : null),
    columns: cols("financial_year:s regime:s slab_no:n income_up_to:n rate_percent:n"),
  },
  {
    name: "pensioners",
    about:
      "Pensions being paid. pension_type: SUPERANNUATION, VOLUNTARY, INVALID, COMPULSORY, FAMILY. status: ACTIVE, STOPPED. relation: SELF or the family member. " +
      "employee_code and employee_name: whose service earned the pension. Amounts in rupees a month.",
    rows: (s) => (!s.sensitive ? null : s.reach.pension === "all" ? "every pensioner of the Board" : s.reach.pension === "own" ? "the user's own pension only" : null),
    columns: cols(
      "pensioner_id:s ppo_number:s pension_type:s status:s relation:s payee_name:s payee_date_of_birth:d employee_code:s employee_name:s basic_pension:n reduced_pension:n reduced_from:d commuted_amount:n commutation_date:d " +
        "gets_medical_allowance:b start_date:d end_date:d end_reason:s bank_name:s has_bank_account:b",
    ),
  },
  {
    name: "pension_slips",
    about:
      "One pensioner's pension in one bill (rupees). run_kind: REGULAR or SUPPLEMENTARY (arrears, benefits). run_status: DRAFT, CHECKING, APPROVING, APPROVED, PAID, CLOSED — paid from PAID. " +
      "slip_status: INCLUDED or WITHHELD. The newest month is max(month).",
    rows: (s) => (!s.sensitive ? null : s.reach.pension === "all" ? "every pensioner of the Board" : s.reach.pension === "own" ? "the user's own pension only" : null),
    columns: cols("payslip_id:s run_id:s pensioner_id:s ppo_number:s payee_name:s month:s run_kind:s run_status:s slip_status:s withheld_reason:s gross:n deductions:n net:n bank_credit_status:s"),
  },
  {
    name: "pension_slip_lines",
    about: "The lines of a pension slip. head_code examples: BASIC_PENSION, ADDL_PENSION, DR (dearness relief), FMA (medical allowance), COMMUTATION (deduction), IT.",
    rows: (s) => (!s.sensitive ? null : s.reach.pension === "all" ? "every pensioner of the Board" : s.reach.pension === "own" ? "the user's own pension only" : null),
    columns: cols("payslip_id:s pensioner_id:s ppo_number:s payee_name:s month:s run_kind:s run_status:s head_code:s head_name:s head_kind:s amount:n"),
  },
  {
    name: "life_certificates",
    about: "Life certificates. source: MANUAL, JEEVAN_PRAMAAN. status: SUBMITTED, VERIFIED, REJECTED.",
    rows: (s) => (s.reach.pension === "all" ? "every pensioner of the Board" : s.reach.pension === "own" ? "the user's own pension only" : null),
    columns: cols("pensioner_id:s ppo_number:s payee_name:s source:s status:s certified_on:d verified_on:d note:s"),
  },
  {
    name: "pension_cases",
    about: "New pension cases. status: DRAFT, CHECKING, APPROVING, APPROVED, REJECTED.",
    rows: allOnly("pension", { sensitive: true }),
    columns: cols(`${EMP} pension_type:s retirement_date:d status:s ppo_number:s approved_on:d`),
  },
  {
    name: "pay_rates",
    about:
      "Dated rates. The rate in force on a day is the row with the latest effective_from on or before it. rate_key examples: DA_PERCENT, HRA_PERCENT, TA_LOW, TA_MID, TA_HIGH, NPS_EMPLOYEE, NPS_EMPLOYER, " +
      "GPF_MIN, GPF_INTEREST, GIS_A, GIS_B, GIS_C, EPF_EMPLOYEE, ESIC_EMPLOYEE, FMA, GRATUITY_CEILING, PENSION_MIN, PENSION_MAX.",
    rows: allOnly("rates"),
    columns: cols("rate_key:s value:n effective_from:d note:s"),
  },
  {
    name: "pay_matrix",
    about: "The pay matrix: basic pay (rupees a month) for each pay level and cell, per matrix in force from a date.",
    rows: allOnly("rates"),
    columns: cols("matrix_name:s effective_from:d pay_level:s pay_cell:n basic_pay:n"),
  },
  {
    name: "pay_heads",
    about: "Earnings, deductions and the Board's shares. head_kind: EARNING, DEDUCTION, EMPLOYER. calculation: SYSTEM (worked out by the pay rules), FIXED (rupees), PERCENT_BASIC, ITEM (per person).",
    rows: allOnly("rates"),
    columns: cols("head_code:s head_name:s head_name_hi:s head_kind:s calculation:s value:n post_codes:s reduced_for_unpaid_days:b counts_for_da:b taxable:b account_head:s is_active:b"),
  },
  {
    name: "filing_due_dates",
    about: "When each statutory filing is due. frequency: MONTHLY (day_of_month of the next month), QUARTERLY or YEARLY (dates_mm_dd), AFTER_PAY (days after the pay bill is approved).",
    rows: (s) => (s.reach.rates === "all" || s.reach.statutory === "all" ? "the whole Board" : null),
    columns: cols("filing_code:s filing_name:s frequency:s day_of_month:n dates_mm_dd:s"),
  },
  {
    name: "users",
    about: "Logins. login_type: ADMIN, HR_ACCOUNTS, EMPLOYEE. permissions: comma-separated (APPROVER, PAY_BILL_SIGNER, USER_SETTINGS_MANAGER, HR, PAYROLL, PENSION, CHECKER, REPORTING_OFFICER). status: ACTIVE, DISABLED.",
    rows: allOnly("users"),
    columns: cols("login_id:s name:s login_type:s permissions:s status:s employee_code:s last_login_at:ts created_on:d"),
  },
  {
    name: "audit_log",
    about: "The audit trail: what was done, by whom and when (India time) — a summary line, not the old and new values. category: SYSTEM (logins, users, settings) or DATA.",
    rows: (s) => (s.reach.audit === "all" ? "every event" : s.reach.audit === "system" ? "system events only (logins, users, settings)" : null),
    columns: cols("happened_at:ts user_name:s login_type:s action:s record_type:s summary:s category:s"),
  },
];

export const ASK_VIEW_NAMES: ReadonlySet<string> = new Set(ASK_VIEWS.map((v) => v.name));

/** The views this person may use, with whose rows each one holds for them. */
export function viewsFor(scope: AskScope): { view: AskView; rows: string }[] {
  return ASK_VIEWS.flatMap((view) => {
    const rows = view.rows(scope);
    return rows ? [{ view, rows }] : [];
  });
}

/** The schema as the model reads it. */
export function describeViews(scope: AskScope): string {
  return viewsFor(scope)
    .map(({ view, rows }) => `${view.name} — ${view.about}\n  Rows: ${rows}.\n  Columns: ${view.columns.map((c) => `${c.name} ${c.type}`).join(", ")}`)
    .join("\n\n");
}
