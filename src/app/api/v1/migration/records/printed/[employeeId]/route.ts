import { apiRoute } from "@/lib/api/route";
import { fileResponse } from "@/lib/api/files";
import { verificationSheetPdf } from "@/modules/migration/verify";

/** A PDF is drawn by a headless Chrome; on a fresh Vercel instance starting it takes several seconds. */
export const maxDuration = 60;

/** The printed record sheet for a person who does not use the system. */
export const GET = apiRoute<{ employeeId: string }>(async ({ actor, params }) => {
  const { pdf, fileName } = await verificationSheetPdf(actor, params.employeeId);
  return fileResponse(pdf, { fileName, mimeType: "application/pdf", inline: true });
});
