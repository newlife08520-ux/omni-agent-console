import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";

const dbPath = path.resolve(process.cwd(), "omnichannel.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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

  migrateBrandsAndChannels();
  migrateSystemPrompt();
  seedMockData();
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
    ["human_transfer_keywords", "真人,客服,投訴,生氣,退貨,爛"],
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
