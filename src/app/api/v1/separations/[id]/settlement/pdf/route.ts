import { apiRoute } from "@/lib/api/route";
import { fileResponse } from "@/lib/api/files";
import { settlementPdf } from "@/modules/payroll/settlement-pdf";

/** A PDF is drawn by a headless Chrome; on a fresh Vercel instance starting it takes several seconds. */
export const maxDuration = 60;

/** The settlement statement as a PDF, for signature and the personal file. */
export const GET = apiRoute<{ id: string }>(async ({ actor, params }) => {
  const { pdf, fileName } = await settlementPdf(actor, params.id);
  return fileResponse(pdf, { fileName, mimeType: "application/pdf", inline: true });
});
