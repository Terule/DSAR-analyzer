"use client";

import { useEffect, useState } from "react";

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
  estimated_tokens?: number; // Added token estimate
}

export default function Dashboard() {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [globalLock, setGlobalLock] = useState<boolean>(false);
  const [mounted, setMounted] = useState<boolean>(false);

  // Real-time connection (Server-Sent Events)
  useEffect(() => {
    setMounted(true);

    const evtSource = new EventSource("/api/events");

    evtSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setFiles(data);

      const isAnyProcessing = data.some(
        (f: StagedFile) =>
          f.status === "scanning_metadata" ||
          f.status === "processing" ||
          f.status === "extracting",
      );
      setGlobalLock(isAnyProcessing);
      setLoading(false);
    };

    return () => evtSource.close();
  }, []);

  function handleScanDirectory() {
    setIsRefreshing(true);

    fetch("/api/files?sync=true", { cache: "no-store" })
      .catch((error) => console.error("Scan failed:", error))
      .finally(() => setIsRefreshing(false));
  }

  async function handleScanMetadata(fileId: string) {
    setGlobalLock(true);
    try {
      await fetch("/api/metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
    } catch (error) {
      console.error("Metadata scan failed:", error);
      setGlobalLock(false);
    }
  }

  async function handleAnalyze(fileId: string) {
    setGlobalLock(true);
    try {
      await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
    } catch (error) {
      console.error("Analysis process initiation failed:", error);
      setGlobalLock(false);
    }
  }

  async function handleExtract(fileId: string) {
    setGlobalLock(true);
    try {
      await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
    } catch (error) {
      console.error("Extraction operation failed:", error);
    } finally {
      setGlobalLock(false);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
  }

  // Helper to extract the path after 'staging-area'
  function getRelativePath(filepath: string) {
    if (!filepath) return "";
    return filepath.split(/staging-area[/\\]/)[1] || filepath;
  }

  const isScanDisabled = !mounted
    ? false
    : loading || isRefreshing || globalLock;
  const isActionDisabled = !mounted ? false : globalLock;

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8 border-b border-slate-800 pb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              PST DSAR Analyzer
            </h1>
            <p className="text-slate-400 mt-2">
              Compliance deduplication workspace. Drop large PST or split ZIP
              exports into
              <code className="bg-slate-800 text-teal-400 px-1.5 py-0.5 rounded mx-1 text-sm font-mono">
                staging-area/
              </code>
              to begin.
            </p>
          </div>

          <div className="flex shrink-0">
            <button
              type="button"
              disabled={isScanDisabled}
              onClick={handleScanDirectory}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2 rounded-lg font-medium text-sm border border-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg
                className={`w-4 h-4 ${mounted && isRefreshing ? "animate-spin text-teal-400" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.253 8H18"
                />
              </svg>
              {mounted && isRefreshing ? "Scanning..." : "Scan Directory"}
            </button>
          </div>
        </header>

        {loading && !isRefreshing ? (
          <div className="text-center text-slate-400 py-12">
            Connecting to real-time engine...
          </div>
        ) : files.length === 0 ? (
          <div className="text-center border-2 border-dashed border-slate-800 rounded-xl p-12 text-slate-500">
            No compliance target files detected inside the staging directory.
            Click "Scan Directory" to check again.
          </div>
        ) : (
          <div className="grid gap-6">
            {files.map((file) => {
              const isScanningMetadata = file.status === "scanning_metadata";
              const isDeepAnalyzing = file.status === "processing";
              const isExtracting = file.status === "extracting";
              const isBusy =
                isScanningMetadata || isDeepAnalyzing || isExtracting;

              const liveProcessedCount =
                (file.unique_emails || 0) + (file.duplicate_emails || 0);
              const hasTotal = file.total_emails && file.total_emails > 0;
              const percentComplete = hasTotal
                ? Math.min(
                    100,
                    Math.round((liveProcessedCount / file.total_emails) * 100),
                  )
                : null;

              return (
                <div
                  key={file.id}
                  className={`bg-slate-800 rounded-xl border p-6 flex flex-col gap-6 shadow-xl transition-all duration-200 ${
                    isBusy
                      ? "border-amber-500/40 bg-slate-800/90"
                      : file.status === "failed"
                        ? "border-rose-500/30"
                        : "border-slate-700 hover:border-slate-600"
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
                    <div className="space-y-2 flex-1">
                      <div className="flex items-start sm:items-center gap-3">
                        <div className="flex flex-col">
                          <h3 className="text-lg font-semibold text-white truncate max-w-md">
                            {file.filename}
                          </h3>
                          <span
                            className="text-xs text-slate-500 font-mono mt-0.5 truncate max-w-md"
                            title={file.filepath}
                          >
                            {getRelativePath(file.filepath)}
                          </span>
                        </div>
                        <span
                          className={`text-xs px-2.5 py-1 rounded-full font-medium tracking-wide mt-1 sm:mt-0 ${
                            file.status === "completed"
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : file.status === "extracting"
                                ? "bg-purple-500/20 text-purple-300 border border-purple-500/30 animate-pulse"
                                : file.status === "analyzed"
                                  ? "bg-teal-500/10 text-teal-400 border border-teal-500/20"
                                  : file.status === "pending"
                                    ? "bg-slate-500/10 text-slate-400 border border-slate-500/20"
                                    : file.status === "scanning_metadata"
                                      ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
                                      : file.status === "processing"
                                        ? "bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse"
                                        : file.status === "failed"
                                          ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                                          : "bg-slate-700 text-slate-300"
                          }`}
                        >
                          {file.status === "scanning_metadata"
                            ? "SCANNING HEADERS"
                            : file.status.toUpperCase().replace("_", " ")}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-4 text-sm pt-2">
                        <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-700/50 min-w-25">
                          <span className="block text-xs text-slate-500 font-medium">
                            FILE SIZE
                          </span>
                          <span className="font-semibold text-slate-300">
                            {formatBytes(file.file_size_bytes)}
                          </span>
                        </div>
                        <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-700/50 min-w-25">
                          <span className="block text-xs text-slate-500 font-medium">
                            TOTAL EMAILS
                          </span>
                          <span className="font-semibold text-slate-300">
                            {file.total_emails || "—"}
                          </span>
                        </div>

                        {(file.total_attachments > 0 ||
                          file.status === "analyzed" ||
                          file.status === "completed") && (
                          <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-700/50 min-w-25">
                            <span className="block text-xs text-slate-500 font-medium">
                              ATTACHMENTS
                            </span>
                            <span className="font-semibold text-slate-300">
                              {file.total_attachments || "0"}
                            </span>
                          </div>
                        )}

                        {(file.status === "analyzed" ||
                          file.status === "completed" ||
                          file.status === "processing") && (
                          <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-700/50 min-w-25">
                            <span className="block text-xs text-rose-400 font-medium">
                              DUPLICATES
                            </span>
                            <span className="font-semibold text-rose-400 font-mono">
                              {file.duplicate_emails}
                            </span>
                          </div>
                        )}

                        {/* NEW: Display Estimated Tokens once extraction begins */}
                        {(file.status === "extracting" ||
                          file.status === "completed") && (
                          <div className="bg-purple-900/20 p-2.5 rounded-lg border border-purple-500/30 min-w-25">
                            <span className="block text-xs text-purple-400 font-medium">
                              TOKENS (EST.)
                            </span>
                            <span className="font-semibold text-purple-300 font-mono">
                              {file.estimated_tokens
                                ? file.estimated_tokens.toLocaleString()
                                : "0"}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 border-t border-slate-700/50 pt-4 md:border-0 md:pt-0 shrink-0">
                      {file.status === "pending" && (
                        <button
                          type="button"
                          disabled={isActionDisabled}
                          onClick={() => handleScanMetadata(file.id)}
                          className="w-full md:w-auto bg-slate-700 hover:bg-slate-600 text-white px-5 py-2.5 rounded-lg font-medium text-sm transition-colors border border-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Scan Metadata
                        </button>
                      )}

                      {file.status === "scanning_metadata" && (
                        <div className="w-full md:w-auto inline-flex items-center gap-2 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-5 py-2.5 rounded-lg font-medium text-sm">
                          <svg
                            className="animate-spin h-4 w-4 text-indigo-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            xmlns="http://www.w3.org/2000/svg"
                            aria-hidden="true"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                          Reading file info...
                        </div>
                      )}

                      {file.status === "pending_analysis" && (
                        <button
                          type="button"
                          disabled={isActionDisabled}
                          onClick={() => handleAnalyze(file.id)}
                          className="w-full md:w-auto bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-lg font-medium text-sm transition-colors shadow-lg shadow-blue-600/10 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Analyze File
                        </button>
                      )}

                      {file.status === "processing" && (
                        <div className="w-full md:w-auto inline-flex items-center gap-2 bg-amber-500/10 text-amber-400 border border-amber-500/20 px-5 py-2.5 rounded-lg font-medium text-sm">
                          <svg
                            className="animate-spin h-4 w-4 text-amber-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            xmlns="http://www.w3.org/2000/svg"
                            aria-hidden="true"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                          Deduplicating...
                        </div>
                      )}

                      {file.status === "analyzed" && (
                        <button
                          type="button"
                          disabled={isActionDisabled}
                          onClick={() => handleExtract(file.id)}
                          className="w-full md:w-auto bg-purple-600 hover:bg-purple-500 text-white px-5 py-2.5 rounded-lg font-medium text-sm transition-colors shadow-lg shadow-purple-600/10 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Extract {file.unique_emails} Emails
                        </button>
                      )}

                      {file.status === "extracting" && (
                        <div className="w-full md:w-auto inline-flex items-center gap-2 bg-purple-500/10 text-purple-400 border border-purple-500/20 px-5 py-2.5 rounded-lg font-medium text-sm">
                          <svg
                            className="animate-spin h-4 w-4 text-purple-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            xmlns="http://www.w3.org/2000/svg"
                            aria-hidden="true"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                          Extracting to JSON...
                        </div>
                      )}

                      {file.status === "completed" && (
                        <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium bg-emerald-500/5 border border-emerald-500/10 px-4 py-2.5 rounded-lg">
                          ✓ Ready for AI Filtering
                        </div>
                      )}

                      {file.status === "failed" && (
                        <div className="flex items-center gap-2 text-rose-400 text-sm font-medium bg-rose-500/5 border border-rose-500/10 px-4 py-2.5 rounded-lg">
                          ⚠️ Scan Faulted
                        </div>
                      )}
                    </div>
                  </div>

                  {isBusy && (
                    <div className="mt-2">
                      <div className="flex justify-between text-xs font-medium text-slate-400 mb-1.5 px-1">
                        <span>
                          {isScanningMetadata
                            ? "Initializing Headers..."
                            : isExtracting
                              ? "Exporting Unique Emails to JSON Data..."
                              : "Cryptographic Scan"}
                        </span>
                        {(file.status === "processing" ||
                          file.status === "extracting") && (
                          <span className="font-mono text-amber-400">
                            {file.status === "extracting"
                              ? "Saving to Disk..."
                              : `${liveProcessedCount.toLocaleString()} parsed ${percentComplete !== null ? `(${percentComplete}%)` : ""}`}
                          </span>
                        )}
                      </div>
                      <div className="w-full bg-slate-900 rounded-full h-2.5 overflow-hidden border border-slate-700/50">
                        <div
                          className={`h-2.5 rounded-full transition-all duration-700 ease-out ${
                            isScanningMetadata
                              ? "bg-linear-to-r from-indigo-500 to-purple-500 w-full animate-[pulse_1.5s_infinite]"
                              : isExtracting
                                ? "bg-linear-to-r from-purple-500 to-indigo-500 w-full animate-[pulse_1.5s_infinite]"
                                : "bg-linear-to-r from-amber-500 to-yellow-400"
                          }`}
                          style={{
                            width:
                              percentComplete !== null && isDeepAnalyzing
                                ? `${percentComplete}%`
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
