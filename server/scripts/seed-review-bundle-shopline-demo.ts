/**
 * ⚠️ 僅供 review bundle／本機 staging **結構驗證**。會修改 SQLite。
 * - 將「第一個品牌」寫入 **占位** Shopline domain + token（無法呼叫真實 Shopline API）。
 * - 寫入一筆 orders_normalized source=shopline（訂單號 BUNDLE_DEMO_SL_001）。
 *
 * 執行：`npm run seed:review-bundle-shopline-demo`（等同 REVIEW_BUNDLE_SHOPLINE_DEMO=1）
 */
import { storage } from "../storage";
import { upsertOrderNormalized } from "../order-index";
import type { OrderInfo } from "@shared/schema";

const DEMO_DOMAIN = "review-bundle-demo.invalid";
const DEMO_TOKEN = "__REVIEW_BUNDLE_DEMO_NO_LIVE_API__";

async function main() {
  if (process.env.REVIEW_BUNDLE_SHOPLINE_DEMO !== "1") {
    console.log("[seed] 略過：請設 REVIEW_BUNDLE_SHOPLINE_DEMO=1 才會寫入 demo（會改 DB）。");
    return;
  }

  const brands = storage.getBrands();
  if (brands.length === 0) {
    console.error("[seed] 無品牌，無法種子。");
    process.exit(1);
  }
  const b = brands[0];
  await storage.updateBrand(b.id, {
    shopline_store_domain: DEMO_DOMAIN,
    shopline_api_token: DEMO_TOKEN,
  });

  const order: OrderInfo = {
    global_order_id: "BUNDLE_DEMO_SL_001",
    status: "completed",
    final_total_order_amount: 99,
    product_list: JSON.stringify([{ name: "DEMO 官網商品", qty: 1 }]),
    buyer_name: "DEMO",
    buyer_phone: "0900000000",
    buyer_email: "demo@review-bundle.invalid",
    tracking_number: "",
    created_at: new Date().toISOString(),
    source: "shopline",
    page_id: "demo_page",
    payment_method: "paid",
    shipping_method: "home",
  };
  upsertOrderNormalized(b.id, "shopline", order);

  console.log(
    JSON.stringify(
      {
        ok: true,
        note: "DEMO ONLY — 非真實 Shopline；請勿用於宣告「線上可查」。",
        brand_id: b.id,
        shopline_store_domain: DEMO_DOMAIN,
        global_order_id: order.global_order_id,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
