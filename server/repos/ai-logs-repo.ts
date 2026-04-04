/**
 * ai_logs 資料存取（自 storage 抽出，供單一職責與測試隔離）。
 */
import db from "../db";
import type { AiLog } from "@shared/schema";

export type CreateAiLogInput = {
  contact_id?: number;
  message_id?: number;
  brand_id?: number;
  prompt_summary: string;
  knowledge_hits: string[];
  tools_called: string[];
  transfer_triggered: boolean;
  transfer_reason?: string;
  result_summary: string;
  token_usage: number;
  model: string;
  response_time_ms: number;
  reply_source?: string;
  used_llm?: number;
  plan_mode?: string | null;
  reason_if_bypassed?: string | null;
  used_first_llm?: number;
  used_second_llm?: number;
  reply_renderer?: string;
  prompt_profile?: string;
  first_customer_visible_reply_ms?: number | null;
  lookup_ack_sent_ms?: number | null;
  queue_wait_ms?: number | null;
  channel_id?: number | null;
  matched_intent?: string | null;
  route_source?: string | null;
  selected_scenario?: string | null;
  route_confidence?: number | null;
  tools_available_json?: string | null;
  response_source_trace?: string | null;
  phase1_config_ref?: string | null;
};

export function createAiLog(data: CreateAiLogInput): AiLog {
  try {
    const result = db
      .prepare(
        `
      INSERT INTO ai_logs (contact_id, message_id, brand_id, prompt_summary, knowledge_hits, tools_called, transfer_triggered, transfer_reason, result_summary, token_usage, model, response_time_ms, reply_source, used_llm, plan_mode, reason_if_bypassed, used_first_llm, used_second_llm, reply_renderer, prompt_profile, first_customer_visible_reply_ms, lookup_ack_sent_ms, queue_wait_ms, channel_id, matched_intent, route_source, selected_scenario, route_confidence, tools_available_json, response_source_trace, phase1_config_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        data.contact_id || null,
        data.message_id || null,
        data.brand_id || null,
        data.prompt_summary,
        JSON.stringify(data.knowledge_hits),
        JSON.stringify(data.tools_called),
        data.transfer_triggered ? 1 : 0,
        data.transfer_reason || null,
        data.result_summary,
        data.token_usage,
        data.model,
        data.response_time_ms,
        data.reply_source ?? "",
        data.used_llm ?? 0,
        data.plan_mode ?? null,
        data.reason_if_bypassed ?? null,
        data.used_first_llm ?? 0,
        data.used_second_llm ?? 0,
        data.reply_renderer ?? "",
        data.prompt_profile ?? "",
        data.first_customer_visible_reply_ms ?? null,
        data.lookup_ack_sent_ms ?? null,
        data.queue_wait_ms ?? null,
        data.channel_id ?? null,
        data.matched_intent ?? null,
        data.route_source ?? null,
        data.selected_scenario ?? null,
        data.route_confidence ?? null,
        data.tools_available_json ?? null,
        data.response_source_trace ?? null,
        data.phase1_config_ref ?? null
      );
    return db.prepare("SELECT * FROM ai_logs WHERE id = ?").get(Number(result.lastInsertRowid)) as AiLog;
  } catch (e) {
    console.error("[ai-logs-repo] createAiLog failed:", (e as Error)?.message || e);
    throw e;
  }
}

export function getAiLogs(contactId: number): AiLog[] {
  return db.prepare("SELECT * FROM ai_logs WHERE contact_id = ? ORDER BY created_at DESC LIMIT 50").all(contactId) as AiLog[];
}

export function getAiLogStats(
  startDate: string,
  endDate: string,
  brandId?: number
): {
  totalAiResponses: number;
  transferTriggered: number;
  avgResponseTime: number;
  toolCallCount: number;
  orderQueryCount: number;
  orderQuerySuccess: number;
  transferReasons: { reason: string; count: number }[];
} {
  const brandFilter = brandId ? " AND brand_id = ?" : "";
  const brandParam = brandId ? [brandId] : [];

  const stats = db
    .prepare(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN transfer_triggered = 1 THEN 1 ELSE 0 END) as transfers,
        AVG(response_time_ms) as avg_time,
        SUM(CASE WHEN tools_called != '[]' THEN 1 ELSE 0 END) as tool_calls
      FROM ai_logs
      WHERE created_at >= ? AND created_at <= ?${brandFilter}
    `
    )
    .get(startDate, endDate, ...brandParam) as any;

  const orderStats = db
    .prepare(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN result_summary LIKE '%found%' OR result_summary LIKE '%查到%' OR result_summary LIKE '%success%' THEN 1 ELSE 0 END) as success
      FROM ai_logs
      WHERE tools_called LIKE '%lookup_order%' AND created_at >= ? AND created_at <= ?${brandFilter}
    `
    )
    .get(startDate, endDate, ...brandParam) as any;

  const reasons = db
    .prepare(
      `
      SELECT transfer_reason as reason, COUNT(*) as count
      FROM ai_logs
      WHERE transfer_triggered = 1 AND transfer_reason IS NOT NULL AND created_at >= ? AND created_at <= ?${brandFilter}
      GROUP BY transfer_reason
      ORDER BY count DESC
      LIMIT 10
    `
    )
    .all(startDate, endDate, ...brandParam) as { reason: string; count: number }[];

  return {
    totalAiResponses: stats?.total || 0,
    transferTriggered: stats?.transfers || 0,
    avgResponseTime: Math.round(stats?.avg_time || 0),
    toolCallCount: stats?.tool_calls || 0,
    orderQueryCount: orderStats?.total || 0,
    orderQuerySuccess: orderStats?.success || 0,
    transferReasons: reasons,
  };
}
