"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { DrawerHeader, Pill } from "./Drawer";

interface ItemEvent {
  id: string;
  state: string;
  rule: string | null;
  reason: string | null;
  decidedBy: string | null;
  time: string;
}
interface ItemDetail {
  id: string;
  label: string;
  kind: string;
  origin: string;
  state: "kept" | "discarded" | "review" | "pending" | "reanalysing";
  rule: string | null;
  reason: string | null;
  decidedBy: string | null;
  analysis: string;
  confidenceKeep: number | null;
  sentDate: string | null;
  parent: { id: string; label: string } | null;
  events: ItemEvent[];
}

const RULE_TITLES: Record<string, string> = {
  dup: "Duplicate",
  keyword: "Confidential keyword",
  subject_absent: "Does not mention the subject",
  unsupported_type: "Unsupported file type",
  password: "Protected by a password",
  zip_error: "Archive could not be opened",
  draft: "Draft",
  self_forward: "Forward to oneself",
  signature_image: "Signature image",
  unreadable_image: "Unreadable image",
  empty_output: "Nothing readable inside",
  files_filter: "Files filter",
  client_case: "Client case: kept after deduplication",
  mail_screen: "Confidentiality screening",
  chat_excerpt: "Chat excerpt",
};

/** The fixed checks an email passes before the AI, in order. */
const PASSED_CHECKS: Array<{ rule: string; pass: string; detail: string }> = [
  {
    rule: "dup",
    pass: "Not a duplicate",
    detail: "Unique identifier in this request",
  },
  {
    rule: "keyword",
    pass: "No confidential keyword",
    detail: "Subject and body checked, signature ignored",
  },
  {
    rule: "subject_absent",
    pass: "Mentions the subject",
    detail: "The subject is cited in the email",
  },
];

const DOT = {
  kept: "bg-aida-green-dot",
  discarded: "bg-aida-red",
  review: "bg-aida-amber",
  reanalysing: "bg-aida-primary",
  pending: "bg-aida-dim",
} as const;

const PILL = {
  kept: { tone: "green", label: "Kept" },
  discarded: { tone: "red", label: "Discarded" },
  review: { tone: "amber", label: "For human review" },
  pending: { tone: "grey", label: "Waiting" },
  reanalysing: { tone: "amber", label: "Reanalysing" },
} as const;

function clock(iso: string): string {
  const date = new Date(iso);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function whoLabel(decidedBy: string | null, rule: string | null): string {
  if (
    !decidedBy ||
    decidedBy === "rule" ||
    rule === "dup" ||
    rule === "keyword"
  )
    return "Rule";
  if (/5[.-]5/.test(decidedBy)) return "2nd analysis (AI)";
  return "1st analysis (AI)";
}

function explanation(item: ItemDetail): string {
  const reason = item.reason ? ` ${item.reason}` : "";
  switch (item.state) {
    case "reanalysing":
      return `The 1st analysis discarded this item${
        item.confidenceKeep !== null
          ? `, but with low confidence (${item.confidenceKeep}% chance it should be kept)`
          : ""
      }. A more careful 2nd analysis therefore decides: the item is kept or the discard is confirmed. If it cannot answer, the item is kept.`;
    case "kept":
      return item.analysis === "2nd analysis"
        ? `Kept after the 2nd analysis.${reason}`
        : item.analysis === "Rule"
          ? `Kept by a fixed rule.${reason}`
          : `Kept by the AI.${reason}`;
    case "discarded":
      return item.analysis === "Rule"
        ? `Removed by a fixed rule before the AI looked at it.${reason}`
        : `Discarded by the ${item.analysis === "2nd analysis" ? "2nd" : "1st"} analysis.${reason}`;
    case "review":
      return `A person should look at this item: it goes to the human review folder.${reason}`;
    default:
      return "No decision yet.";
  }
}

export function ItemPanel({
  itemId,
  backLabel,
  onBack,
  onClose,
}: {
  itemId: string;
  backLabel: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setMissing(false);
    fetch(`/api/items/${itemId}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("missing");
        const body = (await response.json()) as { item: ItemDetail };
        if (!cancelled) setItem(body.item);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (missing) {
    return (
      <div className="flex min-h-full flex-col">
        <DrawerHeader
          title="Item not found"
          onClose={onClose}
          back={{ label: backLabel, onClick: onBack }}
        />
      </div>
    );
  }
  if (!item) {
    return (
      <div className="flex min-h-full flex-col">
        <DrawerHeader
          title="Loading…"
          onClose={onClose}
          back={{ label: backLabel, onClick: onBack }}
        />
      </div>
    );
  }

  const pill = PILL[item.state];
  const kind =
    item.kind === "email"
      ? "Email"
      : item.kind === "chat_message"
        ? "Teams message"
        : "File";
  // The decision events, oldest first; the last one is the current state.
  const decisions = item.events;
  const ruleStopsAt = PASSED_CHECKS.findIndex(
    (check) => check.rule === item.rule,
  );
  const reachedAi = ruleStopsAt === -1;
  const passed =
    item.kind === "email"
      ? PASSED_CHECKS.slice(0, reachedAi ? PASSED_CHECKS.length : ruleStopsAt)
      : [];
  const steps: Array<{
    key: string;
    title: string;
    detail?: string;
    who: string;
    dot: string;
    faded?: boolean;
    link?: boolean;
  }> = [];
  if (item.kind === "email") {
    steps.push({
      key: "read",
      title: "Read from the PST",
      detail: item.sentDate ? `Sent ${item.sentDate}` : undefined,
      who: "Rule",
      dot: "bg-aida-green-dot",
    });
  }
  for (const check of passed) {
    steps.push({
      key: check.rule,
      title: check.pass,
      detail: check.detail,
      who: "Rule",
      dot: "bg-aida-green-dot",
    });
  }
  // Every recorded change after the first becomes a step; the first one is the
  // decision that put the item in its first state.
  decisions.forEach((event, index) => {
    const aiRule =
      event.rule === "ai_email" ||
      event.rule === "ai_file" ||
      event.rule === "mail_screen";
    const title =
      event.state === "kept"
        ? aiRule
          ? index > 0 && /5[.-]5/.test(event.decidedBy ?? "")
            ? "Kept after the 2nd analysis"
            : "Kept"
          : (RULE_TITLES[event.rule ?? ""] ?? "Kept")
        : event.state === "discarded"
          ? aiRule
            ? index > 0
              ? "Discard confirmed"
              : "Discarded"
            : (RULE_TITLES[event.rule ?? ""] ?? "Discarded")
          : event.state === "review"
            ? "Sent to human review"
            : "Waiting for a decision";
    steps.push({
      key: event.id,
      title,
      detail: event.reason ?? undefined,
      who: whoLabel(event.decidedBy, event.rule),
      dot: DOT[event.state as keyof typeof DOT] ?? "bg-aida-dim",
    });
  });
  if (item.state === "reanalysing") {
    steps.push({
      key: "second",
      title: "2nd analysis in progress",
      who: "2nd analysis (AI)",
      detail: "Queued",
      dot: "bg-aida-primary",
    });
    steps.push({
      key: "delivery",
      title: "Delivery: depends on the result of the 2nd analysis",
      who: "",
      dot: "bg-[#2a3350]",
      faded: true,
    });
  }

  return (
    <div className="flex min-h-full flex-col pb-8">
      <DrawerHeader
        back={{ label: backLabel, onClick: onBack }}
        title={item.label}
        subtitle={`${kind}${item.events.length ? ` · ${clock(item.events[item.events.length - 1].time)}` : ""}${
          item.state === "reanalysing" ? " · decision still in progress" : ""
        }`}
        onClose={onClose}
      />
      <div className="mx-6 mt-5 flex flex-col gap-3 rounded-2xl border border-aida-card-line bg-aida-surface p-4">
        <Pill tone={pill.tone} className="w-fit">
          {pill.label}
        </Pill>
        <p className="text-[13px] leading-[17px] text-aida-text-3">
          {explanation(item)}
        </p>
        {item.parent ? (
          <p className="text-xs text-aida-muted">Inside: {item.parent.label}</p>
        ) : null}
      </div>
      <h3 className="mx-6 mb-3 mt-6 text-[15px] font-semibold text-aida-text">
        How the system got here
      </h3>
      <ol className="relative mx-6 flex flex-col gap-[14px]">
        <span className="absolute bottom-3 left-[5px] top-3 w-px bg-aida-input-line" />
        {steps.map((step) => (
          <li key={step.key} className="relative flex items-start gap-3.5">
            <span
              className={cn(
                "relative z-10 mt-1.5 size-[11px] shrink-0 rounded-full",
                step.dot,
              )}
            />
            <div className="flex min-w-0 flex-1 items-start justify-between gap-4">
              <div className="min-w-0">
                <div
                  className={cn(
                    "text-sm font-semibold",
                    step.faded
                      ? "font-medium text-aida-muted"
                      : "text-aida-text",
                  )}
                >
                  {step.title}
                </div>
                {step.detail ? (
                  <div
                    className={cn(
                      "text-xs",
                      step.detail === "Queued"
                        ? "text-aida-primary-text"
                        : "text-aida-muted",
                    )}
                  >
                    {step.detail}
                  </div>
                ) : null}
              </div>
              {step.who ? (
                <span className="shrink-0 text-xs text-aida-muted">
                  {step.who}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="mx-6 mt-6 text-xs leading-4 text-aida-dim">
        Technical details: the 1st analysis uses Claude Haiku 4.5 and the 2nd
        uses Claude Haiku 5.5, both on Amazon Bedrock (EU).
      </p>
    </div>
  );
}
