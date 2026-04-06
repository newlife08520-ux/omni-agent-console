/**
 * Phase 1：依情境過濾 OpenAI tools（物理限制，非僅 prompt 提示）。
 */
import type OpenAI from "openai";
import type { AgentScenario, ScenarioOverrideEntry } from "./phase1-types";
import { orderLookupTools, humanHandoffTools, imageTools, productRecommendTools } from "../openai-tools";

const ALL_REGISTRY_TOOLS = [...orderLookupTools, ...humanHandoffTools, ...imageTools, ...productRecommendTools];
const TOOL_BY_NAME = new Map<string, OpenAI.Chat.Completions.ChatCompletionTool>(
  ALL_REGISTRY_TOOLS.map((t) => [(t.type === "function" ? t.function?.name : "") || "", t]).filter(([n]) => n) as [
    string,
    OpenAI.Chat.Completions.ChatCompletionTool,
  ][]
);

function toolNames(tools: OpenAI.Chat.Completions.ChatCompletionTool[]): string[] {
  return tools.map((t) => (t.type === "function" ? t.function?.name : "") || "").filter(Boolean);
}

const ORDER_NAMES = toolNames(orderLookupTools);
const HANDOFF_NAMES = toolNames(humanHandoffTools);
const IMAGE_NAMES = toolNames(imageTools);

export function filterToolsForScenario(
  scenario: AgentScenario,
  opts: { hasImageAssets: boolean; allowAfterSalesOrderVerify?: boolean }
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const handoff = [...humanHandoffTools];
  const allowOrderInAfterSales = opts.allowAfterSalesOrderVerify === true;

  switch (scenario) {
    case "ORDER_LOOKUP":
      return [...orderLookupTools, ...handoff, ...(opts.hasImageAssets ? imageTools : [])];
    case "AFTER_SALES": {
      const base = [...handoff];
      if (allowOrderInAfterSales) {
        return [...orderLookupTools, ...base, ...(opts.hasImageAssets ? imageTools : [])];
      }
      return [...base, ...(opts.hasImageAssets ? imageTools : [])];
    }
    case "PRODUCT_CONSULT":
      return [...handoff, ...productRecommendTools, ...(opts.hasImageAssets ? imageTools : [])];
    case "GENERAL":
    default:
      return [...handoff, ...productRecommendTools];
  }
}

export function listToolNamesForScenario(
  scenario: AgentScenario,
  opts: { hasImageAssets: boolean; allowAfterSalesOrderVerify?: boolean }
): string[] {
  return toolNames(filterToolsForScenario(scenario, opts));
}

/** scenario_overrides 之 tool_allow_extra / tool_deny_extra */
export function applyScenarioToolOverrides(
  tools: OpenAI.Chat.Completions.ChatCompletionTool[],
  scenario: AgentScenario,
  override?: ScenarioOverrideEntry
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  if (!override?.tool_allow_extra?.length && !override?.tool_deny_extra?.length) return tools;
  let out = [...tools];
  if (override.tool_deny_extra?.length) {
    const deny = new Set(override.tool_deny_extra);
    out = out.filter((t) => !deny.has((t.type === "function" ? t.function?.name : "") || ""));
  }
  if (override.tool_allow_extra?.length) {
    const have = new Set(toolNames(out));
    for (const n of override.tool_allow_extra) {
      if (have.has(n)) continue;
      const add = TOOL_BY_NAME.get(n);
      if (add) {
        out.push(add);
        have.add(n);
      }
    }
  }
  return out;
}

export { ORDER_NAMES, HANDOFF_NAMES, IMAGE_NAMES };
