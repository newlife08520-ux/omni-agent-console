/**
 * GET /api/contacts 端對端 API 耗時（含 auth、getContacts、agent flags、serialize）
 * 使用方式：先啟動 server，登入取得 cookie 後執行：
 *   set COOKIE=connect.sid=你的session值
 *   npx tsx server/scripts/bench-api-contacts.ts
 * 或：BASE_URL=http://localhost:5000 COOKIE=... npx tsx server/scripts/bench-api-contacts.ts
 */
const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const COOKIE = process.env.COOKIE || "";

async function main() {
  if (!COOKIE.trim()) {
    console.error("請設定環境變數 COOKIE（登入後之 connect.sid）。例：COOKIE=connect.sid=xxx npx tsx server/scripts/bench-api-contacts.ts");
    process.exit(1);
  }
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    const res = await fetch(`${BASE_URL}/api/contacts?limit=100`, {
      headers: { Cookie: COOKIE },
    });
    const elapsed = Date.now() - t0;
    times.push(elapsed);
    if (!res.ok) {
      const text = await res.text();
      console.error("請求失敗:", res.status, text.slice(0, 200));
      process.exit(1);
    }
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const avg = sum / times.length;
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  const max = times[times.length - 1];
  console.log("GET /api/contacts (limit=100) 10 次:");
  console.log("平均(ms):", Math.round(avg));
  console.log("p95(ms):", p95);
  console.log("最慢(ms):", max);
  console.log("10 次依序(ms):", times.join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
