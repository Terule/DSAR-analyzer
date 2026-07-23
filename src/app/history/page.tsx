"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchRunHistory } from "@/lib/api";
import type { CaseHistoryItem } from "@/lib/types";

// A manual DSAR case typically takes about one month. Successful cases are
// credited with that full avoided turnaround time instead of a per-item guess.
const MANUAL_CASE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function formatLocalDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

function formatOutcome(outcome: CaseHistoryItem["terminal_outcome"]): string {
  if (outcome === "success") return "Success";
  if (outcome === "failed") return "Failed";
  return "Partial";
}

function formatArchivedReason(
  reason: CaseHistoryItem["archived_reason"],
): string {
  if (reason === "completed") return "Completed";
  if (reason === "manual_reset") return "Manual Reset";
  return "Source Deleted";
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function getDisplayCase(caseKey: string): string {
  return caseKey.split(/[\\/]/).filter(Boolean)[0] || caseKey;
}

function getDisplayRequest(item: CaseHistoryItem): string {
  if (item.request_key && item.request_key.trim().length > 0) {
    return item.request_key;
  }
  const parts = item.case_key.split(/[\\/]/).filter(Boolean);
  return parts[1] || "-";
}

function estimateTimeSavedMs(item: CaseHistoryItem): number {
  return item.terminal_outcome === "success" ? MANUAL_CASE_DURATION_MS : 0;
}

export default function HistoryPage() {
  const [items, setItems] = useState<CaseHistoryItem[]>([]);
  const [caseFilterInput, setCaseFilterInput] = useState("");
  const [activeCaseFilter, setActiveCaseFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchRunHistory({
        caseKey: activeCaseFilter || undefined,
        limit: 500,
      });
      setItems(result.data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch run history.",
      );
    } finally {
      setLoading(false);
    }
  }, [activeCaseFilter]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const summary = useMemo(() => {
    let success = 0;
    let failed = 0;
    let partial = 0;
    let totalDurationMs = 0;
    let totalEstimatedTimeSavedMs = 0;

    for (const item of items) {
      if (item.terminal_outcome === "success") success++;
      else if (item.terminal_outcome === "failed") failed++;
      else partial++;
      totalDurationMs += item.total_duration_ms;
      totalEstimatedTimeSavedMs += estimateTimeSavedMs(item);
    }

    return {
      success,
      failed,
      partial,
      avgDurationMs:
        items.length > 0 ? Math.round(totalDurationMs / items.length) : 0,
      totalEstimatedTimeSavedMs,
    };
  }, [items]);

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 p-4 sm:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              Case History
            </h1>
            <p className="text-slate-400 mt-2 font-medium">
              Archived case metrics for efficiency tracking over time.
            </p>
          </div>

          <Link
            href="/"
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-xl font-semibold text-sm border shadow-sm transition-colors bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
          >
            Back to Dashboard
          </Link>
        </header>

        <section className="grid grid-cols-1 sm:grid-cols-5 gap-4">
          <div className="rounded-xl border border-slate-700 bg-slate-800/70 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">
              Success
            </div>
            <div className="text-2xl font-bold text-emerald-300 mt-1">
              {summary.success}
            </div>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/70 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">
              Failed
            </div>
            <div className="text-2xl font-bold text-rose-300 mt-1">
              {summary.failed}
            </div>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/70 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">
              Partial
            </div>
            <div className="text-2xl font-bold text-amber-300 mt-1">
              {summary.partial}
            </div>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/70 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">
              Avg Total Time
            </div>
            <div className="text-xl font-bold text-sky-300 mt-1">
              {formatDuration(summary.avgDurationMs)}
            </div>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/70 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">
              Approx Time Saved
            </div>
            <div className="text-xl font-bold text-indigo-300 mt-1">
              {formatDuration(summary.totalEstimatedTimeSavedMs)}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="text"
              placeholder="Filter by case (TB) or case/request (TB/R1)"
              value={caseFilterInput}
              onChange={(event) => setCaseFilterInput(event.target.value)}
              className="w-full sm:flex-1 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              type="button"
              onClick={() => setActiveCaseFilter(caseFilterInput.trim())}
              className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold border border-slate-600 bg-slate-700 hover:bg-slate-600 transition-colors"
            >
              Apply Filter
            </button>
            <button
              type="button"
              onClick={() => {
                setCaseFilterInput("");
                setActiveCaseFilter("");
              }}
              className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold border border-slate-600 bg-slate-800 hover:bg-slate-700 transition-colors"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={loadHistory}
              className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold border border-slate-600 bg-slate-800 hover:bg-slate-700 transition-colors"
            >
              Refresh
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-slate-700 bg-slate-800/40 overflow-hidden">
          {loading ? (
            <div className="p-6 text-slate-300">Loading case history...</div>
          ) : error ? (
            <div className="p-6 text-rose-300">{error}</div>
          ) : items.length === 0 ? (
            <div className="p-6 text-slate-300">
              No archived case metrics found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/80 text-slate-300">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold">
                      Archived At
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">Case</th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Request
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Outcome
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Reason
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Total Time
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Approx Time Saved
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">Rows</th>
                    <th className="text-left px-4 py-3 font-semibold">
                      PST Rows
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Files Rows
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Total Emails
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Unique Emails
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Email Duplicates
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Total Files
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Files Processed
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Files Skipped
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      File Duplicates
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Parse Time
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Analyze Time
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Extract Time
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      AI Time
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      PDF Time
                    </th>
                    <th className="text-left px-4 py-3 font-semibold">
                      Files Time
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      className="border-t border-slate-700/60 align-top"
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatLocalDate(item.created_at)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {getDisplayCase(item.case_key) || "-"}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {getDisplayRequest(item)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatOutcome(item.terminal_outcome)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatArchivedReason(item.archived_reason)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-semibold text-sky-300">
                        {formatDuration(item.total_duration_ms)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-semibold text-indigo-300">
                        {formatDuration(estimateTimeSavedMs(item))}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {item.source_rows}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {item.pst_rows}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {item.files_rows}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {item.total_emails}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {item.unique_emails}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {item.duplicate_emails}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {item.files_total}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {item.files_processed}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {item.files_skipped}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {item.files_duplicates}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDuration(item.metadata_duration_ms)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDuration(item.analyze_duration_ms)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDuration(item.extract_duration_ms)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDuration(item.ai_duration_ms)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDuration(item.pdf_duration_ms)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDuration(item.files_duration_ms)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
