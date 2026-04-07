import { describe, it, expect } from "vitest";
import type { OrderInfo } from "@shared/schema";
import { formatExtendedOrderList, formatDateTaipei } from "../order-reply-utils";

describe("formatDateTaipei", () => {
  it("outputs YYYY-MM-DD in Asia/Taipei, not ISO", () => {
    const d = formatDateTaipei("2026-04-07T08:30:00.000Z", "YYYY-MM-DD");
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d).not.toContain("T");
    expect(d).not.toContain("Z");
  });
});

describe("formatExtendedOrderList", () => {
  it("formats 4 orders with 5 lines each, truncation, and closing hint", () => {
    const longName = "這是一個超級超級超級長的商品名稱用來測試截斷";
    const orders: OrderInfo[] = [
      {
        global_order_id: "ESC21137",
        buyer_name: "王小明",
        order_created_at: "2026-04-07T10:00:00+08:00",
        final_total_order_amount: 1580,
        payment_method: "cash_on_delivery",
        status: "confirmed",
        source: "shopline",
        product_list: JSON.stringify([
          { product_name: "LUNA 好眠舒腰枕", quantity: 1 },
          { product_name: "香氛蠟燭", quantity: 2 },
          { product_name: "第三個", quantity: 1 },
        ]),
      } as OrderInfo,
      {
        global_order_id: "X2",
        buyer_name: "李小姐",
        order_created_at: "2026-03-01T12:00:00.000Z",
        final_total_order_amount: 100,
        payment_method: "credit_card",
        status: "processing",
        source: "shopline",
        items_structured: [{ product_name: longName, quantity: 1 }],
      } as OrderInfo,
      {
        global_order_id: "X3",
        buyer_name: "",
        order_created_at: "",
        final_total_order_amount: undefined,
        payment_method: "",
        status: "pending",
        source: "superlanding",
      } as OrderInfo,
      {
        global_order_id: "X4",
        buyer_name: "陳大文",
        order_created_at: "2026-01-15T08:00:00+08:00",
        final_total_order_amount: 999,
        payment_method: "line_pay",
        status: "shipped",
        source: "shopline",
        product_list: "",
      } as OrderInfo,
    ];
    const out = formatExtendedOrderList(orders);
    expect(out).toContain("ESC21137｜2026-04-07");
    expect(out).toContain("收件人：");
    expect(out).toContain("LUNA 好眠舒腰枕 ×1, 香氛蠟燭 ×2，等 3 項");
    expect(out).toContain("金額：NT$1,580");
    expect(out).toContain("要看哪一筆完整資訊請回覆訂單編號或「第 N 筆」。");
    expect(out).toContain("這是一個超級超級超級長的商品名稱用來測試…");
    expect(out.split(/^[A-Z0-9]+｜/m).length - 1).toBeGreaterThanOrEqual(4);
  });
});
