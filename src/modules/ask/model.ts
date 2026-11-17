import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "@/lib/errors";
import { scriptedModel } from "./model-scripted";

/**
 * Ask AI: the language model. One small interface so the question loop (service.ts) does not care who answers:
 * Claude through the Anthropic API in real use, a scripted stand-in for tests and practice copies without a key.
 *
 * The model receives the question, the description of the views the person may read and the results of the
 * statements it asks for — nothing else. It holds no database connection and no credentials.
 */
export type AskMessage = Anthropic.Beta.BetaMessageParam;
export type AskTool = Anthropic.Beta.BetaTool;
export type AskReply = Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason"> & { model?: string; usage?: { input_tokens: number; output_tokens: number } };

export interface AskModelRequest {
  system: string;
  tools: AskTool[];
  messages: AskMessage[];
  /** Called with each piece of text as it is written. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface AskModel {
  /** Shown in the audit trail. */
  id: string;
  reply(req: AskModelRequest): Promise<AskReply>;
}

/** Claude Opus 5.5 unless the deployment names another model. */
export const DEFAULT_ASK_MODEL = "claude-opus-5-5";

const isProductionCopy = () => process.env.APP_ENV === "production";
const scripted = () => process.env.ASK_AI_PROVIDER === "scripted" && !isProductionCopy();

/** Is there a model to ask? (An API key on the server, or the practice stand-in outside production.) */
export function askConfigured(): boolean {
  return scripted() || Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** True when answers come from the scripted stand-in — the screen says so. */
export const askIsPractice = () => scripted();

let client: Anthropic | undefined;

function claude(): AskModel {
  const model = process.env.ASK_AI_MODEL?.trim() || DEFAULT_ASK_MODEL;
  return {
    id: model,
    async reply({ system, tools, messages, onText, signal }) {
      // Credentials come from the environment (ANTHROPIC_API_KEY); nothing is read from the Board's settings.
      client ??= new Anthropic({ maxRetries: 2, timeout: 120_000 });
      try {
        const stream = client.beta.messages.stream(
          {
            model,
            max_tokens: 16_000,
            // If a safety check declines a request, the API tries the fallback model inside the same call.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            // The instructions and the view list are the same for every step of one question (and for the next
            // question of the same person), so they are read from the cache after the first step.
            cache_control: { type: "ephemeral" },
            system,
            tools,
            messages,
          },
          { signal },
        );
        if (onText) stream.on("text", onText);
        const message = await stream.finalMessage();
        return { content: message.content, stop_reason: message.stop_reason, model: message.model, usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens } };
      } catch (e) {
        throw toAppError(e);
      }
    },
  };
}

/** What went wrong, in words for the person asking; the details stay in the server log. */
function toAppError(e: unknown): unknown {
  if (e instanceof Anthropic.APIUserAbortError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    console.error("[ask] the model refused the API key", e.message);
    return new AppError(503, "ask_not_set_up", "ask.errors.notSetUp");
  }
  if (e instanceof Anthropic.RateLimitError) return new AppError(503, "ask_busy", "ask.errors.busy");
  if (e instanceof Anthropic.APIConnectionError) {
    console.error("[ask] could not reach the model", e.message);
    return new AppError(503, "ask_unreachable", "ask.errors.unreachable");
  }
  if (e instanceof Anthropic.APIError) {
    console.error("[ask] model error", e.status, e.message);
    return new AppError(e.status && e.status >= 500 ? 503 : 502, "ask_model_error", e.status && e.status >= 500 ? "ask.errors.busy" : "ask.errors.failed");
  }
  return e;
}

export function askModel(): AskModel {
  return scripted() ? scriptedModel : claude();
}
