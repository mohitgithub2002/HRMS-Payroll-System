import { apiRoute } from "@/lib/api/route";
import { makeT } from "@/lib/i18n";
import { getLocale, getSimple } from "@/lib/i18n/server";
import { askStatus, startAsk, type AskEvent } from "@/modules/ask/service";

/** A question can take several look-ups; give it time on hosts that cut requests short. */
export const maxDuration = 120;

/** Whether this login may ask, and whether a model is set up. */
export const GET = apiRoute(async ({ actor }) => askStatus(actor));

/**
 * Asks one question. What stops a question before it starts (not allowed, not set up, too many questions) comes back
 * as the usual JSON error. Otherwise the reply is a stream of lines, one JSON object each: what is being looked up,
 * the answer as it is written, and "done" or "error" at the end.
 */
export const POST = apiRoute(async ({ actor, req }) => {
  const raw: unknown = await req.json().catch(() => null);
  const run = await startAsk(actor, raw, { signal: req.signal });
  const t = makeT(await getLocale(), await getSimple());
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (e: AskEvent) => {
        if (!open) return;
        const line = e.type === "error" ? { type: "error", code: e.code, message: t(e.key) } : e;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          open = false; // the browser went away
        }
      };
      try {
        await run(send);
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
});
