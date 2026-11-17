import { apiRoute } from "@/lib/api/route";
import { deleteKnowledge, getKnowledge, updateKnowledge } from "@/modules/ask/knowledge";

export const GET = apiRoute<{ id: string }>(async ({ actor, params }) => getKnowledge(actor, params.id));
export const PUT = apiRoute<{ id: string }>(async ({ actor, params, req }) => updateKnowledge(actor, params.id, await req.json().catch(() => null)));
export const DELETE = apiRoute<{ id: string }>(async ({ actor, params }) => deleteKnowledge(actor, params.id));
