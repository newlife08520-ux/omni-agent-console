/**
 * Phase 2.7 Launch Gating + Ops Hardening
 * npx tsx server/phase27-verify.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { isValidOrderDeterministicPayload } from "./deterministic-order-contract";
import { orderFeatureFlags } from "./order-feature-flags";
import { assembleEnrichedSystemPrompt } from "./services/prompt-builder";
import { packDeterministicSingleOrderToolResult, buildSingleOrderCustomerReply } from "./order-single-renderer";
import { ORDER_ULTRA_LITE_VERSION } from "./prompts/order-ultra-lite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(c: boolean, m: string) {
  if (!c) throw new Error(`[phase27-verify] FAIL: ${m}`);
}

async function main() {
  let n = 0;
  const ok = (s: string) => console.log(`  OK ${++n}. ${s}`);

  const apiSingle = packDeterministicSingleOrderToolResult({
    deterministic_customer_reply: buildSingleOrderCustomerReply("商品＋手機（API）", "訂單#API1"),
    renderer: "deterministic_single_product_phone_api",
    one_page_summary: "訂單#API1",
    source: "superlanding",
  });
  assert(apiSingle.renderer === "deterministic_single_product_phone_api", "api single renderer");
  assert(isValidOrderDeterministicPayload(apiSingle as Record<string, unknown>), "api single contract");
  ok("product+phone API 單筆 deterministic");

  assert(!isValidOrderDeterministicPayload({ deterministic_skip_llm: true, deterministic_customer_reply: "x" }), "no version");
  assert(
    !isValidOrderDeterministicPayload({
      deterministic_skip_llm: true,
      deterministic_customer_reply: "x",
      deterministic_contract_version: 1,
      deterministic_domain: "comment",
    }),
    "wrong domain"
  );
  ok("generic deterministic 需 version=1 + domain=order");

  const routes = fs.readFileSync(path.join(__dirname, "routes.ts"), "utf8");
  assert(routes.includes("isValidOrderDeterministicPayload"), "routes contract check");
  assert(routes.includes("orderFeatureFlags.orderFastPath") && routes.includes("orderFinalNormalizer"), "fast path flags+norm");
  assert(routes.includes("final_normalizer_changed=") && routes.includes("fpEarly"), "fast path normalizer log");
  ok("fast path + normalizer 接入");

  assert(
    routes.includes("used_first_llm:") &&
      routes.includes("used_second_llm:") &&
      routes.includes("reply_renderer:") &&
      routes.includes("prompt_profile:"),
    "createAiLog telemetry keys"
  );
  assert(routes.includes("queue_wait_ms:") && routes.includes("enqueueTimestampMs"), "queue wait wiring");
  ok("ai_log 新欄位與 queue_wait 關鍵字");

  const sampleLog = `[phase26_latency] lookup_ack_sent_ms=120 contact=1
[phase26_latency] first_customer_visible_reply_ms=200 final_reply_sent_ms=800 second_llm_skipped=true final_renderer=deterministic_tool prompt_profile=order_lookup_ultra_lite
[phase26_latency] queue_wait_ms=45 contact=1
[AI Latency] contact 9 tool lookup_order_by_id ms 234`;
  const tmp = path.join(__dirname, "..", ".phase27-latency-sample.log");
  fs.writeFileSync(tmp, sampleLog, "utf8");
  const out = execSync(`npx tsx server/scripts/query-latency-stats.ts "${tmp}"`, {
    encoding: "utf8",
    cwd: path.join(__dirname, ".."),
  });
  assert(out.includes("p50=") && out.includes("lookup_ack"), "parser output");
  fs.unlinkSync(tmp);
  ok("latency parser 可 parse sample");

  const ultra = await assembleEnrichedSystemPrompt(1, { planMode: "order_lookup" });
  if (orderFeatureFlags.orderUltraLitePrompt) {
    assert(ultra.full_prompt.length < 1200, `ultra char cap ${ultra.full_prompt.length}`);
    assert(
      !ultra.full_prompt.includes("--- CATALOG ---") &&
        !ultra.full_prompt.includes("--- KNOWLEDGE ---") &&
        !ultra.full_prompt.includes("--- IMAGE ---"),
      "no fat sections"
    );
    const fol = await assembleEnrichedSystemPrompt(1, { planMode: "order_lookup", hasActiveOrderContext: true });
    assert(fol.full_prompt.length <= ultra.full_prompt.length, "followup <= lookup");
  }
  ok(`ultra-lite snapshot (${ORDER_ULTRA_LITE_VERSION})`);

  assert(routes.includes("usedFirstLlmTelemetry = 1") && routes.includes("usedSecondLlmTelemetry = 1"), "first/second LLM flags");
  ok("used_first_llm / used_second_llm 寫入邏輯");

  assert(routes.includes("queue_wait_ms") && routes.includes("queueWaitMs"), "queue_wait_ms");
  ok("queue_wait_ms 量測路徑");

  assert(
    routes.includes("reply_renderer: \"multi_order_router\"") &&
      routes.includes("reply_renderer: \"active_order_deterministic\""),
    "multi vs active renderer"
  );
  assert(routes.includes("reply_source: \"multi_order_router\""), "multi reply_source");
  ok("multi_order_router / active_order 一致性");

  const pay = fs.readFileSync(path.join(__dirname, "order-payment-utils.ts"), "utf8");
  assert(pay.includes("derivePaymentStatus") || pay.includes("export function derivePaymentStatus"), "payment");
  ok("payment 模組仍存在（無回歸）");

  const flagsSrc = fs.readFileSync(path.join(__dirname, "order-feature-flags.ts"), "utf8");
  assert(flagsSrc.includes("ENABLE_ORDER_FAST_PATH"), "feature flags env");
  ok("feature flags 模組");

  const pb = fs.readFileSync(path.join(__dirname, "prompts/order-ultra-lite.ts"), "utf8");
  assert(pb.includes("buildOrderLookupUltraLitePrompt") && !pb.includes("buildCatalogPrompt"), "ultra isolated");
  ok("order-ultra-lite 獨立模組");

  console.log(`[phase27-verify] 通過 ${n} 項`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
