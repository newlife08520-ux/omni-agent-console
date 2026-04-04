/**
 * Phase 2.6：webhook 最後一哩、deterministic、normalizer、latency log
 * npx tsx server/phase26-verify.ts
 *
 * @deprecated Phase 26 靜態驗證——已被 vitest 行為測試取代。
 * 本檔僅做 fs.readFileSync + includes 字串檢查，不測試實際行為。
 * 保留供歷史參考，新功能請寫 server/__tests__/*.test.ts。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { assembleEnrichedSystemPrompt } from "./services/prompt-builder";
import { normalizeCustomerFacingOrderReply } from "./customer-reply-normalizer";
import { packDeterministicSingleOrderToolResult } from "./order-single-renderer";
import { isValidOrderDeterministicPayload, orderDeterministicContractFields } from "./deterministic-order-contract";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`[phase26-verify] FAIL: ${msg}`);
}

const C = orderDeterministicContractFields();

/** 與 routes Phase27 tool loop 一致：契約 + 同輪最後一筆 */
function pickLastDeterministic(toolCalls: { name: string; result: Record<string, unknown> }[]) {
  let reply: string | null = null;
  let meta: { renderer?: string; tool_name?: string } = {};
  for (const tc of toolCalls) {
    const pr = tc.result;
    if (isValidOrderDeterministicPayload(pr)) {
      reply = String(pr.deterministic_customer_reply).trim();
      meta = { renderer: typeof pr.renderer === "string" ? pr.renderer : undefined, tool_name: tc.name };
    }
  }
  return { reply, meta };
}

async function main() {
  let n = 0;
  const ok = (s: string) => console.log(`  OK ${++n}. ${s}`);

  const pick = pickLastDeterministic([
    {
      name: "lookup_order_by_id",
      result: { deterministic_skip_llm: true, deterministic_customer_reply: "A", renderer: "r1", ...C },
    },
    {
      name: "lookup_order_by_phone",
      result: { deterministic_skip_llm: true, deterministic_customer_reply: "B", renderer: "r2", ...C },
    },
  ]);
  assert(pick.reply === "B" && pick.meta.tool_name === "lookup_order_by_phone", "最後一筆 deterministic 優先");
  ok("generic deterministic：多 tool 以最後為準");

  const fiveNames = [
    "lookup_order_by_id",
    "lookup_order_by_product_and_phone",
    "lookup_order_by_date_and_contact",
    "lookup_more_orders",
    "lookup_more_orders_shopline",
  ] as const;
  for (const name of fiveNames) {
    const p = pickLastDeterministic([
      {
        name,
        result: {
          deterministic_skip_llm: true,
          deterministic_customer_reply: `reply-${name}`,
          renderer: `renderer_${name}`,
          ...C,
        },
      },
    ]);
    assert(p.reply === `reply-${name}` && p.meta.tool_name === name, name);
  }
  ok("五種 order tool 皆可被 generic 選出 deterministic reply");

  const single = packDeterministicSingleOrderToolResult({
    renderer: "deterministic_single_test",
    one_page_summary: "訂單#X｜待出貨",
  });
  assert(
    single.deterministic_skip_llm === false &&
      String(single.one_page_summary).includes("訂單#X") &&
      single.deterministic_contract_version === 1 &&
      single.deterministic_domain === "order",
    "single pack + contract"
  );
  ok("單筆 tool packer 契約（不跳過 LLM）");

  const dirty =
    "很高興能為您服務！別擔心，訂單已出貨。希望這些資訊對您有幫助！若您還有任何疑問，歡迎隨時告訴我！祝您有美好的一天！訂單 A123。";
  const norm = normalizeCustomerFacingOrderReply(dirty, { mode: "order_lookup", replySource: "llm" });
  assert(!norm.changed && norm.rulesHit.length === 0 && norm.text === dirty, "normalizer passthrough (rescue)");
  ok("final normalizer 已停用（原樣交還 LLM）");

  const ultra = await assembleEnrichedSystemPrompt(1, { planMode: "order_lookup" });
  assert(ultra.prompt_profile === "order_lookup_ultra_lite", "profile");
  assert(!ultra.full_prompt.includes("--- CATALOG ---"), "ultra 無 CATALOG");
  assert(ultra.full_prompt.length < 1200, "ultra 長度上限 phase27");
  ok("ultra-lite prompt 生效");

  const fol = await assembleEnrichedSystemPrompt(1, { planMode: "order_lookup", hasActiveOrderContext: true });
  assert(fol.prompt_profile === "order_followup_ultra_lite", "followup profile");
  assert(fol.full_prompt.length <= ultra.full_prompt.length, "followup 不大於 lookup ultra");
  ok("order_followup_ultra_lite");

  const routes = fs.readFileSync(path.join(__dirname, "routes.ts"), "utf8");
  assert(routes.includes("deterministic_tool_reply_selected=true"), "deterministic_tool_reply_selected");
  assert(routes.includes("final_normalizer_changed="), "final_normalizer_changed");
  assert(routes.includes("[phase26_latency]"), "phase26_latency");
  assert(routes.includes("second_llm_skipped"), "second_llm_skipped");
  assert(routes.includes("final_renderer="), "final_renderer");
  assert(routes.includes('reply_source: secondLlmSkipped ? "deterministic_tool"'), "ai_log reply_source deterministic");
  ok("routes：latency / normalizer / ai_log 關鍵字");

  const pb = fs.readFileSync(path.join(__dirname, "services/prompt-builder.ts"), "utf8");
  assert(pb.includes("getBrandReplyMeta") && pb.includes("buildOrderLookupUltraLitePrompt"), "ultra builder");
  ok("prompt-builder ultra-lite + getBrandReplyMeta");

  const normSrc = fs.readFileSync(path.join(__dirname, "customer-reply-normalizer.ts"), "utf8");
  assert(normSrc.includes("normalizeCustomerFacingOrderReply"), "normalizer export");
  ok("customer-reply-normalizer 模組存在");

  console.log(`[phase26-verify] 通過 ${n} 項`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
