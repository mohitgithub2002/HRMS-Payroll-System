import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { canManageUsers, isFullAdmin, type Principal } from "@/lib/auth/access";
import type { Actor } from "@/lib/auth/session";
import { decrypt, encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { forbidden } from "@/lib/errors";
import { SETTING_DEFAULTS, settingsSchemas, type SettingValue } from "@/modules/settings/schema";
import { ASK_KEY_ENV, ASK_PROVIDERS, AskModelError, DEFAULT_ASK_MODELS, type AskModel, type AskProvider } from "./model";
import { claudeModel } from "./model-claude";
import { geminiModel } from "./model-gemini";
import { openaiModel } from "./model-openai";
import { scriptedModel } from "./model-scripted";

/**
 * Ask AI: which AI service answers, and with which key.
 *
 * The Board chooses the service in Settings → Ask (Gemini by default, GPT or Claude) and may name the model. The key
 * of a service comes from Settings — saved encrypted with the Board's data key (AES-256-GCM), never shown again, never
 * sent to a browser — or, when none is saved, from the server's environment (GEMINI_API_KEY, OPENAI_API_KEY,
 * ANTHROPIC_API_KEY). Keys are kept apart from the other settings, in a row the settings API cannot read.
 */
const KEYS_ROW = "askKeys";

interface StoredKey {
  enc: string;
  last4: string;
  byName: string;
  at: string;
}
type StoredKeys = Partial<Record<AskProvider, StoredKey>>;

export const askKeySchema = z.object({ key: z.string().trim().min(12, "validation.tooShort").max(400).regex(/^[\x21-\x7e]+$/, "validation.invalid") });
export const askProviderSchema = z.enum(ASK_PROVIDERS);

/** Who chooses the service and sets its keys: whoever may change settings, and the Board's Admin. */
export const canConfigureAsk = (p: Principal) => canManageUsers(p) || isFullAdmin(p);

const isProductionCopy = () => process.env.APP_ENV === "production";
/** Practice copies and browser checks: a scripted stand-in answers, whatever Settings says. Never in production. */
export const askIsPractice = () => process.env.ASK_AI_PROVIDER === "scripted" && !isProductionCopy();

function envKey(provider: AskProvider): { name: string; value: string } | null {
  for (const name of ASK_KEY_ENV[provider]) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

async function load(boardId: string): Promise<{ setting: SettingValue<"ask">; keys: StoredKeys }> {
  const rows = await db.setting.findMany({ where: { boardId, key: { in: ["ask", KEYS_ROW] } } });
  const raw = rows.find((r) => r.key === "ask")?.value as object | undefined;
  const parsed = settingsSchemas.ask.safeParse({ ...SETTING_DEFAULTS.ask, ...raw, models: { ...SETTING_DEFAULTS.ask.models, ...(raw as { models?: object } | undefined)?.models } });
  return { setting: parsed.success ? parsed.data : SETTING_DEFAULTS.ask, keys: (rows.find((r) => r.key === KEYS_ROW)?.value as StoredKeys | undefined) ?? {} };
}

export interface AskKeyStatus {
  provider: AskProvider;
  model: string;
  /** settings: saved in Settings · env: from the server's environment · none: no key. */
  source: "settings" | "env" | "none";
  /** The last four characters of a key saved in Settings; the environment variable's name otherwise. */
  hint: string | null;
  savedBy: string | null;
  savedAt: string | null;
}

/** What Settings shows: per service, where its key comes from — never the key. */
export async function askConfig(boardId: string) {
  const { setting, keys } = await load(boardId);
  const services: AskKeyStatus[] = ASK_PROVIDERS.map((provider) => {
    const saved = keys[provider];
    const env = envKey(provider);
    return {
      provider,
      model: setting.models[provider] || DEFAULT_ASK_MODELS[provider],
      source: saved ? "settings" : env ? "env" : "none",
      hint: saved ? saved.last4 : env ? env.name : null,
      savedBy: saved?.byName ?? null,
      savedAt: saved?.at ?? null,
    };
  });
  const chosen = services.find((s) => s.provider === setting.provider)!;
  return { audience: setting.audience, provider: setting.provider, services, practice: askIsPractice(), ready: askIsPractice() || chosen.source !== "none" };
}

/** Is there a model to ask for this Board right now? */
export async function askReady(boardId: string): Promise<boolean> {
  return (await askConfig(boardId)).ready;
}

const clients = new Map<string, AskModel>();

/** The model that answers for this Board: the chosen service, its model, its key. Throws when no key is there. */
export async function askModelFor(boardId: string, provider?: AskProvider): Promise<AskModel> {
  if (askIsPractice() && !provider) return scriptedModel;
  const { setting, keys } = await load(boardId);
  const which = provider ?? setting.provider;
  const model = setting.models[which] || DEFAULT_ASK_MODELS[which];
  const saved = keys[which];
  const apiKey = saved ? decrypt(saved.enc) : envKey(which)?.value;
  if (!apiKey) throw new AskModelError("auth", "No API key is set for this service.");
  // One client per service, model and key; a changed key makes a new one.
  const id = `${which}:${model}:${saved ? saved.enc.slice(-16) : "env"}`;
  let client = clients.get(id);
  if (!client) {
    client = which === "gemini" ? geminiModel({ apiKey, model }) : which === "openai" ? openaiModel({ apiKey, model }) : claudeModel({ apiKey, model });
    if (clients.size > 20) clients.clear();
    clients.set(id, client);
  }
  return client;
}

const SERVICE_NAME: Record<AskProvider, string> = { gemini: "Gemini", openai: "GPT (OpenAI)", claude: "Claude" };

/** Saves a service's key, encrypted. The audit entry says who and which service — never the key. */
export async function setAskKey(actor: Actor, provider: AskProvider, raw: unknown) {
  if (!canConfigureAsk(actor)) throw forbidden();
  const { key } = askKeySchema.parse(raw);
  await db.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { boardId_key: { boardId: actor.boardId, key: KEYS_ROW } } });
    const keys = { ...((row?.value as StoredKeys | undefined) ?? {}) };
    const before = keys[provider];
    keys[provider] = { enc: encrypt(key), last4: key.slice(-4), byName: actor.name, at: new Date().toISOString() };
    const value = keys as unknown as Prisma.InputJsonValue;
    await tx.setting.upsert({ where: { boardId_key: { boardId: actor.boardId, key: KEYS_ROW } }, create: { boardId: actor.boardId, key: KEYS_ROW, value, updatedById: actor.userId }, update: { value, updatedById: actor.userId } });
    await audit(tx, { ...actor, name: actor.name }, {
      action: "UPDATE",
      entityType: "Setting",
      entityId: `ask.key.${provider}`,
      summary: `${before ? "Replaced" : "Set"} the ${SERVICE_NAME[provider]} key for Ask`,
      oldValue: before ? { endsWith: before.last4 } : undefined,
      newValue: { endsWith: key.slice(-4) },
      category: "SYSTEM",
    });
  });
  return { provider, source: "settings" as const, hint: key.slice(-4) };
}

export async function removeAskKey(actor: Actor, provider: AskProvider) {
  if (!canConfigureAsk(actor)) throw forbidden();
  await db.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { boardId_key: { boardId: actor.boardId, key: KEYS_ROW } } });
    const keys = { ...((row?.value as StoredKeys | undefined) ?? {}) };
    const before = keys[provider];
    if (!before) return;
    delete keys[provider];
    await tx.setting.update({ where: { boardId_key: { boardId: actor.boardId, key: KEYS_ROW } }, data: { value: keys as unknown as Prisma.InputJsonValue, updatedById: actor.userId } });
    await audit(tx, { ...actor, name: actor.name }, {
      action: "DELETE",
      entityType: "Setting",
      entityId: `ask.key.${provider}`,
      summary: `Removed the ${SERVICE_NAME[provider]} key for Ask`,
      oldValue: { endsWith: before.last4 },
      category: "SYSTEM",
    });
  });
  return { provider };
}

/**
 * Asks the service one word, to see that the key and the model name work. For the people who set the keys only: on
 * failure they get the service's own message, which is what tells a wrong key from a wrong model name.
 */
export async function testAskService(actor: Actor, provider: AskProvider): Promise<{ ok: true; model: string; ms: number } | { ok: false; kind: string; message: string }> {
  if (!canConfigureAsk(actor)) throw forbidden();
  const started = Date.now();
  try {
    const model = await askModelFor(actor.boardId, provider);
    const reply = await model.reply({ system: "You are a connection test. Reply with the single word OK.", tools: [], turns: [{ role: "user", text: "Reply with the single word OK." }] });
    return { ok: true, model: reply.model ?? model.id, ms: Date.now() - started };
  } catch (e) {
    if (e instanceof AskModelError) return { ok: false, kind: e.kind, message: e.detail.slice(0, 400) };
    return { ok: false, kind: "request", message: e instanceof Error ? e.message.slice(0, 400) : "unknown error" };
  }
}
