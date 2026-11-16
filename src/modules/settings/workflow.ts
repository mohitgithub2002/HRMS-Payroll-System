import "server-only";
import { db } from "@/lib/db";
import { SETTING_DEFAULTS } from "./schema";

/**
 * The Board's way of working, read on every request (it decides each login's rights), so it is remembered for a few
 * seconds. A change in Settings is forgotten here at once; a second server process follows within the same seconds.
 */
const KEEP_MS = 5_000;
const seen = new Map<string, { simple: boolean; at: number }>();

export async function isSimpleWorkflow(boardId: string): Promise<boolean> {
  const hit = seen.get(boardId);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.simple;
  const row = await db.setting.findUnique({ where: { boardId_key: { boardId, key: "workflow" } }, select: { value: true } });
  const mode = (row?.value as { mode?: string } | null)?.mode ?? SETTING_DEFAULTS.workflow.mode;
  const simple = mode !== "twoStep";
  seen.set(boardId, { simple, at: Date.now() });
  return simple;
}

export function forgetWorkflow(boardId: string) {
  seen.delete(boardId);
}
