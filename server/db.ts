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
      last_message_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      platform TEXT NOT NULL DEFAULT 'line',
      sender_type TEXT NOT NULL CHECK(sender_type IN ('user','ai','admin','system')),
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

    CREATE TABLE IF NOT EXISTS marketing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      pitch TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  seedMockData();
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
    ["system_prompt", "你是一位熱情的品牌購物顧問。當客戶詢問產品時，必須提供『價格』與『購買連結』引導結帳。若客戶情緒憤怒或要求找真人，請安撫並轉接專人。"],
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
    { cid: 1, p: "line", st: "ai", c: "您好！感謝您的來訊。請提供您的訂單編號或手機號碼，我將為您查詢訂單狀態。", ca: "2026-03-01T14:00:05" },
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
