import db, { initDatabase, hashPassword } from "./db";
import type { User, Contact, ContactWithPreview, Message, Setting, KnowledgeFile, TeamMember, MarketingRule } from "@shared/schema";

initDatabase();

export interface IStorage {
  authenticateUser(username: string, password: string): User | null;
  getUserById(id: number): User | undefined;
  createUser(username: string, password: string, displayName: string, role: string): User;
  updateUser(id: number, displayName: string, role: string, password?: string): boolean;
  deleteUser(id: number): boolean;
  getTeamMembers(): TeamMember[];
  getSetting(key: string): string | null;
  getAllSettings(): Setting[];
  setSetting(key: string, value: string): void;
  getContacts(): ContactWithPreview[];
  getContact(id: number): Contact | undefined;
  updateContactHumanFlag(id: number, needsHuman: number): void;
  updateContactStatus(id: number, status: string): void;
  updateContactTags(id: number, tags: string[]): void;
  updateContactPinned(id: number, isPinned: number): void;
  updateContactVipData(id: number, vipLevel: number, orderCount: number, totalSpent: number): void;
  updateContactRating(id: number, rating: number): void;
  getContactByPlatformUser(platform: string, platformUserId: string): Contact | undefined;
  isEventProcessed(eventId: string): boolean;
  markEventProcessed(eventId: string): void;
  getMessages(contactId: number): Message[];
  getMessagesSince(contactId: number, sinceId: number): Message[];
  searchMessages(query: string): { contact_id: number; contact_name: string; message_id: number; content: string; sender_type: string; created_at: string }[];
  createMessage(contactId: number, platform: string, senderType: string, content: string, messageType?: string, imageUrl?: string | null): Message;
  getOrCreateContact(platform: string, platformUserId: string, displayName: string): Contact;
  getKnowledgeFiles(): KnowledgeFile[];
  createKnowledgeFile(filename: string, originalName: string, size: number): KnowledgeFile;
  deleteKnowledgeFile(id: number): boolean;
  getMarketingRules(): MarketingRule[];
  createMarketingRule(keyword: string, pitch: string, url: string): MarketingRule;
  updateMarketingRule(id: number, keyword: string, pitch: string, url: string): boolean;
  deleteMarketingRule(id: number): boolean;
}

export class SQLiteStorage implements IStorage {
  authenticateUser(username: string, password: string): User | null {
    const hash = hashPassword(password);
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND password_hash = ?").get(username, hash) as User | undefined;
    return user || null;
  }

  getUserById(id: number): User | undefined {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
  }

  createUser(username: string, password: string, displayName: string, role: string): User {
    const hash = hashPassword(password);
    const result = db.prepare("INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)").run(username, hash, displayName, role);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(Number(result.lastInsertRowid)) as User;
  }

  updateUser(id: number, displayName: string, role: string, password?: string): boolean {
    if (password && password.trim()) {
      const hash = hashPassword(password);
      const result = db.prepare("UPDATE users SET display_name = ?, role = ?, password_hash = ? WHERE id = ?").run(displayName, role, hash, id);
      return result.changes > 0;
    }
    const result = db.prepare("UPDATE users SET display_name = ?, role = ? WHERE id = ?").run(displayName, role, id);
    return result.changes > 0;
  }

  deleteUser(id: number): boolean {
    const result = db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getTeamMembers(): TeamMember[] {
    return db.prepare("SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at ASC").all() as TeamMember[];
  }

  getSetting(key: string): string | null {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  getAllSettings(): Setting[] {
    return db.prepare("SELECT key, value FROM settings").all() as Setting[];
  }

  setSetting(key: string, value: string): void {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  getContacts(): ContactWithPreview[] {
    const contacts = db.prepare("SELECT * FROM contacts ORDER BY is_pinned DESC, last_message_at DESC").all() as Contact[];
    return contacts.map((c) => {
      const lastMsg = db.prepare("SELECT content FROM messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1").get(c.id) as { content: string } | undefined;
      return { ...c, last_message: lastMsg?.content || "" };
    });
  }

  getContact(id: number): Contact | undefined {
    return db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Contact | undefined;
  }

  updateContactHumanFlag(id: number, needsHuman: number): void {
    db.prepare("UPDATE contacts SET needs_human = ? WHERE id = ?").run(needsHuman, id);
  }

  updateContactStatus(id: number, status: string): void {
    db.prepare("UPDATE contacts SET status = ? WHERE id = ?").run(status, id);
  }

  updateContactTags(id: number, tags: string[]): void {
    db.prepare("UPDATE contacts SET tags = ? WHERE id = ?").run(JSON.stringify(tags), id);
  }

  updateContactPinned(id: number, isPinned: number): void {
    db.prepare("UPDATE contacts SET is_pinned = ? WHERE id = ?").run(isPinned, id);
  }

  updateContactVipData(id: number, vipLevel: number, orderCount: number, totalSpent: number): void {
    db.prepare("UPDATE contacts SET vip_level = ?, order_count = ?, total_spent = ? WHERE id = ?").run(vipLevel, orderCount, totalSpent, id);
  }

  updateContactRating(id: number, rating: number): void {
    db.prepare("UPDATE contacts SET cs_rating = ? WHERE id = ?").run(rating, id);
  }

  getContactByPlatformUser(platform: string, platformUserId: string): Contact | undefined {
    return db.prepare("SELECT * FROM contacts WHERE platform = ? AND platform_user_id = ?").get(platform, platformUserId) as Contact | undefined;
  }

  isEventProcessed(eventId: string): boolean {
    const row = db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").get(eventId);
    return !!row;
  }

  markEventProcessed(eventId: string): void {
    db.prepare("INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)").run(eventId);
  }

  getMessages(contactId: number): Message[] {
    return db.prepare("SELECT * FROM messages WHERE contact_id = ? ORDER BY id ASC").all(contactId) as Message[];
  }

  getMessagesSince(contactId: number, sinceId: number): Message[] {
    return db.prepare("SELECT * FROM messages WHERE contact_id = ? AND id > ? ORDER BY id ASC").all(contactId, sinceId) as Message[];
  }

  searchMessages(query: string): { contact_id: number; contact_name: string; message_id: number; content: string; sender_type: string; created_at: string }[] {
    const pattern = `%${query}%`;
    return db.prepare(`
      SELECT m.id as message_id, m.contact_id, m.content, m.sender_type, m.created_at,
             c.display_name as contact_name
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.content LIKE ? AND m.sender_type != 'system'
      ORDER BY m.created_at DESC
      LIMIT 50
    `).all(pattern) as any[];
  }

  createMessage(contactId: number, platform: string, senderType: string, content: string, messageType: string = "text", imageUrl: string | null = null): Message {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare("INSERT INTO messages (contact_id, platform, sender_type, content, message_type, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(contactId, platform, senderType, content, messageType, imageUrl, now);
    db.prepare("UPDATE contacts SET last_message_at = ? WHERE id = ?").run(now, contactId);
    return { id: Number(result.lastInsertRowid), contact_id: contactId, platform, sender_type: senderType as any, content, message_type: messageType as any, image_url: imageUrl, created_at: now };
  }

  getOrCreateContact(platform: string, platformUserId: string, displayName: string): Contact {
    let contact = db.prepare("SELECT * FROM contacts WHERE platform = ? AND platform_user_id = ?").get(platform, platformUserId) as Contact | undefined;
    if (!contact) {
      const now = new Date().toISOString().replace("T", " ").substring(0, 19);
      const result = db.prepare("INSERT INTO contacts (platform, platform_user_id, display_name, needs_human, is_pinned, status, tags, vip_level, order_count, total_spent, created_at) VALUES (?, ?, ?, 0, 0, 'pending', '[]', 0, 0, 0, ?)").run(platform, platformUserId, displayName, now);
      contact = { id: Number(result.lastInsertRowid), platform, platform_user_id: platformUserId, display_name: displayName, avatar_url: null, needs_human: 0, is_pinned: 0, status: "pending", tags: "[]", vip_level: 0, order_count: 0, total_spent: 0, cs_rating: null, last_message_at: null, created_at: now };
    }
    return contact;
  }

  getKnowledgeFiles(): KnowledgeFile[] {
    return db.prepare("SELECT * FROM knowledge_files ORDER BY created_at DESC").all() as KnowledgeFile[];
  }

  createKnowledgeFile(filename: string, originalName: string, size: number): KnowledgeFile {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare("INSERT INTO knowledge_files (filename, original_name, size, created_at) VALUES (?, ?, ?, ?)").run(filename, originalName, size, now);
    return { id: Number(result.lastInsertRowid), filename, original_name: originalName, size, created_at: now };
  }

  deleteKnowledgeFile(id: number): boolean {
    const result = db.prepare("DELETE FROM knowledge_files WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getMarketingRules(): MarketingRule[] {
    return db.prepare("SELECT * FROM marketing_rules ORDER BY created_at DESC").all() as MarketingRule[];
  }

  createMarketingRule(keyword: string, pitch: string, url: string): MarketingRule {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare("INSERT INTO marketing_rules (keyword, pitch, url, created_at) VALUES (?, ?, ?, ?)").run(keyword, pitch, url, now);
    return { id: Number(result.lastInsertRowid), keyword, pitch, url, created_at: now };
  }

  updateMarketingRule(id: number, keyword: string, pitch: string, url: string): boolean {
    const result = db.prepare("UPDATE marketing_rules SET keyword = ?, pitch = ?, url = ? WHERE id = ?").run(keyword, pitch, url, id);
    return result.changes > 0;
  }

  deleteMarketingRule(id: number): boolean {
    const result = db.prepare("DELETE FROM marketing_rules WHERE id = ?").run(id);
    return result.changes > 0;
  }
}

export const storage = new SQLiteStorage();
