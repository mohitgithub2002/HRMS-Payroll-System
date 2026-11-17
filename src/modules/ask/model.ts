/**
 * Ask AI: the language model, as the question loop (service.ts) sees it — one small interface, whoever answers.
 * The Board chooses the AI service in Settings: Gemini (the default), GPT or Claude; each has an adapter that turns
 * this neutral conversation into the service's own form and back (model-gemini.ts, model-openai.ts, model-claude.ts).
 * A scripted stand-in serves tests and practice copies (model-scripted.ts).
 *
 * Whichever it is, the model receives the question, the description of the views the person may read and the results
 * of the statements it asks for — nothing else. It holds no database connection and never decides access.
 * Pure types and helpers: no server imports here.
 */
export const ASK_PROVIDERS = ["gemini", "openai", "claude"] as const;
export type AskProvider = (typeof ASK_PROVIDERS)[number];

/** The model asked when Settings names none. Gemini is the Board's default service. */
export const DEFAULT_ASK_PROVIDER: AskProvider = "gemini";
export const DEFAULT_ASK_MODELS: Record<AskProvider, string> = {
  gemini: "gemini-3.8-flash",
  openai: "gpt-5.5",
  claude: "claude-opus-5-5",
};

/** The environment variables a key may come from when none is saved in Settings (first one set wins). */
export const ASK_KEY_ENV: Record<AskProvider, readonly string[]> = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY"],
};

export interface AskToolDef {
  name: string;
  description: string;
  /** JSON Schema of the input (an object). */
  parameters: Record<string, unknown>;
}

export interface AskToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AskToolResult {
  id: string;
  name: string;
  /** JSON text. */
  content: string;
  isError: boolean;
}

/** What a service returned, kept exactly, so the same service gets its own turn back unchanged (reasoning included). */
export interface AskRaw {
  provider: AskProvider | "scripted";
  data: unknown;
}

export type AskTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: AskToolCall[]; raw?: AskRaw }
  | { role: "tool"; results: AskToolResult[]; /** A word from the application after the results. */ note?: string };

export interface AskReply {
  text: string;
  calls: AskToolCall[];
  /** end: the answer · tools: look-ups wanted · length: cut off · refusal: the service declined. */
  stop: "end" | "tools" | "length" | "refusal";
  raw?: AskRaw;
  /** The model that answered, as the service names it. */
  model?: string;
}

export interface AskModelRequest {
  system: string;
  tools: AskToolDef[];
  turns: AskTurn[];
  /** Called with each piece of the answer as it is written. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface AskModel {
  /** Shown in the audit trail: "gemini:gemini-3.8-flash". */
  id: string;
  reply(req: AskModelRequest): Promise<AskReply>;
}

/**
 * What went wrong at the AI service, in a form the application can word for the person asking. `detail` is the
 * service's own message — shown only to the Admin who tests the connection, and written to the server log.
 */
export class AskModelError extends Error {
  constructor(
    public readonly kind: "auth" | "busy" | "unreachable" | "request",
    public readonly detail: string,
  ) {
    super(`${kind}: ${detail}`);
  }
}

/** HTTP status of a failed call → what kind of trouble it is. */
export function kindOfStatus(status: number | undefined): AskModelError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || (status !== undefined && status >= 500)) return "busy";
  return "request";
}

export const isAborted = (signal: AbortSignal | undefined, e: unknown) => Boolean(signal?.aborted) || (e instanceof Error && e.name === "AbortError");

/** Tool input as an object, whatever a service sent (JSON text, an object, nothing). */
export function parseToolInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw || "{}") as unknown;
  } catch {
    return { INVALID_JSON: raw.slice(0, 500) };
  }
}
