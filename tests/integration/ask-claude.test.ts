import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetLimits } from "@/lib/rate-limit";
import { askConfigured, askModel, DEFAULT_ASK_MODEL } from "@/modules/ask/model";
import { closeAskPool } from "@/modules/ask/runner";
import { ask, type AskEvent } from "@/modules/ask/service";
import { actorFor, hasTestDb, makeBoard, makeEmployee, makeUser } from "../support/factory";

/**
 * Ask AI through the real Anthropic SDK, against a local server that speaks the Messages streaming protocol: what the
 * application sends (model, tools, instructions, the tool result of the step before) and that a streamed tool call and
 * a streamed answer are read correctly. Whether the live API accepts the request is checked with a real key
 * (docs/DEPLOYMENT.md) — nothing here leaves the machine.
 */
describe.skipIf(!hasTestDb)("Ask AI — the Claude adapter", () => {
  type Body = { model: string; max_tokens: number; stream: boolean; system: unknown; tools: { name: string }[]; messages: { role: string; content: unknown }[]; thinking?: unknown; output_config?: unknown; fallbacks?: unknown; cache_control?: unknown };
  const requests: { headers: http.IncomingHttpHeaders; body: Body }[] = [];
  let server: http.Server;
  const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, provider: process.env.ASK_AI_PROVIDER, model: process.env.ASK_AI_MODEL };

  const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const start = { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } } };
  const toolTurn = (sql: string) => {
    const json = JSON.stringify({ sql, purpose: "Your own record" });
    return sse([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me look." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_test_1", name: "run_sql", input: {} } },
      // The input arrives in pieces, as it does from the API.
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(0, 15) } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(15) } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } },
      { type: "message_stop" },
    ]);
  };
  const textTurn = (parts: string[]) =>
    sse([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ...parts.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ]);

  let reply: (n: number) => { status: number; body: string };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        requests.push({ headers: req.headers, body: JSON.parse(raw || "{}") as Body });
        const r = reply(requests.length);
        res.writeHead(r.status, r.status === 200 ? { "content-type": "text/event-stream" } : { "content-type": "application/json" });
        res.end(r.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    delete process.env.ASK_AI_PROVIDER;
    delete process.env.ASK_AI_MODEL;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeAskPool();
    const put = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    put("ANTHROPIC_API_KEY", saved.key);
    put("ANTHROPIC_BASE_URL", saved.base);
    put("ASK_AI_PROVIDER", saved.provider);
    put("ASK_AI_MODEL", saved.model);
  });

  it("is set up by an API key on the server, and asks Claude Opus 5.5 unless told otherwise", () => {
    expect(askConfigured()).toBe(true);
    expect(askModel().id).toBe(DEFAULT_ASK_MODEL);
    expect(DEFAULT_ASK_MODEL).toBe("claude-opus-5-5");
  });

  it("streams a tool call, runs it with the person's reach, sends the result back and streams the answer", async () => {
    resetLimits();
    const board = await makeBoard();
    const e = await makeEmployee(board.id);
    const actor = await actorFor((await makeUser(board.id, "EMPLOYEE", [], e.id)).id);
    requests.length = 0;
    reply = (n) => ({ status: 200, body: n === 1 ? toolTurn("SELECT employee_code FROM employees") : textTurn(["Your employee ID is ", `**${e.employeeCode}**.`]) });

    const events: AskEvent[] = [];
    await ask(actor, { question: "What is my employee ID?", history: [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hello. How can I help?" }] }, (ev) => events.push(ev));

    const done = events.find((ev) => ev.type === "done") as Extract<AskEvent, { type: "done" }>;
    expect(done.answer).toBe(`Your employee ID is **${e.employeeCode}**.`);
    expect(done.steps).toEqual([{ kind: "sql", purpose: "Your own record", sql: "SELECT employee_code FROM employees", ok: true, rows: 1, truncated: false, views: ["employees"] }]);
    // The remark before the look-up was shown, then cleared; the answer arrived in pieces.
    const kinds = events.map((ev) => ev.type);
    expect(kinds.indexOf("clear")).toBeGreaterThan(kinds.indexOf("text"));
    expect(events.filter((ev) => ev.type === "text").map((ev) => (ev as { delta: string }).delta).join("")).toBe(`Let me look.Your employee ID is **${e.employeeCode}**.`);

    // What was sent.
    expect(requests.length).toBe(2);
    const [first, second] = requests as [(typeof requests)[number], (typeof requests)[number]];
    expect(first.headers.authorization).toBe("Bearer test-key-not-real");
    expect(String(first.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(first.body).toMatchObject({ model: "claude-opus-5-5", stream: true, max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "medium" }, fallbacks: "default", cache_control: { type: "ephemeral" } });
    expect(first.body.tools.map((t) => t.name)).toEqual(["run_sql", "search_documents", "read_document"]);
    expect(String(first.body.system)).toContain(`Employee ID: ${e.employeeCode}`);
    expect(String(first.body.system)).toContain("salary and payslips: their own record only");
    expect(first.body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(first.body.messages[2]!.content).toBe("What is my employee ID?");
    // The second request carries the model's own turn unchanged and one tool result: the person's own row.
    expect(second.body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    const assistant = second.body.messages[3]!.content as { type: string; id?: string; input?: unknown }[];
    expect(assistant.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(assistant[1]!.input).toEqual({ sql: "SELECT employee_code FROM employees", purpose: "Your own record" });
    const results = second.body.messages[4]!.content as { type: string; tool_use_id: string; content: string }[];
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_test_1" });
    expect(JSON.parse(results[0]!.content)).toEqual({ columns: ["employee_code"], rows: [[e.employeeCode]], row_count: 1, truncated: false });
    // Nothing that identifies the database or another person went out.
    const sent = JSON.stringify(requests.map((r) => r.body));
    expect(sent).not.toContain("postgresql://");
    expect(sent).not.toMatch(/"AskGrant"|ask\.token/);
    expect((await db.auditLog.findFirst({ where: { action: "ASK", userId: actor.userId }, orderBy: { id: "desc" } }))?.newValue).toMatchObject({ outcome: "answered", model: "claude-opus-5-5" });
  });

  it("tells the person in plain words when the key is refused or the service is busy", async () => {
    resetLimits();
    const board = await makeBoard();
    const actor = await actorFor((await makeUser(board.id, "EMPLOYEE", [], (await makeEmployee(board.id)).id)).id);
    const errorOf = async (status: number, type: string) => {
      requests.length = 0;
      reply = () => ({ status, body: JSON.stringify({ type: "error", error: { type, message: "no" } }) });
      const events: AskEvent[] = [];
      await ask(actor, { question: "Hello?" }, (ev) => events.push(ev));
      return events.find((ev) => ev.type === "error") as Extract<AskEvent, { type: "error" }>;
    };
    expect((await errorOf(401, "authentication_error")).key).toBe("ask.errors.notSetUp");
    expect((await errorOf(400, "invalid_request_error")).key).toBe("ask.errors.failed");
    expect((await errorOf(429, "rate_limit_error")).key).toBe("ask.errors.busy");
    expect((await db.auditLog.findFirst({ where: { action: "ASK", userId: actor.userId }, orderBy: { id: "desc" } }))?.newValue).toMatchObject({ outcome: "failed" });
  }, 60_000);
});
