/**
 * LINE Webhook 基礎冪等：短時間內同一 inbound event id 只處理一次。
 * - 有 REDIS_URL：SET key NX EX 600
 * - 無則 in-memory Map（10 分鐘過期），輔以 storage.processed_events 持久去重
 */

const SHORT_TTL_MS = 10 * 60 * 1000;
const memClaims = new Map<string, number>();

function pruneMem(now: number): void {
  for (const [k, exp] of memClaims) {
    if (exp <= now) memClaims.delete(k);
  }
}

function tryMemClaim(key: string): boolean {
  const now = Date.now();
  pruneMem(now);
  const exp = memClaims.get(key);
  if (exp != null && exp > now) return false;
  memClaims.set(key, now + SHORT_TTL_MS);
  return true;
}

/** @returns true 表示本輪可繼續處理；false 表示應跳過（重複） */
export async function acquireLineWebhookEvent(eventId: string): Promise<boolean> {
  const key = `line:webhook:${eventId}`;
  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    try {
      const Redis = (await import("ioredis")).default;
      const conn = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
      const ok = await conn.set(`idempotency:${key}`, "1", "EX", 600, "NX");
      await conn.quit().catch(() => {});
      if (ok !== "OK") return false;
      tryMemClaim(key);
      return true;
    } catch {
      /* Redis 不可用時改純記憶體 */
    }
  }
  return tryMemClaim(key);
}
