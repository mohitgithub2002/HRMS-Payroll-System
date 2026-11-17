import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomToken, sha256 } from "./crypto";
import { db } from "./db";
import { env } from "./env";
import { AppError } from "./errors";

/**
 * File storage for uploaded documents and generated files. Keys are always generated here
 * ("<area>/<yyyy>/<mm>/<random>.<ext>"), so a key can never point outside the storage folder.
 */
export type FileKind = "pdf" | "png" | "jpg" | "xlsx" | "csv" | "txt" | "zip" | "bin";

const MIME: Record<FileKind, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  zip: "application/zip",
  bin: "application/octet-stream",
};

export const mimeOf = (kind: FileKind) => MIME[kind];

/** Recognises a file by its first bytes, not by its name (a renamed .exe is not a PDF). */
export function sniff(buffer: Buffer): FileKind | null {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return "xlsx";
  return null;
}

const KEY_RE = /^[a-z-]+\/\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.[a-z0-9]+$/;

function root() {
  return path.resolve(env().STORAGE_DIR);
}

export async function saveFile(area: string, buffer: Buffer, ext: FileKind) {
  const now = new Date();
  const key = `${area}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomToken(18)}.${ext}`;
  if (env().STORAGE_DRIVER === "database") {
    await db.storedFile.create({ data: { key, data: new Uint8Array(buffer), size: buffer.length } });
  } else {
    const full = path.join(root(), key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buffer, { mode: 0o640 });
  }
  return { key, sha256: sha256(buffer), size: buffer.length };
}

/**
 * A stored file's contents. Looked for where files are kept now, then in the other place (a copy that changed its
 * STORAGE_DRIVER, or demo data written by the seed). A file in neither is reported in plain words, not as a crash.
 */
export async function loadFile(key: string): Promise<Buffer> {
  if (!KEY_RE.test(key)) throw new Error("Bad storage key");
  const fromDb = async () => {
    const row = await db.storedFile.findUnique({ where: { key }, select: { data: true } });
    return row ? Buffer.from(row.data) : null;
  };
  const fromDisk = () => readFile(path.join(root(), key)).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
  const found = env().STORAGE_DRIVER === "database" ? ((await fromDb()) ?? (await fromDisk())) : ((await fromDisk()) ?? (await fromDb()));
  if (!found) throw new AppError(410, "file_gone", "errors.fileGone");
  return found;
}
