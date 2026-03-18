/**
 * AI Reply Queue (BullMQ)
 *
 * 設計：
 * 1. Webhook 只做 enqueue（LPUSH 到 Redis + 排程 delayed job）後立即回 200。
 * 2. Redis debounce：同 contact 短時間多則合併為一筆 delayed job（固定 jobId）。
 * 3. 固定 jobId = ai-reply:{platform}:{contactId}，同 contact 同一時刻只有一筆 queue job。
 * 4. per-contact 串行：Redis lock（NX + PX），Worker 處理前取得、處理完釋放。
 * 5. 冪等：以 batch delivery_key（sha1 of sorted event ids）追蹤已送出批次。
 * 6. 全域並發控制：使用 BullMQ RateLimiter 限制同時 active jobs。
 *
 * Redis Key 設計：
 *   ai-reply:pending:{platform}:{contactId}   — List，尚未被 worker claim 的合併訊息
 *   lock:ai-reply:{platform}:{contactId}       — SET NX PX，per-contact 串行 lock
 */
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import crypto from "crypto";

const QUEUE_NAME = "ai-reply";
const REDIS_URL = process.env.REDIS_URL?.trim() || "redis://localhost:6379";
const DEBOUNCE_MS = 1200;
const LOCK_TTL_MS = 120_000;
const LOCK_KEY_PREFIX = "lock:ai-reply:";
const PENDING_KEY_PREFIX = "ai-reply:pending:";
/** Worker 心跳 key，供 /api/debug/runtime 判斷 worker 是否活著 */
export const WORKER_HEARTBEAT_KEY = "omni:worker:heartbeat";
export const WORKER_HEARTBEAT_TTL_S = 60;
const PENDING_KEY_TTL_S = 300;
const MAX_PENDING_ITEMS = 50;

/**
 * 全域最大同時 active jobs。
 * 正式環境只部署一份 worker（concurrency=5），加上 BullMQ limiter 雙重保險。
 */
export const AI_REPLY_CONCURRENCY = 5;

export interface AiReplyJobData {
  contactId: number;
  channelToken: string | null;
  matchedBrandId?: number;
  platform?: string;
  /** worker 計算 queue_wait_ms */
  enqueuedAtMs?: number;
}

export interface DebouncedMessage {
  text: string;
  eventId: string;
}

function getProducerConnection(): IORedis {
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
}

function getWorkerConnection(): IORedis {
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
}

let queue: Queue<AiReplyJobData> | null = null;
let producerConn: IORedis | null = null;

export function getAiReplyQueue(): Queue<AiReplyJobData> {
  if (!queue) {
    producerConn = getProducerConnection();
    queue = new Queue<AiReplyJobData>(QUEUE_NAME, {
      connection: producerConn as import("bullmq").ConnectionOptions,
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
      },
    }) as Queue<AiReplyJobData>;
  }
  return queue;
}

function pendingKey(platform: string, contactId: number): string {
  return `${PENDING_KEY_PREFIX}${platform}:${contactId}`;
}

function lockKey(platform: string, contactId: number): string {
  return `${LOCK_KEY_PREFIX}${platform}:${contactId}`;
}

function jobId(platform: string, contactId: number): string {
  return `ai-reply:${platform}:${contactId}`;
}

/** 產生 batch delivery key：sha1(platform:contactId:sortedEventIds) */
export function computeDeliveryKey(platform: string, contactId: number, eventIds: string[]): string {
  const sorted = [...eventIds].sort();
  const raw = `${platform}:${contactId}:${sorted.join(",")}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

/** 逾此秒數視為 worker 已死，enqueue 時可記錄 blocked:worker_unavailable */
export const WORKER_HEARTBEAT_DEAD_THRESHOLD_S = 90;

/**
 * 查詢 worker heartbeat 狀態（供 enqueue 前判斷是否記錄 blocked:worker_unavailable）。
 * 若未啟用 Redis 或無法讀取則回傳 null。
 */
export async function getWorkerHeartbeatStatus(): Promise<{ alive: boolean; ageSec: number | null } | null> {
  if (!process.env.REDIS_URL?.trim()) return null;
  try {
    const { getRedisClient } = await import("../redis-client");
    const redis = getRedisClient();
    const raw = redis ? await redis.get(WORKER_HEARTBEAT_KEY) : null;
    if (!raw) {
      if (!redis) {
        const conn = getProducerConnection();
        const fallbackRaw = await conn.get(WORKER_HEARTBEAT_KEY);
        if (!fallbackRaw) return { alive: false, ageSec: null };
        return parseHeartbeatRaw(fallbackRaw);
      }
      return { alive: false, ageSec: null };
    }
    return parseHeartbeatRaw(raw);
  } catch {
    return { alive: false, ageSec: null };
  }
}

function parseHeartbeatRaw(raw: string): { alive: boolean; ageSec: number | null } {
  try {
    const data = JSON.parse(raw) as { timestamp?: number };
    const ts = data?.timestamp;
    if (typeof ts !== "number") return { alive: false, ageSec: null };
    const ageSec = Math.round((Date.now() - ts) / 1000);
    const alive = ageSec <= WORKER_HEARTBEAT_DEAD_THRESHOLD_S;
    return { alive, ageSec };
  } catch {
    return { alive: false, ageSec: null };
  }
}

/**
 * 取得 BullMQ queue 計數（供 /api/debug/runtime）。
 * 若未啟用 Redis 或 queue 未初始化則回傳 null。
 */
export async function getQueueJobCounts(): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
} | null> {
  if (!process.env.REDIS_URL?.trim()) return null;
  try {
    const q = getAiReplyQueue();
    const counts = await q.getJobCounts("wait", "active", "delayed", "failed");
    const c = counts as Record<string, number | undefined>;
    return {
      waiting: c.wait ?? c.waiting ?? 0,
      active: c.active ?? 0,
      delayed: c.delayed ?? 0,
      failed: c.failed ?? 0,
    };
  } catch {
    return null;
  }
}

// ─── Producer API ───────────────────────────────────────────

/**
 * Redis debounce + 單 contact 單 job。
 *
 * 每則新訊息：
 *   1. LPUSH { text, eventId } 到 ai-reply:pending:{platform}:{contactId}
 *   2. 設定 TTL 防止永遠殘留
 *   3. 嘗試 remove 現有 delayed job，再 add 新的 delayed job（refresh delay）
 *      - 若 job 是 active：不做 remove，新訊息留在 pending list，
 *        active job 完成後 worker 會再檢查 pending list 並排新 job。
 *      - 若 job 是 waiting：保留原 job，worker 處理時會讀到最新 pending。
 */
export async function enqueueDebouncedAiReply(
  platform: string,
  contactId: number,
  message: string,
  inboundEventId: string,
  channelToken: string | null,
  matchedBrandId?: number
): Promise<void> {
  const redis = getProducerConnection();
  const key = pendingKey(platform, contactId);
  const payload = JSON.stringify({ text: message, eventId: inboundEventId } as DebouncedMessage);

  await redis.lpush(key, payload);
  await redis.ltrim(key, 0, MAX_PENDING_ITEMS - 1);
  await redis.expire(key, PENDING_KEY_TTL_S);

  const q = getAiReplyQueue();
  const jid = jobId(platform, contactId);

  try {
    const existing = await q.getJob(jid);
    if (existing) {
      const state = await existing.getState();
      if (state === "delayed") {
        await existing.remove();
      } else if (state === "active") {
        console.log("[Queue] job active, new message buffered in pending:", jid);
        return;
      } else if (state === "waiting") {
        console.log("[Queue] job waiting, pending updated:", jid);
        return;
      }
    }
  } catch (_e) { /* job may not exist */ }

  await q.add("reply", { contactId, channelToken, matchedBrandId, platform }, { jobId: jid, delay: DEBOUNCE_MS });
  console.log("[Queue] debounced job scheduled:", jid);
}

/** 舊版相容 API（無 debounce），僅供 fallback 使用 */
export async function addAiReplyJob(data: {
  contactId: number;
  message: string;
  channelToken: string | null;
  matchedBrandId?: number;
  platform?: string;
}): Promise<Job<AiReplyJobData> | null> {
  try {
    const q = getAiReplyQueue();
    const job = await q.add("reply", {
      contactId: data.contactId,
      channelToken: data.channelToken,
      matchedBrandId: data.matchedBrandId,
      platform: data.platform,
      enqueuedAtMs: Date.now(),
    }, {
      jobId: `${data.contactId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    });
    return job;
  } catch (err) {
    console.error("[Queue] addAiReplyJob failed:", err);
    return null;
  }
}

// ─── Worker API ─────────────────────────────────────────────

export type AiReplyJobProcessor = (job: Job<AiReplyJobData>) => Promise<void>;

let worker: Worker<AiReplyJobData> | null = null;
let workerConn: IORedis | null = null;

/**
 * 啟動 Worker。
 * 僅由獨立 worker 進程呼叫（server/workers/ai-reply.worker.ts），API 進程只 enqueue。
 * 全域並發由 concurrency + limiter 雙重控制。
 */
export function startAiReplyWorker(processor: AiReplyJobProcessor): Worker<AiReplyJobData> {
  if (worker) return worker;
  workerConn = getWorkerConnection();
  worker = new Worker<AiReplyJobData>(
    QUEUE_NAME,
    async (job) => await processor(job),
    {
      connection: workerConn as import("bullmq").ConnectionOptions,
      concurrency: AI_REPLY_CONCURRENCY,
      limiter: { max: AI_REPLY_CONCURRENCY, duration: 1000 },
    }
  );
  worker.on("completed", (job) => console.log("[Worker] completed:", job.id));
  worker.on("failed", (job, err) => console.error("[Worker] failed:", job?.id, err?.message));
  worker.on("error", (err) => console.error("[Worker] error:", err));
  console.log("[Worker] started, concurrency:", AI_REPLY_CONCURRENCY);
  return worker;
}

export function getWorkerRedis(): IORedis | null {
  return workerConn;
}

/**
 * Worker 內：原子讀取 + 清空 pending list。
 * 回傳合併後的文字、所有 eventIds、以及 delivery key。
 */
export async function consumePendingMessages(
  redis: IORedis,
  platform: string,
  contactId: number
): Promise<{ mergedText: string; eventIds: string[]; deliveryKey: string } | null> {
  const key = pendingKey(platform, contactId);
  const items = await redis.lrange(key, 0, -1);
  await redis.del(key);
  if (!items.length) return null;

  const parsed: DebouncedMessage[] = items.map((s) => {
    try { return JSON.parse(s) as DebouncedMessage; }
    catch { return { text: s, eventId: "" }; }
  });

  const eventIds = [...new Set(parsed.map(p => p.eventId).filter(Boolean))];
  const mergedText = parsed.map(p => p.text).join("\n");
  const deliveryKey = computeDeliveryKey(platform, contactId, eventIds);
  return { mergedText, eventIds, deliveryKey };
}

/**
 * Worker 完成後：檢查 pending list 是否又有新訊息（active 期間進來的），有的話排一筆新 job。
 */
export async function rescheduleIfPending(
  redis: IORedis,
  platform: string,
  contactId: number
): Promise<void> {
  const key = pendingKey(platform, contactId);
  const len = await redis.llen(key);
  if (len > 0) {
    const q = getAiReplyQueue();
    const jid = jobId(platform, contactId);
    try {
      await q.add("reply", { contactId, channelToken: null, platform }, { jobId: jid, delay: DEBOUNCE_MS });
      console.log("[Worker] rescheduled pending job:", jid, "items:", len);
    } catch (_e) { /* jobId may already exist */ }
  }
}

export async function acquireLock(redis: IORedis, platform: string, contactId: number): Promise<boolean> {
  const result = await redis.set(lockKey(platform, contactId), "1", "PX", LOCK_TTL_MS, "NX");
  return result === "OK";
}

export async function releaseLock(redis: IORedis, platform: string, contactId: number): Promise<void> {
  await redis.del(lockKey(platform, contactId));
}

export async function closeAiReplyQueue(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (workerConn) { await workerConn.quit(); workerConn = null; }
  if (queue) { await queue.close(); queue = null; }
  if (producerConn) { await producerConn.quit(); producerConn = null; }
}
