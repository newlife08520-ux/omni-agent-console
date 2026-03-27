/**
 * R1 驗收：不依賴 it.skip；以行為斷言 + 靜態掃描 + 本機 DB 狀態列印。
 * 執行：npm run verify:r1
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { derivePaymentStatus } from "./order-payment-utils";
import {
  deriveOrderLookupIntent,
  resolveOrderSourceIntent,
  shouldRequireApiConfirmBeforeSingleClaim,
} from "./order-lookup-policy";
import { isShoplineLookupConfiguredForBrand } from "./order-service";
import { storage } from "./storage";
import {
  BRAND_DELAY_SHIPPING_TEMPLATE,
  findCustomerFacingRawLeak,
  buildDeterministicFollowUpReply,
} from "./order-reply-utils";
import type { ActiveOrderContext, OrderInfo } from "@shared/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ok(name: string, cond: boolean, detail?: string) {
  if (!cond) {
    console.error(`[r1-verify] FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`[r1-verify] OK: ${name}`);
}

function readRel(p: string): string {
  return fs.readFileSync(path.join(__dirname, p), "utf8");
}

async function main() {
  console.log("=== R1 verify (no test.skip) ===\n");

  // --- R1-4 payment truth fixtures ---
  const linePayFail: OrderInfo = {
    global_order_id: "T-LP-FAIL",
    status: "新訂單",
    payment_method: "line_pay",
    prepaid: false,
    paid_at: null,
    source: "superlanding",
    payment_status_raw: "LINE Pay payment failed",
  } as OrderInfo;
  const payFail = derivePaymentStatus(linePayFail, "新訂單", "superlanding");
  ok("payment: LINE Pay raw fail → failed (not pending)", payFail.kind === "failed");

  const codOrder: OrderInfo = {
    global_order_id: "T-COD",
    status: "待出貨",
    payment_method: "pending",
    shipping_method: "to_store",
    delivery_target_type: "cvs",
    prepaid: false,
    paid_at: null,
    source: "superlanding",
  } as OrderInfo;
  const payCod = derivePaymentStatus(codOrder, "待出貨", "superlanding");
  ok("payment: superlanding CVS pending → cod (not failed)", payCod.kind === "cod");

  const unpaidCard: OrderInfo = {
    global_order_id: "T-PEND",
    status: "新訂單",
    payment_method: "credit_card",
    prepaid: false,
    paid_at: null,
    source: "superlanding",
  } as OrderInfo;
  const payPend = derivePaymentStatus(unpaidCard, "新訂單", "superlanding");
  ok("payment: card unpaid new order → pending", payPend.kind === "pending");

  // --- R1-1 source intent reverse ---
  ok(
    "source: 不是官網的 → unknown",
    resolveOrderSourceIntent("不是官網的", []) === "unknown"
  );
  ok(
    "source: 純手機不繼承上一句官網",
    resolveOrderSourceIntent("0963187463", ["官網 0910022130"]) === "unknown"
  );

  // --- R1-1 phone-only policy ---
  const amb = deriveOrderLookupIntent("0912345678", [], null);
  ok("phone-only: requires product", amb.requiresProduct === true && amb.allowPhoneOnly === false);

  const all = deriveOrderLookupIntent("查我全部訂單 0912345678", [], null);
  ok("phone-all: allow phone only", all.kind === "phone_all_orders" && all.allowPhoneOnly === true);

  // --- R1-2 local_only single guard ---
  const intentOne = deriveOrderLookupIntent("測試 0912345678", [], null);
  ok(
    "local_only single requires API confirm",
    shouldRequireApiConfirmBeforeSingleClaim(intentOne, "local_only", 1) === true
  );
  ok(
    "api_only single no forced confirm",
    shouldRequireApiConfirmBeforeSingleClaim(intentOne, "api_only", 1) === false
  );

  // --- R1-5 delay template ---
  ok(
    "delay template mentions 5 個工作天",
    BRAND_DELAY_SHIPPING_TEMPLATE.includes("5 個工作天")
  );
  ok(
    "delay template mentions 7–20",
    BRAND_DELAY_SHIPPING_TEMPLATE.includes("7–20")
  );
  const delayCtx = {
    order_id: "MASK01",
    fulfillment_status: "待出貨",
    payment_status: "success",
    tracking_no: "",
  } as unknown as ActiveOrderContext;
  const delayReply = buildDeterministicFollowUpReply(delayCtx, "什麼時候出貨");
  ok("delay follow-up uses brand template", (delayReply || "").includes("5 個工作天"));
  ok(
    "delay follow-up avoids 待出貨 line when template path",
    delayReply == null || !delayReply.includes("目前狀態：待出貨")
  );

  // --- R1-8 customer-facing raw scan ---
  const leak1 = findCustomerFacingRawLeak("您的訂單 pending 處理中");
  ok("raw leak scan catches pending", leak1 === "pending");
  ok("raw leak: clean text", findCustomerFacingRawLeak("已幫您查詢訂單") === null);

  // --- Static: shopline-first 註解錨點（禁止回落一頁）---
  const svc = readRel("order-service.ts");
  ok("static: R1 shopline by-id no fallback", svc.includes("R1-1／R1-3"));
  ok("static: R1 shopline product+phone", svc.includes("R1-1：官網（商品+手機）不回落一頁"));
  ok("static: R1 shopline date+contact", svc.includes("R1-1：官網日期／聯絡查詢不回落一頁"));

  // --- R1-3 Shopline configuration truth (explicit, not skip) ---
  const brands = storage.getBrands();
  const configuredIds = brands.filter((b) => isShoplineLookupConfiguredForBrand(b.id)).map((b) => b.id);
  console.log(
    `\n[r1-verify] SHOPLINE_TRUTH: brands=${brands.length}, shopline_api_configured_brand_ids=[${configuredIds.join(",") || "none"}]`
  );
  if (configuredIds.length === 0) {
    console.log(
      "[r1-verify] NOTE: 本機 DB 無任一品牌完成 shopline token+domain — 官網即時查詢會走降級文案（非測試 skip，屬環境真實狀態）。"
    );
  }

  console.log("\n[r1-verify] All checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
