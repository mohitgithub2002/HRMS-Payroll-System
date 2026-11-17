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
  return settingFrom(key, row?.value);
}

/** A saved value merged over the defaults, so settings saved by an older version gain new fields safely. */
function settingFrom<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  if (value === undefined || value === null) return SETTING_DEFAULTS[key];
  const parsed = settingsSchemas[key].safeParse({ ...SETTING_DEFAULTS[key], ...(value as object) });
  return (parsed.success ? parsed.data : SETTING_DEFAULTS[key]) as SettingValue<K>;
}

/** Every setting, in one query. */
export async function getAllSettings(boardId: string) {
  const keys = Object.keys(settingsSchemas) as SettingKey[];
  const rows = await db.setting.findMany({ where: { boardId, key: { in: keys } } });
  const saved = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(keys.map((k) => [k, settingFrom(k, saved.get(k))])) as { [K in SettingKey]: SettingValue<K> };
}

/** S-82: only the User & settings manager may change settings (and the Admin, in the simple way of working). */
export async function updateSetting<K extends SettingKey>(actor: Actor, key: K, value: unknown) {
  // How work is approved is the Board's own decision: its Admin may always change it.
  // Who may use Ask AI is the Board's decision too.
  if (!canManageUsers(actor) && !((key === "workflow" || key === "ask") && isFullAdmin(actor))) throw forbidden();
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
