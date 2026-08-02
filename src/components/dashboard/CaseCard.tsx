"use client";

import {
  AlertCircle,
  CheckCircle,
  Loader2,
  Mail,
  Play,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { memo, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { maskCaseName } from "@/lib/format";
import type { AiConfig, CaseStats, StagedFile } from "@/lib/types";
import { AiConfigForm } from "./AiConfigForm";
import { CaseMetrics } from "./CaseMetrics";
import {
  PHASE_ICONS,
  PhaseIndicators,
  type PhaseItem,
} from "./PhaseIndicators";

interface CaseCardProps {
  caseName: string;
  caseFiles: StagedFile[];
  privacyMode: boolean;
  hasAiConfig: boolean;
  isBlockedByAnotherCase: boolean;
  isSyncing: boolean;
  isResetting: boolean;
  isPreparingUpload: boolean;
  isMetricsOpen: boolean;
  isConfigOpen: boolean;
  onToggleMetrics: () => void;
  onOpenConfig: () => void;
  onCloseConfig: () => void;
  onSync: (fileIds: string[]) => void;
  onReset: (fileIds: string[]) => void;
  onPrepareUpload: (fileIds: string[]) => void;
  onStartSequence: (action: string) => void;
  onSubmitAiConfig: (config: AiConfig) => void;
  onResumeAi: () => void;
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
  privacyMode,
  hasAiConfig,
  isBlockedByAnotherCase,
  isSyncing,
  isResetting,
  isPreparingUpload,
  isMetricsOpen,
  isConfigOpen,
  onToggleMetrics,
  onOpenConfig,
  onCloseConfig,
  onSync,
  onReset,
  onPrepareUpload,
  onStartSequence,
  onSubmitAiConfig,
  onResumeAi,
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
  const isRenderComplete =
    hasPst && pstFiles.every((file) => file.pdf_status === "completed");
  const hasFiles = !!filesRow;
  const uploadRow = caseFiles.find((file) =>
    ["pending", "processing"].includes(file.upload_status || ""),
  );
  const isUploading = !!uploadRow;

  const phaseProgress = useMemo(() => {
    if (pstFiles.length === 0) {
      return {
        parse: 0,
        extract: 0,
        ai: 0,
        render: 0,
        parseComplete: 0,
        extractComplete: 0,
        renderTotal: 0,
        renderProcessed: 0,
        aiAuditedItems: 0,
        aiTotalItems: 0,
      };
    }

    const total = pstFiles.length;

    const parseComplete = pstFiles.filter((file) =>
      ["analyzed", "extracting", "completed", "failed"].includes(file.status),
    ).length;
    const extractComplete = pstFiles.filter((file) =>
      ["completed", "failed"].includes(file.status),
    ).length;

    // AI progress comes from the actual email rows with a persisted decision.
    // Cumulative approval/discard counters are reporting metrics and must not
    // drive progress because a retried Batch can otherwise inflate them.
    const aiTotalItems = pstFiles.reduce(
      (sum, file) => sum + (file.unique_emails || 0),
      0,
    );
    const aiAuditedItems = pstFiles.reduce(
      (sum, file) => sum + (file.ai_audited_count || 0),
      0,
    );
    const anyAiActive = pstFiles.some((f) =>
      ["processing", "batch_ready"].includes(f.ai_status || ""),
    );
    const allAiDone = pstFiles.every((f) =>
      ["completed", "failed"].includes(f.ai_status || ""),
    );

    const renderTotal = Math.max(
      0,
      ...pstFiles.map((file) => file.pdf_total || 0),
    );
    const renderProcessed = Math.max(
      0,
      ...pstFiles.map((file) => file.pdf_processed || 0),
    );
    const parse = Math.round((parseComplete / total) * 100);
    const extract = Math.round((extractComplete / total) * 100);
    const ai = allAiDone
      ? 100
      : aiTotalItems > 0
        ? Math.min(99, Math.round((aiAuditedItems / aiTotalItems) * 100))
        : anyAiActive
          ? 0
          : 0;
    const allRenderDone = pstFiles.every((file) =>
      ["completed", "failed"].includes(file.pdf_status || ""),
    );
    const render = allRenderDone
      ? 100
      : renderTotal > 0
        ? Math.min(99, Math.round((renderProcessed / renderTotal) * 100))
        : 0;

    return {
      parse,
      extract,
      ai,
      render,
      parseComplete,
      extractComplete,
      renderTotal,
      renderProcessed,
      aiAuditedItems,
      aiTotalItems,
    };
  }, [pstFiles]);

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
  // The coordinator briefly changes state while a completed OpenAI chunk is
  // being applied and the next one is submitted. Persisted batch counters keep
  // the card in its AI state through that hand-off instead of falling back to
  // the configuration prompt for one SSE refresh.
  const isAiLifecycleActive =
    !aiDone &&
    pstFiles.some(
      (file) =>
        (file.ai_batches_total || 0) > 0 || (file.ai_batches_done || 0) > 0,
    );

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
  // A Files-only request has no Render phase to unlock the upload action.
  // Let its completed Files phase use the same deliverables upload workflow.
  const canPrepareUpload = isRenderComplete || (!hasPst && filesDone);
  const filesHandled =
    filesRow?.files_progress_handled ||
    (filesRow?.files_processed || 0) + (filesRow?.files_skipped || 0);
  const filesTotal =
    filesRow?.files_progress_total || filesRow?.files_total || 0;
  // Progress is a persisted counter, independent from the terminal state.
  // A failed batch must not make an already-handled Files count display as 0%.
  const filesProgress = filesDone
    ? 100
    : filesTotal > 0 && filesHandled > 0
      ? Math.min(99, Math.round((filesHandled / filesTotal) * 100))
      : isFilesPhase
        ? 5
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
    const canResumeAi =
      extractDone &&
      pstFiles.some((file) => file.ai_status === "failed") &&
      !pstFiles.some(
        (file) => file.status === "failed" || file.pdf_status === "failed",
      );
    btnConfig = canResumeAi
      ? {
          text: "Resume AI Audit",
          action: "resume_ai",
          icon: RefreshCw,
          color:
            "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-900/20",
          spin: false,
        }
      : {
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
  } else if (isAiPhase || filesToSync.length > 0 || isAiLifecycleActive) {
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

  if (isBlockedByAnotherCase && btnConfig.action === "launch_audit") {
    btnConfig = {
      text: "Waiting for Active Case...",
      action: "",
      icon: Loader2,
      color:
        "bg-slate-700/70 text-slate-400 border border-slate-600 cursor-not-allowed",
      spin: false,
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
        progressPct: phaseProgress.parse,
        detail: `${phaseProgress.parseComplete}/${pstFiles.length}`,
      },
      {
        id: "extract",
        label: "EXTRACT",
        icon: PHASE_ICONS.extract,
        hasStarted: extractStarted,
        isProcessing: isExtractPhase,
        isDone: extractDone,
        progressPct: phaseProgress.extract,
        detail: `${phaseProgress.extractComplete}/${pstFiles.length}`,
      },
      {
        id: "ai",
        label: "AI AUDIT",
        icon: PHASE_ICONS.ai,
        hasStarted: aiStarted,
        isProcessing:
          isAiPhase || filesToSync.length > 0 || isAiLifecycleActive,
        isDone: aiDone,
        progressPct: phaseProgress.ai,
        detail:
          phaseProgress.aiTotalItems > 0
            ? `${phaseProgress.aiAuditedItems}/${phaseProgress.aiTotalItems}`
            : undefined,
      },
      {
        id: "render",
        label: "RENDER",
        icon: PHASE_ICONS.render,
        hasStarted: pdfStarted,
        isProcessing: isPdfPhase,
        isDone: pdfDone,
        progressPct: phaseProgress.render,
        detail:
          phaseProgress.renderTotal > 0
            ? `${phaseProgress.renderProcessed}/${phaseProgress.renderTotal}`
            : undefined,
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
      detail:
        filesTotal > 0
          ? `${Math.min(filesHandled, filesTotal)}/${filesTotal}`
          : undefined,
    });
  }

  const handleMainAction = () => {
    if (btnConfig.action === "launch_audit") {
      if (hasAiConfig) onStartSequence("metadata");
      else if (isConfigOpen) onCloseConfig();
      else onOpenConfig();
    } else if (btnConfig.action === "resume_ai") {
      onResumeAi();
    } else if (btnConfig.action) {
      onStartSequence(btnConfig.action);
    }
  };

  return (
    <div className="relative overflow-hidden bg-slate-800 rounded-4xl shadow-xl border border-slate-700 p-8 flex flex-col items-center">
      {/* Top Right Mini Tools */}
      <div className="absolute top-6 right-6 flex items-center gap-2">
        {canPrepareUpload && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => onPrepareUpload(caseFiles.map((file) => file.id))}
            disabled={isPreparingUpload || isUploading}
            title={
              isUploading
                ? `Uploading ${uploadRow.upload_uploaded || 0}/${uploadRow.upload_total || 0} files to SharePoint`
                : "Upload deliverable to SharePoint"
            }
          >
            {isPreparingUpload || isUploading ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Upload />
            )}
          </Button>
        )}
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
          disabled={isResetting}
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
      {isUploading && (
        <div className="absolute top-18 right-6 flex items-center gap-1.5 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-2 py-1 text-[10px] font-semibold tabular-nums text-indigo-200">
          <Loader2 className="size-3 animate-spin" />
          Uploading {uploadRow.upload_uploaded || 0}/
          {uploadRow.upload_total || 0}
        </div>
      )}

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

      {/* The form owns the action while it is open; Cancel restores this button. */}
      {!isConfigOpen && (
        <button
          type="button"
          onClick={handleMainAction}
          disabled={!btnConfig.action || isBlockedByAnotherCase}
          title={
            isBlockedByAnotherCase
              ? "Another case is currently using the pipeline."
              : undefined
          }
          className={`w-full max-w-xl py-4 rounded-2xl font-bold flex items-center justify-center gap-3 transition-all shadow-sm disabled:opacity-90 disabled:cursor-not-allowed ${btnConfig.color}`}
        >
          <ActionIcon
            className={`w-5 h-5 ${btnConfig.spin ? "animate-spin" : ""}`}
          />
          <span className="text-lg tracking-wide">{btnConfig.text}</span>
        </button>
      )}

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
    prev.isBlockedByAnotherCase === next.isBlockedByAnotherCase &&
    prev.isSyncing === next.isSyncing &&
    prev.isResetting === next.isResetting &&
    prev.isMetricsOpen === next.isMetricsOpen &&
    prev.isConfigOpen === next.isConfigOpen
  );
});
