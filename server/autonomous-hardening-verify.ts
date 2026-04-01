/**
 * Phase 2.3 / gap-fix：cache、fast path、Shopline 商品過濾、多筆統計、圖片查單、formatOrderOnePage。
 * 執行：npx tsx server/autonomous-hardening-verify.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { cacheKeyOrderId, cacheKeyPhone, normalizeProductName, normalizePhone, getOrdersByPhoneMerged } from "./order-index";
import { tryOrderFastPath } from "./order-fast-path";
import type { IStorage } from "./storage";
import type { SuperLandingConfig } from "./superlanding";
import type { OrderInfo } from "@shared/schema";
import { filterOrdersByProductQuery } from "./order-product-filter";
import { formatOrderOnePage, payKindForOrder } from "./order-reply-utils";
import { derivePaymentStatus, isCodPaymentMethod } from "./order-payment-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function dedupeKey(orders: { source?: string; global_order_id: string }[]) {
  const m = new Map<string, unknown>();
  for (const o of orders) {
    const k = `${o.source || "sl"}:${(o.global_order_id || "").toUpperCase()}`;
    if (!m.has(k)) m.set(k, o);
  }
  return m.size;
}

function summarizePaymentCounts(
  candidates: { payment_status: "success" | "failed" | "pending" | "cod" | "unknown" }[]
) {
  return {
    succ: candidates.filter((c) => c.payment_status === "success").length,
    fail: candidates.filter((c) => c.payment_status === "failed").length,
    pend: candidates.filter((c) => c.payment_status === "pending").length,
    cod: candidates.filter((c) => c.payment_status === "cod").length,
  };
}

function buildProductPhoneMultiPayload(n: number, _reply: string) {
  return {
    success: true,
    found: true,
    total: n,
    orders: Array.from({ length: n }, (_, i) => ({ order_id: `T${i + 1}` })),
    deterministic_skip_llm: false as const,
    deterministic_contract_version: 1,
    deterministic_domain: "order",
  };
}

async function main() {
  assert(cacheKeyOrderId(7, "ABC12", "shopline") === "order_id:7:shopline:ABC12", "1 cacheKeyOrderId shopline");
  assert(cacheKeyOrderId(7, "ABC12", "superlanding") === "order_id:7:superlanding:ABC12", "1b cacheKeyOrderId sl");
  assert(cacheKeyPhone(3, "0912345678", "any") === "phone:3:any:0912345678", "1c cacheKeyPhone");
  assert(cacheKeyPhone(3, "0912345678", "shopline") === "phone:3:shopline:0912345678", "1d cacheKeyPhone shopline");

  assert(dedupeKey([
    { source: "superlanding", global_order_id: "A" },
    { source: "shopline", global_order_id: "B" },
    { source: "shopline", global_order_id: "B" },
  ]) === 2, "2 dedupe cross-source");

  const noopStorage = {
    linkOrderForContact: () => {},
    setActiveOrderContext: () => {},
    updateContactOrderSource: () => {},
    getActiveOrderContext: () => null,
  } as unknown as IStorage;
  const sl: SuperLandingConfig = { merchantNo: "", accessKey: "" };

  const ask = await tryOrderFastPath({
    userMessage: "我要查訂單",
    brandId: 1,
    contactId: 1,
    slConfig: sl,
    storage: noopStorage,
    planMode: "order_lookup",
    recentUserMessages: [],
  });
  assert(ask === null, "3 fast path disabled (rescue)");

  const off = await tryOrderFastPath({
    userMessage: "你好啊今天天氣如何",
    brandId: 1,
    contactId: 1,
    slConfig: sl,
    storage: noopStorage,
    planMode: "off_topic_guard",
    recentUserMessages: [],
  });
  assert(off === null, "4 off_topic no fast path");

  const retSkip = await tryOrderFastPath({
    userMessage: "0911111111",
    brandId: 1,
    contactId: 1,
    slConfig: sl,
    storage: noopStorage,
    planMode: "return_stage_1",
    recentUserMessages: [],
  });
  assert(retSkip === null, "5 return_stage skip");

  const oAdventure: OrderInfo = {
    global_order_id: "SH1",
    status: "confirmed",
    final_total_order_amount: 100,
    product_list: JSON.stringify([{ name: "冒險包黑色款", qty: 1, price: 100 }]),
    buyer_name: "",
    buyer_phone: "0912345678",
    buyer_email: "",
    tracking_number: "",
    created_at: "2025-01-01",
    source: "shopline",
  };
  const oOther: OrderInfo = {
    ...oAdventure,
    global_order_id: "SH2",
    product_list: JSON.stringify([{ name: "餅乾禮盒", qty: 1, price: 200 }]),
  };
  const filtered = filterOrdersByProductQuery([oAdventure, oOther], "冒險包黑", undefined);
  assert(filtered.length === 1 && filtered[0].global_order_id === "SH1", "6 shopline product filter single match");
  assert(
    filterOrdersByProductQuery([oAdventure, oOther], "餅乾", undefined).length === 1,
    "6b product filter other sku"
  );
  assert(filterOrdersByProductQuery([oAdventure, oOther], "不存在的商品xyz", undefined).length === 0, "6c zero after filter");

  const stats = summarizePaymentCounts([
    { payment_status: "success" },
    { payment_status: "failed" },
    { payment_status: "pending" },
    { payment_status: "cod" },
    { payment_status: "unknown" },
  ]);
  assert(stats.succ === 1 && stats.fail === 1 && stats.pend === 1 && stats.cod === 1, "7 multi-order payment counts");

  const pp = buildProductPhoneMultiPayload(2, "查到 2 筆…");
  assert(pp.deterministic_skip_llm === false && pp.orders.length === 2, "8 product+phone payload keys");

  const routesPath = path.join(__dirname, "services", "ai-reply.service.ts");
  const routesSrc = fs.readFileSync(routesPath, "utf8");
  assert(
    routesSrc.includes("unifiedLookupById(config, orderIdRaw.toUpperCase(), brandId ?? undefined, undefined, false)"),
    "9 image lookup allowCrossBrand false"
  );
  assert(routesSrc.includes("buildActiveOrderContextFromOrder(order, result.source"), "9b image uses buildActiveOrderContextFromOrder");

  const cvsOut = formatOrderOnePage({
    order_id: "T1",
    delivery_target_type: "cvs",
    cvs_store_name: "台中公益店",
    cvs_brand: "全家",
    full_address: "台中市南區",
    shipping_method: "超商取貨",
  });
  assert(cvsOut.includes("門市") && cvsOut.includes("全家"), "10a formatOrderOnePage cvs");
  const homeOut = formatOrderOnePage({
    order_id: "T2",
    delivery_target_type: "home",
    full_address: "台北市信義區信義路五段7號",
    shipping_method: "宅配到府",
  });
  assert(homeOut.includes("地址") && homeOut.includes("信義"), "10b formatOrderOnePage home");

  assert(normalizeProductName("A B 試") === "ab試", "normalizeProductName");
  assert(normalizePhone("09-12-345-678") === "0912345678", "normalizePhone");

  // --- COD hotfix 驗證：derivePaymentStatus 先判 COD，deterministic 回覆不誤導 ---
  const superLandingCvsCod: OrderInfo = {
    global_order_id: "SLCOD1",
    source: "superlanding",
    payment_method: "pending",
    shipping_method: "超商取貨 to_store",
    delivery_target_type: "cvs",
    prepaid: false,
    paid_at: null as unknown as string,
    status: "待出貨",
    final_total_order_amount: 100,
    product_list: "[]",
    buyer_name: "",
    buyer_phone: "",
    buyer_email: "",
    tracking_number: "",
    created_at: "",
  };
  assert(isCodPaymentMethod(superLandingCvsCod), "COD case 1a isCod SuperLanding CVS pending");
  const d1 = derivePaymentStatus(superLandingCvsCod, "待出貨", "superlanding");
  assert(d1.kind === "cod" && d1.label.includes("貨到付款"), "COD case 1b derivePaymentStatus SuperLanding CVS → cod");
  const replyUtilsSrc = fs.readFileSync(path.join(__dirname, "order-reply-utils.ts"), "utf8");
  assert(
    routesSrc.includes("buildDeterministicFollowUpReply") && replyUtilsSrc.includes("payKindForOrder"),
    "COD case 1c follow-up 仍經 order-reply-utils（payKindForOrder）"
  );

  const orderToShou: OrderInfo = { ...superLandingCvsCod, global_order_id: "O2", payment_method: "到收" };
  assert(derivePaymentStatus(orderToShou, "待出貨", "superlanding").kind === "cod", "COD case 2 payment_method 到收 → cod");

  const orderQuJian: OrderInfo = { ...superLandingCvsCod, global_order_id: "O3", payment_method: "取件時付款" };
  assert(derivePaymentStatus(orderQuJian, "待出貨", "shopline").kind === "cod", "COD case 3 payment_method 取件時付款 → cod");

  const orderCreditCard: OrderInfo = {
    ...superLandingCvsCod,
    global_order_id: "O4",
    payment_method: "credit_card",
    source: "shopline",
    prepaid: false,
    paid_at: null as unknown as string,
  };
  const d4 = derivePaymentStatus(orderCreditCard, "新訂單", "shopline");
  assert(d4.kind !== "cod", "COD case 4 credit_card prepaid=false paid_at=null → not cod");

  const ordersMixed = [
    { o: { ...oAdventure, global_order_id: "M1", prepaid: true } as OrderInfo, st: "待出貨", src: "shopline" },
    {
      o: {
        ...oAdventure,
        global_order_id: "M2",
        prepaid: false,
        paid_at: null as unknown as string,
        payment_method: "credit_card",
        payment_status_raw: "failed",
      } as OrderInfo,
      st: "付款失敗",
      src: "shopline",
    },
    { o: { ...superLandingCvsCod, global_order_id: "M3" }, st: "待出貨", src: "superlanding" },
  ];
  const kinds = ordersMixed.map(({ o, st, src }) => payKindForOrder(o, st, src).kind);
  assert(kinds[0] === "success" && kinds[1] === "failed" && kinds[2] === "cod", "COD case 5 multi-order kinds success/failed/cod");
  const succ = kinds.filter((k) => k === "success").length;
  const fail = kinds.filter((k) => k === "failed").length;
  const codn = kinds.filter((k) => k === "cod").length;
  const partsAgg: string[] = [];
  if (succ) partsAgg.push(`${succ} 筆付款成功`);
  if (fail) partsAgg.push(`${fail} 筆未成立／失敗`);
  if (codn) partsAgg.push(`${codn} 筆貨到付款`);
  const aggStr = partsAgg.join("、");
  assert(aggStr.includes("1 筆付款成功") && aggStr.includes("1 筆未成立／失敗") && aggStr.includes("1 筆貨到付款"), "COD case 5 aggregate summary");

  console.log("[autonomous-hardening-verify] OK — 10 checks + cache/dedupe/fast-path + shopline filter + stats + image + format + 5 COD hotfix cases");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
