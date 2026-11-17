import { apiRoute } from "@/lib/api/route";
import { fileResponse } from "@/lib/api/files";
import { casePpo } from "@/modules/pension/cases";

/** A PDF is drawn by a headless Chrome; on a fresh Vercel instance starting it takes several seconds. */
export const maxDuration = 60;

/** PN-09: the PPO PDF for physical signature. */
export const GET = apiRoute<{ id: string }>(async ({ actor, params }) => {
  const { pdf, fileName } = await casePpo(actor, params.id);
  return fileResponse(pdf, { fileName, mimeType: "application/pdf", inline: true });
});
