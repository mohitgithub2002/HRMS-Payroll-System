import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { fileResponse } from "@/lib/api/files";
import { bulkPayslipsPdf } from "@/modules/payroll/payslips";

/** A PDF is drawn by a headless Chrome; on a fresh Vercel instance starting it takes several seconds. */
export const maxDuration = 60;

/** SL-05: every payslip of a bill, or of one section, as one PDF. */
export const GET = apiRoute<{ id: string }>(async ({ actor, params, query }) => {
  const q = query(z.object({ section: z.string().optional(), lang: z.enum(["en", "hi"]).optional() }));
  const { pdf, fileName } = await bulkPayslipsPdf(actor, params.id, q.section || undefined, q.lang ?? actor.language);
  return fileResponse(pdf, { fileName, mimeType: "application/pdf", inline: true });
});
