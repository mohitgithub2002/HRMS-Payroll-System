import { apiRoute } from "@/lib/api/route";
import { createKnowledge, listKnowledge } from "@/modules/ask/knowledge";

/** The Board's documents for Ask AI (policies, orders, circulars). */
export const GET = apiRoute(async ({ actor }) => listKnowledge(actor));
export const POST = apiRoute(async ({ actor, req }) => createKnowledge(actor, await req.json().catch(() => null)));
