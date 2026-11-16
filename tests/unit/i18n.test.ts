import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { hi } from "@/lib/i18n/hi";
import { makeT } from "@/lib/i18n";
import { enSimple, hiSimple } from "@/lib/i18n/simple";

function leaves(obj: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of leaves(v, key)) out.set(kk, vv);
  }
  return out;
}

describe("Hindi and English text (PRD §16)", () => {
  const enKeys = leaves(en);
  const hiKeys = leaves(hi);

  it("have exactly the same keys", () => {
    expect([...hiKeys.keys()].sort()).toEqual([...enKeys.keys()].sort());
  });

  it("have no empty strings", () => {
    for (const [k, v] of [...enKeys, ...hiKeys]) expect(v.trim(), k).not.toBe("");
  });

  it("keep the same {placeholders} in both languages", () => {
    for (const [k, v] of enKeys) {
      const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(names(hiKeys.get(k)!), k).toEqual(names(v));
    }
  });

  it("interpolates values", () => {
    expect(makeT("en")("login.otpSentTo", { mobile: "******3210" })).toBe("We sent a 6-digit code to ******3210.");
    expect(makeT("hi")("home.goodMorning", { name: "प्रिया" })).toBe("सुप्रभात, प्रिया");
  });
});

describe("wording for the simple way of working (lib/i18n/simple.ts)", () => {
  const base = leaves(en);
  const enOver = leaves(enSimple);
  const hiOver = leaves(hiSimple);
  const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("only rewords lines that exist, in both languages", () => {
    for (const k of enOver.keys()) expect(base.has(k), k).toBe(true);
    expect([...hiOver.keys()].sort()).toEqual([...enOver.keys()].sort());
  });

  it("keeps the same {placeholders} as the line it replaces", () => {
    for (const [k, v] of [...enOver, ...hiOver]) {
      expect(v.trim(), k).not.toBe("");
      expect(names(v), k).toEqual(names(base.get(k)!));
    }
  });

  it("is used only when the Board works the simple way", () => {
    expect(makeT("en")("nav.recruitment")).toBe("Recruitment and joining");
    expect(makeT("en", true)("nav.recruitment")).toBe("Hiring");
    expect(makeT("hi", true)("nav.recruitment")).toBe("भर्ती");
    // A line without simpler wording is the same either way.
    expect(makeT("en", true)("nav.home")).toBe(makeT("en")("nav.home"));
  });
});
