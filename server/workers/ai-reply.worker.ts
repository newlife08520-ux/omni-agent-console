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
 * 正式環境（Phase 106.24 起）：預設改由主站 in-process 消費佇列，本進程僅在停用 in-process
 * 或除錯時使用。Railway 可停用獨立 worker service。
 *
 * 正式環境部署（僅獨立 worker 模式）：
 *   只跑一份 worker instance，concurrency=5，加 BullMQ limiter 雙重保險。
 *   若需擴展，增加 instance 數量，總並發 = instance 數 × concurrency。
 *   但因 Redis lock per-contact，同一 contact 不會並行。
 */
import os from "os";
import { storage } from "../storage";
import {
  startAiReplyWorker,
  getWorkerRedis,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_S,
} from "../queue/ai-reply.queue";
import { executeAiReplyQueueJob, logStandaloneWorkerDbDiagnostics, type RunAiReplyPayload } from "./ai-reply-worker-shared";

const INTERNAL_API_URL = (process.env.INTERNAL_API_URL || "http://localhost:8080").replace(/\/$/, "");
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

async function callInternalRunAiReply(payload: RunAiReplyPayload): Promise<void> {
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

  /** Phase 106.26：與 in-process loopback 一致，防 SPA / 代理回 HTML 卻 200 */
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const body = await res.text().catch(() => "");
    throw new Error(`internal/run-ai-reply non-JSON (content-type=${contentType}): ${body.slice(0, 200)}`);
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

  logStandaloneWorkerDbDiagnostics();

  startAiReplyWorker((job) => executeAiReplyQueueJob(job, callInternalRunAiReply));

  const redis = getWorkerRedis();
  if (redis) {
    const writeHeartbeat = () => {
      const payload = JSON.stringify({
        worker_id: `pid:${process.pid}`,
        timestamp: Date.now(),
        pid: process.pid,
        hostname: os.hostname(),
      });
      redis.set(WORKER_HEARTBEAT_KEY, payload, "EX", WORKER_HEARTBEAT_TTL_S).catch((err) =>
        console.error("[Worker] heartbeat write failed:", err?.message)
      );
    };
    writeHeartbeat();
    setInterval(writeHeartbeat, 30_000);
  }

  console.log("[Worker] ai-reply worker running.");
  console.log("[Worker] INTERNAL_API_URL:", INTERNAL_API_URL);
  console.log("[Worker] Concurrency: 5, Limiter: max 5 per 1000ms");
}

main();
