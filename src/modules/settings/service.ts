import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { audit, diff } from "@/lib/audit";
import { canManageUsers, isFullAdmin } from "@/lib/auth/access";
import type { Actor } from "@/lib/auth/session";
import { db, type DbLike } from "@/lib/db";
import { forbidden } from "@/lib/errors";
import { SETTING_DEFAULTS, settingsSchemas, type SettingKey, type SettingValue } from "./schema";
import { forgetWorkflow } from "./workflow";

export async function getSetting<K extends SettingKey>(boardId: string, key: K, tx: DbLike = db): Promise<SettingValue<K>> {
  const row = await tx.setting.findUnique({ where: { boardId_key: { boardId, key } } });
  if (!row) return SETTING_DEFAULTS[key];
  // Merge over defaults so settings saved by an older version gain new fields safely.
  const merged = { ...SETTING_DEFAULTS[key], ...(row.value as object) };
  const parsed = settingsSchemas[key].safeParse(merged);
  return (parsed.success ? parsed.data : SETTING_DEFAULTS[key]) as SettingValue<K>;
}

export async function getAllSettings(boardId: string) {
  const keys = Object.keys(settingsSchemas) as SettingKey[];
  const entries = await Promise.all(keys.map(async (k) => [k, await getSetting(boardId, k)] as const));
  return Object.fromEntries(entries) as { [K in SettingKey]: SettingValue<K> };
}

/** S-82: only the User & settings manager may change settings (and the Admin, in the simple way of working). */
export async function updateSetting<K extends SettingKey>(actor: Actor, key: K, value: unknown) {
  // How work is approved is the Board's own decision: its Admin may always change it.
  if (!canManageUsers(actor) && !(key === "workflow" && isFullAdmin(actor))) throw forbidden();
  const parsed = settingsSchemas[key].parse(value) as SettingValue<K>;
  const saved = await db.$transaction(async (tx) => {
    const before = await getSetting(actor.boardId, key, tx);
    await tx.setting.upsert({
      where: { boardId_key: { boardId: actor.boardId, key } },
      create: { boardId: actor.boardId, key, value: parsed as Prisma.InputJsonValue, updatedById: actor.userId },
      update: { value: parsed as Prisma.InputJsonValue, updatedById: actor.userId },
    });
    const changes = diff(before as Record<string, unknown>, parsed as Record<string, unknown>);
    await audit(tx, { ...actor, name: actor.name }, {
      action: "UPDATE",
      entityType: "Setting",
      entityId: key,
      summary: `Changed ${key} settings`,
      oldValue: changes.oldValue,
      newValue: changes.newValue,
      category: "SYSTEM",
    });
    return parsed;
  });
  // Everyone's rights and wording follow this choice from their next screen.
  if (key === "workflow") forgetWorkflow(actor.boardId);
  return saved;
}
