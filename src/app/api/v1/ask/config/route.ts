import { apiRoute } from "@/lib/api/route";
import { forbidden } from "@/lib/errors";
import { askConfig, canConfigureAsk } from "@/modules/ask/config";

/** Which AI service answers and where each service's key comes from — never a key. */
export const GET = apiRoute(async ({ actor }) => {
  if (!canConfigureAsk(actor)) throw forbidden();
  return askConfig(actor.boardId);
});
