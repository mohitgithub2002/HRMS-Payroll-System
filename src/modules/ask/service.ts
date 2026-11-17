import "server-only";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { canUseAsk } from "@/lib/auth/access";
import type { Actor } from "@/lib/auth/session";
import { currentBoard } from "@/lib/board";
import { financialYear, todayIST } from "@/lib/dates";
import { db } from "@/lib/db";
import { AppError, forbidden, RateLimitError } from "@/lib/errors";
import type { TKey } from "@/lib/i18n";
import { hit, type Limit } from "@/lib/rate-limit";
import { ensureCredits } from "@/modules/leave/balance";
import { getSetting } from "@/modules/settings/service";
import { knowledgeTitles, readKnowledge, searchKnowledge } from "./knowledge";
import { askConfigured, askIsPractice, askModel, type AskMessage, type AskModel, type AskTool } from "./model";
import { buildSystemPrompt } from "./prompt";
import { runAskSql, type AskCell, type AskColumnOut } from "./runner";
import { askScope, type AskScope } from "./scope";

/**
 * Ask AI: one question, start to finish.
 *
 * The person's reach is worked out from their login (scope.ts) — never from anything the model or the browser says.
 * The model may then ask for SELECT statements and document searches; each one is checked and run with that reach
 * (runner.ts, knowledge.ts) and the result goes back to the model, which writes the answer. Every question is written
 * to the audit trail with the statements that were run (not their results).
 */
export const MAX_QUESTION = 2000;
const MAX_MODEL_TURNS = 8;
const MAX_TOOL_CALLS = 12;
const MAX_RESULT_CHARS = 14_000;
/** Per person: enough for a working session, not for emptying the records row by row. */
const ASK_LIMIT: Limit = { max: 30, windowMs: 10 * 60 * 1000 };

export const askInputSchema = z.object({
  question: z.string().trim().min(2, "validation.tooShort").max(MAX_QUESTION),
  /** Earlier turns of this conversation, kept by the browser. They are context for the model and nothing more. */
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) }))
    .max(12)
    .optional()
    .default([]),
});
export type AskInput = z.infer<typeof askInputSchema>;

export type AskStep =
  | { kind: "sql"; purpose: string; sql: string; ok: true; rows: number; truncated: boolean; views: string[] }
  | { kind: "sql"; purpose: string; sql: string; ok: false; reason: string }
  | { kind: "documents"; query: string; found: string[] };

/** A result worth showing as a table under the answer: the last statement that returned rows. */
export interface AskTable {
  columns: AskColumnOut[];
  rows: AskCell[][];
  truncated: boolean;
}

export type AskEvent =
  | { type: "working"; what: "thinking" | "records" | "documents"; note?: string }
  | { type: "text"; delta: string }
  /** What was written so far was a remark before a look-up, not the answer. */
  | { type: "clear" }
  | { type: "step"; step: AskStep }
  | { type: "done"; answer: string; steps: AskStep[]; table: AskTable | null }
  /** `key` is a line of the dictionary (ask.errors.…); the API sends it translated. */
  | { type: "error"; key: TKey; code: string };

const TOOLS: AskTool[] = [
  {
    name: "run_sql",
    description:
      "Run one read-only PostgreSQL SELECT over the views described in the instructions and get the rows back as JSON ({ columns, rows, row_count, truncated }). " +
      "Use it for every fact about the Board's records. A refusal or a database error comes back as { error } — correct the statement, or tell the person when the error says the information is not available to them.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "One SELECT statement (WITH … SELECT allowed). Views are named without a schema." },
        purpose: { type: "string", description: "A few plain words on what this looks up, shown to the person under the answer — for example \"Leave taken in October 2026\"." },
      },
      required: ["sql", "purpose"],
      additionalProperties: false,
    },
  },
  {
    name: "search_documents",
    description:
      "Search the Board's own documents (policies, office orders, circulars, how-to notes) that this person may read. Returns the best passages with the document's title and number. " +
      "Use it for questions about rules, entitlements and procedures. Search with the words the document would use, in English or Hindi.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "The words to look for." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_document",
    description: "Read one whole document of the Board by the id shown in the instructions or in a search result, when a passage is not enough.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "The document id." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

const sqlInput = z.object({ sql: z.string().min(1).max(20_000), purpose: z.string().max(300).optional().default("") });
const searchInput = z.object({ query: z.string().min(1).max(500) });
const readInput = z.object({ id: z.string().min(1).max(60) });

/** What the screen needs to know before the first question. */
export async function askStatus(actor: Actor) {
  const audience = (await getSetting(actor.boardId, "ask")).audience;
  return { allowed: canUseAsk(actor, audience), configured: askConfigured(), practice: askIsPractice(), audience };
}

/** Rows as the model reads them: whole rows only, as many as fit. */
function resultForModel(columns: AskColumnOut[], rows: AskCell[][], truncated: boolean): string {
  const names = columns.map((c) => c.name);
  let shown = rows;
  let body = JSON.stringify({ columns: names, rows: shown, row_count: rows.length, truncated });
  while (body.length > MAX_RESULT_CHARS && shown.length > 1) {
    shown = shown.slice(0, Math.max(1, Math.floor(shown.length * 0.7)));
    body = JSON.stringify({
      columns: names,
      rows: shown,
      row_count: rows.length,
      rows_shown: shown.length,
      truncated: true,
      note: "Only the first rows are shown here. Ask for totals or a narrower list to see the rest.",
    });
  }
  return body;
}

export interface AskOptions {
  /** Tests pass their own model. */
  model?: AskModel;
  signal?: AbortSignal;
}

/**
 * Checks that the question may be asked at all — throws AppError when it may not (not allowed, not set up, too many
 * questions) — and returns the function that answers it, telling `emit` what is happening on the way. Whatever goes
 * wrong while answering is reported as an "error" event, not thrown.
 */
export async function startAsk(actor: Actor, raw: unknown, opts: AskOptions = {}): Promise<(emit: (e: AskEvent) => void) => Promise<void>> {
  const input = askInputSchema.parse(raw);
  const status = await askStatus(actor);
  if (!status.allowed) throw forbidden("ask.errors.notAllowed");
  if (!opts.model && !status.configured) throw new AppError(503, "ask_not_set_up", "ask.errors.notSetUp");
  const limited = hit(`ask:${actor.userId}`, ASK_LIMIT);
  if (!limited.ok) throw new RateLimitError(limited.retryAfterS);
  return (emit) => answer(actor, input, emit, opts);
}

/** One question, start to finish (tests and scripts; the API streams through startAsk). */
export async function ask(actor: Actor, raw: unknown, emit: (e: AskEvent) => void, opts: AskOptions = {}): Promise<void> {
  await (await startAsk(actor, raw, opts))(emit);
}

async function answer(actor: Actor, input: AskInput, emit: (e: AskEvent) => void, opts: AskOptions): Promise<void> {
  const model = opts.model ?? askModel();
  const scope: AskScope = askScope(actor);
  const started = Date.now();
  const steps: AskStep[] = [];
  let table: AskTable | null = null;
  let outcome: "answered" | "failed" | "stopped" = "failed";
  let modelName = model.id;

  try {
    // Leave credits due on 1 January and 1 July are posted the first time leave is looked at, as on the leave screens.
    if (scope.reach.leave !== "none") await ensureCredits(actor.boardId).catch(() => undefined);
    const [board, documents, me] = await Promise.all([
      currentBoard(),
      knowledgeTitles(actor),
      scope.employeeId ? db.employee.findUnique({ where: { id: scope.employeeId }, select: { employeeCode: true, section: { select: { name: true } } } }) : null,
    ]);
    const today = todayIST();
    const system = buildSystemPrompt({
      boardName: board.name,
      today,
      financialYear: financialYear(today),
      user: {
        name: actor.name,
        loginId: actor.loginId,
        loginLabel: actor.isPensioner && !actor.isEmployee ? "Pensioner" : actor.loginType === "ADMIN" ? "Admin" : actor.loginType === "HR_ACCOUNTS" ? "HR & Accounts" : "Employee",
        employeeCode: me?.employeeCode ?? null,
        sectionName: me?.section.name ?? null,
        language: actor.language,
      },
      scope,
      documents,
    });

    const messages: AskMessage[] = [...input.history.filter((h) => h.text.trim()).map((h) => ({ role: h.role, content: h.text })), { role: "user", content: input.question }];
    let toolCalls = 0;

    for (let turn = 1; turn <= MAX_MODEL_TURNS; turn++) {
      emit({ type: "working", what: "thinking" });
      let wrote = false;
      const reply = await model.reply({
        system,
        tools: TOOLS,
        messages,
        signal: opts.signal,
        onText: (delta) => {
          wrote = true;
          emit({ type: "text", delta });
        },
      });
      if (reply.model) modelName = reply.model;
      const text = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      const calls = reply.content.filter((b) => b.type === "tool_use");

      // A refusal or a cut-off reply can leave a tool call half-written: never run the tools of such a turn.
      if (reply.stop_reason === "refusal") {
        outcome = "stopped";
        emit({ type: "error", code: "declined", key: "ask.errors.declined" });
        return;
      }
      if (reply.stop_reason === "max_tokens" && calls.length) throw new AppError(502, "ask_model_error", "ask.errors.failed");

      if (reply.stop_reason !== "tool_use" || !calls.length) {
        if (!text) throw new AppError(502, "ask_model_error", "ask.errors.failed");
        outcome = "answered";
        emit({ type: "done", answer: text, steps, table });
        return;
      }

      if (wrote) emit({ type: "clear" });
      messages.push({ role: "assistant", content: reply.content });

      const results: Extract<AskMessage["content"], unknown[]>[number][] = [];
      for (const c of calls) {
        toolCalls += 1;
        let content: string;
        let isError = false;
        if (toolCalls > MAX_TOOL_CALLS) {
          content = JSON.stringify({ error: "No more look-ups are left for this question. Answer with what you have and say what is missing." });
          isError = true;
        } else if (c.name === "run_sql") {
          const parsed = sqlInput.safeParse(c.input);
          if (!parsed.success) {
            content = JSON.stringify({ error: "The tool input was not valid. Send { sql, purpose }." });
            isError = true;
          } else {
            emit({ type: "working", what: "records", note: parsed.data.purpose });
            const out = await runAskSql(scope, parsed.data.sql);
            if (out.ok) {
              const step: AskStep = { kind: "sql", purpose: parsed.data.purpose, sql: out.sql, ok: true, rows: out.rows.length, truncated: out.truncated, views: out.views };
              steps.push(step);
              emit({ type: "step", step });
              // A list is also shown as a table under the answer, straight from the database.
              if (out.rows.length > 1) table = { columns: out.columns, rows: out.rows, truncated: out.truncated };
              content = resultForModel(out.columns, out.rows, out.truncated);
            } else {
              const step: AskStep = { kind: "sql", purpose: parsed.data.purpose, sql: out.sql, ok: false, reason: out.reason };
              steps.push(step);
              emit({ type: "step", step });
              content = JSON.stringify({ error: out.reason });
              isError = true;
            }
          }
        } else if (c.name === "search_documents") {
          const parsed = searchInput.safeParse(c.input);
          if (!parsed.success) {
            content = JSON.stringify({ error: "The tool input was not valid. Send { query }." });
            isError = true;
          } else {
            emit({ type: "working", what: "documents", note: parsed.data.query });
            const passages = await searchKnowledge(actor, parsed.data.query);
            const step: AskStep = { kind: "documents", query: parsed.data.query, found: [...new Set(passages.map((p) => p.title))] };
            steps.push(step);
            emit({ type: "step", step });
            content = JSON.stringify({ passages: passages.map((p) => ({ id: p.docId, title: p.title, reference: p.reference, category: p.category, part: `${p.part} of ${p.parts}`, text: p.text })) });
          }
        } else if (c.name === "read_document") {
          const parsed = readInput.safeParse(c.input);
          const doc = parsed.success ? await readKnowledge(actor, parsed.data.id) : null;
          if (!doc) {
            content = JSON.stringify({ error: "There is no such document for this person." });
            isError = true;
          } else {
            emit({ type: "working", what: "documents", note: doc.title });
            const step: AskStep = { kind: "documents", query: doc.title, found: [doc.title] };
            steps.push(step);
            emit({ type: "step", step });
            content = JSON.stringify({ id: doc.id, title: doc.title, reference: doc.reference, category: doc.category, text: doc.body, ...(doc.cut ? { note: "Only the first part of this long document is shown." } : {}) });
          }
        } else {
          content = JSON.stringify({ error: `There is no tool called ${c.name}.` });
          isError = true;
        }
        results.push({ type: "tool_result", tool_use_id: c.id, content, ...(isError ? { is_error: true } : {}) });
      }
      // All results of one step go back together. On the last step allowed, say so.
      if (turn === MAX_MODEL_TURNS - 1) results.push({ type: "text", text: "This is the last look-up for this question. Answer now with what you have, and say what you could not find." });
      messages.push({ role: "user", content: results });
    }
    throw new AppError(502, "ask_too_long", "ask.errors.tooLong");
  } catch (e) {
    if (opts.signal?.aborted) {
      outcome = "stopped";
      return;
    }
    const appError = e instanceof AppError ? e : null;
    if (!appError) console.error("[ask] question failed", e);
    emit({ type: "error", code: appError?.code ?? "server_error", key: appError?.key ?? "ask.errors.failed" });
  } finally {
    // The question and the statements that were run — never the rows that came back.
    await audit(
      db,
      { ...actor, name: actor.name },
      {
        action: "ASK",
        entityType: "AskAI",
        summary: `Asked: ${input.question.replace(/\s+/g, " ").slice(0, 200)}`,
        newValue: {
          question: input.question,
          outcome,
          model: modelName,
          ms: Date.now() - started,
          reach: scope.reach,
          steps: steps.map((s) => (s.kind === "sql" ? { sql: s.sql, ...(s.ok ? { rows: s.rows, views: s.views } : { refused: s.reason }) } : { documents: s.query, found: s.found })),
        },
      },
    ).catch((err) => console.error("[ask] could not write the audit entry", err));
  }
}
