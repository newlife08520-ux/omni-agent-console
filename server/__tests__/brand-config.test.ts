import { describe, it, expect } from "vitest";
import { parsePhase1BrandFlags } from "../services/phase1-brand-config";
import type { Brand } from "@shared/schema";

function makeBrand(json: string): Brand {
  return {
    id: 1,
    name: "test",
    slug: "test",
    logo_url: "",
    description: "",
    system_prompt: "",
    superlanding_merchant_no: "",
    superlanding_access_key: "",
    return_form_url: "",
    shopline_store_domain: "",
    shopline_api_token: "",
    created_at: "",
    phase1_agent_ops_json: json,
  } as Brand;
}

describe("parsePhase1BrandFlags", () => {
  it("空 JSON 全部預設 false", () => {
    const flags = parsePhase1BrandFlags(makeBrand(""));
    expect(flags.enabled).toBe(false);
    expect(flags.hybrid_router).toBe(false);
    expect(flags.ai_model_override).toBeUndefined();
  });

  it("完整 flags 解析含 ai_model_override", () => {
    const flags = parsePhase1BrandFlags(
      makeBrand(
        JSON.stringify({
          enabled: true,
          hybrid_router: true,
          scenario_isolation: true,
          tool_whitelist: true,
          trace_v2: true,
          ai_model_override: "anthropic:claude-sonnet-4-5",
        })
      )
    );
    expect(flags.enabled).toBe(true);
    expect(flags.ai_model_override).toBe("anthropic:claude-sonnet-4-5");
  });

  it("無效 JSON 安全回退", () => {
    const flags = parsePhase1BrandFlags(makeBrand("{broken"));
    expect(flags.enabled).toBe(false);
  });

  it("ai_model_override 空字串視為 undefined", () => {
    const flags = parsePhase1BrandFlags(
      makeBrand(
        JSON.stringify({
          enabled: true,
          ai_model_override: "  ",
        })
      )
    );
    expect(flags.enabled).toBe(true);
    expect(flags.ai_model_override).toBeUndefined();
  });
});

describe("scenario_overrides 解析", () => {
  it("解析 prompt_append", () => {
    const flags = parsePhase1BrandFlags(
      makeBrand(
        JSON.stringify({
          enabled: true,
          scenario_overrides: {
            ORDER_LOOKUP: { prompt_append: "本品牌查單後請主動告知預計到貨區間" },
            AFTER_SALES: { knowledge_mode: "minimal" },
          },
        })
      )
    );
    expect(flags.scenario_overrides?.ORDER_LOOKUP?.prompt_append).toContain("預計到貨");
    expect(flags.scenario_overrides?.AFTER_SALES?.knowledge_mode).toBe("minimal");
  });

  it("無效 scenario key 被忽略", () => {
    const flags = parsePhase1BrandFlags(
      makeBrand(
        JSON.stringify({
          enabled: true,
          scenario_overrides: {
            INVALID_SCENARIO: { prompt_append: "test" },
          },
        })
      )
    );
    expect(flags.scenario_overrides).toBeUndefined();
  });

  it("tool_allow_extra / tool_deny_extra", () => {
    const flags = parsePhase1BrandFlags(
      makeBrand(
        JSON.stringify({
          enabled: true,
          scenario_overrides: {
            AFTER_SALES: {
              tool_allow_extra: ["lookup_order_by_id"],
              tool_deny_extra: ["send_image_to_customer"],
            },
          },
        })
      )
    );
    expect(flags.scenario_overrides?.AFTER_SALES?.tool_allow_extra).toContain("lookup_order_by_id");
    expect(flags.scenario_overrides?.AFTER_SALES?.tool_deny_extra).toContain("send_image_to_customer");
  });
});
