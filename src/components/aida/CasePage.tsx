"use client";

import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { formatBytes, maskCaseName } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ArchiveCaseModal,
  ConfigureCaseModal,
  DeleteCaseModal,
  WipeCaseModal,
} from "./CaseDialogs";
import { count, formatClock, isConfigured, requestStage } from "./case-view";
import { useCases } from "./cases-context";
import { DecisionsPanel } from "./DecisionsPanel";
import { Drawer, DrawerHeader } from "./Drawer";
import { ItemPanel } from "./ItemPanel";
import {
  ContinueWaveModal,
  DeleteRequestModal,
  NewRequestModal,
  ResetRequestModal,
  StopWorkModal,
} from "./RequestDialogs";
import { ScanInputModal } from "./ScanInputModal";
import { SendOneTrustModal } from "./SendOneTrustModal";
import { StatisticsModal } from "./StatisticsModal";
import type { CaseItem, RequestItem } from "./types";
import { UploadSharePointModal } from "./UploadSharePointModal";
import { Btn, Card, Dot, EmptyPanel, Page } from "./ui";
import { type Insights, useInsights } from "./use-insights";

type StageState = "done" | "active" | "failed" | "idle";

interface StageCard {
  key: "parse" | "extract" | "ai" | "render" | "files";
  name: string;
  state: StageState;
  value: string;
  sub: string;
  progress: number | null;
}

const ACTIVE = ["processing", "batch_ready", "extracting", "analyzed"];

function phaseState(status: string | undefined): StageState {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status && ACTIVE.includes(status)) return "active";
  return "idle";
}

function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
}

function buildStages(
  request: RequestItem,
  insights: Insights | null,
  client: boolean,
): StageCard[] {
  const progress = request.phaseProgress;
  const mail = request.stats?.mail;
  const files = request.stats?.files;
  const cards: StageCard[] = [];
  const parse = progress?.parse;
  const parseState = phaseState(parse?.status);
  cards.push({
    key: "parse",
    name: "Read",
    state: parseState,
    value:
      parse && parse.total > 0 && parseState !== "idle"
        ? `${parse.done} / ${parse.total}`
        : "—",
    sub:
      parseState === "idle"
        ? "not started"
        : `PSTs · ${count(mail?.scanned ?? request.total_emails)} emails`,
    progress:
      parse && parse.total > 0 ? percent(parse.done, parse.total) : null,
  });
  const extract = progress?.extract;
  const extractState = phaseState(extract?.status);
  cards.push({
    key: "extract",
    name: "Prepare",
    state: extractState,
    value: extractState === "idle" ? "—" : count(mail?.unique ?? 0),
    sub: extractState === "idle" ? "not started" : "unique emails",
    progress:
      extract && extract.total > 0
        ? percent(extract.done, extract.total)
        : null,
  });
  const ai = progress?.ai;
  const aiState = phaseState(ai?.status);
  const split = insights?.funnel.ai;
  const reviewed = split ? split.kept + split.discarded + split.review : 0;
  const aiTotal = split?.total ?? 0;
  const aiStarted = aiState !== "idle" || reviewed > 0;
  cards.push({
    key: "ai",
    name: "AI",
    state: aiState,
    value: !aiStarted
      ? "—"
      : client
        ? count(aiTotal)
        : aiState === "done"
          ? count(reviewed)
          : `${count(reviewed)} / ${count(aiTotal)}`,
    sub: !aiStarted
      ? "not started"
      : client
        ? "items screened"
        : aiState === "done"
          ? "emails reviewed"
          : `emails reviewed · ${percent(reviewed, aiTotal)}%`,
    progress:
      aiStarted && aiTotal > 0 && aiState !== "done" && !client
        ? percent(reviewed, aiTotal)
        : aiStarted && aiState === "done"
          ? 100
          : null,
  });
  const render = progress?.render;
  const renderState = phaseState(render?.status);
  const failedPdfs =
    render && render.total > 0 ? Math.max(0, render.total - render.done) : 0;
  cards.push({
    key: "render",
    name: "PDFs",
    state: renderState,
    value:
      renderState === "idle"
        ? "—"
        : renderState === "done"
          ? count(render?.done ?? 0)
          : `${count(render?.done ?? 0)} / ${count(render?.total ?? 0)}`,
    sub:
      renderState === "idle"
        ? aiState === "done"
          ? "not started"
          : "waiting for the AI review"
        : renderState === "done"
          ? "emails delivered"
          : renderState === "failed"
            ? `built · ${count(failedPdfs)} failed`
            : "built so far",
    progress:
      render && render.total > 0
        ? percent(render.done, render.total)
        : renderState === "done"
          ? 100
          : null,
  });
  if (request.scope !== "mail") {
    const filesPhase = progress?.files;
    const filesState = phaseState(filesPhase?.status);
    const filesAi = progress?.filesAi;
    const state =
      filesState === "done" && filesAi && filesAi.status !== "completed"
        ? "active"
        : filesState;
    cards.push({
      key: "files",
      name: "Files",
      state,
      value:
        state === "idle"
          ? filesPhase && filesPhase.total > 0
            ? count(filesPhase.total)
            : "—"
          : state === "done"
            ? count(files?.delivered ?? filesPhase?.done ?? 0)
            : count(filesPhase?.total ?? 0),
      sub:
        state === "idle"
          ? filesPhase && filesPhase.total > 0
            ? "files queued"
            : "not started"
          : state === "done"
            ? "files delivered"
            : state === "failed"
              ? "failed"
              : "files queued",
      progress:
        filesPhase && filesPhase.total > 0 && state !== "idle"
          ? percent(filesPhase.done, filesPhase.total)
          : state === "done"
            ? 100
            : null,
    });
  }
  return cards;
}

const BAR_TONE: Record<StageState, string> = {
  done: "bg-aida-green",
  active: "bg-aida-primary",
  failed: "bg-[#f87171]",
  idle: "bg-aida-dim",
};

function Stage({
  card,
  selected,
  onClick,
}: {
  card: StageCard;
  selected?: boolean;
  onClick?: () => void;
}) {
  const idle = card.state === "idle";
  const cue = card.key === "ai" && !idle;
  return (
    <button
      type="button"
      disabled={!onClick || (idle && card.key !== "ai")}
      onClick={onClick}
      className={cn(
        "grid min-w-0 flex-1 grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-[14px] border p-3.5 text-left md:flex md:flex-col md:items-stretch md:gap-2 md:p-4",
        selected
          ? "border-[1.5px] border-aida-primary bg-[#111a33]"
          : idle
            ? "border-aida-line bg-aida-surface-2"
            : "border-aida-card-line bg-aida-surface hover:border-aida-primary-line/60",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Dot className={idle ? "bg-[#3a4560]" : BAR_TONE[card.state]} />
          <span
            className={cn(
              "text-[13px] font-semibold",
              selected
                ? "text-[#c9d8ff]"
                : idle
                  ? "text-aida-dim"
                  : "text-aida-text-3",
            )}
          >
            {card.name}
          </span>
        </span>
        {cue ? (
          <span className="flex items-center gap-1 text-xs font-medium text-aida-primary-text">
            View decisions <ChevronRight className="size-3" strokeWidth={1.5} />
          </span>
        ) : !idle ? (
          <ChevronRight className="size-3 text-aida-dim" strokeWidth={1.5} />
        ) : null}
      </span>
      <span
        className={cn(
          "text-xl font-bold leading-[31px] md:text-[26px]",
          selected ? "text-white" : idle ? "text-[#3a4560]" : "text-aida-text",
        )}
      >
        {card.value}
      </span>
      <span
        className={cn(
          "text-xs",
          selected
            ? "text-aida-primary-text"
            : idle
              ? "text-aida-dim"
              : "text-aida-muted",
        )}
      >
        {card.sub}
      </span>
      {!idle && card.progress !== null ? (
        <span
          className={cn(
            "h-1 w-full rounded-sm",
            selected ? "bg-aida-primary-soft" : "bg-aida-track",
          )}
        >
          <span
            style={{ width: `${card.progress}%` }}
            className={cn("block h-1 rounded-sm", BAR_TONE[card.state])}
          />
        </span>
      ) : null}
    </button>
  );
}

/* ---------- Banner ---------- */

interface BannerSpec {
  tone: "green" | "red" | "blue" | "amber" | "neutral";
  title: string;
  text: string;
  actions: React.ReactNode;
}

const BANNER_TONE = {
  green: { box: "border-[#1f6b50] bg-[#0b2019]", title: "text-aida-green-dot" },
  red: { box: "border-[#7d3033] bg-[#241012]", title: "text-aida-red" },
  blue: {
    box: "border-aida-primary-line bg-[#0e1730]",
    title: "text-aida-primary-text",
  },
  amber: { box: "border-[#6b5420] bg-[#211a0b]", title: "text-aida-amber" },
  neutral: {
    box: "border-aida-input-line bg-aida-surface-2",
    title: "text-aida-text",
  },
} as const;

function Banner({ spec }: { spec: BannerSpec }) {
  const tone = BANNER_TONE[spec.tone];
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-6 rounded-2xl border px-6 py-[18px]",
        tone.box,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className={cn("text-sm font-semibold", tone.title)}>
          {spec.title}
        </span>
        <span className="text-[13px] text-aida-text-3">{spec.text}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">{spec.actions}</div>
    </div>
  );
}

/* ---------- Funnel ---------- */

const STEP_LABEL: Record<string, string> = {
  received: "Received",
  duplicates: "No duplicates",
  type: "Accepted type, no password",
  keyword: "No confidential keyword",
  other: "Other fixed filters",
};
const STEP_REMOVED: Record<string, (n: number, who: string) => string> = {
  duplicates: (n) => `−${count(n)} duplicates`,
  type: (n) => `−${count(n)} unsupported`,
  keyword: (n) => `−${count(n)} confidential`,
  other: (n) => `−${count(n)} removed`,
  subject: (n, who) => `−${count(n)} do not mention ${who}`,
};

function Funnel({
  insights,
  subjectName,
  client,
  aiSelected,
  onOpen,
}: {
  insights: Insights | null;
  subjectName: string;
  client: boolean;
  aiSelected: boolean;
  onOpen: (step: string) => void;
}) {
  const funnel = insights?.funnel;
  const max = funnel?.total || 1;
  const rows = (funnel?.rows ?? []).filter(
    (row) => !(client && row.key === "subject"),
  );
  return (
    <Card className="flex flex-col gap-3.5 p-4 md:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-[17px] font-semibold text-aida-text">
            From what came in to what will be delivered
          </h2>
          <p className="text-[13px] text-aida-muted">
            Emails and files together. Click a step to see the items that left
            it.
          </p>
        </div>
        {funnel && funnel.total > 0 ? (
          <div className="flex items-center gap-3">
            <span className="text-[40px] font-bold leading-[48px] text-aida-text">
              {funnel.removedPercent}%
            </span>
            <span className="max-w-[160px] text-xs leading-[15px] text-aida-muted">
              removed by fixed filters, before the AI review
            </span>
          </div>
        ) : null}
      </div>
      {!funnel || funnel.total === 0 ? (
        <p className="py-6 text-sm text-aida-muted">
          {insights
            ? "Nothing has been counted yet. The steps appear as the request is read."
            : "Loading…"}
        </p>
      ) : (
        rows.map((row) => {
          const width = Math.max(
            row.value > 0 ? 0.6 : 0,
            (row.value / max) * 100,
          );
          const ai = row.key === "ai";
          const clickable = row.key !== "received";
          const label = ai
            ? "AI verdict"
            : row.key === "subject"
              ? `Mentions ${subjectName || "the subject"}`
              : STEP_LABEL[row.key];
          const who = subjectName ? "them" : "it";
          const split = funnel.ai;
          const total = Math.max(
            1,
            split.kept + split.discarded + split.review + split.waiting,
          );
          return (
            <button
              type="button"
              key={row.key}
              disabled={!clickable}
              onClick={() => onOpen(row.key)}
              className={cn(
                "group grid grid-cols-[110px_minmax(0,1fr)_56px] items-center gap-x-3 gap-y-0.5 text-left md:grid-cols-[190px_minmax(0,1fr)_80px_200px_14px] md:gap-4",
                clickable ? "cursor-pointer" : "cursor-default",
              )}
            >
              <span
                className={cn(
                  "text-[13px]",
                  ai
                    ? "font-semibold text-aida-primary-text"
                    : "font-medium text-aida-text-2",
                )}
              >
                {label}
              </span>
              <span className="relative h-[22px] rounded-[5px] bg-aida-surface-2">
                {ai ? (
                  <span
                    className="absolute inset-y-0 left-0 flex gap-0.5"
                    style={{ width: `${Math.max(width, 6)}%` }}
                  >
                    {(
                      [
                        [split.kept + split.review, "bg-aida-green"],
                        [split.discarded, "bg-[#e2706f]"],
                        [split.waiting, "bg-[#2a3a66]"],
                      ] as const
                    )
                      .filter(([value]) => value > 0)
                      .map(([value, tone]) => (
                        <span
                          key={tone}
                          style={{ flex: value / total }}
                          className={cn("rounded-[5px]", tone)}
                        />
                      ))}
                  </span>
                ) : (
                  <span
                    className="absolute inset-y-0 left-0 rounded-[5px] bg-[#4f7cff] transition group-hover:brightness-125"
                    style={{ width: `${width}%` }}
                  />
                )}
              </span>
              <span
                className={cn(
                  "text-[15px] font-bold",
                  ai && aiSelected ? "text-white" : "text-aida-text",
                )}
              >
                {count(row.value)}
              </span>
              <span
                className={cn(
                  "text-[12.5px]",
                  ai ? "text-aida-primary-text" : "text-aida-muted",
                )}
              >
                {row.key === "received"
                  ? "emails and files"
                  : ai
                    ? `${funnel.ai.keptPercent}% kept`
                    : (STEP_REMOVED[row.key]?.(row.removed, who) ?? "")}
              </span>
              {clickable ? (
                <ChevronRight
                  className={cn(
                    "size-3",
                    ai ? "text-aida-primary-text" : "text-aida-dim",
                  )}
                  strokeWidth={1.5}
                />
              ) : (
                <span />
              )}
            </button>
          );
        })
      )}
    </Card>
  );
}

/* ---------- Activity ---------- */

function Activity({ insights }: { insights: Insights | null }) {
  const events = insights?.activity ?? [];
  if (events.length === 0) return null;
  return (
    <Card className="flex flex-col gap-4 px-6 py-5">
      <h2 className="text-[15px] font-semibold text-aida-text">Activity</h2>
      <div className="flex flex-col gap-3 md:flex-row md:gap-0">
        {events.map((event, index) => {
          const last = index === events.length - 1;
          const next = events[index + 1];
          return (
            <div
              key={`${event.label}-${index}`}
              className="flex min-w-0 flex-1 flex-col gap-1.5"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-2.5 shrink-0 rounded-full",
                    event.state === "active"
                      ? "bg-aida-primary"
                      : "bg-aida-green",
                  )}
                />
                {!last ? (
                  <span
                    className={cn(
                      "h-0.5 flex-1",
                      next?.state === "active"
                        ? "bg-[#4f7cff]"
                        : "bg-aida-green",
                    )}
                  />
                ) : null}
              </div>
              <span className="text-xs text-aida-muted">
                {event.at
                  ? new Date(event.at).toLocaleTimeString("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "now"}
              </span>
              <span
                className={cn(
                  "pr-2 text-[13px] font-semibold",
                  event.state === "active"
                    ? "text-[#c9d8ff]"
                    : "text-aida-text",
                )}
              >
                {event.label}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ---------- Menus ---------- */

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

interface MenuEntry {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

function Menu({
  trigger,
  entries,
  width = 218,
  title,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  entries: MenuEntry[];
  width?: number;
  /** Heading of the bottom sheet on phones. */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={close}
            className="fixed inset-0 z-20 cursor-default bg-[#05080f]/75 sm:hidden"
          />
          <div
            style={{ ["--menu-width" as string]: `${width}px` }}
            className="fixed inset-x-0 bottom-0 z-30 flex flex-col rounded-t-[20px] border border-aida-input-line bg-aida-surface p-5 pb-6 shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-[44px] sm:z-20 sm:w-[var(--menu-width)] sm:rounded-xl sm:p-1.5"
          >
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-aida-line sm:hidden" />
            {title ? (
              <div className="mb-1 text-lg font-bold text-aida-text sm:hidden">
                {title}
              </div>
            ) : null}
            {entries.map((entry) => (
              <div key={entry.label}>
                {entry.separatorBefore ? (
                  <div className="my-1 h-px bg-aida-line" />
                ) : null}
                <button
                  type="button"
                  disabled={entry.disabled}
                  onClick={() => {
                    setOpen(false);
                    entry.onClick();
                  }}
                  className={cn(
                    "w-full rounded-md px-3 py-3 text-left text-[15px] hover:bg-aida-nav-active disabled:pointer-events-none disabled:opacity-40 sm:py-2 sm:text-[13px]",
                    entry.danger ? "text-aida-red" : "text-aida-text-2",
                  )}
                >
                  {entry.label}
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={close}
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

function HeaderButton({
  children,
  onClick,
  "aria-expanded": expanded,
}: {
  children: React.ReactNode;
  onClick: () => void;
  "aria-expanded"?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="flex items-center gap-2 rounded-[10px] border border-aida-input-line bg-aida-sidebar px-3.5 py-[9px] text-sm font-medium text-aida-text-2 hover:bg-aida-nav-active"
    >
      {children}
    </button>
  );
}

/* ---------- Page ---------- */

type PanelKind =
  | { kind: "decisions"; step: string | null }
  | { kind: "stage"; stage: string }
  | null;

export function CasePage({ caseId }: { caseId: string }) {
  const { cases, loading, privacyMode, call, busy } = useCases();
  const router = useRouter();
  const search = useSearchParams();
  const item = cases.find((entry) => entry.id === caseId) ?? null;

  const requestName = search.get("request");
  const request = useMemo(() => {
    if (!item) return null;
    return (
      item.requests.find((entry) => entry.name === requestName) ??
      item.requests.find((entry) => requestStage(entry).tone === "running") ??
      item.requests[0] ??
      null
    );
  }, [item, requestName]);

  const [panel, setPanel] = useState<PanelKind>(null);
  const [stats, setStats] = useState<"case" | "request" | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [configure, setConfigure] = useState<CaseItem | null>(null);
  const [archive, setArchive] = useState<CaseItem | null>(null);
  const [remove, setRemove] = useState<CaseItem | null>(null);
  const [stop, setStop] = useState<CaseItem | null>(null);
  const [newRequest, setNewRequest] = useState<CaseItem | null>(null);
  const [scanFor, setScanFor] = useState<CaseItem | null>(null);
  const [sendFor, setSendFor] = useState<CaseItem | null>(null);
  const [wipeFor, setWipeFor] = useState<CaseItem | null>(null);
  const [uploadFor, setUploadFor] = useState<RequestItem | null>(null);
  const [continueFor, setContinueFor] = useState<RequestItem | null>(null);
  const [resetFor, setResetFor] = useState<RequestItem | null>(null);
  const [deleteFor, setDeleteFor] = useState<RequestItem | null>(null);

  const stage = request ? requestStage(request) : null;
  const live = !!stage && ["running", "waiting"].includes(stage.tone);
  const insights = useInsights(request?.id ?? null, live);

  useEffect(() => {
    if (search.get("view") === "statistics") setStats("case");
  }, [search]);

  const closePanel = useCallback(() => {
    setPanel(null);
    setItemId(null);
  }, []);

  if (loading && !item) {
    return (
      <Page>
        <div className="h-9 w-72 animate-pulse rounded-md bg-aida-surface" />
      </Page>
    );
  }
  if (!item) {
    return (
      <Page>
        <EmptyPanel
          title="Case not found"
          text="It may have been deleted or archived."
        >
          <Btn kind="soft" onClick={() => router.push("/")}>
            Back to cases
          </Btn>
        </EmptyPanel>
      </Page>
    );
  }

  const caseName = privacyMode ? maskCaseName(item.name) : item.name;
  const configured = isConfigured(item);
  const client = item.case_type === "client";
  const working = item.requests.some((entry) =>
    ["queued", "running", "stopping"].includes(entry.status),
  );
  const activeOther = cases.find(
    (other) =>
      other.id !== item.id &&
      other.requests.some((entry) => entry.status === "running"),
  );
  const switchRequest = (name: string) =>
    router.replace(`/cases/${item.id}?request=${encodeURIComponent(name)}`);

  const delivered = {
    emails: request?.phaseProgress?.render?.done ?? 0,
    files: request?.stats?.files.delivered ?? 0,
  };
  const reviewCount = insights?.funnel.forReview ?? 0;
  const workMs = Object.values(request?.phaseTiming ?? {}).reduce(
    (sum, value) => sum + value,
    0,
  );
  const split = insights?.funnel.ai;
  const reviewed = split ? split.kept + split.discarded + split.review : 0;

  let statusLine = "No requests yet";
  let statusDot = "bg-aida-dim";
  if (!configured) {
    statusLine = "Not configured yet";
  } else if (request && stage) {
    statusDot = {
      running: "bg-aida-primary",
      done: "bg-aida-green-dot",
      failed: "bg-aida-red",
      waiting: "bg-aida-amber",
      idle: "bg-aida-dim",
    }[stage.tone];
    if (stage.tone === "done") {
      statusLine = [
        `Completed in ${formatClock(workMs)}`,
        `${count(delivered.emails)} emails${request.scope !== "mail" ? ` and ${count(delivered.files)} files` : ""} delivered`,
        reviewCount ? `${count(reviewCount)} for human review` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    } else if (stage.tone === "running") {
      statusLine = [
        stage.label,
        stage.step === "ai" && split
          ? `${count(reviewed)} of ${count(split.total)} emails analysed`
          : null,
        reviewCount ? `${count(reviewCount)} for human review` : null,
        insights?.reanalysing
          ? `${count(insights.reanalysing)} being reanalysed`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    } else if (stage.tone === "failed") {
      statusLine = `Failed while ${stage.label
        .replace(/ failed$/, "")
        .toLowerCase()
        .replace("pdf build", "building PDFs")}`;
    } else if (stage.tone === "waiting") {
      statusLine = "Queued";
    } else {
      statusLine = "Ready to run";
    }
  }

  /* Banner by state. */
  let banner: BannerSpec | null = null;
  if (!configured) {
    banner = {
      tone: "neutral",
      title: "Add the subject before starting",
      text: "The system needs the employee’s name and email addresses to know what to look for. Nothing runs until the case is configured.",
      actions: (
        <Btn kind="primary" onClick={() => setConfigure(item)}>
          Configure case
        </Btn>
      ),
    };
  } else if (!request) {
    banner = {
      tone: "neutral",
      title: "No requests yet",
      text: "A request is one delivery of PSTs or files. Create one, or scan the input folder to find what was delivered.",
      actions: (
        <>
          <Btn kind="primary" onClick={() => setNewRequest(item)}>
            New request
          </Btn>
          <Btn kind="secondary" onClick={() => setScanFor(item)}>
            Scan input folder
          </Btn>
        </>
      ),
    };
  } else if (stage?.tone === "failed") {
    const failedPdfs = request.phaseProgress?.render
      ? Math.max(
          0,
          request.phaseProgress.render.total -
            request.phaseProgress.render.done,
        )
      : 0;
    banner = {
      tone: "red",
      title: `${stage.label.replace("PDF build failed", "Building PDFs failed")}`,
      text:
        stage.step === "render" && failedPdfs > 0
          ? `${count(failedPdfs)} emails could not be converted. The rest of the PDFs are kept, so retrying only redoes what failed.`
          : "Retrying redoes only what failed. Output already delivered is kept.",
      actions: (
        <>
          <Btn
            kind="secondary"
            onClick={() =>
              setPanel({ kind: "stage", stage: stage.step ?? "parse" })
            }
          >
            View details
          </Btn>
          <Btn
            kind="primary"
            disabled={busy === `retry-${request.id}`}
            onClick={() => void retryFailed(request)}
          >
            Retry
          </Btn>
        </>
      ),
    };
  } else if (stage?.tone === "waiting") {
    banner = {
      tone: "amber",
      title: "Waiting for the active case",
      text: `${activeOther ? activeOther.name : "Another case"} is running. Only one case works at a time to keep AI costs and memory predictable; this one starts automatically when it finishes.`,
      actions: activeOther ? (
        <Btn
          kind="secondary"
          onClick={() => router.push(`/cases/${activeOther.id}`)}
        >
          View active case
        </Btn>
      ) : null,
    };
  } else if (stage?.tone === "done") {
    banner = client
      ? {
          tone: "green",
          title: "Delivered",
          text: `Emails and files are ready.${reviewCount ? ` ${count(reviewCount)} items are waiting in the human review folder; they are not uploaded for client cases.` : ""}`,
          actions: (
            <>
              <Btn
                kind="secondary"
                onClick={() => setPanel({ kind: "decisions", step: "review" })}
              >
                View human review
              </Btn>
              <Btn
                kind="primary"
                disabled={
                  busy === `onetrust-${item.id}` || item.requests.length !== 1
                }
                onClick={() => setSendFor(item)}
              >
                {item.onetrust_status === "completed"
                  ? "Sync OneTrust"
                  : "Send to OneTrust"}
              </Btn>
            </>
          ),
        }
      : {
          tone: "green",
          title: "Delivered and uploaded",
          text: "The human review folder was uploaded to SharePoint. OneTrust is up to date.",
          actions: (
            <Btn kind="primary" onClick={() => setContinueFor(request)}>
              Continue with a new wave
            </Btn>
          ),
        };
  } else if (stage?.tone === "idle" && configured) {
    banner = {
      tone: "neutral",
      title: "Ready to run",
      text: "Put the PSTs and files in the input folder, then start the request.",
      actions: (
        <Btn
          kind="primary"
          disabled={
            busy === request.id || !["ready", "failed"].includes(request.status)
          }
          onClick={() =>
            void call(request.id, `/api/requests/${request.id}/run`, {
              method: "POST",
            })
          }
        >
          Run request
        </Btn>
      ),
    };
  }

  async function retryFailed(target: RequestItem) {
    const key = `retry-${target.id}`;
    for (const fileId of target.retryTargets ?? []) {
      const response = await fetch("/api/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        toast.error(body.error || "Retry failed.");
        return;
      }
    }
    toast.success(`Retry started for ${target.name}.`);
    await call(key, "/api/cases?status=active");
  }

  const actionEntries: MenuEntry[] = [
    {
      label: "Statistics",
      onClick: () => setStats("case"),
    },
    ...(reviewCount
      ? [
          {
            label: `Human review (${count(reviewCount)})`,
            onClick: () => setPanel({ kind: "decisions", step: "review" }),
          } as MenuEntry,
        ]
      : []),
    { label: "Configure case", onClick: () => setConfigure(item) },
    ...(request && !client && stage?.tone === "done"
      ? [
          {
            label: "Upload to SharePoint",
            onClick: () => setUploadFor(request),
          } as MenuEntry,
        ]
      : []),
    ...(request && stage?.tone === "done"
      ? [
          {
            label: "Continue new wave",
            onClick: () => setContinueFor(request),
          } as MenuEntry,
        ]
      : []),
    ...(client && request && stage?.tone === "done"
      ? [
          {
            label:
              item.onetrust_status === "completed"
                ? "Sync with OneTrust"
                : "Send to OneTrust",
            onClick: () => setSendFor(item),
          } as MenuEntry,
        ]
      : []),
    ...(working
      ? [
          {
            label: "Stop all work",
            onClick: () => setStop(item),
            separatorBefore: true,
            danger: true,
          } as MenuEntry,
        ]
      : []),
    ...(request && !working
      ? [
          {
            label: "Reset",
            onClick: () => setResetFor(request),
            separatorBefore: !working,
          } as MenuEntry,
        ]
      : []),
    ...(item.requests.length > 0 && !working
      ? [
          {
            label: "Wipe data",
            onClick: () => setWipeFor(item),
          } as MenuEntry,
        ]
      : []),
    {
      label: "Archive",
      onClick: () => setArchive(item),
      disabled: !(
        item.requests.length > 0 &&
        item.requests.every((entry) => requestStage(entry).tone === "done")
      ),
      separatorBefore: !request || working,
    },
    { label: "Delete", onClick: () => setRemove(item), danger: true },
  ];

  const stages = request ? buildStages(request, insights, client) : [];
  const panelStep = panel?.kind === "decisions" ? panel.step : null;
  const decisionsOpen = panel?.kind === "decisions";

  return (
    <Page className="pb-12">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-[13px] leading-4 text-aida-muted">
            <Link href="/" className="hover:text-aida-text-2">
              Cases
            </Link>
            {"  /  "}
            {caseName}
            {request ? `  /  ${request.name}` : ""}
          </div>
          <div className="flex items-center gap-3">
            <h1 className="truncate text-2xl font-bold leading-[34px] text-aida-text md:text-[28px]">
              {caseName}
              {request ? ` · ${request.name}` : ""}
            </h1>
            <span className="rounded-md bg-[#1a2233] px-2 py-[3px] text-[11px] font-medium capitalize text-aida-muted">
              {item.case_type}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm leading-[17px] text-aida-text-3">
            <Dot className={statusDot} />
            {statusLine}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2.5">
          {item.requests.length > 0 ? (
            <Menu
              title="Request"
              width={150}
              entries={[
                ...item.requests.map((entry) => ({
                  label: `${entry.name}${request?.id === entry.id ? " ✓" : ""}`,
                  onClick: () => switchRequest(entry.name),
                })),
                ...(request
                  ? [
                      {
                        label: "Statistics request",
                        onClick: () => setStats("request"),
                        separatorBefore: true,
                      },
                      {
                        label: "Reset request",
                        onClick: () => setResetFor(request),
                        disabled: working,
                      },
                      {
                        label: "Delete request",
                        danger: true,
                        onClick: () => setDeleteFor(request),
                        disabled: !(
                          request.status === "ready" &&
                          request.deliverable_files === 0
                        ),
                      },
                    ]
                  : []),
              ]}
              trigger={({ open, toggle }) => (
                <HeaderButton onClick={toggle} aria-expanded={open}>
                  <span className="font-semibold text-aida-text">
                    {request?.name ?? "—"}
                  </span>
                  <ChevronDown
                    className="size-3 text-aida-muted"
                    strokeWidth={1.5}
                  />
                </HeaderButton>
              )}
            />
          ) : null}
          <HeaderButton onClick={() => setNewRequest(item)}>
            <Plus className="size-3.5 text-aida-text-3" strokeWidth={1.8} /> New
            request
          </HeaderButton>
          <Menu
            title="Actions"
            entries={actionEntries}
            trigger={({ open, toggle }) => (
              <HeaderButton onClick={toggle} aria-expanded={open}>
                Actions{" "}
                <ChevronDown
                  className="size-3 text-aida-muted"
                  strokeWidth={1.5}
                />
              </HeaderButton>
            )}
          />
        </div>
      </header>

      {banner ? <Banner spec={banner} /> : null}

      <div className="flex flex-col gap-2 md:flex-row md:gap-3">
        {(stages.length ? stages : placeholderStages()).map((card) => (
          <Stage
            key={card.key}
            card={card}
            selected={card.key === "ai" && decisionsOpen && panelStep === "ai"}
            onClick={
              request
                ? () =>
                    card.key === "ai"
                      ? setPanel({ kind: "decisions", step: "ai" })
                      : setPanel({ kind: "stage", stage: card.key })
                : undefined
            }
          />
        ))}
      </div>

      {request && configured && stage?.tone !== "idle" ? (
        <>
          <Funnel
            insights={insights}
            subjectName={item.subject_name}
            client={client}
            aiSelected={decisionsOpen && panelStep === "ai"}
            onOpen={(step) => setPanel({ kind: "decisions", step })}
          />
          <Activity insights={insights} />
        </>
      ) : null}

      <Drawer
        crumb={`${caseName} · ${request?.name ?? ""}`}
        open={!!panel}
        onClose={closePanel}
        width={decisionsOpen ? 740 : 560}
      >
        {request && panel?.kind === "decisions" ? (
          itemId ? (
            <ItemPanel
              itemId={itemId}
              backLabel={
                panel.step === "review" ? "Human review" : "AI decisions"
              }
              onBack={() => setItemId(null)}
              onClose={closePanel}
            />
          ) : (
            <DecisionsPanel
              requestId={request.id}
              title={`${caseName} · ${request.name}`}
              step={panel.step === "review" ? null : panel.step}
              review={panel.step === "review"}
              onClose={closePanel}
              onOpenItem={setItemId}
            />
          )
        ) : null}
        {request && panel?.kind === "stage" ? (
          <StageDrawer
            stage={panel.stage}
            request={request}
            insights={insights}
            onClose={closePanel}
          />
        ) : null}
      </Drawer>

      <UploadSharePointModal
        target={uploadFor}
        onClose={() => setUploadFor(null)}
      />
      <StatisticsModal
        mode={stats}
        item={item}
        request={request}
        insights={insights}
        onClose={() => setStats(null)}
      />
      <ConfigureCaseModal
        target={configure}
        onClose={() => setConfigure(null)}
      />
      <ArchiveCaseModal target={archive} onClose={() => setArchive(null)} />
      <DeleteCaseModal
        target={remove}
        onClose={() => {
          setRemove(null);
        }}
      />
      <ScanInputModal
        open={!!scanFor}
        caseTarget={scanFor}
        onClose={() => setScanFor(null)}
        onDone={(id) => id === item.id && router.replace(`/cases/${id}`)}
      />
      <SendOneTrustModal
        target={
          sendFor
            ? (cases.find((entry) => entry.id === sendFor.id) ?? sendFor)
            : null
        }
        onClose={() => setSendFor(null)}
        onFix={(entry) => setConfigure(entry)}
      />
      <WipeCaseModal target={wipeFor} onClose={() => setWipeFor(null)} />
      <StopWorkModal target={stop} onClose={() => setStop(null)} />
      <NewRequestModal
        target={newRequest}
        onClose={() => setNewRequest(null)}
        onCreated={switchRequest}
      />
      <ContinueWaveModal
        target={continueFor}
        onClose={() => setContinueFor(null)}
      />
      <ResetRequestModal target={resetFor} onClose={() => setResetFor(null)} />
      <DeleteRequestModal
        target={deleteFor}
        onClose={() => setDeleteFor(null)}
        onDeleted={() => router.replace(`/cases/${item.id}`)}
      />
    </Page>
  );
}

function placeholderStages(): StageCard[] {
  return [
    ["parse", "Read"],
    ["extract", "Prepare"],
    ["ai", "AI"],
    ["render", "PDFs"],
    ["files", "Files"],
  ].map(([key, name]) => ({
    key: key as StageCard["key"],
    name,
    state: "idle" as const,
    value: "—",
    sub: "not started",
    progress: null,
  }));
}

/* ---------- Stage drawers ---------- */

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-[13px]">
      <span className="text-aida-muted">{label}</span>
      <span className="font-medium text-aida-text">{value}</span>
    </div>
  );
}

function StageDrawer({
  stage,
  request,
  insights,
  onClose,
}: {
  stage: string;
  request: RequestItem;
  insights: Insights | null;
  onClose: () => void;
}) {
  const timing = request.phaseTiming;
  const mail = request.stats?.mail;
  const files = request.stats?.files;
  const box =
    "mx-6 overflow-hidden rounded-xl border border-aida-card-line bg-aida-surface divide-y divide-aida-line";
  if (stage === "parse") {
    const pst = insights?.pst ?? [];
    return (
      <div className="flex flex-col gap-4 pb-8">
        <DrawerHeader
          title="Read"
          subtitle={`${pst.length} PSTs opened and every email listed.`}
          onClose={onClose}
        />
        <div className="mx-6 overflow-hidden rounded-xl border border-aida-card-line bg-aida-surface">
          <div className="grid grid-cols-[1fr_80px_80px_70px] gap-3 px-4 py-3 text-[11px] uppercase tracking-wide text-aida-dim">
            <span>PST</span>
            <span>Emails</span>
            <span>Size</span>
            <span>Status</span>
          </div>
          {pst.map((file) => (
            <div
              key={file.id}
              className="grid grid-cols-[1fr_80px_80px_70px] items-center gap-3 px-4 py-3 text-[13px] text-aida-text-2"
            >
              <span className="truncate">{file.name}</span>
              <span>{count(file.emails)}</span>
              <span>{formatBytes(file.sizeBytes)}</span>
              <span
                className={cn(
                  "w-fit rounded-md px-2 py-0.5 text-[11px] font-medium",
                  ["completed", "analyzed", "extracting"].includes(file.status)
                    ? "bg-[#0f2a22] text-[#8de3c3]"
                    : "bg-aida-nav-active text-aida-text-3",
                )}
              >
                {["completed", "analyzed", "extracting"].includes(file.status)
                  ? "Read"
                  : "Waiting"}
              </span>
            </div>
          ))}
        </div>
        <div className={box}>
          <Row label="Emails read" value={count(mail?.scanned ?? 0)} />
          <Row
            label="Attachments found"
            value={count(pst.reduce((sum, file) => sum + file.attachments, 0))}
          />
          <Row label="Time" value={formatClock(timing?.parse ?? 0)} />
        </div>
      </div>
    );
  }
  const text: Record<
    string,
    { title: string; subtitle: string; rows: Array<[string, React.ReactNode]> }
  > = {
    extract: {
      title: "Prepare",
      subtitle: "Unique emails extracted and checked by the fixed rules.",
      rows: [
        ["Unique emails", count(mail?.unique ?? 0)],
        ["Duplicates removed", count(mail?.duplicates ?? 0)],
        ["Time", formatClock(timing?.extract ?? 0)],
      ],
    },
    render: {
      title: "PDFs",
      subtitle: "Every kept email is built as a PDF for delivery.",
      rows: [
        ["Built", count(request.phaseProgress?.render?.done ?? 0)],
        ["Expected", count(request.phaseProgress?.render?.total ?? 0)],
        ["Time", formatClock(timing?.render ?? 0)],
      ],
    },
    files: {
      title: "Files",
      subtitle: "Loose files and Teams chats, processed after the PDFs.",
      rows: [
        ["Found", count(files?.found ?? 0)],
        ["Delivered", count(files?.delivered ?? 0)],
        ["Skipped", count(files?.skipped ?? 0)],
        ["Time", formatClock(timing?.files ?? 0)],
      ],
    },
  };
  const entry = text[stage] ?? text.extract;
  return (
    <div className="flex flex-col gap-4 pb-8">
      <DrawerHeader
        title={entry.title}
        subtitle={entry.subtitle}
        onClose={onClose}
      />
      <div className={box}>
        {entry.rows.map(([label, value]) => (
          <Row key={label} label={label} value={value} />
        ))}
      </div>
    </div>
  );
}
