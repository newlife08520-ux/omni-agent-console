/**
 * Phase 34：人格／查單政策 runtime rescue（34-1～34-5 行為級自驗）
 * 執行：npm run verify:phase34
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { detectLookupSourceIntent, deriveOrderLookupIntent } from "./order-lookup-policy";
import { derivePaymentStatus } from "./order-payment-utils";
import { buildDeterministicFollowUpReply, displayPaymentMethod, displayShippingMethod } from "./order-reply-utils";
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

  /** 34-1／P0：純手機不繼承；僅當前句含官網才為 shopline */
  assert(
    detectLookupSourceIntent("0912345678", ["官網買的", "好的收到"]) === "unknown",
    "phone-only still unknown (no inherit)"
  );
  assert(detectLookupSourceIntent("官網買的查一下", []) === "shopline", "shopline from current message only");
  ok("34-1 lookup source current-message only");

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
  const toolExecutorSrc = fs.readFileSync(path.join(__dirname, "services", "tool-executor.service.ts"), "utf8");
  assert(
    toolExecutorSrc.includes("finalizeLlmToolJsonString") && toolExecutorSrc.includes("toolJson"),
    "tool-executor: LLM JSON sanitize (toolJson + finalize)"
  );
  ok("34-2 long numeric order id + tool sanitize hook");

  /** 34-3：純手機 summary_only + local_only 候選摘要（Minimal Safe Mode） */
  assert(
    toolExecutorSrc.includes("orderLookupSummaryOnly") && toolExecutorSrc.includes("summary_only"),
    "tool-executor: phone summary-only lock"
  );
  assert(
    toolExecutorSrc.includes("singleDeterministicBody") && toolExecutorSrc.includes("formatLocalOnlyCandidateSummary"),
    "tool-executor: local_only 候選摘要與定案分離"
  );
  const routesSrc = fs.readFileSync(path.join(__dirname, "routes.ts"), "utf8");
  const aiReplySrc = fs.readFileSync(path.join(__dirname, "services", "ai-reply.service.ts"), "utf8");
  assert(!routesSrc.includes("<ORDER_LOOKUP_RULES>"), "P0: 已移除硬編碼 ORDER_LOOKUP_RULES");
  assert(
    aiReplySrc.includes("planAllowsActiveOrderDeterministic") && /return\s+false/.test(aiReplySrc),
    "ai-reply: deterministic active-order shortcut disabled"
  );
  ok("34-3 local_only + phone summary lock + deterministic off");

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
  const policySrc = fs.readFileSync(path.join(__dirname, "order-lookup-policy.ts"), "utf8");
  assert(policySrc.includes("15,22"), "order-lookup-policy: 長純數字單號 \\d{15,22}");
  assert(policySrc.includes("summaryOnly"), "order-lookup-policy: summaryOnly 欄位");
  assert(
    orderSvc.includes("unifiedLookupById") && orderSvc.includes("R1-1／R1-3"),
    "order-service: unifiedLookupById + 官網不回落一頁（R1）"
  );
  const sanitizeMod = fs.readFileSync(path.join(__dirname, "tool-llm-sanitize.ts"), "utf8");
  assert(
    sanitizeMod.includes("payment_status_raw") === false && sanitizeMod.includes("stripRawAndGateway"),
    "tool-llm-sanitize: strip raw keys helper present"
  );
  ok("34-audit: humanize + SL raw + shopline-only + policy summaryOnly");

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

  /** 34-5／P0：確定性追問已關閉 */
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
  assert(buildDeterministicFollowUpReply(ctxDelay, "什麼時候會出貨") === null, "P0 follow-up null");
  const ctxCod: ActiveOrderContext = {
    ...ctxDelay,
    payment_status: "cod",
    fulfillment_status: "待出貨",
  };
  assert(buildDeterministicFollowUpReply(ctxCod, "出貨了嗎") === null, "P0 COD follow-up null");
  ok("34-5 deterministic follow-up disabled (LLM)");

  /** 人格檔入庫 */
  const personaDir = path.join(__dirname, "..", "docs", "persona");
  assert(fs.existsSync(path.join(personaDir, "ai客服人格.txt")), "persona ai file");
  assert(fs.existsSync(path.join(personaDir, "全區域人格設定.txt")), "persona global file");
  ok("docs/persona single source files");

  console.log(`[phase34-verify] 全部通過：${pass} 項`);
}

main();
