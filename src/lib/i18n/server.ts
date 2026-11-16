import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { getActor } from "@/lib/auth/session";
import { currentBoard } from "@/lib/board";
import { isSimpleWorkflow } from "@/modules/settings/workflow";
import { makeT } from "./index";
import { LOCALE_COOKIE, type Locale } from "./types";

/** The language chosen on the login screen or in My profile, remembered in a cookie. */
export const getLocale = cache(async (): Promise<Locale> => {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return value === "hi" ? "hi" : "en";
});

/** Whether the Board works the simple way (Settings → How work is approved) — it changes some wording. */
export const getSimple = cache(async (): Promise<boolean> => {
  try {
    // Signed in: exactly what decides the person's rights, so wording and rights can never disagree.
    const actor = await getActor();
    if (actor) return Boolean(actor.simple);
    return await isSimpleWorkflow((await currentBoard()).id);
  } catch {
    return false;
  }
});

export async function getT() {
  const [locale, simple] = await Promise.all([getLocale(), getSimple()]);
  return { t: makeT(locale, simple), locale, simple };
}
