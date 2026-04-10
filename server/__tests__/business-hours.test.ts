import { describe, it, expect } from "vitest";
import {
  isWithinBusinessHours,
  findNextBusinessMoment,
  isHoliday,
  getHolidayStats,
} from "../services/business-hours";

describe("isHoliday", () => {
  it("應該載入到至少 2026 年的國定假日", () => {
    const stats = getHolidayStats();
    expect(stats.totalDates).toBeGreaterThan(10);
  });

  it("2026-01-01 元旦應該是假日", () => {
    expect(isHoliday("2026-01-01")).toBe(true);
  });

  it("2026-02-28 和平紀念日應該是假日", () => {
    expect(isHoliday("2026-02-28")).toBe(true);
  });

  it("2026-03-15 普通週日不是國定假日", () => {
    expect(isHoliday("2026-03-15")).toBe(false);
  });
});

describe("isWithinBusinessHours", () => {
  it("週一 14:00 (台北) → 在營業時間", () => {
    expect(isWithinBusinessHours(new Date("2026-04-13T06:00:00Z"))).toBe(true);
  });

  it("週六 14:00 (台北) → 不在 (週末)", () => {
    expect(isWithinBusinessHours(new Date("2026-04-18T06:00:00Z"))).toBe(false);
  });

  it("元旦平日 14:00 (台北) → 不在 (國定假日)", () => {
    expect(isWithinBusinessHours(new Date("2026-01-01T06:00:00Z"))).toBe(false);
  });
});

describe("findNextBusinessMoment", () => {
  it("週一 14:00 (營業中) → 直接回傳自己", () => {
    const input = new Date("2026-04-13T06:00:00Z");
    expect(findNextBusinessMoment(input).getTime()).toBe(input.getTime());
  });

  it("週六 14:00 → 順延到週一 09:00", () => {
    const input = new Date("2026-04-18T06:00:00Z");
    const result = findNextBusinessMoment(input);
    expect(result.toISOString()).toBe("2026-04-20T01:00:00.000Z");
  });

  it("週五 19:00 (下班後) → 順延到週一 09:00", () => {
    const input = new Date("2026-04-17T11:00:00Z");
    const result = findNextBusinessMoment(input);
    expect(result.toISOString()).toBe("2026-04-20T01:00:00.000Z");
  });

  it("元旦 (週四) 14:00 → 順延到週五 09:00 (1/2)", () => {
    const input = new Date("2026-01-01T06:00:00Z");
    const result = findNextBusinessMoment(input);
    expect(result.toISOString()).toBe("2026-01-02T01:00:00.000Z");
  });
});

describe("整合 case：閒置結案順延", () => {
  it("週五 14:00 訊息 → 24h 後 = 週六 14:00 → 順延到週一 09:00", () => {
    const lastMsg = new Date("2026-04-17T06:00:00Z");
    const expireAt = new Date(lastMsg.getTime() + 24 * 60 * 60 * 1000);
    const realCloseAt = findNextBusinessMoment(expireAt);
    expect(realCloseAt.toISOString()).toBe("2026-04-20T01:00:00.000Z");
  });

  it("週一 14:00 訊息 → 24h 後 = 週二 14:00 (營業中) → 直接結", () => {
    const lastMsg = new Date("2026-04-13T06:00:00Z");
    const expireAt = new Date(lastMsg.getTime() + 24 * 60 * 60 * 1000);
    const realCloseAt = findNextBusinessMoment(expireAt);
    expect(realCloseAt.getTime()).toBe(expireAt.getTime());
  });
});
