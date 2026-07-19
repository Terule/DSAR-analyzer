"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaseCard } from "@/components/dashboard/CaseCard";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { ConnectingState, EmptyState } from "@/components/dashboard/EmptyState";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useFileStream } from "@/hooks/useFileStream";
import { useNotification } from "@/hooks/useNotification";
import * as api from "@/lib/api";
import { getCaseKey } from "@/lib/format";
import type { AiConfig, StagedFile } from "@/lib/types";

export default function Dashboard() {
  const { files, loading } = useFileStream();
  const { setNotification } = useNotification();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [privacyMode, setPrivacyMode] = useState(false);

  // Tracks Files phases already kicked off so the orchestrator doesn't
  // double-spawn a worker while the DB status catches up via SSE.
  const filesStartedRef = useRef<Set<string>>(new Set());

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
  const [launchingCase, setLaunchingCase] = useState<string | null>(null);
  const [wipeDialog, setWipeDialog] = useState<{
    caseName: string;
    fileIds: string[];
  } | null>(null);
  const [openMetrics, setOpenMetrics] = useState<Record<string, boolean>>({});

  // Cache of the previous grouping so we can preserve array reference identity
  // for cases whose contents did not change. The SSE stream re-emits the full
  // snapshot on every tick, so without this every memoized CaseCard would
  // re-render each update (whole-page repaint/blink) instead of only the case
  // that actually changed.
  const prevGroupsRef = useRef<Record<string, StagedFile[]>>({});

  const groupedCases = useMemo(() => {
    const groups: Record<string, StagedFile[]> = {};
    files.forEach((f) => {
      const caseKey = getCaseKey(f.filepath);
      if (!groups[caseKey]) groups[caseKey] = [];
      groups[caseKey].push(f);
    });

    Object.values(groups).forEach((group) => {
      group.sort((a, b) => a.filename.localeCompare(b.filename));
    });

    // Reuse the prior array reference for any case whose serialized contents are
    // identical, so React.memo can skip re-rendering unchanged CaseCards.
    const prev = prevGroupsRef.current;
    const stable: Record<string, StagedFile[]> = {};
    for (const [key, group] of Object.entries(groups)) {
      const prevGroup = prev[key];
      stable[key] =
        prevGroup && JSON.stringify(prevGroup) === JSON.stringify(group)
          ? prevGroup
          : group;
    }
    prevGroupsRef.current = stable;
    return stable;
  }, [files]);

  // A launch persists subject criteria before its Parse job begins, so this
  // remains true through every hand-off (including a queued job or OpenAI Batch
  // wait), not merely while a worker container is visible.
  const activeCaseNames = useMemo(
    () =>
      Object.entries(groupedCases)
        .filter(([, caseFiles]) => {
          const pstFiles = caseFiles.filter((file) => file.kind !== "files");
          if (pstFiles.length === 0) return false;
          const wasLaunched = pstFiles.some((file) => !!file.subject_name);
          if (!wasLaunched) return false;
          const faulted = pstFiles.some(
            (file) =>
              file.status === "failed" ||
              file.ai_status === "failed" ||
              file.pdf_status === "failed",
          );
          const renderComplete = pstFiles.every(
            (file) => file.pdf_status === "completed",
          );
          const filesRow = caseFiles.find((file) => file.kind === "files");
          const filesSettled =
            !filesRow ||
            filesRow.files_status === "completed" ||
            filesRow.files_status === "failed";
          return !faulted && !(renderComplete && filesSettled);
        })
        .map(([caseName]) => caseName),
    [groupedCases],
  );
  const activeCaseName =
    launchingCase ??
    activeCaseNames[0] ??
    Object.keys(activeCaseSequence)[0] ??
    null;

  useEffect(() => {
    if (
      launchingCase &&
      groupedCases[launchingCase]?.some((file) => !!file.subject_name)
    ) {
      setLaunchingCase(null);
    }
  }, [groupedCases, launchingCase]);

  useEffect(() => {
    if (
      activeConfigCase &&
      activeCaseName &&
      activeConfigCase !== activeCaseName
    )
      setActiveConfigCase(null);
  }, [activeCaseName, activeConfigCase]);

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
      } catch (_e) {
        setNotification({
          type: "error",
          message: "Failed to start AI audit. Please retry Launch AI Audit.",
        });
      }
    },
    [setNotification],
  );

  const handleConvertToPdf = useCallback(async (fileId: string) => {
    try {
      await api.convertToPdf(fileId);
    } catch (_e) {}
  }, []);

  const handleProcessFiles = useCallback(
    async (fileId: string, config: AiConfig) => {
      try {
        await api.processFiles(fileId, config);
      } catch (_e) {
        setNotification({
          type: "error",
          message: "Failed to start Files processing.",
        });
      }
    },
    [setNotification],
  );

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
      setResettingCases((prev) => ({ ...prev, [caseName]: true }));
      try {
        const ok = await api.wipeCase(caseName, fileIds);
        if (!ok) throw new Error("Wipe failed");

        filesStartedRef.current.delete(caseName);

        setActiveCaseSequence((prev) => {
          const next = { ...prev };
          delete next[caseName];
          return next;
        });

        setPendingAiConfigs((prev) => {
          const next = { ...prev };
          delete next[caseName];
          return next;
        });

        setOpenMetrics((prev) => {
          const next = { ...prev };
          delete next[caseName];
          return next;
        });

        setActiveConfigCase((prev) => (prev === caseName ? null : prev));

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

  const requestResetCase = useCallback(
    (caseName: string, fileIds: string[]) =>
      setWipeDialog({ caseName, fileIds }),
    [],
  );

  const confirmResetCase = useCallback(() => {
    if (!wipeDialog) return;
    const { caseName, fileIds } = wipeDialog;
    setWipeDialog(null);
    void handleResetCase(caseName, fileIds);
  }, [handleResetCase, wipeDialog]);

  useEffect(() => {
    const isGlobalAiBusy = files.some(
      (f) => f.ai_status === "processing" || f.ai_status === "batch_ready",
    );

    const isGlobalPdfBusy = files.some((f) => f.pdf_status === "processing");

    Object.entries(activeCaseSequence).forEach(([caseName, action]) => {
      const caseFiles = groupedCases[caseName];
      if (!caseFiles) return;

      // Files phase runs sequentially, AFTER the email pipeline (RENDER).
      if (action === "files") {
        const filesRow = caseFiles.find((f) => f.kind === "files");
        const config = pendingAiConfigs[caseName];
        const finish = () =>
          setActiveCaseSequence((prev) => {
            const next = { ...prev };
            delete next[caseName];
            return next;
          });

        if (!filesRow || !config) {
          finish();
          return;
        }

        const filesStatus = filesRow.files_status || "pending";
        if (filesStatus === "processing") return;
        if (filesStatus === "completed" || filesStatus === "failed") {
          filesStartedRef.current.delete(caseName);
          finish();
          return;
        }

        // Pending: kick it off once.
        if (!filesStartedRef.current.has(caseName)) {
          filesStartedRef.current.add(caseName);
          handleProcessFiles(filesRow.id, config);
        }
        return;
      }

      // AI is case-level: a single run audits the emails of EVERY PST file in
      // the request (they share the .unique-emails folder). One deterministic
      // "coordinator" row (smallest id) holds the live batch state; its status
      // is mirrored to all PST rows on completion.
      if (action === "ai") {
        const pstOnly = caseFiles.filter((f) => f.kind !== "files");
        if (pstOnly.length === 0) {
          setActiveCaseSequence((prev) => ({ ...prev, [caseName]: "pdf" }));
          return;
        }

        const coordinator = [...pstOnly].sort((a, b) =>
          a.id.localeCompare(b.id),
        )[0];
        const coordAi = coordinator.ai_status || "pending";

        // Wait while this case's AI is running or another case holds the AI slot.
        if (
          coordAi === "processing" ||
          coordAi === "batch_ready" ||
          isGlobalAiBusy
        ) {
          return;
        }

        // Finished (all PST rows mirrored to completed/failed) -> render.
        if (coordAi === "completed" || coordAi === "failed") {
          setActiveCaseSequence((prev) => ({ ...prev, [caseName]: "pdf" }));
          return;
        }

        // Pending: start once every PST file has finished extraction.
        if (pstOnly.every((f) => f.status === "completed")) {
          handleRunAIAudit(coordinator.id, pendingAiConfigs[caseName]);
        }
        return;
      }

      const caseIsBusy = caseFiles.some(
        (f) =>
          (action === "metadata" && f.status === "scanning_metadata") ||
          (action === "analyze" && f.status === "processing") ||
          (action === "extract" && f.status === "extracting") ||
          (action === "ai" && f.ai_status === "processing") ||
          (action === "pdf" && f.pdf_status === "processing") ||
          (action === "ai" && f.ai_status === "batch_ready"),
      );

      if (
        caseIsBusy ||
        (action === "ai" && isGlobalAiBusy) ||
        (action === "pdf" && isGlobalPdfBusy)
      )
        return;

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
        else if (action === "extract")
          setActiveCaseSequence((prev) => ({ ...prev, [caseName]: "ai" }));
        else if (action === "ai")
          setActiveCaseSequence((prev) => ({ ...prev, [caseName]: "pdf" }));
        else if (action === "pdf")
          setActiveCaseSequence((prev) => ({ ...prev, [caseName]: "files" }));
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
    handleProcessFiles,
  ]);

  const startSequence = useCallback((caseName: string, action: string) => {
    setActiveCaseSequence((prev) => ({ ...prev, [caseName]: action }));
  }, []);

  const submitAiConfigAndStart = useCallback(
    async (caseName: string, config: AiConfig) => {
      const coordinator = groupedCases[caseName]
        ?.filter((file) => file.kind === "pst")
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!coordinator) {
        setNotification({
          type: "error",
          message: "This case has no PST files to process.",
        });
        return;
      }
      setPendingAiConfigs((prev) => ({ ...prev, [caseName]: config }));
      setActiveConfigCase(null);
      setLaunchingCase(caseName);
      try {
        await api.startCase(coordinator.id, config);
      } catch (error) {
        setLaunchingCase(null);
        setNotification({
          type: "error",
          message:
            error instanceof Error ? error.message : "Failed to start case.",
        });
      }
    },
    [groupedCases, setNotification],
  );

  const isGlobalScanDisabled = loading || isRefreshing || !!activeCaseName;

  const togglePrivacy = useCallback(() => {
    setPrivacyMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("dsar_privacy", next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    setIsHydrated(true);
    try {
      setPrivacyMode(localStorage.getItem("dsar_privacy") === "1");
    } catch {}
  }, []);

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 p-4 sm:p-8 font-sans">
      <AlertDialog
        open={Boolean(wipeDialog)}
        onOpenChange={(open) => {
          if (!open) setWipeDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Wipe this case?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes this case&apos;s extracted data and
              resets its pipeline progress. The original staged source files are
              kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmResetCase}>
              Wipe case
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="max-w-6xl mx-auto">
        <DashboardHeader
          showScanButton
          isRefreshing={isRefreshing}
          scanDisabled={isHydrated ? isGlobalScanDisabled : false}
          onScan={handleScanDirectory}
          privacyMode={privacyMode}
          onTogglePrivacy={togglePrivacy}
        />

        {loading && !isRefreshing ? (
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
                privacyMode={privacyMode}
                hasAiConfig={
                  !!pendingAiConfigs[caseName] ||
                  caseFiles.some((file) => !!file.subject_name)
                }
                isBlockedByAnotherCase={
                  !!activeCaseName && activeCaseName !== caseName
                }
                isSyncing={!!syncingCases[caseName]}
                isResetting={!!resettingCases[caseName]}
                isMetricsOpen={!!openMetrics[caseName]}
                isConfigOpen={activeConfigCase === caseName}
                onToggleMetrics={() => toggleMetrics(caseName)}
                onOpenConfig={() => setActiveConfigCase(caseName)}
                onCloseConfig={() => setActiveConfigCase(null)}
                onSync={(ids) => handleSyncBatch(caseName, ids)}
                onReset={(ids) => requestResetCase(caseName, ids)}
                onStartSequence={(action) => startSequence(caseName, action)}
                onSubmitAiConfig={(config) =>
                  submitAiConfigAndStart(caseName, config)
                }
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
