import { describe, it, expect } from "vitest";
import { isWithinBusinessHours, findNextBusinessMoment } from "../services/business-hours";

describe("isWithinBusinessHours", () => {
  it("週一 14:00 (台北) → 在營業時間", () => {
    expect(isWithinBusinessHours(new Date("2026-04-13T06:00:00Z"))).toBe(true);
  });

  it("週一 08:00 (台北) → 不在 (早於 09:00)", () => {
    expect(isWithinBusinessHours(new Date("2026-04-13T00:00:00Z"))).toBe(false);
  });

  it("週一 18:00 (台北) → 不在 (已下班)", () => {
    expect(isWithinBusinessHours(new Date("2026-04-13T10:00:00Z"))).toBe(false);
  });

  it("週六 14:00 (台北) → 不在 (週末)", () => {
    expect(isWithinBusinessHours(new Date("2026-04-18T06:00:00Z"))).toBe(false);
  });

  it("週日 14:00 (台北) → 不在 (週末)", () => {
    expect(isWithinBusinessHours(new Date("2026-04-19T06:00:00Z"))).toBe(false);
  });
});

describe("findNextBusinessMoment", () => {
  it("週一 14:00 (營業中) → 直接回傳自己", () => {
    const input = new Date("2026-04-13T06:00:00Z");
    const result = findNextBusinessMoment(input);
    expect(result.getTime()).toBe(input.getTime());
  });

  it("週六 14:00 (週末) → 順延到週一 09:00", () => {
    const input = new Date("2026-04-18T06:00:00Z");
    const result = findNextBusinessMoment(input);
    expect(result.toISOString()).toBe("2026-04-20T01:00:00.000Z");
  });

  it("週日 22:00 (深夜) → 順延到週一 09:00", () => {
    const input = new Date("2026-04-19T14:00:00Z");
    const result = findNextBusinessMoment(input);
    expect(result.toISOString()).toBe("2026-04-20T01:00:00.000Z");
  });

  it("週六 22:00 → 順延到週一 09:00", () => {
    const input = new Date("2026-04-18T14:00:00Z");
    const result = findNextBusinessMoment(input);
    expect(result.toISOString()).toBe("2026-04-20T01:00:00.000Z");
  });

  it("週一 08:00 (還沒開門) → 順延到當天 09:00", () => {
    const input = new Date("2026-04-13T00:00:00Z");
    const result = findNextBusinessMoment(input);
    expect(result.toISOString()).toBe("2026-04-13T01:00:00.000Z");
  });

  it("週五 19:00 (下班後) → 順延到週一 09:00", () => {
    const input = new Date("2026-04-17T11:00:00Z");
    const result = findNextBusinessMoment(input);
    expect(result.toISOString()).toBe("2026-04-20T01:00:00.000Z");
  });
});

describe("整合 case：閒置結案順延", () => {
  it("週五 14:00 收到客人訊息 → 24h 後 = 週六 14:00 (週末) → 順延到週一 09:00", () => {
    const lastMsg = new Date("2026-04-17T06:00:00Z");
    const expireAt = new Date(lastMsg.getTime() + 24 * 60 * 60 * 1000);
    const realCloseAt = findNextBusinessMoment(expireAt);
    expect(realCloseAt.toISOString()).toBe("2026-04-20T01:00:00.000Z");
  });

  it("週一 14:00 收到 → 24h 後 = 週二 14:00 (營業中) → 直接結案", () => {
    const lastMsg = new Date("2026-04-13T06:00:00Z");
    const expireAt = new Date(lastMsg.getTime() + 24 * 60 * 60 * 1000);
    const realCloseAt = findNextBusinessMoment(expireAt);
    expect(realCloseAt.getTime()).toBe(expireAt.getTime());
  });
});
