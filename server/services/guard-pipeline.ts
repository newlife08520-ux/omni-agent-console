/**
 * 主 LLM 回覆後：長度 → 禁推銷 → 官方渠道反問 → 跨平台推責話術。
 */
import type { ReplyPlanMode } from "../reply-plan-builder";
import { enforceOutputGuard } from "../phase2-output";
import { runPostGenerationGuard, runOfficialChannelGuard, runGlobalPlatformGuard } from "../content-guard";
import { recordGuardHit, type GuardRuleId } from "../content-guard-stats";
import type { PostGenerationGuardContext } from "../content-guard";

export function runPostGenerationPipeline(params: {
  rawReply: string | null | undefined;
  planMode: ReplyPlanMode;
  productScope: string | null;
  channelId?: number | null;
  toolCallsMade?: string[];
  /** Phase 106.11：供 output_guard reply-trace */
  contactId?: number | null;
}): string | null | undefined {
  if (params.rawReply == null) return params.rawReply;
  const trimmed = params.rawReply.trim();
  if (!trimmed) return params.rawReply;

  let reply = enforceOutputGuard(trimmed, params.planMode, {
    contactId: params.contactId ?? undefined,
  });

  if (reply.trim()) {
    const guardContext: PostGenerationGuardContext = {
      toolCallsMade: params.toolCallsMade ?? [],
    };
    const guardResult = runPostGenerationGuard(reply, params.planMode, params.productScope, guardContext);
    if (!guardResult.pass) {
      const useCleaned = guardResult.cleaned && guardResult.cleaned.trim();
      reply = useCleaned ? guardResult.cleaned : "????????????????????";
      const outcome = useCleaned ? "cleaned" : "fallback";
      for (const r of (guardResult.reason || "").split(";").filter(Boolean)) {
        recordGuardHit(r as GuardRuleId, outcome);
      }
    }
  }

  if (reply.trim() && params.channelId) {
    const officialGuard = runOfficialChannelGuard(reply);
    if (!officialGuard.pass) {
      const useCleaned = officialGuard.cleaned && officialGuard.cleaned.trim();
      reply = useCleaned ? officialGuard.cleaned : "??????????????";
      recordGuardHit("official_channel_forbidden", useCleaned ? "cleaned" : "fallback");
    }
  }

  if (reply.trim()) {
    const globalPlatformGuard = runGlobalPlatformGuard(reply);
    if (!globalPlatformGuard.pass) {
      const useCleaned = globalPlatformGuard.cleaned && globalPlatformGuard.cleaned.trim();
      reply = useCleaned ? globalPlatformGuard.cleaned : "??????????????";
      recordGuardHit("global_platform_forbidden", useCleaned ? "cleaned" : "fallback");
    }
  }

  return reply;
}
