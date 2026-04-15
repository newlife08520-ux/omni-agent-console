/**
 * AI Reply BullMQ job 執行邏輯（獨立 worker 與主站 in-process 共用）。
 * 不含 HTTP server；呼叫端注入 run-ai-reply（遠端 fetch 或本機 loopback）。
 */
import type { Job } from "bullmq";
import db, { getDbPath } from "../db";
import { storage } from "../storage";
import type { AiReplyJobData } from "../queue/ai-reply.queue";
import {
  getWorkerRedis,
  consumePendingMessages,
  rescheduleIfPending,
  acquireLock,
  releaseLock,
} from "../queue/ai-reply.queue";

export type RunAiReplyPayload = {
  contactId: number;
  message: string;
  channelToken?: string | null;
  matchedBrandId?: number;
  platform?: string;
  enqueueTimestampMs?: number;
};

/** 主站 in-process：Phase 106.23 診斷四行改為 [Server] 前綴（外加 enabled 由 index 印） */
export function logInProcessWorkerDbDiagnostics(): void {
  const dbPath = getDbPath();
  const contactCount = (db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n;
  const channelCount = (db.prepare("SELECT COUNT(*) AS n FROM channels").get() as { n: number }).n;
  const journalMode = db.pragma("journal_mode", { simple: true });
  console.log(`[Server] DB path resolved to: ${dbPath}`);
  console.log(`[Server] worker DB contact count: ${contactCount}`);
  console.log(`[Server] worker DB channel count: ${channelCount}`);
  console.log(`[Server] worker DB journal_mode: ${journalMode}`);
}

/** 獨立 worker 進程仍印 [Worker] 四行，供手動跑 dist/workers 時對照 */
export function logStandaloneWorkerDbDiagnostics(): void {
  const dbPath = getDbPath();
  const contactCount = (db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n;
  const channelCount = (db.prepare("SELECT COUNT(*) AS n FROM channels").get() as { n: number }).n;
  const journalMode = db.pragma("journal_mode", { simple: true });
  console.log(`[Worker] DB path resolved to: ${dbPath}`);
  console.log(`[Worker] DB contact count: ${contactCount}`);
  console.log(`[Worker] DB channel count: ${channelCount}`);
  console.log(`[Worker] DB journal_mode: ${journalMode}`);
}

export async function executeAiReplyQueueJob(
  job: Job<AiReplyJobData>,
  callRunAiReply: (payload: RunAiReplyPayload) => Promise<void>
): Promise<void> {
  const redis = getWorkerRedis();
  if (!redis) throw new Error("Worker Redis connection not available");

  const platform = job.data.platform || "line";
  const contactId = job.data.contactId;

  const pending = await consumePendingMessages(redis, platform, contactId);
  if (!pending || !pending.mergedText.trim()) {
    console.log("[Worker] no pending messages for", platform, contactId);
    return;
  }

  const { mergedText, eventIds, deliveryKey } = pending;
  console.log(
    "[Worker] processing:",
    deliveryKey,
    "platform:",
    platform,
    "contact:",
    contactId,
    "events:",
    eventIds.length,
    "text length:",
    mergedText.length
  );

  if (storage.isAiReplyDeliverySent(deliveryKey)) {
    console.log("[Worker] already sent, skip:", deliveryKey);
    return;
  }

  const acquired = await acquireLock(redis, platform, contactId);
  if (!acquired) {
    throw new Error(`lock not acquired for ${platform}:${contactId}, will retry`);
  }

  try {
    if (storage.isAiReplyDeliverySent(deliveryKey)) {
      console.log("[Worker] already sent (post-lock check), skip:", deliveryKey);
      return;
    }

    storage.createAiReplyDeliveryIfMissing(deliveryKey, platform, contactId, eventIds, mergedText);

    try {
      const enq = job.data.enqueuedAtMs ?? (job.timestamp as number);
      await callRunAiReply({
        contactId,
        message: mergedText,
        channelToken: job.data.channelToken ?? undefined,
        matchedBrandId: job.data.matchedBrandId,
        platform,
        enqueueTimestampMs: typeof enq === "number" ? enq : undefined,
      });
      storage.markAiReplyDeliverySent(deliveryKey);
      console.log("[Worker] sent:", deliveryKey);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      storage.markAiReplyDeliveryFailed(deliveryKey, msg);
      throw err;
    }
  } finally {
    await releaseLock(redis, platform, contactId);
    await rescheduleIfPending(redis, platform, contactId);
  }
}
