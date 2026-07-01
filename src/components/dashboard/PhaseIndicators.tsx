import { Archive, Cpu, Database, FileText, Loader2 } from "lucide-react";

interface PhaseState {
  isProcessing: boolean;
  isDone: boolean;
  progressPct: number;
}

interface PhaseIndicatorsProps {
  parse: PhaseState;
  extract: PhaseState;
  ai: PhaseState;
  render: PhaseState;
}

export function PhaseIndicators({
  parse,
  extract,
  ai,
  render,
}: PhaseIndicatorsProps) {
  const items = [
    { id: "parse", label: "PARSE", icon: Database, ...parse },
    { id: "extract", label: "EXTRACT", icon: Archive, ...extract },
    { id: "ai", label: "AI AUDIT", icon: Cpu, ...ai },
    { id: "render", label: "RENDER", icon: FileText, ...render },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 w-full max-w-2xl mt-8 pt-8 border-t border-slate-700/50">
      {items.map((item) => {
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
            <div className="mt-1 w-full h-1 rounded-full bg-slate-700/70 overflow-hidden">
              <div
                className={`h-full ${progressStyle} transition-all duration-500`}
                style={{ width: `${clampedProgress}%` }}
              />
            </div>
            <span className="text-[10px] font-semibold tabular-nums">
              {clampedProgress}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
