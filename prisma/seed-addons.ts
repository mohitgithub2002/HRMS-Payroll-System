/**
 * Demo data for the client add-ons, shared by the seed and `npm run db:demo-addons` (which brings an existing demo
 * copy up to date without touching anything already there). Never for production data.
 */
import type { PrismaClient } from "../src/generated/prisma/client";
import { addDays, fromISODate, todayIST } from "../src/lib/dates";

const ORDER = "DCB/EST/Resig/41";

/**
 * A resignation at the end of last month (Vikas Malhotra, DCB10012, with a running loan) whose full and final
 * settlement Payroll still has to prepare. Idempotent: made once; on a later run only puts the person back off the
 * rolls if a re-seed reset them. Returns what it did.
 */
export async function seedDemoLeaver(db: PrismaClient, boardId: string): Promise<"added" | "kept" | "skipped"> {
  const e = await db.employee.findFirst({ where: { boardId, employeeCode: "DCB10012" } });
  if (!e) return "skipped";
  const existing = await db.separation.findFirst({ where: { employeeId: e.id, kind: "RESIGNATION", orderNumber: ORDER } });
  if (existing) {
    if (e.status === "ACTIVE") await db.employee.update({ where: { id: e.id }, data: { status: "RESIGNED", exitDate: existing.effectiveDate, exitReason: `Resignation (order ${ORDER})` } });
    return "kept";
  }
  if (e.status !== "ACTIVE" || (await db.separation.count({ where: { employeeId: e.id } }))) return "skipped";
  const hr = await db.user.findFirst({ where: { boardId, loginType: "HR_ACCOUNTS", loginId: "DCB10003" } });
  if (!hr) return "skipped";
  const lastDay = addDays(`${todayIST().slice(0, 7)}-01`, -1);
  const orderDate = addDays(lastDay, -30);
  const sep = await db.separation.create({
    data: { boardId, employeeId: e.id, kind: "RESIGNATION", status: "APPROVED", effectiveDate: fromISODate(lastDay), orderNumber: ORDER, orderDate: fromISODate(orderDate), reason: "Resigned on selection to a post in the Delhi Jal Board; one month's notice served.", createdById: hr.id, createdByName: hr.displayName, approvedAt: new Date(`${orderDate}T10:00:00Z`) },
  });
  await db.employee.update({ where: { id: e.id }, data: { status: "RESIGNED", exitDate: fromISODate(lastDay), exitReason: `Resignation (order ${ORDER})` } });
  await db.serviceBookEntry.create({
    data: { employeeId: e.id, event: "EXIT", eventDate: fromISODate(lastDay), orderNumber: ORDER, orderDate: fromISODate(orderDate), details: `Resignation accepted; last day of service ${lastDay}.`, detailsHi: `त्यागपत्र स्वीकृत; सेवा का अंतिम दिन ${lastDay}।`, data: { separationId: sep.id, kind: "RESIGNATION" }, status: "APPROVED", createdById: hr.id },
  });
  return "added";
}

/**
 * Ask AI: a few documents to try it with on a demo or training copy — how-to notes that describe this system, and
 * one sample office order. Added once, only while the Board has no document of its own. Returns how many were added.
 */
export async function seedAskDocuments(db: PrismaClient, boardId: string): Promise<number> {
  if (await db.knowledgeDoc.count({ where: { boardId } })) return 0;
  const admin = await db.user.findFirst({ where: { boardId, loginType: "ADMIN", permissions: { has: "APPROVER" } }, orderBy: { loginId: "asc" } });
  if (!admin) return 0;
  const docs: { title: string; category: string; reference: string | null; audience: "EVERYONE" | "STAFF"; body: string }[] = [
    {
      title: "How to apply for leave",
      category: "HOWTO",
      reference: null,
      audience: "EVERYONE",
      body: [
        "Leave is applied for on the Leave screen. Choose the kind of leave, the first and last day, and write the reason. The screen shows how many days will be counted and what balance will be left before you send it.",
        "Who decides: your section head sanctions leave up to the limit set for each kind of leave. Longer leave, and leave for staff who have no section head on the system, is decided by the HR section. You get an SMS when it is decided.",
        "Casual leave cannot be joined with earned leave or half pay leave. A medical certificate is attached for leave on medical grounds. Restricted holidays can be taken only on a day in the restricted-holiday list.",
        "If your plans change, you can cancel leave that has not started. Leave already taken is corrected by the HR section.",
        "Staff who do not use the system give a paper application to the HR section, which enters it with the sanction order.",
      ].join("\n\n"),
    },
    {
      title: "Office hours and attendance (sample order — replace with the Board's own)",
      category: "ORDER",
      reference: "Sample/ADM/01",
      audience: "EVERYONE",
      body: [
        "This is a sample order for practice. The Board's Admin should replace it with the office order in force.",
        "Office hours are 9:00 a.m. to 5:30 p.m. from Monday to Friday, with lunch from 1:00 p.m. to 1:30 p.m. Saturdays and Sundays are weekly offs unless a section is told otherwise.",
        "Attendance is marked on the biometric device when coming in and when leaving. A person who comes in more than 15 minutes after office time is marked late. A person whose first and last punch are less than four hours apart is marked for half a day.",
        "If a punch is missed, or you were away on official duty, send a missed-punch or on-duty request from My attendance the same week. Your section head decides it.",
        "Each section head locks the section's attendance for the month by the 25th. Days without attendance, leave or an approved request are treated as dies-non and pay is not drawn for them.",
      ].join("\n\n"),
    },
    {
      title: "Payslips, tax and who to ask",
      category: "HOWTO",
      reference: null,
      audience: "EVERYONE",
      body: [
        "Your payslip is under My payslips once the month's salary has been paid. It can be opened in Hindi or English and downloaded as a PDF. A link is also sent by SMS and email.",
        "Income tax is deducted every month from an estimate of the whole year's income. To lower it under the old tax regime, fill in your declaration under My tax and attach the proofs before the date the Accounts section announces. Form 16 appears under My tax after the year ends.",
        "GPF subscribers see their account under My funds; NPS subscribers see the contributions deducted from pay and the Board's share.",
        "For a wrong amount on a payslip, a loan instalment or a tax question, write to the Accounts section. For a change of address, mobile number, bank account or nominee, send a request from My requests; a change of bank account takes effect once it is approved.",
      ].join("\n\n"),
    },
    {
      title: "Monthly payroll: order of work for the Accounts section",
      category: "HOWTO",
      reference: null,
      audience: "STAFF",
      body: [
        "Before the pay bill: every section's attendance for the previous month should be locked; approved leave, pay changes, new loans and standing deductions should be entered.",
        "Work out the salaries. Go through each point the pre-checks raise: a person without a bank account, net pay changed by more than 25 per cent, attendance not locked. Hold the pay or record why it is in order.",
        "After approval, download the bank file and upload it on the bank's portal. When the bank returns failed credits, upload the return file and make the re-payment file.",
        "Finish the month only after the salaries have reached the accounts: payslips are sent and the accounting summary is made. Then build the month's statutory files — NPS, EPF and ESIC — and deposit TDS by the due date shown on the Tax and funds screen.",
      ].join("\n\n"),
    },
  ];
  for (const d of docs) await db.knowledgeDoc.create({ data: { boardId, ...d, createdById: admin.id, createdByName: admin.displayName } });
  return docs.length;
}
