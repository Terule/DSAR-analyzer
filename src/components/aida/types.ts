import type { RequestStats } from "@/lib/request-stats";

export type Scope = "mail" | "files" | "both";
export type PhaseState = {
  done: number;
  total: number;
  status: string;
  ai?: { done: number; total: number };
  /** True while attachments (and client bodies) are screened before Render. */
  screening?: boolean;
};
export type PhaseTiming = {
  parse: number;
  extract: number;
  ai: number;
  render: number;
  files: number;
};
export type RequestItem = {
  id: string;
  name: string;
  scope: Scope;
  wave: number;
  wave_scope?: Scope | null;
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
    | "parse"
    | "extract"
    | "ai"
    | "render"
    | "files"
    | "filesAi"
    | "upload"
    | "uploadEmails"
    | "uploadFiles",
    PhaseState
  >;
  phaseTiming?: PhaseTiming;
  stats?: RequestStats;
  files_exported?: number;
  /** Rows with a failed step; when present, Retry replaces Run. */
  retryTargets?: string[];
};
export type CaseItem = {
  id: string;
  name: string;
  subject_name: string;
  subject_email: string;
  subject_personal_email?: string | null;
  subject_aliases?: string | null;
  matter_numbers?: string | null;
  updated_at?: string;
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

export type PhaseKey = keyof NonNullable<RequestItem["phaseProgress"]>;
