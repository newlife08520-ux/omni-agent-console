import { describe, it, expect } from "vitest";
import { ensureShippingSopCompliance } from "../sop-compliance-guard";

describe("ensureShippingSopCompliance", () => {
  it("非 order_followup 直接通過", () => {
    const reply = "您好";
    expect(ensureShippingSopCompliance(reply, "answer_directly", "")).toBe(reply);
  });

  it("已含道歉 + 工作天 → 不注入前綴", () => {
    const reply = "不好意思讓您久等了，現貨大約五個工作天內會幫您安排寄出";
    const result = ensureShippingSopCompliance(reply, "order_followup", "", "什麼時候出貨", ["什麼時候出貨"]);
    expect(result).toBe(reply);
  });

  it("已含盡快 + 處理 → 不注入前綴", () => {
    const reply = "抱歉，我們會盡快幫您處理出貨";
    const result = ensureShippingSopCompliance(reply, "order_followup", "", "還沒出貨", ["還沒出貨"]);
    expect(result).toBe(reply);
  });

  it("LLM 漏講 SOP → 注入前綴", () => {
    const reply = "好的，我幫您查一下";
    const result = ensureShippingSopCompliance(reply, "order_followup", "", "什麼時候出貨", ["什麼時候出貨"]);
    expect(result).not.toBe(reply);
    expect(result).toContain("不好意思");
    expect(result).toContain(reply);
  });
});
