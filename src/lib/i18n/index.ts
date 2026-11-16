import { en } from "./en";
import { hi } from "./hi";
import { enSimple, hiSimple } from "./simple";
import { interpolate, lookup, type Locale, type Paths, type Vars } from "./types";

export type Dictionary = typeof en;
export type TKey = Paths<Dictionary>;
export type TFunction = (key: TKey, vars?: Vars) => string;

export const dictionaries: Record<Locale, Dictionary> = { en, hi: hi as unknown as Dictionary };

/** Wording for the simple way of working: only the lines that would otherwise speak of a Checker or a second step. */
export const simpleDictionaries: Record<Locale, unknown> = { en: enSimple, hi: hiSimple };

/**
 * Builds a translator. Missing Hindi text falls back to English, never to a raw key. With `simple`, a line that
 * has simpler wording for the simple way of working (lib/i18n/simple.ts) uses it.
 */
export function makeT(locale: Locale, simple = false): TFunction {
  const dict = dictionaries[locale];
  const over = simple ? simpleDictionaries[locale] : null;
  return (key, vars) => interpolate((over ? lookup(over, key) : undefined) ?? lookup(dict, key) ?? lookup(en, key) ?? key, vars);
}

/** For dynamic keys such as `permission.${p}` — still falls back safely. */
export function tDynamic(t: TFunction, key: string, vars?: Vars): string {
  return t(key as TKey, vars);
}

export type { Locale } from "./types";
