import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { loadFile, saveFile } from "@/lib/storage";
import { hasTestDb } from "../support/factory";

/**
 * Where file contents are kept: on disk (the Board's server) or in the database (Vercel, whose disk is not kept between
 * requests — a bank file made in one request could not be downloaded in the next). Either way a file is found where it
 * is, and a missing one is said in words.
 */
describe.skipIf(!hasTestDb)("file storage", () => {
  const settings = env() as { STORAGE_DRIVER: "disk" | "database"; STORAGE_DIR: string };
  const original = settings.STORAGE_DRIVER;
  const bytes = Buffer.from("%PDF-1.4 test file\n" + "x".repeat(5000));
  afterAll(() => {
    settings.STORAGE_DRIVER = original;
  });

  it("on disk: saved and read back; nothing in the database", async () => {
    settings.STORAGE_DRIVER = "disk";
    const saved = await saveFile("files", bytes, "pdf");
    expect(saved.size).toBe(bytes.length);
    expect(Buffer.compare(await loadFile(saved.key), bytes)).toBe(0);
    expect(await db.storedFile.count({ where: { key: saved.key } })).toBe(0);
  });

  it("in the database: saved and read back by any server — no disk needed", async () => {
    settings.STORAGE_DRIVER = "database";
    const saved = await saveFile("files", bytes, "xlsx");
    const row = await db.storedFile.findUniqueOrThrow({ where: { key: saved.key } });
    expect(row.size).toBe(bytes.length);
    // Another server with an empty disk still finds it.
    const dir = settings.STORAGE_DIR;
    settings.STORAGE_DIR = path.join(dir, `empty-${Date.now()}`);
    await mkdir(settings.STORAGE_DIR, { recursive: true });
    try {
      expect(Buffer.compare(await loadFile(saved.key), bytes)).toBe(0);
    } finally {
      await rm(settings.STORAGE_DIR, { recursive: true, force: true });
      settings.STORAGE_DIR = dir;
    }
  });

  it("finds a file kept the other way (a copy that changed how it keeps files, or demo files from the seed)", async () => {
    settings.STORAGE_DRIVER = "disk";
    const onDisk = await saveFile("files", bytes, "pdf");
    settings.STORAGE_DRIVER = "database";
    const inDb = await saveFile("files", bytes, "pdf");
    expect(Buffer.compare(await loadFile(onDisk.key), bytes)).toBe(0);
    settings.STORAGE_DRIVER = "disk";
    expect(Buffer.compare(await loadFile(inDb.key), bytes)).toBe(0);
  });

  it("a file in neither place is reported in words (410), not as a crash", async () => {
    await expect(loadFile("files/2001/01/NoSuchFileAnywhere.pdf")).rejects.toMatchObject({ status: 410, code: "file_gone", key: "errors.fileGone" });
    await expect(loadFile("../etc/passwd")).rejects.toThrow("Bad storage key");
  });
});
