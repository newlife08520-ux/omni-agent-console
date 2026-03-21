/**
 * Phase 33：scenario-based verify（非僅靜態字串）。
 * Tickets 33-1, 33-2, 33-6, 33-7, 33-4（flag）, 33-9
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { derivePaymentStatus } from "./order-payment-utils";
import type { OrderInfo } from "@shared/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`[phase33-verify] ${msg}`);
}

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

export async function runPhase33Verify(): Promise<void> {
  const routes = read("server/routes.ts");
  const flags = read("server/order-feature-flags.ts");
  const policy = read("server/order-lookup-policy.ts");
  const pay = read("server/order-payment-utils.ts");

  assert(policy.includes("detectLookupSourceIntent"), "T33-1: detectLookupSourceIntent");
  assert(policy.includes("LookupSourceIntent"), "T33-1: LookupSourceIntent 含 clear");
  assert(policy.includes("shouldDirectLookupByPhone"), "T33-2: shouldDirectLookupByPhone");
  assert(flags.includes("orderLookupAck"), "T33-4: orderLookupAck flag");
  assert(routes.includes("orderFeatureFlags.orderLookupAck"), "T33-4: routes 以 flag 控制 lookup ack");
  assert(routes.includes("lookup_diagnostic"), "T33-7: lookup_diagnostic 於查無回傳");
  assert(pay.includes("superlanding_linepay_card_fail_signal"), "T33-6: LINE Pay/卡類失敗訊號");

  // —— 行為級：來源意圖 ——
  const pol = await import("./order-lookup-policy.js");
  assert(
    pol.detectLookupSourceIntent("官網 0910022130", []) === "shopline",
    "scenario: 官網+手機 → shopline"
  );
  assert(pol.detectLookupSourceIntent("不是官網的", []) === "clear", "scenario: 不是官網的 → clear");
  assert(
    pol.resolveOrderSourceIntent("0963187463", ["官網 0910022130"]) === "unknown",
    "scenario: 純新手機不繼承官網"
  );
  assert(
    pol.resolveOrderSourceIntent("不是官方網站", []) === "unknown",
    "scenario: 不是官方網站 → unknown（clear 映射）"
  );

  // —— 行為級：phone-only 政策 ——
  assert(
    pol.shouldDirectLookupByPhone("0912345678", [], null) === false,
    "scenario: 純手機不可直接查"
  );
  assert(
    pol.shouldDirectLookupByPhone("查我全部訂單 0912345678", [], null) === true,
    "scenario: 查全部+手機 → 可直接查"
  );
  assert(
    pol.shouldDirectLookupByPhone("冒險包 0912345678", [], null) === true,
    "scenario: 商品+手機 → 可直接查"
  );

  // —— 行為級：付款 v4 ——
  const linePayFail: Partial<OrderInfo> = {
    source: "superlanding",
    payment_method: "line_pay",
    prepaid: false,
    paid_at: null,
    status: "payment_failed",
  };
  const payR = derivePaymentStatus(linePayFail as OrderInfo, "新訂單", "superlanding");
  assert(payR.kind === "failed", `scenario: 一頁 LINE Pay API status 失敗 → failed，got ${payR.kind}`);

  const codOrder: Partial<OrderInfo> = {
    source: "superlanding",
    payment_method: "貨到付款",
    prepaid: false,
    paid_at: null,
    status: "awaiting_for_shipment",
  };
  const codR = derivePaymentStatus(codOrder as OrderInfo, "待出貨", "superlanding");
  assert(codR.kind === "cod", `scenario: COD 維持 cod，got ${codR.kind}`);

  console.log("[phase33-verify] OK — scenario-based 檢查通過");
}

async function main() {
  await runPhase33Verify();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
