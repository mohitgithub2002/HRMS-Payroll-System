import { apiRoute } from "@/lib/api/route";
import { fileResponse } from "@/lib/api/files";
import { leaveLedgerPdf } from "@/modules/leave/ledger-pdf";

/** A PDF is drawn by a headless Chrome; on a fresh Vercel instance starting it takes several seconds. */
export const maxDuration = 60;

export const GET = apiRoute<{ id: string }>(async ({ actor, params }) => {
  const { pdf, fileName } = await leaveLedgerPdf(actor, params.id);
  return fileResponse(pdf, { fileName, mimeType: "application/pdf", inline: true });
});
