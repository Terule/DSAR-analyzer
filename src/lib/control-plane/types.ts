export type ControlPhase = "parse" | "extract" | "ai" | "render" | "files";

export type ControlJobStatus =
  | "queued"
  | "leased"
  | "running"
  | "awaiting_external"
  | "completed"
  | "failed"
  | "cancelled"
  | "dead_letter";

export interface ControlJobPayload {
  fileId?: string;
  caseKey: string;
  requestKey?: string;
  phase: ControlPhase;
  inputPath?: string;
  outputPath?: string;
  metadata?: Record<string, unknown>;
}

export interface ControlJobRecord {
  id: string;
  phase: ControlPhase;
  status: ControlJobStatus;
  dedupeKey: string;
  payload: ControlJobPayload;
  priority: number;
  maxAttempts: number;
  availableAt: string;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueEnqueueRequest {
  id?: string;
  phase: ControlPhase;
  dedupeKey: string;
  payload: ControlJobPayload;
  priority?: number;
  maxAttempts?: number;
}

export interface QueueEnqueueResult {
  id: string;
  provider: string;
}
