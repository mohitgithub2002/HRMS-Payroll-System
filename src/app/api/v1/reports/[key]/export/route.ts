import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { fileResponse } from "@/lib/api/files";
import { getLocale } from "@/lib/i18n/server";
import { exportReport } from "@/modules/reports/export";

/** Some files are built on request (a PDF needs a headless Chrome, slow to start on a fresh Vercel instance). */
export const maxDuration = 60;

const q = z.object({ format: z.enum(["xlsx", "pdf"]), month: z.string().optional(), section: z.string().optional(), type: z.string().optional() });

/** S-70: a report as Excel or PDF, in the login's language; every download is in the audit trail. */
export const GET = apiRoute<{ key: string }>(async ({ actor, params, query }) => {
  const { format, ...filters } = query(q);
  const { buffer, fileName, mimeType } = await exportReport(actor, params.key, format, filters, await getLocale());
  return fileResponse(buffer, { fileName, mimeType, inline: format === "pdf" });
});
