/**
 * Phase34B：行為級 fixture + reply-level 斷言（非僅原始碼字串掃描）
 * 執行：npm run verify:phase34b
 *
 * 必修 1：local_only 候選摘要
 * 必修 2：真實結構 payload → mapSuperlandingOrderFromApiPayload → derivePaymentStatus
 * 必修 3：品牌 delay / 物流追問 runtime reply
 * 必修 4：對客路徑 raw denylist
 * 必修 5：本檔 + package 腳本為準；請務必在終端實跑。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { derivePaymentStatus } from "./order-payment-utils";
import { mapSuperlandingOrderFromApiPayload, getStatusLabel } from "./superlanding";
import {
  formatLocalOnlyCandidateSummary,
  formatOrderOnePage,
  buildDeterministicFollowUpReply,
  findCustomerFacingRawLeak,
  payKindForOrder,
} from "./order-reply-utils";
import { getUnifiedStatusLabel } from "./order-service";
import { shouldBypassLocalPhoneIndex } from "./order-lookup-policy";
import { packDeterministicMultiOrderToolResult } from "./order-multi-renderer";
import { buildSingleOrderCustomerReply } from "./order-single-renderer";
import type { OrderInfo, ActiveOrderContext } from "@shared/schema";
import type { IStorage } from "./storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`[phase34b-verify] FAIL: ${msg}`);
}

function loadSanitizedFixture(fileName: string): Record<string, unknown> {
  const p = path.join(ROOT, "docs", "runtime-audit", fileName);
  assert(fs.existsSync(p), `fixture missing: ${p}`);
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  delete raw._comment;
  return raw;
}

function assertNoRawLeak(reply: string, pathLabel: string) {
  const hit = findCustomerFacingRawLeak(reply);
  assert(hit === null, `${pathLabel}: 不得對客露出 raw「${hit}」\n---\n${reply.slice(0, 500)}`);
}

function main() {
  let pass = 0;
  const ok = (name: string) => {
    pass++;
    console.log(`  OK ${pass}. ${name}`);
  };

  console.log("[phase34b-verify] 開始（行為級 fixture）…");

  // --- 必修 1：候選摘要 ≠ final card ---
  const cand = formatLocalOnlyCandidateSummary({
    order_id: "ESC20981",
    created_at: "2026-03-20T14:22:00+08:00",
    product_list: JSON.stringify([{ code: "測試品", qty: 1 }]),
    source_channel: "一頁商店",
    status_short: "新訂單",
  });
  assert(cand.includes("候選"), "候選摘要標題");
  assert(cand.includes("還有其他訂單嗎") || cand.includes("還有其他訂單"), "下一步引導");
  assert(!/幫您查到了|我查到這筆了/.test(cand), "無定案語");
  assert(!cand.includes("付款方式："), "不含完整明細：付款方式列");
  assert(!cand.includes("電話："), "不含完整明細：電話列");
  assert(!cand.includes("收件人："), "不含完整明細：收件人列");
  ok("必修1 local_only candidate summary（非 final card）");

  // --- 必修 2：扁平 fixture → mapOrder → derivePaymentStatus ---
  const flatFixture = loadSanitizedFixture("superlanding-esc20981-linepay-fail.fixture.sanitized.json");
  const orderFlat = mapSuperlandingOrderFromApiPayload(flatFixture);
  assert(orderFlat.global_order_id === "ESC20981", "mapOrder: global_order_id");
  assert(!!orderFlat.payment_status_raw, "mapOrder: payment_status_raw 必須有值");
  assert(/failed|紅叉|未成立|error/i.test(orderFlat.payment_status_raw!), "mapOrder: payment_status_raw 必須含失敗訊號");
  const stFlat = getStatusLabel(orderFlat.status);
  const payFlat = derivePaymentStatus(orderFlat, stFlat, "superlanding");
  assert(payFlat.kind === "failed", `derivePaymentStatus 須為 failed，實際 kind=${payFlat.kind} reason=${payFlat.reason}`);
  assert(
    payFlat.label.includes("付款失敗") && payFlat.label.includes("訂單未成立"),
    `對客 label 須含「付款失敗／訂單未成立」，實際=${payFlat.label}`
  );
  ok("必修2a ESC20981 扁平 fixture：payload → mapOrder → failed");

  const nestFixture = loadSanitizedFixture("superlanding-esc20981-nested-order-wrapper.fixture.sanitized.json");
  const orderNest = mapSuperlandingOrderFromApiPayload(nestFixture);
  assert(/failed|nested\.order\.status|未成立|紅叉/i.test(orderNest.payment_status_raw || ""), "nested wrapper：raw 仍含失敗訊號");
  const stNest = getStatusLabel(orderNest.status);
  const payNest = derivePaymentStatus(orderNest, stNest, "superlanding");
  assert(payNest.kind === "failed", `nested fixture 須 failed，實際=${payNest.kind}`);
  ok("必修2b nested order{} wrapper：仍為 failed");

  // --- 必修 3：品牌話術 runtime（helper 路徑即 production 所用同一函式）---
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
  const r1 = buildDeterministicFollowUpReply(ctxDelay, "什麼時候會出貨");
  assert(!!r1 && r1.includes("5 個工作天") && r1.includes("7–20 個工作天"), "什麼時候會出貨 → 品牌 delay");
  const r2 = buildDeterministicFollowUpReply(
    { ...ctxDelay, payment_status: "cod" },
    "怎麼還沒寄"
  );
  assert(!!r2 && r2.includes("貨到付款") && r2.includes("不是付款失敗"), "COD 怎麼還沒寄");
  assert(r2!.includes("5 個工作天"), "COD 待出貨無追蹤仍帶工作天承諾區間");
  const ctxShipped: ActiveOrderContext = {
    ...ctxDelay,
    fulfillment_status: "已出貨",
    tracking_no: "1234567890",
  };
  const r3 = buildDeterministicFollowUpReply(ctxShipped, "什麼時候收到");
  assert(!!r3 && /不好意思|抱歉/.test(r3) && /物流|單號/.test(r3), "有單號時「什麼時候收到」→ 道歉＋物流引導");
  assert(!r3!.includes("7–20 個工作天"), "有追蹤時不使用預購 7–20 工作天主模板");
  ok("必修3 品牌 delay / COD / 已出貨追問 reply");

  // --- 必修 4：全路徑對客 raw（reply 字串層）---
  const rawish: OrderInfo = {
    global_order_id: "R1",
    status: "待出貨",
    final_total_order_amount: 1,
    product_list: "[]",
    buyer_name: "",
    buyer_phone: "",
    buyer_email: "",
    tracking_number: "",
    created_at: "",
    source: "superlanding",
    payment_method: "pending",
    shipping_method: "to_store",
    prepaid: false,
    paid_at: null as unknown as string,
  };
  const onePage = formatOrderOnePage({
    order_id: rawish.global_order_id,
    payment_method: rawish.payment_method,
    shipping_method: rawish.shipping_method,
    product_list: rawish.product_list,
    status: "待出貨",
    source: "superlanding",
    prepaid: false,
    paid_at: null,
  });
  assertNoRawLeak(onePage, "formatOrderOnePage(pending/to_store)");

  const pk = payKindForOrder(rawish, "待出貨", "superlanding");
  const onePage2 = formatOrderOnePage({
    order_id: "R2",
    payment_method: "credit_card",
    shipping_method: "home",
    payment_status_label: pk.label,
    product_list: "[]",
    status: "待出貨",
  });
  assertNoRawLeak(onePage2, "formatOrderOnePage(credit_card)");

  const singlePacked = buildSingleOrderCustomerReply("前綴", onePage);
  assertNoRawLeak(singlePacked, "order-single-renderer buildSingleOrderCustomerReply");

  const mockStorage = { setActiveOrderContext: () => {} } as unknown as IStorage;
  const multiPack = packDeterministicMultiOrderToolResult({
    orders: [rawish],
    orderSource: "superlanding",
    headerLine: "測試多筆",
    contactId: undefined,
    storage: mockStorage,
    matchedBy: "text",
    renderer: "test_multi",
  });
  const multiFull = String(multiPack.one_page_full || "");
  assertNoRawLeak(multiFull, "order-multi-renderer one_page_full");

  const follow = buildDeterministicFollowUpReply(ctxDelay, "出貨了嗎");
  assertNoRawLeak(follow!, "active follow-up deterministic");

  const candLeak = formatLocalOnlyCandidateSummary({
    order_id: "Z1",
    product_list: "[]",
    source_channel: "官網（SHOPLINE）",
  });
  assertNoRawLeak(candLeak, "local_only candidate summary");
  ok("必修4 對客路徑 denylist（pending / to_store / credit_card）");

  // --- 必修 4b：手機查單跳過本地早退（與 routes / fast-path 一致）---
  assert(shouldBypassLocalPhoneIndex("還有其他訂單嗎", [], null), "bypass：其他訂單");
  assert(shouldBypassLocalPhoneIndex("我有幾筆訂單", [], null), "bypass：我有幾筆");
  assert(
    shouldBypassLocalPhoneIndex("0912345678", ["想查官網那筆"], null),
    "bypass：上一句官網語意"
  );
  assert(
    shouldBypassLocalPhoneIndex("官網 0912345678", [], null),
    "bypass：當句官網＋手機"
  );
  assert(!shouldBypassLocalPhoneIndex("0912345678", [], null), "no bypass：純手機無語境");
  ok("必修4b shouldBypassLocalPhoneIndex（全部/官網 → 強制 live 路徑）");

  // --- 必修 5：與 order-service 標籤路徑一致（phone tool 模擬）---
  const stU = getUnifiedStatusLabel(orderFlat.status, "superlanding");
  const pkU = payKindForOrder(orderFlat, stU, "superlanding");
  assert(pkU.kind === "failed", "payKindForOrder 與 derivePaymentStatus 一致 failed");
  ok("必修5 payKindForOrder 與 fixture 一致");

  console.log(`[phase34b-verify] 全部通過：${pass} 項`);
}

main();
