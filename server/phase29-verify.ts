/**
 * Phase 2.9 緊急止血：靜態回歸檢查（無外部 API）。
 *
 * @deprecated Phase 29 靜態驗證——已被 vitest 行為測試取代。
 * 本檔僅做 fs.readFileSync + includes 字串檢查，不測試實際行為。
 * 保留供歷史參考，新功能請寫 server/__tests__/*.test.ts。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`[phase29-verify] ${msg}`);
}

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

export function runPhase29Verify(): void {
  const routes = read("server/routes.ts");
  assert(routes.includes("phase29_more_orders_expand"), "routes: phase29 單筆展開多筆");
  assert(
    routes.includes("官網（SHOPLINE）這支手機目前查無") || routes.includes("SHOPLINE"),
    "routes: 官網查無文案"
  );
  assert(routes.includes("查別筆") || routes.includes("\\u67e5\\u5225\\u7b46"), "routes: 切換訂單關鍵字");
  assert(!routes.includes("<ORDER_LOOKUP_RULES>"), "P0: ORDER_LOOKUP_RULES 已移除（改由 DB）");

  const sl = read("server/superlanding.ts");
  assert(sl.includes("byOrderId"), "superlanding: 多視窗合併 byOrderId");

  const oru = read("server/order-reply-utils.ts");
  assert(oru.includes("formatProductLinesForCustomer"), "order-reply-utils: 商品明細人類可讀");

  const sync = read("server/scripts/sync-orders-normalized.ts");
  assert(sync.includes("90") && sync.includes("backfill"), "sync: 預設 90 天與 backfill");

  const chat = read("client/src/pages/chat.tsx");
  assert(chat.includes("contactsFetchLimit"), "chat: 聯絡人 limit 分段載入");
  assert(chat.includes("VITE_DISABLE_SSE"), "chat: SSE 可關閉旗標");
  assert(chat.includes("maybeInvalidateStats"), "chat: stats 節流");

  const norm = read("server/customer-reply-normalizer.ts");
  assert(norm.includes("softHumanize"), "normalizer: softHumanize");

  console.log("[phase29-verify] OK — 靜態檢查通過");
}

async function main() {
  runPhase29Verify();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
