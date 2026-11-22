/**
 * Ask AI: the answer's light formatting — paragraphs, **bold**, `code`, bullet and numbered lists and simple tables —
 * read into plain data so the screen builds real elements (never HTML from the model). Pure module.
 */
export type Inline = { kind: "text" | "bold" | "code"; text: string };

export type Block =
  | { kind: "p"; lines: Inline[][] }
  | { kind: "ul" | "ol"; items: Inline[][] }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] };

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+?)\*\*|`([^`]+?)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ kind: "text", text: text.slice(at, m.index) });
    out.push(m[1] !== undefined ? { kind: "bold", text: m[1] } : { kind: "code", text: m[2]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => inline(c.trim()));
const bullet = /^\s*[-*•]\s+(.*)$/;
const numbered = /^\s*\d+[.)]\s+(.*)$/;
/** A heading the model wrote anyway is shown as a bold line. */
const heading = /^\s*#{1,6}\s+(.*)$/;

export function parseAnswer(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (isRow(line) && i + 1 < lines.length && isRule(lines[i + 1]!)) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i]!)) {
        const row = cells(lines[i]!);
        // Every row has the heading's number of cells, so the table stays a table.
        rows.push(head.map((_, c) => row[c] ?? []));
        i += 1;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    const list = bullet.test(line) ? { kind: "ul" as const, re: bullet } : numbered.test(line) ? { kind: "ol" as const, re: numbered } : null;
    if (list) {
      const items: Inline[][] = [];
      while (i < lines.length && list.re.test(lines[i]!)) {
        items.push(inline(list.re.exec(lines[i]!)![1]!.trim()));
        i += 1;
      }
      blocks.push({ kind: list.kind, items });
      continue;
    }
    const para: Inline[][] = [];
    while (i < lines.length && lines[i]!.trim() && !bullet.test(lines[i]!) && !numbered.test(lines[i]!) && !(isRow(lines[i]!) && i + 1 < lines.length && isRule(lines[i + 1]!))) {
      const h = heading.exec(lines[i]!);
      para.push(h ? [{ kind: "bold", text: h[1]!.replace(/\*\*/g, "").trim() }] : inline(lines[i]!.trim()));
      i += 1;
    }
    if (para.length) blocks.push({ kind: "p", lines: para });
  }
  return blocks;
}
