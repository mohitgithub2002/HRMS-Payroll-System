import "server-only";
import { ApiError, FinishReason, GoogleGenAI, type Content, type Part } from "@google/genai";
import { AskModelError, isAborted, kindOfStatus, type AskModel, type AskToolCall, type AskTurn } from "./model";

/** Ask AI through Gemini (Google's Gemini Developer API, official SDK) — the Board's default service. */

/** A call id the application made up (Gemini does not always give one); it is not sent back. */
const LOCAL_ID = "gemini-call-";

const asObject = (json: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { output: v };
  } catch {
    return { output: json };
  }
};

function toContents(turns: AskTurn[]): Content[] {
  return turns.map((t): Content => {
    if (t.role === "user") return { role: "user", parts: [{ text: t.text }] };
    if (t.role === "assistant") {
      // Gemini's own turn goes back part by part as it came: the parts carry the signatures of its reasoning.
      if (t.raw?.provider === "gemini") return { role: "model", parts: t.raw.data as Part[] };
      const parts: Part[] = [];
      if (t.text) parts.push({ text: t.text });
      for (const c of t.calls) parts.push({ functionCall: { name: c.name, args: (c.input ?? {}) as Record<string, unknown> } });
      return { role: "model", parts: parts.length ? parts : [{ text: "" }] };
    }
    const parts: Part[] = t.results.map((r) => ({
      functionResponse: { ...(r.id.startsWith(LOCAL_ID) ? {} : { id: r.id }), name: r.name, response: asObject(r.content) },
    }));
    if (t.note) parts.push({ text: t.note });
    return { role: "user", parts };
  });
}

const DECLINED = new Set<string>([FinishReason.SAFETY, FinishReason.RECITATION, FinishReason.BLOCKLIST, FinishReason.PROHIBITED_CONTENT, FinishReason.SPII]);

export function geminiModel(opts: { apiKey: string; model: string }): AskModel {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey, httpOptions: { timeout: 120_000 } });
  return {
    id: `gemini:${opts.model}`,
    async reply({ system, tools, turns, onText, signal }) {
      try {
        const stream = await ai.models.generateContentStream({
          model: opts.model,
          contents: toContents(turns),
          config: {
            systemInstruction: system,
            ...(tools.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] } : {}),
            maxOutputTokens: 16_000,
            abortSignal: signal,
          },
        });
        const parts: Part[] = [];
        let finish: string | undefined;
        let blocked = false;
        let model: string | undefined;
        for await (const chunk of stream) {
          if (chunk.promptFeedback?.blockReason) blocked = true;
          model = chunk.modelVersion ?? model;
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) finish = candidate.finishReason;
          for (const part of candidate?.content?.parts ?? []) {
            parts.push(part);
            if (part.text && !part.thought) onText?.(part.text);
          }
        }
        const text = parts.flatMap((p) => (p.text && !p.thought ? [p.text] : [])).join("");
        const calls: AskToolCall[] = parts.flatMap((p, i) => (p.functionCall?.name ? [{ id: p.functionCall.id || `${LOCAL_ID}${i}`, name: p.functionCall.name, input: p.functionCall.args ?? {} }] : []));
        if (finish === FinishReason.MALFORMED_FUNCTION_CALL || finish === FinishReason.UNEXPECTED_TOOL_CALL) throw new AskModelError("request", `The model wrote a tool call that could not be read (${finish}).`);
        const stop = blocked || (finish !== undefined && DECLINED.has(finish)) ? "refusal" : finish === FinishReason.MAX_TOKENS ? "length" : calls.length ? "tools" : "end";
        return { text, calls, stop, raw: { provider: "gemini", data: parts }, model: model ?? opts.model };
      } catch (e) {
        if (isAborted(signal, e)) throw e;
        if (e instanceof AskModelError) throw e;
        // Gemini answers a wrong key with 400 as well as 401/403; its message says which it is.
        if (e instanceof ApiError) throw new AskModelError(e.status === 400 && /api key/i.test(e.message) ? "auth" : kindOfStatus(e.status), e.message);
        const message = e instanceof Error ? e.message : "unknown error";
        throw new AskModelError(/fetch failed|network|ECONN|ENOTFOUND|timed? ?out/i.test(message) ? "unreachable" : "request", message);
      }
    },
  };
}
