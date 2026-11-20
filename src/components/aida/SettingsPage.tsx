"use client";

import { Check, ChevronRight, Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import * as api from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OneTrustFormsCard } from "./OneTrustFormsCard";
import { Btn, Card, Field, Modal, Page, PageHeader, TextInput } from "./ui";

type Values = Record<string, string | number | boolean | undefined>;

const TABS = [
  { key: "ai", label: "AI" },
  { key: "sharepoint", label: "Azure / SharePoint" },
  { key: "onetrust", label: "OneTrust" },
  { key: "storage", label: "Storage" },
  { key: "system", label: "System" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const MASK = "••••••••••••••••";

function SectionCard({
  title,
  text,
  children,
}: {
  title: string;
  text?: string;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold text-aida-text">{title}</h2>
        {text ? <p className="text-[13px] text-aida-muted">{text}</p> : null}
      </div>
      {children}
    </Card>
  );
}

function ErrorBanner({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-[#7d3033] bg-[#241012] px-6 py-[18px]">
      <span className="text-sm font-semibold text-aida-red">{title}</span>
      <span className="text-[13px] text-aida-text-3">{text}</span>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-aida-line py-3 text-sm last:border-b-0">
      <span className="font-medium text-aida-text-2">{label}</span>
      <span className="text-right text-aida-muted">{value}</span>
    </div>
  );
}

type Probe = { state: "idle" | "testing" | "ok" | "failed"; message?: string };

function useProbe(target: "sharepoint" | "onetrust" | "bedrock") {
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  const run = useCallback(async () => {
    setProbe({ state: "testing" });
    try {
      const response = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      setProbe(
        body.ok
          ? { state: "ok" }
          : { state: "failed", message: body.error ?? "Connection failed." },
      );
    } catch {
      setProbe({ state: "failed", message: "The app could not be reached." });
    }
  }, [target]);
  return { probe, run };
}

function TestRow({
  probe,
  run,
  failedLabel = "Not connected",
}: {
  probe: Probe;
  run: () => void;
  failedLabel?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Btn kind="secondary" onClick={run} disabled={probe.state === "testing"}>
        {probe.state === "testing" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : null}
        Test connection
      </Btn>
      {probe.state === "ok" ? (
        <span className="flex items-center gap-2 text-[13px] font-medium text-aida-green-dot">
          <span className="size-2 rounded-full bg-aida-green-dot" /> Connected
        </span>
      ) : probe.state === "failed" ? (
        <span className="flex items-center gap-2 text-[13px] font-medium text-aida-red">
          <span className="size-2 rounded-full bg-aida-red" /> {failedLabel}
        </span>
      ) : null}
    </div>
  );
}

/* ---------- SharePoint folder picker ---------- */

function FolderPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (folder: api.SharePointFolder) => void;
}) {
  const [trail, setTrail] = useState<api.SharePointFolder[]>([]);
  const [children, setChildren] = useState<api.SharePointFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browse = useCallback(async (next: api.SharePointFolder[]) => {
    setLoading(true);
    setError(null);
    try {
      setChildren(await api.listSharePointFolderChildren(next.at(-1)?.id));
      setTrail(next);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not load folders.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (open) void browse([]);
  }, [open, browse]);
  const current = trail.at(-1);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose a folder"
      width={520}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            disabled={!current}
            onClick={() => {
              if (current) onPick(current);
              onClose();
            }}
          >
            Use this folder
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1 text-[13px] text-aida-muted">
          <button
            type="button"
            className="hover:text-aida-text"
            onClick={() => void browse([])}
          >
            Document library
          </button>
          {trail.map((folder, index) => (
            <span key={folder.id} className="flex items-center gap-1">
              <ChevronRight className="size-3" />
              <button
                type="button"
                className="hover:text-aida-text"
                onClick={() => void browse(trail.slice(0, index + 1))}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </div>
        <div className="max-h-72 overflow-y-auto rounded-xl border border-aida-input-line bg-aida-bg">
          {loading ? (
            <div className="flex justify-center p-6 text-aida-muted">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : error ? (
            <p className="p-4 text-[13px] text-aida-red">{error}</p>
          ) : children.length === 0 ? (
            <p className="p-4 text-[13px] text-aida-muted">
              No subfolders here.
            </p>
          ) : (
            children.map((folder) => (
              <button
                type="button"
                key={folder.id}
                onClick={() => void browse([...trail, folder])}
                className="flex w-full items-center gap-2 border-b border-aida-line px-4 py-2.5 text-left text-sm text-aida-text-2 last:border-b-0 hover:bg-aida-nav-active"
              >
                <ChevronRight className="size-3 text-aida-dim" />
                {folder.name}
              </button>
            ))
          )}
        </div>
        {current ? (
          <p className="text-[13px] text-aida-muted">
            Selected: <span className="text-aida-text-2">{current.path}</span>
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ---------- Page ---------- */

export function SettingsPage() {
  const search = useSearchParams();
  const tab = (TABS.find((entry) => entry.key === search.get("tab"))?.key ??
    "ai") as TabKey;
  const [saved, setSaved] = useState<Values | null>(null);
  const [draft, setDraft] = useState<Values>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [system, setSystem] = useState<{
    freeBytes: number | null;
    totalBytes: number | null;
    memoryTotalBytes: number;
    memoryUsedBytes: number;
    stagingPath: string | null;
    extractedPath: string | null;
  } | null>(null);
  const bedrock = useProbe("bedrock");
  const sharepoint = useProbe("sharepoint");
  const onetrust = useProbe("onetrust");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Could not load the settings.");
      setSaved(body.settings ?? {});
      setDraft({});
      setLoadError(null);
    } catch (failure) {
      setLoadError(
        failure instanceof Error
          ? failure.message
          : "Could not load the settings.",
      );
    }
  }, []);
  useEffect(() => {
    void load();
    fetch("/api/system-status", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSystem)
      .catch(() => undefined);
  }, [load]);

  const value = (key: string): string | number | boolean | undefined =>
    key in draft ? draft[key] : saved?.[key];
  const set = (key: string, next: string | number | boolean) =>
    setDraft((current) => ({ ...current, [key]: next }));
  const dirty = Object.keys(draft).length > 0;

  const errors = useMemo(() => {
    const result: Record<string, string> = {};
    const range = (key: string, label: string, min: number, max: number) => {
      if (!(key in draft)) return;
      const number = Number(draft[key]);
      if (
        draft[key] === "" ||
        !Number.isFinite(number) ||
        number < min ||
        number > max
      ) {
        result[key] = `Enter a number between ${min} and ${max}.`;
      }
    };
    range("rereviewMinPKeep", "threshold", 0, 100);
    range("rereviewSamplePercent", "spot check", 0, 100);
    range("filesConcurrency", "workers", 1, 8);
    return result;
  }, [draft]);

  const save = async () => {
    if (Object.keys(errors).length) return;
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Could not save the settings.");
      setSaved(body.settings ?? saved);
      setDraft({});
      toast.success("Settings saved.", {
        description:
          tab === "sharepoint"
            ? "SharePoint settings apply to the next upload."
            : undefined,
      });
    } catch (failure) {
      toast.error(
        failure instanceof Error
          ? failure.message
          : "Could not save the settings.",
      );
    } finally {
      setSaving(false);
    }
  };

  const secret = (key: string, label: string, hint?: string) => {
    const configured = Boolean(
      saved?.[`has${key[0].toUpperCase()}${key.slice(1)}`],
    );
    return (
      <Field label={label} hint={hint}>
        <TextInput
          type="password"
          autoComplete="new-password"
          name={`${key}-replacement`}
          data-lpignore="true"
          value={String(draft[key] ?? "")}
          placeholder={configured ? MASK : ""}
          onChange={(event) => set(key, event.target.value)}
        />
      </Field>
    );
  };
  const text = (
    key: string,
    label: string,
    props: { type?: string; placeholder?: string; hint?: string } = {},
  ) => (
    <Field label={label} hint={props.hint} error={errors[key]}>
      <TextInput
        type={props.type}
        value={String(value(key) ?? "")}
        placeholder={props.placeholder}
        invalid={!!errors[key]}
        onChange={(event) => set(key, event.target.value)}
      />
    </Field>
  );
  const toggle = (
    key: string,
    label: string,
    detail: string,
    fallback = true,
  ) => {
    const current = value(key) === undefined ? fallback : Boolean(value(key));
    return (
      <div className="flex items-start justify-between gap-6 border-b border-aida-line py-4 first:pt-0 last:border-b-0 last:pb-0">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-aida-text">{label}</span>
          <span className="max-w-[560px] text-[13px] leading-[18px] text-aida-muted">
            {detail}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={current}
          aria-label={label}
          onClick={() => set(key, !current)}
          className={cn(
            "relative mt-0.5 h-[22px] w-10 shrink-0 rounded-full transition",
            current ? "bg-aida-primary" : "bg-aida-track",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-[18px] rounded-full bg-white transition-all",
              current ? "left-[20px]" : "left-0.5",
            )}
          />
        </button>
      </div>
    );
  };

  const folderPath = String(value("sharePointFolderPath") ?? "");

  return (
    <Page className="pb-28">
      <PageHeader
        title="Settings"
        subtitle="These apply to future cases. Cases in progress do not change."
      />
      {loadError ? (
        <ErrorBanner title="Could not load the settings" text={loadError} />
      ) : null}
      <div className="flex gap-6">
        <nav
          className="flex w-[200px] shrink-0 flex-col gap-1"
          aria-label="Settings sections"
        >
          {TABS.map((entry) => (
            <Link
              key={entry.key}
              href={`/settings?tab=${entry.key}`}
              scroll={false}
              className={cn(
                "rounded-lg px-3 py-2.5 text-sm",
                tab === entry.key
                  ? "bg-aida-nav-active font-semibold text-white"
                  : "font-medium text-aida-text-3 hover:bg-aida-nav-active/60",
              )}
            >
              {entry.label}
            </Link>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {tab === "ai" ? (
            <>
              {bedrock.probe.state === "failed" ? (
                <ErrorBanner
                  title="Amazon Bedrock is unreachable"
                  text="The system could not reach Amazon Bedrock in eu-central-1. AI reviews are paused and resume on their own when the connection returns. Nothing is lost."
                />
              ) : null}
              <SectionCard
                title="How the AI is used"
                text="Amazon Bedrock only, eu-central-1 region. These values are fixed by policy."
              >
                <div>
                  <InfoRow label="More than 100 items" value="Batch analysis" />
                  <InfoRow
                    label="100 items or fewer"
                    value="Immediate analysis"
                  />
                  <InfoRow
                    label="2nd analysis"
                    value="Looks again, more carefully, at doubtful discards"
                  />
                </div>
              </SectionCard>
              <SectionCard
                title="Connection"
                text="AWS credentials come from this computer’s AWS profile and are never stored by the app."
              >
                <TestRow
                  probe={bedrock.probe}
                  run={bedrock.run}
                  failedLabel="Unreachable"
                />
                {bedrock.probe.state === "failed" && bedrock.probe.message ? (
                  <p className="text-[13px] text-aida-muted">
                    {bedrock.probe.message}. Check the AWS profile and network,
                    then test again.
                  </p>
                ) : null}
              </SectionCard>
              <SectionCard title="2nd analysis of discards">
                <div className="grid grid-cols-2 gap-5">
                  <div className="flex flex-col gap-2">
                    {text(
                      "rereviewMinPKeep",
                      "Request a 2nd analysis from (%)",
                      { type: "number" },
                    )}
                    <p className="text-xs leading-[15px] text-aida-dim">
                      If the AI sees at least this chance, in %, that an item
                      should be kept even though it discarded it, the item gets
                      a 2nd analysis.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    {text("rereviewSamplePercent", "Spot check (%)", {
                      type: "number",
                    })}
                    <p className="text-xs leading-[15px] text-aida-dim">
                      A share of obvious discards is also analysed again, to
                      measure whether the filter is letting something important
                      slip through.
                    </p>
                  </div>
                </div>
              </SectionCard>
            </>
          ) : null}

          {tab === "sharepoint" ? (
            <>
              {sharepoint.probe.state === "failed" ? (
                <ErrorBanner
                  title="SharePoint connection failed"
                  text={sharepoint.probe.message ?? "The connection failed."}
                />
              ) : null}
              <SectionCard
                title="Connection"
                text="Microsoft Entra application used to upload the human review folder."
              >
                <div className="flex flex-col gap-4">
                  {secret("azureTenantId", "Tenant ID")}
                  {secret("azureClientId", "Client ID")}
                  {secret(
                    "azureClientSecret",
                    "Client secret",
                    "Stored on this computer only. Never shown again.",
                  )}
                  <TestRow probe={sharepoint.probe} run={sharepoint.run} />
                </div>
              </SectionCard>
              <SectionCard
                title="Destination folder"
                text="Where each case’s human review folder is uploaded."
              >
                <div className="flex flex-col gap-4">
                  {text("sharePointSiteUrl", "Site URL", {
                    type: "url",
                    placeholder: "https://tenant.sharepoint.com/sites/…",
                    hint: "Save the site URL before browsing folders.",
                  })}
                  <Field label="Folder">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1 truncate rounded-[10px] border border-aida-input-line bg-aida-bg px-3.5 py-[11px] text-sm text-aida-text-2">
                        {folderPath || (
                          <span className="text-aida-dim">
                            No folder selected
                          </span>
                        )}
                      </div>
                      <Btn
                        kind="secondary"
                        disabled={!saved?.sharePointSiteUrl}
                        onClick={() => setPicking(true)}
                      >
                        Browse SharePoint
                      </Btn>
                    </div>
                  </Field>
                </div>
              </SectionCard>
            </>
          ) : null}

          {tab === "onetrust" ? (
            <>
              {onetrust.probe.state === "failed" ? (
                <ErrorBanner
                  title="OneTrust is not responding"
                  text={onetrust.probe.message ?? "The connection failed."}
                />
              ) : null}
              <SectionCard
                title="Connection"
                text="The OneTrust tenant where data subject requests are created."
              >
                <div className="flex flex-col gap-4">
                  {text("oneTrustTenantUrl", "Host", {
                    type: "url",
                    placeholder: "https://your-tenant.onetrust.com",
                  })}
                  {secret("oneTrustClientId", "Client ID")}
                  {secret("oneTrustClientSecret", "Client secret")}
                  <TestRow
                    probe={onetrust.probe}
                    run={onetrust.run}
                    failedLabel={onetrust.probe.message ?? "Not connected"}
                  />
                </div>
              </SectionCard>
              <OneTrustFormsCard />
            </>
          ) : null}

          {tab === "storage" ? (
            <>
              {system?.freeBytes != null &&
              system.freeBytes < 20 * 1024 ** 3 ? (
                <ErrorBanner
                  title="Low disk space"
                  text={`Only ${formatBytes(system.freeBytes)} are free in the output folder. Free some space before starting the next case.`}
                />
              ) : null}
              <SectionCard
                title="Folders"
                text="Where the system reads from and writes to."
              >
                <div>
                  <InfoRow
                    label="Input folder"
                    value={
                      <code className="font-mono text-aida-text-2">
                        {system?.stagingPath ?? "/data/Staging"}
                      </code>
                    }
                  />
                  <InfoRow
                    label="Output folder"
                    value={
                      <span className="flex flex-col items-end gap-0.5">
                        <code className="font-mono text-aida-text-2">
                          {system?.extractedPath ?? "/data/Results"}
                        </code>
                        {system?.freeBytes != null && system.totalBytes ? (
                          <span className="text-xs">
                            {formatBytes(system.freeBytes)} free of{" "}
                            {formatBytes(system.totalBytes)}
                          </span>
                        ) : null}
                      </span>
                    }
                  />
                </div>
              </SectionCard>
              <SectionCard title="Housekeeping">
                {toggle(
                  "deleteSourcePsts",
                  "Delete source PSTs after delivery",
                  "Removed once the PDFs are checked and built. A deleted PST cannot be read again, so resetting a request needs the PSTs back in the input folder.",
                )}
                {toggle(
                  "filesAiEnabled",
                  "AI screening of attachments and files",
                  "When off, every file goes to human review instead.",
                )}
              </SectionCard>
            </>
          ) : null}

          {tab === "system" ? (
            <>
              <SectionCard
                title="Performance"
                text="How much work runs at the same time on this computer."
              >
                <div className="flex flex-col gap-5">
                  <div className="max-w-[260px]">
                    {text("filesConcurrency", "Processing workers", {
                      type: "number",
                      hint: "1 to 8 at once. Applies within about 15 seconds.",
                    })}
                  </div>
                  <div>
                    <InfoRow
                      label="Memory in use"
                      value={
                        system
                          ? `${formatBytes(system.memoryUsedBytes)} of ${formatBytes(system.memoryTotalBytes)}`
                          : "—"
                      }
                    />
                    <InfoRow
                      label="Disk free"
                      value={
                        system?.freeBytes != null
                          ? formatBytes(system.freeBytes)
                          : "—"
                      }
                    />
                  </div>
                </div>
              </SectionCard>
              <SectionCard
                title="Integrated runtime"
                text="These services are fixed so every AIDA container can talk to the others."
              >
                <div>
                  <InfoRow label="Execution" value="Docker one-shot jobs" />
                  <InfoRow label="Queue" value="BullMQ via Redis" />
                  <InfoRow
                    label="Database"
                    value="Postgres, integrated stack"
                  />
                </div>
              </SectionCard>
            </>
          ) : null}
        </div>
      </div>

      {dirty ? (
        <div className="fixed bottom-6 left-[calc(232px+50%-116px)] z-20 flex w-[min(720px,calc(100vw-300px))] -translate-x-1/2 items-center justify-between gap-6 rounded-2xl border border-aida-primary-line bg-[#0e1730] px-5 py-3.5 shadow-2xl">
          <span className="text-sm text-aida-text-2">
            {Object.keys(errors).length
              ? "Fix the highlighted fields to save."
              : "You have unsaved changes."}
          </span>
          <div className="flex items-center gap-2.5">
            <Btn kind="ghost" onClick={() => setDraft({})}>
              Discard
            </Btn>
            <Btn
              kind="primary"
              disabled={saving || Object.keys(errors).length > 0}
              onClick={() => void save()}
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}{" "}
              Save changes
            </Btn>
          </div>
        </div>
      ) : null}

      <FolderPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(folder) => {
          set("sharePointFolderId", folder.id);
          set("sharePointFolderPath", folder.path);
        }}
      />
    </Page>
  );
}
