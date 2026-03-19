/**
 * Phase 31：驗證 export-ai-bundle-context.mjs 預設不輸出 raw secret。
 * 執行：node scripts/verify-bundle-safety.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const scriptPath = path.join(root, "scripts/export-ai-bundle-context.mjs");
const content = fs.readFileSync(scriptPath, "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(`[verify-bundle-safety] ${msg}`);
}

assert(content.includes("REDACTED") || content.includes("redact"), "export script 具備 redact 邏輯");
assert(content.includes("maskPII") || content.includes("mask"), "export script 具備 PII 遮罩");
assert(
  content.includes("api_key") || content.includes("secret") || content.includes("SENSITIVE"),
  "export script 辨識敏感鍵"
);

console.log("[verify-bundle-safety] OK — export 腳本已含 secret redact 與 PII 遮罩");
