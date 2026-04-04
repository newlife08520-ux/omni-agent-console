import { describe, it, expect } from "vitest";
import {
  enforceOutputGuard,
  OUTPUT_GUARD_MAX_CHARS,
  OUTPUT_GUARD_MAX_CHARS_RELAXED,
} from "../phase2-output";

describe("enforceOutputGuard", () => {
  it("空字串維持空", () => {
    expect(enforceOutputGuard("", "order_lookup")).toBe("");
  });

  it("未超標不變", () => {
    const s = "您好，需要訂單編號或商品名＋手機。";
    expect(enforceOutputGuard(s, "order_lookup")).toBe(s);
  });

  it("order_lookup 超過 200 字時優先截在句號（且句號在後半段）", () => {
    const head = "A".repeat(120);
    const tail = "後段說明。還有更多文字要補充，直到超過兩百字為止。".repeat(4);
    const long = head + tail;
    expect(long.length).toBeGreaterThan(200);
    const out = enforceOutputGuard(long, "order_lookup");
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("。")).toBe(true);
  });

  it("order_followup 與 order_lookup 同上限 200", () => {
    const long = "測試。".repeat(80);
    const out = enforceOutputGuard(long, "order_followup");
    expect(out.length).toBeLessThanOrEqual(OUTPUT_GUARD_MAX_CHARS);
  });

  it("answer_directly 上限 350", () => {
    const long = "說明。".repeat(120);
    expect(long.length).toBeGreaterThan(350);
    const out = enforceOutputGuard(long, "answer_directly");
    expect(out.length).toBeLessThanOrEqual(OUTPUT_GUARD_MAX_CHARS_RELAXED);
  });

  it("無可用句號時截斷並加省略號（總長度不超過上限）", () => {
    const long = "x".repeat(400);
    const out = enforceOutputGuard(long, "answer_directly");
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(OUTPUT_GUARD_MAX_CHARS_RELAXED);
  });
});
