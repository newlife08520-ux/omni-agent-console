/**
 * Phase 34：人格／查單政策 runtime rescue（34-1～34-5 行為級自驗）
 * 執行：npm run verify:phase34
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { detectLookupSourceIntent, deriveOrderLookupIntent } from "./order-lookup-policy";
import { derivePaymentStatus } from "./order-payment-utils";
import {
  buildDeterministicFollowUpReply,
  deterministicReplyHasBannedPhrase,
  displayPaymentMethod,
  displayShippingMethod,
} from "./order-reply-utils";
import { extractLongNumericOrderIdFromMixedSentence } from "./order-fast-path";
import { deriveSuperlandingPaymentStatusRaw } from "./superlanding";
import type { ActiveOrderContext } from "@shared/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`[phase34-verify] FAIL: ${msg}`);
}

function main() {
  let pass = 0;
  const ok = (name: string) => {
    pass++;
    console.log(`  OK ${pass}. ${name}`);
  };

  console.log("[phase34-verify] 開始…");

  /** 34-1：來源意圖僅繼承「上一則」recent，不讀更舊的官網句 */
  assert(
    detectLookupSourceIntent("0912345678", ["官網買的", "好的收到"]) === "unknown",
    "phone-only still unknown (no inherit)"
  );
  assert(
    detectLookupSourceIntent("查訂單", ["舊的無關句", "官網買的"]) === "shopline",
    "last recent only: shopline"
  );
  ok("34-1 lookup source TTL (slice -1)");

  /** 34-2：長數字單號＋意圖 */
  const longId = "1234567890123456789";
  assert(/^\d{15,22}$/.test(longId), "fixture long id");
  const intentLong = deriveOrderLookupIntent(longId, [], null);
  assert(intentLong.kind === "order_id_direct", "derive intent order_id_direct");
  assert(extractLongNumericOrderIdFromMixedSentence(`請查 ${longId} 謝謝`) === longId, "mixed long numeric");
  assert(
    extractLongNumericOrderIdFromMixedSentence("團購單 9876543210987654321 幫忙看") === "9876543210987654321",
    "mixed with 團購 keyword"
  );
  const fastPathSrc = fs.readFileSync(path.join(__dirname, "order-fast-path.ts"), "utf8");
  assert(fastPathSrc.includes("preferSourceForOrderIdLookup"), "preferSourceForOrderIdLookup present");
  assert(fastPathSrc.includes("return \"shopline\""), "default shopline for long numeric");
  ok("34-2 Shopline long numeric order id");

  /** 34-3：local_only 單筆不得「幫您查到了」定案（fast path 原始碼守門） */
  assert(
    fastPathSrc.includes("isLocalOnlySingle") && fastPathSrc.includes("目前從已同步資料先看到"),
    "local_only single uses conservative wording"
  );
  const routesSrc = fs.readFileSync(path.join(__dirname, "routes.ts"), "utf8");
  assert(routesSrc.includes("不可寫成「幫您查到了」"), "ORDER_LOOKUP_RULES 幫您查到了 guard");
  assert(
    routesSrc.includes("local_only") && routesSrc.includes("不可單筆定案"),
    "ORDER_LOOKUP_RULES local_only"
  );
  assert(
    routesSrc.includes("singleDeterministicBody") && routesSrc.includes("formatLocalOnlyCandidateSummary"),
    "routes: local_only 候選摘要與定案分離"
  );
  assert(
    routesSrc.includes("planAllowsActiveOrderDeterministic") &&
      routesSrc.includes("aftersales_comfort_first") &&
      routesSrc.includes("order_followup"),
    "routes: 品牌 delay 短路模式擴充"
  );
  ok("34-3 local_only single no false finality");

  assert(!/\bpending\b/i.test(displayPaymentMethod("pending")), "displayPaymentMethod 不輸出 pending");
  assert(!/\bto_store\b/i.test(displayShippingMethod("to_store")), "displayShippingMethod 不輸出 to_store");
  assert(!/\bcredit_card\b/i.test(displayPaymentMethod("credit_card")), "displayPaymentMethod 不輸出 credit_card");
  const slRaw = deriveSuperlandingPaymentStatusRaw({
    payment_method: "credit_card",
    system_note: { type: "error", message: "LINE Pay 付款失敗" },
    status: "new_order",
  } as Record<string, unknown>);
  assert(!!slRaw && /失敗|error/i.test(slRaw), "SuperLanding raw 取自 system_note 等，非僅 payment_method");
  const orderSvc = fs.readFileSync(path.join(__dirname, "order-service.ts"), "utf8");
  assert(orderSvc.includes("longNumericShoplineOnly") && orderSvc.includes("15,22"), "unifiedLookupById 長數字 shopline-only");
  const fpSrc = fs.readFileSync(path.join(__dirname, "order-fast-path.ts"), "utf8");
  assert(
    fpSrc.includes("aftersales_comfort_first") && fpSrc.includes("order_followup"),
    "fast path 品牌追問模式擴充（含 order_followup）"
  );
  ok("34-audit: humanize + SL raw + shopline-only + deterministic modes");

  /** 34-4：付款失敗對客標籤＋關鍵字 */
  const payUtil = fs.readFileSync(path.join(__dirname, "order-payment-utils.ts"), "utf8");
  assert(payUtil.includes("訂單未成立") && payUtil.includes("紅叉"), "fail keywords");
  const failedOrder = derivePaymentStatus(
    {
      global_order_id: "F1",
      source: "superlanding",
      payment_method: "LINE Pay",
      shipping_method: "宅配",
      delivery_target_type: "home",
      prepaid: false,
      paid_at: null as unknown as string,
      status: "新訂單",
      final_total_order_amount: 1,
      product_list: "[]",
      buyer_name: "",
      buyer_phone: "",
      buyer_email: "",
      tracking_number: "",
      created_at: "",
      payment_status_raw: "failed",
    } as import("@shared/schema").OrderInfo,
    "訂單未成立（紅叉）",
    "superlanding"
  );
  assert(failedOrder.kind === "failed", "kind failed");
  assert(
    failedOrder.label.includes("付款失敗") && failedOrder.label.includes("訂單未成立"),
    "customer label combined"
  );
  ok("34-4 payment failed label + signals");

  /** 34-5：久候品牌模板＋禁用句型 */
  const ctxDelay: ActiveOrderContext = {
    order_id: "T1",
    matched_by: "text",
    last_fetched_at: "",
    payment_status: "success",
    fulfillment_status: "待出貨",
    delivery_target_type: "cvs",
    cvs_brand: "全家",
    cvs_store_name: "測試店",
    full_address: "",
  };
  const delayReply = buildDeterministicFollowUpReply(ctxDelay, "什麼時候會出貨");
  assert(!!delayReply && delayReply.includes("5 個工作天") && delayReply.includes("7–20 個工作天"), "brand delay");
  assert(!deterministicReplyHasBannedPhrase(delayReply!), "no phase24 banned in delay reply");
  const ctxCod: ActiveOrderContext = {
    ...ctxDelay,
    payment_status: "cod",
    fulfillment_status: "待出貨",
  };
  const codDet = buildDeterministicFollowUpReply(ctxCod, "出貨了嗎");
  assert(!!codDet && codDet.includes("貨到付款") && codDet.includes("不是付款失敗"), "cod wording");
  assert(!deterministicReplyHasBannedPhrase(codDet!), "cod no banned");
  ok("34-5 brand delay + COD deterministic");

  /** 人格檔入庫 */
  const personaDir = path.join(__dirname, "..", "docs", "persona");
  assert(fs.existsSync(path.join(personaDir, "ai客服人格.txt")), "persona ai file");
  assert(fs.existsSync(path.join(personaDir, "全區域人格設定.txt")), "persona global file");
  ok("docs/persona single source files");

  console.log(`[phase34-verify] 全部通過：${pass} 項`);
}

main();
