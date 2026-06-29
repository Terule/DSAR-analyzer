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
import { memo, useMemo } from "react";
import type { AiConfig, CaseStats, StagedFile } from "@/lib/types";
import { AiConfigForm } from "./AiConfigForm";
import { CaseMetrics } from "./CaseMetrics";
import { PhaseIndicators } from "./PhaseIndicators";

interface CaseCardProps {
  caseName: string;
  caseFiles: StagedFile[];
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

function CaseCardComponent({
  caseName,
  caseFiles,
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

  const filesToSync = caseFiles
    .filter((f) => f.ai_status === "batch_ready")
    .map((f) => f.id);

  const isFaulted = caseFiles.some(
    (f) =>
      f.status === "failed" ||
      f.pdf_status === "failed" ||
      f.ai_status === "failed",
  );
  const isCompleted = caseFiles.every((f) => f.pdf_status === "completed");

  const isParsePhase = caseFiles.some((f) =>
    ["scanning_metadata", "pending_analysis", "processing"].includes(f.status),
  );
  const parseDone = caseFiles.every((f) =>
    ["analyzed", "extracting", "completed", "failed"].includes(f.status),
  );

  const isExtractPhase = caseFiles.some((f) => f.status === "extracting");
  const extractDone = caseFiles.every((f) =>
    ["completed", "failed"].includes(f.status),
  );

  const isAiPhase = caseFiles.some((f) =>
    ["batch_ready", "processing"].includes(f.ai_status || ""),
  );
  const aiDone =
    extractDone &&
    caseFiles.every((f) => ["completed", "failed"].includes(f.ai_status || ""));

  const isPdfPhase = caseFiles.some((f) => f.pdf_status === "processing");
  const pdfDone =
    aiDone &&
    caseFiles.every((f) =>
      ["completed", "failed"].includes(f.pdf_status || ""),
    );

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
  }

  const ActionIcon = btnConfig.icon;

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
    <div className="relative bg-slate-800 rounded-4xl shadow-xl border border-slate-700 p-8 flex flex-col items-center">
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
        title={caseName}
      >
        {caseName}
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

      {/* 4-Step Technical Phase Indicators */}
      <PhaseIndicators
        parse={{ isProcessing: isParsePhase, isDone: parseDone }}
        extract={{ isProcessing: isExtractPhase, isDone: extractDone }}
        ai={{
          isProcessing: isAiPhase || filesToSync.length > 0,
          isDone: aiDone,
        }}
        render={{ isProcessing: isPdfPhase, isDone: pdfDone }}
      />

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
    prev.hasAiConfig === next.hasAiConfig &&
    prev.isSequenceLocked === next.isSequenceLocked &&
    prev.isSyncing === next.isSyncing &&
    prev.isResetting === next.isResetting &&
    prev.isMetricsOpen === next.isMetricsOpen &&
    prev.isConfigOpen === next.isConfigOpen
  );
});
