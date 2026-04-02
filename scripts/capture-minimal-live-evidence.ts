/**
 * 最小取證：在隔離 DATA_DIR 下透過正式 Storage / order-index / meta-comments API 寫入列，
 * 再匯出匿名 JSON。非 OpenAI 真回覆；ai_logs.model 標為 evidence-capture-script 以示區隔。
 *
 * 執行（PowerShell 範例）：
 *   $env:DATA_DIR = (Resolve-Path ".\_evidence_run\data").Path
 *   npx tsx scripts/capture-minimal-live-evidence.ts
 */
import type { OrderInfo } from "@shared/schema";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function main() {
  const dataDir = process.env.DATA_DIR?.trim();
  if (!dataDir) {
    console.error("[evidence] 請設定 DATA_DIR 指向隔離目錄（例如 _evidence_run/data）");
    process.exit(2);
  }

  const { initDatabase } = await import("../server/db.js");
  const { storage } = await import("../server/storage.js");
  const { setOrderLookupCache, cacheKeyOrderId } = await import("../server/order-index.js");
  const { createMetaPageSettings } = await import("../server/meta-comments-storage.js");

  initDatabase();

  const brands = storage.getBrands();
  const brandId = brands[0]?.id;
  if (!brandId) {
    console.error("[evidence] 無品牌列，無法繼續");
    process.exit(2);
  }

  const contacts = storage.getContacts();
  const contactId = contacts[0]?.id;
  const messageId = contactId
    ? (storage.getMessages(contactId)[0]?.id ?? null)
    : null;

  storage.createAiLog({
    contact_id: contactId ?? undefined,
    message_id: messageId ?? undefined,
    brand_id: brandId,
    prompt_summary: "[evidence_capture] minimal local isolated DB — not production OpenAI",
    knowledge_hits: [],
    tools_called: ["lookup_order_by_id"],
    transfer_triggered: false,
    transfer_reason: undefined,
    result_summary: "[evidence_capture] row created via SQLiteStorage.createAiLog only",
    token_usage: 0,
    model: "evidence-capture-script",
    response_time_ms: 1,
    reply_source: "evidence_capture",
    used_llm: 0,
    plan_mode: "order_lookup",
    reason_if_bypassed: null,
    used_first_llm: 0,
    used_second_llm: 0,
    reply_renderer: "evidence_capture",
    prompt_profile: "order_lookup_prompt_diet",
    first_customer_visible_reply_ms: null,
    lookup_ack_sent_ms: null,
    queue_wait_ms: null,
  });

  const dummyOrder = {
    global_order_id: "EV-CAP-01",
    status: "新訂單",
    final_total_order_amount: 0,
    product_list: "[]",
    buyer_name: "",
    buyer_phone: "",
    buyer_email: "",
    tracking_number: "",
    created_at: "",
    payment_method: "pending",
    prepaid: false,
    source: "superlanding" as const,
  } as OrderInfo;

  setOrderLookupCache(cacheKeyOrderId(brandId, "EVCAP01", "any"), {
    orders: [dummyOrder],
    source: "superlanding",
    found: true,
  });

  createMetaPageSettings({
    page_id: "999888777666555",
    page_name: "Evidence capture test page (local only)",
    brand_id: brandId,
    auto_reply_enabled: 0,
    auto_route_line_enabled: 0,
    auto_hide_sensitive: 0,
  });

  const outDir = path.join(root, "_evidence_run", "out");
  fs.mkdirSync(outDir, { recursive: true });

  const trace = {
    _provenance: "local_evidence_capture_script",
    _environment: "local_isolated_DATA_DIR_not_production",
    DATA_DIR: dataDir,
    capture_utc: new Date().toISOString(),
    writes: [
      "SQLiteStorage.createAiLog (model=evidence-capture-script — not OpenAI)",
      "setOrderLookupCache(cacheKeyOrderId(...)) via order-index.ts",
      "createMetaPageSettings(...) via meta-comments-storage.ts",
    ],
    line_webhook_masked_rawish: {
      _note: "Structure aligned with LINE Messaging API webhook; not from live HTTP ingest in this run.",
      destination: "U_BOT_ID_WOULD_MATCH_channels.bot_id",
      events: [
        {
          type: "message",
          mode: "active",
          timestamp: Date.now(),
          source: { type: "user", userId: "U_masked_evidence_user" },
          replyToken: "reply_token_masked_32bytes_placeholder",
          message: {
            id: "msg_masked",
            type: "text",
            text: "查訂單 EV-CAP-01",
          },
        },
      ],
    },
    tool_and_handoff_trace_masked: {
      _note: "Mirrors sandbox / executor field names; paired with ai_logs row above.",
      tool_calls_offered_sample: ["lookup_order_by_id", "transfer_to_human"],
      simulated_tool_result_shape: {
        tool: "lookup_order_by_id",
        found: true,
        global_order_id: "EV-CAP-01",
        buyer_phone: "09*******",
      },
      handoff: {
        transfer_triggered_in_ai_log_row: false,
        transfer_to_human_example_reason_masked: "N/A_for_this_row",
      },
    },
  };
  fs.writeFileSync(path.join(outDir, "rawish_trace_local_capture.json"), JSON.stringify(trace, null, 2), "utf8");

  const dbSnap = path.join(outDir, "db_snapshot_anonymized");
  execSync(`npx tsx scripts/export-runtime-addon-data.ts "${dbSnap}"`, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DATA_DIR: dataDir },
  });

  const summaryPath = path.join(outDir, "CAPTURE_SUMMARY.json");
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        DATA_DIR: dataDir,
        capture_utc: trace.capture_utc,
        note: "Counts from export script use omnichannel.db under DATA_DIR",
      },
      null,
      2
    ),
    "utf8"
  );

  console.log("[evidence] Done. Output:", outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
