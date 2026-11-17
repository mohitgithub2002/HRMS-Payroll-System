"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Briefcase,
  CalendarCheck,
  CalendarDays,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Fingerprint,
  HandCoins,
  HeartPulse,
  History,
  Hourglass,
  KeyRound,
  Landmark,
  Leaf,
  Lock,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  SquarePen,
  Table2,
  TriangleAlert,
  Users,
  UsersRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { tDynamic } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { parseAnswer, type Inline } from "@/modules/ask/answer-format";

/** The shapes the API streams (modules/ask/service.ts) — kept here so the screen pulls in no server code. */
type Step =
  | { kind: "sql"; purpose: string; sql: string; ok: true; rows: number; truncated: boolean; views: string[] }
  | { kind: "sql"; purpose: string; sql: string; ok: false; reason: string }
  | { kind: "documents"; query: string; found: string[] };
type Cell = string | number | boolean | null;
interface ResultTable {
  columns: { name: string; kind: "text" | "number" | "boolean" }[];
  rows: Cell[][];
  truncated: boolean;
}
type StreamEvent =
  | { type: "working"; what: "thinking" | "records" | "documents"; note?: string }
  | { type: "text"; delta: string }
  | { type: "clear" }
  | { type: "step"; step: Step }
  | { type: "done"; answer: string; steps: Step[]; table: ResultTable | null }
  | { type: "error"; message: string; code: string };

interface Turn {
  id: number;
  question: string;
  answer: string;
  steps: Step[];
  table: ResultTable | null;
  state: "working" | "done" | "error" | "stopped";
  working?: { what: "thinking" | "records" | "documents"; note?: string };
  error?: string;
}

const MAX_QUESTION = 2000;

/** A picture for each suggested question. */
const SUGGESTION_ICONS: Record<string, LucideIcon> = {
  myLeave: CalendarDays,
  mySalary: Wallet,
  myAttendance: Fingerprint,
  holidays: CalendarCheck,
  leaveRule: BookOpen,
  myPension: Leaf,
  lifeCertificate: HeartPulse,
  teamLeave: UsersRound,
  headcount: Users,
  retiring: Hourglass,
  onLeaveToday: CalendarDays,
  vacant: Briefcase,
  payrollTotal: Wallet,
  loans: HandCoins,
  tdsTotal: Landmark,
  pensioners: Leaf,
  logins: KeyRound,
  auditToday: History,
};

// ── The answer ──────────────────────────────────────────────────────────────────────────────────────────────────

function Rich({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "bold" ? (
          <strong key={i} className="font-semibold text-ink-900">
            {p.text}
          </strong>
        ) : p.kind === "code" ? (
          <code key={i} className="rounded-md bg-ink-100 px-1.5 py-0.5 font-mono text-[0.85em] text-ink-800">
            {p.text}
          </code>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** The answer as real elements: paragraphs, lists and tables. Nothing the model writes is treated as HTML. */
function Answer({ text, writing }: { text: string; writing: boolean }) {
  const blocks = parseAnswer(text);
  const caret = <span className="ml-0.5 inline-block h-[1.1em] w-[3px] translate-y-[0.2em] animate-caret rounded-full bg-brand-600" aria-hidden="true" />;
  return (
    <div className="space-y-4 text-[0.96875rem] leading-7 text-ink-800">
      {blocks.map((b, i) => {
        const last = writing && i === blocks.length - 1;
        if (b.kind === "p") {
          return (
            <p key={i} className="break-words">
              {b.lines.map((line, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  <Rich parts={line} />
                </span>
              ))}
              {last && caret}
            </p>
          );
        }
        if ("items" in b) {
          const List = b.kind;
          return (
            <List key={i} className={cn("space-y-1.5 pl-6 marker:text-ink-400", b.kind === "ul" ? "list-disc" : "list-decimal marker:font-medium")}>
              {b.items.map((item, j) => (
                <li key={j} className="break-words pl-1">
                  <Rich parts={item} />
                  {last && j === b.items.length - 1 && caret}
                </li>
              ))}
            </List>
          );
        }
        return (
          <div key={i} className="scrollbar-thin overflow-x-auto rounded-2xl border border-ink-200 bg-white" tabIndex={0}>
            <table className="w-full min-w-max border-collapse text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/80 text-left">
                  {b.head.map((h, j) => (
                    <th key={j} scope="col" className="whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-600">
                      <Rich parts={h} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {b.rows.map((row, j) => (
                  <tr key={j} className="transition-colors hover:bg-ink-50/60">
                    {row.map((c, k) => (
                      <td key={k} className="px-4 py-2.5 align-top text-ink-800">
                        <Rich parts={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {writing && !blocks.length && caret}
    </div>
  );
}

const cellText = (c: Cell) => (c === null ? "" : typeof c === "boolean" ? (c ? "Yes" : "No") : String(c));

function downloadCsv(table: ResultTable) {
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  // A leading apostrophe stops a spreadsheet from reading a text cell as a formula.
  const safe = (c: Cell) => (typeof c === "string" && /^[=+\-@\t\r]/.test(c) ? `'${c}` : cellText(c));
  const lines = [table.columns.map((c) => quote(c.name)).join(","), ...table.rows.map((r) => r.map((c) => quote(safe(c))).join(","))];
  const url = URL.createObjectURL(new Blob([`﻿${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "ask-result.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The rows behind the answer, straight from the database (already limited to what the person may see). */
function Rows({ table }: { table: ResultTable }) {
  const t = useT();
  return (
    <details className="group overflow-hidden rounded-2xl border border-ink-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 [&::-webkit-details-marker]:hidden">
        <span className="flex size-6 items-center justify-center rounded-lg bg-ink-100 text-ink-500" aria-hidden="true">
          <Table2 className="size-3.5" />
        </span>
        <span>{t("ask.tableTitle", { count: table.rows.length })}</span>
        <ChevronRight className="ml-auto size-4 text-ink-400 transition-transform group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="border-t border-ink-100">
        <div className="scrollbar-thin max-h-96 overflow-auto" tabIndex={0}>
          <table className="w-full min-w-max border-collapse text-sm">
            <thead className="sticky top-0 bg-ink-50">
              <tr>
                {table.columns.map((c, i) => (
                  <th key={i} scope="col" className={cn("whitespace-nowrap px-4 py-2 text-xs font-semibold text-ink-600", c.kind === "number" ? "text-right" : "text-left")}>
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className={cn("whitespace-nowrap px-4 py-1.5 text-ink-800", table.columns[j]?.kind === "number" && "tabular text-right")}>
                      {c === null ? <span className="text-ink-300">—</span> : typeof c === "number" ? c.toLocaleString("en-IN") : cellText(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 bg-ink-50/50 px-4 py-2">
          <p className="text-xs text-ink-500">{table.truncated ? t("ask.tableMore", { count: table.rows.length }) : ""}</p>
          <button type="button" onClick={() => downloadCsv(table)} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-50">
            <Download className="size-3.5" aria-hidden="true" /> {t("ask.download")}
          </button>
        </div>
      </div>
    </details>
  );
}

function StepLine({ step }: { step: Step }) {
  const t = useT();
  if (step.kind === "documents") {
    return (
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700" aria-hidden="true">
          <FileText className="size-3" />
        </span>
        <div className="min-w-0">
          <p className="break-words text-ink-700">
            {t("ask.howDocuments")}: <span className="text-ink-500">{step.query}</span>
          </p>
          {step.found.length > 0 && <p className="break-words text-xs text-ink-500">{step.found.join(" · ")}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5">
      <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full", step.ok ? "bg-brand-50 text-brand-700" : "bg-gold-50 text-gold-600")} aria-hidden="true">
        {step.ok ? <Check className="size-3" /> : <Lock className="size-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-ink-700">
          {step.purpose || t("ask.howRecords")}
          <span className="ml-2 text-xs text-ink-500">{step.ok ? t(step.truncated ? "ask.howRowsMore" : "ask.howRows", { count: step.rows }) : t("ask.howRefused")}</span>
        </p>
        {!step.ok && <p className="break-words text-xs text-ink-500">{step.reason}</p>}
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-medium text-brand-700 hover:underline">{t("ask.showSql")}</summary>
          <pre className="scrollbar-thin mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-ink-200 bg-ink-50 p-3 font-mono text-xs leading-relaxed text-ink-700">{step.sql}</pre>
        </details>
      </div>
    </div>
  );
}

/** What was looked up to answer: each look-up in plain words, the query behind it for those who want to see it. */
function How({ steps }: { steps: Step[] }) {
  const t = useT();
  const lookups = steps.length;
  return (
    <details className="group" data-testid="ask-how">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full border border-ink-200 bg-white px-3 py-1 text-xs font-medium text-ink-600 transition-colors hover:border-ink-300 hover:text-ink-900 [&::-webkit-details-marker]:hidden">
        <ShieldCheck className="size-3.5 text-brand-600" aria-hidden="true" />
        <span>{t("ask.how")}</span>
        {lookups > 0 && <span className="text-ink-400">· {t(lookups === 1 ? "ask.lookupsOne" : "ask.lookups", { count: lookups })}</span>}
        <ChevronRight className="size-3.5 text-ink-400 transition-transform group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="mt-2 rounded-2xl border border-ink-200 bg-white px-4 py-3 text-sm">
        {steps.length === 0 ? (
          <p className="text-ink-600">{t("ask.howNone")}</p>
        ) : (
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li key={i}>
                <StepLine step={s} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

/** While the answer is being worked out: what is happening now, and the look-ups already done. */
function Working({ turn }: { turn: Turn }) {
  const t = useT();
  return (
    <div className="space-y-2" data-testid="ask-working">
      <p className="flex items-center gap-2 text-sm">
        <span className="relative flex size-2.5" aria-hidden="true">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-400 opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-brand-500" />
        </span>
        <span className="ask-shimmer font-medium">{t(`ask.working.${turn.working?.what ?? "thinking"}`)}</span>
        {turn.working?.note ? <span className="min-w-0 truncate text-ink-400">{turn.working.note}</span> : null}
      </p>
      {turn.steps.length > 0 && (
        <ol className="ml-1 space-y-1.5 border-l border-ink-200 pl-4 text-xs text-ink-500">
          {turn.steps.map((s, i) => (
            <li key={i} className="flex animate-rise items-center gap-1.5">
              {s.kind === "sql" && !s.ok ? <Lock className="size-3 text-gold-600" aria-hidden="true" /> : <Check className="size-3 text-brand-600" aria-hidden="true" />}
              <span className="truncate">{s.kind === "documents" ? `${t("ask.howDocuments")}: ${s.query}` : s.purpose || t("ask.howRecords")}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Mark({ size = "sm" }: { size?: "sm" | "lg" }) {
  return (
    <span
      className={cn("ask-mark flex shrink-0 items-center justify-center text-white shadow-[0_6px_20px_-6px_rgb(17_101_65_/_0.55)]", size === "lg" ? "size-14 rounded-2xl" : "size-8 rounded-full")}
      aria-hidden="true"
    >
      <Sparkles className={size === "lg" ? "size-7" : "size-4"} />
    </span>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="flex size-8 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900">
      {children}
    </button>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────────────────────────────────────────

export function AskChat({
  suggestions,
  practice,
  greeting,
  service,
  canWriteDocs,
}: {
  suggestions: string[];
  practice: boolean;
  /** "Good morning, Asha" — worked out on the server in India time. */
  greeting: string;
  /** The AI service that answers, as people know it ("Gemini"). */
  service: string;
  canWriteDocs: boolean;
}) {
  const t = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const nextId = useRef(1);
  const busy = turns.some((x) => x.state === "working");
  const empty = turns.length === 0;

  const scrollToEnd = useCallback((smooth = true) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Follow the answer as it is written, unless the person has scrolled up to read.
  useLayoutEffect(() => {
    if (stick.current && turns.length) scrollToEnd(false);
  }, [turns, scrollToEnd]);

  // Leaving the screen stops a question that is still being answered.
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The question box grows with what is typed, up to a few lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAtBottom(near);
  }

  const patch = (id: number, change: (turn: Turn) => Turn) => setTurns((all) => all.map((x) => (x.id === id ? change(x) : x)));

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const id = nextId.current++;
    // What was said before, so "and last year?" is understood. Only words: access is decided afresh for every question.
    const history = turns
      .filter((x) => x.state === "done" && x.answer)
      .slice(-6)
      .flatMap((x) => [
        { role: "user" as const, text: x.question.slice(0, 8000) },
        { role: "assistant" as const, text: x.answer.slice(0, 8000) },
      ]);
    stick.current = true;
    setTurns((all) => [...all, { id, question: q, answer: "", steps: [], table: null, state: "working", working: { what: "thinking" } }]);
    setText("");
    const controller = new AbortController();
    abort.current = controller;
    const fail = (message: string) => patch(id, (x) => ({ ...x, state: "error", error: message, working: undefined }));

    try {
      const res = await fetch("/api/v1/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, history }),
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (res.status === 401) {
        // The session ended: a full page load drops every cached screen.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = "/login?reason=timeout";
        return;
      }
      if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("ndjson")) {
        const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        fail(payload?.error?.message ?? t("ask.errors.failed"));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      const handle = (e: StreamEvent) => {
        if (e.type === "working") patch(id, (x) => ({ ...x, working: { what: e.what, note: e.note } }));
        else if (e.type === "text") patch(id, (x) => ({ ...x, answer: x.answer + e.delta }));
        else if (e.type === "clear") patch(id, (x) => ({ ...x, answer: "" }));
        else if (e.type === "step") patch(id, (x) => ({ ...x, steps: [...x.steps, e.step] }));
        else if (e.type === "done") {
          finished = true;
          patch(id, (x) => ({ ...x, answer: e.answer, steps: e.steps, table: e.table, state: "done", working: undefined }));
        } else if (e.type === "error") {
          finished = true;
          fail(e.message);
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            try {
              handle(JSON.parse(line) as StreamEvent);
            } catch {
              /* a broken line is skipped; the end of the stream decides */
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
      if (!finished) fail(t("ask.errors.failed"));
    } catch {
      if (controller.signal.aborted) patch(id, (x) => ({ ...x, state: "stopped", working: undefined }));
      else fail(t("ask.errors.unreachable"));
    } finally {
      if (abort.current === controller) abort.current = null;
      inputRef.current?.focus();
    }
  }

  async function copy(turn: Turn) {
    try {
      await navigator.clipboard.writeText(turn.answer);
      setCopied(turn.id);
      setTimeout(() => setCopied((c) => (c === turn.id ? null : c)), 1500);
    } catch {
      /* the clipboard is not available: nothing to do */
    }
  }

  function newChat() {
    abort.current?.abort();
    setTurns([]);
    setText("");
    stick.current = true;
    inputRef.current?.focus();
  }

  const lastId = turns[turns.length - 1]?.id;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ask-chat">
      <h1 className="sr-only">{t("ask.title")}</h1>

      {/* The screen's own bar: which service answers, the Board's documents, a new conversation. */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-200/70 bg-canvas/80 px-4 backdrop-blur sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Mark />
          <span className="truncate text-[0.95rem] font-semibold text-ink-900">{t("ask.title")}</span>
          {practice ? (
            <span className="hidden shrink-0 rounded-full border border-gold-500/30 bg-gold-50 px-2 py-0.5 text-xs font-medium text-gold-600 sm:inline">{t("ask.service.practice")}</span>
          ) : (
            <span className="hidden shrink-0 rounded-full border border-ink-200 bg-white px-2 py-0.5 text-xs font-medium text-ink-600 sm:inline" data-testid="ask-service">
              {service}
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {canWriteDocs && (
            <Link href="/ask/documents" className="inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900">
              <FileText className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("ask.knowledge.title")}</span>
            </Link>
          )}
          {!empty && (
            <button type="button" onClick={newChat} className="inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900">
              <SquarePen className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("ask.newChat")}</span>
            </button>
          )}
        </div>
      </div>

      {/* The conversation scrolls; the question box stays at the bottom. */}
      <div ref={scroller} onScroll={onScroll} className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className="relative mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-4 py-10 sm:px-6">
            <div className="pointer-events-none absolute inset-x-0 top-0 -z-0 mx-auto h-72 max-w-xl animate-glow rounded-full bg-[radial-gradient(closest-side,rgb(64_183_124_/_0.18),transparent)] blur-2xl" aria-hidden="true" />
            <div className="relative animate-rise text-center">
              <div className="flex justify-center">
                <Mark size="lg" />
              </div>
              <h2 className="mt-6 text-balance text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl">{greeting}</h2>
              <p className="mx-auto mt-3 max-w-xl text-balance text-[0.95rem] leading-relaxed text-ink-600">{t("ask.heroHelp")}</p>
              {practice && (
                <p className="mx-auto mt-4 inline-flex items-start gap-2 rounded-full border border-gold-500/30 bg-gold-50 px-3 py-1.5 text-left text-xs font-medium text-gold-600">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" /> {t("ask.practice")}
                </p>
              )}
            </div>
            <div className="relative mt-8">
              <p className="mb-3 text-center text-xs font-medium uppercase tracking-wider text-ink-500">{t("ask.tryAsking")}</p>
              <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 max-sm:[&>li:nth-child(n+5)]:hidden">
                {suggestions.map((key, i) => {
                  const label = tDynamic(t, `ask.suggestions.${key}`);
                  const Icon = SUGGESTION_ICONS[key] ?? Sparkles;
                  return (
                    <li key={key} className="animate-rise" style={{ animationDelay: `${80 + i * 50}ms` }}>
                      <button
                        type="button"
                        onClick={() => ask(label)}
                        className="group flex h-full w-full items-start gap-3 rounded-2xl border border-ink-200 bg-white px-4 py-3.5 text-left shadow-card transition-all hover:-translate-y-px hover:border-brand-300 hover:shadow-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-100" aria-hidden="true">
                          <Icon className="size-4" />
                        </span>
                        <span className="pt-1 text-sm leading-snug text-ink-800">{label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-6 flex items-start justify-center gap-2 text-center text-xs leading-relaxed text-ink-500">
                <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> <span className="max-w-xl">{t("ask.privacy")}</span>
              </p>
            </div>
          </div>
        ) : (
          <ol className="mx-auto w-full max-w-3xl space-y-8 px-4 pb-10 pt-8 sm:px-6" aria-live="polite">
            {turns.map((turn) => (
              <li key={turn.id} className="space-y-5" data-testid="ask-turn">
                <div className="flex animate-rise justify-end">
                  <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl rounded-br-lg bg-ink-100 px-5 py-3 text-[0.96875rem] leading-relaxed text-ink-900">
                    <span className="sr-only">{t("ask.you")}: </span>
                    {turn.question}
                  </p>
                </div>
                <div className="flex animate-rise gap-3 sm:gap-4">
                  <Mark />
                  <div className="min-w-0 flex-1 space-y-4 pt-1">
                    <span className="sr-only">{t("ask.assistant")}: </span>
                    {turn.state === "working" && <Working turn={turn} />}
                    {turn.state === "done" && <How steps={turn.steps} />}
                    {turn.answer && (
                      <div data-testid="ask-answer">
                        <Answer text={turn.answer} writing={turn.state === "working"} />
                      </div>
                    )}
                    {turn.state === "error" && (
                      <div className="flex flex-wrap items-start gap-3 rounded-2xl border border-red-200 bg-red-50/70 px-4 py-3 text-sm text-red-800" role="alert" data-testid="ask-error">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">{turn.error}</span>
                        {turn.id === lastId && (
                          <button type="button" onClick={() => ask(turn.question)} className="inline-flex items-center gap-1.5 text-sm font-medium text-red-800 underline-offset-2 hover:underline">
                            <RotateCcw className="size-3.5" aria-hidden="true" /> {t("ask.retry")}
                          </button>
                        )}
                      </div>
                    )}
                    {turn.state === "stopped" && <p className="text-sm italic text-ink-500">{t("ask.errors.stopped")}</p>}
                    {turn.state === "done" && (
                      <>
                        {turn.table && <Rows table={turn.table} />}
                        <div className="-ml-1.5 flex items-center gap-0.5">
                          <IconButton label={copied === turn.id ? t("ask.copied") : t("ask.copy")} onClick={() => copy(turn)}>
                            {copied === turn.id ? <Check className="size-4 text-brand-600" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
                          </IconButton>
                          {turn.id === lastId && !busy && (
                            <IconButton label={t("ask.retry")} onClick={() => ask(turn.question)}>
                              <RotateCcw className="size-4" aria-hidden="true" />
                            </IconButton>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* The question box, always at the bottom. */}
      <div className="relative shrink-0 px-3 pb-3 pt-1 sm:px-6 sm:pb-4">
        <div className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-linear-to-t from-canvas to-transparent" aria-hidden="true" />
        {!atBottom && !empty && (
          <button
            type="button"
            onClick={() => {
              stick.current = true;
              scrollToEnd();
            }}
            aria-label={t("ask.scrollDown")}
            title={t("ask.scrollDown")}
            className="absolute -top-12 left-1/2 flex size-9 -translate-x-1/2 animate-fade-in items-center justify-center rounded-full border border-ink-200 bg-white text-ink-700 shadow-raised transition-colors hover:bg-ink-50"
          >
            <ArrowDown className="size-4" aria-hidden="true" />
          </button>
        )}
        <form
          className="mx-auto w-full max-w-3xl rounded-[1.75rem] border border-ink-200 bg-white p-2 shadow-[0_10px_40px_-12px_rgb(15_32_24_/_0.18),0_2px_6px_-2px_rgb(15_32_24_/_0.06)] transition-shadow focus-within:border-brand-400 focus-within:shadow-[0_10px_40px_-12px_rgb(17_101_65_/_0.28),0_0_0_4px_rgb(211_243_224)]"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(text);
          }}
        >
          <label htmlFor="ask-question" className="sr-only">
            {t("ask.placeholder")}
          </label>
          <textarea
            id="ask-question"
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_QUESTION))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask(text);
              }
            }}
            rows={1}
            placeholder={t("ask.placeholder")}
            className="block max-h-[200px] min-h-12 w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[0.96875rem] leading-relaxed text-ink-900 placeholder:text-ink-400 focus:outline-none"
          />
          <div className="flex items-center justify-between gap-2 pl-3.5">
            <p className="hidden items-center gap-1.5 text-xs text-ink-400 sm:flex">
              <ShieldCheck className="size-3.5" aria-hidden="true" /> {t("ask.scopeNote")}
            </p>
            <div className="ml-auto flex items-center gap-2">
              {text.length > MAX_QUESTION - 200 && <span className="tabular text-xs text-ink-400">{MAX_QUESTION - text.length}</span>}
              {busy ? (
                <button type="button" onClick={() => abort.current?.abort()} aria-label={t("ask.stop")} title={t("ask.stop")} className="flex size-10 items-center justify-center rounded-full bg-ink-900 text-white transition-colors hover:bg-ink-800">
                  <Square className="size-3.5 fill-current" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!text.trim()}
                  aria-label={t("ask.send")}
                  title={t("ask.send")}
                  className="flex size-10 items-center justify-center rounded-full bg-brand-700 text-white shadow-[0_4px_14px_-4px_rgb(17_101_65_/_0.6)] transition-all hover:bg-brand-800 disabled:bg-ink-200 disabled:text-ink-400 disabled:shadow-none"
                >
                  <ArrowUp className="size-5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </form>
        <p className="mx-auto mt-2 max-w-3xl px-2 text-center text-[0.7rem] leading-relaxed text-ink-500">{t("ask.checkNote")}</p>
      </div>
    </div>
  );
}
