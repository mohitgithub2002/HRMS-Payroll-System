import { z } from "zod";
import { apiRoute } from "@/lib/api/route";
import { isMonth } from "@/lib/dates";
import { finishMonth, payMonth, workOutMonth } from "@/modules/payroll/simple";

const schema = z.object({ month: z.string().refine(isMonth, "validation.invalid"), action: z.enum(["workOut", "pay", "finish"]) });

/** The simple way of working: the whole month's salaries in one go — work out, pay, finish. */
export const POST = apiRoute(async ({ actor, body }) => {
  const input = await body(schema);
  if (input.action === "workOut") return workOutMonth(actor, input.month);
  if (input.action === "pay") return payMonth(actor, input.month);
  return finishMonth(actor, input.month);
});
