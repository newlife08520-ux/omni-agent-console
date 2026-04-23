import { describe, it, expect } from "vitest";
import { buildOrderStatusFollowupHint, formatOrderOnePage } from "../order-reply-utils";

describe("Phase 106.35 v2 buildOrderStatusFollowupHint", () => {
  it("分支 A：cancelled + pending + COD（Shopline）", () => {
    const h = buildOrderStatusFollowupHint("cancelled", "", "cod", {
      deliveryStatusRaw: "pending",
      source: "shopline",
    });
    expect(h).toContain("已取消");
    expect(h).toContain("重新下單");
  });

  it("分支 B：宅配 + collected + shippedAt", () => {
    const h = buildOrderStatusFollowupHint("confirmed", "home_delivery", "success", {
      deliveryStatusRaw: "collected",
      shippedAt: "2026-03-17T12:00:00+08:00",
      source: "shopline",
    });
    expect(h).toMatch(/已於 2026-03-17/);
    expect(h).toContain("追蹤編號");
  });

  it("分支 B：超商 + collected、無 shippedAt", () => {
    const h = buildOrderStatusFollowupHint("completed", "tw_711_pickup", "success", {
      deliveryStatusRaw: "collected",
      source: "shopline",
    });
    expect(h).toContain("已出貨到您選擇的門市");
    expect(h).not.toMatch(/已於\s+$/);
  });

  it("分支 F：confirmed + pending + 已付（Shopline）", () => {
    const h = buildOrderStatusFollowupHint("confirmed", "home_delivery", "success", {
      deliveryStatusRaw: "pending",
      source: "shopline",
    });
    expect(h).toContain("5 個工作天");
    expect(h).toContain("7-20");
  });

  it("分支 E：pending + pending + 未付（LINE Pay）", () => {
    const h = buildOrderStatusFollowupHint("pending", "home_delivery", "pending", {
      deliveryStatusRaw: "pending",
      source: "shopline",
    });
    expect(h).toContain("付款還未完成");
  });

  it("分支 F：pending + pending + COD", () => {
    const h = buildOrderStatusFollowupHint("pending", "tw_family_pickup", "cod", {
      deliveryStatusRaw: "pending",
      source: "shopline",
    });
    expect(h).toContain("5 個工作天");
  });

  it("分支 C：returned", () => {
    const h = buildOrderStatusFollowupHint("confirmed", "", "success", {
      deliveryStatusRaw: "returned",
      source: "shopline",
    });
    expect(h).toContain("已完成退貨處理");
  });
});

describe("Phase 106.35 v2 formatOrderOnePage 整合", () => {
  it("一頁商店 ESC21129 風格：已取消 + COD → 分支 A", () => {
    const card = formatOrderOnePage({
      order_id: "ESC21129",
      source: "superlanding",
      status: "已取消",
      fulfillment_status_raw: "已取消",
      delivery_status_raw: "已取消",
      product_list: "[]",
      payment_method: "貨到付款",
      payment_status: "cod",
      payment_status_label: "貨到付款",
      shipping_method: "超商取貨",
    });
    expect(card).toContain("已取消");
    expect(card).toContain("如果還是有需要商品");
  });
});
