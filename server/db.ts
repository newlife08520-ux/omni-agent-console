import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import { getDataDir, ensureDataDirs } from "./data-dir";

ensureDataDirs();
const dbPath = path.join(getDataDir(), "omnichannel.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
/** 併發時若 DB 被鎖定，最多等待 5 秒再重試，避免 "database is locked" 直接當機（商業級必備） */
db.pragma("busy_timeout = 5000");

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export { hashPassword };

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cs_agent' CHECK(role IN ('super_admin','marketing_manager','cs_agent')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'line',
      platform_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      needs_human INTEGER NOT NULL DEFAULT 0,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','resolved')),
      tags TEXT NOT NULL DEFAULT '[]',
      vip_level INTEGER NOT NULL DEFAULT 0,
      order_count INTEGER NOT NULL DEFAULT 0,
      total_spent REAL NOT NULL DEFAULT 0,
      cs_rating INTEGER,
      last_message_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      platform TEXT NOT NULL DEFAULT 'line',
      sender_type TEXT NOT NULL CHECK(sender_type IN ('user','ai','admin','system')),
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'text' CHECK(message_type IN ('text','image','file','video','audio')),
      image_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS marketing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      pitch TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const msgCols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const msgColNames = msgCols.map((c) => c.name);
  if (!msgColNames.includes("message_type")) {
    db.exec("ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'");
  }
  if (!msgColNames.includes("image_url")) {
    db.exec("ALTER TABLE messages ADD COLUMN image_url TEXT");
  }

  const msgTableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get() as any)?.sql || "";
  if (msgTableSql.includes("'text','image','file'") && !msgTableSql.includes("'video'")) {
    console.log("[DB Migration] 擴充 messages.message_type CHECK 約束，加入 'video' 和 'audio'...");
    db.exec(`
      CREATE TABLE messages_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER NOT NULL,
        platform TEXT NOT NULL DEFAULT 'line',
        sender_type TEXT NOT NULL CHECK(sender_type IN ('user','ai','admin','system')),
        content TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'text' CHECK(message_type IN ('text','image','file','video','audio')),
        image_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      );
      INSERT INTO messages_new SELECT * FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
    `);
    console.log("[DB Migration] messages 資料表 CHECK 約束已更新完成");
  }

  const contactCols = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
  const contactColNames = contactCols.map((c) => c.name);
  if (!contactColNames.includes("cs_rating")) {
    db.exec("ALTER TABLE contacts ADD COLUMN cs_rating INTEGER");
  }
  if (!contactColNames.includes("ai_rating")) {
    db.exec("ALTER TABLE contacts ADD COLUMN ai_rating INTEGER");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`DELETE FROM processed_events WHERE processed_at < datetime('now', '-7 days');`);

  migrateContactStatusExpansion();
  migrateAiLogsTable();
  migrateAiLogsPhase0Observability();
  migrateBrandsAndChannels();
  migrateShoplineFields();
  migrateSystemPrompt();
  migrateHardMuteAndAlerts();
  migrateCaseManagement();
  migrateContactStatusCaseFlow();
  ensureContactStatusIncludesAssigned();
  migrateAgentDutyFields();
  migrateAgentContactFlags();
  migrateContactOrderLinks();
  migrateMetaCommentCenter();
  migrateMetaCommentPhase1();
  migrateMetaCommentPhase2();
  migrateMetaCommentPhase3();
  migrateAgentBrandAssignments();
  ensurePerformanceIndexes();
  seedMockData();
  migrateRemoveOldHandoffAndReturnRules();
  migrateTightenHumanTransferKeywords();
  migrateConversationStateFields();
}

/** 常用查詢欄位索引，避免資料量成長後掃全表 */
function ensurePerformanceIndexes() {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_contact_id ON messages(contact_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_contact_created ON messages(contact_id, created_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_contact_id_desc ON messages(contact_id, id DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_brand_id ON contacts(brand_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_assigned_agent_id ON contacts(assigned_agent_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_last_message_at ON contacts(last_message_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_platform_user ON contacts(platform, platform_user_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_logs_contact_id ON ai_logs(contact_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_logs_created_at ON ai_logs(created_at DESC);`);
}

const HUMAN_TRANSFER_KEYWORDS_NEW = "真人客服,轉人工,找主管,不要機器人,人工客服,真人處理";
const HUMAN_TRANSFER_FORBIDDEN = ["退貨", "爛", "投訴", "退款", "缺貨", "取消", "久候"];

/** 收緊快轉關鍵字：若現有設定含過寬字詞則改為新短語清單，避免單字觸發轉人工 */
function migrateTightenHumanTransferKeywords() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'human_transfer_keywords'").get() as { value: string } | undefined;
  if (!row?.value) return;
  const val = row.value;
  const keywords = val.split(",").map((k) => k.trim()).filter(Boolean);
  const hasForbidden = HUMAN_TRANSFER_FORBIDDEN.some((w) => val.includes(w)) || keywords.includes("客服");
  if (!hasForbidden) return;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'human_transfer_keywords'").run(HUMAN_TRANSFER_KEYWORDS_NEW);
  console.log("[DB] 已將 human_transfer_keywords 收緊為新短語清單（移除過寬字詞）");
}

/** 新增對話狀態／結案／評價／QA 欄位（先判斷再說話、24h 結案、評價條件） */
function migrateConversationStateFields() {
  const contactCols = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
  const contactColNames = contactCols.map((c) => c.name);
  const newCols: [string, string][] = [
    ["resolution_status", "TEXT"],
    ["waiting_for_customer", "TEXT"],
    ["human_reason", "TEXT"],
    ["return_stage", "INTEGER"],
    ["rating_invited_at", "TEXT"],
    ["close_reason", "TEXT"],
    ["qa_score", "INTEGER"],
    ["qa_score_reason", "TEXT"],
    ["product_scope_locked", "TEXT"],
    ["customer_goal_locked", "TEXT"],
  ];
  for (const [col, typ] of newCols) {
    if (!contactColNames.includes(col)) {
      db.exec(`ALTER TABLE contacts ADD COLUMN ${col} ${typ}`);
    }
  }
}

/** 移除 system_prompt 中舊版「售後服務 SOP 與退換貨防守機制」整段，改由 runtime 注入新版轉人工規則 */
function migrateRemoveOldHandoffAndReturnRules() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'system_prompt'").get() as { value: string } | undefined;
  if (!row?.value || !row.value.includes("## 售後服務 SOP 與退換貨防守機制")) return;
  const newValue = row.value.replace(/\n\n## 售後服務 SOP 與退換貨防守機制[\s\S]*$/, "");
  if (newValue === row.value) return;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'system_prompt'").run(newValue);
  console.log("[DB] 已移除 system_prompt 內舊版售後服務 SOP／退換貨防守機制，改由系統注入新版轉人工規則");
}

function migrateAgentBrandAssignments() {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_brand_assignments'").get();
  if (t) return;
  db.exec(`
    CREATE TABLE agent_brand_assignments (
      user_id INTEGER NOT NULL,
      brand_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('primary','backup')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, brand_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (brand_id) REFERENCES brands(id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_brand_assignments_brand ON agent_brand_assignments(brand_id);`);
}

/** Phase 1：粉專→品牌→LINE 設定表、留言表擴欄、貼文/商品判定來源、商品關鍵字表 */
function migrateMetaCommentPhase1() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_page_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id TEXT NOT NULL UNIQUE,
      page_name TEXT,
      brand_id INTEGER NOT NULL,
      line_general TEXT,
      line_after_sale TEXT,
      auto_hide_sensitive INTEGER NOT NULL DEFAULT 0,
      auto_reply_enabled INTEGER NOT NULL DEFAULT 0,
      auto_route_line_enabled INTEGER NOT NULL DEFAULT 0,
      default_reply_template_id INTEGER,
      default_sensitive_template_id INTEGER,
      default_flow TEXT,
      default_product_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (brand_id) REFERENCES brands(id),
      FOREIGN KEY (default_reply_template_id) REFERENCES meta_comment_templates(id),
      FOREIGN KEY (default_sensitive_template_id) REFERENCES meta_comment_templates(id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_product_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER,
      keyword TEXT NOT NULL,
      product_name TEXT NOT NULL,
      match_scope TEXT NOT NULL CHECK(match_scope IN ('post','comment')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (brand_id) REFERENCES brands(id)
    );
  `);
  const commentCols = (db.prepare("PRAGMA table_info(meta_comments)").all() as { name: string }[]).map((c) => c.name);
  const phase1Cols = [
    "reply_error", "platform_error", "auto_replied_at", "auto_hidden_at", "auto_routed_at",
    "detected_product_name", "detected_product_source", "detected_post_title_source", "post_display_name",
    "target_line_type", "target_line_value",
  ];
  for (const col of phase1Cols) {
    if (!commentCols.includes(col)) {
      const typ = col.includes("_at") ? "TEXT" : "TEXT";
      db.exec(`ALTER TABLE meta_comments ADD COLUMN ${col} ${typ}`);
      console.log("[DB Migration] meta_comments 已新增 " + col);
    }
  }
}

/** Phase 2：公開留言 Webhook 原始 payload、隱藏錯誤、平台動作紀錄 */
function migrateMetaCommentPhase2() {
  const commentCols = (db.prepare("PRAGMA table_info(meta_comments)").all() as { name: string }[]).map((c) => c.name);
  if (!commentCols.includes("raw_webhook_payload")) {
    db.exec("ALTER TABLE meta_comments ADD COLUMN raw_webhook_payload TEXT");
    console.log("[DB Migration] meta_comments 已新增 raw_webhook_payload");
  }
  if (!commentCols.includes("hide_error")) {
    db.exec("ALTER TABLE meta_comments ADD COLUMN hide_error TEXT");
    console.log("[DB Migration] meta_comments 已新增 hide_error");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_comment_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      executed_at TEXT NOT NULL DEFAULT (datetime('now')),
      success INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      platform_response TEXT,
      executor TEXT,
      FOREIGN KEY (comment_id) REFERENCES meta_comments(id)
    );
  `);
}

/** Phase 3：主狀態、自動執行防重複 */
function migrateMetaCommentPhase3() {
  const commentCols = (db.prepare("PRAGMA table_info(meta_comments)").all() as { name: string }[]).map((c) => c.name);
  if (!commentCols.includes("main_status")) {
    db.exec("ALTER TABLE meta_comments ADD COLUMN main_status TEXT");
    console.log("[DB Migration] meta_comments 已新增 main_status");
  }
  if (!commentCols.includes("auto_execution_run_at")) {
    db.exec("ALTER TABLE meta_comments ADD COLUMN auto_execution_run_at TEXT");
    console.log("[DB Migration] meta_comments 已新增 auto_execution_run_at");
  }
}

/** 對話與訂單雙向綁定：客服在該對話中查過某訂單即建立連結 */
function migrateContactOrderLinks() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_order_links (
      contact_id INTEGER NOT NULL,
      global_order_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (contact_id, global_order_id),
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
  `);
}

/** Meta 留言互動中心：留言、模板、貼文 mapping、規則 */
function migrateMetaCommentCenter() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER,
      page_id TEXT NOT NULL,
      page_name TEXT,
      post_id TEXT NOT NULL,
      post_name TEXT,
      comment_id TEXT NOT NULL UNIQUE,
      commenter_id TEXT,
      commenter_name TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      replied_at TEXT,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      is_dm_sent INTEGER NOT NULL DEFAULT 0,
      is_human_handled INTEGER NOT NULL DEFAULT 0,
      contact_id INTEGER,
      ai_intent TEXT,
      issue_type TEXT,
      priority TEXT DEFAULT 'normal',
      ai_suggest_hide INTEGER NOT NULL DEFAULT 0,
      ai_suggest_human INTEGER NOT NULL DEFAULT 0,
      reply_first TEXT,
      reply_second TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (brand_id) REFERENCES brands(id),
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
    CREATE TABLE IF NOT EXISTS meta_comment_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      reply_first TEXT NOT NULL DEFAULT '',
      reply_second TEXT NOT NULL DEFAULT '',
      reply_comfort TEXT NOT NULL DEFAULT '',
      reply_dm_guide TEXT NOT NULL DEFAULT '',
      tone_hint TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (brand_id) REFERENCES brands(id)
    );
    CREATE TABLE IF NOT EXISTS meta_post_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      page_id TEXT,
      page_name TEXT,
      post_id TEXT NOT NULL,
      post_name TEXT,
      product_name TEXT,
      primary_url TEXT,
      fallback_url TEXT,
      tone_hint TEXT,
      auto_comment_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (brand_id) REFERENCES brands(id)
    );
    CREATE TABLE IF NOT EXISTS meta_comment_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER,
      page_id TEXT,
      post_id TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      rule_type TEXT NOT NULL CHECK(rule_type IN ('use_template','hide','send_dm','to_human','add_tag')),
      keyword_pattern TEXT NOT NULL,
      template_id INTEGER,
      tag_value TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (brand_id) REFERENCES brands(id),
      FOREIGN KEY (template_id) REFERENCES meta_comment_templates(id)
    );
  `);
  const ruleCols = (db.prepare("PRAGMA table_info(meta_comment_rules)").all() as { name: string }[]).map((c) => c.name);
  if (!ruleCols.includes("enabled")) {
    db.exec("ALTER TABLE meta_comment_rules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
    console.log("[DB Migration] meta_comment_rules.enabled 已新增");
  }
  const commentCols = (db.prepare("PRAGMA table_info(meta_comments)").all() as { name: string }[]).map((c) => c.name);
  if (!commentCols.includes("applied_rule_id")) {
    db.exec("ALTER TABLE meta_comments ADD COLUMN applied_rule_id INTEGER REFERENCES meta_comment_rules(id)");
    db.exec("ALTER TABLE meta_comments ADD COLUMN applied_template_id INTEGER REFERENCES meta_comment_templates(id)");
    db.exec("ALTER TABLE meta_comments ADD COLUMN applied_mapping_id INTEGER REFERENCES meta_post_mappings(id)");
    db.exec("ALTER TABLE meta_comments ADD COLUMN reply_link_source TEXT");
    console.log("[DB Migration] meta_comments 已新增 applied_rule_id, applied_template_id, applied_mapping_id, reply_link_source");
  }
  if (!commentCols.includes("is_simulated")) {
    db.exec("ALTER TABLE meta_comments ADD COLUMN is_simulated INTEGER NOT NULL DEFAULT 0");
    console.log("[DB Migration] meta_comments 已新增 is_simulated");
  }
  if (!commentCols.includes("assigned_agent_id")) {
    db.exec("ALTER TABLE meta_comments ADD COLUMN assigned_agent_id INTEGER");
    db.exec("ALTER TABLE meta_comments ADD COLUMN assigned_agent_name TEXT");
    db.exec("ALTER TABLE meta_comments ADD COLUMN assigned_agent_avatar_url TEXT");
    db.exec("ALTER TABLE meta_comments ADD COLUMN assignment_method TEXT");
    db.exec("ALTER TABLE meta_comments ADD COLUMN assigned_at TEXT");
    console.log("[DB Migration] meta_comments 已新增 分派欄位 assigned_agent_* / assignment_method / assigned_at");
  }
  if (!commentCols.includes("classifier_source")) {
    db.exec("ALTER TABLE meta_comments ADD COLUMN classifier_source TEXT");
    db.exec("ALTER TABLE meta_comments ADD COLUMN matched_rule_keyword TEXT");
    console.log("[DB Migration] meta_comments 已新增 classifier_source, matched_rule_keyword");
  }
  if (!commentCols.includes("reply_flow_type")) {
    db.exec("ALTER TABLE meta_comments ADD COLUMN reply_flow_type TEXT");
    console.log("[DB Migration] meta_comments 已新增 reply_flow_type");
  }
  if (!commentCols.includes("matched_risk_rule_id")) {
    db.exec("ALTER TABLE meta_comments ADD COLUMN matched_risk_rule_id INTEGER");
    db.exec("ALTER TABLE meta_comments ADD COLUMN matched_rule_bucket TEXT");
    console.log("[DB Migration] meta_comments 已新增 matched_risk_rule_id, matched_rule_bucket");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_comment_risk_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_name TEXT NOT NULL DEFAULT '',
      rule_bucket TEXT NOT NULL CHECK(rule_bucket IN ('whitelist','direct_hide','hide_and_route','route_only','gray_area')),
      keyword_pattern TEXT NOT NULL DEFAULT '',
      match_type TEXT NOT NULL DEFAULT 'contains' CHECK(match_type IN ('contains','exact','regex')),
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      brand_id INTEGER,
      page_id TEXT,
      action_reply INTEGER NOT NULL DEFAULT 0,
      action_hide INTEGER NOT NULL DEFAULT 0,
      action_route_line INTEGER NOT NULL DEFAULT 0,
      route_line_type TEXT CHECK(route_line_type IN ('general','after_sale','none') OR route_line_type IS NULL),
      action_mark_to_human INTEGER NOT NULL DEFAULT 0,
      action_use_template_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (brand_id) REFERENCES brands(id),
      FOREIGN KEY (action_use_template_id) REFERENCES meta_comment_templates(id)
    );
  `);
  const riskRuleCount = (db.prepare("SELECT COUNT(*) as c FROM meta_comment_risk_rules").get() as { c: number }).c;
  if (riskRuleCount === 0) {
    const now = new Date().toISOString();
    const seed = (bucket: string, keyword: string, reply: number, hide: number, route: number, lineType: string | null, toHuman: number) =>
      db.prepare(`
        INSERT INTO meta_comment_risk_rules (rule_name, rule_bucket, keyword_pattern, match_type, priority, enabled, action_reply, action_hide, action_route_line, route_line_type, action_mark_to_human, created_at, updated_at)
        VALUES (?, ?, ?, 'contains', 0, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(`種子: ${keyword}`, bucket, keyword, reply, hide, route, lineType, toHuman, now, now);
    for (const k of ["有貨", "哪裡買", "怎麼買", "價格", "官網", "連結", "適合我嗎", "孕婦可以嗎", "敏感肌可以嗎"]) seed("whitelist", k, 1, 0, 0, null, 0);
    for (const k of ["淘寶", "蝦皮", "爛", "雷", "地雷", "不推薦", "盤", "騙", "垃圾", "浪費錢", "誇大", "不實", "呵呵", "笑死", "智商稅"]) seed("direct_hide", k, 0, 1, 0, null, 0);
    for (const k of ["訂單", "沒收到", "漏寄", "少寄", "退貨", "退款", "取消", "改地址", "客服", "聯絡不上", "品質", "過敏", "瑕疵", "發票", "付款", "物流", "配送", "已讀不回"]) seed("hide_and_route", k, 1, 1, 1, "after_sale", 1);
    for (const k of ["批發", "合作", "團購", "客製", "報價", "大量購買", "企業合作", "特殊需求"]) seed("route_only", k, 1, 0, 1, "general", 0);
    for (const k of ["哈哈", "呵", "笑死", "太扯", "真的假的", "好喔", "不回喔"]) seed("gray_area", k, 0, 0, 0, null, 0);
    console.log("[DB Migration] meta_comment_risk_rules 已寫入種子規則");
  }
  const mappingCols = (db.prepare("PRAGMA table_info(meta_post_mappings)").all() as { name: string }[]).map((c) => c.name);
  if (!mappingCols.includes("preferred_flow")) {
    db.exec("ALTER TABLE meta_post_mappings ADD COLUMN preferred_flow TEXT");
    console.log("[DB Migration] meta_post_mappings 已新增 preferred_flow");
  }
  // 種子：若尚無留言則新增範例資料，方便驗收
  const commentCount = (db.prepare("SELECT COUNT(*) as c FROM meta_comments").get() as { c: number }).c;
  if (commentCount === 0) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO meta_comments (page_id, page_name, post_id, post_name, comment_id, commenter_name, message, created_at, ai_intent, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("page_demo", "示範粉專", "post_001", "春季活動貼文", "seed_comment_1", "王小明", "請問這款現在還有貨嗎？想買兩瓶", now, "product_inquiry", "normal");
    db.prepare(`
      INSERT INTO meta_comments (page_id, page_name, post_id, post_name, comment_id, commenter_name, message, created_at, ai_intent, priority, ai_suggest_human)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("page_demo", "示範粉專", "post_002", "商品介紹貼文", "seed_comment_2", "陳小姐", "我上週訂的還沒收到，可以幫我查嗎？很急", now, "refund_after_sale", "high", 1);
    console.log("[DB Migration] Meta 留言互動中心已寫入 2 筆範例留言");
  }
  const templateCount = (db.prepare("SELECT COUNT(*) as c FROM meta_comment_templates").get() as { c: number }).c;
  if (templateCount === 0) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO meta_comment_templates (brand_id, category, name, reply_first, reply_second, reply_comfort, reply_dm_guide, tone_hint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(null, "product_inquiry", "一般商品詢問（示範）", "您好，目前都有現貨喔～", "喜歡的話可以從這裡下單：{primary_url} 有問題再跟我說～", "不好意思造成您的困擾，我們會盡快為您處理。", "請私訊我們提供訂單編號，專人為您查詢。", "親切、活潑", now);
    console.log("[DB Migration] Meta 留言互動中心已寫入 1 筆範例模板");
  }
  const lineTplCount = (db.prepare("SELECT COUNT(*) as c FROM meta_comment_templates WHERE category IN ('line_general','line_after_sale','line_promotion')").get() as { c: number }).c;
  if (lineTplCount === 0) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO meta_comment_templates (brand_id, category, name, reply_first, reply_second, reply_comfort, reply_dm_guide, tone_hint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(null, "line_general", "LINE 一般協助型", "", "", "", "這題比較適合由客服一對一幫你確認，我們把 LINE 放這邊給你 🤍\n如果想更快確認細節，LINE 客服這邊會比較方便協助你～", "自然、友善", now);
    db.prepare(`
      INSERT INTO meta_comment_templates (brand_id, category, name, reply_first, reply_second, reply_comfort, reply_dm_guide, tone_hint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(null, "line_after_sale", "LINE 售後／客訴型", "", "", "抱歉讓你有不好的感受，這邊先跟你說聲不好意思 🙏\n為了更快幫你確認，麻煩加入 LINE 客服並提供資訊，我們會盡快協助你處理。", "抱歉讓你有不好的感受，這邊先跟你說聲不好意思 🙏\n為了更快幫你確認，麻煩加入 LINE 客服並提供資訊，我們會盡快協助你處理。", "誠懇、同理", now);
    db.prepare(`
      INSERT INTO meta_comment_templates (brand_id, category, name, reply_first, reply_second, reply_comfort, reply_dm_guide, tone_hint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(null, "line_promotion", "LINE 導購型", "", "", "", "如果你想直接看更完整內容或讓客服幫你挑選，這邊也可以直接找我們 LINE 客服 ✨", "親切、邀請", now);
    console.log("[DB Migration] Meta 留言分流中心已寫入 3 筆 LINE 導流話術模板");
  }
  const templateCols = (db.prepare("PRAGMA table_info(meta_comment_templates)").all() as { name: string }[]).map((c) => c.name);
  if (!templateCols.includes("reply_private")) {
    db.exec("ALTER TABLE meta_comment_templates ADD COLUMN reply_private TEXT");
    console.log("[DB Migration] meta_comment_templates 已新增 reply_private（私訊版文案）");
  }
  const safeTplCount = (db.prepare("SELECT COUNT(*) as c FROM meta_comment_templates WHERE category IN ('safe_confirm_order','safe_confirm_emotional','external_platform_order','fraud_impersonation')").get() as { c: number }).c;
  const now = new Date().toISOString();
  const safeTplCols = (db.prepare("PRAGMA table_info(meta_comment_templates)").all() as { name: string }[]).map((c) => c.name);
  const hasReplyPrivate = safeTplCols.includes("reply_private");
  if (safeTplCount === 0) {
    const ins = hasReplyPrivate
      ? (brand: null, cat: string, name: string, r1: string, r2: string, rc: string, rd: string, rp: string, tone: string) =>
          db.prepare(`
            INSERT INTO meta_comment_templates (brand_id, category, name, reply_first, reply_second, reply_comfort, reply_dm_guide, reply_private, tone_hint, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(brand, cat, name, r1, r2, rc, rd, rp, tone, now)
      : (brand: null, cat: string, name: string, r1: string, r2: string, rc: string, rd: string, _rp: string, tone: string) =>
          db.prepare(`
            INSERT INTO meta_comment_templates (brand_id, category, name, reply_first, reply_second, reply_comfort, reply_dm_guide, tone_hint, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(brand, cat, name, r1, r2, rc, rd, tone, now);
    const dmOrder = "先跟您確認：若您是透過我們官方通路下單，請提供「訂單編號 + 下單手機」，我們會立刻幫您查。若是其他平台購買，建議向該平台客服確認會最快。";
    const dmEmo = "不好意思讓您有不好的感受。我們先確認來源：請提供訂單編號與下單手機，我們會立刻幫您查；若為他平台購買，會引導您到正確客服。";
    const dmPlatform = "若您是在蝦皮／其他平台購買，訂單與出貨以該平台為準，建議先聯繫該平台客服。若為官方通路下單，請提供訂單編號與下單手機，我們可幫您查。";
    const dmFraud = "先提醒：我們不會用私人帳號要求轉帳或驗證碼。請提供對話截圖、付款資訊與對方帳號，我們協助確認是否冒用並給建議；必要時請同步報警與通知平台。";
    ins(null, "safe_confirm_order", "待確認訂單來源｜安全確認（通用）",
      "我先幫您確認一下 🙏\n若您是透過我們**官方通路**下單，麻煩您加入 LINE 並提供「訂單編號 / 下單手機 / 收件資訊」，我們會立刻為您查詢處理。\n若是其他平台購買，建議也同步向原購買平台客服確認，通常處理會更快。",
      "👉 請私訊我們 LINE：{after_sale_line_url}\n送出「訂單編號 + 下單手機」我們就能快速幫您查到進度。",
      "為了保護您的個資，也方便我們加速查詢，麻煩您私訊 LINE：{after_sale_line_url}\n送出「訂單編號 + 下單手機」，我們會立刻幫您確認進度與後續處理。",
      "為了保護您的個資，也方便我們加速查詢，麻煩您私訊 LINE：{after_sale_line_url}\n送出「訂單編號 + 下單手機」，我們會立刻幫您確認進度與後續處理。",
      dmOrder, "誠懇、不承諾");
    ins(null, "safe_confirm_emotional", "待確認訂單來源｜情緒客訴版",
      "真的抱歉讓您有不好的感受 🙏\n我們先協助您把狀況確認清楚：麻煩您加入 LINE 私訊訂單資訊，我們會立刻幫您查。\n若您是在其他平台購買，也會引導您到正確客服，避免延誤處理。",
      "👉 請私訊 LINE：{after_sale_line_url}\n直接貼上「訂單編號 / 下單手機 / 問題截圖」，我們會更快協助您。",
      "", "", dmEmo, "誠懇、同理、不承諾");
    ins(null, "external_platform_order", "他平台訂單｜導正方向",
      "我先跟您確認一下～如果您是在 **蝦皮 / 其他平台** 購買，訂單與出貨會以該平台系統為準，建議先聯繫原購買平台客服，處理會最快。\n若您是透過我們**官方通路**下單，也歡迎加入 LINE 私訊訂單資訊，我們一樣可以幫您確認。",
      "若是官方通路訂單 👉 {after_sale_line_url}\n私訊「訂單編號 + 下單手機」我們立刻幫您查。",
      "", "", dmPlatform, "中性、導正");
    ins(null, "fraud_impersonation", "疑似詐騙／冒用｜蒐證引導",
      "真的辛苦了…先提醒您：我們不會用私人帳號要求轉帳或提供驗證碼。\n麻煩您加入 LINE 私訊提供「對話截圖 / 付款資訊 / 對方帳號」，我們先協助您確認是否為冒用，並提供後續建議（必要時也建議同步報警與通知平台）。",
      "👉 請私訊 LINE：{after_sale_line_url}\n直接貼上「對話截圖 + 付款證明」，我們會協助您確認與整理處理方向。",
      "", "", dmFraud, "謹慎、同理、不承認");
    console.log("[DB Migration] Meta 安全確認模板已寫入 4 筆（待確認訂單／他平台／詐騙蒐證，含私訊版）");
  } else if (hasReplyPrivate) {
    const dmOrder = "先跟您確認：若您是透過我們官方通路下單，請提供「訂單編號 + 下單手機」，我們會立刻幫您查。若是其他平台購買，建議向該平台客服確認會最快。";
    const dmEmo = "不好意思讓您有不好的感受。我們先確認來源：請提供訂單編號與下單手機，我們會立刻幫您查；若為他平台購買，會引導您到正確客服。";
    const dmPlatform = "若您是在蝦皮／其他平台購買，訂單與出貨以該平台為準，建議先聯繫該平台客服。若為官方通路下單，請提供訂單編號與下單手機，我們可幫您查。";
    const dmFraud = "先提醒：我們不會用私人帳號要求轉帳或驗證碼。請提供對話截圖、付款資訊與對方帳號，我們協助確認是否冒用並給建議；必要時請同步報警與通知平台。";
    db.prepare("UPDATE meta_comment_templates SET reply_private = ? WHERE category = 'safe_confirm_order'").run(dmOrder);
    db.prepare("UPDATE meta_comment_templates SET reply_private = ? WHERE category = 'safe_confirm_emotional'").run(dmEmo);
    db.prepare("UPDATE meta_comment_templates SET reply_private = ? WHERE category = 'external_platform_order'").run(dmPlatform);
    db.prepare("UPDATE meta_comment_templates SET reply_private = ? WHERE category = 'fraud_impersonation'").run(dmFraud);
    console.log("[DB Migration] Meta 安全確認模板已補上 reply_private（私訊版）");
  }
  const mappingCount = (db.prepare("SELECT COUNT(*) as c FROM meta_post_mappings").get() as { c: number }).c;
  if (mappingCount === 0) {
    const firstBrand = db.prepare("SELECT id FROM brands LIMIT 1").get() as { id: number } | undefined;
    if (firstBrand) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO meta_post_mappings (brand_id, page_id, page_name, post_id, post_name, product_name, primary_url, tone_hint, auto_comment_enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(firstBrand.id, "page_demo", "示範粉專", "post_001", "春季活動貼文", "經典精華液", "https://example.com/product/a", "親切、活潑", 1, now);
      console.log("[DB Migration] Meta 留言互動中心已寫入 1 筆範例貼文對應");
    }
  }
  console.log("[DB Migration] Meta 留言互動中心表已就緒");
}

function migrateAgentContactFlags() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_contact_flags (
      agent_id INTEGER NOT NULL,
      contact_id INTEGER NOT NULL,
      flag TEXT NOT NULL CHECK(flag IN ('later','tracking')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_id, contact_id),
      FOREIGN KEY (agent_id) REFERENCES users(id),
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
  `);
}

function migrateAgentDutyFields() {
  const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const userNames = userCols.map((c) => c.name);
  if (!userNames.includes("is_online")) {
    db.exec("ALTER TABLE users ADD COLUMN is_online INTEGER NOT NULL DEFAULT 0");
  }
  if (!userNames.includes("is_available")) {
    db.exec("ALTER TABLE users ADD COLUMN is_available INTEGER NOT NULL DEFAULT 1");
  }
  if (!userNames.includes("last_active_at")) {
    db.exec("ALTER TABLE users ADD COLUMN last_active_at TEXT");
  }
  if (!userNames.includes("avatar_url")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT");
  }

  const agentCols = db.prepare("PRAGMA table_info(agent_status)").all() as { name: string }[];
  const agentNames = agentCols.map((c) => c.name);
  if (!agentNames.includes("max_active_conversations")) {
    db.exec("ALTER TABLE agent_status ADD COLUMN max_active_conversations INTEGER NOT NULL DEFAULT 10");
  }
  if (!agentNames.includes("auto_assign_enabled")) {
    db.exec("ALTER TABLE agent_status ADD COLUMN auto_assign_enabled INTEGER NOT NULL DEFAULT 1");
  }

  const contactCols = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
  const contactNames = contactCols.map((c) => c.name);
  if (!contactNames.includes("last_human_reply_at")) {
    db.exec("ALTER TABLE contacts ADD COLUMN last_human_reply_at TEXT");
  }
  if (!contactNames.includes("reassign_count")) {
    db.exec("ALTER TABLE contacts ADD COLUMN reassign_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!contactNames.includes("assignment_status")) {
    db.exec("ALTER TABLE contacts ADD COLUMN assignment_status TEXT");
  }
  if (!contactNames.includes("assigned_at")) {
    db.exec("ALTER TABLE contacts ADD COLUMN assigned_at TEXT");
  }
  if (!contactNames.includes("assignment_method")) {
    db.exec("ALTER TABLE contacts ADD COLUMN assignment_method TEXT");
  }
  if (!contactNames.includes("needs_assignment")) {
    db.exec("ALTER TABLE contacts ADD COLUMN needs_assignment INTEGER NOT NULL DEFAULT 0");
  }
  if (!contactNames.includes("assignment_reason")) {
    db.exec("ALTER TABLE contacts ADD COLUMN assignment_reason TEXT");
  }
  if (!contactNames.includes("response_sla_deadline_at")) {
    db.exec("ALTER TABLE contacts ADD COLUMN response_sla_deadline_at TEXT");
  }

  const histCols = db.prepare("PRAGMA table_info(assignment_history)").all() as { name: string }[];
  const histNames = histCols.map((c) => c.name);
  if (!histNames.includes("action_type")) {
    db.exec("ALTER TABLE assignment_history ADD COLUMN action_type TEXT");
  }
  if (!histNames.includes("operator_user_id")) {
    db.exec("ALTER TABLE assignment_history ADD COLUMN operator_user_id INTEGER");
  }

  const defaultSchedule = [
    ["work_start_time", "09:00"],
    ["work_end_time", "18:00"],
    ["lunch_start_time", "12:30"],
    ["lunch_end_time", "13:30"],
    ["human_first_reply_sla_minutes", "10"],
    ["assignment_auto_enabled", "1"],
    ["assignment_timeout_reassign_enabled", "1"],
  ];
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of defaultSchedule) {
    insertSetting.run(key, value);
  }

  console.log("[DB Migration] 客服值班欄位（在線、負載、SLA、全域時段、分配紀錄）已就緒");
}

const CASE_FLOW_STATUSES = "('pending','processing','resolved','ai_handling','awaiting_human','high_risk','closed','new_case','pending_info','pending_order_id','assigned','waiting_customer','resolved_observe','reopened')";

function migrateContactStatusCaseFlow() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'").get() as { sql: string } | undefined;
  const tableSql = row?.sql || "";
  if (tableSql.includes("'assigned'")) return;
  const checkMatch = tableSql.match(/CHECK\s*\(\s*status\s+IN\s*\([\s\S]*?\)\s*\)/);
  if (!checkMatch) return;
  console.log("[DB Migration] 擴充 contacts.status 支援案件流程狀態...");
  applyContactStatusCaseFlowMigration(tableSql, checkMatch[0]);
}

/** 強制確保 contacts.status 的 CHECK 包含 assigned 等狀態（若先前 migration 未生效可補跑） */
function ensureContactStatusIncludesAssigned() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'").get() as { sql: string } | undefined;
  const tableSql = row?.sql || "";
  if (tableSql.includes("'assigned'") && tableSql.includes("'waiting_customer'")) return;
  const checkMatch = tableSql.match(/CHECK\s*\(\s*status\s+IN\s*\([\s\S]*?\)\s*\)/);
  let checkOld: string | null = checkMatch ? checkMatch[0] : null;
  if (!checkOld) {
    const idx = tableSql.indexOf("CHECK");
    const parenStart = idx >= 0 ? tableSql.indexOf("(", idx) : -1;
    if (parenStart >= 0) {
      let depth = 1;
      for (let i = parenStart + 1; i < tableSql.length; i++) {
        if (tableSql[i] === "(") depth++;
        else if (tableSql[i] === ")") { depth--; if (depth === 0) { checkOld = tableSql.slice(idx, i + 1); break; } }
      }
      if (checkOld && !checkOld.includes("status")) checkOld = null;
    }
  }
  if (!checkOld) return;
  console.log("[DB Migration] 補強 contacts.status CHECK，加入 assigned / waiting_customer 等狀態...");
  applyContactStatusCaseFlowMigration(tableSql, checkOld);
}

function applyContactStatusCaseFlowMigration(tableSql: string, checkOld: string) {
  const newSql = tableSql.replace(checkOld, `CHECK(status IN ${CASE_FLOW_STATUSES})`);
  const createTableReplaced = newSql
    .replace(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(?:[\w.]*\.)?("?)contacts("?)\s*(\()/gi, "CREATE TABLE $1$2contacts_case_flow$3 $4");
  if (createTableReplaced === newSql) return;
  db.pragma("foreign_keys = OFF");
  db.exec("DROP TABLE IF EXISTS contacts_case_flow;");
  db.exec(createTableReplaced);
  const cols = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
  const colNames = cols.map((c) => c.name).join(",");
  db.exec(`INSERT INTO contacts_case_flow (${colNames}) SELECT ${colNames} FROM contacts;`);
  db.exec("DROP TABLE contacts;");
  db.exec("ALTER TABLE contacts_case_flow RENAME TO contacts;");
  db.pragma("foreign_keys = ON");
  console.log("[DB Migration] contacts.status 已支援案件流程狀態（含 assigned）");
}

function migrateCaseManagement() {
  const contactCols = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
  const contactColNames = contactCols.map((c) => c.name);
  const newCols: [string, string][] = [
    ["assigned_agent_id", "INTEGER"],
    ["intent_level", "TEXT"],
    ["order_number_type", "TEXT"],
    ["first_assigned_at", "TEXT"],
    ["closed_at", "TEXT"],
    ["closed_by_agent_id", "INTEGER"],
    ["case_priority", "INTEGER"],
  ];
  for (const [col, typ] of newCols) {
    if (!contactColNames.includes(col)) {
      db.exec(`ALTER TABLE contacts ADD COLUMN ${col} ${typ}`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_status (
      user_id INTEGER PRIMARY KEY,
      priority INTEGER NOT NULL DEFAULT 1,
      on_duty INTEGER NOT NULL DEFAULT 1,
      lunch_break INTEGER NOT NULL DEFAULT 0,
      pause_new_cases INTEGER NOT NULL DEFAULT 0,
      today_assigned_count INTEGER NOT NULL DEFAULT 0,
      open_cases_count INTEGER NOT NULL DEFAULT 0,
      work_start_time TEXT NOT NULL DEFAULT '09:00',
      work_end_time TEXT NOT NULL DEFAULT '18:00',
      lunch_start_time TEXT NOT NULL DEFAULT '12:00',
      lunch_end_time TEXT NOT NULL DEFAULT '13:00',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS assignment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      assigned_to_agent_id INTEGER NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      assigned_by_agent_id INTEGER,
      reassigned_from_agent_id INTEGER,
      note TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id),
      FOREIGN KEY (assigned_to_agent_id) REFERENCES users(id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assignment_history_contact ON assignment_history(contact_id);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS case_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'in_app',
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_case_notifications_contact ON case_notifications(contact_id);`);

  console.log("[DB Migration] 案件管理、客服狀態、分配紀錄表已就緒");
}

function migrateContactStatusExpansion() {
  const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'").get() as any)?.sql || "";
  if (tableSql.includes("'pending','processing','resolved'") && !tableSql.includes("'ai_handling'")) {
    console.log("[DB Migration] 擴充 contacts.status CHECK 約束...");
    const cols = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);

    db.pragma("foreign_keys = OFF");

    db.exec(`DROP TABLE IF EXISTS contacts_new;`);
    db.exec(`
      CREATE TABLE contacts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL DEFAULT 'line',
        platform_user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        needs_human INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','resolved','ai_handling','awaiting_human','high_risk','closed')),
        tags TEXT NOT NULL DEFAULT '[]',
        vip_level INTEGER NOT NULL DEFAULT 0,
        order_count INTEGER NOT NULL DEFAULT 0,
        total_spent REAL NOT NULL DEFAULT 0,
        cs_rating INTEGER,
        ai_rating INTEGER,
        last_message_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        brand_id INTEGER,
        channel_id INTEGER,
        issue_type TEXT,
        order_source TEXT
      );
    `);

    const insertCols = ["id","platform","platform_user_id","display_name","avatar_url","needs_human","is_pinned","status","tags","vip_level","order_count","total_spent","cs_rating","ai_rating","last_message_at","created_at","brand_id","channel_id","issue_type","order_source"];
    const selectParts: string[] = [];
    for (const col of insertCols) {
      if (colNames.includes(col)) {
        selectParts.push(col);
      } else {
        selectParts.push("NULL");
      }
    }
    db.exec(`INSERT INTO contacts_new (${insertCols.join(",")}) SELECT ${selectParts.join(",")} FROM contacts;`);
    db.exec(`DROP TABLE contacts;`);
    db.exec(`ALTER TABLE contacts_new RENAME TO contacts;`);

    db.pragma("foreign_keys = ON");
    console.log("[DB Migration] contacts.status CHECK 已擴充完成（含 ai_handling, awaiting_human, high_risk, closed）");
  } else {
    const contactCols = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
    const contactColNames = contactCols.map(c => c.name);
    if (!contactColNames.includes("issue_type")) {
      db.exec("ALTER TABLE contacts ADD COLUMN issue_type TEXT");
    }
    if (!contactColNames.includes("order_source")) {
      db.exec("ALTER TABLE contacts ADD COLUMN order_source TEXT");
    }
    if (!contactColNames.includes("ai_suggestions")) {
      db.exec("ALTER TABLE contacts ADD COLUMN ai_suggestions TEXT");
    }
  }
}

function migrateAiLogsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER,
      message_id INTEGER,
      brand_id INTEGER,
      prompt_summary TEXT NOT NULL DEFAULT '',
      knowledge_hits TEXT NOT NULL DEFAULT '[]',
      tools_called TEXT NOT NULL DEFAULT '[]',
      transfer_triggered INTEGER NOT NULL DEFAULT 0,
      transfer_reason TEXT,
      result_summary TEXT NOT NULL DEFAULT '',
      token_usage INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '',
      response_time_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
  `);
}

/** Phase 0 可觀測性：ai_logs 新增 reply_source, used_llm, plan_mode, reason_if_bypassed */
function migrateAiLogsPhase0Observability() {
  const columns = db.prepare("PRAGMA table_info(ai_logs)").all() as { name: string }[];
  const names = new Set(columns.map((c) => c.name));
  if (!names.has("reply_source")) {
    db.exec("ALTER TABLE ai_logs ADD COLUMN reply_source TEXT DEFAULT ''");
  }
  if (!names.has("used_llm")) {
    db.exec("ALTER TABLE ai_logs ADD COLUMN used_llm INTEGER DEFAULT 0");
  }
  if (!names.has("plan_mode")) {
    db.exec("ALTER TABLE ai_logs ADD COLUMN plan_mode TEXT");
  }
  if (!names.has("reason_if_bypassed")) {
    db.exec("ALTER TABLE ai_logs ADD COLUMN reason_if_bypassed TEXT");
  }
}

function migrateBrandsAndChannels() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      logo_url TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      superlanding_merchant_no TEXT NOT NULL DEFAULT '',
      superlanding_access_key TEXT NOT NULL DEFAULT '',
      return_form_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      platform TEXT NOT NULL DEFAULT 'line' CHECK(platform IN ('line','messenger')),
      channel_name TEXT NOT NULL,
      bot_id TEXT NOT NULL DEFAULT '',
      access_token TEXT NOT NULL DEFAULT '',
      channel_secret TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (brand_id) REFERENCES brands(id)
    );
  `);

  const channelColNames = db.prepare("PRAGMA table_info(channels)").all() as { name: string }[];
  if (!channelColNames.map(c => c.name).includes("is_ai_enabled")) {
    db.exec("ALTER TABLE channels ADD COLUMN is_ai_enabled INTEGER NOT NULL DEFAULT 0");
  }

  const brandColNames = db.prepare("PRAGMA table_info(brands)").all() as { name: string }[];
  if (!brandColNames.map(c => c.name).includes("return_form_url")) {
    db.exec("ALTER TABLE brands ADD COLUMN return_form_url TEXT NOT NULL DEFAULT ''");
  }

  const contactCols2 = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
  const contactColNames2 = contactCols2.map((c) => c.name);
  if (!contactColNames2.includes("brand_id")) {
    db.exec("ALTER TABLE contacts ADD COLUMN brand_id INTEGER");
  }
  if (!contactColNames2.includes("channel_id")) {
    db.exec("ALTER TABLE contacts ADD COLUMN channel_id INTEGER");
  }

  const kfCols = db.prepare("PRAGMA table_info(knowledge_files)").all() as { name: string }[];
  const kfColNames = kfCols.map(c => c.name);
  if (!kfColNames.includes("brand_id")) {
    db.exec("ALTER TABLE knowledge_files ADD COLUMN brand_id INTEGER");
  }
  if (!kfColNames.includes("content")) {
    db.exec("ALTER TABLE knowledge_files ADD COLUMN content TEXT");
  }
  // knowledge_files metadata（草案：category, intent, allowed_modes, forbidden_modes, tone）
  for (const col of ["category", "intent", "allowed_modes", "forbidden_modes", "tone"]) {
    const currentCols = db.prepare("PRAGMA table_info(knowledge_files)").all() as { name: string }[];
    if (!currentCols.some(c => c.name === col)) {
      db.exec(`ALTER TABLE knowledge_files ADD COLUMN ${col} TEXT`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS image_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      keywords TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT NOT NULL DEFAULT '',
      brand_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const mrCols = db.prepare("PRAGMA table_info(marketing_rules)").all() as { name: string }[];
  if (!mrCols.map(c => c.name).includes("brand_id")) {
    db.exec("ALTER TABLE marketing_rules ADD COLUMN brand_id INTEGER");
  }

  const brandCount = db.prepare("SELECT COUNT(*) as count FROM brands").get() as { count: number };
  if (brandCount.count === 0) {
    const result = db.prepare("INSERT INTO brands (name, slug, description) VALUES (?, ?, ?)").run("預設品牌", "default", "系統預設品牌工作區");
    const defaultBrandId = Number(result.lastInsertRowid);

    const lineToken = db.prepare("SELECT value FROM settings WHERE key = 'line_channel_access_token'").get() as { value: string } | undefined;
    const lineSecret = db.prepare("SELECT value FROM settings WHERE key = 'line_channel_secret'").get() as { value: string } | undefined;
    if (lineToken?.value || lineSecret?.value) {
      db.prepare("INSERT INTO channels (brand_id, platform, channel_name, access_token, channel_secret) VALUES (?, ?, ?, ?, ?)").run(
        defaultBrandId, "line", "預設 LINE 頻道", lineToken?.value || "", lineSecret?.value || ""
      );
    }

    db.prepare("UPDATE contacts SET brand_id = ? WHERE brand_id IS NULL").run(defaultBrandId);
    db.prepare("UPDATE knowledge_files SET brand_id = ? WHERE brand_id IS NULL").run(defaultBrandId);
    db.prepare("UPDATE marketing_rules SET brand_id = ? WHERE brand_id IS NULL").run(defaultBrandId);

    console.log("[DB] 已建立多品牌架構：預設品牌 + 頻道已遷移");
  }

  const orphanedContacts = db.prepare("SELECT COUNT(*) as count FROM contacts WHERE brand_id IS NULL").get() as { count: number };
  if (orphanedContacts.count > 0) {
    const firstBrand = db.prepare("SELECT id FROM brands ORDER BY id ASC LIMIT 1").get() as { id: number } | undefined;
    if (firstBrand) {
      db.prepare("UPDATE contacts SET brand_id = ? WHERE brand_id IS NULL").run(firstBrand.id);
      console.log(`[DB] 已將 ${orphanedContacts.count} 位未分配聯絡人歸入品牌 #${firstBrand.id}`);
    }
  }
}

function migrateShoplineFields() {
  const brandCols = db.prepare("PRAGMA table_info(brands)").all() as { name: string }[];
  const brandColNames = brandCols.map(c => c.name);
  if (!brandColNames.includes("shopline_store_domain")) {
    db.exec("ALTER TABLE brands ADD COLUMN shopline_store_domain TEXT NOT NULL DEFAULT ''");
  }
  if (!brandColNames.includes("shopline_api_token")) {
    db.exec("ALTER TABLE brands ADD COLUMN shopline_api_token TEXT NOT NULL DEFAULT ''");
  }
}

function migrateSystemPrompt() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'system_prompt'").get() as { value: string } | undefined;
  if (!row || !row.value) return;

  const ORDER_RULES_V4 = `\n\n## 訂單查詢決策樹（Strict Rules v4.3）\n\n### ⚠️ 核心鐵律：零驗證原則\n本系統查詢訂單**不需要任何身分驗證**。\n- **絕對禁止**要求客戶提供「手機末三碼」「完整電話」「Email」來核對身分。\n- **絕對禁止**說出「為了保護您的隱私」「為了確認是本人」「為了避免查到不同人的訂單」等驗證話術。\n- 只要客戶提供了訂單編號，就閉嘴直接去查。不問、不驗、不囉嗦。\n\n### 路徑 A：極速查詢（客戶有訂單編號）\n當客戶提供了訂單編號（如 KBT58265、DEN12345、MRQ00001、MRH99999 等格式）：\n→ **立即、直接**觸發訂單查詢，不追問任何額外資訊。\n→ 查到後回覆訂單狀態、物流進度等。\n→ 查無結果則告知客戶「這個編號目前查不到紀錄，請確認是否正確唷～」\n→ 流程結束。\n\n### 路徑 B：無單號救援（客戶沒有訂單編號）\n當客戶表示找不到單號、忘記了、沒收到確認信時：\n⚠️ 絕對不可以在此階段提議轉接真人客服！\n→ 親切詢問「商品名稱」和「手機號碼」兩項資訊。\n→ 話術：「沒關係唷～請告訴我您買的是什麼商品，再加上下單時留的手機號碼，我馬上幫您查！😊」\n→ 客戶說出商品後，從內部商品清單語意匹配（支持錯字、簡稱、俗稱）。\n→ 若匹配到多個商品，列出選項讓客戶確認（只顯示產品名稱）。\n→ 確認唯一商品 + 取得手機號碼後，觸發查詢。\n→ 流程結束。\n\n### 路徑 A 與路徑 B 互不干涉\n- 走路徑 A 時，不需要手機號碼、不需要商品名稱、不需要任何額外資訊。\n- 走路徑 B 時，不需要訂單編號。\n- 兩條路徑絕對不可混用。\n\n### 備用方案：日期 + 個資查詢\n若客戶無法說出商品名稱，可用「下單日期」+「Email/手機/姓名」查詢（日期範圍限 31 天）。\n\n### 最後防線：轉接專人\n只有在所有方案都無法取得資訊，或查詢結果為空時，才可詢問是否轉接真人客服。\n話術：「很抱歉目前沒有查到相符的紀錄，可能是下單時用了不同的聯絡方式～我幫您轉接專人客服處理唷！」\n\n### 回覆語氣規範\n- 語氣溫暖親切，像朋友般自然，適度使用「唷」「呢」「～」等語助詞。\n- 用「了解」「沒問題」「好的」開場，禁止「根據系統」「依照規則」「步驟一」等機械用語。\n- 適度使用 emoji（😊、✨）但不過度。回覆簡潔有力，不冗長囉嗦。\n\n### 嚴格保密規範\n- **絕對禁止**在對話中顯示任何內部編號、API 欄位、系統代碼、技術參數。\n- **絕對禁止**提及「對應表」「商品清單」「備用查詢」「Function Calling」等系統用語。\n- 所有回覆必須像專業真人客服，只使用客戶能理解的自然語言。`;

  const currentVersion = "訂單查詢決策樹（Strict Rules v4.3）";
  if (row.value.includes(currentVersion)) return;

  let newValue = row.value;
  const oldRulesPattern = /\n\n## 訂單查詢[^\n]*（Strict Rules[^\n]*）\n[\s\S]*?(?=\n\n## (?!訂單)|\n\n---|\s*$)/;
  if (oldRulesPattern.test(row.value)) {
    newValue = row.value.replace(oldRulesPattern, ORDER_RULES_V4);
    console.log("[DB] 已將訂單查詢規則升級至 v4.3（零驗證極速決策樹）");
  } else {
    newValue = row.value + ORDER_RULES_V4;
    console.log("[DB] 已自動附加「訂單查詢決策樹 v4.3」至系統提示詞");
  }
  db.prepare("UPDATE settings SET value = ? WHERE key = 'system_prompt'").run(newValue);
}

function migrateHardMuteAndAlerts() {
  const contactCols = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
  const colNames = contactCols.map(c => c.name);
  if (!colNames.includes("ai_muted_until")) {
    db.exec("ALTER TABLE contacts ADD COLUMN ai_muted_until TEXT");
  }
  if (!colNames.includes("consecutive_timeouts")) {
    db.exec("ALTER TABLE contacts ADD COLUMN consecutive_timeouts INTEGER NOT NULL DEFAULT 0");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS system_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      brand_id INTEGER,
      contact_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_system_alerts_type_date ON system_alerts(alert_type, created_at);`);

  db.exec(`DELETE FROM system_alerts WHERE created_at < datetime('now', '-30 days');`);

  console.log("[DB Migration] Hard Mute + System Alerts 表已就緒");
}

function seedMockData() {
  const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  if (userCount.count > 0) return;

  const insertUser = db.prepare("INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)");
  insertUser.run("admin", hashPassword("admin123"), "系統管理員", "super_admin");
  insertUser.run("marketing", hashPassword("mkt123"), "行銷經理 Amy", "marketing_manager");
  insertUser.run("agent", hashPassword("agent123"), "客服小李", "cs_agent");

  const defaultSettings = [
    ["openai_api_key", ""],
    ["line_channel_secret", ""],
    ["line_channel_access_token", ""],
    ["system_prompt", "你是一位熱情的品牌購物顧問。當客戶詢問產品時，必須提供『價格』與『購買連結』引導結帳。若客戶情緒憤怒或要求找真人，請安撫並轉接專人。\n\n## 訂單查詢決策樹（Strict Rules v4.3）\n\n### ⚠️ 核心鐵律：零驗證原則\n本系統查詢訂單**不需要任何身分驗證**。\n- **絕對禁止**要求客戶提供「手機末三碼」「完整電話」「Email」來核對身分。\n- **絕對禁止**說出「為了保護您的隱私」「為了確認是本人」「為了避免查到不同人的訂單」等驗證話術。\n- 只要客戶提供了訂單編號，就閉嘴直接去查。不問、不驗、不囉嗦。\n\n### 路徑 A：極速查詢（客戶有訂單編號）\n當客戶提供了訂單編號（如 KBT58265、DEN12345、MRQ00001、MRH99999 等格式）：\n→ **立即、直接**觸發訂單查詢，不追問任何額外資訊。\n→ 查到後回覆訂單狀態、物流進度等。\n→ 查無結果則告知客戶「這個編號目前查不到紀錄，請確認是否正確唷～」\n→ 流程結束。\n\n### 路徑 B：無單號救援（客戶沒有訂單編號）\n當客戶表示找不到單號、忘記了、沒收到確認信時：\n⚠️ 絕對不可以在此階段提議轉接真人客服！\n→ 親切詢問「商品名稱」和「手機號碼」兩項資訊。\n→ 話術：「沒關係唷～請告訴我您買的是什麼商品，再加上下單時留的手機號碼，我馬上幫您查！😊」\n→ 客戶說出商品後，從內部商品清單語意匹配（支持錯字、簡稱、俗稱）。\n→ 若匹配到多個商品，列出選項讓客戶確認（只顯示產品名稱）。\n→ 確認唯一商品 + 取得手機號碼後，觸發查詢。\n→ 流程結束。\n\n### 路徑 A 與路徑 B 互不干涉\n- 走路徑 A 時，不需要手機號碼、不需要商品名稱、不需要任何額外資訊。\n- 走路徑 B 時，不需要訂單編號。\n- 兩條路徑絕對不可混用。\n\n### 備用方案：日期 + 個資查詢\n若客戶無法說出商品名稱，可用「下單日期」+「Email/手機/姓名」查詢（日期範圍限 31 天）。\n\n### 最後防線：轉接專人\n只有在所有方案都無法取得資訊，或查詢結果為空時，才可詢問是否轉接真人客服。\n話術：「很抱歉目前沒有查到相符的紀錄，可能是下單時用了不同的聯絡方式～我幫您轉接專人客服處理唷！」\n\n## 售後服務 SOP 與退換貨防守機制（Strict Rules）\n\n### 一、缺貨與等待時間的溫柔安撫\n(系統規則) 當你從知識庫或 API 訂單中發現該商品處於「缺貨/預購/需等待較長時間」的狀態時，你的第一句話必須主動且溫柔地致歉。\n範例話術：「非常抱歉讓您久等了🥺 目前這款商品實在太熱銷，正在緊急為您趕工中...」\n請展現最高的同理心，讓客戶感受到你理解他們等待的焦慮。\n\n### 二、退換貨三階段防守 SOP（⚠️ 極度重要）\n當客戶提到「退貨」「退款」「換貨」「不想等了」「不要了」「取消」等關鍵字時，請嚴格遵守以下三階段對話流程。\n⚠️ 絕對不可第一時間就答應退貨！必須依序走完三階段。\n\n#### 第一階段：安撫與探詢（Empathize & Probe）\n先道歉並詢問原因，展現同理心。\n話術範例：\n- 「真的很抱歉讓您有不好的體驗 🥺 請問是商品哪裡不符合您的期待，或是使用上遇到什麼困難嗎？」\n- 「非常抱歉聽到這個消息😢 能不能跟我說說看是什麼原因讓您想退呢？我想看看有沒有什麼能幫到您的～」\n目的：了解真正原因，為第二階段做準備。\n\n#### 第二階段：挽回與鼓勵體驗（Retain & Encourage）\n根據客戶抱怨的理由，嘗試提供解法或鼓勵多試用：\n- （保養/清潔品）「這款商品通常需要一點時間才能發揮最大效果唷～很多客人初期也有類似感覺，建議您再多試用幾次看看效果！」\n- （蛋糕/甜點/食品）「若是口味不太習慣，真的很抱歉🙏 我們會將您的寶貴意見反映給主廚！」\n- （功能/品質問題）「這個情況確實不應該發生，非常抱歉！請問方便拍張照片讓我看看嗎？」\n- （等太久/缺貨）「非常抱歉讓您等這麼久🥺 目前工廠正在全力趕製中，再請您稍微等等～」\n\n#### 第三階段：提供表單並轉交真人（Provide Form & Handoff）\n⚠️ 只有在客戶「堅持退換貨」時才進入此階段。\n此時不再挽留，立刻：\n1. 提供退換貨表單連結\n2. 自動呼叫 transfer_to_human 工具（reason: 「退換貨申請 - 客戶堅持退貨」）\n話術範例：「好的，我了解了！非常抱歉這次沒能讓您滿意🙏 為了保障您的權益，麻煩您幫我填寫這份退換貨表單。填妥後，我已經幫您標記為🔴急件處理，稍後將有專屬客服為您接手後續流程，請您稍等！」\n\n### 三、自動觸發轉接機制\n當 AI 執行到退換貨 SOP 第三階段時，必須在回覆的同時自動呼叫 transfer_to_human 工具，reason 填寫「退換貨申請 - 客戶堅持退貨」。\n\n### 回覆語氣規範\n- 語氣溫暖親切，像朋友般自然，適度使用「唷」「呢」「～」等語助詞。\n- 用「了解」「沒問題」「好的」開場，禁止「根據系統」「依照規則」「步驟一」等機械用語。\n- 適度使用 emoji（😊、✨、🥺、🙏）但不過度。回覆簡潔有力，不冗長囉嗦。\n- 絕對不可以在對話中提及「SOP」「三階段」「防守」「挽回」等內部用語。\n\n### 嚴格保密規範\n- **絕對禁止**在對話中顯示任何內部編號、API 欄位、系統代碼、技術參數。\n- **絕對禁止**提及「對應表」「商品清單」「備用查詢」「Function Calling」等系統用語。\n- 所有回覆必須像專業真人客服，只使用客戶能理解的自然語言。"],
    ["test_mode", "true"],
    ["system_name", "AI 客服中控台"],
    ["logo_url", ""],
    ["welcome_message", "哈囉！歡迎來到我們的官方帳號\n有任何問題都可以直接詢問我，我會盡快為您服務！"],
    ["quick_buttons", "最新優惠,查詢訂單,專人服務"],
    ["human_transfer_keywords", "真人客服,轉人工,找主管,不要機器人,人工客服,真人處理"],
    ["superlanding_merchant_no", ""],
    ["superlanding_access_key", ""],
  ];
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of defaultSettings) {
    insertSetting.run(key, value);
  }

  const insertContact = db.prepare(
    "INSERT INTO contacts (platform, platform_user_id, display_name, avatar_url, needs_human, is_pinned, status, tags, vip_level, order_count, total_spent, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages (contact_id, platform, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?)"
  );

  const contacts = [
    { platform: "line", pid: "U1a2b3c4d5e6f7", name: "陳小明", nh: 0, pin: 1, status: "resolved", tags: '["VIP"]', vip: 2, oc: 12, ts: 38600, lma: "2026-03-01T14:30:00", ca: "2026-02-28T09:00:00" },
    { platform: "line", pid: "U2b3c4d5e6f7a8", name: "林美玲", nh: 1, pin: 0, status: "processing", tags: '["客訴","重要"]', vip: 0, oc: 2, ts: 3200, lma: "2026-03-01T14:45:00", ca: "2026-02-27T11:30:00" },
    { platform: "line", pid: "U3c4d5e6f7a8b9", name: "王大維", nh: 0, pin: 0, status: "pending", tags: '[]', vip: 0, oc: 0, ts: 0, lma: "2026-03-01T13:15:00", ca: "2026-02-26T15:20:00" },
    { platform: "line", pid: "U4d5e6f7a8b9c0", name: "張雅婷", nh: 0, pin: 1, status: "resolved", tags: '["VIP","回購客戶"]', vip: 3, oc: 28, ts: 125000, lma: "2026-03-01T10:00:00", ca: "2026-02-25T08:45:00" },
    { platform: "line", pid: "U5e6f7a8b9c0d1", name: "李志豪", nh: 1, pin: 0, status: "pending", tags: '["新客戶"]', vip: 0, oc: 1, ts: 990, lma: "2026-03-01T15:10:00", ca: "2026-03-01T14:50:00" },
  ];

  for (const c of contacts) {
    insertContact.run(c.platform, c.pid, c.name, null, c.nh, c.pin, c.status, c.tags, c.vip, c.oc, c.ts, c.lma, c.ca);
  }

  const allMessages = [
    { cid: 1, p: "line", st: "user", c: "你好，我想查詢一下我的訂單狀態", ca: "2026-03-01T14:00:00" },
    { cid: 1, p: "line", st: "ai", c: "您好！感謝您的來訊。請提供您的訂單編號（通常為 KBT 開頭），我將為您查詢訂單狀態。", ca: "2026-03-01T14:00:05" },
    { cid: 1, p: "line", st: "user", c: "訂單編號是 ORD-20260228-001", ca: "2026-03-01T14:10:00" },
    { cid: 1, p: "line", st: "ai", c: "查詢到您的訂單 ORD-20260228-001，目前狀態為「處理中」，預計明天出貨。", ca: "2026-03-01T14:10:05" },
    { cid: 1, p: "line", st: "user", c: "好的，謝謝你", ca: "2026-03-01T14:30:00" },
    { cid: 1, p: "line", st: "ai", c: "不客氣！如有任何問題歡迎隨時詢問，祝您有美好的一天！", ca: "2026-03-01T14:30:05" },
    { cid: 2, p: "line", st: "user", c: "請問這個商品還有貨嗎？", ca: "2026-03-01T14:20:00" },
    { cid: 2, p: "line", st: "ai", c: "您好！請問您想詢問的是哪一款商品呢？", ca: "2026-03-01T14:20:05" },
    { cid: 2, p: "line", st: "user", c: "就是你們官網首頁那個限量款包包", ca: "2026-03-01T14:25:00" },
    { cid: 2, p: "line", st: "user", c: "我要找客服", ca: "2026-03-01T14:35:00" },
    { cid: 2, p: "line", st: "ai", c: "好的，我已為您轉接真人客服，請稍候片刻。", ca: "2026-03-01T14:35:05" },
    { cid: 2, p: "line", st: "admin", c: "您好，我是客服專員小李。關於限量款包包，目前還有少量庫存，請問您需要哪個顏色？", ca: "2026-03-01T14:45:00" },
    { cid: 3, p: "line", st: "user", c: "我想退貨，怎麼辦理？", ca: "2026-03-01T12:00:00" },
    { cid: 3, p: "line", st: "ai", c: "您好！退貨流程如下：\n1. 確認商品在7天鑑賞期內\n2. 商品保持完整未使用\n3. 至會員中心申請退貨", ca: "2026-03-01T12:00:05" },
    { cid: 3, p: "line", st: "user", c: "前天買的，還沒拆封", ca: "2026-03-01T12:30:00" },
    { cid: 3, p: "line", st: "ai", c: "了解，您的商品在鑑賞期內且未拆封，符合退貨條件。請至會員中心申請退貨。", ca: "2026-03-01T12:30:05" },
    { cid: 3, p: "line", st: "user", c: "好的我去試試看，謝謝", ca: "2026-03-01T13:15:00" },
    { cid: 4, p: "line", st: "user", c: "你們營業時間是幾點到幾點？", ca: "2026-03-01T09:30:00" },
    { cid: 4, p: "line", st: "ai", c: "您好！我們的營業時間為：\n週一至週五 09:00 - 18:00\n週六 10:00 - 16:00\n週日及國定假日公休", ca: "2026-03-01T09:30:05" },
    { cid: 4, p: "line", st: "user", c: "門市地址在哪裡？", ca: "2026-03-01T10:00:00" },
    { cid: 4, p: "line", st: "ai", c: "我們的門市地址為：台北市信義區松仁路100號1樓", ca: "2026-03-01T10:00:05" },
    { cid: 5, p: "line", st: "user", c: "我剛下了一筆訂單，但地址填錯了，可以幫我修改嗎？", ca: "2026-03-01T14:50:00" },
    { cid: 5, p: "line", st: "ai", c: "您好！關於修改訂單地址，請提供您的訂單編號。", ca: "2026-03-01T14:50:05" },
    { cid: 5, p: "line", st: "user", c: "ORD-20260301-005，拜託幫我改一下，很急！找真人幫我", ca: "2026-03-01T15:00:00" },
    { cid: 5, p: "line", st: "ai", c: "了解您的急迫性，我已為您轉接真人客服。", ca: "2026-03-01T15:00:05" },
    { cid: 5, p: "line", st: "user", c: "謝謝，麻煩快一點", ca: "2026-03-01T15:10:00" },
  ];

  for (const m of allMessages) {
    insertMessage.run(m.cid, m.p, m.st, m.c, m.ca);
  }

  const insertRule = db.prepare("INSERT INTO marketing_rules (keyword, pitch, url) VALUES (?, ?, ?)");
  insertRule.run("限量包包", "這款限量設計師聯名包包，採用頂級義大利小牛皮，現在下單享 85 折優惠！原價 $12,800，限時特價 $10,880", "https://shop.example.com/bag-001");
  insertRule.run("保養品", "我們的明星商品「極光煥膚精華液」30ml，含玻尿酸+維他命C，現在買一送一只要 $1,680！超過 5,000 則五星好評", "https://shop.example.com/serum-002");
  insertRule.run("會員方案", "加入 VIP 會員即享全站 9 折 + 免運費 + 生日禮金 $500！年費只要 $299，立即升級享受尊榮服務", "https://shop.example.com/vip-membership");
}

export default db;
