/**
 * 留言風險與導流規則（五桶）：兩階段判定
 * 第一階段：收集所有命中的規則
 * 第二階段：依決策邏輯選出最終規則（售後優先、白名單可擋 direct_hide、灰區不覆蓋高風險）
 */
import db from "./db";
import type { MetaCommentRiskRule, MetaCommentRiskRuleBucket } from "@shared/schema";

const BUCKET_ORDER: MetaCommentRiskRuleBucket[] = ["hide_and_route", "direct_hide", "route_only", "gray_area", "whitelist"];

/** 強售後詞：僅當命中此類詞時，hide_and_route 才優先於白名單；且含此類詞的句子不得判為 gray_area。長期可抽成 DB/後台，見 docs/DECISION_RULES_FUTURE.md */
const STRONG_AFTER_SALE_KEYWORDS = [
  "訂單", "退款", "退貨", "沒收到", "漏寄", "過敏", "瑕疵", "壞掉", "發票", "改地址", "取消", "扣款", "物流延遲",
  "還沒到", "寄錯", "破損", "換貨", "退訂", "爭議", "客訴", "賠償", "品質",
];

function bucketOrderValue(b: string): number {
  const i = BUCKET_ORDER.indexOf(b as MetaCommentRiskRuleBucket);
  return i >= 0 ? i : 99;
}

function messageContainsStrongAfterSale(msg: string): boolean {
  const lower = msg.trim();
  if (!lower) return false;
  return STRONG_AFTER_SALE_KEYWORDS.some((kw) => lower.includes(kw));
}

export function getRiskRules(filters: {
  brand_id?: number | null;
  bucket?: MetaCommentRiskRuleBucket | null;
  page_id?: string | null;
  enabled?: number | null;
  /** 搜尋規則名稱或關鍵字（LIKE %q%） */
  q?: string | null;
}): MetaCommentRiskRule[] {
  let sql = "SELECT * FROM meta_comment_risk_rules WHERE 1=1";
  const params: (number | string)[] = [];
  if (filters.brand_id != null) {
    sql += " AND (brand_id IS NULL OR brand_id = ?)";
    params.push(filters.brand_id);
  }
  if (filters.bucket) {
    sql += " AND rule_bucket = ?";
    params.push(filters.bucket);
  }
  if (filters.page_id != null && filters.page_id !== "") {
    sql += " AND (page_id IS NULL OR page_id = ?)";
    params.push(filters.page_id);
  }
  if (filters.enabled !== undefined && filters.enabled !== null) {
    sql += " AND enabled = ?";
    params.push(filters.enabled ? 1 : 0);
  }
  if (filters.q != null && String(filters.q).trim() !== "") {
    const like = `%${String(filters.q).trim()}%`;
    sql += " AND (rule_name LIKE ? OR keyword_pattern LIKE ?)";
    params.push(like, like);
  }
  sql += " ORDER BY CASE rule_bucket WHEN 'hide_and_route' THEN 0 WHEN 'direct_hide' THEN 1 WHEN 'route_only' THEN 2 WHEN 'gray_area' THEN 3 WHEN 'whitelist' THEN 4 ELSE 5 END, priority DESC, id";
  const rows = db.prepare(sql).all(...params) as MetaCommentRiskRule[];
  return rows;
}

/** 單條規則的動作摘要文案（供列表顯示） */
export function getRuleActionSummary(r: MetaCommentRiskRule): string {
  const parts: string[] = [];
  if (r.action_reply) parts.push("回覆");
  if (r.action_hide) parts.push("隱藏");
  if (r.action_route_line) {
    parts.push(r.route_line_type === "after_sale" ? "導售後 LINE" : "導一般 LINE");
  }
  if (r.action_mark_to_human) parts.push("待人工");
  if (parts.length === 0) {
    const bucket = r.rule_bucket;
    if (bucket === "whitelist") return "白名單豁免";
    if (bucket === "direct_hide") return "直接隱藏";
    if (bucket === "gray_area") return "灰區觀察";
    if (bucket === "hide_and_route") return "安撫+隱藏+導LINE";
    if (bucket === "route_only") return "只導 LINE";
  }
  return parts.join(" + ") || "—";
}

export function getRiskRule(id: number): MetaCommentRiskRule | undefined {
  return db.prepare("SELECT * FROM meta_comment_risk_rules WHERE id = ?").get(id) as MetaCommentRiskRule | undefined;
}

export function createRiskRule(data: {
  rule_name?: string;
  rule_bucket: MetaCommentRiskRuleBucket;
  keyword_pattern: string;
  match_type?: "contains" | "exact" | "regex";
  priority?: number;
  enabled?: number;
  brand_id?: number | null;
  page_id?: string | null;
  action_reply?: number;
  action_hide?: number;
  action_route_line?: number;
  route_line_type?: "general" | "after_sale" | "none" | null;
  action_mark_to_human?: number;
  action_use_template_id?: number | null;
  notes?: string | null;
}): MetaCommentRiskRule {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO meta_comment_risk_rules (rule_name, rule_bucket, keyword_pattern, match_type, priority, enabled, brand_id, page_id, action_reply, action_hide, action_route_line, route_line_type, action_mark_to_human, action_use_template_id, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.rule_name ?? "",
    data.rule_bucket,
    data.keyword_pattern,
    data.match_type ?? "contains",
    data.priority ?? 0,
    data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
    data.brand_id ?? null,
    data.page_id ?? null,
    data.action_reply !== undefined ? (data.action_reply ? 1 : 0) : 0,
    data.action_hide !== undefined ? (data.action_hide ? 1 : 0) : 0,
    data.action_route_line !== undefined ? (data.action_route_line ? 1 : 0) : 0,
    data.route_line_type ?? null,
    data.action_mark_to_human !== undefined ? (data.action_mark_to_human ? 1 : 0) : 0,
    data.action_use_template_id ?? null,
    data.notes ?? null,
    now,
    now
  );
  return db.prepare("SELECT * FROM meta_comment_risk_rules ORDER BY id DESC LIMIT 1").get() as MetaCommentRiskRule;
}

export function updateRiskRule(id: number, data: Partial<MetaCommentRiskRule>): boolean {
  const cols: string[] = ["updated_at = ?"];
  const vals: unknown[] = [new Date().toISOString()];
  const set = (k: string, v: unknown) => { cols.push(`${k} = ?`); vals.push(v); };
  if (data.rule_name !== undefined) set("rule_name", data.rule_name);
  if (data.rule_bucket !== undefined) set("rule_bucket", data.rule_bucket);
  if (data.keyword_pattern !== undefined) set("keyword_pattern", data.keyword_pattern);
  if (data.match_type !== undefined) set("match_type", data.match_type);
  if (data.priority !== undefined) set("priority", data.priority);
  if (data.enabled !== undefined) set("enabled", data.enabled ? 1 : 0);
  if (data.brand_id !== undefined) set("brand_id", data.brand_id);
  if (data.page_id !== undefined) set("page_id", data.page_id);
  if (data.action_reply !== undefined) set("action_reply", data.action_reply ? 1 : 0);
  if (data.action_hide !== undefined) set("action_hide", data.action_hide ? 1 : 0);
  if (data.action_route_line !== undefined) set("action_route_line", data.action_route_line ? 1 : 0);
  if (data.route_line_type !== undefined) set("route_line_type", data.route_line_type);
  if (data.action_mark_to_human !== undefined) set("action_mark_to_human", data.action_mark_to_human ? 1 : 0);
  if (data.action_use_template_id !== undefined) set("action_use_template_id", data.action_use_template_id);
  if (data.notes !== undefined) set("notes", data.notes);
  if (cols.length <= 1) return true;
  vals.push(id);
  db.prepare(`UPDATE meta_comment_risk_rules SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

export function deleteRiskRule(id: number): boolean {
  const r = db.prepare("DELETE FROM meta_comment_risk_rules WHERE id = ?").run(id);
  return r.changes > 0;
}

function matchMessage(msg: string, pattern: string, matchType: string): boolean {
  const text = msg.trim();
  if (!pattern) return false;
  if (matchType === "exact") return text === pattern.trim();
  if (matchType === "regex") {
    try {
      return new RegExp(pattern).test(text);
    } catch {
      return text.includes(pattern);
    }
  }
  return text.includes(pattern);
}

export interface RiskRuleMatchResult {
  matched_rule_id: number;
  matched_rule_bucket: MetaCommentRiskRuleBucket;
  matched_keyword: string;
  action_reply: number;
  action_hide: number;
  action_route_line: number;
  route_line_type: "general" | "after_sale" | null;
  action_mark_to_human: number;
  action_use_template_id: number | null;
  rule_name: string;
}

/** 單一命中候選（第一階段收集） */
export interface RiskRuleMatchCandidate {
  rule_id: number;
  rule_bucket: MetaCommentRiskRuleBucket;
  keyword_pattern: string;
  priority: number;
  rule_name: string;
}

/** 兩階段評估結果（供測試器與除錯） */
export interface RiskRuleEvaluationResult {
  matches: RiskRuleMatchCandidate[];
  final: RiskRuleMatchResult | null;
  reason: string;
  /** 給營運看的決策摘要：命中桶、關鍵字、最終決策、原因 */
  decisionSummary: string;
}

/** 第一階段：收集所有命中的規則（不 return 第一個） */
function collectAllMatches(msg: string, rules: MetaCommentRiskRule[], pageId?: string | null): RiskRuleMatchCandidate[] {
  const out: RiskRuleMatchCandidate[] = [];
  for (const r of rules) {
    if (r.page_id != null && r.page_id !== "" && pageId !== r.page_id) continue;
    if (!matchMessage(msg, r.keyword_pattern, r.match_type)) continue;
    out.push({
      rule_id: r.id,
      rule_bucket: r.rule_bucket,
      keyword_pattern: r.keyword_pattern,
      priority: r.priority,
      rule_name: r.rule_name,
    });
  }
  return out;
}

function ruleToResult(r: MetaCommentRiskRule): RiskRuleMatchResult {
  return {
    matched_rule_id: r.id,
    matched_rule_bucket: r.rule_bucket,
    matched_keyword: r.keyword_pattern,
    action_reply: r.action_reply,
    action_hide: r.action_hide,
    action_route_line: r.action_route_line,
    route_line_type: r.route_line_type === "general" || r.route_line_type === "after_sale" ? r.route_line_type : null,
    action_mark_to_human: r.action_mark_to_human,
    action_use_template_id: r.action_use_template_id,
    rule_name: r.rule_name,
  };
}

/**
 * 決策原則（明文化）：
 * A. 真正售後/訂單/權益（強售後詞）→ 優先於一般白名單；弱售後詞+正常詢問 → 走白名單
 * B. 白名單用途是避免正常詢問被 direct_hide 誤殺（A-1 雙意圖句保護）
 * C. gray_area 不得壓過強售後詞（A-3）
 * D. direct_hide 僅在無白名單時採用；同句有真需求（白名單）則不 direct_hide
 * E. direct_hide 與 route_only 同時命中時：維持版面乾淨優先，取 direct_hide
 */
function decideFinalRule(
  matches: RiskRuleMatchCandidate[],
  rulesById: Map<number, MetaCommentRiskRule>,
  msg: string
): { final: RiskRuleMatchResult | null; reason: string; decisionSummary: string } {
  const bucketsHit = [...new Set(matches.map((m) => m.rule_bucket))];
  const keywordsHit = [...new Set(matches.map((m) => m.keyword_pattern))];

  if (matches.length === 0) {
    return {
      final: null,
      reason: "未命中任何規則，走一般 AI",
      decisionSummary: "命中規則桶：無｜命中關鍵字：無｜最終決策：一般 AI｜決策原因：未命中任何規則",
    };
  }
  const byBucket = {
    hide_and_route: matches.filter((m) => m.rule_bucket === "hide_and_route").sort((a, b) => b.priority - a.priority),
    direct_hide: matches.filter((m) => m.rule_bucket === "direct_hide").sort((a, b) => b.priority - a.priority),
    whitelist: matches.filter((m) => m.rule_bucket === "whitelist").sort((a, b) => b.priority - a.priority),
    route_only: matches.filter((m) => m.rule_bucket === "route_only").sort((a, b) => b.priority - a.priority),
    gray_area: matches.filter((m) => m.rule_bucket === "gray_area").sort((a, b) => b.priority - a.priority),
  };

  // 原則 A-2：hide_and_route 僅在「至少命中強售後詞」時才優先於白名單；否則走白名單避免誤殺正常詢問
  const hasStrongAfterSale = messageContainsStrongAfterSale(msg);
  if (byBucket.hide_and_route.length > 0) {
    if (byBucket.whitelist.length > 0 && !hasStrongAfterSale) {
      // 僅弱售後詞（如單純「客服」）且整句為正常詢問 → 不走售後流程
      const chosen = byBucket.whitelist[0];
      const rule = rulesById.get(chosen.rule_id);
      if (rule) {
        const reason = `同時命中白名單與售後類規則，但未含強售後詞且為正常詢問，避免誤判，採用白名單：${chosen.rule_name}（${chosen.keyword_pattern}）`;
        const summary = `命中規則桶：${bucketsHit.join("、")}｜命中關鍵字：${keywordsHit.join("、")}｜最終決策：白名單豁免｜決策原因：${reason}`;
        return { final: ruleToResult(rule), reason, decisionSummary: summary };
      }
    }
    const chosen = byBucket.hide_and_route[0];
    const rule = rulesById.get(chosen.rule_id);
    if (rule) {
      const reason = byBucket.whitelist.length > 0
        ? `同時命中白名單與售後／訂單類規則，依原則 A 強售後詞優先，採用：${chosen.rule_name}（${chosen.keyword_pattern}）`
        : `命中隱藏+導LINE（售後／訂單優先），採用：${chosen.rule_name}（${chosen.keyword_pattern}）`;
      const summary = `命中規則桶：${bucketsHit.join("、")}｜命中關鍵字：${keywordsHit.join("、")}｜最終決策：隱藏+導LINE｜決策原因：${reason}`;
      return { final: ruleToResult(rule), reason, decisionSummary: summary };
    }
  }
  // 原則 A-1、D：direct_hide 僅在無白名單時採用；同句命中白名單 = 有真需求，不 direct_hide（避免誤殺雙意圖句）
  if (byBucket.direct_hide.length > 0 && byBucket.whitelist.length === 0) {
    const chosen = byBucket.direct_hide[0];
    const rule = rulesById.get(chosen.rule_id);
    if (rule) {
      const reason = byBucket.route_only.length > 0
        ? `同時命中直接隱藏與只導LINE，依原則 E 維持版面乾淨優先，採用：${chosen.rule_name}（${chosen.keyword_pattern}）`
        : `命中直接隱藏且無白名單，採用：${chosen.rule_name}（${chosen.keyword_pattern}）`;
      const summary = `命中規則桶：${bucketsHit.join("、")}｜命中關鍵字：${keywordsHit.join("、")}｜最終決策：直接隱藏｜決策原因：${reason}`;
      return { final: ruleToResult(rule), reason, decisionSummary: summary };
    }
  }
  // A-1：direct_hide + whitelist 同時命中時改走白名單，避免誤殺雙意圖句。技術債：未來可補強負評詞/問句型，見 docs/DECISION_RULES_FUTURE.md
  if (byBucket.whitelist.length > 0) {
    const chosen = byBucket.whitelist[0];
    const rule = rulesById.get(chosen.rule_id);
    if (rule) {
      const reason = byBucket.direct_hide.length > 0
        ? `命中競品詞但同時為正常詢問，避免誤殺，採用白名單：${chosen.rule_name}（${chosen.keyword_pattern}）`
        : `命中白名單，採用：${chosen.rule_name}（${chosen.keyword_pattern}）`;
      const summary = `命中規則桶：${bucketsHit.join("、")}｜命中關鍵字：${keywordsHit.join("、")}｜最終決策：白名單豁免｜決策原因：${reason}`;
      return { final: ruleToResult(rule), reason, decisionSummary: summary };
    }
  }
  if (byBucket.route_only.length > 0) {
    const chosen = byBucket.route_only[0];
    const rule = rulesById.get(chosen.rule_id);
    if (rule) {
      const summary = `命中規則桶：${bucketsHit.join("、")}｜命中關鍵字：${keywordsHit.join("、")}｜最終決策：只導LINE｜決策原因：命中只導LINE，採用：${chosen.rule_name}（${chosen.keyword_pattern}）`;
      return { final: ruleToResult(rule), reason: `命中只導LINE，採用：${chosen.rule_name}（${chosen.keyword_pattern}）`, decisionSummary: summary };
    }
  }
  // 原則 A-3：句中含強售後詞不得判為 gray_area
  if (byBucket.gray_area.length > 0 && hasStrongAfterSale) {
    return {
      final: null,
      reason: "句中含強售後詞（訂單／退款／過敏等），不進入灰區，走一般 AI",
      decisionSummary: `命中規則桶：${bucketsHit.join("、")}｜命中關鍵字：${keywordsHit.join("、")}｜最終決策：一般 AI｜決策原因：句中含強售後詞，不進入灰區`,
    };
  }
  if (byBucket.gray_area.length > 0) {
    const chosen = byBucket.gray_area[0];
    const rule = rulesById.get(chosen.rule_id);
    if (rule) {
      const summary = `命中規則桶：${bucketsHit.join("、")}｜命中關鍵字：${keywordsHit.join("、")}｜最終決策：灰區觀察｜決策原因：命中灰區觀察，採用：${chosen.rule_name}（${chosen.keyword_pattern}）`;
      return { final: ruleToResult(rule), reason: `命中灰區觀察，採用：${chosen.rule_name}（${chosen.keyword_pattern}）`, decisionSummary: summary };
    }
  }
  return {
    final: null,
    reason: "候選規則中無可採用桶別，走一般 AI",
    decisionSummary: `命中規則桶：${bucketsHit.join("、")}｜命中關鍵字：${keywordsHit.join("、")}｜最終決策：一般 AI｜決策原因：候選中無可採用桶別`,
  };
}

/** 兩階段評估：收集所有命中 → 決策選出最終規則（供測試器與除錯） */
export function evaluateRiskRulesWithCandidates(
  message: string,
  brandId?: number | null,
  pageId?: string | null
): RiskRuleEvaluationResult {
  const msg = (message || "").trim();
  if (!msg) return { matches: [], final: null, reason: "空訊息", decisionSummary: "命中規則桶：無｜命中關鍵字：無｜最終決策：一般 AI｜決策原因：空訊息" };
  const rules = getRiskRules({ brand_id: brandId ?? null });
  const enabled = rules.filter((r) => r.enabled !== 0);
  const rulesById = new Map(enabled.map((r) => [r.id, r]));
  const matches = collectAllMatches(msg, enabled, pageId ?? null);
  const { final, reason, decisionSummary } = decideFinalRule(matches, rulesById, msg);
  return { matches, final, reason, decisionSummary };
}

/** 回傳最終採用規則（供 auto-execute 使用，相容原介面） */
export function evaluateRiskRules(message: string, brandId?: number | null, pageId?: string | null): RiskRuleMatchResult | null {
  const { final } = evaluateRiskRulesWithCandidates(message, brandId, pageId);
  return final;
}

export { BUCKET_ORDER };
