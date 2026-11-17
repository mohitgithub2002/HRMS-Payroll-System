"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronRight, Copy, Download, FileText, Lock, Sparkles, Square, Table2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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

function Rich({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "bold" ? (
          <strong key={i} className="font-semibold text-ink-900">
            {p.text}
          </strong>
        ) : p.kind === "code" ? (
          <code key={i} className="rounded bg-ink-100 px-1 py-0.5 text-[0.85em]">
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
function Answer({ text }: { text: string }) {
  const blocks = parseAnswer(text);
  return (
    <div className="space-y-3 text-[0.95rem] leading-relaxed text-ink-800">
      {blocks.map((b, i) => {
        if (b.kind === "p") {
          return (
            <p key={i} className="break-words">
              {b.lines.map((line, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  <Rich parts={line} />
                </span>
              ))}
            </p>
          );
        }
        if ("items" in b) {
          const List = b.kind;
          return (
            <List key={i} className={cn("space-y-1 pl-5", b.kind === "ul" ? "list-disc" : "list-decimal")}>
              {b.items.map((item, j) => (
                <li key={j} className="break-words">
                  <Rich parts={item} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <div key={i} className="overflow-x-auto rounded-xl border border-ink-200" tabIndex={0}>
            <table className="w-full min-w-max border-collapse text-sm">
              <thead>
                <tr className="bg-ink-50 text-left">
                  {b.head.map((h, j) => (
                    <th key={j} scope="col" className="whitespace-nowrap px-3 py-2 font-semibold text-ink-700">
                      <Rich parts={h} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, j) => (
                  <tr key={j} className="border-t border-ink-100">
                    {row.map((c, k) => (
                      <td key={k} className="px-3 py-2 align-top text-ink-800">
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
    <details className="group rounded-xl border border-ink-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium text-ink-700 hover:text-ink-900">
        <ChevronRight className="size-4 text-ink-400 transition-transform group-open:rotate-90" aria-hidden="true" />
        <Table2 className="size-4 text-ink-400" aria-hidden="true" />
        {t("ask.tableTitle", { count: table.rows.length })}
      </summary>
      <div className="border-t border-ink-100">
        <div className="max-h-96 overflow-auto" tabIndex={0}>
          <table className="w-full min-w-max border-collapse text-sm">
            <thead className="sticky top-0 bg-ink-50">
              <tr>
                {table.columns.map((c, i) => (
                  <th key={i} scope="col" className={cn("whitespace-nowrap px-3 py-2 font-semibold text-ink-700", c.kind === "number" ? "text-right" : "text-left")}>
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i} className="border-t border-ink-100">
                  {r.map((c, j) => (
                    <td key={j} className={cn("whitespace-nowrap px-3 py-1.5 text-ink-800", table.columns[j]?.kind === "number" && "tabular text-right")}>
                      {c === null ? <span className="text-ink-300">—</span> : typeof c === "number" ? c.toLocaleString("en-IN") : cellText(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 px-3 py-2">
          <p className="text-xs text-ink-500">{table.truncated ? t("ask.tableMore", { count: table.rows.length }) : ""}</p>
          <Button size="sm" variant="ghost" icon={<Download className="size-4" aria-hidden="true" />} onClick={() => downloadCsv(table)}>
            {t("ask.download")}
          </Button>
        </div>
      </div>
    </details>
  );
}

/** What was looked up to answer: each look-up in plain words, the query behind it for those who want to see it. */
function How({ steps }: { steps: Step[] }) {
  const t = useT();
  return (
    <details className="group rounded-xl border border-ink-200 bg-white" data-testid="ask-how">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium text-ink-700 hover:text-ink-900">
        <ChevronRight className="size-4 text-ink-400 transition-transform group-open:rotate-90" aria-hidden="true" />
        {t("ask.how")}
      </summary>
      <div className="border-t border-ink-100 px-3 py-3">
        {steps.length === 0 ? (
          <p className="text-sm text-ink-600">{t("ask.howNone")}</p>
        ) : (
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li key={i} className="text-sm">
                {s.kind === "documents" ? (
                  <div className="flex items-start gap-2">
                    <FileText className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="break-words text-ink-800">
                        {t("ask.howDocuments")}: <span className="text-ink-600">{s.query}</span>
                      </p>
                      {s.found.length > 0 && <p className="break-words text-xs text-ink-500">{s.found.join(" · ")}</p>}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    {s.ok ? <Table2 className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" /> : <Lock className="mt-0.5 size-4 shrink-0 text-gold-600" aria-hidden="true" />}
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-ink-800">
                        {s.purpose || t("ask.howRecords")}
                        <span className="ml-2 text-xs text-ink-500">{s.ok ? t(s.truncated ? "ask.howRowsMore" : "ask.howRows", { count: s.rows }) : t("ask.howRefused")}</span>
                      </p>
                      {!s.ok && <p className="break-words text-xs text-ink-500">{s.reason}</p>}
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-brand-700 hover:underline">{t("ask.showSql")}</summary>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-ink-50 p-2 text-xs text-ink-700">{s.sql}</pre>
                      </details>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

export function AskChat({ suggestions, practice, phoneNav }: { suggestions: string[]; practice: boolean; /** The phone bottom bar is shown (employees): keep the question box above it. */ phoneNav: boolean }) {
  const t = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(1);
  const busy = turns.some((x) => x.state === "working");

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns]);
  // Leaving the screen stops a question that is still being answered.
  useEffect(() => () => abort.current?.abort(), []);

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

  const empty = turns.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col" data-testid="ask-chat">
      {practice && (
        <p className="mb-4 flex items-start gap-2 rounded-xl border border-gold-500/30 bg-gold-50 px-3 py-2 text-sm text-gold-600">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {t("ask.practice")}
        </p>
      )}

      {empty ? (
        <div className="rounded-2xl border border-ink-200/80 bg-white p-5 shadow-card sm:p-6">
          <p className="flex items-center gap-2 text-sm font-medium text-ink-700">
            <Sparkles className="size-4 text-brand-600" aria-hidden="true" /> {t("ask.tryAsking")}
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {suggestions.map((key) => {
              const label = tDynamic(t, `ask.suggestions.${key}`);
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => ask(label)}
                    className="h-full w-full rounded-xl border border-ink-200 px-3.5 py-2.5 text-left text-sm text-ink-800 transition-colors hover:border-brand-400 hover:bg-brand-50/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                  >
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <ol className="space-y-6" aria-live="polite">
          {turns.map((turn) => (
            <li key={turn.id} className="space-y-3" data-testid="ask-turn">
              <div className="flex justify-end">
                <p className="max-w-[90%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-700 px-4 py-2.5 text-[0.95rem] text-white">
                  <span className="sr-only">{t("ask.you")}: </span>
                  {turn.question}
                </p>
              </div>
              <div className="rounded-2xl rounded-bl-md border border-ink-200/80 bg-white px-4 py-3.5 shadow-card sm:px-5">
                <span className="sr-only">{t("ask.assistant")}: </span>
                {turn.answer && (
                  <div data-testid="ask-answer">
                    <Answer text={turn.answer} />
                  </div>
                )}
                {turn.state === "working" && (
                  <p className={cn("flex items-center gap-2 text-sm text-ink-500", turn.answer && "mt-3")} data-testid="ask-working">
                    <Spinner className="size-4 text-brand-600" />
                    <span className="min-w-0 break-words">
                      {t(`ask.working.${turn.working?.what ?? "thinking"}`)}
                      {turn.working?.note ? <span className="text-ink-400"> {turn.working.note}</span> : null}
                    </span>
                  </p>
                )}
                {turn.state === "error" && (
                  <p className="flex items-start gap-2 text-sm text-red-700" role="alert" data-testid="ask-error">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {turn.error}
                  </p>
                )}
                {turn.state === "stopped" && <p className={cn("text-sm text-ink-500", turn.answer && "mt-3")}>{t("ask.errors.stopped")}</p>}
                {turn.state === "done" && (
                  <div className="mt-4 space-y-2">
                    {turn.table && <Rows table={turn.table} />}
                    <How steps={turn.steps} />
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <p className="text-xs text-ink-500">{t("ask.checkNote")}</p>
                      <Button size="sm" variant="ghost" icon={copied === turn.id ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />} onClick={() => copy(turn)}>
                        {copied === turn.id ? t("ask.copied") : t("ask.copy")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <div ref={endRef} />

      <form
        className={cn("sticky z-10 mt-6 rounded-2xl border border-ink-200 bg-white p-2 shadow-raised focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-100 lg:bottom-4", phoneNav ? "bottom-20" : "bottom-4")}
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <div className="flex items-end gap-2">
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
            rows={Math.min(6, Math.max(1, text.split("\n").length))}
            placeholder={t("ask.placeholder")}
            className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-3 py-2.5 text-[0.95rem] text-ink-900 placeholder:text-ink-400 focus:outline-none"
          />
          {busy ? (
            <Button variant="secondary" onClick={() => abort.current?.abort()} icon={<Square className="size-3.5" aria-hidden="true" />}>
              {t("ask.stop")}
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={!text.trim()} icon={<ArrowUp className="size-4" aria-hidden="true" />}>
              {t("ask.send")}
            </Button>
          )}
        </div>
      </form>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-xs text-ink-500">{t("ask.privacy")}</p>
        {!empty && !busy && (
          <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setTurns([])}>
            {t("ask.newChat")}
          </button>
        )}
      </div>
    </div>
  );
}
