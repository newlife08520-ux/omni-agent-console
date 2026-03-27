/**
 * 匯出「執行期實際會用到的」system prompt 片段（遮罩版），供 review bundle。
 * - settings.system_prompt → buildGlobalPolicyPrompt
 * - brands.system_prompt → buildBrandPersonaPrompt
 * - assembleEnrichedSystemPrompt（一般對答、order_lookup、查單後追問）
 *
 * 用法: npx tsx server/scripts/export-effective-prompt-masked.ts <輸出.md 路徑>
 */
import fs from "fs";
import path from "path";
import { storage } from "../storage";
import { assembleEnrichedSystemPrompt } from "../services/prompt-builder";

function maskText(s: string, maxLen = 200_000): string {
  let t = (s || "").slice(0, maxLen);
  t = t.replace(/09\d{8}/g, "09********");
  t = t.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]");
  t = t.replace(/\bsk_(live|test)_[A-Za-z0-9]{8,}\b/gi, "sk_***");
  t = t.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, "Bearer ***");
  t = t.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[JWT]");
  t = t.replace(/https?:\/\/[^\s)"']{4,}/gi, (u) => {
    try {
      const x = new URL(u);
      return `${x.protocol}//[HOST]${x.pathname.slice(0, 24)}…`;
    } catch {
      return "[URL]";
    }
  });
  return t;
}

async function main() {
  /** 僅本腳本：避免 buildCatalogPrompt → 一頁商店全量同步（打包／本機匯出會卡住數分鐘） */
  process.env.REVIEW_PROMPT_EXPORT_SKIP_CATALOG = "1";

  const outPath = path.resolve(process.argv[2] || path.join(process.cwd(), "system_prompt_effective.md"));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const globalRaw = storage.getSetting("system_prompt") || "";
  const brands = storage.getBrands();

  const lines: string[] = [];
  lines.push("# 實際生效的 system prompt（遮罩版）");
  lines.push("");
  lines.push("> 產生時間：" + new Date().toISOString());
  lines.push("> **settings.system_prompt** = DB `settings` 表 key `system_prompt`，經 `buildGlobalPolicyPrompt()` 讀取。");
  lines.push("> **brands.system_prompt** = 各品牌語氣，經 `buildBrandPersonaPrompt()` 拼接為「--- 品牌語氣與規範 ---」區塊。");
  lines.push("> **完整送模組** = `assembleEnrichedSystemPrompt()` 依 `planMode`、是否含圖等選擇 **ultra-lite** 或 **full**（見下方範例與 `server/services/prompt-builder.ts`）。");
  lines.push("> **docs/persona/**：多為撰寫參考；若未同步寫回 DB，**以本檔與 DB 為準**。");
  lines.push("> **CATALOG**：本匯出固定 `REVIEW_PROMPT_EXPORT_SKIP_CATALOG=1`，**不**呼叫一頁商店銷售頁 API；一般對答範例中可能無 `--- CATALOG ---` 區塊（與線上含快取時不同）。");
  lines.push("");

  lines.push("## 1. `settings.system_prompt`（全域）");
  lines.push("");
  lines.push("```text");
  lines.push(maskText(globalRaw) || "(empty — 將使用程式內建預設句)");
  lines.push("```");
  lines.push("");

  lines.push("## 2. 各品牌 `brands.system_prompt`");
  lines.push("");
  if (brands.length === 0) {
    lines.push("_(無品牌)_");
  } else {
    for (const b of brands) {
      lines.push(`### 品牌 id=${b.id} name=${b.name}`);
      lines.push("");
      lines.push("```text");
      lines.push(maskText(b.system_prompt || "") || "(empty)");
      lines.push("```");
      lines.push("");
    }
  }

  const first = brands[0];
  if (first) {
    const assembledFull = await assembleEnrichedSystemPrompt(first.id, {
      planMode: "",
      productScope: null,
      hasActiveOrderContext: false,
      recentUserHasImage: false,
    });
    lines.push(`## 3. 組裝範例：一般對答（非 order_lookup，prompt_profile=${assembledFull.prompt_profile}）`);
    lines.push("");
    lines.push(`- **prompt_profile**: \`${assembledFull.prompt_profile}\``);
    lines.push(`- **prompt_chars**: ${assembledFull.prompt_chars ?? assembledFull.full_prompt.length}`);
    lines.push(`- **includes**: \`${JSON.stringify(assembledFull.includes)}\``);
    lines.push("");
    lines.push("```text");
    lines.push(maskText(assembledFull.full_prompt));
    lines.push("```");
    lines.push("");

    const assembledLookup = await assembleEnrichedSystemPrompt(first.id, {
      planMode: "order_lookup",
      hasActiveOrderContext: false,
      recentUserHasImage: false,
    });
    lines.push(`## 4. 組裝範例：查單模式 order_lookup（首輪，prompt_profile=${assembledLookup.prompt_profile}）`);
    lines.push("");
    lines.push(`- **prompt_profile**: \`${assembledLookup.prompt_profile}\``);
    lines.push(`- **prompt_chars**: ${assembledLookup.prompt_chars ?? assembledLookup.full_prompt.length}`);
    lines.push(`- **includes**: \`${JSON.stringify(assembledLookup.includes)}\``);
    lines.push("");
    lines.push("```text");
    lines.push(maskText(assembledLookup.full_prompt));
    lines.push("```");
    lines.push("");

    const assembledFollow = await assembleEnrichedSystemPrompt(first.id, {
      planMode: "order_lookup",
      hasActiveOrderContext: true,
      recentUserHasImage: false,
    });
    lines.push(`## 5. 組裝範例：查單後追問（hasActiveOrderContext=true，prompt_profile=${assembledFollow.prompt_profile}）`);
    lines.push("");
    lines.push(`- **prompt_profile**: \`${assembledFollow.prompt_profile}\``);
    lines.push(`- **prompt_chars**: ${assembledFollow.prompt_chars ?? assembledFollow.full_prompt.length}`);
    lines.push("");
    lines.push("```text");
    lines.push(maskText(assembledFollow.full_prompt));
    lines.push("```");
    lines.push("");
  } else {
    lines.push("## 3～5. 組裝範例");
    lines.push("");
    lines.push("_(無品牌，略過 assembleEnrichedSystemPrompt 範例)_");
    lines.push("");
  }

  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log("[export-effective-prompt-masked] Wrote:", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
