/**
 * 一次性產出 docs/handover/ 交接 markdown（含大檔內嵌）。
 * 執行: node scripts/build-handover-pack.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "docs", "handover");

const META = (purpose, extra = "") =>
  `---\n產出時間: 2026-04-14（Asia/Taipei）\nPhase 版本: Phase 106 交接包（含 106.1–106.17 與 debug endpoint）\n檔案用途: ${purpose}\n${extra}---\n\n`;

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function codeBlock(lang, content) {
  return "```" + lang + "\n" + content + "\n```\n";
}

function write(name, body) {
  fs.writeFileSync(path.join(outDir, name), body, "utf8");
  console.log("wrote", name);
}

fs.mkdirSync(outDir, { recursive: true });

// ── 05 splits ──
write(
  "05a-core-services-ai-reply.service.md",
  META("【檔案 5a】核心服務原始碼：`ai-reply.service.ts`（主自動回覆／LLM 流程）", "對應路徑: `server/services/ai-reply.service.ts`\n") +
    codeBlock("typescript", read("server/services/ai-reply.service.ts")),
);

write(
  "05b-core-services-tool-executor.md",
  META("【檔案 5b】核心服務：`tool-executor.service.ts`（查單等工具執行）", "對應路徑: `server/services/tool-executor.service.ts`\n") +
    codeBlock("typescript", read("server/services/tool-executor.service.ts")),
);

write(
  "05c-core-services-prompt-messaging.md",
  META("【檔案 5c】核心服務：prompt-builder、messaging、contact-classification、business-hours", "") +
    "## server/services/prompt-builder.ts\n\n" +
    codeBlock("typescript", read("server/services/prompt-builder.ts")) +
    "## server/services/messaging.service.ts\n\n" +
    codeBlock("typescript", read("server/services/messaging.service.ts")) +
    "## server/services/contact-classification.ts\n\n" +
    codeBlock("typescript", read("server/services/contact-classification.ts")) +
    "## server/services/business-hours.ts\n\n" +
    codeBlock("typescript", read("server/services/business-hours.ts")),
);

write(
  "05d-core-services-intent-ai-client.md",
  META("【檔案 5d】核心服務：`intent-router.service.ts`、`ai-client.service.ts`", "") +
    "## server/services/intent-router.service.ts\n\n" +
    codeBlock("typescript", read("server/services/intent-router.service.ts")) +
    "## server/services/ai-client.service.ts\n\n" +
    codeBlock("typescript", read("server/services/ai-client.service.ts")),
);

// ── 06 order handling ──
write(
  "06-order-handling.md",
  META("【檔案 6】訂單／一頁／閒置結案相關原始碼", "") +
    "## server/order-service.ts\n\n" +
    codeBlock("typescript", read("server/order-service.ts")) +
    "## server/order-status.ts\n\n" +
    codeBlock("typescript", read("server/order-status.ts")) +
    "## server/order-reply-utils.ts\n\n" +
    codeBlock("typescript", read("server/order-reply-utils.ts")) +
    "## server/superlanding.ts\n\n" +
    codeBlock("typescript", read("server/superlanding.ts")) +
    "## server/idle-close-job.ts\n\n" +
    codeBlock("typescript", read("server/idle-close-job.ts")),
);

// ── 07 webhook queue ──
const routesFull = read("server/routes.ts");
const routesLines = routesFull.split("\n");
const internalStart = routesLines.findIndex((l) => l.includes('app.post("/internal/run-ai-reply"'));
const internalSlice = routesLines.slice(Math.max(0, internalStart - 3), internalStart + 85).join("\n");

write(
  "07-webhook-and-queue.md",
  META("【檔案 7】LINE／Facebook Webhook、佇列、Worker、`/internal/run-ai-reply` 節錄", "說明：專案無 `messenger-webhook.controller.ts`，Messenger 為 `facebook-webhook.controller.ts`。\n") +
    "## server/controllers/line-webhook.controller.ts\n\n" +
    codeBlock("typescript", read("server/controllers/line-webhook.controller.ts")) +
    "## server/controllers/facebook-webhook.controller.ts（Messenger / FB）\n\n" +
    codeBlock("typescript", read("server/controllers/facebook-webhook.controller.ts")) +
    "## server/queue/ai-reply.queue.ts\n\n" +
    codeBlock("typescript", read("server/queue/ai-reply.queue.ts")) +
    "## server/workers/ai-reply.worker.ts\n\n" +
    codeBlock("typescript", read("server/workers/ai-reply.worker.ts")) +
    "## server/routes.ts — `POST /internal/run-ai-reply` 前後脈絡（節錄）\n\n" +
    codeBlock("typescript", internalSlice),
);

// ── 08 core.routes ──
write(
  "08-admin-core.routes.md",
  META("【檔案 8】`server/routes/core.routes.ts` 完整內容（含 admin／debug 路由）", "另見同目錄 `08-admin-endpoints-index.md` 為端點清單摘要。\n") +
    codeBlock("typescript", read("server/routes/core.routes.ts")),
);

// ── 09 schema ──
write(
  "09a-database-db.ts.md",
  META("【檔案 9a】`server/db.ts` 完整內容（migration／表建立）", "") + codeBlock("typescript", read("server/db.ts")),
);

write(
  "09b-database-schema.ts.md",
  META("【檔案 9b】`shared/schema.ts` 完整內容（型別與介面）", "") + codeBlock("typescript", read("shared/schema.ts")),
);

console.log("Done. Output:", outDir);
