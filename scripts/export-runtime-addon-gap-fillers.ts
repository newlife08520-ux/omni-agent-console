/**
 * Fills REVIEW ADDON "gaps" when SQLite tables are empty:
 * 1) code_derived_reference/* — truth from source (NOT production rows).
 * 2) masked_payloads/meta_raw_webhook_from_db_masked.json — IF meta_comments.raw_webhook_payload has rows.
 *
 * Run: npx tsx scripts/export-runtime-addon-gap-fillers.ts [stagingDir]
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const staging =
  process.argv[2] || path.join(process.cwd(), "review_runtime_addon_staging");
const dbPath = path.join(process.cwd(), "omnichannel.db");

function maskJsonDeep(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === "string") {
    let s = v;
    s = s.replace(/\b09\d{8}\b/g, "09*******");
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***");
    s = s.replace(/"id"\s*:\s*"\d{10,}"/g, '"id":"[ID]"');
    return s.length > 12000 ? s.slice(0, 12000) + "\n...[truncated]" : s;
  }
  if (Array.isArray(v)) return v.map(maskJsonDeep);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      const kl = k.toLowerCase();
      if (kl.includes("token") || kl.includes("secret") || kl.includes("access")) {
        out[k] = typeof val === "string" ? `[REDACTED len=${String(val).length}]` : "[REDACTED]";
      } else out[k] = maskJsonDeep(val);
    }
    return out;
  }
  return v;
}

function main() {
  fs.mkdirSync(path.join(staging, "code_derived_reference"), { recursive: true });
  fs.mkdirSync(path.join(staging, "masked_payloads"), { recursive: true });

  const aiLogsRef = {
    _provenance:
      "Derived from server/storage.ts createAiLog INSERT + server/services/ai-reply.service.ts call sites. NOT from DB.",
    table_sqlite: {
      table: "ai_logs",
      columns_from_db_ts:
        "id, contact_id, message_id, brand_id, prompt_summary, knowledge_hits (JSON array string), tools_called (JSON array string), transfer_triggered, transfer_reason, result_summary, token_usage, model, response_time_ms, created_at, reply_source, used_llm (0|1), plan_mode, reason_if_bypassed, used_first_llm, used_second_llm, reply_renderer, prompt_profile, first_customer_visible_reply_ms, lookup_ack_sent_ms, queue_wait_ms",
    },
    note_fixed_template:
      "DB 無 whether_fixed_template 欄位；固定模板／安全確認等多落在 reply_source（如 safe_confirm_template）或 tools_called（如 safe_confirm_template）或 result_summary 前綴。",
    reply_source_enum_from_ai_reply_service: [
      "gate_skip",
      "high_risk_short_circuit",
      "safe_confirm_template",
      "order_fast_path",
      "handoff",
      "return_form_first",
      "multi_order_router",
      "deterministic_tool",
      "llm",
      "error",
    ],
    example_rows_as_written_by_code: [
      {
        scenario: "gate_skip: ai_muted",
        reply_source: "gate_skip",
        used_llm: 0,
        plan_mode: null,
        reason_if_bypassed: "ai_muted",
        tools_called: [],
        token_usage: 0,
        model: "gate",
        result_summary: "gate_skip:ai_muted",
      },
      {
        scenario: "safe_confirm_template (no LLM)",
        reply_source: "safe_confirm_template",
        used_llm: 0,
        plan_mode: null,
        reason_if_bypassed: "safe_confirm",
        tools_called: ["safe_confirm_template"],
        token_usage: 0,
        model: "safe-after-sale-classifier",
        result_summary: "safe_confirm_template: safe_confirm_order | image_clear_caption (variant)",
      },
      {
        scenario: "order_fast_path",
        reply_source: "order_fast_path",
        used_llm: 0,
        plan_mode: "<from plan.mode e.g. tool_first>",
        tools_called: ["<e.g. lookup_order_by_id>"],
        token_usage: 0,
      },
      {
        scenario: "deterministic_tool",
        reply_source: "deterministic_tool",
        used_llm: 0,
        plan_mode: "<plan.mode>",
      },
      {
        scenario: "full LLM path",
        reply_source: "llm",
        used_llm: 1,
        plan_mode: "<plan.mode>",
        used_first_llm: 1,
        used_second_llm: 0,
      },
      {
        scenario: "error handler",
        reply_source: "error",
        used_llm: 0,
        plan_mode: null,
        result_summary: "<error string>",
      },
    ],
    code_pointers: [
      "server/storage.ts — createAiLog INSERT columns",
      "server/services/ai-reply.service.ts — storage.createAiLog({ ... })",
      "server/controllers/line-webhook.controller.ts — createAiLog",
      "server/controllers/facebook-webhook.controller.ts — createAiLog",
    ],
  };

  const cacheRef = {
    _provenance: "Derived from server/order-index.ts + server/order-service.ts. NOT from DB.",
    table_sqlite: {
      table: "order_lookup_cache",
      columns: ["cache_key (PK)", "result_payload (JSON)", "fetched_at", "ttl_seconds (default 300)"],
    },
    cache_key_functions: {
      order_id: "cacheKeyOrderId(brandId, idNorm, scope) => `order_id:${brandId}:${scope}:${idNorm}`",
      phone: "cacheKeyPhone(brandId, phoneNorm, scope) => `phone:${brandId}:${scope}:${phoneNorm}`",
      scope: ["superlanding", "shopline", "any"],
    },
    hit_path_order_service: [
      "unifiedLookupById: preferSource → scope; getOrderLookupCache(ck); miss → local index getOrderByOrderId → setOrderLookupCache(ck, result) + often setOrderLookupCache(..., 'any')",
      "phone path: setOrderLookupCache(cacheKeyPhone(brandId, phoneNorm, 'shopline'|'superlanding'|'any'), ...)",
    ],
    example_cache_keys: [
      "order_id:1:any:SGT18770",
      "order_id:1:superlanding:SGT18770",
      "order_id:1:shopline:SGT18770",
      "phone:1:any:0912345678",
    ],
    result_payload_shape: {
      _type: "CachedOrderResult / UnifiedOrderResult JSON",
      fields: ["orders: OrderInfo[]", "source", "found", "optional: crossBrand, crossBrandName, data_coverage, coverage_confidence, needs_live_confirm"],
    },
    example_result_payload_minimal: {
      orders: [],
      source: "unknown",
      found: false,
    },
    example_result_payload_found: {
      orders: [
        {
          global_order_id: "DEMO001",
          buyer_phone: "09*******",
          source: "superlanding",
          status: "pending",
        },
      ],
      source: "superlanding",
      found: true,
      data_coverage: "local_only",
      coverage_confidence: "low",
      needs_live_confirm: true,
    },
  };

  const metaPageRef = {
    _provenance: "Derived from server/db.ts migrateMetaCommentPhase1 + server/meta-comments-storage.ts INSERT.",
    table_sqlite: {
      table: "meta_page_settings",
      columns: [
        "id",
        "page_id UNIQUE",
        "page_name",
        "brand_id",
        "line_general",
        "line_after_sale",
        "auto_hide_sensitive",
        "auto_reply_enabled",
        "auto_route_line_enabled",
        "default_reply_template_id",
        "default_sensitive_template_id",
        "default_flow",
        "default_product_name",
        "created_at",
        "updated_at",
      ],
    },
    example_row_synthetic: {
      page_id: "page_masked_demo_123",
      page_name: "Demo Fan Page",
      brand_id: 1,
      line_general: "https://line.me/R/ti/p/[MASKED]",
      line_after_sale: "https://line.me/R/ti/p/[MASKED]",
      auto_hide_sensitive: 1,
      auto_reply_enabled: 1,
      auto_route_line_enabled: 0,
      default_reply_template_id: null,
      default_sensitive_template_id: null,
      default_flow: "general",
      default_product_name: null,
    },
    code_pointer: "server/meta-comments-storage.ts — upsertMetaPageSettings INSERT",
  };

  fs.writeFileSync(
    path.join(staging, "code_derived_reference", "ai_logs_and_observability.json"),
    JSON.stringify(aiLogsRef, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(staging, "code_derived_reference", "order_lookup_cache_contract.json"),
    JSON.stringify(cacheRef, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(staging, "code_derived_reference", "meta_page_settings_contract.json"),
    JSON.stringify(metaPageRef, null, 2),
    "utf8"
  );

  const readme = `# 程式碼衍生參考（補空表缺口）

本目錄 **不是** 資料庫匯出，而是從 \`server/\` 原始碼整理出的 **契約／列名／cache key 格式／reply_source 枚舉**。

- 當 \`db_snapshot_anonymized/ai_logs.json\` 為 \`[]\` 時，請讀 \`ai_logs_and_observability.json\`。
- 當 \`order_lookup_cache.json\` 為 \`[]\` 時，請讀 \`order_lookup_cache_contract.json\`。
- 當 \`meta_page_settings.json\` 為 \`[]\` 時，請讀 \`meta_page_settings_contract.json\`。

若要 **本機產生可匯出的非空 DB 列**（仍為示範資料，非線上真實）：備份 \`omnichannel.db\` 後執行  
\`npx tsx scripts/seed-runtime-addon-demo-rows.ts --apply\`，再跑 \`export-runtime-addon-data.ts\`。
`;
  fs.writeFileSync(path.join(staging, "code_derived_reference", "README.md"), readme, "utf8");

  if (!fs.existsSync(dbPath)) {
    console.warn("No omnichannel.db; skip meta_comments webhook export.");
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const cols = db.prepare("PRAGMA table_info(meta_comments)").all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("raw_webhook_payload")) {
      fs.writeFileSync(
        path.join(staging, "masked_payloads", "meta_raw_webhook_from_db_masked.json"),
        JSON.stringify(
          {
            _note: "Table meta_comments has no raw_webhook_payload column in this schema.",
            samples: [],
          },
          null,
          2
        ),
        "utf8"
      );
      console.log("meta_comments.raw_webhook_payload column missing; wrote empty stub.");
      return;
    }
    const rows = db
      .prepare(
        `SELECT id, page_id, comment_id, LENGTH(raw_webhook_payload) AS raw_len, raw_webhook_payload
         FROM meta_comments
         WHERE raw_webhook_payload IS NOT NULL AND trim(raw_webhook_payload) != ''
         ORDER BY id DESC LIMIT 8`
      )
      .all() as { id: number; page_id: string; comment_id: string; raw_len: number; raw_webhook_payload: string }[];

    if (rows.length === 0) {
      const out = {
        _note:
          "No rows with raw_webhook_payload in local DB. Still not raw HTTP capture — this is DB-stored webhook JSON when Meta path persisted it.",
        samples: [],
      };
      fs.writeFileSync(
        path.join(staging, "masked_payloads", "meta_raw_webhook_from_db_masked.json"),
        JSON.stringify(out, null, 2),
        "utf8"
      );
      console.log("meta_raw_webhook_from_db: 0 rows");
      return;
    }

    const samples = rows.map((r) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.raw_webhook_payload);
      } catch {
        parsed = { _parse_error: true, raw_snippet: maskJsonDeep(r.raw_webhook_payload) };
      }
      return {
        meta_comment_row_id: r.id,
        page_id: String(r.page_id || "").replace(/\d/g, (d) => "*"),
        comment_id: "[MASKED]",
        raw_payload_length: r.raw_len,
        payload_masked: maskJsonDeep(parsed),
      };
    });

    fs.writeFileSync(
      path.join(staging, "masked_payloads", "meta_raw_webhook_from_db_masked.json"),
      JSON.stringify(
        {
          _provenance:
            "Rows from meta_comments.raw_webhook_payload (local SQLite). Masked. Not guaranteed full HTTP (headers/signature not stored).",
          _note:
            "Closer to 'live payload shape' than hand-written samples when this table is populated in your environment.",
          samples,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`meta_raw_webhook_from_db: wrote ${samples.length} samples`);
  } finally {
    db.close();
  }
}

main();
