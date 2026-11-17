import { apiRoute } from "@/lib/api/route";
import { askProviderSchema, removeAskKey, setAskKey } from "@/modules/ask/config";

/** The API key of one AI service (gemini, openai, claude): saved encrypted, never read back. */
export const PUT = apiRoute<{ provider: string }>(async ({ actor, params, req }) => setAskKey(actor, askProviderSchema.parse(params.provider), await req.json().catch(() => null)));
export const DELETE = apiRoute<{ provider: string }>(async ({ actor, params }) => removeAskKey(actor, askProviderSchema.parse(params.provider)));
