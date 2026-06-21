"use client";

import {
  AlertCircle,
  CheckCircle,
  Database,
  FileText,
  Folder,
  Loader2,
  Play,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface StagedFile {
  id: string;
  filename: string;
  filepath: string;
  file_size_bytes: number;
  status:
    | "pending"
    | "scanning_metadata"
    | "processing"
    | "pending_analysis"
    | "analyzed"
    | "extracting"
    | "completed"
    | "failed";
  total_emails: number;
  total_attachments: number;
  unique_emails: number;
  duplicate_emails: number;
  estimated_tokens?: number;
  ai_status?: "pending" | "processing" | "completed" | "failed" | "batch_ready";
  ai_approved_count?: number;
  ai_discarded_count?: number;
  pdf_status?: "pending" | "processing" | "completed" | "failed";
  subject_name?: string;
  subject_email?: string;
  subject_aliases?: string;
}

interface AiConfig {
  name: string;
  email: string;
  aliases: string[];
}

function getRelativePath(filepath: string) {
  if (!filepath) return "";
  return filepath.split(/staging-area[/\\]/)[1] || filepath;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

export default function Dashboard() {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [mounted, setMounted] = useState<boolean>(false);

  // Orchestrator States
  const [activeCaseSequence, setActiveCaseSequence] = useState<
    Record<string, string>
  >({});
  const [pendingAiConfigs, setPendingAiConfigs] = useState<
    Record<string, AiConfig>
  >({});
  const [syncingCases, setSyncingCases] = useState<Record<string, boolean>>({});

  // AI Configuration Input States for active panel
  const [activeConfigCase, setActiveConfigCase] = useState<string | null>(null);
  const [subjectName, setSubjectName] = useState<string>("");
  const [subjectEmail, setSubjectEmail] = useState<string>("");
  const [subjectAliases, setSubjectAliases] = useState<string>("");

  useEffect(() => {
    setMounted(true);
    const evtSource = new EventSource("/api/events");

    evtSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setFiles(data);
      setLoading(false);
    };

    return () => evtSource.close();
  }, []);

  // Group files into "Cases" based on their parent directory
  const groupedCases = useMemo(() => {
    const groups: Record<string, StagedFile[]> = {};
    files.forEach((f) => {
      const relPath = getRelativePath(f.filepath);
      let dirName = relPath.substring(0, relPath.lastIndexOf("/"));
      if (!dirName) dirName = "Root Staging Area";

      if (!groups[dirName]) groups[dirName] = [];
      groups[dirName].push(f);
    });

    // Ensure strict alphabetical order (001 before 002)
    Object.values(groups).forEach((group) => {
      group.sort((a, b) => a.filename.localeCompare(b.filename));
    });

    return groups;
  }, [files]);

  const handleScanDirectory = useCallback(() => {
    setIsRefreshing(true);
    fetch("/api/files?sync=true", { cache: "no-store" })
      .catch(console.error)
      .finally(() => setIsRefreshing(false));
  }, []);

  const handleScanMetadata = useCallback(async (fileId: string) => {
    try {
      await fetch("/api/metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
    } catch (error) {
      console.error(error);
    }
  }, []);

  const handleAnalyze = useCallback(async (fileId: string) => {
    try {
      await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
    } catch (error) {
      console.error(error);
    }
  }, []);

  const handleExtract = useCallback(async (fileId: string) => {
    try {
      await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
    } catch (error) {
      console.error(error);
    }
  }, []);

  const handleRunAIAudit = useCallback(
    async (fileId: string, config: AiConfig | null) => {
      try {
        await fetch("/api/filter", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId, subjectCriteria: config }),
        });
      } catch (error) {
        console.error(error);
      }
    },
    [],
  );

  const handleConvertToPdf = useCallback(async (fileId: string) => {
    try {
      await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
    } catch (error) {
      console.error(error);
    }
  }, []);

  const handleSyncBatch = useCallback(
    async (caseName: string, filesToSync: string[]) => {
      setSyncingCases((prev) => ({ ...prev, [caseName]: true }));
      try {
        for (const fileId of filesToSync) {
          await fetch("/api/batch-poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId }),
          });
        }
      } catch (error) {
        console.error(error);
      } finally {
        setSyncingCases((prev) => ({ ...prev, [caseName]: false }));
      }
    },
    [],
  );

  const handleRetry = useCallback(async (filesToRetry: string[]) => {
    try {
      for (const fileId of filesToRetry) {
        await fetch("/api/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId }),
        });
      }
    } catch (error) {
      console.error(error);
    }
  }, []);

  // Chains files together automatically
  useEffect(() => {
    // 1. GLOBAL AI LOCK: Verify if ANY file in the entire workspace is busy processing AI
    // This stops multiple cases from overlapping in OpenAI's queue and exceeding the Tier 1 enqueued limit.
    const isGlobalAiBusy = files.some(
      (f) => f.ai_status === "processing" || f.ai_status === "batch_ready",
    );

    Object.entries(activeCaseSequence).forEach(([caseName, action]) => {
      const caseFiles = groupedCases[caseName];
      if (!caseFiles) return;

      // 2. Check if ANY file in the current case is currently busy with this action
      const caseIsBusy = caseFiles.some(
        (f) =>
          (action === "metadata" && f.status === "scanning_metadata") ||
          (action === "analyze" && f.status === "processing") ||
          (action === "extract" && f.status === "extracting") ||
          (action === "ai" && f.ai_status === "processing") ||
          (action === "pdf" && f.pdf_status === "processing") ||
          (action === "ai" && f.ai_status === "batch_ready"),
      );

      // If the backend is busy processing a file in this case, we wait.
      if (caseIsBusy) return;

      // 3. GLOBAL LOCK GUARD: If the next action is AI, and the AI queue is globally busy, pause and wait.
      if (action === "ai" && isGlobalAiBusy) return;

      // 4. Find the NEXT file in the sequence that needs this action
      const nextFile = caseFiles.find((f) => {
        if (action === "metadata") return f.status === "pending";
        if (action === "analyze") return f.status === "pending_analysis";
        if (action === "extract") return f.status === "analyzed";
        if (action === "ai")
          return (
            f.status === "completed" &&
            (!f.ai_status || f.ai_status === "pending")
          );
        if (action === "pdf")
          return (
            f.ai_status === "completed" &&
            (!f.pdf_status || f.pdf_status === "pending")
          );
        return false;
      });

      // 5. Execute the API call for the next file, or clear the sequence if done
      if (nextFile) {
        if (action === "metadata") handleScanMetadata(nextFile.id);
        else if (action === "analyze") handleAnalyze(nextFile.id);
        else if (action === "extract") handleExtract(nextFile.id);
        else if (action === "ai") {
          // Robust auto-resume: read from state, fallback to saved DB configuration
          const dbConfig = nextFile.subject_name
            ? {
                name: nextFile.subject_name,
                email: nextFile.subject_email || "",
                aliases: nextFile.subject_aliases
                  ? nextFile.subject_aliases.split(",").map((a) => a.trim())
                  : [],
              }
            : null;
          handleRunAIAudit(nextFile.id, pendingAiConfigs[caseName] || dbConfig);
        } else if (action === "pdf") handleConvertToPdf(nextFile.id);
      } else {
        // Sequence completed for all files in this case!
        setActiveCaseSequence((prev) => {
          const next = { ...prev };
          delete next[caseName];
          return next;
        });
      }
    });
  }, [
    activeCaseSequence,
    groupedCases,
    files,
    pendingAiConfigs,
    handleScanMetadata,
    handleAnalyze,
    handleExtract,
    handleRunAIAudit,
    handleConvertToPdf,
  ]);

  function startSequence(caseName: string, action: string) {
    setActiveCaseSequence((prev) => ({ ...prev, [caseName]: action }));
  }

  function submitAiConfigAndStart(caseName: string) {
    if (!subjectName || !subjectEmail) return; // Silent fail if required fields are missing

    setPendingAiConfigs((prev) => ({
      ...prev,
      [caseName]: {
        name: subjectName,
        email: subjectEmail,
        aliases: subjectAliases
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
      },
    }));
    setActiveConfigCase(null);
    startSequence(caseName, "ai");
  }

  // Defer rendering interactive DOM nodes to guarantee 0 SSR/Client hydration mismatches
  if (!mounted) {
    return (
      <main className="min-h-screen bg-slate-900 text-slate-100 p-8 flex items-center justify-center">
        <div className="flex flex-col items-center justify-center text-slate-400 py-12">
          <Loader2 className="w-8 h-8 animate-spin mb-4 text-indigo-500" />
          <p className="text-sm font-medium">
            Connecting to real-time orchestrator...
          </p>
        </div>
      </main>
    );
  }

  const isGlobalScanDisabled =
    loading || isRefreshing || Object.keys(activeCaseSequence).length > 0;

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 p-8">
      <div className="max-w-6xl mx-auto">
        {}
        <header className="mb-10 border-b border-slate-800 pb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
              <Database className="w-8 h-8 text-indigo-500" />
              Unified Case Workspace
            </h1>
            <p className="text-slate-400 mt-2">
              Automated multi-file sequencing, aggregated deduplication, and AI
              auditing.
            </p>
          </div>

          <div className="flex shrink-0">
            <button
              type="button"
              disabled={isGlobalScanDisabled}
              onClick={handleScanDirectory}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 px-5 py-2.5 rounded-lg font-medium text-sm border border-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw
                className={`w-4 h-4 ${isRefreshing ? "animate-spin text-teal-400" : ""}`}
              />
              {isRefreshing ? "Scanning Storage..." : "Scan Directory"}
            </button>
          </div>
        </header>

        {loading && !isRefreshing ? (
          <div className="flex flex-col items-center justify-center text-slate-400 py-12">
            <Loader2 className="w-8 h-8 animate-spin mb-4 text-indigo-500" />
            Connecting to real-time orchestrator...
          </div>
        ) : files.length === 0 ? (
          <div className="text-center border-2 border-dashed border-slate-800 rounded-xl p-12 text-slate-500 flex flex-col items-center">
            <Folder className="w-12 h-12 text-slate-700 mb-4" />
            No compliance target files detected inside the staging directory.
          </div>
        ) : (
          <div className="grid gap-8">
            {Object.entries(groupedCases).map(([caseName, caseFiles]) => {
              // 1. Calculate Aggregated Statistics across all files in the case
              const stats = caseFiles.reduce(
                (acc, file) => {
                  acc.size += file.file_size_bytes || 0;
                  acc.totalEmails += file.total_emails || 0;
                  acc.uniqueEmails += file.unique_emails || 0;
                  acc.duplicateEmails += file.duplicate_emails || 0;
                  acc.estimatedTokens += file.estimated_tokens || 0;
                  acc.aiApproved += file.ai_approved_count || 0;
                  acc.aiDiscarded += file.ai_discarded_count || 0;
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
                },
              );

              const filesToSync = caseFiles
                .filter((f) => f.ai_status === "batch_ready")
                .map((f) => f.id);
              const isSyncing = syncingCases[caseName];

              // Check if a configuration was previously saved in the database for this case
              const hasSavedConfig = caseFiles.some(
                (f) => f.subject_name && f.subject_email,
              );

              // 2. Determine Master Action State
              let caseAction = "";
              let btnText = "";
              let isBusy = false;
              let needsSync = false;
              let isFaulted = false;

              if (
                caseFiles.some(
                  (f) =>
                    f.status === "failed" ||
                    f.pdf_status === "failed" ||
                    f.ai_status === "failed",
                )
              ) {
                isFaulted = true;
                btnText = "Case Faulted";
              } else if (filesToSync.length > 0) {
                needsSync = true;
                btnText = "Sync AI Status";
              } else if (caseFiles.some((f) => f.status === "pending")) {
                caseAction = "metadata";
                btnText = "Scan Metadata Sequence";
              } else if (
                caseFiles.some((f) => f.status === "scanning_metadata")
              ) {
                isBusy = true;
                btnText = "Scanning Headers...";
              } else if (
                caseFiles.some((f) => f.status === "pending_analysis")
              ) {
                caseAction = "analyze";
                btnText = "Analyze Case Sequence";
              } else if (caseFiles.some((f) => f.status === "processing")) {
                isBusy = true;
                btnText = "Analyzing Deduplication...";
              } else if (caseFiles.some((f) => f.status === "analyzed")) {
                caseAction = "extract";
                btnText = `Extract ${stats.uniqueEmails.toLocaleString()} Unique Emails`;
              } else if (caseFiles.some((f) => f.status === "extracting")) {
                isBusy = true;
                btnText = "Exporting Unified Folder...";
              } else if (
                caseFiles.some(
                  (f) =>
                    f.status === "completed" &&
                    (!f.ai_status || f.ai_status === "pending"),
                )
              ) {
                if (hasSavedConfig) {
                  // Perfect resume: immediately run using saved criteria from the DB
                  caseAction = "ai";
                  btnText = "Resume AI Audit Sequence";
                } else {
                  caseAction = "configure_ai";
                  btnText = "Configure AI Audit Sequence";
                }
              } else if (caseFiles.some((f) => f.ai_status === "processing")) {
                isBusy = true;
                btnText = "AI Auditing Unified Folder...";
              } else if (
                caseFiles.some(
                  (f) =>
                    f.ai_status === "completed" &&
                    (!f.pdf_status || f.pdf_status === "pending"),
                )
              ) {
                caseAction = "pdf";
                btnText = "Compile Final PDFs Sequence";
              } else if (caseFiles.some((f) => f.pdf_status === "processing")) {
                isBusy = true;
                btnText = "Rendering PDFs...";
              } else {
                btnText = "Unified DSAR Package Ready";
              }

              const liveProcessedCount =
                stats.uniqueEmails + stats.duplicateEmails;
              const analyzeProgress =
                stats.totalEmails > 0
                  ? Math.min(
                      100,
                      Math.round(
                        (liveProcessedCount / stats.totalEmails) * 100,
                      ),
                    )
                  : 0;

              const aiProcessedCount = stats.aiApproved + stats.aiDiscarded;
              const aiProgress =
                stats.uniqueEmails > 0
                  ? Math.min(
                      100,
                      Math.round((aiProcessedCount / stats.uniqueEmails) * 100),
                    )
                  : 0;

              return (
                <div
                  key={caseName}
                  className={`bg-slate-800 rounded-2xl border p-6 flex flex-col gap-6 shadow-xl transition-all duration-300 ${isBusy || isSyncing ? "border-amber-500/40 bg-slate-800/90" : "border-slate-700"}`}
                >
                  <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-6">
                    <div className="flex-1 space-y-4">
                      <div className="flex items-center gap-3 border-b border-slate-700/50 pb-3">
                        <Folder className="w-6 h-6 text-indigo-400" />
                        <h2
                          className="text-2xl font-bold text-white tracking-wide truncate"
                          title={caseName}
                        >
                          {caseName}
                        </h2>
                      </div>

                      {/* PST File Parts Tracker */}
                      <div className="flex flex-wrap gap-2 pt-1">
                        {caseFiles.map((f, i) => {
                          let activeColorClass =
                            "bg-slate-900/60 border-slate-700/50 text-slate-400";
                          let StatusIcon = FileText;
                          let iconClass = "text-slate-500";
                          let isFileBusy = false;

                          const fileFaulted =
                            f.status === "failed" ||
                            f.pdf_status === "failed" ||
                            f.ai_status === "failed";

                          if (fileFaulted) {
                            StatusIcon = AlertCircle;
                            iconClass = "text-rose-400";
                            activeColorClass =
                              "bg-rose-950/30 border-rose-500/50 text-rose-300";
                          } else if (
                            f.pdf_status === "processing" ||
                            f.ai_status === "processing" ||
                            f.status === "extracting" ||
                            f.status === "processing" ||
                            f.status === "scanning_metadata"
                          ) {
                            isFileBusy = true;
                            StatusIcon = Loader2;
                            iconClass = "animate-spin text-white";

                            if (f.pdf_status === "processing")
                              activeColorClass =
                                "bg-blue-900/40 border-blue-400 text-blue-200 shadow-[0_0_12px_rgba(59,130,246,0.6)]";
                            else if (f.ai_status === "processing")
                              activeColorClass =
                                "bg-emerald-900/40 border-emerald-400 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.6)]";
                            else if (f.status === "extracting")
                              activeColorClass =
                                "bg-purple-900/40 border-purple-400 text-purple-200 shadow-[0_0_12px_rgba(168,85,247,0.6)]";
                            else if (f.status === "processing")
                              activeColorClass =
                                "bg-amber-900/40 border-amber-400 text-amber-200 shadow-[0_0_12px_rgba(245,158,11,0.6)]";
                            else
                              activeColorClass =
                                "bg-indigo-900/40 border-indigo-400 text-indigo-200 shadow-[0_0_12px_rgba(99,102,241,0.6)]";
                          } else if (
                            f.pdf_status === "completed" ||
                            f.ai_status === "completed" ||
                            f.status === "completed" ||
                            f.status === "analyzed" ||
                            f.status === "pending_analysis"
                          ) {
                            StatusIcon = CheckCircle;
                            if (f.pdf_status === "completed") {
                              iconClass = "text-emerald-400";
                              activeColorClass =
                                "bg-emerald-950/20 border-emerald-500/30 text-emerald-500";
                            } else if (
                              f.ai_status === "completed" ||
                              f.status === "completed"
                            ) {
                              iconClass = "text-blue-400";
                              activeColorClass =
                                "bg-blue-950/20 border-blue-500/30 text-blue-400";
                            } else {
                              iconClass = "text-slate-400";
                              activeColorClass =
                                "bg-slate-800/80 border-slate-600/50 text-slate-300";
                            }
                          } else if (f.ai_status === "batch_ready") {
                            StatusIcon = RefreshCw;
                            iconClass = "text-amber-400";
                            activeColorClass =
                              "bg-amber-950/20 border-amber-500/30 text-amber-400";
                          }

                          return (
                            <div
                              key={f.id}
                              className={`text-xs flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition-all duration-300 ${activeColorClass}`}
                            >
                              <span
                                className={`font-mono ${isFileBusy ? "text-white font-bold" : "text-slate-500"}`}
                              >
                                {i + 1}.
                              </span>
                              <span
                                className={`truncate max-w-40 ${isFileBusy ? "font-semibold" : ""}`}
                              >
                                {f.filename}
                              </span>
                              <StatusIcon
                                className={`w-3.5 h-3.5 ml-0.5 ${iconClass}`}
                              />
                            </div>
                          );
                        })}
                      </div>

                      {/* Aggregated Statistics Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">
                        <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-700/50">
                          <span className="block text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">
                            Total Size
                          </span>
                          <span className="text-base font-semibold text-slate-200">
                            {formatBytes(stats.size)}
                          </span>
                        </div>
                        <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-700/50">
                          <span className="block text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">
                            Gross Emails
                          </span>
                          <span className="text-base font-semibold text-slate-200">
                            {stats.totalEmails.toLocaleString()}
                          </span>
                        </div>
                        <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-700/50">
                          <span className="block text-[10px] text-rose-400 font-bold uppercase tracking-wider mb-1">
                            Duplicates
                          </span>
                          <span className="text-base font-semibold text-rose-400 font-mono">
                            {stats.duplicateEmails.toLocaleString()}
                          </span>
                        </div>
                        <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-700/50">
                          <span className="block text-[10px] text-teal-400 font-bold uppercase tracking-wider mb-1">
                            Unique Items
                          </span>
                          <span className="text-base font-semibold text-teal-400 font-mono">
                            {stats.uniqueEmails.toLocaleString()}
                          </span>
                        </div>

                        {(stats.aiApproved > 0 || stats.aiDiscarded > 0) && (
                          <>
                            <div className="bg-emerald-950/20 p-3 rounded-xl border border-emerald-500/30 col-span-2 sm:col-span-1">
                              <span className="block text-[10px] text-emerald-400 font-bold uppercase tracking-wider mb-1">
                                AI Approved
                              </span>
                              <span className="text-base font-semibold text-emerald-300 font-mono">
                                {stats.aiApproved.toLocaleString()}
                              </span>
                            </div>
                            <div className="bg-rose-950/20 p-3 rounded-xl border border-rose-500/30 col-span-2 sm:col-span-1">
                              <span className="block text-[10px] text-rose-400 font-bold uppercase tracking-wider mb-1">
                                AI Discarded
                              </span>
                              <span className="text-base font-semibold text-rose-300 font-mono">
                                {stats.aiDiscarded.toLocaleString()}
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Master Action Section */}
                    <div className="flex flex-col items-end gap-3 min-w-70 shrink-0 xl:pt-2">
                      {isFaulted ? (
                        <button
                          type="button"
                          onClick={() => {
                            const filesToRetry = caseFiles
                              .filter(
                                (f) =>
                                  f.status === "failed" ||
                                  f.pdf_status === "failed" ||
                                  f.ai_status === "failed",
                              )
                              .map((f) => f.id);
                            handleRetry(filesToRetry);
                          }}
                          className="w-full bg-rose-600 hover:bg-rose-500 text-white px-6 py-3.5 rounded-xl font-bold text-sm transition-all shadow-lg shadow-rose-600/20 flex items-center justify-center gap-2"
                        >
                          <RefreshCw className="w-4 h-4 animate-[spin_3s_linear_infinite]" />{" "}
                          Reset & Retry Case
                        </button>
                      ) : needsSync ? (
                        <button
                          type="button"
                          disabled={isSyncing}
                          onClick={() => handleSyncBatch(caseName, filesToSync)}
                          className="w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-3.5 rounded-xl font-bold text-sm transition-all shadow-lg flex items-center justify-center gap-2"
                        >
                          {isSyncing ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />{" "}
                              Syncing...
                            </>
                          ) : (
                            <>
                              <RefreshCw className="w-4 h-4" /> {btnText}
                            </>
                          )}
                        </button>
                      ) : caseAction === "configure_ai" ? (
                        <button
                          type="button"
                          onClick={() => {
                            setActiveConfigCase(caseName);
                            setSubjectName("");
                            setSubjectEmail("");
                            setSubjectAliases("");
                          }}
                          className="w-full bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-3.5 rounded-xl font-bold text-sm transition-all shadow-lg shadow-emerald-600/20 flex items-center justify-center gap-2"
                        >
                          <Play className="w-4 h-4" /> {btnText}
                        </button>
                      ) : caseAction ? (
                        <button
                          type="button"
                          disabled={Object.keys(activeCaseSequence).length > 0}
                          onClick={() => startSequence(caseName, caseAction)}
                          className={`w-full text-white px-6 py-3.5 rounded-xl font-bold text-sm transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed ${
                            caseAction === "metadata"
                              ? "bg-slate-600 hover:bg-slate-500 shadow-slate-600/20"
                              : caseAction === "analyze"
                                ? "bg-blue-600 hover:bg-blue-500 shadow-blue-600/20"
                                : caseAction === "extract"
                                  ? "bg-purple-600 hover:bg-purple-500 shadow-purple-600/20"
                                  : caseAction === "ai"
                                    ? "bg-purple-600 hover:bg-purple-500 shadow-purple-600/20"
                                    : "bg-blue-600 hover:bg-blue-500 shadow-blue-600/20"
                          }`}
                        >
                          <Play className="w-4 h-4" /> {btnText}
                        </button>
                      ) : (
                        <div className="w-full inline-flex justify-center items-center gap-2 px-6 py-3.5 rounded-xl font-bold text-sm bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          <CheckCircle className="w-4 h-4" />
                          <span>{btnText}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Config Panel Dropdown */}
                  {activeConfigCase === caseName && (
                    <div className="bg-slate-900 border border-slate-700/60 rounded-xl p-6 mt-2 space-y-5 shadow-inner">
                      <div className="border-b border-slate-800 pb-3">
                        <h4 className="text-base font-bold text-slate-200">
                          Configure AI Audit Sequence
                        </h4>
                        <p className="text-sm text-slate-400 mt-1">
                          This configuration will be strictly applied across all
                          files in this Unified Case.
                        </p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                        <div>
                          <label
                            htmlFor="subjectName"
                            className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2"
                          >
                            Subject Full Name
                          </label>
                          <input
                            id="subjectName"
                            type="text"
                            value={subjectName}
                            onChange={(e) => setSubjectName(e.target.value)}
                            placeholder="e.g., Rafael Gomes"
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-purple-500 transition-colors"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="subjectEmail"
                            className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2"
                          >
                            Primary Email
                          </label>
                          <input
                            id="subjectEmail"
                            type="email"
                            value={subjectEmail}
                            onChange={(e) => setSubjectEmail(e.target.value)}
                            placeholder="e.g., rgomes@companydomain.com"
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-purple-500 transition-colors"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="subjectAliases"
                            className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2"
                          >
                            Aliases (Comma Separated)
                          </label>
                          <input
                            id="subjectAliases"
                            type="text"
                            value={subjectAliases}
                            onChange={(e) => setSubjectAliases(e.target.value)}
                            placeholder="e.g., Rafael G., RGomes"
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-purple-500 transition-colors"
                          />
                        </div>
                      </div>

                      <div className="flex justify-end gap-3 pt-4 border-t border-slate-800/50">
                        <button
                          type="button"
                          onClick={() => setActiveConfigCase(null)}
                          className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-5 py-2.5 rounded-lg text-sm font-bold border border-slate-700 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => submitAiConfigAndStart(caseName)}
                          className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-6 py-2.5 rounded-lg text-sm font-bold transition-colors shadow-lg shadow-purple-600/20"
                        >
                          <Play className="w-4 h-4" /> Launch Sequence
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Unified Progress Bar */}
                  {isBusy && (
                    <div className="mt-2 pt-4 border-t border-slate-700/50">
                      <div className="flex justify-between text-sm font-semibold text-slate-400 mb-2 px-1">
                        <span>Unified Case Engine Running...</span>
                        <span className="font-mono text-amber-400">
                          {btnText.includes("AI")
                            ? `${aiProcessedCount.toLocaleString()} items audited (${aiProgress}%)`
                            : btnText.includes("Analyzing")
                              ? `${liveProcessedCount.toLocaleString()} parsed (${analyzeProgress}%)`
                              : btnText.includes("Exporting")
                                ? "Saving to disk..."
                                : ""}
                        </span>
                      </div>
                      <div className="w-full bg-slate-900 rounded-full h-3 overflow-hidden border border-slate-700/50 shadow-inner">
                        <div
                          className={`h-3 rounded-full transition-all duration-700 ease-out ${
                            btnText.includes("Scanning")
                              ? "bg-linear-to-r from-indigo-500 to-purple-500 w-full animate-[pulse_1.5s_infinite]"
                              : btnText.includes("Exporting")
                                ? "bg-linear-to-r from-purple-500 to-indigo-500 w-full animate-[pulse_1.5s_infinite]"
                                : btnText.includes("AI")
                                  ? "bg-linear-to-r from-emerald-500 to-teal-500"
                                  : btnText.includes("Rendering")
                                    ? "bg-linear-to-r from-blue-500 to-indigo-500 w-full animate-[pulse_1.5s_infinite]"
                                    : "bg-linear-to-r from-amber-500 to-yellow-400"
                          }`}
                          style={{
                            width: btnText.includes("AI")
                              ? `${aiProgress}%`
                              : btnText.includes("Analyzing")
                                ? `${analyzeProgress}%`
                                : "100%",
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
