import { describe, it, expect } from "vitest";
import { normalizeSections, buildScenarioIsolationBlock, buildScenarioFlowBlock } from "../services/prompt-builder";

describe("normalizeSections", () => {
  it("去除重複 section", () => {
    const input = "abc\n--- 品牌 ---\n內容一\n--- 品牌 ---\n內容二\n--- 流程 ---\n流程內容";
    const result = normalizeSections(input);
    const matches = result.match(/--- 品牌 ---/g);
    expect(matches?.length).toBe(1);
    expect(result).toContain("--- 流程 ---");
  });

  it("無重複時不變", () => {
    const input = "--- A ---\naaa\n--- B ---\nbbb";
    expect(normalizeSections(input)).toBe(input);
  });
});

describe("buildScenarioIsolationBlock", () => {
  it("ORDER_LOOKUP 含禁止推薦", () => {
    const block = buildScenarioIsolationBlock("ORDER_LOOKUP");
    expect(block).toContain("禁止做");
    expect(block).toContain("推薦商品");
  });

  it("AFTER_SALES 含禁止推薦", () => {
    const block = buildScenarioIsolationBlock("AFTER_SALES");
    expect(block).toContain("禁止做");
  });

  it("PRODUCT_CONSULT 禁止主動查單", () => {
    const block = buildScenarioIsolationBlock("PRODUCT_CONSULT");
    expect(block).toContain("禁止做");
    expect(block).toContain("查單");
  });

  it("GENERAL 有基本指引", () => {
    const block = buildScenarioIsolationBlock("GENERAL");
    expect(block).toContain("一般");
  });
});

describe("buildScenarioFlowBlock", () => {
  it("ORDER_LOOKUP 含查單工具提示", () => {
    const block = buildScenarioFlowBlock("ORDER_LOOKUP", {});
    expect(block).toContain("查單");
  });

  it("AFTER_SALES 含退換提示", () => {
    const block = buildScenarioFlowBlock("AFTER_SALES", { returnFormUrl: "https://example.com/returns" });
    expect(block).toContain("example.com/returns");
  });

  it("含物流覆寫", () => {
    const block = buildScenarioFlowBlock("ORDER_LOOKUP", { shippingHintOverride: "冷藏品 48 小時內到貨" });
    expect(block).toContain("冷藏品");
  });
});

describe("buildScenarioFlowBlock 邊界", () => {
  it("AFTER_SALES flow 不含查單步驟", () => {
    const block = buildScenarioFlowBlock("AFTER_SALES", {});
    expect(block).not.toContain("有單號直接查");
    expect(block).toContain("transfer_to_human");
  });

  it("GENERAL flow 不含全系統查單步驟", () => {
    const block = buildScenarioFlowBlock("GENERAL", {});
    expect(block).not.toContain("有單號直接查");
  });

  it("ORDER_LOOKUP flow 含查單工具提示", () => {
    const block = buildScenarioFlowBlock("ORDER_LOOKUP", {});
    expect(block).toContain("查單");
  });

  it("returnFormUrl 注入", () => {
    const block = buildScenarioFlowBlock("AFTER_SALES", { returnFormUrl: "https://example.com/return" });
    expect(block).toContain("example.com/return");
  });
});
