/**
 * AI Reply Worker — 獨立進程
 *
 * 只消費 ai-reply 佇列，不啟動 HTTP server。
 * 流程：claim pending → acquire lock → idempotency check → call internal API → record → release lock → reschedule
 *
 * 環境變數：
 *   REDIS_URL              — 必填
 *   INTERNAL_API_URL       — 預設 http://localhost:8080
 *   INTERNAL_API_SECRET    — 必填，與 API server 一致
 *
 * 正式環境部署：
 *   只跑一份 worker instance，concurrency=5，加 BullMQ limiter 雙重保險。
 *   若需擴展，增加 instance 數量，總並發 = instance 數 × concurrency。
 *   但因 Redis lock per-contact，同一 contact 不會並行。
 */
import os from "os";
import { storage } from "../storage";
import {
  startAiReplyWorker,
  getWorkerRedis,
  consumePendingMessages,
  rescheduleIfPending,
  acquireLock,
  releaseLock,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_S,
} from "../queue/ai-reply.queue";

const INTERNAL_API_URL = (process.env.INTERNAL_API_URL || "http://localhost:8080").replace(/\/$/, "");
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

async function callInternalRunAiReply(payload: {
  contactId: number;
  message: string;
  channelToken?: string | null;
  matchedBrandId?: number;
  platform?: string;
  enqueueTimestampMs?: number;
}): Promise<void> {
  if (!INTERNAL_API_SECRET) {
    throw new Error("INTERNAL_API_SECRET is required");
  }
  const res = await fetch(`${INTERNAL_API_URL}/internal/run-ai-reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": INTERNAL_API_SECRET },
    body: JSON.stringify(payload),
  });
  if (res.status === 504) {
    console.log(
      "[ai-reply.worker] internal API soft timeout (504) contactId=" +
        payload.contactId +
        " — fallback message already pushed by routes layer; job completes without retry"
    );
    return;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`internal/run-ai-reply ${res.status}: ${errText.slice(0, 300)}`);
  }
}

function main() {
  if (!process.env.REDIS_URL) {
    console.error("[Worker] REDIS_URL is required. Exiting.");
    process.exit(1);
  }
  if (!INTERNAL_API_SECRET) {
    console.error("[Worker] INTERNAL_API_SECRET is required. Exiting.");
    process.exit(1);
  }

  startAiReplyWorker(async (job) => {
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
    console.log("[Worker] processing:", deliveryKey, "platform:", platform, "contact:", contactId, "events:", eventIds.length, "text length:", mergedText.length);

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
        await callInternalRunAiReply({
          contactId,
          message: mergedText,
          channelToken: job.data.channelToken ?? undefined,
          matchedBrandId: job.data.matchedBrandId,
          platform,
          enqueueTimestampMs: typeof enq === "number" ? enq : undefined,
        });
        storage.markAiReplyDeliverySent(deliveryKey);
        console.log("[Worker] sent:", deliveryKey);
      } catch (err: any) {
        storage.markAiReplyDeliveryFailed(deliveryKey, err?.message || "unknown");
        throw err;
      }
    } finally {
      await releaseLock(redis, platform, contactId);
      await rescheduleIfPending(redis, platform, contactId);
    }
  });

  const redis = getWorkerRedis();
  if (redis) {
    const writeHeartbeat = () => {
      const payload = JSON.stringify({
        worker_id: `pid:${process.pid}`,
        timestamp: Date.now(),
        pid: process.pid,
        hostname: os.hostname(),
      });
      redis.set(WORKER_HEARTBEAT_KEY, payload, "EX", WORKER_HEARTBEAT_TTL_S).catch((err) => console.error("[Worker] heartbeat write failed:", err?.message));
    };
    writeHeartbeat();
    setInterval(writeHeartbeat, 30_000);
  }

  console.log("[Worker] ai-reply worker running.");
  console.log("[Worker] INTERNAL_API_URL:", INTERNAL_API_URL);
  console.log("[Worker] Concurrency: 5, Limiter: max 5 per 1000ms");
}

main();
