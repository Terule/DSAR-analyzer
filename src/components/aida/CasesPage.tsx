"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { maskCaseName } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ArchiveCaseModal,
  ConfigureCaseModal,
  DeleteCaseModal,
  NewCaseModal,
} from "./CaseDialogs";
import {
  caseCompleted,
  caseHasFailure,
  caseInProgress,
  caseSummary,
  formatClock,
  type SegmentState,
} from "./case-view";
import { useCases } from "./cases-context";
import type { CaseItem } from "./types";
import {
  Btn,
  Card,
  Dot,
  EmptyPanel,
  FilterChip,
  Page,
  PageHeader,
  SearchBox,
} from "./ui";

const SEGMENT_COLOR: Record<SegmentState, string> = {
  done: "bg-aida-green",
  active: "bg-aida-primary",
  failed: "bg-[#f87171]",
  idle: "bg-aida-track",
};
const TONE_DOT = {
  running: "bg-aida-primary",
  done: "bg-aida-green-dot",
  failed: "bg-aida-red",
  waiting: "bg-aida-amber",
  idle: "bg-aida-dim",
} as const;

const GRID =
  "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.1fr)_80px_minmax(0,1fr)_224px_100px_40px] items-center gap-4 px-5";

export function PipelineBar({
  segments,
  className,
}: {
  segments: SegmentState[];
  className?: string;
}) {
  return (
    <div
      className={cn("flex gap-1", className)}
      role="img"
      aria-label="Pipeline progress"
    >
      {segments.map((state, index) => (
        <span
          // The five steps never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed positions
          key={index}
          className={cn("h-1.5 flex-1 rounded-[3px]", SEGMENT_COLOR[state])}
        />
      ))}
    </div>
  );
}

function RowMenu({
  item,
  onConfigure,
  onArchive,
  onDelete,
}: {
  item: CaseItem;
  onConfigure: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const canArchive = caseCompleted(item);
  const entry = (
    label: string,
    action: () => void,
    extra?: string,
    disabled?: boolean,
  ) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        action();
      }}
      className={cn(
        "rounded-md px-3 py-3 text-left text-[15px] text-aida-text-2 hover:bg-aida-nav-active disabled:pointer-events-none disabled:opacity-40 sm:py-2 sm:text-[13px]",
        extra,
      )}
    >
      {label}
    </button>
  );
  return (
    <div ref={ref} className="relative z-10 justify-self-end">
      <button
        type="button"
        aria-label="Case actions"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className="rounded-md p-1.5 text-aida-dim hover:bg-aida-nav-active hover:text-aida-text"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
            }}
            className="fixed inset-0 z-20 cursor-default bg-[#05080f]/75 sm:hidden"
          />
          <div className="fixed inset-x-0 bottom-0 z-30 flex flex-col rounded-t-[20px] border border-aida-input-line bg-aida-surface p-5 pb-6 shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-8 sm:z-20 sm:w-[218px] sm:rounded-xl sm:p-1.5">
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-aida-line sm:hidden" />
            <div className="mb-1 text-lg font-bold text-aida-text sm:hidden">
              {item.name}
            </div>
            {entry("Open", () => router.push(`/cases/${item.id}`))}
            {entry("Configure", onConfigure)}
            {entry("Statistics", () =>
              router.push(`/cases/${item.id}?view=statistics`),
            )}
            <div className="my-1 h-px bg-aida-line" />
            {entry("Archive", onArchive, undefined, !canArchive)}
            {entry("Delete", onDelete, "text-aida-red hover:text-aida-red")}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
              }}
              className="mt-3 w-fit rounded-[10px] border border-aida-input-line px-4 py-2.5 text-[13px] font-medium text-aida-text-2 sm:hidden"
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function SkeletonRows() {
  return (
    <Card className="overflow-hidden">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex items-center gap-6 px-5 py-[22px]">
          {[200, 160, 60, 120, 220, 80].map((width) => (
            <span
              key={width}
              style={{ width }}
              className="h-3 animate-pulse rounded-md bg-[#1b2335]"
            />
          ))}
        </div>
      ))}
    </Card>
  );
}

export function CasesPage() {
  const { cases, loading, privacyMode } = useCases();
  const router = useRouter();
  const [filter, setFilter] = useState<"all" | "progress" | "completed">("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [_scanning, setScanning] = useState(false);
  const [configure, setConfigure] = useState<CaseItem | null>(null);
  const [archive, setArchive] = useState<CaseItem | null>(null);
  const [remove, setRemove] = useState<CaseItem | null>(null);

  const opening = useSearchParams();
  useEffect(() => {
    if (opening.get("new") === "1") {
      setCreating(true);
      router.replace("/");
    }
  }, [opening, router]);
  useEffect(() => {
    const open = () => setCreating(true);
    window.addEventListener("aida:new-case", open);
    return () => window.removeEventListener("aida:new-case", open);
  }, []);

  const inProgress = cases.filter(caseInProgress).length;
  const failed = cases.filter(caseHasFailure).length;
  const completed = cases.filter(caseCompleted).length;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return cases.filter((item) => {
      if (filter === "progress" && !caseInProgress(item)) return false;
      if (filter === "completed" && !caseCompleted(item)) return false;
      if (!needle) return true;
      return `${item.name} ${item.subject_name} ${item.subject_email}`
        .toLowerCase()
        .includes(needle);
    });
  }, [cases, filter, query]);

  const subtitle = [
    `${cases.length} ${cases.length === 1 ? "case" : "cases"}`,
    inProgress ? `${inProgress} in progress` : null,
    failed ? `${failed} with an error` : null,
    privacyMode ? "names hidden" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Page>
      <PageHeader
        title="Cases"
        subtitle={
          loading ? " " : cases.length === 0 ? "No cases yet" : subtitle
        }
        actions={
          <>
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder="Search cases or employees"
            />
            <Btn
              kind="primary"
              className="px-4 text-sm font-semibold"
              onClick={() => setCreating(true)}
            >
              <Plus className="size-3.5" strokeWidth={2} /> New case
            </Btn>
          </>
        }
      />
      {cases.length > 0 ? (
        <div className="flex gap-2">
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All {cases.length}
          </FilterChip>
          <FilterChip
            active={filter === "progress"}
            onClick={() => setFilter("progress")}
          >
            In progress {inProgress}
          </FilterChip>
          <FilterChip
            active={filter === "completed"}
            onClick={() => setFilter("completed")}
          >
            Completed {completed}
          </FilterChip>
        </div>
      ) : null}

      {loading ? (
        <SkeletonRows />
      ) : cases.length === 0 ? (
        <EmptyPanel
          icon="＋"
          title="Create first case"
          text="A case gathers requests of one data subject. Start from a new case; the system then reads, filters and prepares the delivery."
        >
          <Btn kind="primary" onClick={() => setCreating(true)}>
            New case
          </Btn>
          <Btn kind="secondary" onClick={() => setScanning(true)}>
            Scan input folder
          </Btn>
        </EmptyPanel>
      ) : visible.length === 0 ? (
        <EmptyPanel
          title={`No cases match “${query}”`}
          text="Check spelling, or search by employee or client name"
        >
          <Btn kind="soft" onClick={() => setQuery("")}>
            Clear search
          </Btn>
        </EmptyPanel>
      ) : (
        <Card className="overflow-visible">
          <div
            className={cn(
              GRID,
              "h-11 rounded-t-2xl bg-aida-surface-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-aida-dim",
            )}
          >
            <span>Case</span>
            <span>Subject</span>
            <span>Requests</span>
            <span>Stage</span>
            <span>Pipeline</span>
            <span>Duration</span>
            <span />
          </div>
          {visible.map((item) => {
            const summary = caseSummary(item);
            return (
              <div
                key={item.id}
                className={cn(
                  GRID,
                  "relative h-16 border-b border-aida-line last:rounded-b-2xl last:border-b-0 hover:bg-aida-nav-active/40",
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Link
                    href={`/cases/${item.id}`}
                    className="truncate text-sm font-semibold text-aida-text after:absolute after:inset-0 after:content-['']"
                  >
                    {privacyMode ? maskCaseName(item.name) : item.name}
                  </Link>
                  <span className="text-xs capitalize text-aida-muted">
                    {item.case_type}
                  </span>
                </div>
                <span className="truncate text-sm text-aida-text-2">
                  {privacyMode
                    ? item.subject_name.replace(/[^\s]/g, "•")
                    : item.subject_name || "—"}
                </span>
                <span className="text-sm text-aida-text-2">
                  {item.requests.length}
                </span>
                <span className="flex items-center gap-2 text-[13px] font-medium text-aida-text-2">
                  <Dot className={TONE_DOT[summary.tone]} />
                  {summary.label}
                </span>
                <PipelineBar segments={summary.segments} />
                <span className="text-[13px] text-aida-muted">
                  {summary.workMs ? formatClock(summary.workMs) : "—"}
                </span>
                <RowMenu
                  item={item}
                  onConfigure={() => setConfigure(item)}
                  onArchive={() => setArchive(item)}
                  onDelete={() => setRemove(item)}
                />
              </div>
            );
          })}
        </Card>
      )}

      <NewCaseModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(created) => router.push(`/cases/${created.id}`)}
      />
      <ConfigureCaseModal
        target={configure}
        onClose={() => setConfigure(null)}
      />
      <ArchiveCaseModal target={archive} onClose={() => setArchive(null)} />
      <DeleteCaseModal target={remove} onClose={() => setRemove(null)} />
    </Page>
  );
}
