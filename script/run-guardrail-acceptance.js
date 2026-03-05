/**
 * Guardrail 驗收：10 筆案例。需先啟動 server (http://127.0.0.1:5001)
 * 使用方式: node script/run-guardrail-acceptance.js
 * 會先登入取得 Cookie，再逐筆建立留言並呼叫 suggest-reply，最後輸出驗收表。
 */
const base = 'http://127.0.0.1:5001';
const cases = [
  { msg: '我要退款', expectNoSecond: true },
  { msg: '我要客訴', expectNoSecond: true },
  { msg: '你們都不回訊息', expectNoSecond: true },
  { msg: '上週訂的還沒收到', expectNoSecond: true },
  { msg: '這品質也太差', expectNoSecond: true },
  { msg: '商品有瑕疵', expectNoSecond: true },
  { msg: '我不要了可以取消嗎', expectNoSecond: true },
  { msg: '請問多少錢', expectNoSecond: false },
  { msg: '請問哪裡買', expectNoSecond: false },
  { msg: '這款敏感肌可以用嗎', expectNoSecond: false },
];

async function run() {
  const loginRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    redirect: 'manual',
  });
  const setCookie = loginRes.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : '';
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;

  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const createRes = await fetch(base + '/api/meta-comments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        page_id: 'page_demo',
        post_id: 'post_001',
        commenter_name: 'Acceptance',
        message: c.msg,
        is_simulated: 1,
      }),
    });
    if (!createRes.ok) {
      results.push({
        n: i + 1,
        msg: c.msg,
        error: createRes.status,
        pass: false,
      });
      continue;
    }
    const comment = await createRes.json();
    const suggestRes = await fetch(
      base + '/api/meta-comments/' + comment.id + '/suggest-reply',
      { method: 'POST', headers: cookie ? { Cookie: cookie } : {} }
    );
    if (!suggestRes.ok) {
      results.push({
        n: i + 1,
        msg: c.msg,
        error: suggestRes.status,
        pass: false,
      });
      continue;
    }
    const after = await suggestRes.json();
    const hasSecond = after.reply_second && String(after.reply_second).trim() !== '';
    const pass =
      (c.expectNoSecond && !hasSecond) || (!c.expectNoSecond && hasSecond);
    results.push({
      n: i + 1,
      msg: c.msg,
      classifier_source: after.classifier_source ?? '-',
      matched_rule_keyword: after.matched_rule_keyword ?? '-',
      final_intent: after.ai_intent ?? '-',
      is_high_risk: after.priority === 'urgent' || after.ai_suggest_human === 1,
      reply_first: (after.reply_first || '').slice(0, 40) + (after.reply_first && after.reply_first.length > 40 ? '...' : ''),
      reply_second: hasSecond ? 'Y' : 'N',
      pass,
    });
  }

  console.log('=== Guardrail 驗收結果 ===\n');
  console.log(
    '原始留言\tclassifier_source\tfinal_intent\tis_high_risk\treply_second\t是否通過'
  );
  results.forEach((r) => {
    if (r.error) {
      console.log(`${r.msg}\tERROR ${r.error}\t-\t-\t-\t${r.pass ? 'Y' : 'N'}`);
      return;
    }
    console.log(
      `${r.msg}\t${r.classifier_source}\t${r.final_intent}\t${r.is_high_risk}\t${r.reply_second}\t${r.pass ? '通過' : '未通過'}`
    );
  });
  const passed = results.filter((r) => r.pass).length;
  console.log('\nPassed: ' + passed + ' / 10');
  process.exit(passed === 10 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
