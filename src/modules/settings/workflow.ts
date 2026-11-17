import "server-only";
import { db } from "@/lib/db";
import { SETTING_DEFAULTS } from "./schema";

/**
 * The Board's way of working, read on every request (it decides each login's rights), so it is remembered for a few
 * seconds. A change in Settings is forgotten here at once; a second server process follows within the same seconds.
 */
const KEEP_MS = 5_000;
// Pages and API routes are bundled apart and would each get their own copy of a module-level map, so a change saved
// through the API would not be forgotten for the pages: the map lives on the process instead.
const store = globalThis as unknown as { __dcbWorkflow?: Map<string, { simple: boolean; at: number }> };
const seen = (store.__dcbWorkflow ??= new Map<string, { simple: boolean; at: number }>());

export async function isSimpleWorkflow(boardId: string): Promise<boolean> {
  const hit = seen.get(boardId);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.simple;
  const row = await db.setting.findUnique({ where: { boardId_key: { boardId, key: "workflow" } }, select: { value: true } });
  return rememberWorkflow(boardId, row?.value ?? null);
}

/** The way of working from the saved "workflow" setting (or the default), remembered as above. */
export function rememberWorkflow(boardId: string, value: unknown): boolean {
  const mode = (value as { mode?: string } | null)?.mode ?? SETTING_DEFAULTS.workflow.mode;
  const simple = mode !== "twoStep";
  seen.set(boardId, { simple, at: Date.now() });
  return simple;
}

export function forgetWorkflow(boardId: string) {
  seen.delete(boardId);
}
