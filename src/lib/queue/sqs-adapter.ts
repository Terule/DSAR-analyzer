import { randomUUID } from "node:crypto";
import type {
  QueueEnqueueRequest,
  QueueEnqueueResult,
} from "@/lib/control-plane/types";
import type { OrchestratorQueueAdapter, QueueHealth } from "@/lib/queue/types";

// Placeholder cloud adapter for upcoming ECS/SQS wiring.
// Kept explicit so provider selection is compile-safe now.
export class SqsQueueAdapter implements OrchestratorQueueAdapter {
  public readonly provider = "sqs";

  public async enqueue(
    input: QueueEnqueueRequest,
  ): Promise<QueueEnqueueResult> {
    const id = input.id || randomUUID();
    throw new Error(
      `SQS adapter is not wired yet (attempted enqueue id=${id}).`,
    );
  }

  public async health(): Promise<QueueHealth> {
    return {
      provider: this.provider,
      ok: false,
      details: {
        message: "SQS adapter is scaffolded but not wired yet.",
      },
    };
  }

  public async close(): Promise<void> {
    // No-op until SDK integration lands.
  }
}
