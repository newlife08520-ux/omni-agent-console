/**
 * Phase 96：統計 ensureShippingSopCompliance 在出貨語境下是否介入。
 * 執行：npx tsx scripts/phase96-shipping-guard-audit.ts
 */
import { ensureShippingSopCompliance, SHIPPING_SOP_COMPLIANCE_PREFIX } from "../server/sop-compliance-guard";

const USER = "請問什麼時候會出貨？";
const RECENT: string[] = [];

const CASES: { id: string; reply: string }[] = [
  { id: "01_template_only", reply: "您的訂單正在處理中，請耐心等待。" },
  { id: "02_apology_no_timing", reply: "真的很抱歉讓您久等了，我們會盡快處理。" },
  { id: "03_apology_workday", reply: "不好意思久候，現貨大概五個工作天內會幫您寄出喔。" },
  { id: "04_apology_preorder_range", reply: "抱歉讓您等久了，這筆是預購，約七到二十個工作天會安排。" },
  { id: "05_logistics_no_apology", reply: "物流那邊我會幫您催一下進度。" },
  { id: "06_natural_full", reply: "不好意思久等了～現貨我們大約五個工作天內會寄出；預購的話七到二十工作天不等。確切到貨日沒辦法跟您保證，但我可以幫您向物流催促。" },
  { id: "07_short_ok", reply: "抱歉，現貨五工作天內寄出，預購七到二十工作天，無法保證到貨日，可幫催物流。" },
  { id: "08_only_預購", reply: "不好意思，這是預購品，會依檔期出貨喔。" },
  { id: "09_apology_arrange", reply: "抱歉讓您久候，這邊會盡快安排寄出。" },
  { id: "10_cold_status", reply: "狀態：處理中。" },
  { id: "11_apology_ship_word", reply: "真的很抱歉，我們會盡快為您出貨。" },
  { id: "12_apology_delivery", reply: "不好意思，配送作業進行中，請再稍候。" },
  { id: "13_no_shipping_words", reply: "了解，我幫您查一下喔。" },
  { id: "14_already_prefixed", reply: SHIPPING_SOP_COMPLIANCE_PREFIX + "（測試續寫）" },
  { id: "15_apology_warehouse", reply: "抱歉久等，我這邊會請倉儲那邊幫您盯一下進度。" },
];

function main(): void {
  let guard = 0;
  console.log("=== Phase 96 Shipping Guard Audit ===");
  console.log("userMessage:", USER);
  console.log("planMode: order_followup\n");
  for (const c of CASES) {
    const out = ensureShippingSopCompliance(c.reply, "order_followup", "", USER, RECENT);
    const applied = out !== c.reply;
    if (applied) guard++;
    console.log(`[${c.id}] guard=${applied ? "YES" : "no"}`);
    if (applied) console.log("  out_prefix:", JSON.stringify(out.slice(0, 48) + "…"));
  }
  console.log("\n--- summary ---");
  console.log("cases:", CASES.length);
  console.log("guard_triggered:", guard);
  console.log("guard_rate:", ((guard / CASES.length) * 100).toFixed(1) + "%");
}

main();
