import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AskModelError, isAborted, kindOfStatus, type AskModel, type AskTurn } from "./model";

/** Ask AI through Claude (Anthropic's Messages API, official SDK). */
type Message = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

function toMessages(turns: AskTurn[]): Message[] {
  return turns.map((t): Message => {
    if (t.role === "user") return { role: "user", content: t.text };
    if (t.role === "assistant") {
      // Claude's own turn goes back exactly as it came (its reasoning blocks are tied to it).
      if (t.raw?.provider === "claude") return { role: "assistant", content: t.raw.data as Block[] };
      const blocks: Block[] = [];
      if (t.text) blocks.push({ type: "text", text: t.text });
      for (const c of t.calls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      return { role: "assistant", content: blocks.length ? blocks : t.text };
    }
    // All results of one step together, in one message.
    const blocks: Block[] = t.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) }));
    if (t.note) blocks.push({ type: "text", text: t.note });
    return { role: "user", content: blocks };
  });
}

function toError(e: unknown): AskModelError {
  if (e instanceof Anthropic.APIConnectionError) return new AskModelError("unreachable", e.message);
  if (e instanceof Anthropic.APIError) return new AskModelError(kindOfStatus(e.status), e.message);
  return new AskModelError("request", e instanceof Error ? e.message : "unknown error");
}

export function claudeModel(opts: { apiKey: string; model: string }): AskModel {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 120_000 });
  return {
    id: `claude:${opts.model}`,
    async reply({ system, tools, turns, onText, signal }) {
      try {
        const stream = client.beta.messages.stream(
          {
            model: opts.model,
            max_tokens: 16_000,
            // If a safety check declines a request, the API tries its fallback model inside the same call.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            // The instructions and the view list are the same for every step of one question (and for the next
            // question of the same person), so they are read from the cache after the first step.
            cache_control: { type: "ephemeral" },
            system,
            // Inputs stream as they are written; the question loop validates every input before it runs anything.
            tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool["input_schema"], eager_input_streaming: true })),
            messages: toMessages(turns),
          },
          { signal },
        );
        if (onText) stream.on("text", onText);
        const message = await stream.finalMessage();
        const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        const calls = message.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : []));
        const stop = message.stop_reason === "refusal" ? "refusal" : message.stop_reason === "max_tokens" ? "length" : message.stop_reason === "tool_use" && calls.length ? "tools" : "end";
        return { text, calls, stop, raw: { provider: "claude", data: message.content }, model: message.model };
      } catch (e) {
        if (isAborted(signal, e)) throw e;
        throw toError(e);
      }
    },
  };
}
