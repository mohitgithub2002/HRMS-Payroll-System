import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { fileResponse } from "@/lib/api/files";
import { payslipPdf } from "@/modules/payroll/payslips";

/** A PDF is drawn by a headless Chrome; on a fresh Vercel instance starting it takes several seconds. */
export const maxDuration = 60;

/** SL-01 to SL-03: one payslip as a PDF, in Hindi or English. */
export const GET = apiRoute<{ id: string }>(async ({ actor, params, query }) => {
  const { lang } = query(z.object({ lang: z.enum(["en", "hi"]).optional() }));
  const { pdf, fileName } = await payslipPdf(actor, params.id, lang ?? actor.language);
  return fileResponse(pdf, { fileName, mimeType: "application/pdf", inline: true });
});
