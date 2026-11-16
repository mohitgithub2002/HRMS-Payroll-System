import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Simple way of working: items sent for approval while one request is handled are remembered here, so that the
 * request can finish them itself when the person who made them is also the one who decides them (see
 * `approveDirectly` in the engine). Outside a request (the seed, the tests, daily jobs) nothing is remembered.
 */
const store = new AsyncLocalStorage<{ taskIds: string[] }>();

export function collectSubmitted<T>(fn: () => Promise<T>): Promise<{ result: T; taskIds: string[] }> {
  const box = { taskIds: [] as string[] };
  return store.run(box, async () => ({ result: await fn(), taskIds: box.taskIds }));
}

export function noteSubmitted(taskId: string) {
  store.getStore()?.taskIds.push(taskId);
}
