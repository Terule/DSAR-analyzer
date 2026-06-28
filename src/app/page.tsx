"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CaseCard } from "@/components/dashboard/CaseCard";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { ConnectingState, EmptyState } from "@/components/dashboard/EmptyState";
import { NotificationToast } from "@/components/dashboard/NotificationToast";
import { StandalonePanel } from "@/components/dashboard/StandalonePanel";
import { TabNavigation } from "@/components/dashboard/TabNavigation";
import { useFileStream } from "@/hooks/useFileStream";
import { useNotification } from "@/hooks/useNotification";
import * as api from "@/lib/api";
import { getRelativePath } from "@/lib/format";
import type { AiConfig, StagedFile, TabKey } from "@/lib/types";

export default function Dashboard() {
  const { files, loading } = useFileStream();
  const { notification, setNotification } = useNotification();

  const [activeTab, setActiveTab] = useState<TabKey>("pst");
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [activeCaseSequence, setActiveCaseSequence] = useState<
    Record<string, string>
  >({});
  const [pendingAiConfigs, setPendingAiConfigs] = useState<
    Record<string, AiConfig>
  >({});
  const [syncingCases, setSyncingCases] = useState<Record<string, boolean>>({});
  const [resettingCases, setResettingCases] = useState<Record<string, boolean>>(
    {},
  );
  const [activeConfigCase, setActiveConfigCase] = useState<string | null>(null);
  const [openMetrics, setOpenMetrics] = useState<Record<string, boolean>>({});

  const isSequenceLocked = Object.keys(activeCaseSequence).length > 0;

  const groupedCases = useMemo(() => {
    const groups: Record<string, StagedFile[]> = {};
    files.forEach((f) => {
      const relPath = getRelativePath(f.filepath);
      let dirName = relPath.substring(0, relPath.lastIndexOf("/"));
      if (!dirName) dirName = "Root Staging Area";

      if (!groups[dirName]) groups[dirName] = [];
      groups[dirName].push(f);
    });

    Object.values(groups).forEach((group) => {
      group.sort((a, b) => a.filename.localeCompare(b.filename));
    });
    return groups;
  }, [files]);

  const toggleMetrics = (caseName: string) => {
    setOpenMetrics((prev) => ({ ...prev, [caseName]: !prev[caseName] }));
  };

  // API Callbacks
  const handleScanDirectory = useCallback(() => {
    setIsRefreshing(true);
    api
      .scanDirectory()
      .catch(console.error)
      .finally(() => setIsRefreshing(false));
  }, []);

  const handleScanMetadata = useCallback(async (fileId: string) => {
    try {
      await api.scanMetadata(fileId);
    } catch (_e) {}
  }, []);

  const handleAnalyze = useCallback(async (fileId: string) => {
    try {
      await api.analyzeFile(fileId);
    } catch (_e) {}
  }, []);

  const handleExtract = useCallback(async (fileId: string) => {
    try {
      await api.extractFile(fileId);
    } catch (_e) {}
  }, []);

  const handleRunAIAudit = useCallback(
    async (fileId: string, config: AiConfig) => {
      try {
        await api.runAiAudit(fileId, config);
      } catch (_e) {}
    },
    [],
  );

  const handleConvertToPdf = useCallback(async (fileId: string) => {
    try {
      await api.convertToPdf(fileId);
    } catch (_e) {}
  }, []);

  const handleSyncBatch = useCallback(
    async (caseName: string, filesToSync: string[]) => {
      setSyncingCases((prev) => ({ ...prev, [caseName]: true }));
      let stillProcessing = false;
      let wasReverted = false;
      try {
        for (const fileId of filesToSync) {
          const data = await api.pollBatch(fileId);
          if (
            data.status === "in_progress" ||
            data.status === "validating" ||
            data.status === "finalizing"
          )
            stillProcessing = true;
          if (data.status === "reverted") wasReverted = true;
        }

        if (wasReverted)
          setNotification({
            type: "error",
            message: "Stuck batch detected: Auto-healing initiated.",
          });
        else if (stillProcessing)
          setNotification({
            type: "info",
            message:
              "OpenAI is still processing this batch. Check back in a few minutes.",
          });
        else
          setNotification({
            type: "success",
            message: "Sync successful: Batch status updated.",
          });
      } catch (_err) {
        setNotification({
          type: "error",
          message: "Network error during sync.",
        });
      } finally {
        setSyncingCases((prev) => ({ ...prev, [caseName]: false }));
      }
    },
    [setNotification],
  );

  const handleResetCase = useCallback(
    async (caseName: string, fileIds: string[]) => {
      if (
        !window.confirm(
          `Are you sure you want to permanently reset case "${caseName}"? This will delete all extracted data.`,
        )
      )
        return;
      setResettingCases((prev) => ({ ...prev, [caseName]: true }));
      try {
        const ok = await api.wipeCase(caseName, fileIds);
        if (!ok) throw new Error("Wipe failed");
        setActiveCaseSequence((prev) => {
          const next = { ...prev };
          delete next[caseName];
          return next;
        });
        setNotification({
          type: "success",
          message: "Case reset successfully.",
        });
      } catch (_err) {
        setNotification({ type: "error", message: "Failed to reset case." });
      } finally {
        setResettingCases((prev) => ({ ...prev, [caseName]: false }));
      }
    },
    [setNotification],
  );

  useEffect(() => {
    const isGlobalAiBusy = files.some(
      (f) => f.ai_status === "processing" || f.ai_status === "batch_ready",
    );

    Object.entries(activeCaseSequence).forEach(([caseName, action]) => {
      const caseFiles = groupedCases[caseName];
      if (!caseFiles) return;

      const caseIsBusy = caseFiles.some(
        (f) =>
          (action === "metadata" && f.status === "scanning_metadata") ||
          (action === "analyze" && f.status === "processing") ||
          (action === "extract" && f.status === "extracting") ||
          (action === "ai" && f.ai_status === "processing") ||
          (action === "pdf" && f.pdf_status === "processing") ||
          (action === "ai" && f.ai_status === "batch_ready"),
      );

      if (caseIsBusy || (action === "ai" && isGlobalAiBusy)) return;

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

      if (nextFile) {
        if (action === "metadata") handleScanMetadata(nextFile.id);
        else if (action === "analyze") handleAnalyze(nextFile.id);
        else if (action === "extract") handleExtract(nextFile.id);
        else if (action === "ai")
          handleRunAIAudit(nextFile.id, pendingAiConfigs[caseName]);
        else if (action === "pdf") handleConvertToPdf(nextFile.id);
      } else {
        if (action === "metadata")
          setActiveCaseSequence((prev) => ({ ...prev, [caseName]: "analyze" }));
        else if (action === "analyze")
          setActiveCaseSequence((prev) => ({ ...prev, [caseName]: "extract" }));
        else if (action === "ai")
          setActiveCaseSequence((prev) => ({ ...prev, [caseName]: "pdf" }));
        else
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

  const startSequence = useCallback((caseName: string, action: string) => {
    setActiveCaseSequence((prev) => ({ ...prev, [caseName]: action }));
  }, []);

  const submitAiConfigAndStart = useCallback(
    (caseName: string, config: AiConfig) => {
      setPendingAiConfigs((prev) => ({ ...prev, [caseName]: config }));
      setActiveConfigCase(null);
      startSequence(caseName, "ai");
    },
    [startSequence],
  );

  const isGlobalScanDisabled = loading || isRefreshing || isSequenceLocked;

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 p-4 sm:p-8 font-sans">
      {notification && <NotificationToast notification={notification} />}

      <div className="max-w-6xl mx-auto">
        <DashboardHeader
          showScanButton={activeTab === "pst"}
          isRefreshing={isRefreshing}
          scanDisabled={isGlobalScanDisabled}
          onScan={handleScanDirectory}
        />

        <TabNavigation activeTab={activeTab} onChange={setActiveTab} />

        {activeTab === "pst" &&
          (loading && !isRefreshing ? (
            <ConnectingState />
          ) : files.length === 0 ? (
            <EmptyState />
          ) : (
            // CRITICAL FIX: items-start prevents grids from stretching when accordion opens
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
              {Object.entries(groupedCases).map(([caseName, caseFiles]) => (
                <CaseCard
                  key={caseName}
                  caseName={caseName}
                  caseFiles={caseFiles}
                  isSequenceLocked={isSequenceLocked}
                  isSyncing={!!syncingCases[caseName]}
                  isResetting={!!resettingCases[caseName]}
                  isMetricsOpen={!!openMetrics[caseName]}
                  isConfigOpen={activeConfigCase === caseName}
                  onToggleMetrics={() => toggleMetrics(caseName)}
                  onOpenConfig={() => setActiveConfigCase(caseName)}
                  onCloseConfig={() => setActiveConfigCase(null)}
                  onSync={(ids) => handleSyncBatch(caseName, ids)}
                  onReset={(ids) => handleResetCase(caseName, ids)}
                  onStartSequence={(action) => startSequence(caseName, action)}
                  onSubmitAiConfig={(config) =>
                    submitAiConfigAndStart(caseName, config)
                  }
                />
              ))}
            </div>
          ))}

        {activeTab === "standalone" && <StandalonePanel />}
      </div>
    </main>
  );
}
