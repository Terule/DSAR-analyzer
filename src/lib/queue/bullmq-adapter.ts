import { randomUUID } from "node:crypto";
import type { JobsOptions } from "bullmq";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import type {
  QueueEnqueueRequest,
  QueueEnqueueResult,
} from "@/lib/control-plane/types";
import type { OrchestratorQueueAdapter, QueueHealth } from "@/lib/queue/types";

function getQueueName(): string {
  return process.env.ORCHESTRATOR_QUEUE_NAME || "pst-analyser-orchestrator";
}

function getRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for BullMQ provider.");
  return url;
}

export class BullmqQueueAdapter implements OrchestratorQueueAdapter {
  public readonly provider = "bullmq";

  private readonly connection = new IORedis(getRedisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  private readonly queue = new Queue(getQueueName(), {
    connection: this.connection,
  });

  public async enqueue(
    input: QueueEnqueueRequest,
  ): Promise<QueueEnqueueResult> {
    const id = input.id || randomUUID();
    const options: JobsOptions = {
      jobId: id,
      removeOnComplete: 2000,
      removeOnFail: 2000,
      attempts: input.maxAttempts ?? 5,
      priority: input.priority ?? 100,
    };

    await this.queue.add(
      input.phase,
      {
        id,
        phase: input.phase,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
      },
      options,
    );

    return {
      id,
      provider: this.provider,
    };
  }

  public async health(): Promise<QueueHealth> {
    const counts = await this.queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
    );

    return {
      provider: this.provider,
      ok: true,
      details: counts,
    };
  }

  public async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
