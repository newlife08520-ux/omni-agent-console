import { describe, it, expect, afterEach, vi } from "vitest";
import { shouldSendQuickAck } from "../services/quick-ack.service";

describe("Quick Ack feature flag (ENABLE_ORDER_LOOKUP_ACK)", () => {
  const original = process.env.ENABLE_ORDER_LOOKUP_ACK;

  afterEach(() => {
    if (original === undefined) delete process.env.ENABLE_ORDER_LOOKUP_ACK;
    else process.env.ENABLE_ORDER_LOOKUP_ACK = original;
  });

  it("未設環境變數時預設為 true（僅 ORDER_LOOKUP／AFTER_SALES 才送 Ack）", async () => {
    delete process.env.ENABLE_ORDER_LOOKUP_ACK;
    vi.resetModules();
    const { orderFeatureFlags } = await import("../order-feature-flags");
    expect(orderFeatureFlags.orderLookupAck).toBe(true);
  });

  it("ENABLE_ORDER_LOOKUP_ACK=0 時關閉", async () => {
    process.env.ENABLE_ORDER_LOOKUP_ACK = "0";
    vi.resetModules();
    const { orderFeatureFlags } = await import("../order-feature-flags");
    expect(orderFeatureFlags.orderLookupAck).toBe(false);
  });
});

describe("shouldSendQuickAck", () => {
  const base = {
    orderLookupAckEnabled: true,
    sentLookupAckThisTurn: false,
    planMode: "answer_directly",
  };

  it("GENERAL 不送", () => {
    expect(
      shouldSendQuickAck({ ...base, scenarioKey: "GENERAL", userMessage: "你好" })
    ).toBe(false);
  });

  it("PRODUCT_CONSULT 不送", () => {
    expect(
      shouldSendQuickAck({ ...base, scenarioKey: "PRODUCT_CONSULT", userMessage: "有什麼顏色" })
    ).toBe(false);
  });

  it("ORDER_LOOKUP 送", () => {
    expect(shouldSendQuickAck({ ...base, scenarioKey: "ORDER_LOOKUP", userMessage: "你好" })).toBe(
      true
    );
  });

  it("AFTER_SALES 送（不限關鍵字）", () => {
    expect(
      shouldSendQuickAck({ ...base, scenarioKey: "AFTER_SALES", userMessage: "你好" })
    ).toBe(true);
  });

  it("AFTER_SALES 含退貨關鍵字仍送", () => {
    expect(
      shouldSendQuickAck({ ...base, scenarioKey: "AFTER_SALES", userMessage: "我要退貨" })
    ).toBe(true);
  });

  it("handoff 不送", () => {
    expect(
      shouldSendQuickAck({
        ...base,
        planMode: "handoff",
        scenarioKey: "ORDER_LOOKUP",
        userMessage: "查單",
      })
    ).toBe(false);
  });
});
