import {
  Archive,
  Cpu,
  Database,
  FileText,
  FolderOpen,
  Loader2,
  type LucideIcon,
} from "lucide-react";

export interface PhaseItem {
  id: string;
  label: string;
  icon: LucideIcon;
  hasStarted: boolean;
  isProcessing: boolean;
  isDone: boolean;
  progressPct: number;
}

export const PHASE_ICONS = {
  parse: Database,
  extract: Archive,
  ai: Cpu,
  render: FileText,
  files: FolderOpen,
} as const;

const COLS_CLASS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-5",
};

export function PhaseIndicators({ phases }: { phases: PhaseItem[] }) {
  if (phases.length === 0) return null;

  const colsClass = COLS_CLASS[Math.min(phases.length, 5)] || "sm:grid-cols-4";

  return (
    <div
      className={`grid grid-cols-2 ${colsClass} gap-4 w-full max-w-2xl mt-8 pt-8 border-t border-slate-700/50`}
    >
      {phases.map((item) => {
        const clampedProgress = Math.max(0, Math.min(100, item.progressPct));
        const style = item.isProcessing
          ? "bg-indigo-500/10 border-indigo-500/50 text-indigo-400"
          : item.isDone
            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-500"
            : "bg-slate-900 border-slate-800 text-slate-500";
        const progressStyle = item.isProcessing
          ? "bg-indigo-400"
          : item.isDone
            ? "bg-emerald-400"
            : "bg-slate-600";
        const Icon = item.icon;
        return (
          <div
            key={item.id}
            className={`flex flex-col items-center justify-center gap-2 p-4 rounded-2xl border ${style} transition-colors`}
          >
            {item.isProcessing ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Icon className="w-5 h-5" />
            )}
            <span className="text-[10px] font-bold tracking-widest text-center">
              {item.label}
            </span>
            {item.hasStarted && (
              <>
                <div className="mt-1 w-full h-1 rounded-full bg-slate-700/70 overflow-hidden">
                  <div
                    className={`h-full ${progressStyle} transition-all duration-500`}
                    style={{ width: `${clampedProgress}%` }}
                  />
                </div>
                <span className="text-[10px] font-semibold tabular-nums">
                  {clampedProgress}%
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
