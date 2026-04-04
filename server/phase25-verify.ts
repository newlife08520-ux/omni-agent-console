/**
 * Phase 2.5 驗證：npx tsx server/phase25-verify.ts
 *
 * @deprecated Phase 25 靜態驗證——已被 vitest 行為測試取代。
 * 本檔僅做 fs.readFileSync + includes 字串檢查，不測試實際行為。
 * 保留供歷史參考，新功能請寫 server/__tests__/*.test.ts。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { assembleEnrichedSystemPrompt } from "./services/prompt-builder";
import { derivePaymentStatus } from "./order-payment-utils";
import { deterministicReplyHasBannedPhrase } from "./order-reply-utils";
import { filterOrdersByDateRange } from "./order-service";
import type { OrderInfo } from "@shared/schema";
import { packDeterministicMultiOrderToolResult } from "./order-multi-renderer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`[phase25-verify] FAIL: ${msg}`);
}

async function main() {
  let n = 0;
  const ok = (s: string) => console.log(`  OK ${++n}. ${s}`);

  const lite = await assembleEnrichedSystemPrompt(1, { planMode: "order_lookup" });
  assert(lite.prompt_profile === "order_lookup_ultra_lite", "profile order_lookup_ultra_lite");
  assert(!lite.includes.catalog && !lite.includes.knowledge && !lite.includes.image, "lite no c/k/i");
  assert(lite.full_prompt.length < 2500, "ultra-lite 顯著短於肥 prompt");
  ok("order_lookup_ultra_lite 不含 catalog/knowledge/image");

  const pbSrc = fs.readFileSync(path.join(__dirname, "services/prompt-builder.ts"), "utf8");
  assert(pbSrc.includes("answer_directly_full") && pbSrc.includes("buildCatalogPrompt"), "full 路徑含 catalog");
  ok("answer_directly_full 程式含 catalog（避免 verify 拉整包 catalog API）");

  const fol = await assembleEnrichedSystemPrompt(1, {
    planMode: "order_lookup",
    hasActiveOrderContext: true,
  });
  assert(fol.prompt_profile === "order_followup_ultra_lite", "followup ultra_lite");
  assert(fol.full_prompt.length <= lite.full_prompt.length, "followup 不大於 lookup ultra");
  ok("order_followup_ultra_lite");

  const o1: OrderInfo = {
    global_order_id: "X1",
    status: "新訂單",
    final_total_order_amount: 1,
    product_list: "[]",
    buyer_name: "",
    buyer_phone: "",
    buyer_email: "",
    tracking_number: "",
    created_at: "",
    payment_method: "credit_card",
    prepaid: false,
    source: "superlanding",
  };
  assert(derivePaymentStatus(o1, "新訂單", "superlanding").kind === "pending", "cc unpaid pending");
  const o2: OrderInfo = { ...o1, global_order_id: "X2", status: "待出貨", payment_method: "virtual_account" };
  assert(derivePaymentStatus(o2, "待出貨", "superlanding").kind === "pending", "atm pending");
  const o3: OrderInfo = {
    ...o1,
    global_order_id: "X3",
    status: "已取消",
    payment_status_raw: "cancelled",
  };
  assert(derivePaymentStatus(o3, "已取消", "superlanding").kind === "failed", "cancel failed via payment_status_raw");
  ok("payment truth v2 pending/failed");

  const d1: OrderInfo = {
    ...o1,
    global_order_id: "D1",
    order_created_at: "2026-03-10T10:00:00+08:00",
    created_at: "2026-03-10T10:00:00+08:00",
  };
  const d2: OrderInfo = { ...d1, global_order_id: "D2", order_created_at: "2026-04-01T10:00:00+08:00" };
  assert(filterOrdersByDateRange([d1, d2], "2026-03-01", "2026-03-31").length === 1, "date filter");
  ok("date range filter");

  const noop = { setActiveOrderContext: () => {} } as unknown as import("./storage").IStorage;
  const pack = packDeterministicMultiOrderToolResult({
    orders: [d1, d2],
    orderSource: "superlanding",
    headerLine: "測試",
    contactId: undefined,
    storage: noop,
    matchedBy: "text",
    renderer: "test",
  });
  assert(
    pack.deterministic_skip_llm === false && Array.isArray((pack as { orders?: unknown }).orders),
    "pack multi (JSON for LLM)"
  );
  ok("multi deterministic pack");

  const det = "訂單 A；貨到付款；狀態：待出貨。";
  assert(!deterministicReplyHasBannedPhrase(det), "no banned");
  ok("deterministic 無禁用句");

  const toolEx = fs.readFileSync(path.join(__dirname, "services/tool-executor.service.ts"), "utf8");
  assert(toolEx.includes("deterministic_skip_llm: false"), "tool executor skips llm=false");
  const coreRoutes = fs.readFileSync(path.join(__dirname, "routes", "core.routes.ts"), "utf8");
  assert(coreRoutes.includes("packDeterministicMultiOrderToolResult"), "routes uses pack");
  ok("log 關鍵字存在");

  const pb = fs.readFileSync(path.join(__dirname, "services/prompt-builder.ts"), "utf8");
  assert(
    pb.includes("buildOrderLookupUltraLitePrompt") && pb.includes("getBrandReplyMeta"),
    "builder ultra-lite + meta"
  );
  ok("prompt-builder ultra-lite 分流");

  console.log(`[phase25-verify] 通過 ${n} 項`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
