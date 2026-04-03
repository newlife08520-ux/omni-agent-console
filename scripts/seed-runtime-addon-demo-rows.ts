/**
 * Inserts DEMO rows into local omnichannel.db so export-runtime-addon-data.ts
 * can produce non-empty ai_logs / order_lookup_cache / meta_page_settings.
 *
 * ⚠️ Backup DB first. Not for production.
 *
 * Dry run (default): prints plan only.
 * Apply: npx tsx scripts/seed-runtime-addon-demo-rows.ts --apply
 */
import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "omnichannel.db");
const apply = process.argv.includes("--apply");

const DEMO_PAGE_ID = "__addon_demo_page_do_not_use_prod__";

function main() {
  if (!apply) {
    console.log("[seed-runtime-addon-demo-rows] DRY RUN. Pass --apply to write rows.");
    console.log("Will insert: 4 ai_logs, 3 order_lookup_cache, 1 meta_page_settings (if brand exists).");
    process.exit(0);
  }

  const db = new Database(dbPath);
  try {
    const brand = db.prepare("SELECT id FROM brands ORDER BY id ASC LIMIT 1").get() as { id: number } | undefined;
    if (!brand) {
      console.error("No brands row; cannot seed meta_page_settings / FK-safe logs.");
      process.exit(1);
    }
    const contact = db.prepare("SELECT id FROM contacts ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    const contactId = contact?.id ?? null;

    db.exec("BEGIN");
    const insLog = db.prepare(`
      INSERT INTO ai_logs (
        contact_id, message_id, brand_id, prompt_summary, knowledge_hits, tools_called,
        transfer_triggered, transfer_reason, result_summary, token_usage, model, response_time_ms,
        reply_source, used_llm, plan_mode, reason_if_bypassed,
        used_first_llm, used_second_llm, reply_renderer, prompt_profile,
        first_customer_visible_reply_ms, lookup_ack_sent_ms, queue_wait_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const rows: Parameters<typeof insLog.run>[0][] = [
      [
        contactId,
        null,
        brand.id,
        "查詢訂單 SGT18770 出貨時間",
        "[]",
        '["lookup_order_by_id"]',
        0,
        null,
        "tool ok: found superlanding",
        0,
        "gpt-5.4",
        842,
        "deterministic_tool",
        0,
        "tool_first",
        null,
        0,
        0,
        "order_one_page",
        "default",
        1200,
        80,
        0,
      ],
      [
        contactId,
        null,
        brand.id,
        "你好",
        "[]",
        "[]",
        0,
        null,
        "llm_reply_ok",
        1840,
        "gpt-5.4",
        2100,
        "llm",
        1,
        "standard",
        null,
        1,
        0,
        "plain_text",
        "default",
        2300,
        null,
        150,
      ],
      [
        contactId,
        null,
        brand.id,
        "我要真人客服",
        "[]",
        "[]",
        1,
        "user_request",
        "handoff applied",
        0,
        "gate",
        45,
        "handoff",
        0,
        "handoff",
        null,
        0,
        0,
        "",
        "",
        null,
        null,
        0,
      ],
      [
        contactId,
        null,
        brand.id,
        "是不是詐騙",
        "[]",
        '["safe_confirm_template"]',
        0,
        null,
        "safe_confirm_template: fraud_impersonation",
        0,
        "safe-after-sale-classifier",
        12,
        "safe_confirm_template",
        0,
        null,
        "safe_confirm",
        0,
        0,
        "",
        "",
        null,
        null,
        0,
      ],
    ];
    for (const r of rows) insLog.run(...r);

    const cachePayload = JSON.stringify({
      orders: [
        {
          global_order_id: "DEMO_ORDER",
          buyer_phone: "0912345678",
          source: "superlanding",
          status: "pending",
        },
      ],
      source: "superlanding",
      found: true,
      data_coverage: "local_only",
      coverage_confidence: "low",
      needs_live_confirm: true,
    });
    const insCache = db.prepare(`
      INSERT INTO order_lookup_cache (cache_key, result_payload, fetched_at, ttl_seconds)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(cache_key) DO UPDATE SET result_payload = excluded.result_payload, fetched_at = excluded.fetched_at, ttl_seconds = excluded.ttl_seconds
    `);
    insCache.run(`order_id:${brand.id}:any:DEMO_ORDER`, cachePayload, 300);
    insCache.run(`order_id:${brand.id}:superlanding:DEMO_ORDER`, cachePayload, 300);
    insCache.run(`phone:${brand.id}:any:0912345678`, cachePayload, 300);

    const exists = db.prepare("SELECT id FROM meta_page_settings WHERE page_id = ?").get(DEMO_PAGE_ID);
    if (!exists) {
      db.prepare(
        `INSERT INTO meta_page_settings (
          page_id, page_name, brand_id, line_general, line_after_sale,
          auto_hide_sensitive, auto_reply_enabled, auto_route_line_enabled,
          default_reply_template_id, default_sensitive_template_id, default_flow, default_product_name,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 1, 0, NULL, NULL, 'general', 'Demo SKU', datetime('now'), datetime('now'))`
      ).run(DEMO_PAGE_ID, "ADDON_DEMO_PAGE", brand.id, "https://line.me/R/ti/p/~demo", "https://line.me/R/ti/p/~after");
    }

    db.exec("COMMIT");
    console.log("[seed-runtime-addon-demo-rows] OK: ai_logs x4, order_lookup_cache x3, meta_page_settings x1 (if new).");
    console.log("Re-run: npx tsx scripts/export-runtime-addon-data.ts review_runtime_addon_staging/db_snapshot_anonymized");
    console.log("Cleanup (optional): DELETE FROM meta_page_settings WHERE page_id = ? ;", DEMO_PAGE_ID);
    console.log("  DELETE FROM order_lookup_cache WHERE cache_key LIKE '%DEMO_ORDER%' OR cache_key LIKE '%0912345678%';");
    console.log("  DELETE FROM ai_logs WHERE result_summary LIKE '%DEMO%' OR prompt_summary = '你好'; -- adjust as needed");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error(e);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
