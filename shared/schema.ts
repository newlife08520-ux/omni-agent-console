export type UserRole = "super_admin" | "marketing_manager" | "cs_agent";
export type ChannelPlatform = "line" | "messenger";

/** 指派狀態：未分配 / 已分配 / 已改派 / 待人工 / 非上班時段暫停 */
export type AssignmentStatus = "unassigned" | "assigned" | "reassigned" | "waiting_human" | "paused_off_hours";

/** 指派方式：自動 / 手動 / 改派 */
export type AssignmentMethod = "auto" | "manual" | "reassign";

/** 分配紀錄動作類型 */
export type AssignmentLogActionType = "auto_assign" | "manual_assign" | "reassign_timeout" | "reassign_offline" | "restore_to_queue";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  created_at: string;
  is_online?: number;
  is_available?: number;
  last_active_at?: string | null;
  avatar_url?: string | null;
}

export interface Brand {
  id: number;
  name: string;
  slug: string;
  logo_url: string;
  description: string;
  system_prompt: string;
  superlanding_merchant_no: string;
  superlanding_access_key: string;
  return_form_url: string;
  shopline_store_domain: string;
  shopline_api_token: string;
  created_at: string;
}

export interface Channel {
  id: number;
  brand_id: number;
  platform: ChannelPlatform;
  channel_name: string;
  bot_id: string;
  access_token: string;
  channel_secret: string;
  is_active: number;
  is_ai_enabled: number;
  created_at: string;
}

export interface ChannelWithBrand extends Channel {
  brand_name?: string;
  brand_slug?: string;
}

export type AgentBrandRole = "primary" | "backup";

export interface AgentBrandAssignment {
  user_id: number;
  brand_id: number;
  role: AgentBrandRole;
  created_at: string;
}

export type ContactStatus =
  | "pending"
  | "processing"
  | "resolved"
  | "ai_handling"
  | "awaiting_human"
  | "high_risk"
  | "closed"
  | "new_case"
  | "pending_info"
  | "pending_order_id"
  | "assigned"
  | "waiting_customer"
  | "resolved_observe"
  | "reopened";

/** 與 DB contacts.status CHECK 一致，指派客服時會寫入 assigned */
export const CONTACT_STATUS_ALLOWED: ContactStatus[] = [
  "pending", "processing", "resolved", "ai_handling", "awaiting_human", "high_risk", "closed",
  "new_case", "pending_info", "pending_order_id", "assigned", "waiting_customer", "resolved_observe", "reopened",
];

/** 案件狀態（流程）：主狀態 dropdown 用 */
export const CASE_STATUS_VALUES: ContactStatus[] = [
  "pending", "processing", "waiting_customer", "resolved_observe", "closed", "reopened",
];
/** 系統標記／案件屬性：與案件狀態分開展示，同一 status 欄位 */
export const SYSTEM_MARK_VALUES: ContactStatus[] = [
  "awaiting_human", "new_case", "assigned", "pending_info", "pending_order_id", "high_risk",
];

export type IssueType = "order_inquiry" | "product_consult" | "return_refund" | "complaint" | "order_modify" | "general" | "other";
export type OrderSource = "superlanding" | "shopline" | "unknown";

/** 案件意圖強度：高=明確需求，中=一般詢問，低=亂點/無回應 */
export type IntentLevel = "high" | "medium" | "low";

/** 客戶提供的編號類型（訂單/金流/物流/電話/待確認） */
export type OrderNumberType = "order_id" | "payment_id" | "logistics_id" | "phone" | "unknown" | "pending_review";

export interface Contact {
  id: number;
  platform: string;
  platform_user_id: string;
  display_name: string;
  avatar_url: string | null;
  needs_human: number;
  is_pinned: number;
  status: ContactStatus;
  tags: string;
  vip_level: number;
  order_count: number;
  total_spent: number;
  cs_rating: number | null;
  ai_rating: number | null;
  last_message_at: string | null;
  created_at: string;
  brand_id: number | null;
  channel_id: number | null;
  issue_type: IssueType | null;
  order_source: OrderSource | null;
  /** 目前負責的客服 user id */
  assigned_agent_id: number | null;
  /** 本次指派時間（每次改派更新） */
  assigned_at: string | null;
  /** 意圖強度 */
  intent_level: IntentLevel | null;
  /** 最後一次提供的編號類型 */
  order_number_type: OrderNumberType | null;
  /** 首次分配給誰、何時 */
  first_assigned_at: string | null;
  /** 結案時間、結案人 */
  closed_at: string | null;
  closed_by_agent_id: number | null;
  /** 案件優先級 1=最高 */
  case_priority: number | null;
  /** 最後一次人工回覆時間（SLA/逾時重分配用） */
  last_human_reply_at: string | null;
  /** 已重新分配次數 */
  reassign_count: number | null;
  /** 指派狀態 */
  assignment_status: AssignmentStatus | null;
  /** 指派方式 */
  assignment_method: AssignmentMethod | null;
  /** 是否待分配（需人工但尚未派給任何人） */
  needs_assignment: number | null;
  /** 指派/轉人工原因（可選） */
  assignment_reason: string | null;
  /** SLA 首次回覆截止時間（可選） */
  response_sla_deadline_at: string | null;
  /** 流程用：解決狀態 open | awaiting_customer | awaiting_human | resolved | closed */
  resolution_status?: string | null;
  /** 流程用：正在等客戶提供什麼 */
  waiting_for_customer?: string | null;
  /** 轉人工原因代碼 */
  human_reason?: string | null;
  /** 退換貨階段 0|1|2|3 */
  return_stage?: number | null;
  /** 已發送評價邀請時間 */
  rating_invited_at?: string | null;
  /** 結案原因（idle_24h / manual / 等） */
  close_reason?: string | null;
  /** QA 規則分數 */
  qa_score?: number | null;
  /** QA 扣分原因摘要 */
  qa_score_reason?: string | null;
  /** Phase 2：已鎖定商品範圍（如 bag / sweet），回覆不得跨品類 */
  product_scope_locked?: string | null;
  /** 客戶目標鎖定：return | cancel | order_lookup | handoff | already_provided；鎖定期間不得推銷/跨品類 */
  customer_goal_locked?: string | null;
}


export interface ContactWithPreview extends Contact {
  last_message?: string;
  last_message_sender_type?: "user" | "ai" | "admin" | "system";
  brand_name?: string;
  channel_name?: string;
  assigned_agent_name?: string;
  assigned_agent_avatar_url?: string | null;
  /** 當前客服對此案件的標記：稍後處理 / 追蹤中（僅在 assigned_to_me 時回傳） */
  my_flag?: "later" | "tracking" | null;
}

/** 客服線上狀態：順位、上班/午休/暫停、今日分配數、未結案數、最大對話數、是否參與自動分配 */
export interface AgentStatus {
  user_id: number;
  priority: number;
  on_duty: number;
  lunch_break: number;
  pause_new_cases: number;
  today_assigned_count: number;
  open_cases_count: number;
  work_start_time: string;
  work_end_time: string;
  lunch_start_time: string;
  lunch_end_time: string;
  updated_at: string;
  max_active_conversations: number;
  auto_assign_enabled: number;
}

/** 案件分配紀錄：首次分配、改派、結案人 */
export interface AssignmentRecord {
  id: number;
  contact_id: number;
  assigned_to_agent_id: number;
  assigned_at: string;
  assigned_by_agent_id: number | null;
  reassigned_from_agent_id: number | null;
  note: string | null;
  action_type?: AssignmentLogActionType | null;
  operator_user_id?: number | null;
}

export interface Message {
  id: number;
  contact_id: number;
  platform: string;
  sender_type: "user" | "ai" | "admin" | "system";
  content: string;
  message_type: "text" | "image" | "file";
  image_url: string | null;
  created_at: string;
}

export interface Setting {
  key: string;
  value: string;
}

/** 知識適用條件（metadata 化後使用） */
export type KnowledgeCategory = "sweet" | "bag" | "cleaning" | "skincare" | "all";
export type KnowledgeIntent = "shipping" | "return" | "product_qa" | "order_lookup" | "all";
export type KnowledgeTone = "factual" | "promo" | "operational";

export interface KnowledgeFile {
  id: number;
  filename: string;
  original_name: string;
  size: number;
  content: string | null;
  created_at: string;
  brand_id: number | null;
  /** 適用品類；空/null 視為 all */
  category?: string | null;
  /** 適用意圖；空/null 視為 all */
  intent?: string | null;
  /** JSON 陣列，例 ["order_lookup"]；空/null 表示全部允許 */
  allowed_modes?: string | null;
  /** JSON 陣列，例 ["handoff"]；這些 mode 下不注入 */
  forbidden_modes?: string | null;
  /** factual | promo | operational */
  tone?: string | null;
}

export interface ImageAsset {
  id: number;
  filename: string;
  original_name: string;
  display_name: string;
  description: string;
  keywords: string;
  size: number;
  mime_type: string;
  brand_id: number | null;
  created_at: string;
}

export interface TeamMember {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  created_at: string;
  avatar_url?: string | null;
  is_online?: number;
  is_available?: number;
  last_active_at?: string | null;
  max_active_conversations?: number;
  open_cases_count?: number;
  auto_assign_enabled?: number;
}

export interface MarketingRule {
  id: number;
  keyword: string;
  pitch: string;
  url: string;
  created_at: string;
  brand_id: number | null;
}

export interface OrderInfo {
  global_order_id: string;
  status: string;
  final_total_order_amount: number;
  product_list: string;
  buyer_name: string;
  buyer_phone: string;
  buyer_email: string;
  tracking_number: string;
  created_at: string;
  shipped_at?: string;
  order_created_at?: string;
  shipping_method?: string;
  payment_method?: string;
  address?: string;
  note?: string;
  source?: OrderSource;
}

/** 回覆來源：用於區分「有無進 LLM」與短路路徑（Phase 0 可觀測性） */
export type ReplySource =
  | "gate_skip"
  | "high_risk_short_circuit"
  | "safe_confirm_template"
  | "image_short_caption"
  | "image_dm_only"
  | "image_vision_first"
  | "return_form_first"
  | "off_topic_guard"
  | "llm"
  | "handoff"
  | "error";

export interface AiLog {
  id: number;
  contact_id: number | null;
  message_id: number | null;
  brand_id: number | null;
  prompt_summary: string;
  knowledge_hits: string;
  tools_called: string;
  transfer_triggered: number;
  transfer_reason: string | null;
  result_summary: string;
  token_usage: number;
  model: string;
  response_time_ms: number;
  created_at: string;
  /** Phase 0：回覆來源，便於篩選有無進 LLM */
  reply_source?: ReplySource | string | null;
  /** Phase 0：本輪是否曾呼叫 LLM */
  used_llm?: number | null;
  /** Phase 0：本輪 reply plan mode（若未走到 plan 則 null） */
  plan_mode?: string | null;
  /** Phase 0：未進 LLM 時簡短原因 */
  reason_if_bypassed?: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  message: string;
  user?: { id: number; username: string; display_name: string; role: string };
}

export interface AnalyticsData {
  kpi: {
    customerMessages: number;
    activeContacts: number;
    resolvedCount: number;
    completionRate: number | null;
    transferCount: number;
    transferRate: number | null;
    aiResolutionRate: number | null;
    aiHasData: boolean;
    orderQuerySuccessRate: number | null;
    orderQueryHasData: boolean;
    avgMessagesPerContact: number | null;
  };
  messageSplit: { name: string; value: number; pct: number }[];
  statusDistribution: { name: string; value: number }[];
  intentDistribution: { name: string; value: number; isEstimate: boolean }[];
  intentUnclassifiedPct: number;
  aiInsights: {
    painPoints: string[];
    suggestions: string[];
    hotProducts: { name: string; mentions: number }[];
    customerConcerns: { concern: string; count: number }[];
  };
  issueTypeDistribution: { name: string; value: number }[];
  transferReasons: { reason: string; count: number }[];
  platformDistribution: { name: string; value: number }[];
  topKeywords: { keyword: string; count: number }[];
  dailyVolume: { date: string; user: number; ai: number; admin: number }[];
}

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  pending: "待處理",
  processing: "處理中",
  resolved: "已解決",
  ai_handling: "AI處理中",
  awaiting_human: "待人工接手",
  high_risk: "高風險",
  closed: "已結案",
  new_case: "新案件",
  pending_info: "待補資訊",
  pending_order_id: "待訂單編號",
  assigned: "已分配",
  waiting_customer: "等待客戶回覆",
  resolved_observe: "已解決待觀察",
  reopened: "已重開",
};

export const INTENT_LEVEL_LABELS: Record<IntentLevel, string> = {
  high: "高意圖",
  medium: "中意圖",
  low: "低意圖",
};

export const ORDER_NUMBER_TYPE_LABELS: Record<OrderNumberType, string> = {
  order_id: "訂單編號",
  payment_id: "金流/交易編號",
  logistics_id: "物流單號",
  phone: "手機號碼",
  unknown: "未知",
  pending_review: "待人工確認",
};

export const CONTACT_STATUS_COLORS: Record<ContactStatus, { bg: string; dot: string }> = {
  pending: { bg: "bg-red-50 text-red-700", dot: "bg-red-500" },
  processing: { bg: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
  resolved: { bg: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  ai_handling: { bg: "bg-blue-50 text-blue-700", dot: "bg-blue-500" },
  awaiting_human: { bg: "bg-orange-50 text-orange-700", dot: "bg-orange-500" },
  high_risk: { bg: "bg-rose-50 text-rose-700", dot: "bg-rose-600" },
  closed: { bg: "bg-stone-50 text-stone-500", dot: "bg-stone-400" },
  new_case: { bg: "bg-sky-50 text-sky-700", dot: "bg-sky-500" },
  pending_info: { bg: "bg-yellow-50 text-yellow-700", dot: "bg-yellow-500" },
  pending_order_id: { bg: "bg-violet-50 text-violet-700", dot: "bg-violet-500" },
  assigned: { bg: "bg-indigo-50 text-indigo-700", dot: "bg-indigo-500" },
  waiting_customer: { bg: "bg-cyan-50 text-cyan-700", dot: "bg-cyan-500" },
  resolved_observe: { bg: "bg-emerald-50 text-emerald-600", dot: "bg-emerald-400" },
  reopened: { bg: "bg-rose-50 text-rose-600", dot: "bg-rose-500" },
};

export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  order_inquiry: "訂單查詢",
  product_consult: "商品諮詢",
  return_refund: "退貨退款",
  complaint: "客訴",
  order_modify: "訂單修改",
  general: "一般諮詢",
  other: "其他",
};

export const ISSUE_TYPE_COLORS: Record<IssueType, string> = {
  order_inquiry: "bg-blue-100 text-blue-700",
  product_consult: "bg-violet-100 text-violet-700",
  return_refund: "bg-rose-100 text-rose-700",
  complaint: "bg-red-100 text-red-700",
  order_modify: "bg-amber-100 text-amber-700",
  general: "bg-stone-100 text-stone-600",
  other: "bg-gray-100 text-gray-600",
};

export const ORDER_SOURCE_LABELS: Record<OrderSource, string> = {
  superlanding: "一頁商店",
  shopline: "SHOPLINE",
  unknown: "未知",
};

export const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "超級管理員",
  marketing_manager: "行銷經理",
  cs_agent: "客服人員",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  new_order: "新訂單",
  confirming: "確認中",
  confirmed: "已確認",
  awaiting_for_shipment: "待出貨",
  shipping: "出貨中",
  shipped: "已出貨",
  delay_handling: "延遲出貨",
  other: "其他",
  refunding: "退款中",
  refunded: "已退款",
  replacement: "換貨中",
  temp: "臨時",
  returned: "已退貨",
  pending: "待處理",
  canceled: "已取消",
};

// --- Meta 留言互動中心（公開留言分流） ---
export type MetaCommentIntent =
  | "product_inquiry"
  | "price_inquiry"
  | "where_to_buy"
  | "ingredient_effect"
  | "activity_engage"
  | "dm_guide"
  | "complaint"
  | "refund_after_sale"
  | "spam_competitor";

/** 分流結果：公開簡答 / 公開簡答+導商品 / 公開簡答+導 LINE / 安撫+導 LINE・人工 */
export type MetaCommentReplyFlowType = "public_only" | "product_link" | "line_redirect" | "comfort_line";

/** 商品判定來源 */
export type MetaDetectedProductSource = "post_mapping" | "post_keyword" | "comment_keyword" | "page_default" | "none";

/** 貼文標題顯示來源 */
export type MetaPostTitleSource = "graph_api" | "mapping" | "post_id";

/** 貼文偏好處理：導商品頁 / 導活動頁 / 優先導 LINE / 僅售後・人工 */
export type MetaPostPreferredFlow = "product_link" | "activity_link" | "line_redirect" | "support_only";

export type MetaCommentPriority = "normal" | "high" | "urgent";

/** 分派方式：手動 / 自動 / 規則 */
export type MetaCommentAssignmentMethod = "manual" | "auto" | "rule";

export interface MetaComment {
  id: number;
  brand_id: number | null;
  page_id: string;
  page_name: string | null;
  post_id: string;
  post_name: string | null;
  comment_id: string;
  commenter_id: string | null;
  commenter_name: string;
  message: string;
  created_at: string;
  replied_at: string | null;
  is_hidden: number;
  is_dm_sent: number;
  is_human_handled: number;
  contact_id: number | null;
  ai_intent: string | null;
  issue_type: string | null;
  priority: string | null;
  ai_suggest_hide: number;
  ai_suggest_human: number;
  reply_first: string | null;
  reply_second: string | null;
  tags: string;
  applied_rule_id: number | null;
  applied_template_id: number | null;
  applied_mapping_id: number | null;
  reply_link_source: string | null;
  is_simulated: number;
  assigned_agent_id: number | null;
  assigned_agent_name: string | null;
  assigned_agent_avatar_url: string | null;
  assignment_method: MetaCommentAssignmentMethod | null;
  assigned_at: string | null;
  /** 分類來源：rule = 規則關鍵字先擋，ai = 由 AI 分類 */
  classifier_source: "rule" | "ai" | null;
  /** 規則命中時記錄命中的關鍵字 */
  matched_rule_keyword: string | null;
  /** 分流結果：公開簡答 / 導商品 / 導 LINE / 安撫+導 LINE */
  reply_flow_type: MetaCommentReplyFlowType | null;
  reply_error: string | null;
  platform_error: string | null;
  auto_replied_at: string | null;
  auto_hidden_at: string | null;
  auto_routed_at: string | null;
  detected_product_name: string | null;
  detected_product_source: MetaDetectedProductSource | null;
  detected_post_title_source: MetaPostTitleSource | null;
  post_display_name: string | null;
  target_line_type: "general" | "after_sale" | null;
  target_line_value: string | null;
  hide_error: string | null;
  raw_webhook_payload: string | null;
  /** Phase 3：客服主狀態，由流程與 API 更新 */
  main_status: MetaCommentMainStatus | null;
  /** Phase 3：自動執行完成時間，用於防重複執行 */
  auto_execution_run_at: string | null;
  /** 留言風險與導流規則：命中的規則 ID */
  matched_risk_rule_id: number | null;
  /** 命中的規則桶：whitelist / direct_hide / hide_and_route / route_only / gray_area */
  matched_rule_bucket: string | null;
}

/** Phase 3：案件主狀態（含灰區、純隱藏完成） */
export type MetaCommentMainStatus =
  | "unhandled"      // 未處理
  | "pending_send"   // 待送出
  | "auto_replied"   // 已自動回覆
  | "human_replied" // 已人工回覆
  | "hidden"         // 已隱藏
  | "routed_line"   // 已導 LINE
  | "to_human"      // 待人工
  | "completed"      // 已完成
  | "failed"         // 執行失敗
  | "partial_success" // 部分成功
  | "gray_area"     // 灰區待觀察
  | "hidden_completed"; // 純負評隱藏後完成

/** 留言風險與導流規則（五桶） */
export type MetaCommentRiskRuleBucket = "whitelist" | "direct_hide" | "hide_and_route" | "route_only" | "gray_area";

export interface MetaCommentRiskRule {
  id: number;
  rule_name: string;
  rule_bucket: MetaCommentRiskRuleBucket;
  keyword_pattern: string;
  match_type: "contains" | "exact" | "regex";
  priority: number;
  enabled: number;
  brand_id: number | null;
  page_id: string | null;
  action_reply: number;
  action_hide: number;
  action_route_line: number;
  route_line_type: "general" | "after_sale" | "none" | null;
  action_mark_to_human: number;
  action_use_template_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaPageSettings {
  id: number;
  page_id: string;
  page_name: string | null;
  brand_id: number;
  line_general: string | null;
  line_after_sale: string | null;
  auto_hide_sensitive: number;
  auto_reply_enabled: number;
  auto_route_line_enabled: number;
  default_reply_template_id: number | null;
  default_sensitive_template_id: number | null;
  default_flow: MetaPostPreferredFlow | null;
  default_product_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaProductKeyword {
  id: number;
  brand_id: number | null;
  keyword: string;
  product_name: string;
  match_scope: "post" | "comment";
  created_at: string;
}

export interface MetaCommentTemplate {
  id: number;
  brand_id: number | null;
  category: string;
  name: string;
  reply_first: string;
  reply_second: string;
  reply_comfort: string;
  reply_dm_guide: string;
  /** 私訊版文案（留言用 reply_first/reply_second，私訊用 reply_private；可同文案或微調語氣） */
  reply_private?: string | null;
  tone_hint: string | null;
  created_at: string;
}

export interface MetaPostMapping {
  id: number;
  brand_id: number;
  page_id: string | null;
  page_name: string | null;
  post_id: string;
  post_name: string | null;
  product_name: string | null;
  primary_url: string | null;
  fallback_url: string | null;
  tone_hint: string | null;
  auto_comment_enabled: number;
  /** 此貼文偏好：導商品頁 / 導活動頁 / 優先導 LINE / 僅售後・人工 */
  preferred_flow: MetaPostPreferredFlow | null;
  created_at: string;
}

export type MetaCommentRuleType = "use_template" | "hide" | "send_dm" | "to_human" | "add_tag";

export interface MetaCommentRule {
  id: number;
  brand_id: number | null;
  page_id: string | null;
  post_id: string | null;
  priority: number;
  rule_type: MetaCommentRuleType;
  keyword_pattern: string;
  template_id: number | null;
  tag_value: string | null;
  enabled: number;
  created_at: string;
}

export const META_COMMENT_INTENT_LABELS: Record<string, string> = {
  product_inquiry: "商品詢問",
  price_inquiry: "價格詢問",
  where_to_buy: "下單/哪裡買",
  ingredient_effect: "成分/功效",
  activity_engage: "活動互動",
  dm_guide: "需要更多說明／導 LINE",
  complaint: "抱怨/客訴",
  refund_after_sale: "退款/售後",
  spam_competitor: "垃圾/競品/不雅",
};

export const META_COMMENT_CATEGORY_LABELS: Record<string, string> = {
  product_inquiry: "一般商品詢問",
  price_inquiry: "價格詢問",
  where_to_buy: "哪裡買/下單",
  ingredient_effect: "成分/功效",
  activity_engage: "活動留言",
  complaint: "抱怨/客訴",
  refund_after_sale: "退款/售後",
  dm_guide: "私訊導流",
  line_general: "LINE 一般協助型",
  line_after_sale: "LINE 售後／客訴型",
  line_promotion: "LINE 導購型",
};

/** 顯示用狀態（第一線友善） */
export const META_COMMENT_STATUS_DISPLAY: Record<string, string> = {
  unhandled: "待回覆",
  auto_replied: "已回覆",
  human: "建議轉客服處理",
  hidden: "已隱藏",
  urgent: "緊急案件／客訴優先",
  all: "全部",
};

/** 意圖顯示名稱（第一線看得懂） */
export const META_COMMENT_INTENT_DISPLAY: Record<string, string> = {
  product_inquiry: "商品詢問",
  price_inquiry: "問價格",
  where_to_buy: "哪裡買",
  ingredient_effect: "成分／功效",
  activity_engage: "活動互動",
  dm_guide: "建議導 LINE",
  complaint: "客訴",
  refund_after_sale: "售後／退款",
  spam_competitor: "垃圾／競品",
};
/** 分流結果顯示（建議處理方式） */
export const META_REPLY_FLOW_DISPLAY: Record<string, string> = {
  public_only: "公開簡答",
  product_link: "公開簡答＋導商品",
  line_redirect: "公開簡答＋導 LINE",
  comfort_line: "安撫＋導 LINE／人工",
};
