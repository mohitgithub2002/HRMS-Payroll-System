/**
 * Ask AI: a stand-in for the AI service that follows a few fixed rules. It lets the browser checks and practice
 * copies without an API key go through the real path — the guard, the read-only role, the person's pass — with
 * answers that are the same every time. It is never used on a production copy (config.ts).
 *
 * What it understands:
 *   "sql: <statement>"            runs the statement (handy for showing what a login can and cannot read)
 *   "… leave … left / balance …"  the person's own leave balances
 *   "… salary / payslip / pay …"  the person's own last three payslips
 *   "… how many employees …"      people on the rolls the person can see
 *   "… policy / rule / order …"   searches the Board's documents
 */
import type { AskModel, AskReply, AskTurn } from "./model";

const text = (t: string): AskReply => ({ text: t, calls: [], stop: "end", raw: { provider: "scripted", data: null } });
const call = (name: string, input: Record<string, unknown>): AskReply => ({
  text: "",
  calls: [{ id: `practice_${Math.random().toString(36).slice(2, 10)}`, name, input }],
  stop: "tools",
  raw: { provider: "scripted", data: null },
});

function lastUserText(turns: AskTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.role === "user") return t.text;
  }
  return "";
}

/** The results of the tools asked for in the last step, if that is where the conversation stands. */
function pendingResults(turns: AskTurn[]): string[] | null {
  const last = turns[turns.length - 1];
  return last?.role === "tool" && last.results.length ? last.results.map((r) => r.content) : null;
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
  async reply({ turns, onText }) {
    const say = (t: string) => {
      onText?.(t);
      return text(t);
    };
    const results = pendingResults(turns);
    if (results) return say(results.map(describe).join("\n\n"));

    const q = lastUserText(turns).trim();
    const lower = q.toLowerCase();
    if (lower.startsWith("sql:")) return call("run_sql", { sql: q.slice(4).trim(), purpose: "Practice statement" });
    if (/\bleave\b.*\b(balance|left|have)\b|छुट्टी बची|अवकाश शेष/.test(lower)) {
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
    if (/policy|rule|order|circular|allowed|can i |how do i |timing|नीति|नियम|आदेश/.test(lower)) return call("search_documents", { query: q });
    return say("This is a practice copy without a language model, so I only know a few fixed questions: your leave balance, your salary, how many employees there are, and the Board's policies. Start a line with \"sql:\" to run a statement.");
  },
};
