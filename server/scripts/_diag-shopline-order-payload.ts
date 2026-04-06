/**
 * 臨時診斷：orders_normalized 內 Shopline 訂單 payload 欄位
 * 用法：npx tsx server/scripts/_diag-shopline-order-payload.ts
 */
import db from "../db";

const row = db
  .prepare(
    "SELECT payload FROM orders_normalized WHERE global_order_id = ? AND brand_id = ?"
  )
  .get("20260404104559915", 1) as { payload: string } | undefined;

if (row) {
  const order = JSON.parse(row.payload) as Record<string, unknown>;
  console.log("=== Shopline 訂單完整欄位 ===");
  console.log("所有 key:", Object.keys(order).join(", "));
  console.log("product_list:", order.product_list);
  console.log("items:", JSON.stringify(order.items)?.slice(0, 500));
  console.log("items_structured:", JSON.stringify(order.items_structured)?.slice(0, 500));
  console.log("line_items:", JSON.stringify(order.line_items)?.slice(0, 500));
  console.log("payment_method:", order.payment_method);
  console.log("payment_status_raw:", order.payment_status_raw);
  console.log("shipping_method:", order.shipping_method);
  console.log("delivery_target_type:", order.delivery_target_type);
  console.log("status:", order.status);
  console.log("buyer_name:", order.buyer_name);
  console.log("buyer_phone:", order.buyer_phone);
  console.log("address:", order.address);
  console.log("full_address:", order.full_address);
  console.log("cvs_store_name:", order.cvs_store_name);
  console.log("cvs_brand:", order.cvs_brand);
  console.log("tracking_number:", order.tracking_number);
  console.log("prepaid:", order.prepaid);
  console.log("paid_at:", order.paid_at);
} else {
  console.log("找不到這筆 Shopline 訂單");
}
