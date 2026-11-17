import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { fileResponse } from "@/lib/api/files";
import { gpfStatementPdf } from "@/modules/statutory/gpf";

/** A PDF is drawn by a headless Chrome; on a fresh Vercel instance starting it takes several seconds. */
export const maxDuration = 60;

/** §9 GPF: the annual statement as a PDF (the employee's own, or any for HR & Accounts). */
export const GET = apiRoute<{ employeeId: string }>(async ({ actor, params, query }) => {
  const { fy } = query(z.object({ fy: z.string().regex(/^\d{4}-\d{2}$/) }));
  const { pdf, fileName } = await gpfStatementPdf(actor, params.employeeId, fy);
  return fileResponse(pdf, { fileName, mimeType: "application/pdf", inline: true });
});
