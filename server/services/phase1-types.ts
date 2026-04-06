/** Phase 1 Multi-Brand Agent Ops — 情境與路由型別（後端共用） */

export type AgentScenario = "ORDER_LOOKUP" | "AFTER_SALES" | "PRODUCT_CONSULT" | "GENERAL";

export type RouteSource = "rule" | "llm" | "legacy_fallback" | "legacy_plan_map";

/** 知識載入：inherit 沿用組裝器預設 */
export type ScenarioKnowledgeMode = "inherit" | "none" | "minimal" | "full";

export interface ScenarioOverrideEntry {
  /** 附加在該情境 prompt 尾端（不取代全域／品牌區塊） */
  prompt_append?: string;
  knowledge_mode?: ScenarioKnowledgeMode;
  /** 在情境預設 whitelist 上額外允許的工具 function name */
  tool_allow_extra?: string[];
  /** 從當前列表移除的工具名 */
  tool_deny_extra?: string[];
}

/** 與 brands.phase1_agent_ops_json 對齊的鍵名（JSON） */
export interface Phase1BrandFlags {
  enabled: boolean;
  hybrid_router: boolean;
  scenario_isolation: boolean;
  tool_whitelist: boolean;
  trace_v2: boolean;
  /** 預留：售後情境下允許有限只讀查單（第一版 false） */
  allow_after_sales_order_verify?: boolean;
  /** 覆寫流程區塊內物流說明，避免甜點/非甜點硬編碼 */
  logistics_hint_override?: string;
  /** 逐情境輕量覆寫（不做新表） */
  scenario_overrides?: Partial<Record<AgentScenario, ScenarioOverrideEntry>>;
  /** 品牌級模型覆寫，格式同 AI_MODEL（如 openai:…、anthropic:…、google:gemini-…）；無前綴視為 OpenAI id */
  ai_model_override?: string;
}

export interface HybridRouteResult {
  selected_scenario: AgentScenario;
  matched_intent: string;
  route_source: RouteSource;
  confidence: number;
  used_llm_router: boolean;
}
