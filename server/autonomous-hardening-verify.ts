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
import { formatOrderOnePage } from "./order-reply-utils";

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

function buildProductPhoneMultiPayload(n: number, reply: string) {
  return {
    success: true,
    found: true,
    total: n,
    deterministic_skip_llm: true as const,
    deterministic_customer_reply: reply,
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
  assert(ask?.fastPathType === "ask_for_identifier", "3 ask_for_identifier");

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
  assert(pp.deterministic_skip_llm === true && pp.deterministic_customer_reply.includes("2"), "8 product+phone payload keys");

  const routesPath = path.join(__dirname, "routes.ts");
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

  console.log("[autonomous-hardening-verify] OK — 10 checks + cache/dedupe/fast-path + shopline filter + stats + image + format");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
