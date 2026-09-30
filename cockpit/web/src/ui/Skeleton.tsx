// Loading placeholders: shimmering shapes where content will land. Only
// placeholders shimmer (never real content), and prefers-reduced-motion holds
// them still. The region is announced once as "Loading".
export function Skeleton({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={`flex flex-col gap-2.5 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skel block h-3.5" style={{ width: `${[92, 76, 58, 84, 66][i % 5]}%` }} />
      ))}
    </div>
  );
}

/** A row-shaped placeholder: a title bar and a meta bar. */
export function SkeletonRow() {
  return (
    <div aria-hidden className="flex items-center gap-3 min-h-14 px-4">
      <span className="flex-1 flex flex-col gap-2">
        <span className="skel block h-4 w-2/5" />
        <span className="skel block h-3 w-3/5" />
      </span>
    </div>
  );
}
