/**
 * Isolated Single-Brand Pilot 前置檢查。
 * 執行：npm run pilot:precheck -- [brand_id]
 */
import { storage } from "../storage";
import { parsePhase1BrandFlags, isPhase1Active } from "../services/phase1-brand-config";

const brandId = parseInt(process.argv[2] || "0", 10);
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n=== Pilot Precheck ===\n");

const brand = brandId ? storage.getBrand(brandId) : null;
check("Brand 存在", !!brand, brandId ? `brand_id=${brandId}` : "未提供 brand_id");

if (brand) {
  const flags = parsePhase1BrandFlags(brand);
  check("Phase 1 enabled", isPhase1Active(flags));
  check("Hybrid Router", flags.hybrid_router);
  check("Scenario Isolation", flags.scenario_isolation);
  check("Tool Whitelist", flags.tool_whitelist);
  check("Trace V2", flags.trace_v2);

  check("Brand system_prompt 非空", !!(brand.system_prompt?.trim()), `長度: ${brand.system_prompt?.length || 0}`);

  const channels = storage.getChannelsByBrand(brandId);
  check("至少有一個渠道", channels.length > 0, `找到 ${channels.length} 個`);

  check("return_form_url 已設定", !!(brand.return_form_url?.trim()), brand.return_form_url || "(空)");
  check("return_form_url 非 lovethelife", !brand.return_form_url?.includes("lovethelife"));
}

const globalPrompt = storage.getSetting("system_prompt") || "";
check("Global Prompt 非空", !!globalPrompt.trim(), `長度: ${globalPrompt.length}`);
check("Global Prompt < 2000 字元", globalPrompt.length < 2000, `實際: ${globalPrompt.length}`);
check("Global Prompt 無甜點硬編碼", !globalPrompt.includes("甜點") && !globalPrompt.includes("巴斯克"));

const hasOpenAI = !!(process.env.OPENAI_API_KEY?.trim());
const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY?.trim());
check("至少一個 AI API Key", hasOpenAI || hasAnthropic, `OpenAI: ${hasOpenAI}, Anthropic: ${hasAnthropic}`);

const hasRedis = !!(process.env.REDIS_URL?.trim());
check("REDIS_URL 已設定", hasRedis);

console.log(`\n=== 結果：${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("\n有未通過項目，建議修正後再啟動 pilot。");
  process.exit(1);
}
console.log("\n所有檢查通過，可啟動 isolated pilot。");
