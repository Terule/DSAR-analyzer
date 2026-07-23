"use client";

import {
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  FolderOpen,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/format";
import type { CaseStats, StagedFile } from "@/lib/types";
import { Duration } from "./Duration";

interface CaseMetricsProps {
  caseFiles: StagedFile[];
  stats: CaseStats;
  isOpen: boolean;
  onToggle: () => void;
}

type MetricsTab = "emails" | "files";

function StatCard({
  label,
  value,
  accent = "text-white",
}: {
  label: string;
  value: ReactNode;
  accent?: string;
}) {
  return (
    <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 flex flex-col items-center justify-center text-center min-h-24">
      <span className="text-[8px] sm:text-[9px] text-slate-500 font-bold uppercase tracking-wider mb-1 sm:mb-2 leading-tight">
        {label}
      </span>
      <span
        className={`text-sm sm:text-[14px] font-bold ${accent} leading-tight whitespace-nowrap`}
      >
        {value}
      </span>
    </div>
  );
}

function TimeCard({ label, ms }: { label: string; ms: number }) {
  return (
    <div className="bg-slate-900/50 px-3 py-3 rounded-xl border border-slate-800 flex flex-col items-center justify-center gap-1 min-h-20 text-center">
      <span className="text-[11px] sm:text-xs text-slate-500">{label}</span>
      <span className="font-mono text-sm sm:text-[14px] text-slate-200 tabular-nums">
        <Duration ms={ms} />
      </span>
    </div>
  );
}

export function CaseMetrics({
  caseFiles,
  stats,
  isOpen,
  onToggle,
}: CaseMetricsProps) {
  const filesRow = caseFiles.find((f) => f.kind === "files");
  const hasPst = caseFiles.some((f) => f.kind !== "files");
  const hasFiles = !!filesRow;
  // The Files phase only runs after the Render phase. Until it actually starts
  // (or completes), the Files tab must stay inert — otherwise a stray/orphaned
  // worker's live counters would surface during the emails pipeline.
  const filesPhaseStarted =
    !!filesRow &&
    ((filesRow.files_status && filesRow.files_status !== "pending") ||
      !!filesRow.files_started_at);
  const aiStillRunning = caseFiles.some(
    (f) =>
      f.kind !== "files" &&
      !["completed", "failed"].includes((f.ai_status || "").toLowerCase()),
  );
  const [now, setNow] = useState(() => Date.now());

  // AI duration is committed to the database only once the whole case settles.
  // Tick locally while it runs so telemetry remains useful between Batch
  // completions instead of showing a blank card for many hours.
  useEffect(() => {
    if (!aiStillRunning) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [aiStillRunning]);

  const aiStartedAt = Math.min(
    ...caseFiles
      .filter((file) => file.kind !== "files" && !!file.ai_started_at)
      .map((file) => file.ai_started_at as number),
  );
  const liveAiTime =
    aiStillRunning && Number.isFinite(aiStartedAt)
      ? Math.max(0, now - aiStartedAt)
      : 0;
  const displayedAiTime = Math.max(stats.aiTime, liveAiTime);

  const emailElapsed =
    stats.metadataTime +
    stats.analyzeTime +
    stats.extractTime +
    displayedAiTime +
    stats.pdfTime;
  const filesElapsed = filesRow?.files_duration_ms || 0;
  const totalElapsed = emailElapsed + filesElapsed;

  const availableTabs: MetricsTab[] = [];
  if (hasPst) availableTabs.push("emails");
  if (hasFiles) availableTabs.push("files");

  const [tab, setTab] = useState<MetricsTab>("emails");
  const activeTab: MetricsTab = availableTabs.includes(tab)
    ? tab
    : availableTabs[0] || "emails";

  return (
    <div className="w-full mt-8">
      {/* General metrics — always visible breakdown header */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Total Size" value={formatBytes(stats.size)} />
        <StatCard label="Total Time" value={<Duration ms={totalElapsed} />} />
      </div>

      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-center gap-2 text-[11px] uppercase tracking-widest font-bold text-slate-500 hover:text-slate-300 transition-colors py-2 mt-4"
      >
        {isOpen ? "Hide Diagnostics" : "View Technical Metrics"}
        {isOpen ? (
          <ChevronUp className="w-3.5 h-3.5" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5" />
        )}
      </button>

      {isOpen && (
        <div className="mt-4 space-y-6 animate-in fade-in slide-in-from-top-2 text-left w-full">
          {/* Tab toggle (only when both breakdowns exist) */}
          {availableTabs.length > 1 && (
            <div className="flex gap-2 bg-slate-900/50 border border-slate-800 rounded-xl p-1">
              {availableTabs.map((t) => {
                const isActive = t === activeTab;
                const Icon = t === "emails" ? Database : FolderOpen;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest transition-colors ${
                      isActive
                        ? "bg-indigo-500/15 text-indigo-300 border border-indigo-500/40"
                        : "text-slate-500 hover:text-slate-300 border border-transparent"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {t === "emails" ? "Emails" : "Files"}
                  </button>
                );
              })}
            </div>
          )}

          {activeTab === "emails" && hasPst && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 lg:gap-4">
                <StatCard
                  label="Gross Emails"
                  value={stats.totalEmails.toLocaleString()}
                />
                <StatCard
                  label="Unique"
                  value={stats.uniqueEmails.toLocaleString()}
                  accent="text-teal-400"
                />
                <StatCard
                  label="AI Approved"
                  value={stats.aiApproved.toLocaleString()}
                  accent="text-emerald-500"
                />
                <StatCard
                  label="Discarded"
                  value={(
                    stats.aiDiscarded + stats.duplicateEmails
                  ).toLocaleString()}
                  accent="text-rose-400"
                />
              </div>

              {stats.aiDiscarded + stats.duplicateEmails > 0 && (
                <div className="text-[11px] text-slate-500 text-center">
                  Includes {stats.duplicateEmails.toLocaleString()} duplicates
                  plus rule/system and AI discards
                  {aiStillRunning ? " (AI still running)" : ""}.
                </div>
              )}

              <div>
                <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4" /> Engine Telemetry (Execution
                  Time)
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                  <TimeCard
                    label="Parse"
                    ms={stats.metadataTime + stats.analyzeTime}
                  />
                  <TimeCard label="Extract" ms={stats.extractTime} />
                  <TimeCard
                    label={aiStillRunning ? "AI (Live)" : "AI"}
                    ms={displayedAiTime}
                  />
                  <TimeCard label="Render" ms={stats.pdfTime} />
                </div>
              </div>

              <div className="text-[11px] text-slate-500 font-mono text-center pt-2">
                ~{stats.estimatedTokens.toLocaleString()} Total Tokens Consumed
              </div>
            </div>
          )}

          {activeTab === "files" && hasFiles && filesRow && (
            <div className="space-y-6">
              {filesPhaseStarted ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 lg:gap-4">
                    <StatCard
                      label="Total Files"
                      value={(filesRow.files_total || 0).toLocaleString()}
                    />
                    <StatCard
                      label="Exported"
                      value={(filesRow.files_processed || 0).toLocaleString()}
                      accent="text-emerald-500"
                    />
                    <StatCard
                      label="Excluded"
                      value={(filesRow.files_skipped || 0).toLocaleString()}
                      accent="text-slate-300"
                    />
                    <StatCard
                      label="Duplicates"
                      value={(filesRow.files_duplicates || 0).toLocaleString()}
                      accent="text-amber-400"
                    />
                  </div>

                  <div>
                    <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                      <Clock className="w-4 h-4" /> Engine Telemetry (Execution
                      Time)
                    </h4>
                    <div className="grid grid-cols-1 gap-2 sm:gap-3">
                      <TimeCard label="Files Processing" ms={filesElapsed} />
                    </div>
                  </div>
                </>
              ) : (
                <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-6 text-center">
                  <p className="text-sm font-semibold text-slate-300 mb-1">
                    {(filesRow.files_total || 0).toLocaleString()} files
                    detected
                  </p>
                  <p className="text-[12px] text-slate-500">
                    The Files phase runs after the Render phase. Metrics will
                    appear once it starts.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
