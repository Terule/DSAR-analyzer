import type {
  QueueEnqueueRequest,
  QueueEnqueueResult,
} from "@/lib/control-plane/types";

export interface QueueHealth {
  provider: string;
  ok: boolean;
  details?: Record<string, unknown>;
}

export interface OrchestratorQueueAdapter {
  readonly provider: string;
  enqueue(input: QueueEnqueueRequest): Promise<QueueEnqueueResult>;
  health(): Promise<QueueHealth>;
  close(): Promise<void>;
}
