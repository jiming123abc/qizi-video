interface ShotSkeletonProps {
  count?: number;
}

export function ShotSkeleton({ count = 8 }: ShotSkeletonProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-3xl border border-white/5 bg-white/[0.02] overflow-hidden">
          <div className="aspect-video bg-white/[0.03] animate-pulse" />
          <div className="p-3 space-y-2">
            <div className="h-4 bg-white/[0.05] rounded w-3/4 animate-pulse" />
            <div className="h-3 bg-white/[0.03] rounded w-1/2 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}
