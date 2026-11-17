import "server-only";
import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { AskModelError, isAborted, kindOfStatus, parseToolInput, type AskModel, type AskTurn } from "./model";

/** Ask AI through GPT (OpenAI's Responses API, official SDK). */
type InputItem = OpenAI.Responses.ResponseInputItem;
type OutputItem = OpenAI.Responses.ResponseOutputItem;

function toInput(turns: AskTurn[]): InputItem[] {
  return turns.flatMap((t): InputItem[] => {
    if (t.role === "user") return [{ role: "user", content: t.text }];
    if (t.role === "assistant") {
      // GPT's own output items go back in order, reasoning items included — dropping one fails the next request.
      if (t.raw?.provider === "openai") return toResponseInputItems(t.raw.data as OutputItem[]);
      const items: InputItem[] = [];
      if (t.text) items.push({ role: "assistant", content: t.text });
      for (const c of t.calls) items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.input ?? {}) });
      return items;
    }
    const items: InputItem[] = t.results.map((r) => ({ type: "function_call_output", call_id: r.id, output: r.content }));
    if (t.note) items.push({ role: "user", content: t.note });
    return items;
  });
}

export function openaiModel(opts: { apiKey: string; model: string }): AskModel {
  const client = new OpenAI({ apiKey: opts.apiKey, maxRetries: 2, timeout: 120_000 });
  return {
    id: `openai:${opts.model}`,
    async reply({ system, tools, turns, onText, signal }) {
      try {
        const stream = client.responses.stream(
          {
            model: opts.model,
            instructions: system,
            input: toInput(turns),
            ...(tools.length ? { tools: tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters, strict: false })) } : {}),
            max_output_tokens: 16_000,
            // Nothing is kept at the service between steps: the conversation is sent each time, with the model's
            // reasoning carried along in encrypted form.
            store: false,
            include: ["reasoning.encrypted_content"],
          },
          { signal },
        );
        if (onText) stream.on("response.output_text.delta", (e) => onText(e.delta));
        const res = await stream.finalResponse();
        let text = "";
        let refused = false;
        const calls = [];
        for (const item of res.output) {
          if (item.type === "function_call") calls.push({ id: item.call_id, name: item.name, input: parseToolInput(item.arguments) });
          else if (item.type === "message") {
            for (const c of item.content) {
              if (c.type === "output_text") text += c.text;
              else if (c.type === "refusal") refused = true;
            }
          }
        }
        const cut = res.status === "incomplete";
        const stop = refused || (cut && res.incomplete_details?.reason === "content_filter") ? "refusal" : cut ? "length" : calls.length ? "tools" : "end";
        if (res.status === "failed") throw new AskModelError("request", res.error?.message ?? "The response failed.");
        return { text, calls, stop, raw: { provider: "openai", data: res.output }, model: res.model };
      } catch (e) {
        if (isAborted(signal, e)) throw e;
        if (e instanceof AskModelError) throw e;
        if (e instanceof OpenAI.APIConnectionError) throw new AskModelError("unreachable", e.message);
        if (e instanceof OpenAI.APIError) throw new AskModelError(kindOfStatus(e.status), e.message);
        throw new AskModelError("request", e instanceof Error ? e.message : "unknown error");
      }
    },
  };
}
