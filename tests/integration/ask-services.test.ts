import http from "node:http";
import type { AddressInfo } from "node:net";
import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetLimits } from "@/lib/rate-limit";
import { askConfig, askModelFor, removeAskKey, setAskKey, testAskService } from "@/modules/ask/config";
import { DEFAULT_ASK_MODELS, DEFAULT_ASK_PROVIDER } from "@/modules/ask/model";
import { closeAskPool } from "@/modules/ask/runner";
import { ask, askStatus, type AskEvent } from "@/modules/ask/service";
import { exportAllData } from "@/modules/migration/export";
import { SETTING_DEFAULTS } from "@/modules/settings/schema";
import { getSetting, updateSetting } from "@/modules/settings/service";
import { actorFor, hasTestDb, makeBoard, makeEmployee, makeUser } from "../support/factory";

type Actor = Awaited<ReturnType<typeof actorFor>>;

/**
 * Ask AI and its three AI services — Gemini (the default), GPT and Claude — through the official SDK of each, against
 * a local server that speaks each service's streaming protocol: what the application sends (the key, the model, the
 * instructions, the tools, the result of the step before, the service's own turn handed back unchanged) and that a
 * streamed tool call and a streamed answer are read correctly. Also: choosing the service in Settings, and keys saved
 * encrypted. Whether a live service accepts the request is checked with a real key (Settings → Ask → Test) — nothing
 * here leaves the machine.
 */
describe.skipIf(!hasTestDb)("Ask AI — the AI services (Gemini, GPT, Claude)", () => {
  type Seen = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
  const requests: Seen[] = [];
  let server: http.Server;
  let respond: (req: Seen, n: number) => { status: number; body: string };
  const ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "ASK_AI_PROVIDER"] as const;
  const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  let boardId: string;
  let employee: Actor;
  let employeeCode: string;
  let admin: Actor;
  let itSupport: Actor;
  let hr: Actor;

  const sse = (events: Record<string, unknown>[], named = true) => events.map((e) => `${named ? `event: ${String(e.type)}\n` : ""}data: ${JSON.stringify(e)}\n\n`).join("");
  const SQL = "SELECT employee_code FROM employees";
  const input = { sql: SQL, purpose: "Your own record" };

  // ── What each service streams back ──────────────────────────────────────────────────────────────────────────────
  const gemini = {
    tool: () =>
      sse(
        [
          { candidates: [{ content: { role: "model", parts: [{ text: "Let me look." }] } }], modelVersion: "gemini-3.8-flash" },
          { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "run_sql", args: input }, thoughtSignature: "c2lnbmF0dXJl" }] }, finishReason: "STOP" }], modelVersion: "gemini-3.8-flash", usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 20 } },
        ],
        false,
      ),
    text: (parts: string[]) => sse([...parts.map((text, i) => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, ...(i === parts.length - 1 ? { finishReason: "STOP" } : {}) }], modelVersion: "gemini-3.8-flash" }))], false),
  };

  const oaResponse = (status: string, output: unknown[]) => ({ id: "resp_test", object: "response", created_at: 1, status, model: "gpt-5.5", output, parallel_tool_calls: true, tools: [], tool_choice: "auto", error: null, incomplete_details: null, instructions: null, metadata: {}, temperature: null, top_p: null });
  const openai = {
    tool: () => {
      const reasoning = { type: "reasoning", id: "rs_test_1", summary: [], encrypted_content: "ZW5jcnlwdGVk" };
      const call = { type: "function_call", id: "fc_test_1", call_id: "call_test_1", name: "run_sql", arguments: JSON.stringify(input), status: "completed" };
      return sse([
        { type: "response.created", sequence_number: 0, response: oaResponse("in_progress", []) },
        { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...reasoning } },
        { type: "response.output_item.done", sequence_number: 2, output_index: 0, item: reasoning },
        { type: "response.output_item.added", sequence_number: 3, output_index: 1, item: { ...call, arguments: "", status: "in_progress" } },
        { type: "response.function_call_arguments.delta", sequence_number: 4, item_id: "fc_test_1", output_index: 1, delta: call.arguments.slice(0, 12) },
        { type: "response.function_call_arguments.delta", sequence_number: 5, item_id: "fc_test_1", output_index: 1, delta: call.arguments.slice(12) },
        { type: "response.function_call_arguments.done", sequence_number: 6, item_id: "fc_test_1", output_index: 1, name: "run_sql", arguments: call.arguments },
        { type: "response.output_item.done", sequence_number: 7, output_index: 1, item: call },
        { type: "response.completed", sequence_number: 8, response: oaResponse("completed", [reasoning, call]) },
      ]);
    },
    text: (parts: string[]) => {
      const full = parts.join("");
      const message = (text: string, status: string) => ({ type: "message", id: "msg_test_1", role: "assistant", status, content: [{ type: "output_text", text, annotations: [], logprobs: [] }] });
      return sse([
        { type: "response.created", sequence_number: 0, response: oaResponse("in_progress", []) },
        { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { type: "message", id: "msg_test_1", role: "assistant", status: "in_progress", content: [] } },
        { type: "response.content_part.added", sequence_number: 2, item_id: "msg_test_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } },
        ...parts.map((delta, i) => ({ type: "response.output_text.delta", sequence_number: 3 + i, item_id: "msg_test_1", output_index: 0, content_index: 0, delta, logprobs: [] })),
        { type: "response.output_text.done", sequence_number: 20, item_id: "msg_test_1", output_index: 0, content_index: 0, text: full, logprobs: [] },
        { type: "response.content_part.done", sequence_number: 21, item_id: "msg_test_1", output_index: 0, content_index: 0, part: { type: "output_text", text: full, annotations: [], logprobs: [] } },
        { type: "response.output_item.done", sequence_number: 22, output_index: 0, item: message(full, "completed") },
        { type: "response.completed", sequence_number: 23, response: oaResponse("completed", [message(full, "completed")]) },
      ]);
    },
  };

  const claudeStart = { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } } };
  const claude = {
    tool: () => {
      const json = JSON.stringify(input);
      return sse([
        claudeStart,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me look." } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_test_1", name: "run_sql", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(0, 15) } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(15) } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } },
        { type: "message_stop" },
      ]);
    },
    text: (parts: string[]) =>
      sse([
        claudeStart,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        ...parts.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
        { type: "message_stop" },
      ]),
  };

  const serviceOf = (path: string) => (/generatecontent/i.test(path) ? "gemini" : path.includes("/responses") ? "openai" : path.includes("/messages") ? "claude" : "unknown");
  /** The usual conversation: a look-up first, then the answer in two pieces. */
  const converse = (answer: string[]) => (req: Seen, n: number) => {
    const s = serviceOf(req.path);
    const lib = s === "gemini" ? gemini : s === "openai" ? openai : claude;
    return { status: 200, body: n === 1 ? lib.tool() : lib.text(answer) };
  };

  const question = async (actor: Actor, text: string) => {
    const events: AskEvent[] = [];
    await ask(actor, { question: text }, (e) => events.push(e));
    return { events, done: events.find((e) => e.type === "done") as Extract<AskEvent, { type: "done" }> | undefined, error: events.find((e) => e.type === "error") as Extract<AskEvent, { type: "error" }> | undefined };
  };
  const setService = (provider: "gemini" | "openai" | "claude", models = SETTING_DEFAULTS.ask.models) => updateSetting(admin, "ask", { audience: "everyone", provider, models });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const seen: Seen = { path: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> };
        requests.push(seen);
        const r = respond(seen, requests.length);
        res.writeHead(r.status, { "content-type": r.status === 200 ? "text/event-stream" : "application/json" });
        res.end(r.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const k of ENV) delete process.env[k];
    process.env.ANTHROPIC_BASE_URL = base;
    process.env.GOOGLE_GEMINI_BASE_URL = base;
    process.env.OPENAI_BASE_URL = `${base}/v1`;

    const board = await makeBoard();
    boardId = board.id;
    const e = await makeEmployee(boardId);
    employeeCode = e.employeeCode!;
    employee = await actorFor((await makeUser(boardId, "EMPLOYEE", [], e.id)).id);
    admin = await actorFor((await makeUser(boardId, "ADMIN", ["APPROVER"])).id);
    itSupport = await actorFor((await makeUser(boardId, "ADMIN", ["USER_SETTINGS_MANAGER"])).id);
    hr = await actorFor((await makeUser(boardId, "HR_ACCOUNTS", ["HR"])).id);
    await db.setting.deleteMany({ where: { boardId, key: { in: ["ask", "askKeys"] } } });
  });

  beforeEach(() => {
    resetLimits();
    requests.length = 0;
  });

  afterAll(async () => {
    await db.setting.deleteMany({ where: { boardId, key: { in: ["ask", "askKeys"] } } });
    await new Promise((resolve) => server.close(resolve));
    await closeAskPool();
    for (const k of ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("Gemini is the default service; without a key Ask is not set up and nothing is sent", async () => {
    expect(DEFAULT_ASK_PROVIDER).toBe("gemini");
    expect(await getSetting(boardId, "ask")).toEqual({ audience: "everyone", provider: "gemini", models: { gemini: "gemini-3.8-flash", openai: "gpt-5.5", claude: "claude-opus-5-5" } });
    expect(SETTING_DEFAULTS.ask.models).toEqual(DEFAULT_ASK_MODELS);
    const config = await askConfig(boardId);
    expect(config).toMatchObject({ provider: "gemini", ready: false, practice: false });
    expect(config.services.map((s) => [s.provider, s.source])).toEqual([["gemini", "none"], ["openai", "none"], ["claude", "none"]]);
    expect(await askStatus(employee)).toMatchObject({ allowed: true, configured: false });
    await expect(question(employee, "Hello?")).rejects.toMatchObject({ status: 503 });
    expect(requests.length).toBe(0);
  });

  it("a key is set by the Admin or IT support only, saved encrypted, never read back, and audited without its value", async () => {
    const key = "AIza-test-gemini-key-0001";
    await expect(setAskKey(employee, "gemini", { key })).rejects.toMatchObject({ status: 403 });
    await expect(setAskKey(hr, "gemini", { key })).rejects.toMatchObject({ status: 403 });
    await expect(setAskKey(itSupport, "gemini", { key: "short" })).rejects.toThrow();
    expect(await setAskKey(itSupport, "gemini", { key })).toEqual({ provider: "gemini", source: "settings", hint: "0001" });

    const row = await db.setting.findUniqueOrThrow({ where: { boardId_key: { boardId, key: "askKeys" } } });
    expect(JSON.stringify(row.value)).not.toContain(key);
    expect((row.value as { gemini: { enc: string } }).gemini.enc).toMatch(/^v1\./);
    const config = await askConfig(boardId);
    expect(config.ready).toBe(true);
    expect(config.services[0]).toMatchObject({ provider: "gemini", source: "settings", hint: "0001", savedBy: itSupport.name });
    expect(JSON.stringify(config)).not.toContain(key);

    const entry = await db.auditLog.findFirstOrThrow({ where: { boardId, entityType: "Setting", entityId: "ask.key.gemini", userId: itSupport.userId }, orderBy: { id: "desc" } });
    expect(entry).toMatchObject({ category: "SYSTEM", summary: "Set the Gemini key for Ask" });
    expect(`${entry.summary} ${JSON.stringify(entry.oldValue)} ${JSON.stringify(entry.newValue)}`).not.toContain(key);
    expect(entry.newValue).toEqual({ endsWith: "0001" });

    // The settings screen's own API knows nothing of the keys row, and the full data export leaves it out.
    expect(Object.keys(await getSetting(boardId, "ask")).sort()).toEqual(["audience", "models", "provider"]);
    const zip = await JSZip.loadAsync((await exportAllData(admin)).buffer);
    const settings = await zip.file("json/Setting.json")!.async("string");
    expect(settings).not.toContain("askKeys");
    expect(settings).not.toContain((row.value as { gemini: { enc: string } }).gemini.enc);
  }, 60_000);

  it("Gemini: sends the saved key and the question, runs the look-up with the person's reach, hands Gemini's turn back unchanged", async () => {
    respond = converse(["Your employee ID is ", `**${employeeCode}**.`]);
    const { done, events } = await question(employee, "What is my employee ID?");
    expect(done?.answer).toBe(`Your employee ID is **${employeeCode}**.`);
    expect(done?.steps).toEqual([{ kind: "sql", purpose: "Your own record", sql: SQL, ok: true, rows: 1, truncated: false, views: ["employees"] }]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe(`Let me look.Your employee ID is **${employeeCode}**.`);

    expect(requests.length).toBe(2);
    const [first, second] = requests as [Seen, Seen];
    expect(first.path).toContain("models/gemini-3.8-flash:streamGenerateContent");
    expect(first.headers["x-goog-api-key"]).toBe("AIza-test-gemini-key-0001");
    expect(first.path).not.toContain("AIza");
    const body = first.body as { contents: { role: string; parts: Record<string, unknown>[] }[]; systemInstruction: unknown; tools: { functionDeclarations: { name: string; parametersJsonSchema?: unknown }[] }[] };
    expect(JSON.stringify(body.systemInstruction)).toContain(`Employee ID: ${employeeCode}`);
    expect(JSON.stringify(body.systemInstruction)).toContain("salary and payslips: their own record only");
    expect(body.tools[0]!.functionDeclarations.map((f) => f.name)).toEqual(["run_sql", "search_documents", "read_document"]);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "What is my employee ID?" }] }]);

    const contents = (second.body as typeof body).contents;
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    // The model's parts, signature of its reasoning included, exactly as they came.
    expect(contents[1]!.parts).toEqual([{ text: "Let me look." }, { functionCall: { name: "run_sql", args: input }, thoughtSignature: "c2lnbmF0dXJl" }]);
    expect(contents[2]!.parts).toEqual([{ functionResponse: { name: "run_sql", response: { columns: ["employee_code"], rows: [[employeeCode]], row_count: 1, truncated: false } } }]);
    expect((await db.auditLog.findFirst({ where: { action: "ASK", userId: employee.userId }, orderBy: { id: "desc" } }))?.newValue).toMatchObject({ outcome: "answered", model: "gemini:gemini-3.8-flash" });
  });

  it("GPT: chosen in Settings with its own key and model — the Responses API, reasoning carried along, nothing stored", async () => {
    await setAskKey(admin, "openai", { key: "sk-test-openai-key-0002" });
    await setService("openai", { ...SETTING_DEFAULTS.ask.models, openai: "gpt-5.5-pro" });
    expect((await askModelFor(boardId)).id).toBe("openai:gpt-5.5-pro");
    respond = converse(["Your employee ID is ", `**${employeeCode}**.`]);
    const { done } = await question(employee, "What is my employee ID?");
    expect(done?.answer).toBe(`Your employee ID is **${employeeCode}**.`);
    expect(done?.steps[0]).toMatchObject({ kind: "sql", ok: true, rows: 1 });

    expect(requests.length).toBe(2);
    const [first, second] = requests as [Seen, Seen];
    expect(first.path).toBe("/v1/responses");
    expect(first.headers.authorization).toBe("Bearer sk-test-openai-key-0002");
    expect(first.body).toMatchObject({ model: "gpt-5.5-pro", stream: true, store: false, include: ["reasoning.encrypted_content"], input: [{ role: "user", content: "What is my employee ID?" }] });
    expect(String(first.body.instructions)).toContain(`Employee ID: ${employeeCode}`);
    expect((first.body.tools as { type: string; name: string }[]).map((t) => `${t.type}:${t.name}`)).toEqual(["function:run_sql", "function:search_documents", "function:read_document"]);
    const items = second.body.input as Record<string, unknown>[];
    expect(items.map((i) => i.type ?? i.role)).toEqual(["user", "reasoning", "function_call", "function_call_output"]);
    expect(items[1]).toMatchObject({ type: "reasoning", encrypted_content: "ZW5jcnlwdGVk" });
    expect(items[2]).toMatchObject({ type: "function_call", call_id: "call_test_1", name: "run_sql" });
    expect(items[3]).toMatchObject({ type: "function_call_output", call_id: "call_test_1" });
    expect(JSON.parse(String(items[3]!.output))).toEqual({ columns: ["employee_code"], rows: [[employeeCode]], row_count: 1, truncated: false });
  });

  it("Claude: chosen in Settings, its key from the server's environment when none is saved", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-0003";
    await setService("claude");
    const config = await askConfig(boardId);
    expect(config.services[2]).toMatchObject({ provider: "claude", source: "env", hint: "ANTHROPIC_API_KEY" });
    expect(config.ready).toBe(true);
    respond = converse(["Your employee ID is ", `**${employeeCode}**.`]);
    const { done } = await question(employee, "What is my employee ID?");
    expect(done?.answer).toBe(`Your employee ID is **${employeeCode}**.`);

    expect(requests.length).toBe(2);
    const [first, second] = requests as [Seen, Seen];
    expect(first.path).toContain("/v1/messages");
    expect(first.headers.authorization).toBe("Bearer sk-ant-test-key-0003");
    expect(String(first.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(first.body).toMatchObject({ model: "claude-opus-5-5", stream: true, max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "medium" }, fallbacks: "default", cache_control: { type: "ephemeral" } });
    expect((first.body.tools as { name: string }[]).map((t) => t.name)).toEqual(["run_sql", "search_documents", "read_document"]);
    const messages = second.body.messages as { role: string; content: { type: string; tool_use_id?: string; content?: string; input?: unknown }[] }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]!.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(messages[1]!.content[1]!.input).toEqual(input);
    expect(messages[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_test_1" });
    expect(JSON.parse(messages[2]!.content[0]!.content!)).toEqual({ columns: ["employee_code"], rows: [[employeeCode]], row_count: 1, truncated: false });

    // A key saved in Settings wins over the environment; removing it falls back again.
    await setAskKey(admin, "claude", { key: "sk-ant-saved-key-0004" });
    expect((await askConfig(boardId)).services[2]).toMatchObject({ source: "settings", hint: "0004" });
    requests.length = 0;
    respond = () => ({ status: 200, body: claude.text(["Hello."]) });
    await question(employee, "Hello");
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-ant-saved-key-0004");
    await removeAskKey(admin, "claude");
    expect((await askConfig(boardId)).services[2]).toMatchObject({ source: "env" });
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("nothing that identifies the database or another person goes to any service", async () => {
    for (const provider of ["gemini", "openai"] as const) {
      await setService(provider);
      requests.length = 0;
      respond = converse(["Done."]);
      await question(employee, "What is my employee ID?");
      const sent = JSON.stringify(requests.map((r) => r.body));
      expect(sent, provider).not.toContain("postgresql://");
      expect(sent, provider).not.toMatch(/"AskGrant"|ask\.token|dcb_ask/);
      expect(sent, provider).toContain(employeeCode);
    }
  });

  it("trouble at the service is said in plain words; the Admin's test shows the service's own message", async () => {
    await setService("gemini");
    const errorKey = async (status: number, message: string) => {
      respond = () => ({ status, body: JSON.stringify({ error: { code: status, message, status: "ERR" } }) });
      return (await question(employee, "Hello?")).error?.key;
    };
    expect(await errorKey(400, "API key not valid. Please pass a valid API key.")).toBe("ask.errors.notSetUp");
    expect(await errorKey(403, "Permission denied")).toBe("ask.errors.notSetUp");
    expect(await errorKey(404, "models/gemini-9 is not found")).toBe("ask.errors.failed");
    expect((await db.auditLog.findFirst({ where: { action: "ASK", userId: employee.userId }, orderBy: { id: "desc" } }))?.newValue).toMatchObject({ outcome: "failed" });

    await expect(testAskService(hr, "gemini")).rejects.toMatchObject({ status: 403 });
    respond = () => ({ status: 404, body: JSON.stringify({ error: { code: 404, message: "models/gemini-9 is not found", status: "NOT_FOUND" } }) });
    const bad = await testAskService(itSupport, "gemini");
    expect(bad).toMatchObject({ ok: false, kind: "request" });
    expect(!bad.ok && bad.message).toContain("gemini-9 is not found");
    respond = () => ({ status: 200, body: gemini.text(["OK"]) });
    expect(await testAskService(itSupport, "gemini")).toMatchObject({ ok: true, model: "gemini-3.8-flash" });
    // A service without a key: said so, without calling anyone.
    await removeAskKey(admin, "openai");
    requests.length = 0;
    expect(await testAskService(admin, "openai")).toMatchObject({ ok: false, kind: "auth" });
    expect(requests.length).toBe(0);
  }, 90_000);

  it("only the Admin and IT support choose the service; a model name must look like one", async () => {
    await expect(updateSetting(hr, "ask", { audience: "everyone", provider: "claude", models: SETTING_DEFAULTS.ask.models })).rejects.toMatchObject({ status: 403 });
    await expect(updateSetting(admin, "ask", { audience: "everyone", provider: "mistral", models: SETTING_DEFAULTS.ask.models })).rejects.toThrow();
    await expect(setService("gemini", { ...SETTING_DEFAULTS.ask.models, gemini: "gemini 3.8; drop" })).rejects.toThrow();
    await updateSetting(itSupport, "ask", { audience: "staff", provider: "gemini", models: { ...SETTING_DEFAULTS.ask.models, gemini: "gemini-4-argon" } });
    expect((await askModelFor(boardId)).id).toBe("gemini:gemini-4-argon");
    expect((await askStatus(employee)).allowed).toBe(false);
  });
});
