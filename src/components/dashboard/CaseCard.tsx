"use client";

import {
  AlertCircle,
  CheckCircle,
  Loader2,
  Mail,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { maskCaseName } from "@/lib/format";
import type { AiConfig, CaseStats, StagedFile } from "@/lib/types";
import { AiConfigForm } from "./AiConfigForm";
import { CaseMetrics } from "./CaseMetrics";
import {
  PHASE_ICONS,
  PhaseIndicators,
  type PhaseItem,
} from "./PhaseIndicators";

const DEFAULT_PARSE_MS = 120_000;
const DEFAULT_EXTRACT_MS = 90_000;
const DEFAULT_AI_MS = 480_000;
const DEFAULT_RENDER_MS = 120_000;
const ACTIVE_MAX_PROGRESS = 0.96;
const ACTIVE_MIN_PROGRESS_PARSE_EXTRACT = 0;
const ACTIVE_MIN_PROGRESS_AI_RENDER = 0.04;
const PHASE_PROGRESS_SMOOTH_STEP = 8;

interface CaseCardProps {
  caseName: string;
  caseFiles: StagedFile[];
  privacyMode: boolean;
  hasAiConfig: boolean;
  isSequenceLocked: boolean;
  isSyncing: boolean;
  isResetting: boolean;
  isMetricsOpen: boolean;
  isConfigOpen: boolean;
  onToggleMetrics: () => void;
  onOpenConfig: () => void;
  onCloseConfig: () => void;
  onSync: (fileIds: string[]) => void;
  onReset: (fileIds: string[]) => void;
  onStartSequence: (action: string) => void;
  onSubmitAiConfig: (config: AiConfig) => void;
}

function computeStats(caseFiles: StagedFile[]): CaseStats {
  return caseFiles.reduce<CaseStats>(
    (acc, file) => {
      acc.size += file.file_size_bytes || 0;
      acc.totalEmails += file.total_emails || 0;
      acc.uniqueEmails += file.unique_emails || 0;
      acc.duplicateEmails += file.duplicate_emails || 0;
      acc.estimatedTokens += file.estimated_tokens || 0;
      acc.aiApproved += file.ai_approved_count || 0;
      acc.aiDiscarded += file.ai_discarded_count || 0;
      acc.metadataTime += file.metadata_duration_ms || 0;
      acc.analyzeTime += file.analyze_duration_ms || 0;
      acc.extractTime += file.extract_duration_ms || 0;
      acc.aiTime += file.ai_duration_ms || 0;
      acc.pdfTime += file.pdf_duration_ms || 0;
      return acc;
    },
    {
      size: 0,
      totalEmails: 0,
      uniqueEmails: 0,
      duplicateEmails: 0,
      estimatedTokens: 0,
      aiApproved: 0,
      aiDiscarded: 0,
      metadataTime: 0,
      analyzeTime: 0,
      extractTime: 0,
      aiTime: 0,
      pdfTime: 0,
    },
  );
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function averageDuration(values: number[], fallbackMs: number): number {
  if (values.length === 0) return fallbackMs;
  const total = values.reduce((sum, current) => sum + current, 0);
  return Math.max(1, total / values.length);
}

function tunedDuration(
  values: number[],
  fallbackMs: number,
  minFactor: number,
  maxFactor: number,
): number {
  const avg = averageDuration(values, fallbackMs);
  const minMs = fallbackMs * minFactor;
  const maxMs = fallbackMs * maxFactor;
  return Math.max(minMs, Math.min(maxMs, avg));
}

function activeProgress(
  elapsedMs: number,
  targetMs: number,
  minProgress: number,
): number {
  const unit = clampUnit(elapsedMs / Math.max(1, targetMs));
  return minProgress + unit * (ACTIVE_MAX_PROGRESS - minProgress);
}

function smoothProgress(prev: number, next: number): number {
  if (next <= prev) return next;
  if (next === 100) return 100;
  return Math.min(prev + PHASE_PROGRESS_SMOOTH_STEP, next);
}

function toTimestampMs(value?: string): number | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is typically "YYYY-MM-DD HH:MM:SS" in UTC.
  // Browsers can interpret this as local time, causing future timestamps.
  const sqliteUtcPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const normalized = sqliteUtcPattern.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;

  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function CaseCardComponent({
  caseName,
  caseFiles,
  privacyMode,
  hasAiConfig,
  isSequenceLocked,
  isSyncing,
  isResetting,
  isMetricsOpen,
  isConfigOpen,
  onToggleMetrics,
  onOpenConfig,
  onCloseConfig,
  onSync,
  onReset,
  onStartSequence,
  onSubmitAiConfig,
}: CaseCardProps) {
  const stats = useMemo(() => computeStats(caseFiles), [caseFiles]);

  const displayName = privacyMode ? maskCaseName(caseName) : caseName;

  // Split the case into PST rows (email pipeline) and the single Files row
  // (Teams/docs). Email phases are computed over PST rows only; the Files phase
  // is driven by the Files row's files_status.
  const pstFiles = useMemo(
    () => caseFiles.filter((f) => f.kind !== "files"),
    [caseFiles],
  );
  const filesRow = useMemo(
    () => caseFiles.find((f) => f.kind === "files"),
    [caseFiles],
  );
  const hasPst = pstFiles.length > 0;
  const hasFiles = !!filesRow;

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [displayedPhaseProgress, setDisplayedPhaseProgress] = useState({
    parse: 0,
    extract: 0,
    ai: 0,
    render: 0,
  });

  const hasActiveWork = useMemo(
    () =>
      pstFiles.some(
        (f) =>
          ["scanning_metadata", "pending_analysis", "processing"].includes(
            f.status,
          ) ||
          f.status === "extracting" ||
          ["processing", "batch_ready"].includes(f.ai_status || "") ||
          f.pdf_status === "processing",
      ) || filesRow?.files_status === "processing",
    [pstFiles, filesRow],
  );

  useEffect(() => {
    if (!hasActiveWork) return;

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [hasActiveWork]);

  const phaseProgress = useMemo(() => {
    if (pstFiles.length === 0) {
      return { parse: 0, extract: 0, ai: 0, render: 0 };
    }

    const total = pstFiles.length;

    const parseSamples = pstFiles
      .map((f) => (f.metadata_duration_ms || 0) + (f.analyze_duration_ms || 0))
      .filter((ms) => ms > 0);
    const extractSamples = pstFiles
      .map((f) => f.extract_duration_ms || 0)
      .filter((ms) => ms > 0);
    const aiSamples = pstFiles
      .map((f) => f.ai_duration_ms || 0)
      .filter((ms) => ms > 0);
    const renderSamples = pstFiles
      .map((f) => f.pdf_duration_ms || 0)
      .filter((ms) => ms > 0);

    const parseTargetMs = tunedDuration(parseSamples, DEFAULT_PARSE_MS, 0.5, 3);
    const extractTargetMs = tunedDuration(
      extractSamples,
      DEFAULT_EXTRACT_MS,
      0.5,
      3,
    );
    const aiTargetMs = tunedDuration(aiSamples, DEFAULT_AI_MS, 0.5, 4);
    const renderTargetMs = tunedDuration(
      renderSamples,
      DEFAULT_RENDER_MS,
      0.5,
      3,
    );

    const parseSum = pstFiles.reduce((sum, file) => {
      if (
        ["analyzed", "extracting", "completed", "failed"].includes(file.status)
      ) {
        return sum + 1;
      }

      if (
        ["scanning_metadata", "pending_analysis", "processing"].includes(
          file.status,
        )
      ) {
        const createdAtMs = toTimestampMs(file.created_at);
        const parseStartEstimate =
          createdAtMs || nowMs - Math.floor(parseTargetMs * 0.2);
        const parseStartMs = Math.min(parseStartEstimate, nowMs);
        const elapsedMs = Math.max(0, nowMs - parseStartMs);
        return (
          sum +
          activeProgress(
            elapsedMs,
            parseTargetMs,
            ACTIVE_MIN_PROGRESS_PARSE_EXTRACT,
          )
        );
      }

      return sum;
    }, 0);

    const extractSum = pstFiles.reduce((sum, file) => {
      if (["completed", "failed"].includes(file.status)) {
        return sum + 1;
      }

      if (file.status === "extracting") {
        const createdAtMs = toTimestampMs(file.created_at);

        const knownParseMs =
          (file.metadata_duration_ms || 0) + (file.analyze_duration_ms || 0);
        const parseMsForOffset =
          knownParseMs > 0 ? knownParseMs : parseTargetMs;
        const extractStartEstimate = createdAtMs
          ? createdAtMs + parseMsForOffset
          : nowMs - Math.floor(extractTargetMs * 0.2);
        const extractStartMs = Math.min(extractStartEstimate, nowMs);
        const elapsedMs = Math.max(0, nowMs - extractStartMs);

        return (
          sum +
          activeProgress(
            elapsedMs,
            extractTargetMs,
            ACTIVE_MIN_PROGRESS_PARSE_EXTRACT,
          )
        );
      }

      return sum;
    }, 0);

    // AI progress is batch-based: completed OpenAI batches divided by the
    // estimated total batches for the case. Each finished batch advances the
    // bar by ~1/total (e.g. 5 total -> 20% per batch). The total self-corrects
    // in the batch worker if the initial estimate is exceeded.
    const aiBatchesTotal = pstFiles.reduce(
      (sum, file) => sum + (file.ai_batches_total || 0),
      0,
    );
    const aiBatchesDone = pstFiles.reduce(
      (sum, file) => sum + (file.ai_batches_done || 0),
      0,
    );
    const anyAiActive = pstFiles.some((f) =>
      ["processing", "batch_ready"].includes(f.ai_status || ""),
    );
    const allAiDone = pstFiles.every((f) =>
      ["completed", "failed"].includes(f.ai_status || ""),
    );

    const renderSum = pstFiles.reduce((sum, file) => {
      if (["completed", "failed"].includes(file.pdf_status || "")) {
        return sum + 1;
      }

      if (file.pdf_status === "processing") {
        const createdAtMs = toTimestampMs(file.created_at);
        const parseMs =
          (file.metadata_duration_ms || 0) + (file.analyze_duration_ms || 0) ||
          parseTargetMs;
        const extractMs = file.extract_duration_ms || extractTargetMs;
        const aiMs = file.ai_duration_ms || aiTargetMs;

        const renderStartEstimate = createdAtMs
          ? createdAtMs + parseMs + extractMs + aiMs
          : nowMs - Math.floor(renderTargetMs * 0.2);
        const renderStartMs = Math.min(renderStartEstimate, nowMs);
        const elapsedMs = Math.max(0, nowMs - renderStartMs);
        return (
          sum +
          activeProgress(
            elapsedMs,
            renderTargetMs,
            ACTIVE_MIN_PROGRESS_AI_RENDER,
          )
        );
      }

      return sum;
    }, 0);

    const parse = Math.round((parseSum / total) * 100);
    const extract = Math.round((extractSum / total) * 100);
    const ai = allAiDone
      ? 100
      : aiBatchesTotal > 0
        ? Math.min(99, Math.round((aiBatchesDone / aiBatchesTotal) * 100))
        : anyAiActive
          ? ACTIVE_MIN_PROGRESS_AI_RENDER * 100
          : 0;
    const render = Math.round((renderSum / total) * 100);

    return { parse, extract, ai, render };
  }, [pstFiles, nowMs]);

  useEffect(() => {
    setDisplayedPhaseProgress((prev) => ({
      parse: smoothProgress(prev.parse, phaseProgress.parse),
      extract: smoothProgress(prev.extract, phaseProgress.extract),
      ai: smoothProgress(prev.ai, phaseProgress.ai),
      render: smoothProgress(prev.render, phaseProgress.render),
    }));
  }, [phaseProgress]);

  const filesToSync = pstFiles
    .filter((f) => f.ai_status === "batch_ready")
    .map((f) => f.id);

  const isParsePhase = pstFiles.some((f) =>
    ["scanning_metadata", "pending_analysis", "processing"].includes(f.status),
  );
  const parseStarted = pstFiles.some((f) => f.status !== "pending");
  const parseDone =
    hasPst &&
    pstFiles.every((f) =>
      ["analyzed", "extracting", "completed", "failed"].includes(f.status),
    );

  const isExtractPhase = pstFiles.some((f) => f.status === "extracting");
  const extractStarted = pstFiles.some((f) =>
    ["extracting", "completed", "failed"].includes(f.status),
  );
  const extractDone =
    hasPst && pstFiles.every((f) => ["completed", "failed"].includes(f.status));

  const isAiPhase = pstFiles.some((f) =>
    ["batch_ready", "processing"].includes(f.ai_status || ""),
  );
  const aiStarted = pstFiles.some((f) =>
    ["batch_ready", "processing", "completed", "failed"].includes(
      f.ai_status || "",
    ),
  );
  const aiDone =
    extractDone &&
    pstFiles.every((f) => ["completed", "failed"].includes(f.ai_status || ""));

  const isPdfPhase = pstFiles.some((f) => f.pdf_status === "processing");
  const pdfStarted = pstFiles.some((f) =>
    ["processing", "completed", "failed"].includes(f.pdf_status || ""),
  );
  const pdfDone =
    aiDone &&
    pstFiles.every((f) => ["completed", "failed"].includes(f.pdf_status || ""));

  // Files phase state (driven by the Files row's files_status + counters).
  const filesStatus = filesRow?.files_status || "pending";
  const isFilesPhase = filesStatus === "processing";
  const filesStarted = hasFiles && filesStatus !== "pending";
  const filesDone = filesStatus === "completed";
  const filesFaulted = filesStatus === "failed";
  const filesHandled =
    (filesRow?.files_processed || 0) + (filesRow?.files_skipped || 0);
  const filesTotal = filesRow?.files_total || 0;
  const filesProgress = filesDone
    ? 100
    : isFilesPhase
      ? filesTotal > 0 && filesHandled > 0
        ? Math.min(99, Math.round((filesHandled / filesTotal) * 100))
        : 5
      : 0;

  const isFaulted =
    pstFiles.some(
      (f) =>
        f.status === "failed" ||
        f.pdf_status === "failed" ||
        f.ai_status === "failed",
    ) || filesFaulted;
  const isCompleted =
    (hasPst || hasFiles) && (!hasPst || pdfDone) && (!hasFiles || filesDone);

  let btnConfig = {
    text: hasAiConfig ? "Run Pipeline" : "Configure Case Settings",
    action: "launch_audit",
    icon: Play,
    color: "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-900/20",
    spin: false,
  };

  if (isFaulted) {
    btnConfig = {
      text: "Pipeline Faulted",
      action: "",
      icon: AlertCircle,
      color:
        "bg-rose-900/50 text-rose-400 border border-rose-500/30 cursor-not-allowed",
      spin: false,
    };
  } else if (isCompleted) {
    btnConfig = {
      text: "Pipeline Complete",
      action: "",
      icon: CheckCircle,
      color:
        "bg-emerald-900/40 text-emerald-400 border border-emerald-500/30 cursor-default",
      spin: false,
    };
  } else if (isParsePhase) {
    btnConfig = {
      text: "Parsing & Deduplicating...",
      action: "",
      icon: Loader2,
      color:
        "bg-amber-900/30 text-amber-400 border border-amber-500/30 cursor-wait",
      spin: true,
    };
  } else if (isExtractPhase) {
    btnConfig = {
      text: "Exporting Flat Files...",
      action: "",
      icon: Loader2,
      color:
        "bg-amber-900/30 text-amber-400 border border-amber-500/30 cursor-wait",
      spin: true,
    };
  } else if (isAiPhase || filesToSync.length > 0) {
    btnConfig = {
      text: "AI Auditing Process...",
      action: "",
      icon: Loader2,
      color:
        "bg-amber-900/30 text-amber-400 border border-amber-500/30 cursor-wait",
      spin: true,
    };
  } else if (aiDone && !pdfDone && !isPdfPhase) {
    btnConfig = {
      text: "Starting PDF Compilation...",
      action: "pdf",
      icon: Loader2,
      color:
        "bg-amber-900/30 text-amber-400 border border-amber-500/30 cursor-wait",
      spin: true,
    };
  } else if (isPdfPhase) {
    btnConfig = {
      text: "Rendering PDFs...",
      action: "",
      icon: Loader2,
      color:
        "bg-amber-900/30 text-amber-400 border border-amber-500/30 cursor-wait",
      spin: true,
    };
  } else if (isFilesPhase) {
    btnConfig = {
      text: "Processing Files...",
      action: "",
      icon: Loader2,
      color:
        "bg-amber-900/30 text-amber-400 border border-amber-500/30 cursor-wait",
      spin: true,
    };
  }

  const ActionIcon = btnConfig.icon;

  const phases: PhaseItem[] = [];
  if (hasPst) {
    phases.push(
      {
        id: "parse",
        label: "PARSE",
        icon: PHASE_ICONS.parse,
        hasStarted: parseStarted,
        isProcessing: isParsePhase,
        isDone: parseDone,
        progressPct: displayedPhaseProgress.parse,
      },
      {
        id: "extract",
        label: "EXTRACT",
        icon: PHASE_ICONS.extract,
        hasStarted: extractStarted,
        isProcessing: isExtractPhase,
        isDone: extractDone,
        progressPct: displayedPhaseProgress.extract,
      },
      {
        id: "ai",
        label: "AI AUDIT",
        icon: PHASE_ICONS.ai,
        hasStarted: aiStarted,
        isProcessing: isAiPhase || filesToSync.length > 0,
        isDone: aiDone,
        progressPct: displayedPhaseProgress.ai,
      },
      {
        id: "render",
        label: "RENDER",
        icon: PHASE_ICONS.render,
        hasStarted: pdfStarted,
        isProcessing: isPdfPhase,
        isDone: pdfDone,
        progressPct: displayedPhaseProgress.render,
      },
    );
  }
  if (hasFiles) {
    phases.push({
      id: "files",
      label: "FILES",
      icon: PHASE_ICONS.files,
      hasStarted: filesStarted,
      isProcessing: isFilesPhase,
      isDone: filesDone,
      progressPct: filesProgress,
    });
  }

  const handleMainAction = () => {
    if (btnConfig.action === "launch_audit") {
      if (hasAiConfig) onStartSequence("metadata");
      else if (isConfigOpen) onCloseConfig();
      else onOpenConfig();
    } else if (btnConfig.action) {
      onStartSequence(btnConfig.action);
    }
  };

  return (
    <div className="relative overflow-hidden bg-slate-800 rounded-4xl shadow-xl border border-slate-700 p-8 flex flex-col items-center">
      {/* Top Right Mini Tools */}
      <div className="absolute top-6 right-6 flex items-center gap-2">
        {filesToSync.length > 0 && (
          <button
            type="button"
            onClick={() => onSync(filesToSync)}
            disabled={isSyncing}
            className="p-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300 transition-colors border border-slate-600"
            title="Sync AI Batch"
          >
            <RefreshCw
              className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
            />
          </button>
        )}
        <button
          type="button"
          onClick={() => onReset(caseFiles.map((f) => f.id))}
          disabled={isResetting || isSequenceLocked}
          className="p-2 bg-slate-700 hover:bg-rose-900/50 text-slate-400 hover:text-rose-400 rounded-lg transition-colors border border-slate-600"
          title="Wipe Data"
        >
          {isResetting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Central Header */}
      <div className="w-16 h-16 bg-indigo-500/10 rounded-2xl flex items-center justify-center mb-4 mt-2">
        <Mail className="w-8 h-8 text-indigo-400" />
      </div>
      <h2
        className="text-3xl font-bold tracking-tight text-white mb-2 text-center max-w-full truncate px-4"
        title={privacyMode ? undefined : caseName}
      >
        {displayName}
      </h2>
      <p className="text-slate-400 mb-8 font-medium text-sm text-center">
        Data Subject Access Request Pipeline
      </p>

      {/* AI Configuration Popover */}
      {isConfigOpen && (
        <AiConfigForm
          caseName={caseName}
          onCancel={onCloseConfig}
          onSubmit={onSubmitAiConfig}
        />
      )}

      {/* Primary Big Action Button */}
      <button
        type="button"
        onClick={handleMainAction}
        disabled={!btnConfig.action || isSequenceLocked}
        className={`w-full max-w-xl py-4 rounded-2xl font-bold flex items-center justify-center gap-3 transition-all shadow-sm disabled:opacity-90 disabled:cursor-not-allowed ${btnConfig.color}`}
      >
        <ActionIcon
          className={`w-5 h-5 ${btnConfig.spin ? "animate-spin" : ""}`}
        />
        <span className="text-lg tracking-wide">{btnConfig.text}</span>
      </button>

      {/* Technical Phase Indicators (PST email phases and/or Files phase) */}
      <PhaseIndicators phases={phases} />

      {/* Metrics Accordion */}
      <CaseMetrics
        caseFiles={caseFiles}
        stats={stats}
        isOpen={isMetricsOpen}
        onToggle={onToggleMetrics}
      />
    </div>
  );
}

export const CaseCard = memo(CaseCardComponent, (prev, next) => {
  return (
    prev.caseName === next.caseName &&
    prev.caseFiles === next.caseFiles &&
    prev.privacyMode === next.privacyMode &&
    prev.hasAiConfig === next.hasAiConfig &&
    prev.isSequenceLocked === next.isSequenceLocked &&
    prev.isSyncing === next.isSyncing &&
    prev.isResetting === next.isResetting &&
    prev.isMetricsOpen === next.isMetricsOpen &&
    prev.isConfigOpen === next.isConfigOpen
  );
});
