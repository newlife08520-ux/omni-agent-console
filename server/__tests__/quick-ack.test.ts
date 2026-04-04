import { describe, it, expect, afterEach, vi } from "vitest";

describe("Quick Ack feature flag (ENABLE_ORDER_LOOKUP_ACK)", () => {
  const original = process.env.ENABLE_ORDER_LOOKUP_ACK;

  afterEach(() => {
    if (original === undefined) delete process.env.ENABLE_ORDER_LOOKUP_ACK;
    else process.env.ENABLE_ORDER_LOOKUP_ACK = original;
  });

  it("未設環境變數時預設為 true（全情境 Quick Ack）", async () => {
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
