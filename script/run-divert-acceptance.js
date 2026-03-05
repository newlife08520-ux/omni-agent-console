/**
 * 公開留言分流驗收：A–E 情境。需先啟動 server (http://127.0.0.1:5001)
 * node script/run-divert-acceptance.js
 */
const base = "http://127.0.0.1:5001";

const scenarios = [
  {
    name: "A. 一般詢問",
    cases: [
      { msg: "多少錢？", expect: "公開簡答，可導商品，不強制導 LINE" },
      { msg: "哪裡買？", expect: "公開簡答，可導商品" },
      { msg: "這款還有貨嗎？", expect: "公開簡答，可導商品" },
    ],
  },
  {
    name: "B. 中等複雜",
    cases: [
      { msg: "想知道哪款比較適合我", expect: "建議導 LINE" },
      { msg: "可以幫我推薦嗎", expect: "建議導 LINE" },
      { msg: "想了解更詳細", expect: "建議導 LINE" },
      { msg: "幫我挑一下", expect: "建議導 LINE" },
      { msg: "哪款比較適合", expect: "建議導 LINE" },
    ],
  },
  {
    name: "C. 訂單/售後",
    cases: [
      { msg: "我的訂單還沒收到", expect: "不導購，導 LINE/人工" },
      { msg: "想查訂單", expect: "不導購，導 LINE" },
      { msg: "出貨很慢", expect: "不導購，安撫+導 LINE" },
    ],
  },
  {
    name: "D. 客訴/退款/爭議",
    cases: [
      { msg: "我要退款", expect: "只安撫，無第二則導購" },
      { msg: "你們都不回訊息", expect: "只安撫，無第二則" },
      { msg: "品質很差", expect: "只安撫，無第二則" },
      { msg: "我要客訴", expect: "只安撫，無第二則" },
    ],
  },
  {
    name: "E. 活動",
    cases: [
      { msg: "+1", expect: "活動互動，不誤判客訴" },
      { msg: "已完成", expect: "活動互動" },
      { msg: "抽獎怎麼參加", expect: "活動互動，可導活動或 LINE" },
    ],
  },
];

async function run() {
  const loginRes = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
    redirect: "manual",
  });
  const setCookie = loginRes.headers.get("set-cookie");
  const cookie = setCookie ? setCookie.split(";")[0] : "";
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;

  const results = [];
  for (const scenario of scenarios) {
    for (const c of scenario.cases) {
      const createRes = await fetch(base + "/api/meta-comments", {
        method: "POST",
        headers,
        body: JSON.stringify({
          page_id: "page_demo",
          post_id: "post_001",
          commenter_name: "Acceptance",
          message: c.msg,
          is_simulated: 1,
        }),
      });
      if (!createRes.ok) {
        results.push({ scenario: scenario.name, msg: c.msg, error: createRes.status });
        continue;
      }
      const comment = await createRes.json();
      const suggestRes = await fetch(
        base + "/api/meta-comments/" + comment.id + "/suggest-reply",
        { method: "POST", headers: cookie ? { Cookie: cookie } : {} }
      );
      if (!suggestRes.ok) {
        results.push({ scenario: scenario.name, msg: c.msg, error: suggestRes.status });
        continue;
      }
      const after = await suggestRes.json();
      const hasSecond = after.reply_second && String(after.reply_second).trim() !== "";
      const flow = after.reply_flow_type || (hasSecond ? (after.reply_link_source === "post_mapping" ? "product_link" : "line_redirect") : (after.priority === "urgent" || after.ai_suggest_human ? "comfort_line" : "public_only"));
      results.push({
        scenario: scenario.name,
        msg: c.msg,
        expect: c.expect,
        flow,
        intent: after.ai_intent,
        hasSecond: hasSecond ? "Y" : "N",
        isHighRisk: after.priority === "urgent" || after.ai_suggest_human === 1,
      });
    }
  }

  console.log("\n=== 公開留言分流驗收 A–E ===\n");
  let lastScenario = "";
  for (const r of results) {
    if (r.scenario !== lastScenario) {
      console.log(r.scenario);
      lastScenario = r.scenario;
    }
    if (r.error) {
      console.log("  ", r.msg, "→ ERROR", r.error);
      continue;
    }
    console.log("  ", r.msg);
    console.log("      flow:", r.flow, "| intent:", r.intent, "| 第二則:", r.hasSecond, "| 高風險:", r.isHighRisk);
    console.log("      預期:", r.expect);
  }
  console.log("\n完成。請人工核對 D 組全部無第二則、C 組不導購、B 組有導 LINE、A/E 符合預期。");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
