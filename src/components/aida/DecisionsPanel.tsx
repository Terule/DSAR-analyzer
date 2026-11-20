"use client";

import { Download, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ItemTab } from "@/lib/request-insights";
import { cn } from "@/lib/utils";
import { count } from "./case-view";
import { Drawer, DrawerHeader, Pill } from "./Drawer";
import { Btn, FilterChip, Modal } from "./ui";

export interface DecisionRow {
  id: string;
  label: string;
  kind: string;
  state: "kept" | "discarded" | "review" | "pending" | "reanalysing";
  rule: string | null;
  reason: string | null;
  time: string;
  analysis: string;
}

interface Listing {
  items: DecisionRow[];
  counts: Record<string, number>;
  tabs: Record<ItemTab, number>;
  hasMore: boolean;
}

const STATE_PILL = {
  kept: { tone: "green", label: "Kept" },
  discarded: { tone: "red", label: "Discarded" },
  review: { tone: "amber", label: "For review" },
  pending: { tone: "grey", label: "Waiting" },
  reanalysing: { tone: "amber", label: "Reanalysing" },
} as const;

export const STEP_TITLES: Record<string, { title: string; subtitle: string }> =
  {
    duplicates: {
      title: "Duplicates removed",
      subtitle:
        "Items already in this request, recognised by their unique identifier.",
    },
    type: {
      title: "Unsupported or protected",
      subtitle:
        "Files the system cannot read, or that are protected by a password.",
    },
    keyword: {
      title: "Confidential keyword",
      subtitle:
        "Subject or body contains a confidential keyword; signatures are ignored.",
    },
    other: {
      title: "Other fixed filters",
      subtitle:
        "Drafts, forwards to oneself, signature images and other fixed rules.",
    },
    subject: {
      title: "Does not mention the subject",
      subtitle:
        "Nothing in these items cites the data subject, so they are not delivered.",
    },
    ai: {
      title: "AI decisions",
      subtitle:
        "Emails analysed by the AI; doubtful discards are analysed again.",
    },
  };

function clock(iso: string): string {
  const date = new Date(iso);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

/**
 * The list of decisions behind a funnel step, or all AI decisions of a request.
 * Rows open the item panel.
 */
export function DecisionsPanel({
  requestId,
  title,
  step,
  heading,
  onClose,
  onOpenItem,
  initialTab = "emails",
  review = false,
}: {
  requestId: string;
  /** "Concerns..." style subtitle prefix: the case and request. */
  title: string;
  step: string | null;
  heading?: { title: string; subtitle: string };
  onClose: () => void;
  onOpenItem: (id: string) => void;
  initialTab?: ItemTab;
  /** The human review list: every item a person must check, no tabs. */
  review?: boolean;
}) {
  const [tab, setTab] = useState<ItemTab>(initialTab);
  const [state, setState] = useState<string>(review ? "review" : "");
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportScope, setExportScope] = useState<"screen" | "tab">("screen");
  const [exportBusy, setExportBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const params = useMemo(() => {
    const search = new URLSearchParams({ tab: review ? "all" : tab });
    if (step && step !== "ai") search.set("step", step);
    if (step === "ai") search.set("step", "ai");
    if (state) search.set("state", state);
    if (query.trim()) search.set("q", query.trim());
    return search;
  }, [tab, step, state, query, review]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/requests/${requestId}/items?${params}`,
        {
          cache: "no-store",
        },
      );
      if (response.ok) setListing((await response.json()) as Listing);
    } catch {
      // The shell shows when the connection is lost.
    } finally {
      setLoading(false);
    }
  }, [requestId, params]);

  useEffect(() => {
    setLoading(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void load(), query ? 250 : 0);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [load, query]);

  // Keep the list current while the AI works.
  useEffect(() => {
    const interval = window.setInterval(() => void load(), 6_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const runExport = async () => {
    setExportBusy(true);
    try {
      const query = new URLSearchParams(params);
      if (exportScope === "tab") query.set("scope", "tab");
      const response = await fetch(`/api/requests/${requestId}/audit?${query}`);
      if (!response.ok) throw new Error("export failed");
      const blob = await response.blob();
      const name = `aida-${title.split(" · ").pop()?.toLowerCase() ?? "request"}-${tab}.csv`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Export ready", {
        description: `${name} · ${(blob.size / 1024).toFixed(blob.size > 1_048_576 ? 0 : 1)} KB saved to Downloads.`,
      });
      setExporting(false);
    } catch {
      toast.error("Export failed", {
        description:
          "The file could not be written. Check free disk space and try again.",
      });
    } finally {
      setExportBusy(false);
    }
  };

  useEffect(() => {
    const open = () => setExporting(true);
    window.addEventListener("aida:export", open);
    return () => window.removeEventListener("aida:export", open);
  }, []);

  const counts = listing?.counts ?? {};
  const total = ["kept", "discarded", "review", "pending"].reduce(
    (sum, key) => sum + (counts[key] ?? 0),
    0,
  );
  const info = review
    ? {
        title: "For human review",
        subtitle: `${count(counts.review ?? 0)} items are waiting for a person.`,
      }
    : (step && STEP_TITLES[step]) || heading || STEP_TITLES.ai;
  const showStates = step === "ai" || !step;

  const shown = ["kept", "discarded", "review", "pending"].reduce(
    (sum, key) => sum + (state && key !== state ? 0 : (counts[key] ?? 0)),
    0,
  );
  const tabLabel = review
    ? "Items"
    : tab === "emails"
      ? "Emails"
      : tab === "attachments"
        ? "Attachments"
        : "Files";
  const screenDescription = [
    tabLabel,
    state
      ? `tab ${STATE_PILL[state as keyof typeof STATE_PILL]?.label ?? state}`
      : null,
    query.trim() ? `search “${query.trim()}”` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex min-h-full flex-col">
      <Modal
        open={exporting}
        onClose={() => setExporting(false)}
        title="Export CSV"
        description="Saved to your Downloads folder."
        width={520}
        footer={
          <>
            <Btn kind="ghost" onClick={() => setExporting(false)}>
              Cancel
            </Btn>
            <Btn
              kind="primary"
              disabled={exportBusy}
              onClick={() => void runExport()}
            >
              {exportScope === "screen"
                ? `Export ${count(shown)} rows`
                : `Export ${count(listing?.tabs[tab] ?? 0)} rows`}
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="text-[13px] font-medium text-aida-text-2">
            What to export
          </div>
          {(
            [
              [
                "screen",
                "What is on screen",
                `${screenDescription} · ${count(shown)} rows`,
              ],
              [
                "tab",
                "Everything in this tab",
                `All ${count(listing?.tabs[tab] ?? 0)} ${tabLabel.toLowerCase()} with their decisions`,
              ],
            ] as const
          ).map(([key, label, detail]) => (
            <button
              type="button"
              key={key}
              onClick={() => setExportScope(key)}
              aria-pressed={exportScope === key}
              className={cn(
                "flex flex-col gap-1 rounded-xl border p-4 text-left",
                exportScope === key
                  ? "border-aida-primary bg-[#111a33]"
                  : "border-aida-input-line hover:bg-aida-nav-active/40",
              )}
            >
              <span className="text-sm font-semibold text-aida-text">
                {label}
              </span>
              <span className="text-[13px] text-aida-muted">{detail}</span>
            </button>
          ))}
          <p className="text-xs leading-4 text-aida-dim">
            Same format as the audit trail file delivered with the request.
            Columns: time, decision, item (email subject or file name), kind,
            origin, parent, rule, reason and who decided.
          </p>
        </div>
      </Modal>
      <DrawerHeader
        title={info.title}
        subtitle={`${title} · ${info.subtitle}`}
        onClose={onClose}
        actions={
          <button
            type="button"
            onClick={() => (review ? void runExport() : setExporting(true))}
            className="inline-flex items-center gap-2 rounded-[10px] bg-aida-primary px-3.5 py-2 text-[13px] font-semibold text-white hover:brightness-110"
          >
            <Download className="size-4" strokeWidth={2} /> Export CSV
          </button>
        }
      />
      {review ? (
        <p className="mx-6 mt-4 rounded-[10px] border border-aida-primary-line bg-[#0f1830] px-3.5 py-3 text-[13px] leading-5 text-aida-text-2">
          A person must check these before delivery. For employee cases the
          folder is delivered to the HR review folder on SharePoint; for client
          cases it stays on disk for a person outside this app.
        </p>
      ) : null}
      <div
        className={cn(
          "mt-4 flex gap-6 border-b border-aida-line px-6",
          review && "hidden",
        )}
      >
        {(
          [
            ["emails", "Emails"],
            ["attachments", "Attachments"],
            ["files", "Files"],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 pb-2.5 text-[13px]",
              tab === key
                ? "border-aida-primary font-semibold text-aida-text"
                : "border-transparent font-medium text-aida-muted hover:text-aida-text-2",
            )}
          >
            {label} {listing ? count(listing.tabs[key]) : ""}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
        {review ? null : (
          <FilterChip active={state === ""} onClick={() => setState("")}>
            All {count(total)}
          </FilterChip>
        )}
        {showStates && !review ? (
          <>
            <FilterChip
              active={state === "kept"}
              onClick={() => setState("kept")}
            >
              <Swatch className="bg-aida-green-dot" /> Kept{" "}
              {count(counts.kept ?? 0)}
            </FilterChip>
            <FilterChip
              active={state === "discarded"}
              onClick={() => setState("discarded")}
            >
              <Swatch className="bg-aida-red" /> Discarded{" "}
              {count(counts.discarded ?? 0)}
            </FilterChip>
            {(counts.reanalysing ?? 0) > 0 ? (
              <FilterChip
                active={state === "pending"}
                onClick={() => setState("pending")}
              >
                <Swatch className="bg-aida-amber" /> Reanalysing{" "}
                {count(counts.reanalysing ?? 0)}
              </FilterChip>
            ) : null}
          </>
        ) : null}
        <label className="ml-auto flex w-[150px] items-center gap-2 rounded-[10px] border border-aida-input-line px-3 py-1.5 focus-within:border-aida-primary-line">
          <Search className="size-3.5 text-aida-dim" strokeWidth={1.5} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search items"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-aida-text outline-none placeholder:text-aida-dim"
          />
        </label>
      </div>
      <ul className="flex flex-col gap-2 px-6 py-4">
        {loading && !listing ? (
          [0, 1, 2, 3].map((row) => (
            <li
              key={row}
              className="h-[54px] animate-pulse rounded-[10px] bg-aida-surface"
            />
          ))
        ) : listing && listing.items.length === 0 ? (
          <li className="rounded-xl border border-aida-input-line bg-aida-surface-2 px-4 py-10 text-center text-sm text-aida-muted">
            {query ? `Nothing matches “${query}”.` : "No items here yet."}
          </li>
        ) : (
          listing?.items.map((item) => {
            const pill = STATE_PILL[item.state];
            if (review) {
              const kind =
                item.kind === "email"
                  ? "Email"
                  : item.kind === "chat_message"
                    ? "Chat"
                    : /\.(jpe?g|png|gif|bmp|tiff?|webp|heic)(\b|$)/i.test(
                          item.label,
                        )
                      ? "Image"
                      : "File";
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onOpenItem(item.id)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)_56px] items-center gap-3 rounded-[10px] border border-aida-card-line bg-aida-surface px-3.5 py-3 text-left hover:border-aida-primary-line/70"
                  >
                    <span className="block truncate text-[13px] text-aida-text-2">
                      {item.label}
                    </span>
                    <span className="block truncate text-[13px] text-aida-muted">
                      {item.reason ?? "—"}
                    </span>
                    <Pill tone="amber" className="w-fit justify-self-end">
                      {kind}
                    </Pill>
                  </button>
                </li>
              );
            }
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onOpenItem(item.id)}
                  className="grid w-full grid-cols-[64px_96px_minmax(0,1fr)_88px] items-center gap-3 rounded-[10px] border border-transparent bg-aida-surface px-3.5 py-2.5 text-left hover:border-aida-primary-line/70"
                >
                  <span className="text-xs text-aida-dim">
                    {clock(item.time)}
                  </span>
                  <Pill tone={pill.tone} className="w-fit">
                    {pill.label}
                  </Pill>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-aida-text">
                      {item.label}
                    </span>
                    <span className="block truncate text-xs text-aida-muted">
                      {item.reason ?? "—"}
                    </span>
                  </span>
                  <span className="text-right text-xs text-aida-muted">
                    {item.analysis}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

function Swatch({ className }: { className: string }) {
  return (
    <span
      className={cn(
        "mr-1.5 inline-block size-1.5 rounded-full align-middle",
        className,
      )}
    />
  );
}

export function DecisionsDrawer(props: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Drawer open={props.open} onClose={props.onClose} width={740}>
      {props.children}
    </Drawer>
  );
}
