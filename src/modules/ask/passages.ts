/**
 * Ask AI: finding the passages of the Board's documents that speak to a question. Plain word matching (English and
 * Hindi), no outside service — the documents are few and short, and what is found must be easy to explain.
 * Pure module.
 */

export interface PassageDoc {
  id: string;
  title: string;
  category: string;
  reference: string | null;
  body: string;
}

export interface Passage {
  docId: string;
  title: string;
  category: string;
  reference: string | null;
  /** 1 for the first part of the document. */
  part: number;
  parts: number;
  text: string;
  score: number;
}

const PART_CHARS = 900;

const STOP = new Set(
  "a an and are as at be by can do does for from has have how i if in is it its many me my of on or our shall should that the their there this to was we what when where which who whom why will with would you your का की के को में से है हैं और या पर क्या कैसे कब कहाँ कौन कितना कितनी कितने मेरा मेरी मेरे".split(" "),
);

/** Words of a text: lower-case, without the commonest words; a light stem so "leaves" finds "leave". */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

function stem(w: string): string {
  if (!/^[a-z]+$/.test(w) || w.length < 5) return w;
  return w.replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, "");
}

/** A document cut at blank lines into parts of about PART_CHARS characters. */
export function partsOf(body: string): string[] {
  const paras = body
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length > PART_CHARS) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    // One very long paragraph: cut at sentence ends.
    while (cur.length > PART_CHARS * 2) {
      const cut = cur.lastIndexOf(". ", PART_CHARS * 1.5);
      const at = cut > PART_CHARS / 2 ? cut + 1 : PART_CHARS * 1.5;
      out.push(cur.slice(0, at).trim());
      cur = cur.slice(at).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The best passages for a question: each word of the question counts once per passage, rarer words more; a word in
 * the title counts for every part of that document. Passages that share no word with the question are left out.
 */
export function findPassages(query: string, docs: PassageDoc[], limit = 5): Passage[] {
  const q = [...new Set(words(query))];
  if (!q.length) return [];
  const all = docs.flatMap((d) => {
    const parts = partsOf(d.body);
    const titleWords = new Set(words(`${d.title} ${d.reference ?? ""}`));
    return parts.map((text, i) => ({ d, text, part: i + 1, parts: parts.length, bag: new Set(words(text)), titleWords }));
  });
  if (!all.length) return [];
  const df = new Map<string, number>();
  for (const w of q) df.set(w, all.filter((p) => p.bag.has(w) || p.titleWords.has(w)).length);
  const scored = all
    .map((p) => {
      let score = 0;
      for (const w of q) {
        const n = df.get(w) ?? 0;
        if (!n) continue;
        const idf = Math.log(1 + all.length / n);
        if (p.bag.has(w)) score += idf;
        if (p.titleWords.has(w)) score += idf * 0.6;
      }
      return { ...p, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.part - b.part);
  return scored.slice(0, limit).map((p) => ({
    docId: p.d.id,
    title: p.d.title,
    category: p.d.category,
    reference: p.d.reference,
    part: p.part,
    parts: p.parts,
    text: p.text,
    score: Math.round(p.score * 100) / 100,
  }));
}
