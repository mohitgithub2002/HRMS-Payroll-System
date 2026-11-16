/**
 * The simple way of working: the server says when what was just entered counted at once (no second person), so
 * the next "sent for approval" message can say "Saved" instead. Browser only.
 */
let appliedAt = 0;

export function markApplied() {
  appliedAt = Date.now();
}

/** True once, for a message shown right after such a reply. */
export function takeApplied(): boolean {
  const fresh = Date.now() - appliedAt < 5000;
  appliedAt = 0;
  return fresh;
}
