import "server-only";
import { after } from "next/server";

/**
 * Work that must not hold the response up (payslip e-mails, the day's jobs): it runs once the response has gone.
 * Outside a request (scripts, the seed, tests) there is no "after", so the work is done there and then and the
 * returned promise waits for it. A failure is logged, never thrown — the request it follows has already succeeded.
 */
export function afterResponse(label: string, job: () => Promise<unknown>): Promise<void> {
  const run = () => job().then(() => undefined, (e) => console.error(`[${label}] background job failed`, e));
  try {
    after(run);
    return Promise.resolve();
  } catch {
    return run();
  }
}
