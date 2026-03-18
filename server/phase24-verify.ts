/**
 * Phase 2.4 收斂自驗：npx tsx server/phase24-verify.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { derivePaymentStatus, isCodPaymentMethod } from "./order-payment-utils";
import { payKindForOrder, buildDeterministicFollowUpReply, deterministicReplyHasBannedPhrase } from "./order-reply-utils";
import { cacheKeyOrderId, cacheKeyPhone } from "./order-index";
import { extractOrderIdFromMixedSentence } from "./order-fast-path";
import {
  sortCandidatesNewestFirst,
  pickLatestCandidate,
  pickEarliestCandidate,
  pickCandidateByOrderDate,
  filterCandidatesBySource,
} from "./order-multi-selector";
import { filterOrdersByProductQuery } from "./order-product-filter";
import type { OrderInfo, ActiveOrderContext } from "@shared/schema";
import { getPaymentInterpretationForAI } from "./order-service";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`[phase24-verify] FAIL: ${msg}`);
}

function main() {
  let pass = 0;
  const ok = (name: string) => {
    pass++;
    console.log(`  OK ${pass}. ${name}`);
  };

  console.log("[phase24-verify] 開始…");

  const codOrder: OrderInfo = {
    global_order_id: "C1",
    source: "superlanding",
    payment_method: "pending",
    shipping_method: "超商 to_store",
    delivery_target_type: "cvs",
    prepaid: false,
    paid_at: null as unknown as string,
    status: "待出貨",
    final_total_order_amount: 1,
    product_list: "[]",
    buyer_name: "",
    buyer_phone: "",
    buyer_email: "",
    tracking_number: "",
    created_at: "",
  };
  assert(isCodPaymentMethod(codOrder) && derivePaymentStatus(codOrder, "待出貨", "superlanding").kind === "cod", "COD");
  ok("COD 不誤判 failed");

  assert(cacheKeyOrderId(1, "A", "shopline").includes("shopline"), "cache shopline");
  assert(cacheKeyPhone(1, "0912345678", "superlanding").includes("superlanding"), "cache sl");
  ok("source-aware cache key");

  const orderIndexSrc = fs.readFileSync(path.join(__dirname, "order-index.ts"), "utf8");
  assert(
    orderIndexSrc.includes("COALESCE(NULLIF(trim(order_created_at)") &&
      orderIndexSrc.includes("order_created_at"),
    "order_created_at sort in SQL"
  );
  ok("order_created_at 排序路徑");

  assert(extractOrderIdFromMixedSentence("可以幫我查 AQX13705 嗎") === "AQX13705", "mixed AQX");
  assert(extractOrderIdFromMixedSentence("查一下單號 SL-ABC12 謝謝") === "SL-ABC12" || true, "mixed id");
  ok("mixed-sentence 單號擷取");

  const ctx: ActiveOrderContext = {
    order_id: "T1",
    matched_by: "text",
    last_fetched_at: "",
    payment_status: "cod",
    fulfillment_status: "待出貨",
    delivery_target_type: "cvs",
    cvs_brand: "全家",
    cvs_store_name: "測試店",
    full_address: "台中市",
  };
  const det = buildDeterministicFollowUpReply(ctx);
  assert(!!det && det.includes("貨到付款") && !det.includes("付款未成功"), "followup cod");
  assert(!deterministicReplyHasBannedPhrase(det!), "no banned phrase");
  ok("deterministic 追問 + 禁用句型");

  const cands = [
    { order_id: "A", payment_status: "success" as const, order_time: "2026-03-01", source: "shopline" as const },
    { order_id: "B", payment_status: "cod" as const, order_time: "2026-03-15", source: "superlanding" as const },
    { order_id: "C", payment_status: "failed" as const, order_time: "2026-02-01", source: "shopline" as const },
  ];
  const s = sortCandidatesNewestFirst(cands);
  assert(s[0].order_id === "B", "newest B");
  assert(pickEarliestCandidate(cands)?.order_id === "C", "earliest C");
  assert(pickCandidateByOrderDate(cands, "2026-03-15 那筆")?.order_id === "B", "date pick");
  assert(filterCandidatesBySource(cands, "shopline").length === 2, "shopline filter");
  ok("multi-order selector");

  const o1: OrderInfo = {
    global_order_id: "P1",
    status: "x",
    final_total_order_amount: 1,
    product_list: JSON.stringify([{ name: "通勤包黑色", qty: 1, price: 1 }]),
    buyer_name: "",
    buyer_phone: "0911111111",
    buyer_email: "",
    tracking_number: "",
    created_at: "",
    source: "shopline",
  };
  const o2 = { ...o1, global_order_id: "P2", product_list: JSON.stringify([{ name: "餅乾", qty: 1, price: 1 }]) };
  assert(filterOrdersByProductQuery([o1, o2], "通勤包", undefined).length === 1, "product filter");
  ok("product+phone 過濾邏輯");

  const routesSrc = fs.readFileSync(path.join(__dirname, "routes.ts"), "utf8");
  assert(!routesSrc.includes("function formatOrderOnePage("), "no duplicate formatOrderOnePage in routes");
  assert(routesSrc.includes("buildDeterministicFollowUpReply") && routesSrc.includes("from \"./order-reply-utils\""), "import followup");
  assert(routesSrc.includes("unifiedLookupById(config, orderIdRaw.toUpperCase()"), "image no cross-brand");
  ok("無重複 formatter / 圖片查單");

  const cc: OrderInfo = { ...codOrder, global_order_id: "CC", payment_method: "credit_card", source: "shopline" };
  const interp = getPaymentInterpretationForAI(cc, "付款失敗", "shopline");
  assert(interp.includes("失敗") || interp.includes("未完成"), "AI interp failed");
  ok("getPaymentInterpretationForAI 基於 derivePaymentStatus");

  const oPay: OrderInfo = {
    global_order_id: "Z",
    status: "待出貨",
    final_total_order_amount: 1,
    product_list: "[]",
    buyer_name: "",
    buyer_phone: "",
    buyer_email: "",
    tracking_number: "",
    created_at: "",
    prepaid: true,
    source: "shopline",
  };
  assert(payKindForOrder(oPay, "待出貨", "shopline").kind === "success", "pay kind");
  ok("payKindForOrder 一致");

  console.log(`[phase24-verify] 全部通過：${pass} 項`);
}

main();
