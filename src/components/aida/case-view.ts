import type { CaseItem, PhaseKey, PhaseState, RequestItem } from "./types";

export type SegmentState = "done" | "active" | "failed" | "idle";
export type StageTone = "running" | "done" | "failed" | "waiting" | "idle";

/** The five steps shown as the pipeline bar, in order. */
export const PIPELINE_STEPS = [
  { key: "parse", label: "Read" },
  { key: "extract", label: "Prepare" },
  { key: "ai", label: "AI" },
  { key: "render", label: "PDFs" },
  { key: "files", label: "Files" },
] as const;

type StepKey = (typeof PIPELINE_STEPS)[number]["key"];

const ACTIVE = ["processing", "batch_ready", "extracting", "analyzed"];

function stateOf(state: PhaseState | undefined): SegmentState {
  if (!state) return "idle";
  if (state.status === "completed") return "done";
  if (state.status === "failed") return "failed";
  if (ACTIVE.includes(state.status)) return "active";
  return "idle";
}

/** One step can rest on several phases (Files also waits for its AI check). */
function stepState(request: RequestItem, step: StepKey): SegmentState {
  const progress = request.phaseProgress;
  if (!progress) return "idle";
  const phases: PhaseKey[] =
    step === "files" ? ["files", "filesAi"] : [step as PhaseKey];
  const states = phases.map((key) => stateOf(progress[key]));
  if (states.includes("failed")) return "failed";
  if (states.includes("active")) return "active";
  // Files with nothing to do (scope mail) must not read as unfinished work.
  if (step === "files" && request.scope === "mail") return "idle";
  if (states.every((value) => value === "done")) return "done";
  if (states.includes("done")) return "active";
  return "idle";
}

export function pipelineSegments(request: RequestItem): SegmentState[] {
  return PIPELINE_STEPS.map((step) => stepState(request, step.key));
}

const ACTIVE_LABELS: Record<StepKey, string> = {
  parse: "Reading PSTs",
  extract: "Preparing emails",
  ai: "AI review running",
  render: "Building PDFs",
  files: "Processing files",
};
const FAILED_LABELS: Record<StepKey, string> = {
  parse: "Read failed",
  extract: "Prepare failed",
  ai: "AI review failed",
  render: "PDF build failed",
  files: "Files failed",
};

export interface RequestStage {
  label: string;
  tone: StageTone;
  /** The step the label is about, when there is one. */
  step: StepKey | null;
}

export function requestStage(request: RequestItem): RequestStage {
  const segments = pipelineSegments(request);
  const failedAt = segments.indexOf("failed");
  if (failedAt >= 0) {
    const step = PIPELINE_STEPS[failedAt].key;
    return { label: FAILED_LABELS[step], tone: "failed", step };
  }
  if (request.status === "queued") {
    return { label: "Waiting for active case", tone: "waiting", step: null };
  }
  const activeAt = segments.indexOf("active");
  if (activeAt >= 0) {
    const step = PIPELINE_STEPS[activeAt].key;
    const ai = request.phaseProgress?.ai;
    const label =
      step === "ai" && ai?.screening
        ? "Screening attachments"
        : ACTIVE_LABELS[step];
    return { label, tone: "running", step };
  }
  if (request.status === "completed") {
    return { label: "Completed", tone: "done", step: null };
  }
  if (["running", "stopping"].includes(request.status)) {
    return { label: "Working", tone: "running", step: null };
  }
  if (request.status === "failed") {
    return { label: "Failed", tone: "failed", step: null };
  }
  return { label: "Ready to run", tone: "idle", step: null };
}

export function isConfigured(item: CaseItem): boolean {
  return Boolean(item.subject_name && item.subject_email);
}

/** The request a case row speaks for: a failure first, then live work. */
export function representativeRequest(item: CaseItem): RequestItem | null {
  const stages = item.requests.map((request) => ({
    request,
    stage: requestStage(request),
  }));
  return (
    stages.find((entry) => entry.stage.tone === "failed")?.request ??
    stages.find((entry) => entry.stage.tone === "running")?.request ??
    stages.find((entry) => entry.stage.tone === "waiting")?.request ??
    stages.find((entry) => entry.stage.tone === "idle")?.request ??
    stages[stages.length - 1]?.request ??
    null
  );
}

export interface CaseSummary {
  label: string;
  tone: StageTone;
  segments: SegmentState[];
  workMs: number;
}

export function caseSummary(item: CaseItem): CaseSummary {
  if (!isConfigured(item)) {
    return {
      label: "Not configured",
      tone: "idle",
      segments: PIPELINE_STEPS.map(() => "idle" as const),
      workMs: 0,
    };
  }
  const request = representativeRequest(item);
  if (!request) {
    return {
      label: "No requests yet",
      tone: "idle",
      segments: PIPELINE_STEPS.map(() => "idle" as const),
      workMs: 0,
    };
  }
  const stage = requestStage(request);
  return {
    label: stage.label,
    tone: stage.tone,
    segments: pipelineSegments(request),
    workMs: item.requests.reduce(
      (sum, entry) =>
        sum +
        Object.values(entry.phaseTiming ?? {}).reduce(
          (total, value) => total + value,
          0,
        ),
      0,
    ),
  };
}

export function caseHasFailure(item: CaseItem): boolean {
  return item.requests.some(
    (request) => requestStage(request).tone === "failed",
  );
}

export function caseInProgress(item: CaseItem): boolean {
  return item.requests.some((request) =>
    ["running", "waiting"].includes(requestStage(request).tone),
  );
}

export function caseCompleted(item: CaseItem): boolean {
  return (
    item.requests.length > 0 &&
    item.requests.every((request) => requestStage(request).tone === "done")
  );
}

export function formatClock(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3_600))}:${pad(Math.floor((seconds % 3_600) / 60))}:${pad(seconds % 60)}`;
}

export const count = (value: number) => value.toLocaleString("en-GB");

export const formatUsd = (value: number) => `US$${value.toFixed(2)}`;
