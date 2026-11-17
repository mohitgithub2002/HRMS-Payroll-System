import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown the moment a link is clicked, while the next screen is read from the database: the menu and the top bar stay,
 * the page area shows its outline. Without it a click seemed to do nothing until the whole page had arrived.
 */
export default function Loading() {
  return (
    <div className="animate-fade-in" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="mb-6 space-y-2.5">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-ink-200/80 bg-white p-5 shadow-card">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-2xl border border-ink-200/80 bg-white p-5 shadow-card">
        <Skeleton className="h-5 w-40" />
        <div className="mt-5 space-y-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
