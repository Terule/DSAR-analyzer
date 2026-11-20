"use client";

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchRunHistory } from "@/lib/api";
import type { CaseHistoryItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { count, formatClock } from "./case-view";
import { Drawer, DrawerHeader } from "./Drawer";
import { Btn, Card, EmptyPanel, Page, PageHeader, SearchBox } from "./ui";

// A manual DSAR case takes about a month. Time saved is that baseline less the
// processing time actually spent, for successful cases only.
const MANUAL_CASE_MS = 30 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const PERIODS = [
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "year", label: "This year", days: null },
  { key: "all", label: "All time", days: null },
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];

function inPeriod(item: CaseHistoryItem, period: PeriodKey): boolean {
  const at = Date.parse(item.finalized_at);
  if (Number.isNaN(at) || period === "all") return true;
  if (period === "year")
    return new Date(at).getFullYear() === new Date().getFullYear();
  return Date.now() - at <= Number(period) * DAY;
}

function shortDate(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function caseTitle(item: CaseHistoryItem): string {
  const parts = item.case_key.split(/[\\/]/).filter(Boolean);
  const name = parts[0] || item.case_key;
  const request = item.request_key?.trim() || parts[1];
  return request ? `${name} · ${request}` : name;
}

function removedPercent(item: CaseHistoryItem): number {
  const received = item.total_emails + item.files_total;
  if (received <= 0) return 0;
  const delivered = item.emails_selected + item.files_processed;
  return Math.max(
    0,
    Math.min(100, Math.round(((received - delivered) / received) * 100)),
  );
}

function PeriodMenu({
  value,
  onChange,
}: {
  value: PeriodKey;
  onChange: (value: PeriodKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const current = PERIODS.find((period) => period.key === value) ?? PERIODS[1];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((state) => !state)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-[10px] border border-aida-input-line bg-aida-sidebar px-3.5 py-[9px] text-[13px] font-medium text-aida-text-2 hover:bg-aida-nav-active"
      >
        {current.label}
        <ChevronDown className="size-3 text-aida-muted" strokeWidth={1.5} />
      </button>
      {open ? (
        <div className="absolute right-0 top-11 z-20 flex w-44 flex-col rounded-xl border border-aida-input-line bg-aida-surface p-1.5 shadow-2xl">
          {PERIODS.map((period) => (
            <button
              type="button"
              key={period.key}
              onClick={() => {
                onChange(period.key);
                setOpen(false);
              }}
              className={cn(
                "rounded-md px-3 py-2 text-left text-[13px] hover:bg-aida-nav-active",
                period.key === value
                  ? "font-semibold text-aida-text"
                  : "text-aida-text-2",
              )}
            >
              {period.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function HistoryPage() {
  const [items, setItems] = useState<CaseHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("90");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<CaseHistoryItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchRunHistory({ limit: 500 });
      setItems(result.data);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not load the history.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter((item) => inPeriod(item, period))
      .filter(
        (item) => !needle || caseTitle(item).toLowerCase().includes(needle),
      )
      .sort(
        (left, right) =>
          Date.parse(right.finalized_at) - Date.parse(left.finalized_at),
      );
  }, [items, period, query]);

  const summary = useMemo(() => {
    const total = visible.reduce(
      (sum, item) => sum + item.total_duration_ms,
      0,
    );
    const saved = visible.reduce(
      (sum, item) =>
        sum +
        (item.terminal_outcome === "success"
          ? Math.max(0, MANUAL_CASE_MS - item.total_duration_ms)
          : 0),
      0,
    );
    return {
      cases: visible.length,
      average: visible.length ? Math.round(total / visible.length) : 0,
      savedHours: Math.round(saved / 3_600_000),
    };
  }, [visible]);

  const periodLabel = (
    PERIODS.find((entry) => entry.key === period) ?? PERIODS[1]
  ).label.toLowerCase();

  return (
    <Page>
      <PageHeader
        title="History"
        subtitle="Archived cases and what the system saved"
        actions={
          <>
            <PeriodMenu value={period} onChange={setPeriod} />
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder="Search cases or employees"
            />
          </>
        }
      />
      <div className="grid grid-cols-3 gap-4">
        <Card className="flex flex-col gap-1.5 p-5">
          <span className="text-[13px] text-aida-muted">Archived cases</span>
          <span className="text-[32px] font-bold leading-10 text-aida-text">
            {summary.cases}
          </span>
          <span className="text-xs text-aida-muted">in the {periodLabel}</span>
        </Card>
        <Card className="flex flex-col gap-1.5 p-5">
          <span className="text-[13px] text-aida-muted">
            Average time per case
          </span>
          <span className="text-[32px] font-bold leading-10 text-aida-text">
            {summary.cases ? formatClock(summary.average) : "—"}
          </span>
          <span className="text-xs text-aida-muted">from intake to PDFs</span>
        </Card>
        <Card className="flex flex-col gap-1.5 p-5">
          <span className="text-[13px] text-aida-muted">Time saved</span>
          <span className="text-[32px] font-bold leading-10 text-aida-text">
            {summary.cases ? `${count(summary.savedHours)} h` : "—"}
          </span>
          <span className="text-xs text-aida-muted">
            estimate compared with manual review
          </span>
        </Card>
      </div>

      {error ? (
        <EmptyPanel title="Could not load the history" text={error}>
          <Btn kind="soft" onClick={() => void load()}>
            Try again
          </Btn>
        </EmptyPanel>
      ) : loading ? (
        <div className="h-52 animate-pulse rounded-2xl bg-aida-surface" />
      ) : items.length === 0 ? (
        <EmptyPanel
          title="Nothing archived yet"
          text="Archived cases appear here with what the system saved you."
        />
      ) : visible.length === 0 ? (
        <EmptyPanel
          title={
            query
              ? `No archived cases match “${query}”`
              : `No archived cases in the ${periodLabel}`
          }
          text={
            query
              ? "Check the spelling, or search by employee or client name."
              : "Try a longer period."
          }
        >
          <Btn
            kind="soft"
            onClick={() => {
              setQuery("");
              setPeriod("all");
            }}
          >
            Show all time
          </Btn>
        </EmptyPanel>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid h-11 grid-cols-[1fr_1.5fr_1fr_1fr_0.8fr_1fr] items-center gap-4 bg-aida-surface-2 px-5 text-[11px] font-semibold uppercase tracking-[0.08em] text-aida-dim">
            <span>Archived on</span>
            <span>Case</span>
            <span>Emails delivered</span>
            <span>Files delivered</span>
            <span>Removed</span>
            <span>Duration</span>
          </div>
          {visible.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => setOpen(item)}
              className="grid h-[60px] w-full grid-cols-[1fr_1.5fr_1fr_1fr_0.8fr_1fr] items-center gap-4 border-b border-aida-line px-5 text-left text-sm last:border-b-0 hover:bg-aida-nav-active/40"
            >
              <span className="text-aida-muted">
                {shortDate(item.finalized_at)}
              </span>
              <span className="truncate font-semibold text-aida-text">
                {caseTitle(item)}
              </span>
              <span className="text-aida-text-2">
                {count(item.emails_selected)}
              </span>
              <span className="text-aida-text-2">
                {count(item.files_processed)}
              </span>
              <span className="font-semibold text-aida-text">
                {removedPercent(item)}%
              </span>
              <span className="text-aida-muted">
                {formatClock(item.total_duration_ms)}
              </span>
            </button>
          ))}
        </Card>
      )}

      <Drawer open={!!open} onClose={() => setOpen(null)} width={560}>
        {open ? (
          <div className="flex flex-col gap-5 pb-8">
            <DrawerHeader
              title={caseTitle(open)}
              subtitle={`Archived on ${shortDate(open.finalized_at)}`}
              onClose={() => setOpen(null)}
            />
            <div className="mx-6 grid grid-cols-3 gap-3">
              {[
                [count(open.emails_selected), "emails delivered"],
                [count(open.files_processed), "files delivered"],
                [`${removedPercent(open)}%`, "removed"],
              ].map(([value, label]) => (
                <div
                  key={label}
                  className="rounded-xl border border-aida-card-line bg-aida-surface p-4"
                >
                  <div className="text-2xl font-bold text-aida-text">
                    {value}
                  </div>
                  <div className="text-xs text-aida-muted">{label}</div>
                </div>
              ))}
            </div>
            <div className="mx-6 divide-y divide-aida-line overflow-hidden rounded-xl border border-aida-card-line bg-aida-surface">
              {[
                ["Archived on", shortDate(open.finalized_at)],
                [
                  "Outcome",
                  open.terminal_outcome === "success"
                    ? "Success"
                    : open.terminal_outcome === "failed"
                      ? "Failed"
                      : "Partial",
                ],
                ["Emails read", count(open.total_emails)],
                ["Duplicates", count(open.duplicate_emails)],
                ["Emails discarded", count(open.emails_discarded)],
                ["Files found", count(open.files_total)],
                ["Time", formatClock(open.total_duration_ms)],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between px-4 py-3 text-[13px]"
                >
                  <span className="text-aida-muted">{label}</span>
                  <span className="font-medium text-aida-text">{value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Drawer>
    </Page>
  );
}
