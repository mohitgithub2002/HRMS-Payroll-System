import { apiRoute } from "@/lib/api/route";
import { payRun } from "@/modules/payroll/simple";

/** The simple way of working (payroll/simple.ts). */
export const POST = apiRoute<{ id: string }>(async ({ actor, params }) => {
  await payRun(actor, params.id);
  return { id: params.id };
});
