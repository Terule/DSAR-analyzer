/**
 * What the case screen shows for one request, read from the audit trail
 * (`items`): the funnel from what came in to what is delivered, the AI verdict
 * split, and the items behind each step. Pure functions here; the routes in
 * `app/api/requests/[requestId]/` do the queries.
 */

export type FunnelStepKey =
  | "received"
  | "duplicates"
  | "type"
  | "keyword"
  | "other"
  | "subject"
  | "ai";

/** Rules that remove an item before the AI looks at it, by funnel step. */
export const FUNNEL_RULES: Record<
  Exclude<FunnelStepKey, "received" | "ai">,
  string[]
> = {
  duplicates: ["dup"],
  type: [
    "unsupported_type",
    "password",
    "zip_error",
    "empty_output",
    "unreadable_image",
  ],
  keyword: ["keyword"],
  other: ["draft", "self_forward", "signature_image", "files_filter"],
  subject: ["subject_absent"],
};

/** Rules of the items the AI (or the attachment screening) decided. */
export const AI_RULES = ["ai_email", "ai_file", "mail_screen"];

export interface RuleGroup {
  state: string;
  rule: string | null;
  count: number;
}

export interface FunnelRow {
  key: FunnelStepKey;
  value: number;
  /** Items this step removed; zero for the first and the AI rows. */
  removed: number;
}

export interface AiSplit {
  kept: number;
  discarded: number;
  review: number;
  waiting: number;
}

export interface Funnel {
  rows: FunnelRow[];
  /** Items sent to a person, across every step. */
  forReview: number;
  total: number;
  /** Share removed by fixed filters before the AI, 0-100. */
  removedPercent: number;
  ai: AiSplit & { total: number; keptPercent: number };
}

function sum(groups: RuleGroup[], match: (group: RuleGroup) => boolean) {
  return groups.reduce(
    (total, group) => total + (match(group) ? group.count : 0),
    0,
  );
}

export function buildFunnel(groups: RuleGroup[]): Funnel {
  const total = sum(groups, () => true);
  const removedBy = (key: keyof typeof FUNNEL_RULES) =>
    sum(
      groups,
      (group) =>
        group.state === "discarded" &&
        group.rule !== null &&
        FUNNEL_RULES[key].includes(group.rule),
    );
  const duplicates = removedBy("duplicates");
  const type = removedBy("type");
  const keyword = removedBy("keyword");
  const other = removedBy("other");
  const subject = removedBy("subject");
  const afterDuplicates = total - duplicates;
  const afterType = afterDuplicates - type;
  const afterKeyword = afterType - keyword;
  const afterOther = afterKeyword - other;
  const afterSubject = afterOther - subject;
  const aiGroups = groups.filter(
    (group) => group.rule !== null && AI_RULES.includes(group.rule),
  );
  const kept = sum(aiGroups, (group) => group.state === "kept");
  const discarded = sum(aiGroups, (group) => group.state === "discarded");
  const review = sum(aiGroups, (group) => group.state === "review");
  // Items that passed every fixed filter and have no AI verdict yet, plus the
  // ones whose discard waits for the 2nd analysis.
  const waiting = Math.max(0, afterSubject - kept - discarded - review);
  const reachedAi = afterSubject;
  const rows: FunnelRow[] = [
    { key: "received", value: total, removed: 0 },
    { key: "duplicates", value: afterDuplicates, removed: duplicates },
    { key: "type", value: afterType, removed: type },
    { key: "keyword", value: afterKeyword, removed: keyword },
  ];
  if (other > 0) rows.push({ key: "other", value: afterOther, removed: other });
  rows.push({ key: "subject", value: afterSubject, removed: subject });
  rows.push({ key: "ai", value: reachedAi, removed: 0 });
  return {
    rows,
    forReview: sum(groups, (group) => group.state === "review"),
    total,
    removedPercent:
      total > 0
        ? Math.round(
            ((duplicates + type + keyword + other + subject) / total) * 100,
          )
        : 0,
    ai: {
      total: reachedAi,
      kept,
      discarded,
      review,
      waiting,
      keptPercent:
        reachedAi > 0 ? Math.round(((kept + review) / reachedAi) * 100) : 0,
    },
  };
}

/** The rules behind a funnel step, for the list that opens when it is clicked. */
export function rulesForStep(step: string): string[] | null {
  if (step === "ai") return AI_RULES;
  return step in FUNNEL_RULES
    ? FUNNEL_RULES[step as keyof typeof FUNNEL_RULES]
    : null;
}

export type ItemTab = "emails" | "attachments" | "files";

/** Where each tab of the decisions panel reads from. */
export function tabFilter(tab: ItemTab): {
  origin: string | string[];
  kind?: string | { not: string };
} {
  if (tab === "emails") return { origin: "pst", kind: "email" };
  if (tab === "attachments") return { origin: "attachment" };
  return { origin: "files_folder", kind: { not: "chat_message" } };
}

/** Which AI generation decided an item, for the "1st / 2nd analysis" column. */
export function analysisLabel(
  decidedBy: string | null,
  rule: string | null,
  state: string,
  rereview: boolean,
): string {
  if (state === "pending" && rereview) return "2nd analysis";
  if (
    !decidedBy ||
    decidedBy === "rule" ||
    (rule && !AI_RULES.includes(rule))
  ) {
    return "Rule";
  }
  if (/5[.-]5/.test(decidedBy)) return "2nd analysis";
  return "1st analysis";
}

export interface ActivityEvent {
  label: string;
  /** Epoch milliseconds, or null when the time is not known. */
  at: number | null;
  state: "done" | "active";
}

/** The request timeline, with each time worked out from the phase durations. */
export function buildActivity(input: {
  startedAt: number | null;
  readMs: number;
  prepareMs: number;
  aiMs: number;
  renderMs: number;
  filesMs: number;
  done: {
    read: boolean;
    prepare: boolean;
    ai: boolean;
    render: boolean;
    files: boolean;
  };
  aiStarted: boolean;
  reanalysing: boolean;
  completedAt: number | null;
  hasFiles: boolean;
}): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  let clock = input.startedAt;
  const advance = (ms: number) => {
    clock = clock === null ? null : clock + ms;
    return clock;
  };
  events.push({ label: "Case started", at: clock, state: "done" });
  if (input.done.read) {
    events.push({
      label: "Read completed",
      at: advance(input.readMs),
      state: "done",
    });
  }
  if (input.done.prepare) {
    events.push({
      label: "Prepare completed",
      at: advance(input.prepareMs),
      state: "done",
    });
  }
  if (input.aiStarted) {
    events.push({
      label: "AI review started (1st analysis)",
      at: clock,
      // Active only while it is the latest thing that happened.
      state: input.done.ai || input.reanalysing ? "done" : "active",
    });
  }
  if (input.reanalysing) {
    events.push({
      label: "Reanalysis of doubtful discards",
      at: null,
      state: "active",
    });
  }
  if (input.done.ai) {
    events.push({
      label: "AI review completed",
      at: advance(input.aiMs),
      state: "done",
    });
  }
  if (input.done.render) {
    events.push({
      label: "PDFs built",
      at: advance(input.renderMs),
      state: "done",
    });
  }
  if (input.hasFiles && input.done.files) {
    events.push({
      label: "Files processed",
      at: advance(input.filesMs),
      state: "done",
    });
  }
  if (input.completedAt) {
    events.push({
      label: "Request completed",
      at: input.completedAt,
      state: "done",
    });
  }
  return events;
}

/* ---------- Outcomes: where every item went ---------- */

export type OutcomeKey =
  | "type"
  | "keyword"
  | "other"
  | "subject"
  | "ai_discarded"
  | "review"
  | "kept"
  | "waiting";

export interface OutcomeSegment {
  key: OutcomeKey;
  count: number;
  /** Funnel step to open in the decisions panel, when there is a list behind it. */
  step: string | null;
}

export interface OutcomeBar {
  kind: "emails" | "files";
  received: number;
  duplicates: number;
  /** received minus duplicates: the items that were actually judged. */
  unique: number;
  /** In pipeline order; only segments with items. They add up to `unique`. */
  segments: OutcomeSegment[];
}

const ORDER: OutcomeKey[] = [
  "type",
  "keyword",
  "other",
  "subject",
  "ai_discarded",
  "review",
  "kept",
  "waiting",
];

const STEP_OF: Record<OutcomeKey, string | null> = {
  type: "type",
  keyword: "keyword",
  other: "other",
  subject: "subject",
  ai_discarded: "ai",
  review: "ai",
  kept: "ai",
  waiting: null,
};

function outcomeOf(group: RuleGroup): OutcomeKey | "duplicate" {
  if (group.state === "kept") return "kept";
  if (group.state === "review") return "review";
  if (group.state === "pending") return "waiting";
  const rule = group.rule;
  if (rule !== null && FUNNEL_RULES.duplicates.includes(rule))
    return "duplicate";
  if (rule !== null && FUNNEL_RULES.type.includes(rule)) return "type";
  if (rule !== null && FUNNEL_RULES.keyword.includes(rule)) return "keyword";
  if (rule !== null && FUNNEL_RULES.subject.includes(rule)) return "subject";
  if (rule !== null && AI_RULES.includes(rule)) return "ai_discarded";
  // Every other fixed rule (draft, signature image, ...) and any rule not
  // listed: removed before a person or the AI looked at it.
  return "other";
}

/**
 * One bar per kind of item (emails, files), each over the items that were
 * actually judged: duplicates are counted apart because they are repetition,
 * not a decision, and at 60%+ of a request they would flatten every other step.
 * Every segment is a share of `unique`, so the bar and its legend always agree.
 */
export function buildOutcomes(
  groups: Array<RuleGroup & { kind: "emails" | "files" }>,
): OutcomeBar[] {
  const bars: OutcomeBar[] = [];
  for (const kind of ["emails", "files"] as const) {
    const mine = groups.filter((group) => group.kind === kind);
    const received = mine.reduce((sum, group) => sum + group.count, 0);
    if (received === 0) continue;
    const counts = new Map<OutcomeKey, number>();
    let duplicates = 0;
    for (const group of mine) {
      const outcome = outcomeOf(group);
      if (outcome === "duplicate") duplicates += group.count;
      else counts.set(outcome, (counts.get(outcome) ?? 0) + group.count);
    }
    bars.push({
      kind,
      received,
      duplicates,
      unique: received - duplicates,
      segments: ORDER.filter((key) => (counts.get(key) ?? 0) > 0).map(
        (key) => ({
          key,
          count: counts.get(key) ?? 0,
          step: STEP_OF[key],
        }),
      ),
    });
  }
  return bars;
}
