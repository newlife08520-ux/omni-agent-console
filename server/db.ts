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
      role TEXT NOT NULL DEFAULT 'agent' CHECK(role IN ('admin','agent')),
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
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','resolved')),
      tags TEXT NOT NULL DEFAULT '[]',
      last_message_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      platform TEXT NOT NULL DEFAULT 'line',
      sender_type TEXT NOT NULL CHECK(sender_type IN ('user','ai','admin')),
      content TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent' CHECK(role IN ('super_admin','agent')),
      avatar_url TEXT,
      status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  seedMockData();
}

function seedMockData() {
  const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  if (userCount.count > 0) return;

  const insertUser = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)");
  insertUser.run("admin", hashPassword("admin123"), "admin");
  insertUser.run("agent", hashPassword("agent123"), "agent");

  const defaultSettings = [
    ["openai_api_key", ""],
    ["line_channel_secret", ""],
    ["line_channel_access_token", ""],
    ["system_prompt", "你是一位專業且友善的客服助理。請用繁體中文回答用戶的問題，保持禮貌和耐心。如果遇到無法解答的問題，請建議用戶聯繫真人客服。"],
    ["test_mode", "true"],
  ];
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of defaultSettings) {
    insertSetting.run(key, value);
  }

  const insertContact = db.prepare(
    "INSERT INTO contacts (platform, platform_user_id, display_name, avatar_url, needs_human, status, tags, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages (contact_id, platform, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?)"
  );

  const contacts = [
    { platform: "line", platform_user_id: "U1a2b3c4d5e6f7", display_name: "陳小明", avatar_url: null, needs_human: 0, status: "resolved", tags: '["VIP"]', last_message_at: "2026-03-01T14:30:00", created_at: "2026-02-28T09:00:00" },
    { platform: "line", platform_user_id: "U2b3c4d5e6f7a8", display_name: "林美玲", avatar_url: null, needs_human: 1, status: "processing", tags: '["客訴","重要"]', last_message_at: "2026-03-01T14:45:00", created_at: "2026-02-27T11:30:00" },
    { platform: "line", platform_user_id: "U3c4d5e6f7a8b9", display_name: "王大維", avatar_url: null, needs_human: 0, status: "pending", tags: '[]', last_message_at: "2026-03-01T13:15:00", created_at: "2026-02-26T15:20:00" },
    { platform: "line", platform_user_id: "U4d5e6f7a8b9c0", display_name: "張雅婷", avatar_url: null, needs_human: 0, status: "resolved", tags: '["VIP","回購客戶"]', last_message_at: "2026-03-01T10:00:00", created_at: "2026-02-25T08:45:00" },
    { platform: "line", platform_user_id: "U5e6f7a8b9c0d1", display_name: "李志豪", avatar_url: null, needs_human: 1, status: "pending", tags: '["新客戶"]', last_message_at: "2026-03-01T15:10:00", created_at: "2026-03-01T14:50:00" },
  ];

  for (const c of contacts) {
    insertContact.run(c.platform, c.platform_user_id, c.display_name, c.avatar_url, c.needs_human, c.status, c.tags, c.last_message_at, c.created_at);
  }

  const allMessages = [
    { contact_id: 1, platform: "line", sender_type: "user", content: "你好，我想查詢一下我的訂單狀態", created_at: "2026-03-01T14:00:00" },
    { contact_id: 1, platform: "line", sender_type: "ai", content: "您好！感謝您的來訊。請提供您的訂單編號或手機號碼，我將為您查詢訂單狀態。", created_at: "2026-03-01T14:00:05" },
    { contact_id: 1, platform: "line", sender_type: "user", content: "訂單編號是 ORD-20260228-001", created_at: "2026-03-01T14:10:00" },
    { contact_id: 1, platform: "line", sender_type: "ai", content: "查詢到您的訂單 ORD-20260228-001，目前狀態為「處理中」，預計明天出貨。請問還有其他需要協助的嗎？", created_at: "2026-03-01T14:10:05" },
    { contact_id: 1, platform: "line", sender_type: "user", content: "好的，謝謝你", created_at: "2026-03-01T14:30:00" },
    { contact_id: 1, platform: "line", sender_type: "ai", content: "不客氣！如有任何問題歡迎隨時詢問，祝您有美好的一天！", created_at: "2026-03-01T14:30:05" },
    { contact_id: 2, platform: "line", sender_type: "user", content: "請問這個商品還有貨嗎？", created_at: "2026-03-01T14:20:00" },
    { contact_id: 2, platform: "line", sender_type: "ai", content: "您好！請問您想詢問的是哪一款商品呢？可以提供商品名稱或編號嗎？", created_at: "2026-03-01T14:20:05" },
    { contact_id: 2, platform: "line", sender_type: "user", content: "就是你們官網首頁那個限量款包包", created_at: "2026-03-01T14:25:00" },
    { contact_id: 2, platform: "line", sender_type: "ai", content: "感謝您的詢問！讓我為您確認庫存狀況，請稍候。", created_at: "2026-03-01T14:25:05" },
    { contact_id: 2, platform: "line", sender_type: "user", content: "我要找客服", created_at: "2026-03-01T14:35:00" },
    { contact_id: 2, platform: "line", sender_type: "ai", content: "好的，我已為您轉接真人客服，請稍候片刻，客服人員將盡快為您服務。", created_at: "2026-03-01T14:35:05" },
    { contact_id: 2, platform: "line", sender_type: "admin", content: "您好，我是客服專員小李。關於限量款包包，目前還有少量庫存，請問您需要哪個顏色？", created_at: "2026-03-01T14:45:00" },
    { contact_id: 3, platform: "line", sender_type: "user", content: "我想退貨，怎麼辦理？", created_at: "2026-03-01T12:00:00" },
    { contact_id: 3, platform: "line", sender_type: "ai", content: "您好！退貨流程如下：\n1. 確認商品在7天鑑賞期內\n2. 商品保持完整未使用\n3. 至會員中心申請退貨\n\n請問您的訂單是什麼時候下的呢？", created_at: "2026-03-01T12:00:05" },
    { contact_id: 3, platform: "line", sender_type: "user", content: "前天買的，還沒拆封", created_at: "2026-03-01T12:30:00" },
    { contact_id: 3, platform: "line", sender_type: "ai", content: "了解，您的商品在鑑賞期內且未拆封，符合退貨條件。請至會員中心 > 訂單管理 > 選擇該筆訂單 > 申請退貨。", created_at: "2026-03-01T12:30:05" },
    { contact_id: 3, platform: "line", sender_type: "user", content: "好的我去試試看，謝謝", created_at: "2026-03-01T13:15:00" },
    { contact_id: 4, platform: "line", sender_type: "user", content: "你們營業時間是幾點到幾點？", created_at: "2026-03-01T09:30:00" },
    { contact_id: 4, platform: "line", sender_type: "ai", content: "您好！我們的營業時間為：\n週一至週五 09:00 - 18:00\n週六 10:00 - 16:00\n週日及國定假日公休", created_at: "2026-03-01T09:30:05" },
    { contact_id: 4, platform: "line", sender_type: "user", content: "門市地址在哪裡？", created_at: "2026-03-01T10:00:00" },
    { contact_id: 4, platform: "line", sender_type: "ai", content: "我們的門市地址為：\n台北市信義區松仁路100號1樓\n\n交通方式：捷運市政府站2號出口步行約5分鐘即可到達。歡迎蒞臨！", created_at: "2026-03-01T10:00:05" },
    { contact_id: 5, platform: "line", sender_type: "user", content: "我剛下了一筆訂單，但地址填錯了，可以幫我修改嗎？", created_at: "2026-03-01T14:50:00" },
    { contact_id: 5, platform: "line", sender_type: "ai", content: "您好！關於修改訂單地址，請提供您的訂單編號，我先為您查詢是否還能修改。", created_at: "2026-03-01T14:50:05" },
    { contact_id: 5, platform: "line", sender_type: "user", content: "ORD-20260301-005，拜託幫我改一下，很急！找真人幫我", created_at: "2026-03-01T15:00:00" },
    { contact_id: 5, platform: "line", sender_type: "ai", content: "了解您的急迫性，我已為您轉接真人客服，客服人員將儘速為您處理訂單地址修改。", created_at: "2026-03-01T15:00:05" },
    { contact_id: 5, platform: "line", sender_type: "user", content: "謝謝，麻煩快一點", created_at: "2026-03-01T15:10:00" },
  ];

  for (const m of allMessages) {
    insertMessage.run(m.contact_id, m.platform, m.sender_type, m.content, m.created_at);
  }

  const insertTeam = db.prepare("INSERT INTO team_members (name, email, role, avatar_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const teamMembers = [
    { name: "陳建宏", email: "chen@company.com", role: "super_admin", avatar_url: null, status: "online", created_at: "2026-01-01T00:00:00" },
    { name: "李佳穎", email: "lee@company.com", role: "agent", avatar_url: null, status: "online", created_at: "2026-01-15T00:00:00" },
    { name: "黃志明", email: "huang@company.com", role: "agent", avatar_url: null, status: "offline", created_at: "2026-02-01T00:00:00" },
    { name: "吳美華", email: "wu@company.com", role: "agent", avatar_url: null, status: "online", created_at: "2026-02-10T00:00:00" },
    { name: "鄭凱文", email: "zheng@company.com", role: "super_admin", avatar_url: null, status: "offline", created_at: "2026-02-20T00:00:00" },
  ];
  for (const t of teamMembers) {
    insertTeam.run(t.name, t.email, t.role, t.avatar_url, t.status, t.created_at);
  }
}

export default db;
