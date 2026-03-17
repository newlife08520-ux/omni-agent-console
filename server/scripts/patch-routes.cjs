/**
 * 一次性 patch routes.ts：
 * 1. 加入 import
 * 2. 在 autoReplyWithAI 結束後加入 internal API + DI wiring + controller 綁定
 * 3. 移除 LINE/FB webhook inline code
 */
const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "..", "routes.ts");
const content = fs.readFileSync(file, "utf8");
const lines = content.split("\n");
console.log("Original lines:", lines.length);

// Step 1: Find insertion point for imports (after last import line before first const/function)
let importInsertIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith("import ") || lines[i].startsWith("import{")) {
    importInsertIdx = i;
  }
  if (lines[i].startsWith("const ") || lines[i].startsWith("function ") || lines[i].startsWith("export ")) break;
}
console.log("Import insert after line:", importInsertIdx + 1);

const importLines = [
  'import { addAiReplyJob, enqueueDebouncedAiReply } from "./queue/ai-reply.queue";',
  'import { handleLineWebhook } from "./controllers/line-webhook.controller";',
  'import { handleFacebookWebhook, handleFacebookVerify, type FacebookWebhookDeps } from "./controllers/facebook-webhook.controller";',
];

// Step 2: Find LINE webhook start and FB POST handler end
let lineWebhookStart = -1;
let fbPostClose = -1;
for (let i = 0; i < lines.length; i++) {
  if (lineWebhookStart === -1 && lines[i].includes('app.post("/api/webhook/line"')) {
    lineWebhookStart = i;
  }
}
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes("FB Webhook] Async processing error")) {
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "});") { fbPostClose = j; break; }
    }
    break;
  }
}

// Also find fetchAndUpdateFBProfile helper (outside FB POST handler)
let fbOuterHelperStart = -1;
for (let i = lineWebhookStart; i < lines.length; i++) {
  if (lines[i].includes("async function fetchAndUpdateFBProfile") && lines[i - 1] && (lines[i - 1].trim().startsWith("/**") || lines[i - 1].trim() === "")) {
    fbOuterHelperStart = i;
    // Go up to comment
    let j = i - 1;
    while (j >= 0 && (lines[j].trim().startsWith("/**") || lines[j].trim().startsWith("*") || lines[j].trim() === "")) j--;
    fbOuterHelperStart = j + 1;
    break;
  }
}

console.log("LINE webhook start:", lineWebhookStart + 1);
console.log("FB outer helper start:", fbOuterHelperStart + 1);
console.log("FB POST close:", fbPostClose + 1);

if (lineWebhookStart < 0 || fbPostClose < 0) {
  console.error("ERROR: Could not find webhook boundaries");
  process.exit(1);
}

// Step 3: Build replacement code
const replacementLines = [
  "",
  '  app.post("/internal/run-ai-reply", (req, res) => {',
  '    const secret = req.headers["x-internal-secret"];',
  "    if (secret !== process.env.INTERNAL_API_SECRET) {",
  '      return res.status(403).json({ message: "Forbidden" });',
  "    }",
  "    const { contactId, message, channelToken, matchedBrandId, platform } = req.body || {};",
  "    if (!contactId || message == null) {",
  '      return res.status(400).json({ message: "contactId and message required" });',
  "    }",
  "    const contact = storage.getContact(Number(contactId));",
  "    if (!contact) {",
  '      return res.status(404).json({ message: "contact not found" });',
  "    }",
  "    autoReplyWithAI(",
  "      contact, String(message), channelToken ?? undefined,",
  "      matchedBrandId != null ? Number(matchedBrandId) : undefined,",
  "      platform ? String(platform) : undefined",
  "    )",
  "      .then(() => res.status(200).json({ ok: true }))",
  "      .catch((err) => {",
  '        console.error("[internal/run-ai-reply]", err);',
  '        res.status(500).json({ message: err?.message || "Internal Server Error" });',
  "      });",
  "  });",
  "",
  "  const fbWebhookDeps = {",
  "    storage,",
  "    broadcastSSE,",
  "    sendFBMessage,",
  "    downloadExternalImage,",
  "    handleImageVisionFirst,",
  "    enqueueDebouncedAiReply: process.env.REDIS_URL ? enqueueDebouncedAiReply : undefined,",
  "    debounceTextMessage,",
  "    addAiReplyJob,",
  "    getHandoffReplyForCustomer,",
  "    HANDOFF_MANDATORY_OPENING,",
  "    SHORT_IMAGE_FALLBACK,",
  "    getUnavailableReason: () => assignment.getUnavailableReason(),",
  "    resolveCommentMetadata,",
  "    metaCommentsStorage,",
  "    runAutoExecution,",
  "    FB_VERIFY_TOKEN,",
  "  };",
  "",
  '  app.post("/api/webhook/line", (req, res) => {',
  "    handleLineWebhook(req, res, {",
  "      storage,",
  "      broadcastSSE,",
  "      pushLineMessage,",
  "      replyToLine,",
  "      downloadLineContent,",
  "      debounceTextMessage,",
  "      addAiReplyJob,",
  "      enqueueDebouncedAiReply: process.env.REDIS_URL ? enqueueDebouncedAiReply : undefined,",
  "      autoReplyWithAI,",
  "      handleImageVisionFirst,",
  "      getHandoffReplyForCustomer,",
  "      HANDOFF_MANDATORY_OPENING,",
  "      getUnavailableReason: () => assignment.getUnavailableReason(),",
  "    });",
  "  });",
  "",
  '  app.get("/api/webhook/facebook", (req, res) => handleFacebookVerify(req, res, fbWebhookDeps));',
  '  app.post("/api/webhook/facebook", (req, res) => handleFacebookWebhook(req, res, fbWebhookDeps));',
  "",
];

// Assemble: imports + before-webhook + replacement + after-fb-close
const part1 = lines.slice(0, importInsertIdx + 1);
const importBlock = importLines.map(l => l);
const part2 = lines.slice(importInsertIdx + 1, lineWebhookStart);
const part3 = replacementLines;
const part4 = lines.slice(fbPostClose + 1);

const result = [...part1, ...importBlock, ...part2, ...part3, ...part4];
fs.writeFileSync(file, result.join("\n"), "utf8");
console.log("New total lines:", result.length);
console.log("Removed", fbPostClose - lineWebhookStart + 1, "inline webhook lines");
console.log("Added", importLines.length, "import lines +", replacementLines.length, "replacement lines");

// Verify Chinese chars preserved
const verify = fs.readFileSync(file, "utf8");
const hasQ = verify.includes("???|");
console.log("Chinese preserved (no ???|):", !hasQ);
