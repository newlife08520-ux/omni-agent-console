/**
 * Phase 90 / 95：活體 E2E Mock；隱私遮罩、柔性金流 sys_note、SOP Guard；Phase 95 已移除 System Recency 強制補丁。
 */
import OpenAI from "openai";
import type { OrderInfo } from "@shared/schema";
import { assembleEnrichedSystemPrompt } from "../server/services/prompt-builder";
import { sanitizeToolPayloadForLLM, finalizeLlmToolJsonString } from "../server/tool-llm-sanitize";
import { derivePaymentStatus } from "../server/order-payment-utils";
import { ensureShippingSopCompliance, SHIPPING_SOP_COMPLIANCE_PREFIX } from "../server/sop-compliance-guard";

function printSection(title: string) {
  console.log("\n" + "=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

function printMessages(msgs: { role: string; content: string }[]) {
  console.log(JSON.stringify(msgs, null, 2));
}

/** Case 1 — 官網查單成功（清洗後無 _raw / gateway_status） */
async function case1() {
  printSection("CASE 1 — 官網查單成功（驗證無 _raw）");
  const raw = {
    success: true,
    found: true,
    source: "shopline",
    payment_status_raw: "paid",
    gateway_status: "ok",
    order: {
      order_id: "SL-1001",
      status: "已出貨",
      payment_status_raw: "completed",
      gateway_status: "captured",
      product_list: "[]",
    },
  };
  const cleaned = sanitizeToolPayloadForLLM(JSON.parse(JSON.stringify(raw)) as Record<string, unknown>);
  const toolStr = JSON.stringify(cleaned);
  const userMsg = "幫我查 SL-1001";
  const enriched = await assembleEnrichedSystemPrompt(undefined, { planMode: "order_lookup" });
  const messages = [
    { role: "system", content: enriched.full_prompt },
    { role: "user", content: userMsg },
    { role: "assistant", content: `[tool lookup_order_by_id 結果]\n${toolStr}` },
  ];
  printMessages(messages);
  const rawDump = JSON.stringify(raw);
  console.log("[verify] raw 字串含 payment_status_raw:", rawDump.includes("payment_status_raw"));
  console.log("[verify] cleaned 頂層無 _raw 後綴欄位:", !Object.keys(cleaned).some((k) => k.endsWith("_raw")));
  const orderObj = cleaned.order as Record<string, unknown> | undefined;
  console.log("[verify] order 內無 gateway_status:", orderObj == null || !("gateway_status" in orderObj));
}

/** Case 2 — 官網查無、不 fallback 一頁（驗證溫暖 sys_note） */
async function case2() {
  printSection("CASE 2 — 官網查無（驗證溫暖 sys_note）");
  const payload = { success: true, found: false, message: "此單號目前查無官網訂單紀錄。" };
  const toolStr = finalizeLlmToolJsonString("lookup_order_by_id", JSON.stringify(payload), {});
  const enriched = await assembleEnrichedSystemPrompt(undefined, { planMode: "order_lookup" });
  const messages = [
    { role: "system", content: enriched.full_prompt },
    { role: "user", content: "幫我查 #SL-NOTFOUND-999" },
    { role: "assistant", content: `[tool lookup_order_by_id 結果]\n${toolStr}` },
  ];
  printMessages(messages);
  const p = JSON.parse(toolStr) as Record<string, unknown>;
  const sn = String(p.sys_note || "");
  console.log("[verify] found === false:", p.found === false);
  console.log("[verify] sys_note 為 Phase96 語氣小抄（非營運指導標籤）:", sn.includes("語氣小抄") && !sn.includes("【營運指導】"));
  console.log("[verify] sys_note 含一頁式補路徑:", sn.includes("一頁式"));
}

/** Case 3 — 純手機 summary_only */
async function case3() {
  printSection("CASE 3 — 純手機 summary_only（驗證討要商品名的溫婉話術）");
  const payload = {
    success: true,
    found: true,
    summary_only: true,
    total: 3,
    source: "shopline",
    sys_note: "（舊欄位會被 finalize 覆寫為營運口吻）",
    message: "此手機在官網共找到 3 筆訂單。",
  };
  const toolStr = finalizeLlmToolJsonString("lookup_order_by_phone", JSON.stringify(payload), {
    userMessage: "0912345678",
    recentUserMessages: [],
  });
  const messages = [
    {
      role: "system",
      content: (await assembleEnrichedSystemPrompt(undefined, { planMode: "order_lookup" })).full_prompt,
    },
    { role: "user", content: "0912345678" },
    { role: "assistant", content: `[tool lookup_order_by_phone 結果]\n${toolStr}` },
  ];
  printMessages(messages);
  const p = JSON.parse(toolStr) as Record<string, unknown>;
  const sn = String(p.sys_note || "");
  console.log("[verify] summary_only:", p.summary_only === true);
  console.log("[verify] sys_note 含語氣小抄與商品名:", sn.includes("語氣小抄") && sn.includes("商品名稱"));
}

/** Case 4 — 商品 + 手機（單筆命中） */
async function case4() {
  printSection("CASE 4 — 商品 + 手機（Product + Phone）");
  const raw = {
    success: true,
    found: true,
    total: 1,
    source: "shopline",
    orders: [
      {
        order_id: "SL-P9-001",
        status: "處理中",
        payment_status_raw: "pending",
        gateway_status: "authorized",
        product_list: "草莓蛋糕",
        buyer_phone: "0988777666",
      },
    ],
  };
  const cleaned = sanitizeToolPayloadForLLM(JSON.parse(JSON.stringify(raw)) as Record<string, unknown>);
  const toolStr = finalizeLlmToolJsonString(
    "lookup_order_by_product_and_phone",
    JSON.stringify(cleaned),
    {}
  );
  const messages = [
    {
      role: "system",
      content: (await assembleEnrichedSystemPrompt(undefined, { planMode: "order_lookup" })).full_prompt,
    },
    { role: "user", content: "我用 0988777666 買草莓蛋糕，單號多少？" },
    { role: "assistant", content: `[tool lookup_order_by_product_and_phone 結果]\n${toolStr}` },
  ];
  printMessages(messages);
  const p = JSON.parse(toolStr) as Record<string, unknown>;
  const ord = p.orders as Record<string, unknown>[] | undefined;
  const row = ord?.[0];
  console.log("[verify] found && total===1:", p.found === true && Number(p.total) === 1);
  console.log(
    "[verify] buyer_phone 已隱碼（非完整 0988777666）:",
    row != null && String(row.buyer_phone).includes("***") && !String(row.buyer_phone).includes("0988777666")
  );
}

/** Case 5 — 多筆混合來源摘要 */
async function case5() {
  printSection("CASE 5 — 多筆訂單摘要（混合來源 + 人話 sys_note）");
  const payload = {
    success: true,
    found: true,
    total: 4,
    source: "mixed",
    note: "【重要】以下共 4 筆訂單。回覆時請只給摘要，勿對客戶逐筆展開完整明細。",
    formatted_list: "SL-1 待出貨 | SL-2 已送達 | SL-3 待付款 | SL-4 處理中",
    one_page_summary: "【摘要】共 4 筆：官網與一頁通路混合；細節請客戶指定單號再查。",
  };
  const toolStr = finalizeLlmToolJsonString("lookup_more_orders", JSON.stringify(payload), {});
  const messages = [
    {
      role: "system",
      content: (await assembleEnrichedSystemPrompt(undefined, { planMode: "order_lookup" })).full_prompt,
    },
    { role: "user", content: "我有一頁跟官網兩邊的單，列給我摘要就好" },
    { role: "assistant", content: `[tool lookup_more_orders 結果]\n${toolStr}` },
  ];
  printMessages(messages);
  const p = JSON.parse(toolStr) as Record<string, unknown>;
  const sn = String(p.sys_note || "");
  console.log("[verify] source mixed:", p.source === "mixed");
  console.log("[verify] sys_note 含人話與勿講內部來源:", sn.includes("人話") && sn.includes("內部來源"));
}

/** Case 6 — 貨到付款 COD */
function case6() {
  printSection("CASE 6 — 貨到付款（COD）");
  const order = {
    global_order_id: "T-COD-E2E",
    status: "新訂單",
    final_total_order_amount: 0,
    product_list: "",
    buyer_name: "",
    buyer_phone: "",
    buyer_email: "",
    tracking_number: "",
    created_at: "",
    payment_method: "貨到付款",
    prepaid: false,
    paid_at: null as string | null,
    source: "shopline" as const,
  } as OrderInfo;
  const st = derivePaymentStatus(order, "", "shopline");
  const toolStr = finalizeLlmToolJsonString(
    "lookup_order_by_id",
    JSON.stringify({
      success: true,
      found: true,
      source: "shopline",
      order: {
        order_id: order.global_order_id,
        payment_status: st.kind,
        payment_status_label: st.label,
      },
    }),
    {}
  );
  console.log("[derivePaymentStatus]", JSON.stringify(st, null, 2));
  console.log("[tool JSON]\n", JSON.stringify(JSON.parse(toolStr), null, 2));
  console.log("[verify] kind === cod:", st.kind === "cod");
}

/** Case 7 — 付款失敗（gateway_status：3D驗證失敗 → failed，非 pending） */
function case7() {
  printSection('CASE 7 — 付款失敗（gateway_status: "3D驗證失敗"）');
  const order3d = {
    global_order_id: "T-3D-GW",
    status: "新訂單",
    final_total_order_amount: 0,
    product_list: "",
    buyer_name: "",
    buyer_phone: "",
    buyer_email: "",
    tracking_number: "",
    created_at: "",
    payment_method: "credit_card",
    prepaid: false,
    paid_at: null as string | null,
    source: "shopline" as const,
    payment_status_raw: "",
    gateway_status: "3D驗證失敗",
  } as OrderInfo & { gateway_status?: string };
  const st = derivePaymentStatus(order3d, "", "shopline");
  const orderForTool = {
    success: true,
    found: true,
    order: {
      order_id: order3d.global_order_id,
      payment_status: st.kind,
      payment_status_label: st.label,
    },
  };
  const toolStr = finalizeLlmToolJsonString("lookup_order_by_id", JSON.stringify(orderForTool), {});
  console.log("[derivePaymentStatus 3D gateway]", JSON.stringify(st, null, 2));
  console.log("[tool JSON]\n", JSON.stringify(JSON.parse(toolStr), null, 2));
  console.log("[verify] kind === failed (3D gateway):", st.kind === "failed");

  const orderExpired = {
    ...order3d,
    global_order_id: "T-EXP-FAIL",
    payment_status_raw: "expired",
    gateway_status: "",
  } as OrderInfo & { gateway_status?: string };
  const stExp = derivePaymentStatus(orderExpired, "", "shopline");
  console.log("[derivePaymentStatus expired raw]", JSON.stringify(stExp, null, 2));
  console.log("[verify] kind === failed (expired):", stExp.kind === "failed");

  const orderDnh = {
    ...order3d,
    global_order_id: "T-DNH",
    payment_status_raw: "do not honor",
    gateway_status: "",
  } as OrderInfo & { gateway_status?: string };
  const stDnh = derivePaymentStatus(orderDnh, "", "shopline");
  console.log("[derivePaymentStatus do_not_honor]", JSON.stringify(stDnh, null, 2));
  console.log("[verify] kind === failed (do not honor):", stDnh.kind === "failed");

  const orderOc = {
    ...order3d,
    global_order_id: "T-OC",
    payment_status_raw: "order cancelled",
    gateway_status: "",
  } as OrderInfo & { gateway_status?: string };
  const stOc = derivePaymentStatus(orderOc, "", "shopline");
  console.log("[derivePaymentStatus order_cancelled]", JSON.stringify(stOc, null, 2));
  console.log("[verify] kind === failed (order cancelled):", stOc.kind === "failed");
}

/** Case 8 — 久候出貨：LLM 漏講 SOP → Guard 靜默兜底（Phase 95：system 不再接 Recency 強制補丁） */
async function case8() {
  printSection("CASE 8 — 久候出貨（Shipping Guard，自然化前綴融入）");
  const base = "您的訂單正在處理中，請耐心等待。";
  const out = ensureShippingSopCompliance(base, "order_followup", "", "請問什麼時候會出貨？", []);
  const basePrompt = (await assembleEnrichedSystemPrompt(undefined, { planMode: "order_followup" })).full_prompt;
  const messages = [
    { role: "system", content: basePrompt },
    { role: "user", content: "請問什麼時候會出貨？" },
    { role: "assistant", content: `[simulated LLM 叛逆回覆]\n${base}\n\n[after ensureShippingSopCompliance]\n${out}` },
  ];
  printMessages(messages);
  console.log("[simulated LLM reply]", base);
  console.log("[after ensureShippingSopCompliance]\n", out);
  console.log("[系統最終回覆]（送客戶前字串，含 Guard 時）\n", out);
  console.log("[verify] 文首為自然化 Guard 前綴:", out.startsWith(SHIPPING_SOP_COMPLIANCE_PREFIX));
  console.log("[verify] 無【系統溫馨提示】補丁標籤:", !out.includes("【系統溫馨提示"));
  console.log("[verify] 仍保留原文:", out.includes("訂單正在處理中"));
  console.log("[verify] system 不再含 Recency 強制指令:", !basePrompt.includes("最高系統強制指令"));
}

/** Case 9 — 隱私遮罩：姓名／電話不可完整外洩 */
function case9() {
  printSection('CASE 9 — 隱私遮罩（buyer_name / buyer_phone）');
  const raw = {
    success: true,
    found: true,
    source: "shopline",
    order: {
      order_id: "SL-PRIV-95",
      status: "已出貨",
      buyer_name: "陳小美",
      buyer_phone: "0988111222",
      product_list: "[]",
    },
  };
  const cleaned = sanitizeToolPayloadForLLM(JSON.parse(JSON.stringify(raw)) as Record<string, unknown>);
  const toolStr = JSON.stringify(cleaned, null, 2);
  console.log("[tool JSON after sanitize]\n", toolStr);
  const order = cleaned.order as Record<string, unknown>;
  const name = String(order?.buyer_name ?? "");
  const phone = String(order?.buyer_phone ?? "");
  console.log("[verify] 姓名為 陳*美:", name === "陳*美");
  console.log("[verify] 電話為 0988***222:", phone === "0988***222");
  console.log("[verify] 不含完整原名:", !toolStr.includes("陳小美"));
  console.log("[verify] 不含完整原電話:", !toolStr.includes("0988111222"));
}

/** Case 10 — 付款失敗柔性營運指導 sys_note */
function case10() {
  printSection("CASE 10 — 付款失敗（柔性換卡／重新下單指導）");
  const payload = {
    success: true,
    found: true,
    source: "shopline",
    order: {
      order_id: "SL-FAIL-UX",
      status: "新訂單",
      payment_status: "failed",
      payment_status_label: "付款失敗／訂單未成立",
    },
  };
  const toolStr = finalizeLlmToolJsonString("lookup_order_by_id", JSON.stringify(payload), {});
  console.log("[tool JSON]\n", JSON.stringify(JSON.parse(toolStr), null, 2));
  const sn = String(JSON.parse(toolStr).sys_note || "");
  console.log(
    "[verify] sys_note 含柔性指導（重新下單或換卡）:",
    sn.includes("重新下一張單") || sn.includes("換一張卡")
  );
}

async function optionalOpenAI() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    console.log("\n[OPENAI] SKIP（未設定 OPENAI_API_KEY）");
    return;
  }
  printSection("OPTIONAL — OpenAI 真實回覆（出貨追問，無 Recency 末端補丁）");
  const base = (await assembleEnrichedSystemPrompt(undefined, { planMode: "order_followup" })).full_prompt;
  const openai = new OpenAI({ apiKey: key });
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-5.4",
    messages: [
      { role: "system", content: base },
      { role: "user", content: "請問何時出貨？" },
    ],
    max_tokens: 256,
  });
  const txt = completion.choices[0]?.message?.content;
  console.log("[OPENAI] assistant reply:\n", txt);
}

async function main() {
  console.log("[rescue-live-e2e-simulator] Phase 90/95 — cwd:", process.cwd());
  await case1();
  await case2();
  await case3();
  await case4();
  await case5();
  case6();
  case7();
  await case8();
  case9();
  case10();
  await optionalOpenAI();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
