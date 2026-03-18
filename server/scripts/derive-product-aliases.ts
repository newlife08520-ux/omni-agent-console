/**
 * 從 order_items_normalized 衍生 product_aliases（canonical = alias，供本地商品關鍵字查詢）。
 * 執行：npx tsx server/scripts/derive-product-aliases.ts [brand_id]
 */
import db from "../db";
import { normalizeProductName } from "../order-index";

function main() {
  const brandArg = process.argv[2];
  const rows = db
    .prepare(
      `
    SELECT DISTINCT o.brand_id, COALESCE(o.page_id, '') as page_id, i.product_name
    FROM order_items_normalized i
    INNER JOIN orders_normalized o ON o.id = i.order_normalized_id
    WHERE i.product_name IS NOT NULL AND trim(i.product_name) != ''
      ${brandArg ? "AND o.brand_id = ?" : ""}
  `
    )
    .all(...(brandArg ? [parseInt(brandArg, 10)] : [])) as { brand_id: number; page_id: string; product_name: string }[];

  const exists = db.prepare(
    "SELECT 1 FROM product_aliases WHERE brand_id = ? AND page_id = ? AND alias = ? LIMIT 1"
  );
  const ins = db.prepare(
    `INSERT INTO product_aliases (brand_id, page_id, canonical_name, alias, alias_normalized, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  );
  let n = 0;
  for (const r of rows) {
    const norm = normalizeProductName(r.product_name);
    if (norm.length < 2) continue;
    const pid = r.page_id || "_";
    const name = r.product_name.trim();
    if (exists.get(r.brand_id, pid, name)) continue;
    ins.run(r.brand_id, pid, name, name, norm);
    n++;
  }
  console.log(`[derive-product-aliases] 掃描 ${rows.length} 筆 distinct 商品列，新增 ${n} 筆別名`);
}

main();
