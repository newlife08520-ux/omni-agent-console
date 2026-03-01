import db, { initDatabase } from "./db";
import type { Contact, ContactWithPreview, Message, Setting, KnowledgeFile, TeamMember } from "@shared/schema";

initDatabase();

export interface IStorage {
  login(password: string): boolean;
  getSetting(key: string): string | null;
  getAllSettings(): Setting[];
  setSetting(key: string, value: string): void;
  getContacts(): ContactWithPreview[];
  getContact(id: number): Contact | undefined;
  updateContactHumanFlag(id: number, needsHuman: number): void;
  updateContactStatus(id: number, status: string): void;
  updateContactTags(id: number, tags: string[]): void;
  getMessages(contactId: number): Message[];
  getMessagesSince(contactId: number, sinceId: number): Message[];
  createMessage(contactId: number, platform: string, senderType: string, content: string): Message;
  getOrCreateContact(platform: string, platformUserId: string, displayName: string): Contact;
  getKnowledgeFiles(): KnowledgeFile[];
  createKnowledgeFile(filename: string, originalName: string, size: number): KnowledgeFile;
  deleteKnowledgeFile(id: number): boolean;
  getTeamMembers(): TeamMember[];
}

export class SQLiteStorage implements IStorage {
  login(password: string): boolean {
    const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
    return password === adminPassword;
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
    const contacts = db.prepare("SELECT * FROM contacts ORDER BY last_message_at DESC").all() as Contact[];
    return contacts.map((c) => {
      const lastMsg = db.prepare(
        "SELECT content FROM messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(c.id) as { content: string } | undefined;
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

  getMessages(contactId: number): Message[] {
    return db.prepare("SELECT * FROM messages WHERE contact_id = ? ORDER BY created_at ASC").all(contactId) as Message[];
  }

  getMessagesSince(contactId: number, sinceId: number): Message[] {
    return db.prepare("SELECT * FROM messages WHERE contact_id = ? AND id > ? ORDER BY created_at ASC").all(contactId, sinceId) as Message[];
  }

  createMessage(contactId: number, platform: string, senderType: string, content: string): Message {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare(
      "INSERT INTO messages (contact_id, platform, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(contactId, platform, senderType, content, now);

    db.prepare("UPDATE contacts SET last_message_at = ? WHERE id = ?").run(now, contactId);

    return {
      id: Number(result.lastInsertRowid),
      contact_id: contactId,
      platform,
      sender_type: senderType as "user" | "ai" | "admin",
      content,
      created_at: now,
    };
  }

  getOrCreateContact(platform: string, platformUserId: string, displayName: string): Contact {
    let contact = db.prepare("SELECT * FROM contacts WHERE platform = ? AND platform_user_id = ?").get(platform, platformUserId) as Contact | undefined;
    if (!contact) {
      const now = new Date().toISOString().replace("T", " ").substring(0, 19);
      const result = db.prepare(
        "INSERT INTO contacts (platform, platform_user_id, display_name, needs_human, status, tags, created_at) VALUES (?, ?, ?, 0, 'pending', '[]', ?)"
      ).run(platform, platformUserId, displayName, now);
      contact = {
        id: Number(result.lastInsertRowid),
        platform,
        platform_user_id: platformUserId,
        display_name: displayName,
        avatar_url: null,
        needs_human: 0,
        status: "pending",
        tags: "[]",
        last_message_at: null,
        created_at: now,
      };
    }
    return contact;
  }

  getKnowledgeFiles(): KnowledgeFile[] {
    return db.prepare("SELECT * FROM knowledge_files ORDER BY created_at DESC").all() as KnowledgeFile[];
  }

  createKnowledgeFile(filename: string, originalName: string, size: number): KnowledgeFile {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare(
      "INSERT INTO knowledge_files (filename, original_name, size, created_at) VALUES (?, ?, ?, ?)"
    ).run(filename, originalName, size, now);
    return {
      id: Number(result.lastInsertRowid),
      filename,
      original_name: originalName,
      size,
      created_at: now,
    };
  }

  deleteKnowledgeFile(id: number): boolean {
    const result = db.prepare("DELETE FROM knowledge_files WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getTeamMembers(): TeamMember[] {
    return db.prepare("SELECT * FROM team_members ORDER BY created_at ASC").all() as TeamMember[];
  }
}

export const storage = new SQLiteStorage();

export function getOrderStatus(phone: string): { status: string; order_id: string } {
  const statuses = ["處理中", "已出貨", "配送中", "已送達"];
  const status = statuses[Math.floor(Math.random() * statuses.length)];
  const orderId = `ORD-${Date.now().toString().slice(-8)}`;
  return { status, order_id: orderId };
}
