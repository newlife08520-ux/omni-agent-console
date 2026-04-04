import { describe, it, expect } from "vitest";
import { computePhase15HardRoute } from "../services/intent-router.service";
import {
  filterToolsForScenario,
  listToolNamesForScenario,
  applyScenarioToolOverrides,
} from "../services/tool-scenario-filter";

describe("computePhase15HardRoute", () => {
  it("單號 → ORDER_LOOKUP", () => {
    const r = computePhase15HardRoute("KBT58265");
    expect(r?.selected_scenario).toBe("ORDER_LOOKUP");
    expect(r?.route_source).toBe("rule");
  });

  it("退貨 → AFTER_SALES", () => {
    const r = computePhase15HardRoute("我要退貨");
    expect(r?.selected_scenario).toBe("AFTER_SALES");
  });

  it("規格 → PRODUCT_CONSULT", () => {
    const r = computePhase15HardRoute("這個尺寸有哪些");
    expect(r?.selected_scenario).toBe("PRODUCT_CONSULT");
  });

  it("物流 → ORDER_LOOKUP", () => {
    const r = computePhase15HardRoute("我的物流到哪了");
    expect(r?.selected_scenario).toBe("ORDER_LOOKUP");
  });

  it("你好 → null（走 LLM 或 legacy）", () => {
    const r = computePhase15HardRoute("你好");
    expect(r).toBeNull();
  });

  it("混合意圖：退貨優先於物流", () => {
    const r = computePhase15HardRoute("退貨物流怎麼寄回");
    expect(r?.selected_scenario).toBe("AFTER_SALES");
  });

  it("手機號 + 查單語境 → ORDER_LOOKUP", () => {
    const r = computePhase15HardRoute("0912345678 查訂單");
    expect(r?.selected_scenario).toBe("ORDER_LOOKUP");
  });

  it("優惠碼（無查單語境）→ PRODUCT_CONSULT", () => {
    const r = computePhase15HardRoute("優惠碼 SAVE20 怎麼用");
    expect(r?.selected_scenario).toBe("PRODUCT_CONSULT");
  });
});

describe("filterToolsForScenario", () => {
  it("ORDER_LOOKUP 有查單工具", () => {
    const names = listToolNamesForScenario("ORDER_LOOKUP", { hasImageAssets: false });
    expect(names).toContain("lookup_order_by_id");
    expect(names).toContain("transfer_to_human");
  });

  it("AFTER_SALES 預設無查單工具", () => {
    const names = listToolNamesForScenario("AFTER_SALES", { hasImageAssets: false });
    expect(names).not.toContain("lookup_order_by_id");
    expect(names).toContain("transfer_to_human");
  });

  it("PRODUCT_CONSULT 無查單工具", () => {
    const names = listToolNamesForScenario("PRODUCT_CONSULT", { hasImageAssets: false });
    expect(names).not.toContain("lookup_order_by_id");
  });

  it("GENERAL 只有轉人工", () => {
    const names = listToolNamesForScenario("GENERAL", { hasImageAssets: false });
    expect(names).toEqual(["transfer_to_human"]);
  });
});

describe("applyScenarioToolOverrides", () => {
  it("tool_deny_extra 移除指定工具", () => {
    const base = filterToolsForScenario("ORDER_LOOKUP", { hasImageAssets: false });
    const result = applyScenarioToolOverrides(base, "ORDER_LOOKUP", {
      tool_deny_extra: ["lookup_order_by_id"],
    });
    const names = result.map((t) => (t as { type?: string; function?: { name?: string } }).function?.name).filter(Boolean);
    expect(names).not.toContain("lookup_order_by_id");
    expect(names).toContain("transfer_to_human");
  });
});
