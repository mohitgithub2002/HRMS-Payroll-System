import { apiRoute } from "@/lib/api/route";
import { askProviderSchema, testAskService } from "@/modules/ask/config";

export const maxDuration = 60;

/** Asks the service one word with the key and model in force, and says whether it answered. */
export const POST = apiRoute<{ provider: string }>(async ({ actor, params }) => testAskService(actor, askProviderSchema.parse(params.provider)));
