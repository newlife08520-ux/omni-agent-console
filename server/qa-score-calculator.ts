/**
 * 內部 QA 評分：規則扣分，從 100 分起算。分數由系統算，qa_score_reason 可另由 LLM 摘要。
 */
export interface QaMetrics {
  violated_f2_rule: boolean;
  wrong_handoff: boolean;
  missing_handoff: boolean;
  hallucinated_info: boolean;
  repeated_question_count: number;
  requested_rating_in_wrong_state: boolean;
  resolved: boolean;
}

const DEDUCTIONS: Record<keyof QaMetrics, number> = {
  violated_f2_rule: 25,
  wrong_handoff: 15,
  missing_handoff: 30,
  hallucinated_info: 20,
  repeated_question_count: 8,
  requested_rating_in_wrong_state: 20,
  resolved: 0,
};

export function calculateQaScore(metrics: QaMetrics, reasonSummary?: string | null): { score: number; reason: string } {
  let score = 100;
  const reasons: string[] = [];
  if (metrics.violated_f2_rule) {
    score -= DEDUCTIONS.violated_f2_rule;
    reasons.push("退貨首輪先講其他平台");
  }
  if (metrics.missing_handoff) {
    score -= DEDUCTIONS.missing_handoff;
    reasons.push("該轉人工未轉");
  }
  if (metrics.wrong_handoff) {
    score -= DEDUCTIONS.wrong_handoff;
    reasons.push("不該轉人工卻轉");
  }
  if (metrics.hallucinated_info) {
    score -= DEDUCTIONS.hallucinated_info;
    reasons.push("知識不足亂答");
  }
  if (metrics.requested_rating_in_wrong_state) {
    score -= DEDUCTIONS.requested_rating_in_wrong_state;
    reasons.push("未解決就發評價邀請");
  }
  if (metrics.repeated_question_count > 0) {
    const d = Math.min(metrics.repeated_question_count * DEDUCTIONS.repeated_question_count, 24);
    score -= d;
    reasons.push(`重複問資料${metrics.repeated_question_count}次`);
  }
  const final = Math.max(0, Math.min(100, score));
  const reason = (reasonSummary && reasonSummary.trim()) ? reasonSummary.trim() : (reasons.length ? reasons.join("；") : "");
  return { score: final, reason };
}
