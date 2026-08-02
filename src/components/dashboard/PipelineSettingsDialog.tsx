"use client";

import {
  ChevronLeft,
  FolderOpen,
  Loader2,
  Save,
  Settings2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import * as api from "@/lib/api";

interface PipelineSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (message: string) => void;
}

const TOKEN_STEP = 50_000;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function nearestTokenStep(value: number): number {
  return Math.round(value / TOKEN_STEP) * TOKEN_STEP;
}

export function PipelineSettingsDialog({
  open,
  onOpenChange,
  onSaved,
}: PipelineSettingsDialogProps) {
  const [tokens, setTokens] = useState(2_000_000);
  const [parallel, setParallel] = useState(4);
  const [linked, setLinked] = useState(true);
  const [linkedQueueTarget, setLinkedQueueTarget] = useState(8_000_000);
  const [sharePointSiteUrl, setSharePointSiteUrl] = useState("");
  const [savedSharePointSiteUrl, setSavedSharePointSiteUrl] = useState("");
  const [sharePointFolderId, setSharePointFolderId] = useState("");
  const [sharePointFolderPath, setSharePointFolderPath] = useState("");
  const [folderTrail, setFolderTrail] = useState<api.SharePointFolder[]>([]);
  const [folderChildren, setFolderChildren] = useState<api.SharePointFolder[]>(
    [],
  );
  const [pendingFolderId, setPendingFolderId] = useState("");
  const [searchingFolders, setSearchingFolders] = useState(false);
  const [limits, setLimits] = useState<api.AiBatchSettingsLimits | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    api
      .getPipelineSettings()
      .then((data) => {
        setTokens(data.settings.maxTokensPerBatch);
        setParallel(data.settings.maxConcurrentBatches);
        setLinkedQueueTarget(
          data.settings.maxTokensPerBatch * data.settings.maxConcurrentBatches,
        );
        setSharePointSiteUrl(data.settings.sharePointSiteUrl);
        setSavedSharePointSiteUrl(data.settings.sharePointSiteUrl);
        setSharePointFolderId(data.settings.sharePointFolderId);
        setSharePointFolderPath(data.settings.sharePointFolderPath);
        setFolderTrail([]);
        setFolderChildren([]);
        setPendingFolderId("");
        setLimits(data.limits);
      })
      .catch(() => setError("Could not load the live pipeline settings."))
      .finally(() => setLoading(false));
  }, [open]);

  const queuedTokens = useMemo(() => tokens * parallel, [tokens, parallel]);
  const queuedLabel = `${(queuedTokens / 1_000_000).toFixed(1)}M tokens`;
  const minTokens = limits?.minTokensPerBatch ?? 250_000;
  const maxTokens = limits?.maxTokensPerBatch ?? 4_000_000;
  const minParallel = limits?.minConcurrentBatches ?? 1;
  const maxParallel = limits?.maxConcurrentBatches ?? 12;

  const changeParallel = (nextValue: number) => {
    const nextParallel = clamp(Math.round(nextValue), minParallel, maxParallel);
    setParallel(nextParallel);
    if (!linked) return;
    setTokens(
      clamp(
        nearestTokenStep(linkedQueueTarget / nextParallel),
        minTokens,
        maxTokens,
      ),
    );
  };

  const changeTokens = (nextValue: number) => {
    const nextTokens = clamp(nearestTokenStep(nextValue), minTokens, maxTokens);
    setTokens(nextTokens);
    if (!linked) return;
    setParallel(
      clamp(
        Math.round(linkedQueueTarget / nextTokens),
        minParallel,
        maxParallel,
      ),
    );
  };

  const toggleLink = (nextLinked: boolean) => {
    if (nextLinked) setLinkedQueueTarget(queuedTokens);
    setLinked(nextLinked);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const settings = await api.updatePipelineSettings({
        maxTokensPerBatch: tokens,
        maxConcurrentBatches: parallel,
        sharePointSiteUrl,
        sharePointFolderId,
        sharePointFolderPath,
      });
      onOpenChange(false);
      onSaved(
        `AI throughput updated: ${settings.maxConcurrentBatches} parallel batches at ${(settings.maxTokensPerBatch / 1_000_000).toFixed(2)}M tokens each.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Could not save pipeline settings.",
      );
    } finally {
      setSaving(false);
    }
  };

  const browseFolders = useCallback(
    async (trail: api.SharePointFolder[]) => {
      if (!savedSharePointSiteUrl) {
        setError("Enter and save a SharePoint site URL before searching.");
        return;
      }

      setSearchingFolders(true);
      setError(null);
      try {
        setFolderChildren(
          await api.listSharePointFolderChildren(trail.at(-1)?.id),
        );
        setFolderTrail(trail);
        setPendingFolderId("");
      } catch (searchError) {
        setError(
          searchError instanceof Error
            ? searchError.message
            : "Could not load SharePoint folders.",
        );
      } finally {
        setSearchingFolders(false);
      }
    },
    [savedSharePointSiteUrl],
  );

  useEffect(() => {
    if (!open || !savedSharePointSiteUrl) return;
    void browseFolders([]);
  }, [browseFolders, open, savedSharePointSiteUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(48rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300">
              <Settings2 />
            </div>
            <div>
              <DialogTitle>Pipeline settings</DialogTitle>
              <DialogDescription>
                Changes affect new AI slots immediately. Existing OpenAI batches
                continue unchanged.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center text-slate-400">
              <Loader2 className="animate-spin" />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
                <span className="flex flex-col gap-1">
                  <span className="text-sm font-semibold text-slate-200">
                    Link batch window
                  </span>
                  <span className="text-xs text-slate-400">
                    Keep approximately{" "}
                    {(linkedQueueTarget / 1_000_000).toFixed(1)}M tokens queued
                    while the sliders compensate for each other.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={linked}
                  onChange={(event) => toggleLink(event.target.checked)}
                  className="size-4 accent-indigo-500"
                />
              </label>

              <label className="flex flex-col gap-2">
                <span className="flex items-center justify-between gap-3 text-sm font-semibold text-slate-200">
                  <span>Parallel AI batches</span>
                  <output>{parallel}</output>
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
                <span className="text-xs text-slate-400">
                  How many independently retryable Batch jobs may be in flight.
                </span>
              </label>

              <label className="flex flex-col gap-2">
                <span className="flex items-center justify-between gap-3 text-sm font-semibold text-slate-200">
                  <span>Token ceiling per batch</span>
                  <output>{(tokens / 1_000_000).toFixed(2)}M</output>
                </span>
                <input
                  type="range"
                  min={minTokens}
                  max={maxTokens}
                  step={TOKEN_STEP}
                  value={tokens}
                  onChange={(event) => changeTokens(Number(event.target.value))}
                  className="accent-indigo-500"
                />
                <span className="text-xs text-slate-400">
                  {linked
                    ? "Linked mode preserves the queued work target. Uncheck above for free mode."
                    : "Free mode: larger chunks reduce submission overhead; smaller chunks limit retry scope."}
                </span>
              </label>

              <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-slate-400">Maximum queued AI work</span>
                  <strong className="text-slate-100">{queuedLabel}</strong>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  Safety cap:{" "}
                  {(
                    (limits?.maxQueuedTokens ?? 20_000_000) / 1_000_000
                  ).toFixed(0)}
                  M tokens. Failed request lines are retried individually, not
                  as a whole case.
                </p>
              </div>

              <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
                <div>
                  <p className="text-sm font-semibold text-slate-200">
                    SharePoint destination
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    Choose where prepared case folders will be uploaded. The
                    site is stored here; Microsoft credentials remain
                    server-only.
                  </p>
                </div>

                <label className="flex flex-col gap-2">
                  <span className="text-xs font-semibold text-slate-300">
                    Site URL
                  </span>
                  <input
                    type="url"
                    value={sharePointSiteUrl}
                    onChange={(event) => {
                      setSharePointSiteUrl(event.target.value);
                      if (event.target.value !== savedSharePointSiteUrl) {
                        setSharePointFolderId("");
                        setSharePointFolderPath("");
                        setFolderTrail([]);
                        setFolderChildren([]);
                      }
                    }}
                    placeholder="https://spglaw.sharepoint.com/sites/TheITverse"
                    className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
                  />
                </label>

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold text-slate-300">
                    Destination folder
                  </span>
                  {sharePointFolderPath ? (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-100">
                      <span className="truncate" title={sharePointFolderPath}>
                        {sharePointFolderPath}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSharePointFolderId("");
                          setSharePointFolderPath("");
                        }}
                        className="text-indigo-200 hover:text-white"
                        aria-label="Clear SharePoint destination folder"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">
                      No folder selected.
                    </p>
                  )}

                  <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                    <span className="truncate">
                      {folderTrail.length > 0
                        ? folderTrail.map((folder) => folder.name).join(" / ")
                        : "Document library root"}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void browseFolders(folderTrail.slice(0, -1))
                      }
                      disabled={folderTrail.length === 0 || searchingFolders}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-semibold text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                    >
                      <ChevronLeft className="size-4" />
                      Back
                    </button>
                  </div>

                  <select
                    value={pendingFolderId}
                    onChange={(event) => {
                      const next = folderChildren.find(
                        (folder) => folder.id === event.target.value,
                      );
                      if (next) void browseFolders([...folderTrail, next]);
                    }}
                    disabled={searchingFolders}
                    className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
                  >
                    <option value="">
                      {searchingFolders
                        ? "Loading folders…"
                        : folderChildren.length > 0
                          ? "Open a subfolder…"
                          : "No subfolders in this location"}
                    </option>
                    {folderChildren.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => {
                      const current = folderTrail.at(-1);
                      if (!current) return;
                      setSharePointFolderId(current.id);
                      setSharePointFolderPath(current.path);
                    }}
                    disabled={folderTrail.length === 0}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-indigo-500/50 bg-indigo-500/10 px-3 py-2 text-sm font-semibold text-indigo-100 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <FolderOpen className="size-4" />
                    Use this folder
                  </button>
                  <p className="text-xs leading-5 text-slate-500">
                    Open folders from the dropdown to navigate deeper, then use
                    the current folder as the destination.
                  </p>
                </div>
              </div>

              {error && <p className="text-sm text-rose-300">{error}</p>}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-3 border-t border-slate-700 bg-slate-900 px-6 py-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-xl border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || loading}
            onClick={save}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Save settings
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
