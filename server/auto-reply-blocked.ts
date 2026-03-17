/**
 * 統一記錄「自動回覆被擋下」的原因，供除錯與報表使用。
 * 原因代碼：blocked:test_mode | no_channel_match | channel_ai_disabled | no_channel_token | no_channel_secret | no_page_settings | worker_unavailable
 */
import type { IStorage } from "./storage";

export type AutoReplyBlockedReason =
  | "blocked:test_mode"
  | "blocked:no_channel_match"
  | "blocked:channel_ai_disabled"
  | "blocked:no_channel_token"
  | "blocked:no_channel_secret"
  | "blocked:no_page_settings"
  | "blocked:worker_unavailable";

export interface RecordAutoReplyBlockedOptions {
  reason: AutoReplyBlockedReason;
  contactId?: number;
  platform?: string;
  channelId?: number;
  brandId?: number;
  /** 原始訊息摘要（可截短，避免過長） */
  messageSummary?: string;
  /** Meta 留言 ID（與 page_id 一併寫入 details） */
  commentId?: number;
  pageId?: string;
}

const MAX_SUMMARY_LEN = 120;

export function recordAutoReplyBlocked(storage: IStorage, opts: RecordAutoReplyBlockedOptions): void {
  const summary =
    opts.messageSummary != null
      ? opts.messageSummary.slice(0, MAX_SUMMARY_LEN) + (opts.messageSummary.length > MAX_SUMMARY_LEN ? "…" : "")
      : "";
  const parts = [
    opts.reason,
    opts.contactId != null ? `contact_id=${opts.contactId}` : "",
    opts.commentId != null ? `comment_id=${opts.commentId}` : "",
    opts.pageId ? `page_id=${opts.pageId}` : "",
    opts.platform ? `platform=${opts.platform}` : "",
    opts.channelId != null ? `channel_id=${opts.channelId}` : "",
    opts.brandId != null ? `brand_id=${opts.brandId}` : "",
    summary ? `message_summary=${summary}` : "",
  ].filter(Boolean);
  const details = parts.join(" ");
  storage.createSystemAlert({
    alert_type: "auto_reply_blocked",
    details,
    brand_id: opts.brandId,
    contact_id: opts.contactId,
  });
}
