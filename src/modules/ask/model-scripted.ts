/**
 * Ask AI: a stand-in for the language model that follows a few fixed rules. It lets the browser checks and practice
 * copies without an API key go through the real path — the guard, the read-only role, the person's pass — with
 * answers that are the same every time. It is never used on a production copy (model.ts).
 *
 * What it understands:
 *   "sql: <statement>"            runs the statement (handy for showing what a login can and cannot read)
 *   "… leave balance …"           the person's own leave balances
 *   "… salary / payslip / pay …"  the person's own last three payslips
 *   "… how many employees …"      people on the rolls the person can see
 *   "… policy / rule / order …"   searches the Board's documents
 */
import type { AskModel, AskReply, AskMessage } from "./model";

const text = (t: string): AskReply => ({ content: [{ type: "text", text: t, citations: null }], stop_reason: "end_turn" });
const call = (name: string, input: Record<string, unknown>): AskReply => ({
  content: [{ type: "tool_use", id: `toolu_practice_${Math.random().toString(36).slice(2, 10)}`, name, input }],
  stop_reason: "tool_use",
});

function lastUserText(messages: AskMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text") return t.text;
  }
  return "";
}

/** The results of the tools asked for in the last step, if that is where the conversation stands. */
function pendingResults(messages: AskMessage[]): string[] | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string") return null;
  const results = last.content.filter((b) => b.type === "tool_result");
  if (!results.length) return null;
  return results.map((r) => (r.type !== "tool_result" ? "" : typeof r.content === "string" ? r.content : (r.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("")));
}

const cellText = (v: unknown) => (v === null || v === undefined ? "—" : String(v).replace(/\|/g, "/"));

function describe(result: string): string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(result) as Record<string, unknown>;
  } catch {
    return result;
  }
  if (typeof data.error === "string") return `I could not get that: ${data.error}`;
  if (Array.isArray(data.columns) && Array.isArray(data.rows)) {
    const columns = data.columns as string[];
    const rows = data.rows as unknown[][];
    if (!rows.length) return "I found nothing for that in the records you can see.";
    if (rows.length === 1 && columns.length === 1) return `**${columns[0]}**: ${cellText(rows[0]![0])}`;
    const head = `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |`;
    const body = rows.slice(0, 30).map((r) => `| ${r.map(cellText).join(" | ")} |`).join("\n");
    return `Here is what the records show (${rows.length} ${rows.length === 1 ? "row" : "rows"}):\n\n${head}\n${body}`;
  }
  if (Array.isArray(data.passages)) {
    const passages = data.passages as { title: string; reference?: string | null; text: string }[];
    if (!passages.length) return "The Board's documents here do not cover that.";
    const p = passages[0]!;
    return `From **${p.title}**${p.reference ? ` (${p.reference})` : ""}:\n\n${p.text}`;
  }
  return result;
}

export const scriptedModel: AskModel = {
  id: "practice",
  async reply({ messages, onText }) {
    const say = (t: string) => {
      onText?.(t);
      return text(t);
    };
    const results = pendingResults(messages);
    if (results) return say(results.map(describe).join("\n\n"));

    const q = lastUserText(messages).trim();
    const lower = q.toLowerCase();
    if (lower.startsWith("sql:")) return call("run_sql", { sql: q.slice(4).trim(), purpose: "Practice statement" });
    if (/leave balance|छुट्टी|अवकाश/.test(lower)) {
      return call("run_sql", { sql: "SELECT leave_code, balance_days, pending_days FROM leave_balances WHERE employee_id = (SELECT employee_id FROM me) ORDER BY leave_code", purpose: "Your leave balances" });
    }
    if (/salary|payslip|net pay|वेतन/.test(lower)) {
      return call("run_sql", {
        sql: "SELECT month, gross, deductions, net FROM payslips WHERE employee_id = (SELECT employee_id FROM me) AND run_kind = 'REGULAR' ORDER BY month DESC LIMIT 3",
        purpose: "Your last three payslips",
      });
    }
    if (/how many (employees|people|staff)/.test(lower)) {
      return call("run_sql", { sql: "SELECT count(*) AS people_on_the_rolls FROM employees WHERE status IN ('ACTIVE', 'SUSPENDED')", purpose: "People on the rolls" });
    }
    if (/policy|rule|order|circular|नीति|नियम/.test(lower)) return call("search_documents", { query: q });
    return say("This is a practice copy without a language model, so I only know a few fixed questions: your leave balance, your salary, how many employees there are, and the Board's policies. Start a line with \"sql:\" to run a statement.");
  },
};
