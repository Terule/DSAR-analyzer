"use client";

import { ChevronRight } from "lucide-react";
import type {
  OutcomeBar,
  OutcomeKey,
  OutcomeSegment,
} from "@/lib/request-insights";
import { cn } from "@/lib/utils";
import { count } from "./case-view";
import { DrawerHeader } from "./Drawer";
import { Card } from "./ui";
import type { Insights } from "./use-insights";

/**
 * Four colours: the fixed rules that removed an item (red), the AI that
 * discarded it (dark red), a person who must look (amber) and what was kept
 * (green). Grey is only for what still waits for the AI.
 */
type Group = "rules" | "ai" | "review" | "kept" | "waiting";

const GROUP_OF: Record<OutcomeKey, Group> = {
  type: "rules",
  keyword: "rules",
  other: "rules",
  subject: "rules",
  ai_discarded: "ai",
  review: "review",
  kept: "kept",
  waiting: "waiting",
};

const GROUP_ORDER: Group[] = ["rules", "ai", "review", "kept", "waiting"];

const TONE: Record<Group, string> = {
  rules: "bg-[#e0605f]",
  ai: "bg-[#a53b3a]",
  review: "bg-aida-amber",
  kept: "bg-aida-green",
  waiting: "bg-[#2a3a66]",
};

const GROUP_LABEL: Record<Group, string> = {
  rules: "Removed by fixed rules",
  ai: "Discarded by the AI",
  review: "For human review",
  kept: "Kept",
  waiting: "Waiting for the AI",
};

function reason(key: OutcomeKey, subject: string): string {
  switch (key) {
    case "type":
      return "Unsupported or protected";
    case "keyword":
      return "Confidential keyword";
    case "other":
      return "Other fixed filters";
    case "subject":
      return `Does not mention ${subject || "the subject"}`;
    default:
      return GROUP_LABEL[GROUP_OF[key]];
  }
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const value = (part / whole) * 100;
  return value > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
}

export interface OpenOutcome {
  step: string;
  tab: "emails" | "files";
  state?: string;
}

interface GroupTotal {
  group: Group;
  count: number;
  parts: OutcomeSegment[];
}

function groupsOf(bar: OutcomeBar): GroupTotal[] {
  return GROUP_ORDER.flatMap((group) => {
    const parts = bar.segments.filter(
      (segment) => GROUP_OF[segment.key] === group,
    );
    const total = parts.reduce((sum, part) => sum + part.count, 0);
    return total > 0 ? [{ group, count: total, parts }] : [];
  });
}

function targetOf(
  bar: OutcomeBar,
  segment: OutcomeSegment,
): OpenOutcome | null {
  if (!segment.step) return null;
  return {
    step: segment.step,
    tab: bar.kind,
    state:
      segment.key === "kept"
        ? "kept"
        : segment.key === "ai_discarded"
          ? "discarded"
          : undefined,
  };
}

function Summary({ bar }: { bar: OutcomeBar }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 className="text-[15px] font-semibold text-aida-text">
        {bar.kind === "emails" ? "Emails" : "Files"}
      </h3>
      <p className="text-[13px] text-aida-muted">
        {count(bar.received)} received ·{" "}
        <span className="text-aida-text-2">
          {count(bar.duplicates)} duplicates
        </span>{" "}
        ·{" "}
        <span className="font-semibold text-aida-text">
          {count(bar.unique)}
        </span>{" "}
        unique
      </p>
    </div>
  );
}

function StackedBar({
  bar,
  groups,
}: {
  bar: OutcomeBar;
  groups: GroupTotal[];
}) {
  return (
    <div
      className="flex h-[18px] w-full gap-0.5 overflow-hidden rounded-md"
      role="img"
      aria-label={groups
        .map((entry) => `${count(entry.count)} ${GROUP_LABEL[entry.group]}`)
        .join(", ")}
    >
      {groups.map((entry) => (
        <span
          key={entry.group}
          title={`${GROUP_LABEL[entry.group]}: ${count(entry.count)} (${percent(entry.count, bar.unique)})`}
          style={{ flexGrow: entry.count, flexBasis: 0, minWidth: 4 }}
          className={cn("h-full", TONE[entry.group])}
        />
      ))}
    </div>
  );
}

/** Reason by reason, each opening its list. Used under the rules card and as the list layout. */
function ReasonRows({
  bar,
  parts,
  subject,
  onOpen,
}: {
  bar: OutcomeBar;
  parts: OutcomeSegment[];
  subject: string;
  onOpen: (target: OpenOutcome) => void;
}) {
  return (
    <ul className="flex flex-col">
      {parts.map((segment) => {
        const target = targetOf(bar, segment);
        return (
          <li key={segment.key}>
            <button
              type="button"
              disabled={!target}
              onClick={() => target && onOpen(target)}
              className="grid w-full grid-cols-[14px_minmax(0,1fr)_64px_40px_14px] items-center gap-3 rounded-md px-1 py-1.5 text-left enabled:hover:bg-aida-nav-active/40 disabled:cursor-default"
            >
              <span
                className={cn(
                  "size-2.5 rounded-sm",
                  TONE[GROUP_OF[segment.key]],
                )}
              />
              <span className="truncate text-[13px] text-aida-text-2">
                {reason(segment.key, subject)}
              </span>
              <span className="text-right text-[13px] font-semibold text-aida-text">
                {count(segment.count)}
              </span>
              <span className="text-right text-xs text-aida-muted">
                {percent(segment.count, bar.unique)}
              </span>
              {target ? (
                <ChevronRight
                  className="size-3 text-aida-dim"
                  strokeWidth={1.5}
                />
              ) : (
                <span />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function OutcomeCards({
  bar,
  groups,
  onOpen,
  onOpenRules,
}: {
  bar: OutcomeBar;
  groups: GroupTotal[];
  onOpen: (target: OpenOutcome) => void;
  onOpenRules: () => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {groups.map((entry) => {
        const single = entry.parts.length === 1 ? entry.parts[0] : null;
        const target = single ? targetOf(bar, single) : null;
        const isRules = entry.group === "rules";
        const clickable = isRules || !!target;
        return (
          <button
            type="button"
            key={entry.group}
            disabled={!clickable}
            onClick={() => (isRules ? onOpenRules() : target && onOpen(target))}
            className="relative flex flex-col gap-1 overflow-hidden rounded-xl border border-aida-card-line bg-aida-surface-2 px-4 py-3 text-left enabled:hover:border-aida-primary-line/70 disabled:cursor-default"
          >
            <span
              className={cn("absolute inset-x-0 top-0 h-1", TONE[entry.group])}
            />
            <span className="mt-1 text-[24px] font-bold leading-7 text-aida-text">
              {count(entry.count)}
            </span>
            <span className="text-[12.5px] text-aida-text-2">
              {GROUP_LABEL[entry.group]}
            </span>
            <span className="flex items-center justify-between text-xs text-aida-muted">
              {percent(entry.count, bar.unique)} of the unique
              {clickable ? (
                <ChevronRight className="size-3" strokeWidth={1.5} />
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Panel({
  bar,
  onOpen,
  onOpenRules,
}: {
  bar: OutcomeBar;
  onOpen: (target: OpenOutcome) => void;
  onOpenRules: () => void;
}) {
  const groups = groupsOf(bar);
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <Summary bar={bar} />
      {bar.unique === 0 ? (
        <p className="text-[13px] text-aida-muted">
          Every item was a duplicate, so nothing was judged.
        </p>
      ) : (
        <>
          <StackedBar bar={bar} groups={groups} />
          <OutcomeCards
            bar={bar}
            groups={groups}
            onOpen={onOpen}
            onOpenRules={onOpenRules}
          />
        </>
      )}
    </section>
  );
}

/**
 * The first layer behind the "Removed by fixed rules" card, shown in the side
 * panel: one row per reason. A reason opens the items behind it in the same
 * panel, with an arrow back to this list.
 */
export function RulesPanel({
  bar,
  subjectName,
  title,
  onPick,
  onClose,
}: {
  bar: OutcomeBar;
  subjectName: string;
  /** "Case · request", for the subtitle. */
  title: string;
  onPick: (target: OpenOutcome) => void;
  onClose: () => void;
}) {
  const rules = groupsOf(bar).find((entry) => entry.group === "rules");
  return (
    <div className="flex min-h-full flex-col gap-4 pb-8">
      <DrawerHeader
        title="Removed by fixed rules"
        subtitle={`${title} · ${bar.kind === "emails" ? "Emails" : "Files"} · ${count(rules?.count ?? 0)} of ${count(bar.unique)} unique items`}
        onClose={onClose}
      />
      <div className="mx-6 rounded-xl border border-aida-card-line bg-aida-surface px-3 py-2">
        <ReasonRows
          bar={bar}
          parts={rules?.parts ?? []}
          subject={subjectName}
          onOpen={onPick}
        />
      </div>
      <p className="mx-6 text-xs text-aida-dim">
        Pick a reason to see the items it removed.
      </p>
    </div>
  );
}

/**
 * Where every item of a request went: one bar per kind of item over the items
 * that were actually judged, with duplicates counted apart. The fixed-rules
 * card opens the reasons in the side panel; a reason opens the items.
 */
export function Outcomes({
  insights,
  onOpen,
  onOpenRules,
}: {
  insights: Insights | null;
  onOpen: (target: OpenOutcome) => void;
  onOpenRules: (kind: OutcomeBar["kind"]) => void;
}) {
  const bars = insights?.outcomes ?? [];
  return (
    <Card className="flex flex-col gap-5 p-4 md:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold text-aida-text">
          Where everything went
        </h2>
        <p className="text-[13px] text-aida-muted">
          Each bar is the items that were judged, once duplicates are set aside.
          Click a card to see what is behind it.
        </p>
      </div>
      {bars.length === 0 ? (
        <p className="py-4 text-sm text-aida-muted">
          {insights
            ? "Nothing has been counted yet. The parts appear as the request is read."
            : "Loading…"}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-8 xl:grid-cols-2 xl:gap-10">
          {bars.map((bar) => (
            <Panel
              key={bar.kind}
              bar={bar}
              onOpen={onOpen}
              onOpenRules={() => onOpenRules(bar.kind)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
