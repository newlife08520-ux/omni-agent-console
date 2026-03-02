const Database = require("better-sqlite3");
const db = new Database("./omnichannel.db");

const now = new Date().toISOString().replace("T", " ").substring(0, 19);

// Insert test contact with needs_human = 1
const insertContact = db.prepare(`
  INSERT INTO contacts (platform, platform_user_id, display_name, needs_human, is_pinned, status, tags, vip_level, order_count, total_spent, last_message_at, created_at)
  VALUES ('line', 'test_handoff_user_001', '測試轉接用戶', 1, 0, 'pending', '[]', 0, 0, 0, ?, ?)
`);
const result = insertContact.run(now, now);
const contactId = result.lastInsertRowid;
console.log(`Created contact id: ${contactId}`);

// Insert system message
const insertMsg = db.prepare(`
  INSERT INTO messages (contact_id, platform, sender_type, content, message_type, created_at)
  VALUES (?, 'line', 'system', '(系統提示) AI 已靜默轉接真人客服。轉接原因：多次查詢仍查不到訂單', 'text', ?)
`);
insertMsg.run(contactId, now);
console.log("Inserted system message.");

// Insert a user message so there's chat history
const insertUserMsg = db.prepare(`
  INSERT INTO messages (contact_id, platform, sender_type, content, message_type, created_at)
  VALUES (?, 'line', 'user', '你好，我想查一下我的訂單進度', 'text', ?)
`);
insertUserMsg.run(contactId, now);
console.log("Inserted user message.");

console.log("Done! Test contact '測試轉接用戶' created with needs_human=1.");
db.close();
