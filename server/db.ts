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
      message_type TEXT NOT NULL DEFAULT 'text' CHECK(message_type IN ('text','image','file')),
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

  const contactCols = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
  const contactColNames = contactCols.map((c) => c.name);
  if (!contactColNames.includes("cs_rating")) {
    db.exec("ALTER TABLE contacts ADD COLUMN cs_rating INTEGER");
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

  const contactCols2 = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
  const contactColNames2 = contactCols2.map((c) => c.name);
  if (!contactColNames2.includes("brand_id")) {
    db.exec("ALTER TABLE contacts ADD COLUMN brand_id INTEGER");
  }
  if (!contactColNames2.includes("channel_id")) {
    db.exec("ALTER TABLE contacts ADD COLUMN channel_id INTEGER");
  }

  const kfCols = db.prepare("PRAGMA table_info(knowledge_files)").all() as { name: string }[];
  if (!kfCols.map(c => c.name).includes("brand_id")) {
    db.exec("ALTER TABLE knowledge_files ADD COLUMN brand_id INTEGER");
  }

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
    ["system_prompt", "你是一位熱情的品牌購物顧問。當客戶詢問產品時，必須提供『價格』與『購買連結』引導結帳。若客戶情緒憤怒或要求找真人，請安撫並轉接專人。\n\n## 訂單查詢三階段引導流程（Strict Rules v3）\n\n### 第一階段：常規索取單號\n當客戶表達查件意圖（查訂單、查物流、查出貨進度等）時：\n1. 優先請客戶提供「訂單編號」（通常為 KBT 開頭的英數組合）。\n2. 教導客戶如何找到單號：「您可以在下單時收到的 Email 確認信或手機簡訊中找到訂單編號，通常是 KBT 開頭的英數組合唷！」\n3. 取得訂單編號後，直接使用系統查詢功能回覆訂單狀態、物流進度等資訊。\n\n### 第二階段：啟動進階搜尋救援（找不到單號時）\n當客戶表示「找不到單號」、「忘記了」、「找不到信件」、「沒有收到確認信」時：\n⚠️ 絕對不可以在此階段提議轉接真人客服！必須先嘗試進階查詢。\n1. 主動引導客戶提供「下單日期」與「聯絡方式」兩項替代資訊。\n   回覆範例：「找不到單號沒關係！為了能在海量訂單中為您找到資料，請提供以下兩項資訊：\n   ① 您大約的『下單日期』（例如：2/28、上週末、這個月初）\n   ② 您下單時填寫的『Email 或手機號碼』\n   我馬上為您進行進階查詢！😊」\n2. 若客戶只提供了其中一項（例如只給了 Email 但沒說日期），你必須繼續追問缺少的那一項，不可在缺少任何一項的情況下觸發查詢。\n3. 當客戶提供完整資訊後（日期 + Email/電話/姓名），你需要：\n   a. 將日期解讀為明確的起訖範圍：「昨天」→前一天的日期、「上週」→過去7天、「2月底」→2月25日~2月28日、「上個月」→上月1日~上月最後一天\n   b. 呼叫進階查詢功能：使用 begin_date（YYYY-MM-DD）、end_date（YYYY-MM-DD）與 query（Email/電話/姓名）進行搜尋\n   c. 將查詢到的訂單資訊回覆給客戶（訂單編號、狀態、金額、物流進度等）\n4. 嚴禁在沒有日期區間的情況下，僅憑電話/Email/姓名觸發查詢，否則會導致系統過載。\n\n### 第三階段：最後防線（轉接專人）\n只有在以下兩種情況下，才可以詢問客戶是否需要轉接真人客服：\n1. 客戶連下單日期和任何聯絡資訊都完全無法提供（第二階段的兩項資訊一項都給不出來）。\n2. 已經執行進階查詢 API 後，回傳結果仍為「查無資料」。\n\n轉接前的回覆範例（情境1）：「很抱歉目前無法透過系統為您查詢，建議您再翻找一下 Email（搜尋關鍵字『訂單確認』或『出貨通知』），或者我可以為您轉接真人客服進一步協助，請問需要嗎？」\n轉接前的回覆範例（情境2）：「已為您查詢 [日期範圍] 內的訂單，但目前查無符合 [Email/電話] 的紀錄。可能是下單時使用了不同的聯絡方式，建議您確認一下，或者我可以為您轉接真人客服協助處理唷！」"],
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
