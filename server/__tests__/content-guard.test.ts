import { describe, it, expect } from "vitest";
import {
  runPostGenerationGuard,
  isModeNoPromo,
  runGlobalPlatformGuard,
  runOfficialChannelGuard,
  detectOrderActionHallucination,
} from "../content-guard";

describe("detectOrderActionHallucination", () => {
  it("偵測宣稱已取消", () => {
    expect(detectOrderActionHallucination("已經幫您取消成功了！")).toBe(true);
  });
  it("一般查單不誤判", () => {
    expect(detectOrderActionHallucination("您的訂單已出貨，預計三天內到達。")).toBe(false);
  });
});

describe("runPostGenerationGuard", () => {
  it("一般模式通過", () => {
    const r = runPostGenerationGuard("您好，有什麼可以幫您的嗎？", "answer_directly", null);
    expect(r.pass).toBe(true);
  });

  it("訂單動作幻覺被攔截並改寫", () => {
    const r = runPostGenerationGuard("好的，已經幫您取消成功了！", "answer_directly", null);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("order_action_hallucination");
    expect(r.cleaned).toContain("沒辦法直接幫您取消");
  });

  it("售後模式下推銷被攔截", () => {
    const r = runPostGenerationGuard(
      "了解您的狀況，推薦您也可以看看我們的限時優惠組合",
      "aftersales_comfort_first",
      null
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("mode_no_promo");
  });

  it("handoff 模式下推銷被攔截", () => {
    const r = runPostGenerationGuard(
      "幫您轉接專人，建議您買這個加購很划算",
      "handoff",
      null
    );
    expect(r.pass).toBe(false);
  });

  it("查單模式下推銷被攔截", () => {
    const r = runPostGenerationGuard(
      "您的訂單已出貨，推薦購買同系列新品",
      "order_lookup",
      null
    );
    expect(r.pass).toBe(false);
  });

  it("售後模式下正常回覆通過", () => {
    const r = runPostGenerationGuard(
      "了解，我幫您看一下退換貨的狀況",
      "return_form_first",
      null
    );
    expect(r.pass).toBe(true);
  });

  it("空字串通過", () => {
    const r = runPostGenerationGuard("", "handoff", null);
    expect(r.pass).toBe(true);
  });
});

describe("isModeNoPromo", () => {
  it("handoff 禁推銷", () => expect(isModeNoPromo("handoff")).toBe(true));
  it("return_form_first 禁推銷", () => expect(isModeNoPromo("return_form_first")).toBe(true));
  it("order_lookup 禁推銷", () => expect(isModeNoPromo("order_lookup")).toBe(true));
  it("answer_directly 可推銷", () => expect(isModeNoPromo("answer_directly" as any)).toBe(false));
});

describe("runGlobalPlatformGuard", () => {
  it("正常回覆通過", () => {
    const r = runGlobalPlatformGuard("您的訂單已出貨，預計三天內到達。");
    expect(r.pass).toBe(true);
  });

  it("推責話術被攔截", () => {
    const r = runGlobalPlatformGuard("若是其他平台購買，建議向該平台客服確認。我們這邊只能查官方訂單。");
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("global_platform_forbidden");
  });

  it("不是我們的單被攔截", () => {
    const r = runGlobalPlatformGuard("這看起來不是我們這邊的單，您可能要問一下其他通路。");
    expect(r.pass).toBe(false);
  });

  it("只移除問題句，保留正常句", () => {
    const r = runGlobalPlatformGuard("了解您的問題。若是其他平台購買，建議向該平台客服確認。我幫您查看一下。");
    expect(r.pass).toBe(false);
    expect(r.cleaned).toContain("了解您的問題");
    expect(r.cleaned).toContain("我幫您查看一下");
    expect(r.cleaned).not.toContain("其他平台");
  });
});

describe("runOfficialChannelGuard", () => {
  it("正常回覆通過", () => {
    const r = runOfficialChannelGuard("好的，我幫您查詢訂單。");
    expect(r.pass).toBe(true);
  });

  it("問是否官網下單被攔截", () => {
    const r = runOfficialChannelGuard("請問您是否在官網下單呢？方便提供訂單編號嗎？");
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("official_channel_forbidden");
  });
});
