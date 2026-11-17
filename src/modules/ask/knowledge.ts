import "server-only";
import { z } from "zod";
import { audit, diff } from "@/lib/audit";
import { canManageKnowledge, knowledgeAudiences } from "@/lib/auth/access";
import type { Actor } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import { emit } from "@/lib/outbox";
import { findPassages, type Passage } from "./passages";

/**
 * Ask AI: the Board's own documents — policies, office orders, circulars, how-to notes — kept as text. Each document
 * says who may read it (everyone, office staff, or the Admin); Ask AI quotes only from documents the person asking
 * may read. Written by the Board's Admin (and the HR manager in the simple way of working); every change is audited.
 */
export const KNOWLEDGE_CATEGORIES = ["POLICY", "ORDER", "CIRCULAR", "RULES", "HOWTO", "OTHER"] as const;
export const KNOWLEDGE_AUDIENCES = ["EVERYONE", "STAFF", "ADMIN"] as const;
export const MAX_DOC_CHARS = 60_000;
const MAX_READ_CHARS = 12_000;

export const knowledgeSchema = z.object({
  title: z.string().trim().min(3, "validation.tooShort").max(150),
  category: z.enum(KNOWLEDGE_CATEGORIES),
  reference: z.string().trim().max(120).optional().default(""),
  body: z.string().trim().min(20, "validation.tooShort").max(MAX_DOC_CHARS),
  audience: z.enum(KNOWLEDGE_AUDIENCES),
  isActive: z.boolean().optional().default(true),
});
export type KnowledgeInput = z.infer<typeof knowledgeSchema>;

const who = (actor: Actor) => ({ ...actor, name: actor.name });

/** The list for the people who write the documents (everything, switched-off ones too). */
export async function listKnowledge(actor: Actor) {
  if (!canManageKnowledge(actor)) throw forbidden();
  const rows = await db.knowledgeDoc.findMany({ where: { boardId: actor.boardId }, orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }] });
  return rows.map((r) => ({ ...r, chars: r.body.length, body: undefined }));
}

export async function getKnowledge(actor: Actor, id: string) {
  if (!canManageKnowledge(actor)) throw forbidden();
  const row = await db.knowledgeDoc.findFirst({ where: { id, boardId: actor.boardId } });
  if (!row) throw notFound();
  return row;
}

export async function createKnowledge(actor: Actor, raw: unknown) {
  if (!canManageKnowledge(actor)) throw forbidden();
  const input = knowledgeSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const doc = await tx.knowledgeDoc.create({
      data: { boardId: actor.boardId, title: input.title, category: input.category, reference: input.reference || null, body: input.body, audience: input.audience, isActive: input.isActive, createdById: actor.userId, createdByName: actor.name },
    });
    await audit(tx, who(actor), {
      action: "CREATE",
      entityType: "KnowledgeDoc",
      entityId: doc.id,
      summary: `Added the document "${doc.title}" for Ask AI`,
      newValue: { title: doc.title, category: doc.category, reference: doc.reference, audience: doc.audience, isActive: doc.isActive, chars: doc.body.length },
    });
    await emit(tx, actor.boardId, "knowledge.created", { type: "KnowledgeDoc", id: doc.id }, { title: doc.title, audience: doc.audience });
    return { id: doc.id };
  });
}

export async function updateKnowledge(actor: Actor, id: string, raw: unknown) {
  if (!canManageKnowledge(actor)) throw forbidden();
  const input = knowledgeSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const before = await tx.knowledgeDoc.findFirst({ where: { id, boardId: actor.boardId } });
    if (!before) throw notFound();
    const data = { title: input.title, category: input.category, reference: input.reference || null, audience: input.audience, isActive: input.isActive };
    const changes = diff({ title: before.title, category: before.category, reference: before.reference, audience: before.audience, isActive: before.isActive } as Record<string, unknown>, data);
    const textChanged = before.body !== input.body;
    await tx.knowledgeDoc.update({ where: { id }, data: { ...data, body: input.body, updatedById: actor.userId, updatedByName: actor.name } });
    await audit(tx, who(actor), {
      action: "UPDATE",
      entityType: "KnowledgeDoc",
      entityId: id,
      summary: `Changed the document "${input.title}" for Ask AI`,
      oldValue: { ...changes.oldValue, ...(textChanged ? { chars: before.body.length } : {}) },
      newValue: { ...changes.newValue, ...(textChanged ? { chars: input.body.length } : {}) },
    });
    await emit(tx, actor.boardId, "knowledge.updated", { type: "KnowledgeDoc", id }, { title: input.title, audience: input.audience, isActive: input.isActive });
    return { id };
  });
}

export async function deleteKnowledge(actor: Actor, id: string) {
  if (!canManageKnowledge(actor)) throw forbidden();
  return db.$transaction(async (tx) => {
    const before = await tx.knowledgeDoc.findFirst({ where: { id, boardId: actor.boardId } });
    if (!before) throw notFound();
    await tx.knowledgeDoc.delete({ where: { id } });
    await audit(tx, who(actor), {
      action: "DELETE",
      entityType: "KnowledgeDoc",
      entityId: id,
      summary: `Removed the document "${before.title}" from Ask AI`,
      oldValue: { title: before.title, category: before.category, reference: before.reference, audience: before.audience, chars: before.body.length },
    });
    await emit(tx, actor.boardId, "knowledge.deleted", { type: "KnowledgeDoc", id }, { title: before.title });
    return { id };
  });
}

// ── Reading, for Ask AI ───────────────────────────────────────────────────────────────────────────────────────────

/** Switched-on documents this person may read. */
function readable(actor: Actor) {
  return { boardId: actor.boardId, isActive: true, audience: { in: knowledgeAudiences(actor) } };
}

/** Titles only — the model is told what there is to search. */
export async function knowledgeTitles(actor: Actor) {
  return db.knowledgeDoc.findMany({ where: readable(actor), select: { id: true, title: true, category: true, reference: true }, orderBy: { title: "asc" }, take: 80 });
}

export async function searchKnowledge(actor: Actor, query: string, limit = 5): Promise<Passage[]> {
  const docs = await db.knowledgeDoc.findMany({ where: readable(actor), select: { id: true, title: true, category: true, reference: true, body: true }, take: 500 });
  return findPassages(query, docs, limit);
}

/** One whole document (long ones are cut, and say so). Null when it is not there for this person. */
export async function readKnowledge(actor: Actor, id: string) {
  const doc = await db.knowledgeDoc.findFirst({ where: { ...readable(actor), id }, select: { id: true, title: true, category: true, reference: true, body: true } });
  if (!doc) return null;
  const cut = doc.body.length > MAX_READ_CHARS;
  return { ...doc, body: cut ? doc.body.slice(0, MAX_READ_CHARS) : doc.body, cut };
}
