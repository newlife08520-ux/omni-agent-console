/**
 * Phase 97：在「預期模型已依 prompt 自然合規」的輸出上量測 Guard；另附兩則刻意叛逆句。
 * 執行：npx tsx scripts/phase97-shipping-guard-audit.ts
 */
import { ensureShippingSopCompliance, SHIPPING_SOP_COMPLIANCE_PREFIX } from "../server/sop-compliance-guard";

const USER = "請問什麼時候會出貨？";
const RECENT: string[] = [];

/** 28 則：預期不需 Guard（道歉＋時程／物流行動等） */
const NATURAL_OK: { id: string; reply: string }[] = [
  { id: "N01", reply: "不好意思久候，現貨大概五個工作天內會幫您寄出；預購的話七到二十工作天不等，沒辦法保證幾號一定到，但我可以幫您向物流催一下。" },
  { id: "N02", reply: "真的很抱歉讓您久等了，現貨我們五個工作天內會安排寄出，預購約七到二十工作天，確切到貨日不便跟您保證，需要我幫您盯物流嗎？" },
  { id: "N03", reply: "抱歉讓您等久了，這筆是預購，約七到二十個工作天會安排，沒辦法說死到貨日，我會幫您留意出貨進度。" },
  { id: "N04", reply: "不好意思，配送這邊還在作業，現貨一般五工作天內寄出；若為預購檔期會到七至二十工作天，我幫您追一下進度。" },
  { id: "N05", reply: "真的很抱歉，我們會盡快為您出貨，現貨約五工作天內，預購七到二十工作天，無法保證到貨日，可幫您催物流。" },
  { id: "N06", reply: "抱歉久等，這邊會盡快安排寄出，現貨五個工作天內，預購七到二十工作天，不亂保證日期，會幫您盯倉儲那邊。" },
  { id: "N07", reply: "不好意思久等了，倉儲正在依序處理，現貨約五工作天內寄出；預購品七到二十工作天，我會幫您盯進度。" },
  { id: "N08", reply: "物流那邊我會幫您催一下進度，另外現貨約五工作天內會寄出，預購七到二十工作天，抱歉讓您久候。" },
  { id: "N09", reply: "真的很抱歉讓您久等了，我們會盡快處理，現貨五工作天內安排寄出，預購七到二十工作天，不保證到貨日。" },
  { id: "N10", reply: "不好意思，預購品約七到二十工作天，現貨五工作天內寄出，沒辦法保證物流哪天到，我幫您加急留意。" },
  { id: "N11", reply: "抱歉，目前訂單量大，現貨仍約五工作天內寄出；預購七到二十工作天，我會向物流確認並幫您催。" },
  { id: "N12", reply: "讓您久等了真不好意思，現貨五個工作天內出貨；預購七到二十工作天，到貨日無法保證，需要我幫您盯配送嗎？" },
  { id: "N13", reply: "不好意思，這邊先跟您說明：現貨五工作天內寄出，預購七～二十工作天，我不會跟您保證幾號到，但會幫您催倉儲。" },
  { id: "N14", reply: "真的很抱歉久候，現貨約 5 個工作天內安排；預購 7–20 工作天，物流我會幫您盯一下。" },
  { id: "N15", reply: "抱歉造成困擾，現貨五工作天內會寄出；預購商品七到二十工作天，無法保證到貨日，可幫您向物流端催促。" },
  { id: "N16", reply: "不好意思讓您著急，現貨五工作天內出貨；預購七到二十工作天，我這邊會幫您確認配送進度。" },
  { id: "N17", reply: "久候了抱歉，現貨五個工作天內安排寄出；預購七到二十工作天，到貨日沒辦法保證，我幫您催物流看看。" },
  { id: "N18", reply: "真的很不好意思，現貨五工作天內會處理寄出；預購七到二十工作天，我會幫您盯出貨與配送。" },
  { id: "N19", reply: "抱歉讓您等待，現貨約五工作天內寄出；預購七到二十工作天，不亂保證，需要的話我幫您加急問倉儲。" },
  { id: "N20", reply: "不好意思久候囉，現貨五工作天內出貨；預購七到二十工作天，物流我會幫您催一下。" },
  { id: "N21", reply: "先跟您說聲抱歉，現貨五個工作天內安排；預購七到二十工作天，沒辦法保證到貨日，我幫您留意物流。" },
  { id: "N22", reply: "抱歉晚回，現貨五工作天內寄出；預購七到二十工作天，配送進度我會幫您盯。" },
  { id: "N23", reply: "讓您久候真的很抱歉，現貨五工作天內出貨；預購七到二十工作天，需要我幫您向物流催促嗎？" },
  { id: "N24", reply: "不好意思，這筆現貨五工作天內會寄；預購七到二十工作天，到貨日不保證，我幫您問倉儲與物流。" },
  { id: "N25", reply: "抱歉造成久候，現貨五工作天內安排寄出；預購七到二十工作天，我會持續幫您追物流。" },
  { id: "N26", reply: "真的很抱歉，現貨五個工作天內出貨；預購七到二十工作天，無法保證，我幫您盯配送進度。" },
  { id: "N27", reply: "不好意思讓您等，現貨五工作天內寄出；預購七到二十工作天，物流端我會幫您催。" },
  { id: "N28", reply: "抱歉久等，現貨五工作天內處理寄出；預購七到二十工作天，不保證到貨日，會幫您加急留意。" },
];

const HOSTILE: { id: string; reply: string }[] = [
  { id: "H01", reply: "您的訂單正在處理中，請耐心等待。" },
  { id: "H02", reply: "狀態：處理中。" },
];

function main(): void {
  const cases = [...NATURAL_OK, ...HOSTILE];
  let guard = 0;
  console.log("=== Phase 97 Shipping Guard Audit（自然合規樣本 ＋ 2 則叛逆）===");
  console.log("userMessage:", USER);
  console.log("planMode: order_followup\n");
  for (const c of cases) {
    const out = ensureShippingSopCompliance(c.reply, "order_followup", "", USER, RECENT);
    const applied = out !== c.reply;
    if (applied) guard++;
    console.log(`[${c.id}] guard=${applied ? "YES" : "no"}`);
  }
  console.log("\n--- summary ---");
  console.log("cases:", cases.length);
  console.log("guard_triggered:", guard);
  console.log("guard_rate:", ((guard / cases.length) * 100).toFixed(1) + "%");
}

main();
