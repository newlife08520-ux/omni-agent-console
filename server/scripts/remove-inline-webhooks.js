const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "..", "routes.ts");
const content = fs.readFileSync(file, "utf8");
const lines = content.split("\n");
console.log("Original lines:", lines.length);

let lineWebhookStart = -1;
let fbPostClose = -1;
for (let i = 0; i < lines.length; i++) {
  if (lineWebhookStart === -1 && lines[i].includes('app.post("/api/webhook/line"')) {
    lineWebhookStart = i;
  }
}

// Find fetchAndUpdateFBProfile helper BEFORE the FB GET
let fbHelperStart = -1;
for (let i = lineWebhookStart; i < lines.length; i++) {
  if (lines[i].includes("async function fetchAndUpdateFBProfile") && fbHelperStart === -1) {
    // Go back to JSDoc comment
    let j = i - 1;
    while (j >= 0 && (lines[j].trim().startsWith("/**") || lines[j].trim().startsWith("*") || lines[j].trim() === "")) j--;
    fbHelperStart = j + 1;
    break;
  }
}

// Find FB POST handler close: })().catch(... Async processing error ...); → next line });
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes("FB Webhook] Async processing error")) {
    // Next line with }); is the POST handler close
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "});") { fbPostClose = j; break; }
    }
    break;
  }
}

console.log("LINE webhook start (0-indexed):", lineWebhookStart);
console.log("FB helper start (0-indexed):", fbHelperStart);
console.log("FB POST close (0-indexed):", fbPostClose);
console.log("Lines to remove:", fbPostClose - lineWebhookStart + 1);

if (lineWebhookStart >= 0 && fbPostClose > lineWebhookStart) {
  const before = lines.slice(0, lineWebhookStart);
  const after = lines.slice(fbPostClose + 1);
  const result = before.concat(after);
  fs.writeFileSync(file, result.join("\n"), "utf8");
  console.log("New total lines:", result.length);
  console.log("Done. Removed lines", lineWebhookStart + 1, "to", fbPostClose + 1);
} else {
  console.log("ERROR: Could not find markers");
}
