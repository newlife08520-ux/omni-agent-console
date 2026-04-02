import type { HybridRouteResult, Phase1BrandFlags } from "./phase1-types";

/** 與 ai-reply 寫入 ai_logs 一致，供取證腳本重用 */
export function buildPhase1AiLogExtras(args: {
  phase1Flags: Phase1BrandFlags;
  phase1Route: HybridRouteResult | null;
  channelId: number | null | undefined;
  toolsAvailableNames: string[];
  replySource: string;
}): Record<string, unknown> {
  if (!args.phase1Flags.enabled || !args.phase1Flags.trace_v2 || !args.phase1Route) return {};
  return {
    channel_id: args.channelId ?? null,
    matched_intent: args.phase1Route.matched_intent,
    route_source: args.phase1Route.route_source,
    selected_scenario: args.phase1Route.selected_scenario,
    route_confidence: args.phase1Route.confidence,
    tools_available_json: JSON.stringify(args.toolsAvailableNames),
    response_source_trace: args.replySource,
    phase1_config_ref: JSON.stringify({
      v: 1.5,
      hybrid_router: args.phase1Flags.hybrid_router,
      scenario_isolation: args.phase1Flags.scenario_isolation,
      tool_whitelist: args.phase1Flags.tool_whitelist,
      has_scenario_overrides: !!args.phase1Flags.scenario_overrides,
    }),
  };
}
