"use client";
import { useEffect, useState } from "react";
import { count, formatClock, formatUsd } from "./case-view";
import type { CaseItem, RequestItem } from "./types";
import { Btn, Modal } from "./ui";
import type { Insights } from "./use-insights";

interface CaseStatistics {
  requests: Array<{
    requestId: string;
    name: string;
    removedPercent: number | null;
    costUsd: number;
    inputTokens: number;
  }>;
  costUsd: number;
}

const COST_NOTE =
  "Cost is an Amazon Bedrock estimate from token counts, not an invoice. It covers the 1st analysis (Haiku 4.5, Batch rates); the 2nd analysis is a few items and is not counted.";

function requestTime(request: RequestItem): number {
  return Object.values(request.phaseTiming ?? {}).reduce(
    (sum, value) => sum + value,
    0,
  );
}

function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-aida-input-line bg-aida-surface-2 p-3.5">
      <span className="text-xl font-semibold text-aida-text">{value}</span>
      <span className="text-xs text-aida-muted">{label}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-[13px]">
      <span className="text-aida-muted">{label}</span>
      <span className="font-medium text-aida-text">{value}</span>
    </div>
  );
}

function useCaseStatistics(caseId: string, open: boolean) {
  const [data, setData] = useState<CaseStatistics | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setData(null);
    fetch(`/api/cases/${caseId}/statistics`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body) setData(body as CaseStatistics);
      })
      .catch(() => {
        // The shell already shows when the connection is lost.
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, open]);
  return data;
}

/** Statistics of the whole case (all its requests) or of one request. */
export function StatisticsModal({
  mode,
  item,
  request,
  insights,
  onClose,
}: {
  mode: "case" | "request" | null;
  item: CaseItem;
  request: RequestItem | null;
  insights: Insights | null;
  onClose: () => void;
}) {
  const data = useCaseStatistics(item.id, mode !== null);
  const footer = (
    <Btn kind="ghost" onClick={onClose}>
      Close
    </Btn>
  );

  if (mode === "request" && request) {
    const mail = request.stats?.mail;
    const files = request.stats?.files;
    const cost = data?.requests.find((row) => row.requestId === request.id);
    const delivered =
      (request.phaseProgress?.render?.done ?? 0) + (files?.delivered ?? 0);
    return (
      <Modal
        open
        onClose={onClose}
        title={`Statistics · ${request.name}`}
        description="Numbers for this request only."
        width={560}
        footer={footer}
      >
        <div className="divide-y divide-aida-line overflow-hidden rounded-xl border border-aida-input-line bg-aida-surface-2">
          <Row label="Emails read" value={count(mail?.scanned ?? 0)} />
          <Row label="Unique emails" value={count(mail?.unique ?? 0)} />
          <Row label="Delivered" value={count(delivered)} />
          <Row
            label="For human review"
            value={count(insights?.funnel.forReview ?? 0)}
          />
          <Row
            label="1st analysis"
            value={`${count((insights?.funnel.ai.kept ?? 0) + (insights?.funnel.ai.discarded ?? 0))} items`}
          />
          <Row
            label="Reanalysing"
            value={`${count(insights?.reanalysing ?? 0)} items`}
          />
          <Row label="Time" value={formatClock(requestTime(request))} />
          <Row
            label="AI cost (estimate)"
            value={cost ? formatUsd(cost.costUsd) : "—"}
          />
        </div>
      </Modal>
    );
  }

  if (mode !== "case") return null;
  const time = item.requests.reduce(
    (sum, entry) => sum + requestTime(entry),
    0,
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={`Statistics · ${item.name}`}
      description="All requests of case."
      width={640}
      footer={footer}
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-3 gap-3">
          <Kpi
            value={`${item.requests.length} request${item.requests.length === 1 ? "" : "s"}`}
            label={item.requests.map((entry) => entry.name).join(", ") || "—"}
          />
          <Kpi value={formatClock(time)} label="time so far" />
          <Kpi
            value={data ? formatUsd(data.costUsd) : "—"}
            label="AI cost so far"
          />
        </div>
        <div className="overflow-hidden rounded-xl border border-aida-input-line bg-aida-surface-2">
          <div className="grid grid-cols-4 gap-3 border-b border-aida-line px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-aida-dim">
            <span>Request</span>
            <span>Emails</span>
            <span>Files</span>
            <span>Removed</span>
          </div>
          {item.requests.map((entry) => {
            const row = data?.requests.find((r) => r.requestId === entry.id);
            const mailCount = entry.stats?.mail.unique ?? 0;
            const fileCount = entry.stats?.files.found ?? 0;
            return (
              <div
                key={entry.id}
                className="grid grid-cols-4 gap-3 px-4 py-3 text-[13px] text-aida-text-2"
              >
                <span>{entry.name}</span>
                <span>{mailCount ? count(mailCount) : "—"}</span>
                <span>{fileCount ? count(fileCount) : "—"}</span>
                <span>
                  {row?.removedPercent != null ? `${row.removedPercent}%` : "—"}
                </span>
              </div>
            );
          })}
        </div>
        <p className="rounded-[10px] border border-aida-primary-line bg-[#0f1830] px-3.5 py-3 text-[13px] leading-5 text-aida-text-2">
          {COST_NOTE}
        </p>
      </div>
    </Modal>
  );
}
