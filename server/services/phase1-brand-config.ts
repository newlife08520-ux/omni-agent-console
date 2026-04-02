/**
 * Phase 1：逐品牌 JSON 設定（brands.phase1_agent_ops_json）
 * flags 全關或未啟用時，呼叫端應走舊路徑。
 */
import type { Brand } from "@shared/schema";
import type { AgentScenario, Phase1BrandFlags, ScenarioOverrideEntry } from "./phase1-types";

const DEFAULT_FLAGS: Phase1BrandFlags = {
  enabled: false,
  hybrid_router: false,
  scenario_isolation: false,
  tool_whitelist: false,
  trace_v2: false,
  allow_after_sales_order_verify: false,
};

const SCENARIOS: AgentScenario[] = ["ORDER_LOOKUP", "AFTER_SALES", "PRODUCT_CONSULT", "GENERAL"];

function parseScenarioOverrides(raw: unknown): Phase1BrandFlags["scenario_overrides"] {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, ScenarioOverrideEntry>;
  const out: Partial<Record<AgentScenario, ScenarioOverrideEntry>> = {};
  for (const k of SCENARIOS) {
    const e = src[k];
    if (!e || typeof e !== "object") continue;
    const ent: ScenarioOverrideEntry = {};
    if (typeof e.prompt_append === "string") ent.prompt_append = e.prompt_append;
    if (e.knowledge_mode === "inherit" || e.knowledge_mode === "none" || e.knowledge_mode === "minimal" || e.knowledge_mode === "full") {
      ent.knowledge_mode = e.knowledge_mode;
    }
    if (Array.isArray(e.tool_allow_extra)) ent.tool_allow_extra = e.tool_allow_extra.map(String);
    if (Array.isArray(e.tool_deny_extra)) ent.tool_deny_extra = e.tool_deny_extra.map(String);
    if (Object.keys(ent).length) out[k] = ent;
  }
  return Object.keys(out).length ? out : undefined;
}

export function parsePhase1BrandFlags(brand: Brand | undefined): Phase1BrandFlags {
  if (!brand) return { ...DEFAULT_FLAGS };
  const raw = brand.phase1_agent_ops_json;
  if (!raw || !String(raw).trim()) return { ...DEFAULT_FLAGS };
  try {
    const o = JSON.parse(String(raw)) as Partial<Phase1BrandFlags> & { scenario_overrides?: unknown };
    return {
      enabled: !!o.enabled,
      hybrid_router: !!o.hybrid_router,
      scenario_isolation: !!o.scenario_isolation,
      tool_whitelist: !!o.tool_whitelist,
      trace_v2: !!o.trace_v2,
      allow_after_sales_order_verify: !!o.allow_after_sales_order_verify,
      logistics_hint_override:
        typeof o.logistics_hint_override === "string" ? o.logistics_hint_override : undefined,
      scenario_overrides: parseScenarioOverrides(o.scenario_overrides),
    };
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

export function isPhase1Active(flags: Phase1BrandFlags): boolean {
  return flags.enabled === true;
}
