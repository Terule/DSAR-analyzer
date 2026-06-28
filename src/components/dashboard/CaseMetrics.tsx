import { ChevronDown, ChevronUp, Clock, Folder } from "lucide-react";
import { formatBytes } from "@/lib/format";
import type { CaseStats, StagedFile } from "@/lib/types";
import { Duration } from "./Duration";

interface CaseMetricsProps {
  caseFiles: StagedFile[];
  stats: CaseStats;
  isOpen: boolean;
  onToggle: () => void;
}

export function CaseMetrics({
  caseFiles,
  stats,
  isOpen,
  onToggle,
}: CaseMetricsProps) {
  return (
    <div className="w-full mt-8">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-center gap-2 text-[11px] uppercase tracking-widest font-bold text-slate-500 hover:text-slate-300 transition-colors py-2"
      >
        {isOpen ? "Hide Diagnostics" : "View Technical Metrics"}
        {isOpen ? (
          <ChevronUp className="w-3.5 h-3.5" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5" />
        )}
      </button>

      {isOpen && (
        <div className="mt-6 space-y-6 animate-in fade-in slide-in-from-top-2 text-left w-full">
          {/* File Path List */}
          <div>
            <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
              <Folder className="w-4 h-4" /> Tracked Storage Objects
            </h4>
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5 space-y-3">
              {caseFiles.map((f) => (
                <div
                  key={f.id}
                  title={f.filepath}
                  className="flex items-center gap-3"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
                  <span className="font-mono text-[13px] text-slate-300">
                    {f.filename}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Stat Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 lg:gap-4">
            <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 flex flex-col items-center justify-center text-center min-h-24">
              <span className="text-[8px] sm:text-[9px] text-slate-500 font-bold uppercase tracking-wider mb-1 sm:mb-2 leading-tight">
                Total Size
              </span>
              <span className="text-sm sm:text-[14px] font-bold text-white leading-tight whitespace-nowrap">
                {formatBytes(stats.size)}
              </span>
            </div>
            <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 flex flex-col items-center justify-center text-center min-h-24">
              <span className="text-[8px] sm:text-[9px] text-slate-500 font-bold uppercase tracking-wider mb-1 sm:mb-2 leading-tight">
                Gross Emails
              </span>
              <span className="text-sm sm:text-[14px] font-bold text-white leading-tight whitespace-nowrap">
                {stats.totalEmails.toLocaleString()}
              </span>
            </div>
            <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 flex flex-col items-center justify-center text-center min-h-24">
              <span className="text-[8px] sm:text-[9px] text-teal-500 font-bold uppercase tracking-wider mb-1 sm:mb-2 leading-tight">
                Deduplicated
              </span>
              <span className="text-sm sm:text-[14px] font-bold text-teal-400 leading-tight whitespace-nowrap">
                {stats.uniqueEmails.toLocaleString()}
              </span>
            </div>
            <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 flex flex-col items-center justify-center text-center min-h-24">
              <span className="text-[8px] sm:text-[9px] text-emerald-500 font-bold uppercase tracking-wider mb-1 sm:mb-2 leading-tight">
                AI Approved
              </span>
              <span className="text-sm sm:text-[14px] font-bold text-emerald-500 leading-tight whitespace-nowrap">
                {stats.aiApproved.toLocaleString()}
              </span>
            </div>
          </div>

          {/* Engine Duration Breakdown */}
          <div>
            <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4" /> Engine Telemetry (Execution Time)
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
              <div className="bg-slate-900/50 px-3 py-3 rounded-xl border border-slate-800 flex flex-col items-center justify-center gap-1 min-h-20 text-center">
                <span className="text-[11px] sm:text-xs text-slate-500">
                  Parse
                </span>
                <span className="font-mono text-sm sm:text-[14px] text-slate-200 tabular-nums">
                  <Duration ms={stats.metadataTime + stats.analyzeTime} />
                </span>
              </div>
              <div className="bg-slate-900/50 px-3 py-3 rounded-xl border border-slate-800 flex flex-col items-center justify-center gap-1 min-h-20 text-center">
                <span className="text-[11px] sm:text-xs text-slate-500">
                  Extract
                </span>
                <span className="font-mono text-sm sm:text-[14px] text-slate-200 tabular-nums">
                  <Duration ms={stats.extractTime} />
                </span>
              </div>
              <div className="bg-slate-900/50 px-3 py-3 rounded-xl border border-slate-800 flex flex-col items-center justify-center gap-1 min-h-20 text-center">
                <span className="text-[11px] sm:text-xs text-slate-500">
                  AI
                </span>
                <span className="font-mono text-sm sm:text-[14px] text-slate-200 tabular-nums">
                  <Duration ms={stats.aiTime} />
                </span>
              </div>
              <div className="bg-slate-900/50 px-3 py-3 rounded-xl border border-slate-800 flex flex-col items-center justify-center gap-1 min-h-20 text-center">
                <span className="text-[11px] sm:text-xs text-slate-500">
                  Render
                </span>
                <span className="font-mono text-sm sm:text-[14px] text-slate-200 tabular-nums">
                  <Duration ms={stats.pdfTime} />
                </span>
              </div>
            </div>
          </div>

          <div className="text-[11px] text-slate-500 font-mono text-center pt-6">
            ~{stats.estimatedTokens.toLocaleString()} Total Tokens Consumed
          </div>
        </div>
      )}
    </div>
  );
}
