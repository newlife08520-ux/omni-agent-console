/**
 * Phase 106.36 前置：orders_normalized 兩平台 payment_method 分佈 + isCodPaymentMethod 對照（不改產品邏輯）。
 * 執行：npx tsx server/scripts/_diag-payment-methods.ts
 *
 * 說明：isCodPaymentMethod 會讀 shipping_method / delivery_target_type（尤其一頁商店 payment_method=pending）。
 * 本腳本輸出：
 * - aggregates：依 source × payment_method 筆數（等同指定 SQL）
 * - cod_probe：每個 payment_method 字串在數種 stub 下的 isCod 結果
 */
import path from "path";
import Database from "better-sqlite3";
import type { OrderInfo } from "@shared/schema";
import { getDataDir } from "../data-dir";
import { isCodPaymentMethod } from "../order-payment-utils";

function stub(
  source: "shopline" | "superlanding",
  paymentMethod: string,
  extra?: Partial<Pick<OrderInfo, "shipping_method" | "delivery_target_type" | "prepaid" | "paid_at">>
): OrderInfo {
  return {
    global_order_id: "DIAG",
    status: "",
    final_total_order_amount: 0,
    product_list: "[]",
    buyer_name: "",
    buyer_phone: "",
    buyer_email: "",
    tracking_number: "",
    created_at: "",
    source,
    payment_method: paymentMethod,
    prepaid: extra?.prepaid ?? false,
    paid_at: extra?.paid_at ?? null,
    shipping_method: extra?.shipping_method ?? "",
    delivery_target_type: extra?.delivery_target_type,
  };
}

function main() {
  const dbPath = path.join(getDataDir(), "omnichannel.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    const sql = `
      SELECT
        source,
        COALESCE(NULLIF(trim(json_extract(payload, '$.payment_method')), ''), '(empty)') AS payment_method,
        COUNT(*) AS cnt
      FROM orders_normalized
      WHERE source IN ('shopline', 'superlanding')
      GROUP BY source, json_extract(payload, '$.payment_method')
      ORDER BY source, cnt DESC
    `;
    const rows = db.prepare(sql).all() as {
      source: string;
      payment_method: string;
      cnt: number;
    }[];

    const cod_probe = rows.map((r) => {
      const pm = r.payment_method === "(empty)" ? "" : r.payment_method;
      const src = r.source === "shopline" ? "shopline" : "superlanding";

      const only_pm = isCodPaymentMethod(stub(src, pm));

      const sl_cvs_pending =
        src === "superlanding" && pm.trim().toLowerCase() === "pending"
          ? isCodPaymentMethod(
              stub("superlanding", pm, {
                shipping_method: "超商取貨 to_store",
                delivery_target_type: "cvs",
              })
            )
          : null;

      const sl_home_pending =
        src === "superlanding" && pm.trim().toLowerCase() === "pending"
          ? isCodPaymentMethod(
              stub("superlanding", pm, {
                shipping_method: "to_home",
                delivery_target_type: "home",
              })
            )
          : null;

      return {
        source: r.source,
        payment_method: r.payment_method,
        cnt: r.cnt,
        isCod_payment_method_only_stub: only_pm,
        isCod_superlanding_pending_plus_cvs_stub:
          sl_cvs_pending === null ? undefined : sl_cvs_pending,
        isCod_superlanding_pending_plus_home_stub:
          sl_home_pending === null ? undefined : sl_home_pending,
      };
    });

    const total = rows.reduce((s, r) => s + r.cnt, 0);
    console.log(
      JSON.stringify(
        {
          note: "isCod_superlanding_pending_* 僅在 payment_method 為 pending（不分大小寫）時有意義；其餘列為 null。",
          total_rows: total,
          aggregates: rows,
          cod_probe,
        },
        null,
        2
      )
    );
  } finally {
    db.close();
  }
}

main();
