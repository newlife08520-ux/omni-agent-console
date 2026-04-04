import { describe, it, expect } from "vitest";
import type { OrderInfo } from "@shared/schema";
import { derivePaymentStatus } from "../order-payment-utils";

function minOrder(partial: Partial<OrderInfo>): OrderInfo {
  return {
    global_order_id: "T-TEST-1",
    status: "",
    final_total_order_amount: 0,
    product_list: "",
    buyer_name: "",
    buyer_phone: "",
    buyer_email: "",
    tracking_number: "",
    created_at: "2026-01-01T00:00:00Z",
    source: "superlanding",
    ...partial,
  };
}

describe("derivePaymentStatus", () => {
  it("LINE Pay 授權失敗 → failed", () => {
    const result = derivePaymentStatus(
      minOrder({ payment_method: "LINE Pay", payment_status_raw: "授權失敗", status: "新訂單" }),
      "新訂單",
      "superlanding"
    );
    expect(result.kind).toBe("failed");
  });

  it("超商取貨付款 → cod", () => {
    const result = derivePaymentStatus(
      minOrder({ payment_method: "超商取貨付款", status: "待出貨" }),
      "待出貨",
      "superlanding"
    );
    expect(result.kind).toBe("cod");
  });

  it("信用卡未付 新訂單 → pending", () => {
    const result = derivePaymentStatus(minOrder({ payment_method: "信用卡", status: "新訂單" }), "新訂單", "superlanding");
    expect(result.kind).toBe("pending");
  });

  it("紅叉訊號 → failed", () => {
    const result = derivePaymentStatus(
      minOrder({ payment_method: "信用卡", payment_status_raw: "❌ 授權失敗", status: "新訂單" }),
      "新訂單",
      "superlanding"
    );
    expect(result.kind).toBe("failed");
  });

  it("已取消 → failed", () => {
    const result = derivePaymentStatus(minOrder({ payment_method: "信用卡", status: "已取消" }), "已取消", "superlanding");
    expect(result.kind).toBe("failed");
  });

  it("刷卡不成功 → failed", () => {
    const result = derivePaymentStatus(
      minOrder({ payment_method: "信用卡", payment_status_raw: "刷卡不成功", status: "新訂單" }),
      "新訂單",
      "superlanding"
    );
    expect(result.kind).toBe("failed");
  });
});
