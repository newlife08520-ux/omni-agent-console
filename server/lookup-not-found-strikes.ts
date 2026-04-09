/**
 * Phase 106.11：查單查無計次（記憶體、5 分鐘滑動窗），不變更 contacts schema。
 * 查單成功時由 tool-executor 呼叫 clearLookupNotFoundStrikes。
 */

const WINDOW_MS = 5 * 60 * 1000;

type Entry = { strikes: number; windowStart: number };

const map = new Map<number, Entry>();

export function clearLookupNotFoundStrikes(contactId: number): void {
  map.delete(contactId);
}

/** 目前時間窗內已累積幾次「查無訂單」（不含尚未 bump 的本次） */
export function getLookupNotFoundStrikesInWindow(contactId: number): number {
  const e = map.get(contactId);
  const now = Date.now();
  if (!e || now - e.windowStart > WINDOW_MS) return 0;
  return e.strikes;
}

/** 記錄一次查無（第一次 miss 後 strikes=1） */
export function bumpLookupNotFoundStrike(contactId: number): void {
  const now = Date.now();
  let e = map.get(contactId);
  if (!e || now - e.windowStart > WINDOW_MS) {
    map.set(contactId, { strikes: 1, windowStart: now });
  } else {
    e.strikes += 1;
    map.set(contactId, e);
  }
}
