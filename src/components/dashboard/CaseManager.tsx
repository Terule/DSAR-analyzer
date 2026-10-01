"use client";

import {
  Archive,
  ChevronDown,
  Cpu,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  formatBytes,
  maskCaseName,
  maskSubjectInformation,
} from "@/lib/format";
import { SystemSettingsDialog } from "./SystemSettingsDialog";

type Scope = "mail" | "files" | "both";
type PhaseState = { done: number; total: number; status: string };
type PhaseTiming = {
  parse: number;
  extract: number;
  ai: number;
  render: number;
  files: number;
};
type RequestItem = {
  id: string;
  name: string;
  scope: Scope;
  case_type?: "employee" | "client";
  status: string;
  pst_count: number;
  pst_size_bytes: number;
  files_count: number;
  files_size_bytes: number;
  deliverable_files: number;
  deliverable_size_bytes: number;
  total_emails: number;
  emails_exported: number;
  phaseProgress?: Record<
    "parse" | "extract" | "ai" | "render" | "files" | "upload",
    PhaseState
  >;
  phaseTiming?: PhaseTiming;
};
type CaseItem = {
  id: string;
  name: string;
  subject_name: string;
  subject_email: string;
  status: string;
  case_type: "employee" | "client";
  onetrust_status: string;
  onetrust_request_id?: string | null;
  onetrust_url?: string | null;
  onetrust_error?: string | null;
  onetrust_uploaded: number;
  onetrust_total: number;
  requests: RequestItem[];
};

const initialConfiguration = {
  subjectName: "",
  subjectEmail: "",
  personalEmail: "",
  aliases: "",
};
const scopeOptions: { value: Scope; label: string; description: string }[] = [
  { value: "mail", label: "Mail", description: "PST and Emails" },
  { value: "files", label: "Files", description: "Files and deliverables" },
  { value: "both", label: "Mail + files", description: "Complete request" },
];

function formatDuration(milliseconds: number) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function aggregateCaseRequests(requests: RequestItem[]): RequestItem {
  const timing = requests.reduce<PhaseTiming>(
    (total, request) => ({
      parse: total.parse + (request.phaseTiming?.parse || 0),
      extract: total.extract + (request.phaseTiming?.extract || 0),
      ai: total.ai + (request.phaseTiming?.ai || 0),
      render: total.render + (request.phaseTiming?.render || 0),
      files: total.files + (request.phaseTiming?.files || 0),
    }),
    { parse: 0, extract: 0, ai: 0, render: 0, files: 0 },
  );
  const total: RequestItem = {
    id: "case-total",
    name: "Case total",
    scope: "both",
    status: requests.every((item) => item.status === "completed")
      ? "completed"
      : "active",
    pst_count: 0,
    pst_size_bytes: 0,
    files_count: 0,
    files_size_bytes: 0,
    deliverable_files: 0,
    deliverable_size_bytes: 0,
    total_emails: 0,
    emails_exported: 0,
    phaseTiming: timing,
  };
  for (const request of requests) {
    total.pst_count += request.pst_count;
    total.pst_size_bytes += request.pst_size_bytes;
    total.files_count += request.files_count;
    total.files_size_bytes += request.files_size_bytes;
    total.deliverable_files += request.deliverable_files;
    total.deliverable_size_bytes += request.deliverable_size_bytes;
    total.total_emails += request.total_emails;
    total.emails_exported += request.emails_exported;
  }
  return total;
}

function phaseCards(request: RequestItem) {
  type PhaseKey = keyof NonNullable<RequestItem["phaseProgress"]>;
  const phases: Array<{ name: string; key: PhaseKey }> = [];
  if (request.scope !== "files") {
    phases.push(
      { name: "Parse", key: "parse" },
      { name: "Extract", key: "extract" },
      { name: "AI audit", key: "ai" },
      { name: "Render", key: "render" },
    );
  }
  if (request.scope !== "mail") phases.push({ name: "Files", key: "files" });
  if (request.case_type !== "client") {
    phases.push({ name: "Upload", key: "upload" });
  }
  return phases.map((phase) => {
    const state = request.phaseProgress?.[phase.key];
    const complete = state?.status === "completed";
    const active = [
      "processing",
      "batch_ready",
      "extracting",
      "analyzed",
    ].includes(state?.status || "");
    const progress = complete
      ? 100
      : state && state.total > 0
        ? Math.min(99, Math.round((state.done / state.total) * 100))
        : active
          ? 10
          : 0;
    return {
      name: phase.name,
      progress,
      detail:
        state && state.total > 0
          ? phase.key === "ai"
            ? `${state.done}/${state.total} batches complete`
            : `${state.done}/${state.total}`
          : undefined,
      label: complete
        ? "Complete"
        : state?.status === "failed"
          ? "Failed"
          : phase.key === "ai" && state?.status === "batch_ready"
            ? "Waiting on OpenAI"
            : active
              ? "In progress"
              : "Waiting",
    };
  });
}

export function CaseManager() {
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [caseName, setCaseName] = useState("");
  const [caseType, setCaseType] = useState<"employee" | "client">("employee");
  const [configureTarget, setConfigureTarget] = useState<CaseItem | null>(null);
  const [newRequestFor, setNewRequestFor] = useState<string | null>(null);
  const [configuration, setConfiguration] = useState(initialConfiguration);
  const [requestForm, setRequestForm] = useState({
    name: "",
    scope: "both" as Scope,
  });
  const [archiveTarget, setArchiveTarget] = useState<CaseItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CaseItem | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [privacyMode, setPrivacyMode] = useState(false);
  const [statisticsTarget, setStatisticsTarget] = useState<CaseItem | null>(
    null,
  );
  const [statisticsRequest, setStatisticsRequest] =
    useState<RequestItem | null>(null);
  const [collapsedCaseIds, setCollapsedCaseIds] = useState<Set<string>>(
    new Set(),
  );

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const response = await fetch(`/api/cases?status=${tab}`, {
          cache: "no-store",
        });
        const body = await response.text();
        let data: { cases?: CaseItem[]; error?: string } = {};
        try {
          data = body ? (JSON.parse(body) as typeof data) : {};
        } catch {
          throw new Error("The case list returned an invalid response.");
        }
        if (!response.ok)
          throw new Error(data.error || "Unable to load cases.");
        setCases(data.cases || []);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Unable to load cases.",
        );
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [tab],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      !cases.some((item) =>
        item.requests.some(
          (request) =>
            ["queued", "running"].includes(request.status) ||
            request.phaseProgress?.upload.status === "processing",
        ),
      )
    )
      return;
    const timer = window.setInterval(() => void refresh(true), 5_000);
    return () => window.clearInterval(timer);
  }, [cases, refresh]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      if (event.key.toLowerCase() === "c" && tab === "active") {
        event.preventDefault();
        setCreateOpen(true);
      } else if (event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab]);
  const call = async (key: string, url: string, init?: RequestInit) => {
    setBusy(key);
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers || {}),
        },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Request failed.");
      await refresh();
      return data;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed.");
      return null;
    } finally {
      setBusy(null);
    }
  };
  const create = async () => {
    const result = await call("create", "/api/cases", {
      method: "POST",
      body: JSON.stringify({ name: caseName, caseType }),
    });
    if (result) {
      setCaseName("");
      setCaseType("employee");
      setCreateOpen(false);
    }
  };
  const configure = async () => {
    if (!configureTarget) return;
    const result = await call(
      `configure-${configureTarget.id}`,
      `/api/cases/${configureTarget.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...configuration,
          aliases: configuration.aliases
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      },
    );
    if (result) {
      setConfiguration(initialConfiguration);
      setConfigureTarget(null);
    }
  };
  const closeConfigure = () => {
    setConfiguration(initialConfiguration);
    setConfigureTarget(null);
  };
  const addRequest = async () => {
    if (!newRequestFor) return;
    const result = await call(
      `add-${newRequestFor}`,
      `/api/cases/${newRequestFor}/requests`,
      { method: "POST", body: JSON.stringify(requestForm) },
    );
    if (result) {
      setRequestForm({ name: "", scope: "both" });
      setNewRequestFor(null);
    }
  };
  const sendToOneTrust = async (item: CaseItem) => {
    const result = await call(
      `onetrust-${item.id}`,
      `/api/cases/${item.id}/onetrust`,
      { method: "POST" },
    );
    if (result) {
      const parts = [
        result.uploaded ? `${result.uploaded} uploaded` : null,
        result.skipped ? `${result.skipped} oversized` : null,
        result.failed ? `${result.failed} failed` : null,
      ].filter(Boolean);
      const detail = parts.join(", ") || "no files to upload";
      if (result.status === "completed") {
        toast.success(`OneTrust completed: ${detail}.`);
      } else {
        toast.warning(`OneTrust ${result.status}: ${detail}.`);
      }
    }
  };
  const stopBeforeDelete = async () => {
    if (!deleteTarget) return;
    const result = await call(
      `stop-${deleteTarget.id}`,
      `/api/cases/${deleteTarget.id}`,
      { method: "POST" },
    );
    if (result?.stopped) {
      setDeleteTarget((current) =>
        current
          ? {
              ...current,
              requests: current.requests.map((request) =>
                ["queued", "running", "stopping"].includes(request.status)
                  ? { ...request, status: "ready" }
                  : request,
              ),
            }
          : null,
      );
      toast.success(
        "All work has stopped. You can now permanently delete the case.",
      );
    } else if (result) {
      toast.info(
        "Stopping background workers. Select Stop all work again to check progress.",
      );
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-950/30 via-[#10182c] to-[#0d1425] px-6 py-8 text-slate-100">
      <div className="mx-auto flex w-full max-w-[1700px] flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-indigo-400/25 bg-indigo-500/15 text-indigo-200 shadow-lg shadow-indigo-950/40">
              <ShieldCheck className="size-6" />
            </div>
            <div>
              <p className="text-xs font-bold tracking-[0.22em] text-indigo-300">
                AIDA
              </p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight">
                Automated Intelligent Data Auditor
              </h1>
              <p className="mt-1 text-slate-400">
                Case-led, controlled data-request delivery
              </p>
            </div>
          </div>
          <div className="flex gap-1 p-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setPrivacyMode((value) => !value)}
              aria-pressed={privacyMode}
              title={privacyMode ? "Show case names" : "Hide case names"}
            >
              {privacyMode ? <EyeOff /> : <Eye />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              title="System settings (,)"
              aria-keyshortcuts=","
            >
              <Settings />
            </Button>
          </div>
        </header>
        <div className="flex gap-2 rounded-2xl border border-slate-800 bg-slate-900/65 p-2 shadow-lg shadow-slate-950/25">
          <Button
            type="button"
            variant="ghost"
            className={
              tab === "active"
                ? "border border-indigo-400/35 bg-indigo-500/20 text-indigo-100 hover:bg-indigo-500/25 hover:text-white"
                : "border border-transparent text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100"
            }
            aria-pressed={tab === "active"}
            onClick={() => setTab("active")}
          >
            Active cases
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={
              tab === "archived"
                ? "border border-indigo-400/35 bg-indigo-500/20 text-indigo-100 hover:bg-indigo-500/25 hover:text-white"
                : "border border-transparent text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100"
            }
            aria-pressed={tab === "archived"}
            onClick={() => setTab("archived")}
          >
            Archived cases
          </Button>
        </div>
        {loading ? (
          <div className="flex justify-center py-24">
            <Loader2 className="animate-spin text-indigo-300" />
          </div>
        ) : tab === "archived" && cases.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-700 p-12 text-center text-slate-400">
            No {tab} cases.
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {tab === "active" && (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                title="Create new case (C)"
                aria-keyshortcuts="C"
                className="flex h-52 self-start flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-700 bg-[#0b1220] p-6 text-slate-400 transition hover:-translate-y-0.5 hover:border-indigo-400 hover:bg-[#111b31] hover:text-indigo-200"
              >
                <span className="flex size-12 items-center justify-center rounded-full border border-current">
                  <Plus />
                </span>
                <span className="text-lg font-semibold">Create new case</span>
                <span className="text-sm">Add a case, then configure it</span>
              </button>
            )}
            <div className="grid items-start gap-5 lg:grid-cols-2">
              {cases.map((item) => {
                const configured = Boolean(
                  item.subject_name.trim() && item.subject_email.trim(),
                );
                const collapsed = collapsedCaseIds.has(item.id);
                return (
                  // biome-ignore lint/a11y/useSemanticElements: The card contains its own buttons, so it cannot be a native button.
                  <div
                    key={item.id}
                    className={`relative rounded-2xl bg-[#1a2742] p-6 ${collapsed ? "h-52" : ""}`}
                    onClick={(event) => {
                      if (
                        (event.target as HTMLElement).closest(
                          "button,input,select,label",
                        )
                      )
                        return;
                      const requestCard = (
                        event.target as HTMLElement
                      ).closest<HTMLElement>("[data-request-id]");
                      if (requestCard) {
                        setStatisticsRequest(
                          item.requests.find(
                            (request) =>
                              request.id === requestCard.dataset.requestId,
                          ) || null,
                        );
                      } else setStatisticsRequest(null);
                      setStatisticsTarget(item);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setStatisticsTarget(item);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`View statistics for ${item.name}`}
                  >
                    <div className="pr-24">
                      <div>
                        <div className="mb-2 inline-flex rounded-full border border-indigo-400/20 bg-indigo-500/10 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-indigo-200">
                          {item.status}
                        </div>
                        <span className="mb-2 ml-2 inline-flex rounded-full border border-slate-500/30 bg-slate-800 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-slate-300">
                          {item.case_type}
                        </span>
                        <h2 className="text-2xl font-bold tracking-tight">
                          {privacyMode ? maskCaseName(item.name) : item.name}
                        </h2>
                        <p className="text-sm text-slate-400">
                          {configured
                            ? privacyMode
                              ? maskSubjectInformation(
                                  item.subject_name,
                                  item.subject_email,
                                )
                              : `${item.subject_name} · ${item.subject_email}`
                            : "Draft case — configuration is required before it can run."}
                        </p>
                      </div>
                      {tab === "active" && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {!configured && (
                            <Button
                              type="button"
                              onClick={() => setConfigureTarget(item)}
                            >
                              <Settings data-icon="inline-start" /> Configure
                              case
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            className="border-emerald-400/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20 hover:text-white disabled:border-slate-800 disabled:bg-slate-900/45 disabled:text-slate-600"
                            disabled={
                              !configured ||
                              (item.case_type === "client" &&
                                item.requests.length > 0)
                            }
                            onClick={() => setNewRequestFor(item.id)}
                          >
                            <Plus data-icon="inline-start" />{" "}
                            {item.requests.length
                              ? item.case_type === "client"
                                ? "Client request added"
                                : "Add request"
                              : "Add first request"}
                          </Button>
                          {item.case_type === "client" && (
                            <Button
                              type="button"
                              variant="outline"
                              className="border-sky-400/45 bg-sky-500/10 text-sky-100 hover:bg-sky-500/20 hover:text-white disabled:border-slate-800 disabled:bg-slate-900/45 disabled:text-slate-600"
                              disabled={
                                busy === `onetrust-${item.id}` ||
                                item.requests.length !== 1 ||
                                item.requests[0]?.status !== "completed"
                              }
                              onClick={() => void sendToOneTrust(item)}
                              title={
                                item.requests[0]?.status !== "completed"
                                  ? "Complete the client request before sending deliverables to OneTrust"
                                  : "Create or update the OneTrust Results Summary"
                              }
                            >
                              {busy === `onetrust-${item.id}` ? (
                                <Loader2
                                  data-icon="inline-start"
                                  className="animate-spin"
                                />
                              ) : (
                                <Upload data-icon="inline-start" />
                              )}
                              {item.onetrust_status === "completed"
                                ? "Sync OneTrust"
                                : "Send to OneTrust"}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                    {tab === "active" && (
                      <div className="absolute right-5 top-5 flex gap-1 p-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() =>
                            setCollapsedCaseIds((current) => {
                              const next = new Set(current);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })
                          }
                          aria-expanded={!collapsed}
                          aria-controls={`case-content-${item.id}`}
                          title={collapsed ? "Expand case" : "Collapse case"}
                          aria-label={
                            collapsed ? "Expand case" : "Collapse case"
                          }
                        >
                          <ChevronDown
                            className={
                              collapsed
                                ? "-rotate-90 transition-transform"
                                : "transition-transform"
                            }
                          />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={
                            !configured ||
                            !item.requests.length ||
                            item.requests.some(
                              (request) => request.status !== "completed",
                            )
                          }
                          onClick={() => setArchiveTarget(item)}
                          title="Archive case"
                          aria-label="Archive case"
                        >
                          <Archive />
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon-sm"
                          disabled={privacyMode}
                          onClick={() => {
                            setDeleteConfirmation("");
                            setDeleteTarget(item);
                          }}
                          title={
                            privacyMode
                              ? "Show case names before deleting a case"
                              : "Delete case"
                          }
                          aria-label="Delete case"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                    <div id={`case-content-${item.id}`} hidden={collapsed}>
                      {!configured && (
                        <div className="mt-5 rounded-xl border border-dashed border-indigo-400/35 bg-indigo-500/5 p-5">
                          <p className="font-semibold text-indigo-100">
                            Configuration required
                          </p>
                          <p className="mt-1 text-sm text-slate-400">
                            Add the subject details, then create the first
                            request. AIDA creates its scope-specific staging and
                            deliverable folders when that request is added.
                          </p>
                        </div>
                      )}
                      {configured && item.requests.length === 0 && (
                        <div className="mt-5 rounded-xl border border-dashed border-indigo-400/35 bg-indigo-500/5 p-5">
                          <p className="font-semibold text-indigo-100">
                            First request required
                          </p>
                          <p className="mt-1 text-sm text-slate-400">
                            Add a request and choose its mail/files scope before
                            AIDA can begin processing this case.
                          </p>
                        </div>
                      )}
                      {item.case_type === "client" &&
                        item.onetrust_status !== "idle" && (
                          <p className="mt-4 text-xs text-sky-200">
                            OneTrust: {item.onetrust_status}
                            {item.onetrust_request_id ? (
                              <>
                                {" · "}
                                {item.onetrust_url ? (
                                  <a
                                    href={item.onetrust_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 hover:text-sky-100"
                                  >
                                    {item.onetrust_request_id}
                                    <ExternalLink className="size-3" />
                                  </a>
                                ) : (
                                  item.onetrust_request_id
                                )}
                              </>
                            ) : null}
                            {item.onetrust_total > 0
                              ? ` · ${item.onetrust_uploaded}/${item.onetrust_total} files uploaded`
                              : ""}
                            {item.onetrust_error
                              ? ` · ${item.onetrust_error}`
                              : ""}
                          </p>
                        )}
                      <div className="mt-5 grid gap-3">
                        {item.requests.map((request) => (
                          <article
                            key={request.id}
                            data-request-id={request.id}
                            className="rounded-xl border border-slate-700/80 bg-slate-950/55 p-4 shadow-inner shadow-slate-950/20"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <h3 className="flex items-center gap-2 font-semibold">
                                  <span>{request.name}</span>
                                  <span className="rounded-full border border-indigo-400/20 bg-indigo-500/15 px-2 py-1 text-xs font-semibold text-indigo-200">
                                    {request.scope}
                                  </span>
                                </h3>
                                <p className="mt-1 text-sm capitalize text-slate-400">
                                  {request.status}
                                </p>
                              </div>
                              {tab === "active" && (
                                <div className="flex gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={
                                      busy === request.id ||
                                      !["ready", "failed"].includes(
                                        request.status,
                                      )
                                    }
                                    onClick={() =>
                                      void call(
                                        request.id,
                                        `/api/requests/${request.id}/run`,
                                        { method: "POST" },
                                      )
                                    }
                                  >
                                    {busy === request.id ? (
                                      <Loader2 className="animate-spin" />
                                    ) : (
                                      <Play />
                                    )}{" "}
                                    Run
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="border-amber-400/45 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20 hover:text-white disabled:border-slate-800 disabled:bg-slate-900/45 disabled:text-slate-600"
                                    disabled={busy === `reset-${request.id}`}
                                    onClick={() =>
                                      void call(
                                        `reset-${request.id}`,
                                        `/api/requests/${request.id}/reset`,
                                        { method: "POST" },
                                      )
                                    }
                                  >
                                    {busy === `reset-${request.id}` ? (
                                      <Loader2 className="animate-spin" />
                                    ) : (
                                      <RefreshCw />
                                    )}{" "}
                                    Reset
                                  </Button>
                                </div>
                              )}
                            </div>
                            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                              {phaseCards(request).map((phase) => {
                                const Icon =
                                  phase.name === "Parse"
                                    ? Database
                                    : phase.name === "Extract"
                                      ? Archive
                                      : phase.name === "AI audit"
                                        ? Cpu
                                        : phase.name === "Upload"
                                          ? Upload
                                          : FileText;
                                return (
                                  <div
                                    key={phase.name}
                                    className="min-h-44 rounded-2xl border border-indigo-400/20 bg-slate-900/65 p-4 text-center"
                                  >
                                    <Icon
                                      className={
                                        phase.progress === 100
                                          ? "mx-auto size-6 text-emerald-300"
                                          : "mx-auto size-6 text-indigo-300"
                                      }
                                    />
                                    <p className="mt-3 whitespace-nowrap text-xs font-bold tracking-[0.14em] text-slate-200">
                                      {phase.name.toUpperCase()}
                                    </p>
                                    <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-800">
                                      <div
                                        className={
                                          phase.progress === 100
                                            ? "h-full bg-emerald-400"
                                            : "h-full bg-indigo-400/80"
                                        }
                                        style={{ width: `${phase.progress}%` }}
                                      />
                                    </div>
                                    <p className="mt-3 text-lg font-semibold text-slate-200">
                                      {phase.progress}%
                                    </p>
                                    <p className="mt-1 text-xs text-slate-500">
                                      {phase.label}
                                    </p>
                                  </div>
                                );
                              })}
                            </div>
                          </article>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-slate-700 bg-slate-900 text-slate-100">
          <DialogHeader>
            <DialogTitle>Create case</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <input
              className="rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2.5 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30"
              placeholder="Case name"
              value={caseName}
              onChange={(event) => setCaseName(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  caseName.trim() &&
                  !/[\\/\0]/.test(caseName.trim()) &&
                  busy !== "create"
                ) {
                  event.preventDefault();
                  void create();
                }
              }}
            />
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-slate-200">
                Case type
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {(["employee", "client"] as const).map((type) => (
                  <label
                    key={type}
                    className={
                      caseType === type
                        ? "rounded-xl border border-indigo-400/45 bg-indigo-500/20 px-3 py-2.5 text-indigo-100"
                        : "rounded-xl border border-slate-700 bg-slate-950/55 px-3 py-2.5 text-slate-400"
                    }
                  >
                    <input
                      type="radio"
                      name="case-type"
                      value={type}
                      checked={caseType === type}
                      onChange={() => setCaseType(type)}
                      className="sr-only"
                    />
                    <span className="block text-sm font-bold capitalize">
                      {type}
                    </span>
                    <span className="mt-1 block text-xs opacity-75">
                      {type === "client"
                        ? "One request, with OneTrust delivery."
                        : "Standard AIDA case workflow."}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="text-xs leading-5 text-slate-400">
              Use a single folder name. Subject details and the first request
              are added from the case card.
            </p>
            <Button
              type="button"
              disabled={
                busy === "create" ||
                !caseName.trim() ||
                /[\\/\0]/.test(caseName.trim())
              }
              onClick={() => void create()}
            >
              {busy === "create" && <Loader2 className="animate-spin" />} Create
              case
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!configureTarget}
        onOpenChange={(open) => !open && closeConfigure()}
      >
        <DialogContent className="border-slate-700 bg-slate-900 p-0 text-slate-100 sm:max-w-xl">
          <DialogHeader className="border-b border-slate-700/80 px-6 pb-5 pt-6">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl border border-indigo-400/25 bg-indigo-500/15 text-lg font-bold text-indigo-200">
                1
              </div>
              <div>
                <DialogTitle>Configure {configureTarget?.name}</DialogTitle>
                <DialogDescription className="mt-1 text-slate-400">
                  Set the shared subject details used by requests in this case.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="grid gap-5 px-6 py-6">
            <section className="rounded-2xl border border-slate-700 bg-slate-800/55 p-4">
              <h3 className="font-bold text-slate-100">Data subject</h3>
              <p className="mb-4 mt-1 text-sm text-slate-400">
                Shared by every request added to this case.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-semibold text-slate-200">
                  Subject name <span className="text-indigo-300">Required</span>
                  <input
                    className="rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2.5 font-normal outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30"
                    placeholder="Full name"
                    value={configuration.subjectName}
                    onChange={(event) =>
                      setConfiguration({
                        ...configuration,
                        subjectName: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-semibold text-slate-200">
                  Subject email{" "}
                  <span className="text-indigo-300">Required</span>
                  <input
                    className="rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2.5 font-normal outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30"
                    placeholder="name@example.com"
                    value={configuration.subjectEmail}
                    onChange={(event) =>
                      setConfiguration({
                        ...configuration,
                        subjectEmail: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-semibold text-slate-200">
                  Personal email{" "}
                  <span className="font-normal text-slate-500">Optional</span>
                  <input
                    className="rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2.5 font-normal outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30"
                    placeholder="personal@example.com"
                    value={configuration.personalEmail}
                    onChange={(event) =>
                      setConfiguration({
                        ...configuration,
                        personalEmail: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-semibold text-slate-200">
                  Aliases{" "}
                  <span className="font-normal text-slate-500">Optional</span>
                  <input
                    className="rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2.5 font-normal outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30"
                    placeholder="Comma-separated names"
                    value={configuration.aliases}
                    onChange={(event) =>
                      setConfiguration({
                        ...configuration,
                        aliases: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
            </section>
            <Button
              type="button"
              size="lg"
              disabled={
                busy === `configure-${configureTarget?.id}` ||
                !configuration.subjectName.trim() ||
                !configuration.subjectEmail.trim()
              }
              onClick={() => void configure()}
            >
              {busy === `configure-${configureTarget?.id}` && (
                <Loader2 className="animate-spin" />
              )}{" "}
              Complete configuration
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!newRequestFor}
        onOpenChange={(open) => !open && setNewRequestFor(null)}
      >
        <DialogContent className="border-slate-700 bg-slate-900 text-slate-100">
          <DialogHeader>
            <DialogTitle>Add request</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <input
              className="rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2.5 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30"
              placeholder="Request name"
              value={requestForm.name}
              onChange={(event) =>
                setRequestForm({ ...requestForm, name: event.target.value })
              }
            />
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-slate-200">
                Request type
              </legend>
              <div className="grid grid-cols-3 gap-2">
                {scopeOptions.map((option) => {
                  const selected = requestForm.scope === option.value;
                  return (
                    <label
                      key={option.value}
                      className={
                        selected
                          ? "rounded-xl border border-indigo-400/45 bg-indigo-500/20 px-2 py-3 text-left text-indigo-100"
                          : "rounded-xl border border-slate-700 bg-slate-950/55 px-2 py-3 text-left text-slate-400 transition hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100"
                      }
                    >
                      <input
                        type="radio"
                        name="request-scope"
                        value={option.value}
                        checked={selected}
                        onChange={() =>
                          setRequestForm({
                            ...requestForm,
                            scope: option.value,
                          })
                        }
                        className="sr-only"
                      />
                      <span className="block text-sm font-bold">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-xs text-current opacity-70">
                        {option.description}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <Button
              type="button"
              disabled={
                !newRequestFor ||
                busy === `add-${newRequestFor}` ||
                !requestForm.name.trim()
              }
              onClick={() => void addRequest()}
            >
              {newRequestFor && busy === `add-${newRequestFor}` && (
                <Loader2 className="animate-spin" />
              )}
              Add request
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!archiveTarget}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
      >
        <DialogContent className="border-slate-700 bg-slate-900 text-slate-100">
          <DialogHeader>
            <DialogTitle>Archive {archiveTarget?.name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-400">
            This permanently deletes every staging and deliverables folder for
            this completed case. Metrics remain in the archived database record.
          </p>
          <Button
            type="button"
            variant="destructive"
            onClick={async () => {
              if (
                archiveTarget &&
                (await call(
                  `archive-${archiveTarget.id}`,
                  `/api/cases/${archiveTarget.id}/archive`,
                  { method: "POST" },
                ))
              )
                setArchiveTarget(null);
            }}
          >
            Archive and wipe folders
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="border-slate-700 bg-slate-900 text-slate-100">
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-rose-200">
            This irreversible action deletes all case folders and every related
            database entry.
          </p>
          {deleteTarget?.requests.some((request) =>
            ["queued", "running", "stopping"].includes(request.status),
          ) && (
            <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 p-3 text-sm text-amber-100">
              <p className="font-semibold">This case is still processing.</p>
              <p className="mt-1 text-amber-100/75">
                Stop all workers and any live AI batch before deletion can be
                confirmed.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-3 border-amber-400/40 text-amber-100 hover:bg-amber-500/15"
                disabled={busy === `stop-${deleteTarget.id}`}
                onClick={() => void stopBeforeDelete()}
              >
                {busy === `stop-${deleteTarget.id}` && (
                  <Loader2 className="animate-spin" />
                )}
                Stop all work
              </Button>
            </div>
          )}
          <div className="mt-4 grid gap-3 border-t border-rose-500/20 pt-4">
            <input
              className="rounded-xl border border-rose-500/60 bg-slate-950/80 px-3 py-2.5 outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-400/30"
              placeholder={`Type ${deleteTarget?.name || "case name"}`}
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
            />
            <Button
              type="button"
              variant="destructive"
              className="w-full"
              disabled={
                !deleteTarget ||
                busy === `delete-${deleteTarget.id}` ||
                deleteConfirmation !== deleteTarget.name ||
                deleteTarget.requests.some((request) =>
                  ["queued", "running", "stopping"].includes(request.status),
                )
              }
              onClick={async () => {
                if (
                  deleteTarget &&
                  (await call(
                    `delete-${deleteTarget.id}`,
                    `/api/cases/${deleteTarget.id}`,
                    {
                      method: "DELETE",
                      body: JSON.stringify({
                        confirmation: deleteConfirmation,
                      }),
                    },
                  ))
                )
                  setDeleteTarget(null);
              }}
            >
              {deleteTarget && busy === `delete-${deleteTarget.id}` && (
                <Loader2 className="animate-spin" />
              )}
              Delete permanently
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <SystemSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      <Dialog
        open={!!statisticsTarget}
        onOpenChange={(open) => {
          if (!open) {
            setStatisticsTarget(null);
            setStatisticsRequest(null);
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto border-slate-700 bg-[#1a2742] text-slate-100 sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {statisticsRequest ? "Request statistics" : "Case statistics"} —{" "}
              {statisticsTarget &&
                (privacyMode
                  ? maskCaseName(statisticsTarget.name)
                  : statisticsTarget.name)}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            {(statisticsRequest
              ? [statisticsRequest]
              : [aggregateCaseRequests(statisticsTarget?.requests || [])]
            ).map((request) => (
              <section
                key={request.id}
                className="rounded-2xl bg-[#1a2742] p-2"
              >
                <div className="flex justify-between">
                  <strong>{request.name}</strong>
                  <span className="capitalize text-slate-400">
                    {request.status}
                  </span>
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-3xl bg-slate-950/45 p-5 text-center">
                    <p className="text-xs font-bold tracking-wider text-slate-500">
                      TOTAL SOURCE SIZE
                    </p>
                    <strong className="mt-3 block text-2xl">
                      {formatBytes(
                        request.pst_size_bytes + request.files_size_bytes,
                      )}
                    </strong>
                  </div>
                  <div className="rounded-3xl bg-slate-950/45 p-5 text-center">
                    <p className="text-xs font-bold tracking-wider text-slate-500">
                      DELIVERABLE SIZE
                    </p>
                    <strong className="mt-3 block text-2xl">
                      {formatBytes(request.deliverable_size_bytes)}
                    </strong>
                  </div>
                </div>
                <dl className="mt-5 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                  <div className="rounded-2xl bg-slate-950/45 p-4">
                    <dt className="text-slate-500">PST sources</dt>
                    <dd className="mt-2 text-lg">{request.pst_count}</dd>
                  </div>
                  <div className="rounded-2xl bg-slate-950/45 p-4">
                    <dt className="text-slate-500">Files sources</dt>
                    <dd className="mt-2 text-lg">{request.files_count}</dd>
                  </div>
                  <div className="rounded-2xl bg-slate-950/45 p-4">
                    <dt className="text-slate-500">Emails</dt>
                    <dd className="mt-2 text-lg">{request.total_emails}</dd>
                  </div>
                  <div className="rounded-2xl bg-slate-950/45 p-4">
                    <dt className="text-slate-500">Exported</dt>
                    <dd className="mt-2 text-lg text-indigo-200">
                      {request.emails_exported}
                    </dd>
                  </div>
                </dl>
                <div className="mt-5 rounded-3xl bg-slate-950/45 p-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-xs font-bold tracking-wider text-slate-500">
                      ENGINE TELEMETRY · EXECUTION TIME
                    </p>
                    <span className="text-sm text-indigo-200">
                      Cumulative work{" "}
                      {formatDuration(
                        Object.values(request.phaseTiming || {}).reduce(
                          (sum, duration) => sum + duration,
                          0,
                        ),
                      )}
                    </span>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
                    {(
                      [
                        ["Parse", request.phaseTiming?.parse || 0],
                        ["Extract", request.phaseTiming?.extract || 0],
                        ["AI audit", request.phaseTiming?.ai || 0],
                        ["Render", request.phaseTiming?.render || 0],
                        ["Files", request.phaseTiming?.files || 0],
                      ] as const
                    ).map(([phase, duration]) => (
                      <div
                        key={phase}
                        className="rounded-2xl border border-indigo-400/15 bg-slate-900/65 p-4 text-center"
                      >
                        <dt className="text-xs text-slate-500">{phase}</dt>
                        <dd className="mt-2 font-mono text-base text-slate-100">
                          {formatDuration(duration)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
