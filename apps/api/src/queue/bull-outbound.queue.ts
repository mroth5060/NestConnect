import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { MessageStatus } from "@ding/schemas";
import { env } from "../config/env";
import { Store } from "../data/store";
import { OutboundDeliveryService, type DeliveryJob } from "../channels/outbound-delivery.service";
import { GmailSyncService } from "../channels/google/gmail-sync.service";
import { OutlookSyncService } from "../channels/microsoft/outlook-sync.service";
import { OutboundQueue } from "./outbound-queue";

const QUEUE_NAME = "outbound";
/** Total send attempts before a message is marked permanently failed. */
const DELIVERY_ATTEMPTS = 6;
/** Base for the exponential backoff (3s, 6s, 12s, 24s, 48s). */
const BACKOFF_MS = 3000;
const SWEEP_JOB = "recover-sweep";
const GMAIL_JOB = "gmail-poll";
const OUTLOOK_JOB = "outlook-poll";
/** Mock-mode tick timings for the delivered/read ladder. */
const MOCK_DELIVERED_MS = 1400;
const MOCK_READ_MS = 3200;

type StatusData = { channelMsgId: string; status: MessageStatus };

/**
 * BullMQ-backed durable outbound queue (active when REDIS_URL is set). Jobs are
 * persisted in Redis, so they survive an API restart; transient provider failures
 * are retried with exponential backoff and only permanent failures stop early.
 * Delivery jobs carry just a pointer ({messageId, conversationId}); everything
 * needed to send is re-read from Postgres, so recovery is a simple re-enqueue.
 *
 * Also hosts the two critical background timers as repeatable jobs — a recovery
 * sweep and Gmail polling — so they run once cluster-wide instead of per node.
 */
@Injectable()
export class BullOutboundQueue
  extends OutboundQueue
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BullOutboundQueue.name);
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker?: Worker;

  constructor(
    private readonly delivery: OutboundDeliveryService,
    private readonly store: Store,
    private readonly gmail: GmailSyncService,
    private readonly outlook: OutlookSyncService,
  ) {
    super();
    // BullMQ requires maxRetriesPerRequest: null on its Redis connection.
    this.connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
  }

  async onApplicationBootstrap(): Promise<void> {
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
      // The worker uses blocking reads, so it needs its own connection.
      connection: this.connection.duplicate(),
      concurrency: 8,
    });
    this.worker.on("failed", (job, err) => void this.onFailed(job, err));
    this.worker.on("error", (err) => this.logger.error(`Worker error: ${String(err)}`));

    // Re-drive anything the previous process left in flight, then keep a periodic
    // sweep as a backstop against a lost enqueue.
    await this.recoverStuck(0);
    await this.queue.add(
      SWEEP_JOB,
      {},
      { repeat: { every: 60_000 }, jobId: SWEEP_JOB, removeOnComplete: true, removeOnFail: true },
    );

    // Gmail polling as one cluster-wide repeatable job (replaces per-node setInterval).
    if (!this.gmail.isPollingDisabled) {
      await this.queue.add(
        GMAIL_JOB,
        {},
        {
          repeat: { every: Math.max(15, env.gmail.pollSeconds) * 1000 },
          jobId: GMAIL_JOB,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log("Gmail polling scheduled as a repeatable queue job");
    }
    if (!this.outlook.isPollingDisabled) {
      await this.queue.add(
        OUTLOOK_JOB,
        {},
        {
          repeat: { every: Math.max(15, env.outlook.pollSeconds) * 1000 },
          jobId: OUTLOOK_JOB,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log("Outlook polling scheduled as a repeatable queue job");
    }
    this.logger.log("BullMQ outbound queue ready");
  }

  private async process(job: Job): Promise<void> {
    switch (job.name) {
      case "deliver": {
        const result = await this.delivery.deliver(job.data as DeliveryJob);
        if (result.state === "failed-transient") {
          // Throw so BullMQ applies the backoff and retries this job.
          throw new Error(result.error ?? "transient delivery failure");
        }
        if (result.state === "sent" && result.simulated && result.channelMsgId) {
          await this.scheduleMockLadder(result.channelMsgId);
        }
        return;
      }
      case "status": {
        const { channelMsgId, status } = job.data as StatusData;
        await this.delivery.applyStatus(channelMsgId, status);
        return;
      }
      case SWEEP_JOB:
        await this.recoverStuck(60_000);
        return;
      case GMAIL_JOB:
        await this.gmail.syncAll({ skipPushCovered: true });
        return;
      case OUTLOOK_JOB:
        await this.outlook.syncAll();
        return;
    }
  }

  /** Mock providers have no status webhooks, so fake the delivered/read ticks as
   *  durable delayed jobs (survive a restart, unlike a setTimeout). */
  private async scheduleMockLadder(channelMsgId: string): Promise<void> {
    await this.queue.add(
      "status",
      { channelMsgId, status: "delivered" },
      { delay: MOCK_DELIVERED_MS, removeOnComplete: true, removeOnFail: true },
    );
    await this.queue.add(
      "status",
      { channelMsgId, status: "read" },
      { delay: MOCK_READ_MS, removeOnComplete: true, removeOnFail: true },
    );
  }

  /** When a delivery job exhausts its retries, mark the message permanently failed. */
  private async onFailed(job: Job | undefined, err: Error): Promise<void> {
    if (!job || job.name !== "deliver") return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // more retries still pending
    const { messageId } = job.data as DeliveryJob;
    await this.delivery.markExhausted(
      messageId,
      `Delivery failed after ${job.attemptsMade} attempts: ${err.message}`,
    );
  }

  async enqueueDelivery(job: DeliveryJob, idempotencyKey?: string): Promise<void> {
    await this.queue.add("deliver", job, {
      // Idempotency: same key ⇒ same job id ⇒ duplicate enqueues collapse to one.
      jobId: idempotencyKey ?? `deliver:${job.messageId}`,
      attempts: DELIVERY_ATTEMPTS,
      backoff: { type: "exponential", delay: BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async recoverStuck(olderThanMs = 0): Promise<number> {
    const stuck = await this.store.listStuckOutbound(olderThanMs);
    for (const s of stuck) {
      await this.enqueueDelivery(
        { messageId: s.messageId, conversationId: s.conversationId },
        s.idempotencyKey,
      );
    }
    if (stuck.length) this.logger.log(`Re-enqueued ${stuck.length} in-flight message(s)`);
    return stuck.length;
  }

  async getStats(): Promise<Record<string, unknown>> {
    try {
      const counts = await this.queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
      return { mode: "bullmq", ...counts };
    } catch (err) {
      return { mode: "bullmq", error: String(err) };
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Graceful shutdown: stop taking new jobs, let active ones drain, close conns.
    await this.worker?.close();
    await this.queue.close();
    this.connection.disconnect();
  }
}
