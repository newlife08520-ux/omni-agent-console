import db from "./db";
import type { MetaComment, MetaCommentTemplate, MetaPostMapping, MetaCommentRule, MetaPageSettings, MetaProductKeyword } from "@shared/schema";

export type MetaCommentStatusFilter =
  | "all"
  | "exceptions"
  | "unhandled"
  | "auto_replied"
  | "human"
  | "hidden"
  | "urgent"
  | "failed"
  | "sensitive"
  | "to_human"
  | "no_mapping"
  | "no_product"
  | "completed"
  | "overdue";

export function getMetaComments(filters: {
  brand_id?: number;
  page_id?: string;
  post_id?: string;
  status?: MetaCommentStatusFilter;
  source?: "all" | "real" | "simulated";
  /** 完成後幾分鐘內仍視為「未歸檔」而可出現在例外列表（僅 status=exceptions 時） */
  archive_delay_minutes?: number;
}): MetaComment[] {
  let sql = `
    SELECT * FROM meta_comments
    WHERE 1=1
  `;
  const params: (number | string)[] = [];
  if (filters.brand_id != null) {
    sql += ` AND brand_id = ?`;
    params.push(filters.brand_id);
  }
  if (filters.page_id) {
    sql += ` AND page_id = ?`;
    params.push(filters.page_id);
  }
  if (filters.post_id) {
    sql += ` AND post_id = ?`;
    params.push(filters.post_id);
  }
  const archiveDelayMinutes = filters.archive_delay_minutes ?? 5;
  if (filters.status && filters.status !== "all") {
    if (filters.status === "exceptions") {
      const cutoffOverdue = new Date(Date.now() - DEFAULT_REPLY_MINUTES * 60 * 1000).toISOString();
      sql += ` AND (
        (main_status = 'failed' OR main_status = 'partial_success' OR (reply_error IS NOT NULL AND reply_error != '') OR (hide_error IS NOT NULL AND hide_error != ''))
        OR (priority = 'urgent' OR ai_suggest_human = 1)
        OR (main_status = 'to_human' OR is_human_handled = 1)
        OR (main_status = 'gray_area')
        OR (created_at < ? AND (main_status IN ('unhandled','to_human','failed','pending_send','routed_line') OR (main_status IS NULL AND replied_at IS NULL AND is_hidden = 0)))
        OR (reply_link_source IS NULL OR reply_link_source = 'none')
        OR (detected_product_name IS NULL OR detected_product_name = '')
      )`;
      params.push(cutoffOverdue);
      sql += ` AND (
        (main_status NOT IN ('completed','human_replied','auto_replied') OR (reply_error IS NOT NULL AND reply_error != '') OR (hide_error IS NOT NULL AND hide_error != '') OR is_hidden = 1)
      )`;
    } else if (filters.status === "unhandled") sql += ` AND (main_status = 'unhandled' OR (main_status IS NULL AND replied_at IS NULL AND is_human_handled = 0 AND is_hidden = 0))`;
    else if (filters.status === "auto_replied") sql += ` AND (main_status = 'auto_replied' OR (main_status IS NULL AND replied_at IS NOT NULL AND is_human_handled = 0))`;
    else if (filters.status === "human" || filters.status === "to_human") sql += ` AND (main_status = 'to_human' OR is_human_handled = 1)`;
    else if (filters.status === "hidden") sql += ` AND (main_status = 'hidden' OR is_hidden = 1)`;
    else if (filters.status === "urgent" || filters.status === "sensitive") sql += ` AND (priority = 'urgent' OR ai_suggest_human = 1)`;
    else if (filters.status === "failed") sql += ` AND (main_status = 'failed' OR main_status = 'partial_success' OR (reply_error IS NOT NULL AND reply_error != '') OR (hide_error IS NOT NULL AND hide_error != ''))`;
    else if (filters.status === "no_mapping") sql += ` AND (reply_link_source IS NULL OR reply_link_source = 'none') AND (detected_product_source IS NULL OR detected_product_source = 'none')`;
    else if (filters.status === "no_product") sql += ` AND (detected_product_name IS NULL OR detected_product_name = '')`;
    else if (filters.status === "completed") sql += ` AND (main_status = 'completed' OR main_status = 'human_replied' OR (replied_at IS NOT NULL AND (reply_error IS NULL OR reply_error = '') AND is_hidden = 0))`;
    else if (filters.status === "overdue") {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      sql += ` AND created_at < ? AND (main_status IN ('unhandled','to_human','failed','pending_send','routed_line') OR (main_status IS NULL AND replied_at IS NULL AND is_hidden = 0))`;
      params.push(cutoff);
    }
  }
  if (filters.source === "real") sql += ` AND (is_simulated = 0 OR is_simulated IS NULL)`;
  else if (filters.source === "simulated") sql += ` AND is_simulated = 1`;

  if (filters.status === "exceptions") {
    const sortCutoff = new Date(Date.now() - DEFAULT_REPLY_MINUTES * 60 * 1000).toISOString();
    params.push(sortCutoff);
    sql += ` ORDER BY CASE
      WHEN (main_status = 'failed' OR main_status = 'partial_success' OR (reply_error IS NOT NULL AND reply_error != '') OR (hide_error IS NOT NULL AND hide_error != '')) THEN 1
      WHEN (main_status = 'to_human' OR is_human_handled = 1) THEN 2
      WHEN matched_rule_bucket = 'hide_and_route' AND (main_status NOT IN ('completed','human_replied','auto_replied','hidden_completed') OR main_status IS NULL) THEN 3
      WHEN (main_status IN ('unhandled','pending_send','routed_line') OR main_status IS NULL) AND created_at < ? THEN 4
      WHEN (reply_link_source IS NULL OR reply_link_source = 'none' OR reply_link_source = '') OR (detected_product_name IS NULL OR detected_product_name = '') THEN 5
      WHEN main_status = 'gray_area' THEN 6
      ELSE 7
    END, created_at ASC`;
    const rows = db.prepare(sql).all(...params) as MetaComment[];
    return rows;
  }

  sql += ` ORDER BY created_at DESC`;
  const rows = db.prepare(sql).all(...params) as MetaComment[];
  return rows;
}

/** 預設處理時限（分鐘），逾時未處理計入 overdue */
const DEFAULT_REPLY_MINUTES = 30;

/** Phase 3：戰情摘要計數（防漏用）+ 逾時筆數 + 例外筆數 */
export function getMetaCommentsSummary(filters: { brand_id?: number | null }): {
  unhandled: number;
  sensitive: number;
  to_human: number;
  failed: number;
  completed: number;
  overdue: number;
  exceptions: number;
  default_reply_minutes: number;
} {
  const base = filters.brand_id != null ? " WHERE brand_id = ?" : "";
  const params = filters.brand_id != null ? [filters.brand_id] : [];
  const unhandled = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND (main_status = 'unhandled' OR (main_status IS NULL AND replied_at IS NULL AND is_human_handled = 0 AND is_hidden = 0))`).get(...params) as { c: number }).c;
  const sensitive = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND (priority = 'urgent' OR ai_suggest_human = 1)`).get(...params) as { c: number }).c;
  const to_human = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND (main_status = 'to_human' OR is_human_handled = 1)`).get(...params) as { c: number }).c;
  const failed = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND (main_status = 'failed' OR main_status = 'partial_success' OR (reply_error IS NOT NULL AND reply_error != '') OR (hide_error IS NOT NULL AND hide_error != ''))`).get(...params) as { c: number }).c;
  const completed = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND (main_status = 'completed' OR main_status = 'human_replied' OR main_status = 'auto_replied' OR (replied_at IS NOT NULL AND (reply_error IS NULL OR reply_error = '') AND is_hidden = 0))`).get(...params) as { c: number }).c;
  const cutoff = new Date(Date.now() - DEFAULT_REPLY_MINUTES * 60 * 1000).toISOString();
  const overdue = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at < ? AND (main_status IN ('unhandled','to_human','failed','pending_send','routed_line') OR (main_status IS NULL AND replied_at IS NULL AND is_hidden = 0))`).get(...[...params, cutoff]) as { c: number }).c;
  const exceptionsSql = `SELECT COUNT(*) as c FROM meta_comments${base} AND (
    (main_status = 'failed' OR main_status = 'partial_success' OR (reply_error IS NOT NULL AND reply_error != '') OR (hide_error IS NOT NULL AND hide_error != ''))
    OR (priority = 'urgent' OR ai_suggest_human = 1)
    OR (main_status = 'to_human' OR is_human_handled = 1)
    OR (main_status = 'gray_area')
    OR (created_at < ? AND (main_status IN ('unhandled','to_human','failed','pending_send','routed_line') OR (main_status IS NULL AND replied_at IS NULL AND is_hidden = 0)))
    OR (reply_link_source IS NULL OR reply_link_source = 'none')
    OR (detected_product_name IS NULL OR detected_product_name = '')
  ) AND (
    (main_status NOT IN ('completed','human_replied','auto_replied') OR (reply_error IS NOT NULL AND reply_error != '') OR (hide_error IS NOT NULL AND hide_error != '') OR is_hidden = 1)
  )`;
  const exceptions = (db.prepare(exceptionsSql).get(...[...params, cutoff]) as { c: number }).c;
  return { unhandled, sensitive, to_human, failed, completed, overdue, exceptions, default_reply_minutes: DEFAULT_REPLY_MINUTES };
}

/** 今日規則命中分布 / 今日完成類型分布 / 近 10 分鐘錯誤原因 Top N */
export type TodayRuleHitDistribution = {
  whitelist: number;
  direct_hide: number;
  hide_and_route: number;
  route_only: number;
  gray_area: number;
  general_ai: number;
};
export type TodayCompletionDistribution = {
  ai_replied: number;
  hidden_completed: number;
  routed_line: number;
  to_human: number;
  failed: number;
  gray_area: number;
};
export type RecentErrorReason = { reason: string; count: number };

/** 健康儀表板：今日總數、自動完成、待人工、失敗、今日隱藏數、今日導 LINE 數（一般/售後）、平均處理時間、近 1h 成功率；失敗告警用：連續失敗次數、近 10 分鐘失敗率；分布與錯誤 Top N */
export function getMetaCommentsHealth(filters: { brand_id?: number | null }): {
  today_total: number;
  today_auto_completed: number;
  today_to_human: number;
  today_failed: number;
  today_hidden: number;
  today_routed_general: number;
  today_routed_after_sale: number;
  avg_processing_minutes: number | null;
  last_1h_total: number;
  last_1h_success: number;
  last_1h_success_rate: number | null;
  last_10m_failed: number;
  last_10m_total: number;
  failure_rate_10m: number | null;
  consecutive_failures: number;
  alert_active: boolean;
  alert_reason: string | null;
  today_rule_hit_distribution: TodayRuleHitDistribution;
  today_completion_distribution: TodayCompletionDistribution;
  recent_error_reasons: RecentErrorReason[];
} {
  const base = filters.brand_id != null ? " WHERE brand_id = ?" : "";
  const params = filters.brand_id != null ? [filters.brand_id] : [];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartISO = todayStart.toISOString();
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const today_total = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ?`).get(...[...params, todayStartISO]) as { c: number }).c;
  const today_auto_completed = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND (main_status = 'auto_replied' OR main_status = 'completed')`).get(...[...params, todayStartISO]) as { c: number }).c;
  const today_to_human = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND (main_status = 'to_human' OR is_human_handled = 1)`).get(...[...params, todayStartISO]) as { c: number }).c;
  const today_failed = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND (main_status = 'failed' OR main_status = 'partial_success' OR (reply_error IS NOT NULL AND reply_error != '') OR (hide_error IS NOT NULL AND hide_error != ''))`).get(...[...params, todayStartISO]) as { c: number }).c;
  const today_hidden = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND is_hidden = 1 AND auto_hidden_at >= ?`).get(...[...params, todayStartISO]) as { c: number }).c;
  const today_routed_general = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND target_line_type = 'general' AND target_line_value IS NOT NULL AND target_line_value != ''`).get(...[...params, todayStartISO]) as { c: number }).c;
  const today_routed_after_sale = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND target_line_type = 'after_sale' AND target_line_value IS NOT NULL AND target_line_value != ''`).get(...[...params, todayStartISO]) as { c: number }).c;

  const avgCond = base ? `${base} AND` : " WHERE";
  const avgRow = db.prepare(`
    SELECT AVG((julianday(replied_at) - julianday(created_at)) * 24 * 60) as avg_min
    FROM meta_comments${avgCond} created_at >= ? AND replied_at IS NOT NULL AND (reply_error IS NULL OR reply_error = '')
  `).get(...[...params, todayStartISO]) as { avg_min: number | null };
  const avg_processing_minutes = avgRow?.avg_min != null && !Number.isNaN(avgRow.avg_min) ? Math.round(avgRow.avg_min) : null;

  const last_1h_total = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ?`).get(...[...params, oneHourAgo]) as { c: number }).c;
  const last_1h_success = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND replied_at IS NOT NULL AND (reply_error IS NULL OR reply_error = '')`).get(...[...params, oneHourAgo]) as { c: number }).c;
  const last_1h_success_rate = last_1h_total > 0 ? Math.round((last_1h_success / last_1h_total) * 100) : null;

  const last_10m_total = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ?`).get(...[...params, tenMinAgo]) as { c: number }).c;
  const last_10m_failed = (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND (main_status = 'failed' OR main_status = 'partial_success' OR (reply_error IS NOT NULL AND reply_error != '') OR (hide_error IS NOT NULL AND hide_error != ''))`).get(...[...params, tenMinAgo]) as { c: number }).c;
  const failure_rate_10m = last_10m_total > 0 ? Math.round((last_10m_failed / last_10m_total) * 100) : null;

  const recentCond = base ? `${base} AND` : " WHERE";
  const recentRows = db.prepare(`
    SELECT id, main_status, reply_error, hide_error FROM meta_comments${recentCond} created_at >= ?
    ORDER BY id DESC LIMIT 100
  `).all(...[...params, oneHourAgo]) as { id: number; main_status: string | null; reply_error: string | null; hide_error: string | null }[];
  let consecutive_failures = 0;
  for (const r of recentRows) {
    const isFail = r.main_status === "failed" || r.main_status === "partial_success" || (r.reply_error != null && r.reply_error !== "") || (r.hide_error != null && r.hide_error !== "");
    if (isFail) consecutive_failures++; else break;
  }

  const CONSECUTIVE_THRESHOLD = 5;
  const RATE_THRESHOLD_PCT = 50;
  let alert_active = false;
  let alert_reason: string | null = null;
  if (consecutive_failures >= CONSECUTIVE_THRESHOLD) {
    alert_active = true;
    alert_reason = `連續 ${consecutive_failures} 筆執行失敗，請檢查 Token／權限／API 或 Meta 連線。`;
  } else if (failure_rate_10m != null && last_10m_total >= 3 && failure_rate_10m >= RATE_THRESHOLD_PCT) {
    alert_active = true;
    alert_reason = `近 10 分鐘失敗率 ${failure_rate_10m}%（${last_10m_failed}/${last_10m_total}），請檢查 Token／權限／API。`;
  }

  const today_rule_hit_distribution: TodayRuleHitDistribution = {
    whitelist: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND matched_rule_bucket = 'whitelist'`).get(...[...params, todayStartISO]) as { c: number }).c,
    direct_hide: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND matched_rule_bucket = 'direct_hide'`).get(...[...params, todayStartISO]) as { c: number }).c,
    hide_and_route: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND matched_rule_bucket = 'hide_and_route'`).get(...[...params, todayStartISO]) as { c: number }).c,
    route_only: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND matched_rule_bucket = 'route_only'`).get(...[...params, todayStartISO]) as { c: number }).c,
    gray_area: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND matched_rule_bucket = 'gray_area'`).get(...[...params, todayStartISO]) as { c: number }).c,
    general_ai: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND (matched_rule_bucket IS NULL OR matched_rule_bucket = '')`).get(...[...params, todayStartISO]) as { c: number }).c,
  };
  const today_completion_distribution: TodayCompletionDistribution = {
    ai_replied: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND (main_status = 'auto_replied' OR main_status = 'completed')`).get(...[...params, todayStartISO]) as { c: number }).c,
    hidden_completed: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND main_status = 'hidden_completed'`).get(...[...params, todayStartISO]) as { c: number }).c,
    routed_line: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND main_status = 'routed_line'`).get(...[...params, todayStartISO]) as { c: number }).c,
    to_human: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND (main_status = 'to_human' OR is_human_handled = 1)`).get(...[...params, todayStartISO]) as { c: number }).c,
    failed: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND (main_status = 'failed' OR main_status = 'partial_success')`).get(...[...params, todayStartISO]) as { c: number }).c,
    gray_area: (db.prepare(`SELECT COUNT(*) as c FROM meta_comments${base} AND created_at >= ? AND main_status = 'gray_area'`).get(...[...params, todayStartISO]) as { c: number }).c,
  };
  const errRows = db.prepare(`
    SELECT reply_error, hide_error FROM meta_comments${recentCond} created_at >= ? AND (reply_error IS NOT NULL AND reply_error != '' OR hide_error IS NOT NULL AND hide_error != '')
  `).all(...[...params, tenMinAgo]) as { reply_error: string | null; hide_error: string | null }[];
  const reasonCounts: Record<string, number> = {};
  for (const row of errRows) {
    const reasons: string[] = [];
    if (row.reply_error) reasons.push(String(row.reply_error).slice(0, 120));
    if (row.hide_error) reasons.push(String(row.hide_error).slice(0, 120));
    for (const r of reasons) {
      const key = r || "未知錯誤";
      reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    }
  }
  const recent_error_reasons: RecentErrorReason[] = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  return {
    today_total,
    today_auto_completed,
    today_to_human,
    today_failed,
    today_hidden,
    today_routed_general,
    today_routed_after_sale,
    avg_processing_minutes,
    last_1h_total,
    last_1h_success,
    last_1h_success_rate,
    last_10m_failed,
    last_10m_total,
    failure_rate_10m,
    consecutive_failures,
    alert_active,
    alert_reason,
    today_rule_hit_distribution,
    today_completion_distribution,
    recent_error_reasons,
  };
}

/** 抽查已完成：隨機取 N 筆已完成留言（不預設顯示） */
export function getMetaCommentsRandomCompleted(filters: { brand_id?: number | null; limit?: number }): MetaComment[] {
  const limit = Math.min(50, Math.max(1, filters.limit ?? 20));
  let sql = `
    SELECT * FROM meta_comments
    WHERE (main_status = 'completed' OR main_status = 'human_replied' OR main_status = 'auto_replied' OR (replied_at IS NOT NULL AND (reply_error IS NULL OR reply_error = '') AND is_hidden = 0))
  `;
  const params: (number | string)[] = [];
  if (filters.brand_id != null) {
    sql += ` AND brand_id = ?`;
    params.push(filters.brand_id);
  }
  sql += ` ORDER BY RANDOM() LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as MetaComment[];
}

/** 灰區抽查：隨機取 N 筆 main_status = 'gray_area' 的留言，供營運抽查 */
export function getMetaCommentsGraySpotCheck(filters: { brand_id?: number | null; limit?: number }): MetaComment[] {
  const limit = Math.min(50, Math.max(1, filters.limit ?? 20));
  let sql = `SELECT * FROM meta_comments WHERE main_status = 'gray_area'`;
  const params: (number | string)[] = [];
  if (filters.brand_id != null) {
    sql += ` AND brand_id = ?`;
    params.push(filters.brand_id);
  }
  sql += ` ORDER BY RANDOM() LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as MetaComment[];
}

export function getMetaComment(id: number): MetaComment | undefined {
  return db.prepare("SELECT * FROM meta_comments WHERE id = ?").get(id) as MetaComment | undefined;
}

export function getMetaCommentByCommentId(commentId: string): MetaComment | undefined {
  return db.prepare("SELECT * FROM meta_comments WHERE comment_id = ?").get(commentId) as MetaComment | undefined;
}

export function createMetaComment(data: {
  brand_id?: number | null;
  page_id: string;
  page_name?: string | null;
  post_id: string;
  post_name?: string | null;
  comment_id: string;
  commenter_id?: string | null;
  commenter_name: string;
  message: string;
  ai_intent?: string | null;
  issue_type?: string | null;
  priority?: string | null;
  ai_suggest_hide?: number;
  ai_suggest_human?: number;
  reply_first?: string | null;
  reply_second?: string | null;
  is_simulated?: number;
  post_display_name?: string | null;
  detected_post_title_source?: string | null;
  detected_product_name?: string | null;
  detected_product_source?: string | null;
  target_line_type?: "general" | "after_sale" | null;
  target_line_value?: string | null;
  raw_webhook_payload?: string | null;
}): MetaComment {
  const now = new Date().toISOString();
  const isSimulated = data.is_simulated ? 1 : 0;
  const hasRaw = (db.prepare("PRAGMA table_info(meta_comments)").all() as { name: string }[]).some((c) => c.name === "raw_webhook_payload");
  const cols = hasRaw
    ? "brand_id, page_id, page_name, post_id, post_name, comment_id, commenter_id, commenter_name, message, created_at, ai_intent, issue_type, priority, ai_suggest_hide, ai_suggest_human, reply_first, reply_second, is_simulated, post_display_name, detected_post_title_source, detected_product_name, detected_product_source, target_line_type, target_line_value, raw_webhook_payload"
    : "brand_id, page_id, page_name, post_id, post_name, comment_id, commenter_id, commenter_name, message, created_at, ai_intent, issue_type, priority, ai_suggest_hide, ai_suggest_human, reply_first, reply_second, is_simulated, post_display_name, detected_post_title_source, detected_product_name, detected_product_source, target_line_type, target_line_value";
  const placeholders = hasRaw ? "?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?" : "?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?";
  const stmt = db.prepare(`
    INSERT INTO meta_comments (${cols})
    VALUES (${placeholders})
  `);
  const runArgs = [
    data.brand_id ?? null,
    data.page_id,
    data.page_name ?? null,
    data.post_id,
    data.post_name ?? null,
    data.comment_id,
    data.commenter_id ?? null,
    data.commenter_name,
    data.message,
    now,
    data.ai_intent ?? null,
    data.issue_type ?? null,
    data.priority ?? "normal",
    data.ai_suggest_hide ?? 0,
    data.ai_suggest_human ?? 0,
    data.reply_first ?? null,
    data.reply_second ?? null,
    isSimulated,
    data.post_display_name ?? null,
    data.detected_post_title_source ?? null,
    data.detected_product_name ?? null,
    data.detected_product_source ?? null,
    data.target_line_type ?? null,
    data.target_line_value ?? null,
  ];
  if (hasRaw) runArgs.push(data.raw_webhook_payload ?? null);
  const runResult = stmt.run(...runArgs);
  return getMetaComment(Number(runResult.lastInsertRowid))!;
}

export function updateMetaComment(id: number, data: Partial<{
  replied_at: string | null;
  is_hidden: number;
  is_dm_sent: number;
  is_human_handled: number;
  contact_id: number | null;
  reply_first: string | null;
  reply_second: string | null;
  issue_type: string | null;
  priority: string | null;
  tags: string;
  ai_intent: string | null;
  ai_suggest_hide: number;
  ai_suggest_human: number;
  applied_rule_id: number | null;
  applied_template_id: number | null;
  applied_mapping_id: number | null;
  reply_link_source: string | null;
  assigned_agent_id: number | null;
  assigned_agent_name: string | null;
  assigned_agent_avatar_url: string | null;
  assignment_method: string | null;
  assigned_at: string | null;
  classifier_source: string | null;
  matched_rule_keyword: string | null;
  reply_flow_type: string | null;
  reply_error: string | null;
  platform_error: string | null;
  auto_replied_at: string | null;
  auto_hidden_at: string | null;
  auto_routed_at: string | null;
  detected_product_name: string | null;
  detected_product_source: string | null;
  detected_post_title_source: string | null;
  post_display_name: string | null;
  target_line_type: "general" | "after_sale" | null;
  target_line_value: string | null;
  hide_error: string | null;
  raw_webhook_payload: string | null;
  main_status: string | null;
  auto_execution_run_at: string | null;
  matched_risk_rule_id: number | null;
  matched_rule_bucket: string | null;
  blocked_reason: string | null;
}>): boolean {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (data.replied_at !== undefined) { cols.push("replied_at = ?"); vals.push(data.replied_at); }
  if (data.is_hidden !== undefined) { cols.push("is_hidden = ?"); vals.push(data.is_hidden); }
  if (data.is_dm_sent !== undefined) { cols.push("is_dm_sent = ?"); vals.push(data.is_dm_sent); }
  if (data.is_human_handled !== undefined) { cols.push("is_human_handled = ?"); vals.push(data.is_human_handled); }
  if (data.contact_id !== undefined) { cols.push("contact_id = ?"); vals.push(data.contact_id); }
  if (data.reply_first !== undefined) { cols.push("reply_first = ?"); vals.push(data.reply_first); }
  if (data.reply_second !== undefined) { cols.push("reply_second = ?"); vals.push(data.reply_second); }
  if (data.issue_type !== undefined) { cols.push("issue_type = ?"); vals.push(data.issue_type); }
  if (data.priority !== undefined) { cols.push("priority = ?"); vals.push(data.priority); }
  if (data.tags !== undefined) { cols.push("tags = ?"); vals.push(data.tags); }
  if (data.ai_intent !== undefined) { cols.push("ai_intent = ?"); vals.push(data.ai_intent); }
  if (data.ai_suggest_hide !== undefined) { cols.push("ai_suggest_hide = ?"); vals.push(data.ai_suggest_hide); }
  if (data.ai_suggest_human !== undefined) { cols.push("ai_suggest_human = ?"); vals.push(data.ai_suggest_human); }
  if (data.applied_rule_id !== undefined) { cols.push("applied_rule_id = ?"); vals.push(data.applied_rule_id); }
  if (data.applied_template_id !== undefined) { cols.push("applied_template_id = ?"); vals.push(data.applied_template_id); }
  if (data.applied_mapping_id !== undefined) { cols.push("applied_mapping_id = ?"); vals.push(data.applied_mapping_id); }
  if (data.reply_link_source !== undefined) { cols.push("reply_link_source = ?"); vals.push(data.reply_link_source); }
  if (data.assigned_agent_id !== undefined) { cols.push("assigned_agent_id = ?"); vals.push(data.assigned_agent_id); }
  if (data.assigned_agent_name !== undefined) { cols.push("assigned_agent_name = ?"); vals.push(data.assigned_agent_name); }
  if (data.assigned_agent_avatar_url !== undefined) { cols.push("assigned_agent_avatar_url = ?"); vals.push(data.assigned_agent_avatar_url); }
  if (data.assignment_method !== undefined) { cols.push("assignment_method = ?"); vals.push(data.assignment_method); }
  if (data.assigned_at !== undefined) { cols.push("assigned_at = ?"); vals.push(data.assigned_at); }
  if (data.classifier_source !== undefined) { cols.push("classifier_source = ?"); vals.push(data.classifier_source); }
  if (data.matched_rule_keyword !== undefined) { cols.push("matched_rule_keyword = ?"); vals.push(data.matched_rule_keyword); }
  if (data.reply_flow_type !== undefined) { cols.push("reply_flow_type = ?"); vals.push(data.reply_flow_type); }
  if (data.reply_error !== undefined) { cols.push("reply_error = ?"); vals.push(data.reply_error); }
  if (data.platform_error !== undefined) { cols.push("platform_error = ?"); vals.push(data.platform_error); }
  if (data.auto_replied_at !== undefined) { cols.push("auto_replied_at = ?"); vals.push(data.auto_replied_at); }
  if (data.auto_hidden_at !== undefined) { cols.push("auto_hidden_at = ?"); vals.push(data.auto_hidden_at); }
  if (data.auto_routed_at !== undefined) { cols.push("auto_routed_at = ?"); vals.push(data.auto_routed_at); }
  if (data.detected_product_name !== undefined) { cols.push("detected_product_name = ?"); vals.push(data.detected_product_name); }
  if (data.detected_product_source !== undefined) { cols.push("detected_product_source = ?"); vals.push(data.detected_product_source); }
  if (data.detected_post_title_source !== undefined) { cols.push("detected_post_title_source = ?"); vals.push(data.detected_post_title_source); }
  if (data.post_display_name !== undefined) { cols.push("post_display_name = ?"); vals.push(data.post_display_name); }
  if (data.target_line_type !== undefined) { cols.push("target_line_type = ?"); vals.push(data.target_line_type); }
  if (data.target_line_value !== undefined) { cols.push("target_line_value = ?"); vals.push(data.target_line_value); }
  if (data.hide_error !== undefined) { cols.push("hide_error = ?"); vals.push(data.hide_error); }
  if (data.raw_webhook_payload !== undefined) { cols.push("raw_webhook_payload = ?"); vals.push(data.raw_webhook_payload); }
  if (data.main_status !== undefined) { cols.push("main_status = ?"); vals.push(data.main_status); }
  if (data.auto_execution_run_at !== undefined) { cols.push("auto_execution_run_at = ?"); vals.push(data.auto_execution_run_at); }
  if (data.matched_risk_rule_id !== undefined) { cols.push("matched_risk_rule_id = ?"); vals.push(data.matched_risk_rule_id); }
  if (data.matched_rule_bucket !== undefined) { cols.push("matched_rule_bucket = ?"); vals.push(data.matched_rule_bucket); }
  if (data.blocked_reason !== undefined) { cols.push("blocked_reason = ?"); vals.push(data.blocked_reason); }
  if (cols.length === 0) return true;
  vals.push(id);
  db.prepare(`UPDATE meta_comments SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

/** 紀錄平台動作（回覆/隱藏）供追蹤與除錯 */
export function insertMetaCommentAction(data: {
  comment_id: number;
  action_type: string;
  success: number;
  error_message?: string | null;
  platform_response?: string | null;
  executor?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO meta_comment_actions (comment_id, action_type, executed_at, success, error_message, platform_response, executor)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.comment_id,
    data.action_type,
    now,
    data.success ? 1 : 0,
    data.error_message ?? null,
    data.platform_response ?? null,
    data.executor ?? null
  );
}

/** Phase 3：嘗試佔用自動執行（防重複）。僅當 auto_execution_run_at 為 NULL 時寫入 now，回傳是否成功佔用。 */
export function tryClaimAutoExecution(commentId: number): boolean {
  const now = new Date().toISOString();
  const r = db.prepare("UPDATE meta_comments SET auto_execution_run_at = ? WHERE id = ? AND (auto_execution_run_at IS NULL OR auto_execution_run_at = '')").run(now, commentId);
  return r.changes > 0;
}

/** 依粉專/貼文取得導購連結用 mapping；僅回傳 auto_comment_enabled=1 的對應，確保啟用開關生效 */
export function getMappingForComment(brandId: number | null, pageId: string, postId: string): MetaPostMapping | null {
  const enabled = " AND auto_comment_enabled = 1";
  if (brandId != null) {
    const exact = db.prepare(`
      SELECT * FROM meta_post_mappings
      WHERE brand_id = ? AND post_id = ? AND (page_id IS NULL OR page_id = ?)${enabled}
      LIMIT 1
    `).get(brandId, postId, pageId) as MetaPostMapping | undefined;
    if (exact) return exact;
  }
  const anyBrand = db.prepare(`
    SELECT * FROM meta_post_mappings
    WHERE post_id = ? AND (page_id IS NULL OR page_id = ?)${enabled}
    LIMIT 1
  `).get(postId, pageId) as MetaPostMapping | undefined;
  if (anyBrand) return anyBrand;
  if (brandId != null) {
    const fallback = db.prepare(`SELECT * FROM meta_post_mappings WHERE brand_id = ?${enabled} LIMIT 1`).get(brandId) as MetaPostMapping | undefined;
    return fallback ?? null;
  }
  return null;
}

// --- Templates ---
export function getMetaCommentTemplates(brandId?: number | null): MetaCommentTemplate[] {
  const sql = brandId != null
    ? "SELECT * FROM meta_comment_templates WHERE brand_id IS NULL OR brand_id = ? ORDER BY category, name"
    : "SELECT * FROM meta_comment_templates ORDER BY category, name";
  const params = brandId != null ? [brandId] : [];
  return db.prepare(sql).all(...params) as MetaCommentTemplate[];
}

/** 依情境分類取一筆模板（用於 LINE 導流話術：line_general / line_after_sale / line_promotion） */
export function getMetaCommentTemplateByCategory(brandId: number | null | undefined, category: string): MetaCommentTemplate | undefined {
  const sql = brandId != null
    ? "SELECT * FROM meta_comment_templates WHERE category = ? AND (brand_id IS NULL OR brand_id = ?) ORDER BY brand_id DESC LIMIT 1"
    : "SELECT * FROM meta_comment_templates WHERE category = ? ORDER BY id LIMIT 1";
  const params = brandId != null ? [category, brandId] : [category];
  return db.prepare(sql).get(...params) as MetaCommentTemplate | undefined;
}

export function createMetaCommentTemplate(data: {
  brand_id?: number | null;
  category: string;
  name: string;
  reply_first?: string;
  reply_second?: string;
  reply_comfort?: string;
  reply_dm_guide?: string;
  reply_private?: string | null;
  tone_hint?: string | null;
}): MetaCommentTemplate {
  const now = new Date().toISOString();
  const cols = ["brand_id", "category", "name", "reply_first", "reply_second", "reply_comfort", "reply_dm_guide", "tone_hint", "created_at"];
  const vals: unknown[] = [data.brand_id ?? null, data.category, data.name, data.reply_first ?? "", data.reply_second ?? "", data.reply_comfort ?? "", data.reply_dm_guide ?? "", data.tone_hint ?? null, now];
  const hasPrivate = (db.prepare("PRAGMA table_info(meta_comment_templates)").all() as { name: string }[]).some((c) => c.name === "reply_private");
  if (hasPrivate) {
    cols.splice(cols.indexOf("tone_hint"), 0, "reply_private");
    vals.splice(vals.length - 1, 0, data.reply_private ?? null);
  }
  db.prepare(`INSERT INTO meta_comment_templates (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  const row = db.prepare("SELECT * FROM meta_comment_templates ORDER BY id DESC LIMIT 1").get() as MetaCommentTemplate;
  return row;
}

export function updateMetaCommentTemplate(id: number, data: Partial<MetaCommentTemplate>): boolean {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (data.category !== undefined) { cols.push("category = ?"); vals.push(data.category); }
  if (data.name !== undefined) { cols.push("name = ?"); vals.push(data.name); }
  if (data.reply_first !== undefined) { cols.push("reply_first = ?"); vals.push(data.reply_first); }
  if (data.reply_second !== undefined) { cols.push("reply_second = ?"); vals.push(data.reply_second); }
  if (data.reply_comfort !== undefined) { cols.push("reply_comfort = ?"); vals.push(data.reply_comfort); }
  if (data.reply_dm_guide !== undefined) { cols.push("reply_dm_guide = ?"); vals.push(data.reply_dm_guide); }
  if (data.tone_hint !== undefined) { cols.push("tone_hint = ?"); vals.push(data.tone_hint); }
  if ((data as any).reply_private !== undefined) { cols.push("reply_private = ?"); vals.push((data as any).reply_private); }
  if (cols.length === 0) return true;
  vals.push(id);
  db.prepare(`UPDATE meta_comment_templates SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

export function deleteMetaCommentTemplate(id: number): boolean {
  const r = db.prepare("DELETE FROM meta_comment_templates WHERE id = ?").run(id);
  return r.changes > 0;
}

// --- Post mappings ---
export function getMetaPostMappings(brandId?: number | null): MetaPostMapping[] {
  const sql = brandId != null
    ? "SELECT * FROM meta_post_mappings WHERE brand_id = ? ORDER BY post_id"
    : "SELECT * FROM meta_post_mappings ORDER BY brand_id, post_id";
  const params = brandId != null ? [brandId] : [];
  return db.prepare(sql).all(...params) as MetaPostMapping[];
}

export function createMetaPostMapping(data: {
  brand_id: number;
  page_id?: string | null;
  page_name?: string | null;
  post_id: string;
  post_name?: string | null;
  product_name?: string | null;
  primary_url?: string | null;
  fallback_url?: string | null;
  tone_hint?: string | null;
  auto_comment_enabled?: number;
  preferred_flow?: string | null;
}): MetaPostMapping {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO meta_post_mappings (brand_id, page_id, page_name, post_id, post_name, product_name, primary_url, fallback_url, tone_hint, auto_comment_enabled, preferred_flow, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.brand_id,
    data.page_id ?? null,
    data.page_name ?? null,
    data.post_id,
    data.post_name ?? null,
    data.product_name ?? null,
    data.primary_url ?? null,
    data.fallback_url ?? null,
    data.tone_hint ?? null,
    data.auto_comment_enabled ?? 1,
    data.preferred_flow ?? null,
    now
  );
  const row = db.prepare("SELECT * FROM meta_post_mappings ORDER BY id DESC LIMIT 1").get() as MetaPostMapping;
  return row;
}

export function updateMetaPostMapping(id: number, data: Partial<MetaPostMapping>): boolean {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (data.page_id !== undefined) { cols.push("page_id = ?"); vals.push(data.page_id); }
  if (data.page_name !== undefined) { cols.push("page_name = ?"); vals.push(data.page_name); }
  if (data.post_id !== undefined) { cols.push("post_id = ?"); vals.push(data.post_id); }
  if (data.post_name !== undefined) { cols.push("post_name = ?"); vals.push(data.post_name); }
  if (data.product_name !== undefined) { cols.push("product_name = ?"); vals.push(data.product_name); }
  if (data.primary_url !== undefined) { cols.push("primary_url = ?"); vals.push(data.primary_url); }
  if (data.fallback_url !== undefined) { cols.push("fallback_url = ?"); vals.push(data.fallback_url); }
  if (data.tone_hint !== undefined) { cols.push("tone_hint = ?"); vals.push(data.tone_hint); }
  if (data.auto_comment_enabled !== undefined) { cols.push("auto_comment_enabled = ?"); vals.push(data.auto_comment_enabled); }
  if (data.preferred_flow !== undefined) { cols.push("preferred_flow = ?"); vals.push(data.preferred_flow); }
  if (cols.length === 0) return true;
  vals.push(id);
  db.prepare(`UPDATE meta_post_mappings SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

export function deleteMetaPostMapping(id: number): boolean {
  const r = db.prepare("DELETE FROM meta_post_mappings WHERE id = ?").run(id);
  return r.changes > 0;
}

/** 同一個 page_id + post_id 只能有一筆啟用中的 mapping（用於防呆） */
export function hasDuplicateEnabledMapping(
  brandId: number,
  pageId: string | null,
  postId: string,
  excludeMappingId?: number
): boolean {
  let sql = `
    SELECT 1 FROM meta_post_mappings
    WHERE brand_id = ? AND post_id = ? AND auto_comment_enabled = 1
  `;
  const params: (number | string)[] = [brandId, postId];
  if (pageId != null && pageId !== "") {
    sql += ` AND (page_id IS NULL OR page_id = ?)`;
    params.push(pageId);
  } else {
    sql += ` AND (page_id IS NULL OR page_id = '')`;
  }
  if (excludeMappingId != null) {
    sql += ` AND id != ?`;
    params.push(excludeMappingId);
  }
  sql += ` LIMIT 1`;
  const row = db.prepare(sql).get(...params);
  return !!row;
}

/** 粉專列表（目前從既有 mapping + 留言彙總；未來可接 Meta Graph API） */
export function getMetaPagesForDropdown(brandId?: number | null): { page_id: string; page_name: string }[] {
  const fromMappings = db.prepare(`
    SELECT DISTINCT page_id, page_name FROM meta_post_mappings
    WHERE (page_id IS NOT NULL AND page_id != '')
  `).all() as { page_id: string; page_name: string | null }[];
  const fromComments = db.prepare(`
    SELECT DISTINCT page_id, page_name FROM meta_comments
    WHERE (page_id IS NOT NULL AND page_id != '')
  `).all() as { page_id: string; page_name: string | null }[];
  const seen = new Set<string>();
  const out: { page_id: string; page_name: string }[] = [];
  for (const r of [...fromMappings, ...fromComments]) {
    if (!r.page_id || seen.has(r.page_id)) continue;
    seen.add(r.page_id);
    out.push({ page_id: r.page_id, page_name: r.page_name || r.page_id });
  }
  if (out.length === 0) {
    out.push({ page_id: "page_demo", page_name: "示範粉專" });
    out.push({ page_id: "page_sim", page_name: "模擬粉專" });
  }
  return out.sort((a, b) => (a.page_name || "").localeCompare(b.page_name || ""));
}

/** 依粉專取得貼文列表（目前從 mapping + 留言彙總；未來可接 Meta Graph API） */
export function getMetaPostsByPage(pageId: string, brandId?: number | null): { post_id: string; post_name: string; created_at?: string }[] {
  const fromMappings = db.prepare(`
    SELECT DISTINCT post_id, post_name, created_at FROM meta_post_mappings
    WHERE (page_id IS NULL OR page_id = ?)
  `).all(pageId) as { post_id: string; post_name: string | null; created_at: string }[];
  const fromComments = db.prepare(`
    SELECT DISTINCT post_id, post_name, created_at FROM meta_comments WHERE page_id = ?
  `).all(pageId) as { post_id: string; post_name: string | null; created_at: string }[];
  const seen = new Set<string>();
  const out: { post_id: string; post_name: string; created_at?: string }[] = [];
  for (const r of [...fromMappings, ...fromComments]) {
    if (!r.post_id || seen.has(r.post_id)) continue;
    seen.add(r.post_id);
    out.push({ post_id: r.post_id, post_name: r.post_name || r.post_id, created_at: r.created_at });
  }
  if (out.length === 0) {
    out.push({ post_id: "post_001", post_name: "春季活動貼文" });
    out.push({ post_id: "post_002", post_name: "商品介紹貼文" });
    out.push({ post_id: "post_sim", post_name: "模擬貼文" });
  }
  return out.sort((a, b) => (a.post_name || "").localeCompare(b.post_name || ""));
}

/** 商品名稱搜尋（目前從 mapping 彙總 + 假資料；未來可接電商 API） */
export function searchMetaProducts(q?: string | null, brandId?: number | null): { product_name: string }[] {
  const rows = db.prepare(`
    SELECT DISTINCT product_name FROM meta_post_mappings
    WHERE product_name IS NOT NULL AND product_name != ''
  `).all() as { product_name: string | null }[];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (r.product_name && !seen.has(r.product_name)) {
      seen.add(r.product_name);
      out.push(r.product_name);
    }
  }
  const fake = ["經典精華液", "保濕霜", "面膜組", "防曬乳", "化妝水", "乳液"];
  fake.forEach((n) => {
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  });
  let list = out.sort((a, b) => a.localeCompare(b));
  if (q && q.trim()) {
    const lower = q.trim().toLowerCase();
    list = list.filter((n) => n.toLowerCase().includes(lower));
  }
  return list.map((product_name) => ({ product_name }));
}

// --- Rules ---
export function getMetaCommentRules(brandId?: number | null): MetaCommentRule[] {
  const sql = brandId != null
    ? "SELECT * FROM meta_comment_rules WHERE brand_id IS NULL OR brand_id = ? ORDER BY priority DESC, id"
    : "SELECT * FROM meta_comment_rules ORDER BY priority DESC, id";
  const params = brandId != null ? [brandId] : [];
  return db.prepare(sql).all(...params) as MetaCommentRule[];
}

export function getMetaCommentRule(id: number): MetaCommentRule | undefined {
  return db.prepare("SELECT * FROM meta_comment_rules WHERE id = ?").get(id) as MetaCommentRule | undefined;
}

export function createMetaCommentRule(data: {
  brand_id?: number | null;
  page_id?: string | null;
  post_id?: string | null;
  priority?: number;
  rule_type: string;
  keyword_pattern: string;
  template_id?: number | null;
  tag_value?: string | null;
  enabled?: number;
}): MetaCommentRule {
  const now = new Date().toISOString();
  const enabled = data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1;
  db.prepare(`
    INSERT INTO meta_comment_rules (brand_id, page_id, post_id, priority, rule_type, keyword_pattern, template_id, tag_value, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.brand_id ?? null,
    data.page_id ?? null,
    data.post_id ?? null,
    data.priority ?? 0,
    data.rule_type,
    data.keyword_pattern,
    data.template_id ?? null,
    data.tag_value ?? null,
    enabled,
    now
  );
  const row = db.prepare("SELECT * FROM meta_comment_rules ORDER BY id DESC LIMIT 1").get() as MetaCommentRule;
  return row;
}

export function updateMetaCommentRule(id: number, data: Partial<{
  brand_id: number | null;
  page_id: string | null;
  post_id: string | null;
  priority: number;
  rule_type: string;
  keyword_pattern: string;
  template_id: number | null;
  tag_value: string | null;
  enabled: number;
}>): boolean {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (data.brand_id !== undefined) { cols.push("brand_id = ?"); vals.push(data.brand_id); }
  if (data.page_id !== undefined) { cols.push("page_id = ?"); vals.push(data.page_id); }
  if (data.post_id !== undefined) { cols.push("post_id = ?"); vals.push(data.post_id); }
  if (data.priority !== undefined) { cols.push("priority = ?"); vals.push(data.priority); }
  if (data.rule_type !== undefined) { cols.push("rule_type = ?"); vals.push(data.rule_type); }
  if (data.keyword_pattern !== undefined) { cols.push("keyword_pattern = ?"); vals.push(data.keyword_pattern); }
  if (data.template_id !== undefined) { cols.push("template_id = ?"); vals.push(data.template_id); }
  if (data.tag_value !== undefined) { cols.push("tag_value = ?"); vals.push(data.tag_value); }
  if (data.enabled !== undefined) { cols.push("enabled = ?"); vals.push(data.enabled ? 1 : 0); }
  if (cols.length === 0) return true;
  vals.push(id);
  db.prepare(`UPDATE meta_comment_rules SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

export function deleteMetaCommentRule(id: number): boolean {
  const r = db.prepare("DELETE FROM meta_comment_rules WHERE id = ?").run(id);
  return r.changes > 0;
}

// --- Page settings (粉專 → 品牌 → 導流 LINE) ---
export function getMetaPageSettingsList(brandId?: number | null): (MetaPageSettings & { brand_name?: string })[] {
  let sql = `
    SELECT s.*, b.name as brand_name FROM meta_page_settings s
    LEFT JOIN brands b ON s.brand_id = b.id
    ORDER BY s.page_id
  `;
  const params: (number | null)[] = [];
  if (brandId != null) {
    sql = `
      SELECT s.*, b.name as brand_name FROM meta_page_settings s
      LEFT JOIN brands b ON s.brand_id = b.id
      WHERE s.brand_id = ?
      ORDER BY s.page_id
    `;
    params.push(brandId);
  }
  return db.prepare(sql).all(...params) as (MetaPageSettings & { brand_name?: string })[];
}

export function getMetaPageSettingsByPageId(pageId: string): MetaPageSettings | undefined {
  return db.prepare("SELECT * FROM meta_page_settings WHERE page_id = ?").get(pageId) as MetaPageSettings | undefined;
}

export function getMetaPageSettings(id: number): MetaPageSettings | undefined {
  return db.prepare("SELECT * FROM meta_page_settings WHERE id = ?").get(id) as MetaPageSettings | undefined;
}

export function createMetaPageSettings(data: {
  page_id: string;
  page_name?: string | null;
  brand_id: number;
  line_general?: string | null;
  line_after_sale?: string | null;
  auto_hide_sensitive?: number;
  auto_reply_enabled?: number;
  auto_route_line_enabled?: number;
  default_reply_template_id?: number | null;
  default_sensitive_template_id?: number | null;
  default_flow?: string | null;
  default_product_name?: string | null;
}): MetaPageSettings {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO meta_page_settings (page_id, page_name, brand_id, line_general, line_after_sale, auto_hide_sensitive, auto_reply_enabled, auto_route_line_enabled, default_reply_template_id, default_sensitive_template_id, default_flow, default_product_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.page_id,
    data.page_name ?? null,
    data.brand_id,
    data.line_general ?? null,
    data.line_after_sale ?? null,
    data.auto_hide_sensitive ?? 0,
    data.auto_reply_enabled ?? 0,
    data.auto_route_line_enabled ?? 0,
    data.default_reply_template_id ?? null,
    data.default_sensitive_template_id ?? null,
    data.default_flow ?? null,
    data.default_product_name ?? null,
    now,
    now
  );
  return db.prepare("SELECT * FROM meta_page_settings ORDER BY id DESC LIMIT 1").get() as MetaPageSettings;
}

export function updateMetaPageSettings(id: number, data: Partial<MetaPageSettings>): boolean {
  const cols: string[] = ["updated_at = ?"];
  const vals: unknown[] = [new Date().toISOString()];
  if (data.page_name !== undefined) { cols.push("page_name = ?"); vals.push(data.page_name); }
  if (data.brand_id !== undefined) { cols.push("brand_id = ?"); vals.push(data.brand_id); }
  if (data.line_general !== undefined) { cols.push("line_general = ?"); vals.push(data.line_general); }
  if (data.line_after_sale !== undefined) { cols.push("line_after_sale = ?"); vals.push(data.line_after_sale); }
  if (data.auto_hide_sensitive !== undefined) { cols.push("auto_hide_sensitive = ?"); vals.push(data.auto_hide_sensitive); }
  if (data.auto_reply_enabled !== undefined) { cols.push("auto_reply_enabled = ?"); vals.push(data.auto_reply_enabled); }
  if (data.auto_route_line_enabled !== undefined) { cols.push("auto_route_line_enabled = ?"); vals.push(data.auto_route_line_enabled); }
  if (data.default_reply_template_id !== undefined) { cols.push("default_reply_template_id = ?"); vals.push(data.default_reply_template_id); }
  if (data.default_sensitive_template_id !== undefined) { cols.push("default_sensitive_template_id = ?"); vals.push(data.default_sensitive_template_id); }
  if (data.default_flow !== undefined) { cols.push("default_flow = ?"); vals.push(data.default_flow); }
  if (data.default_product_name !== undefined) { cols.push("default_product_name = ?"); vals.push(data.default_product_name); }
  vals.push(id);
  db.prepare(`UPDATE meta_page_settings SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

export function deleteMetaPageSettings(id: number): boolean {
  const r = db.prepare("DELETE FROM meta_page_settings WHERE id = ?").run(id);
  return r.changes > 0;
}

// --- Product keywords (貼文/留言關鍵字 → 商品) ---
export function getMetaProductKeywords(brandId?: number | null): MetaProductKeyword[] {
  const sql = brandId != null
    ? "SELECT * FROM meta_product_keywords WHERE brand_id IS NULL OR brand_id = ? ORDER BY match_scope, keyword"
    : "SELECT * FROM meta_product_keywords ORDER BY match_scope, keyword";
  const params = brandId != null ? [brandId] : [];
  return db.prepare(sql).all(...params) as MetaProductKeyword[];
}

export function createMetaProductKeyword(data: {
  brand_id?: number | null;
  keyword: string;
  product_name: string;
  match_scope: "post" | "comment";
}): MetaProductKeyword {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO meta_product_keywords (brand_id, keyword, product_name, match_scope, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(data.brand_id ?? null, data.keyword.trim(), data.product_name.trim(), data.match_scope, now);
  return db.prepare("SELECT * FROM meta_product_keywords ORDER BY id DESC LIMIT 1").get() as MetaProductKeyword;
}

export function deleteMetaProductKeyword(id: number): boolean {
  const r = db.prepare("DELETE FROM meta_product_keywords WHERE id = ?").run(id);
  return r.changes > 0;
}
