"use client";

import {
  ChevronLeft,
  FolderOpen,
  HardDrive,
  KeyRound,
  Link2,
  Loader2,
  Save,
  ServerCog,
  Settings2,
  Unlink2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import * as api from "@/lib/api";

type Tab = "AI" | "Azure / SharePoint" | "Storage" | "System";
type Values = Record<string, string | number | boolean | undefined>;

const tabs: { label: Tab; icon: typeof Settings2 }[] = [
  { label: "AI", icon: Settings2 },
  { label: "Azure / SharePoint", icon: KeyRound },
  { label: "Storage", icon: HardDrive },
  { label: "System", icon: ServerCog },
];
const TOKEN_STEP = 50_000;
const MASK = "••••••••••••••••••••";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function nearestTokenStep(value: number) {
  return Math.round(value / TOKEN_STEP) * TOKEN_STEP;
}

export function SystemSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("AI");
  const [values, setValues] = useState<Values>({});
  const [tokens, setTokens] = useState(2_000_000);
  const [parallel, setParallel] = useState(4);
  const [linked, setLinked] = useState(true);
  const [linkedQueueTarget, setLinkedQueueTarget] = useState(8_000_000);
  const [limits, setLimits] = useState<api.AiBatchSettingsLimits | null>(null);
  const [folderTrail, setFolderTrail] = useState<api.SharePointFolder[]>([]);
  const [folderChildren, setFolderChildren] = useState<api.SharePointFolder[]>(
    [],
  );
  const [searchingFolders, setSearchingFolders] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    void fetch("/api/settings", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Unable to load settings.");
        return data;
      })
      .then((data) => {
        const next = data.settings || {};
        setValues(next);
        setTokens(Number(next.maxTokensPerBatch) || 2_000_000);
        setParallel(Number(next.maxConcurrentBatches) || 4);
        setLinkedQueueTarget(
          (Number(next.maxTokensPerBatch) || 2_000_000) *
            (Number(next.maxConcurrentBatches) || 4),
        );
        setLimits(data.limits || null);
        setFolderTrail([]);
        setFolderChildren([]);
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Unable to load settings.",
        ),
      )
      .finally(() => setLoading(false));
  }, [open]);

  const savedSiteUrl = String(values.sharePointSiteUrl || "");
  const minTokens = limits?.minTokensPerBatch ?? 250_000;
  const maxTokens = limits?.maxTokensPerBatch ?? 4_000_000;
  const minParallel = limits?.minConcurrentBatches ?? 1;
  const maxParallel = limits?.maxConcurrentBatches ?? 12;
  const queuedTokens = useMemo(() => tokens * parallel, [tokens, parallel]);

  const update = (key: string, value: string | number) =>
    setValues((current) => ({ ...current, [key]: value }));

  const changeParallel = (nextValue: number) => {
    const nextParallel = clamp(Math.round(nextValue), minParallel, maxParallel);
    setParallel(nextParallel);
    if (linked) {
      setTokens(
        clamp(
          nearestTokenStep(linkedQueueTarget / nextParallel),
          minTokens,
          maxTokens,
        ),
      );
    }
  };

  const changeTokens = (nextValue: number) => {
    const nextTokens = clamp(nearestTokenStep(nextValue), minTokens, maxTokens);
    setTokens(nextTokens);
    if (linked) {
      setParallel(
        clamp(
          Math.round(linkedQueueTarget / nextTokens),
          minParallel,
          maxParallel,
        ),
      );
    }
  };

  const browseFolders = useCallback(
    async (trail: api.SharePointFolder[]) => {
      if (!savedSiteUrl) {
        setError("Save a SharePoint site URL before browsing its folders.");
        return;
      }
      setSearchingFolders(true);
      setError(null);
      try {
        setFolderChildren(
          await api.listSharePointFolderChildren(trail.at(-1)?.id),
        );
        setFolderTrail(trail);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Unable to load folders.",
        );
      } finally {
        setSearchingFolders(false);
      }
    },
    [savedSiteUrl],
  );

  useEffect(() => {
    if (!open || !savedSiteUrl) return;
    void browseFolders([]);
  }, [browseFolders, open, savedSiteUrl]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          maxTokensPerBatch: tokens,
          maxConcurrentBatches: parallel,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to save settings.");
      setValues(data.settings || values);
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to save settings.",
      );
    } finally {
      setSaving(false);
    }
  };

  const input = (
    key: string,
    label: string,
    options: { type?: string; secure?: boolean; hint?: string } = {},
  ) => {
    const configured = Boolean(
      values[`has${key[0].toUpperCase()}${key.slice(1)}`],
    );
    return (
      <label className="grid gap-2">
        <span className="text-sm font-semibold text-slate-200">{label}</span>
        <input
          type={options.type || "text"}
          name={options.secure ? `${key}-replacement` : key}
          autoComplete={options.secure ? "new-password" : undefined}
          data-lpignore={options.secure ? "true" : undefined}
          value={String(values[key] || "")}
          placeholder={options.secure && configured ? MASK : undefined}
          onChange={(event) => update(key, event.target.value)}
          className="rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30 placeholder:text-slate-200"
        />
        {options.hint && (
          <span className="text-xs leading-5 text-slate-500">
            {options.hint}
          </span>
        )}
      </label>
    );
  };

  const section = (
    title: string,
    description: string,
    children: React.ReactNode,
  ) => (
    <section className="rounded-2xl border border-slate-700 bg-slate-800/60 p-5 shadow-[0_16px_45px_-32px_rgba(99,102,241,0.8)]">
      <div className="mb-5">
        <h3 className="text-base font-bold text-slate-100">{title}</h3>
        <p className="mt-1 text-sm leading-6 text-slate-400">{description}</p>
      </div>
      {children}
    </section>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(48rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden border-slate-700 bg-slate-900 p-0 text-slate-100 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b border-slate-700/80 px-6 pb-5 pt-6">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-xl border border-indigo-400/20 bg-indigo-500/15 text-indigo-300 shadow-inner shadow-indigo-400/10">
              <Settings2 className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-xl">System settings</DialogTitle>
              <DialogDescription className="mt-1 text-slate-400">
                Configuration is encrypted at rest and shared by every case.
              </DialogDescription>
            </div>
          </div>
          <div
            className="mt-5 flex flex-wrap gap-2"
            role="tablist"
            aria-label="Settings sections"
          >
            {tabs.map(({ label, icon: Icon }) => (
              <Button
                key={label}
                type="button"
                size="sm"
                variant="ghost"
                className={
                  tab === label
                    ? "border border-indigo-400/35 bg-indigo-500/20 text-indigo-100 shadow-sm shadow-indigo-950 hover:bg-indigo-500/25 hover:text-white"
                    : "border border-transparent text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100"
                }
                aria-selected={tab === label}
                role="tab"
                onClick={() => setTab(label)}
              >
                <Icon data-icon="inline-start" className="size-4" />
                {label}
              </Button>
            ))}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {loading ? (
            <div className="flex min-h-64 items-center justify-center text-slate-400">
              <Loader2 className="animate-spin" />
            </div>
          ) : (
            <div className="grid gap-5">
              {tab === "AI" && (
                <>
                  {section(
                    "Batch delivery window",
                    "Balance parallel work and batch size while keeping the desired amount of work queued.",
                    <div className="grid gap-6">
                      <label className="flex items-center justify-between gap-4 rounded-xl border border-indigo-400/25 bg-indigo-500/10 p-4">
                        <span className="flex gap-3">
                          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-200">
                            {linked ? (
                              <Link2 className="size-4" />
                            ) : (
                              <Unlink2 className="size-4" />
                            )}
                          </span>
                          <span>
                            <span className="block text-sm font-bold text-slate-100">
                              Link batch window
                            </span>
                            <span className="mt-1 block text-xs leading-5 text-slate-400">
                              {linked
                                ? `Keep approximately ${(linkedQueueTarget / 1_000_000).toFixed(1)}M tokens queued as the sliders compensate.`
                                : "Free mode lets each slider change independently."}
                            </span>
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={linked}
                          onChange={(event) => {
                            if (event.target.checked)
                              setLinkedQueueTarget(queuedTokens);
                            setLinked(event.target.checked);
                          }}
                          className="size-5 accent-indigo-500"
                        />
                      </label>
                      <label className="grid gap-2">
                        <span className="flex items-center justify-between text-sm font-bold text-slate-200">
                          Parallel AI batches{" "}
                          <output className="rounded-md bg-slate-950 px-2 py-1 text-indigo-200">
                            {parallel}
                          </output>
                        </span>
                        <input
                          type="range"
                          min={minParallel}
                          max={maxParallel}
                          step={1}
                          value={parallel}
                          onChange={(event) =>
                            changeParallel(Number(event.target.value))
                          }
                          className="accent-indigo-500"
                        />
                        <span className="text-xs text-slate-500">
                          How many independently retryable Batch jobs may be in
                          flight.
                        </span>
                      </label>
                      <label className="grid gap-2">
                        <span className="flex items-center justify-between text-sm font-bold text-slate-200">
                          Token ceiling per batch{" "}
                          <output className="rounded-md bg-slate-950 px-2 py-1 text-indigo-200">
                            {(tokens / 1_000_000).toFixed(2)}M
                          </output>
                        </span>
                        <input
                          type="range"
                          min={minTokens}
                          max={maxTokens}
                          step={TOKEN_STEP}
                          value={tokens}
                          onChange={(event) =>
                            changeTokens(Number(event.target.value))
                          }
                          className="accent-indigo-500"
                        />
                        <span className="text-xs text-slate-500">
                          {linked
                            ? "Linked mode preserves the queued work target. Unlink for free mode."
                            : "Larger chunks reduce submission overhead; smaller chunks limit retry scope."}
                        </span>
                      </label>
                      <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-700 bg-slate-950/45 p-4">
                        <span>
                          <span className="block text-sm font-semibold text-slate-300">
                            Maximum queued AI work
                          </span>
                          <span className="mt-1 block text-xs text-slate-500">
                            Safety cap:{" "}
                            {(
                              (limits?.maxQueuedTokens ?? 20_000_000) /
                              1_000_000
                            ).toFixed(0)}
                            M tokens.
                          </span>
                        </span>
                        <strong className="text-lg text-indigo-200">
                          {(queuedTokens / 1_000_000).toFixed(1)}M
                        </strong>
                      </div>
                    </div>,
                  )}
                  {section(
                    "OpenAI access",
                    "Stored encrypted; enter a new key only when replacing the configured value.",
                    input("openAiKey", "OpenAI API key", {
                      type: "password",
                      secure: true,
                    }),
                  )}
                </>
              )}
              {tab === "Azure / SharePoint" && (
                <>
                  {section(
                    "Azure application",
                    "These application credentials remain encrypted and are never sent back to the browser.",
                    <div className="grid gap-4 md:grid-cols-2">
                      {input("azureTenantId", "Tenant ID", {
                        secure: true,
                        type: "password",
                      })}
                      {input("azureClientId", "Client ID", {
                        secure: true,
                        type: "password",
                      })}
                      <div className="md:col-span-2">
                        {input("azureClientSecret", "Client secret", {
                          secure: true,
                          type: "password",
                        })}
                      </div>
                    </div>,
                  )}
                  {section(
                    "SharePoint destination",
                    "Choose the library folder where completed request deliverables will be uploaded.",
                    <div className="grid gap-4">
                      {input("sharePointSiteUrl", "Site URL", {
                        type: "url",
                        hint: "Save the site URL before browsing folders.",
                      })}
                      <div className="grid gap-2">
                        <span className="text-sm font-semibold text-slate-200">
                          Destination folder
                        </span>
                        {values.sharePointFolderPath ? (
                          <div className="flex items-center justify-between gap-2 rounded-xl border border-indigo-400/35 bg-indigo-500/10 px-3 py-2.5 text-sm text-indigo-100">
                            <span className="truncate">
                              {String(values.sharePointFolderPath)}
                            </span>
                            <button
                              type="button"
                              className="text-indigo-200 hover:text-white"
                              onClick={() => {
                                update("sharePointFolderId", "");
                                update("sharePointFolderPath", "");
                              }}
                              aria-label="Clear destination folder"
                            >
                              <X className="size-4" />
                            </button>
                          </div>
                        ) : (
                          <p className="rounded-xl border border-dashed border-slate-700 px-3 py-2.5 text-sm text-slate-500">
                            No folder selected.
                          </p>
                        )}
                        <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                          <span className="truncate">
                            {folderTrail.length
                              ? folderTrail
                                  .map((folder) => folder.name)
                                  .join(" / ")
                              : "Document library root"}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              void browseFolders(folderTrail.slice(0, -1))
                            }
                            disabled={!folderTrail.length || searchingFolders}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-semibold hover:bg-slate-700 disabled:opacity-40"
                          >
                            <ChevronLeft className="size-4" />
                            Back
                          </button>
                        </div>
                        <select
                          value=""
                          disabled={searchingFolders}
                          onChange={(event) => {
                            const next = folderChildren.find(
                              (folder) => folder.id === event.target.value,
                            );
                            if (next)
                              void browseFolders([...folderTrail, next]);
                          }}
                          className="rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30 disabled:opacity-50"
                        >
                          <option value="">
                            {searchingFolders
                              ? "Loading folders…"
                              : folderChildren.length
                                ? "Open a subfolder…"
                                : "No subfolders in this location"}
                          </option>
                          {folderChildren.map((folder) => (
                            <option key={folder.id} value={folder.id}>
                              {folder.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!folderTrail.length}
                          onClick={() => {
                            const current = folderTrail.at(-1);
                            if (current) {
                              update("sharePointFolderId", current.id);
                              update("sharePointFolderPath", current.path);
                            }
                          }}
                        >
                          <FolderOpen data-icon="inline-start" />
                          Use this folder
                        </Button>
                      </div>
                    </div>,
                  )}
                </>
              )}
              {tab === "Storage" &&
                section(
                  "Managed storage",
                  "Storage is fixed to the DSAR folder mounted into AIDA. It is not configurable per system or case.",
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-xl border border-slate-700 bg-slate-950/45 p-4">
                      <p className="text-sm font-semibold text-slate-200">
                        Base staging folder
                      </p>
                      <p className="mt-2 font-mono text-sm text-indigo-200">
                        /data/Staging
                      </p>
                      <p className="mt-3 text-xs text-slate-400">
                        macOS: ~/DSAR/Staging
                      </p>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-950/45 p-4">
                      <p className="text-sm font-semibold text-slate-200">
                        Base deliverables folder
                      </p>
                      <p className="mt-2 font-mono text-sm text-indigo-200">
                        /data/Results
                      </p>
                      <p className="mt-3 text-xs text-slate-400">
                        macOS: ~/DSAR/Results
                      </p>
                    </div>
                  </div>,
                )}
              {tab === "System" &&
                section(
                  "Integrated runtime",
                  "These services are deliberately fixed so every AIDA container can communicate without user-managed connection strings.",
                  <div className="grid gap-3 sm:grid-cols-2">
                    {[
                      ["Execution provider", "Docker one-shot jobs", "Running"],
                      ["Queue provider", "BullMQ via Redis", "Connected"],
                      ["Queue name", "aida-orchestrator", "Fixed"],
                      ["Database", "Postgres integrated stack", "Connected"],
                    ].map(([title, detail, state]) => (
                      <div
                        key={title}
                        className="rounded-xl border border-slate-700 bg-slate-950/45 p-4"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <strong className="text-sm text-slate-200">
                            {title}
                          </strong>
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-300">
                            {state}
                          </span>
                        </div>
                        <p className="mt-2 text-sm text-slate-400">{detail}</p>
                      </div>
                    ))}
                  </div>,
                )}
              {error && (
                <p className="rounded-xl border border-rose-500/35 bg-rose-950/35 px-3 py-2 text-sm text-rose-200">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-3 border-t border-slate-700 bg-slate-900 px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving || loading}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="animate-spin" /> : <Save />} Save
            settings
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
