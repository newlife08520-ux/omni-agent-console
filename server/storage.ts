import db, { initDatabase, hashPassword } from "./db";
import type { User, Contact, ContactWithPreview, Message, Setting, KnowledgeFile, TeamMember, MarketingRule, Brand, Channel, ChannelWithBrand, ImageAsset } from "@shared/schema";

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
  getBrands(): Brand[];
  getBrand(id: number): Brand | undefined;
  createBrand(name: string, slug: string, logoUrl?: string, description?: string, systemPrompt?: string, superlandingMerchantNo?: string, superlandingAccessKey?: string): Brand;
  updateBrand(id: number, data: Partial<Omit<Brand, "id" | "created_at">>): boolean;
  deleteBrand(id: number): boolean;
  getChannels(): ChannelWithBrand[];
  getChannelsByBrand(brandId: number): Channel[];
  getChannel(id: number): Channel | undefined;
  getChannelByBotId(botId: string): ChannelWithBrand | undefined;
  createChannel(brandId: number, platform: string, channelName: string, botId?: string, accessToken?: string, channelSecret?: string): Channel;
  updateChannel(id: number, data: Partial<Omit<Channel, "id" | "created_at">>): boolean;
  deleteChannel(id: number): boolean;
  getContacts(brandId?: number): ContactWithPreview[];
  getContact(id: number): Contact | undefined;
  updateContactHumanFlag(id: number, needsHuman: number): void;
  updateContactStatus(id: number, status: string): void;
  updateContactTags(id: number, tags: string[]): void;
  updateContactPinned(id: number, isPinned: number): void;
  updateContactVipData(id: number, vipLevel: number, orderCount: number, totalSpent: number): void;
  updateContactRating(id: number, rating: number): void;
  updateContactAiRating(id: number, rating: number): void;
  getContactByPlatformUser(platform: string, platformUserId: string): Contact | undefined;
  isEventProcessed(eventId: string): boolean;
  markEventProcessed(eventId: string): void;
  getMessages(contactId: number): Message[];
  getMessagesSince(contactId: number, sinceId: number): Message[];
  searchMessages(query: string): { contact_id: number; contact_name: string; message_id: number; content: string; sender_type: string; created_at: string }[];
  createMessage(contactId: number, platform: string, senderType: string, content: string, messageType?: string, imageUrl?: string | null): Message;
  getOrCreateContact(platform: string, platformUserId: string, displayName: string, brandId?: number, channelId?: number): Contact;
  getKnowledgeFiles(brandId?: number): KnowledgeFile[];
  createKnowledgeFile(filename: string, originalName: string, size: number, brandId?: number, content?: string): KnowledgeFile;
  updateKnowledgeFileContent(id: number, content: string): boolean;
  deleteKnowledgeFile(id: number): boolean;
  getImageAssets(brandId?: number): ImageAsset[];
  getImageAsset(id: number): ImageAsset | undefined;
  getImageAssetByName(displayName: string, brandId?: number): ImageAsset | undefined;
  createImageAsset(filename: string, originalName: string, displayName: string, description: string, keywords: string, size: number, mimeType: string, brandId?: number): ImageAsset;
  updateImageAsset(id: number, data: Partial<Omit<ImageAsset, "id" | "created_at">>): boolean;
  deleteImageAsset(id: number): boolean;
  getMarketingRules(brandId?: number): MarketingRule[];
  createMarketingRule(keyword: string, pitch: string, url: string, brandId?: number): MarketingRule;
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

  getBrands(): Brand[] {
    return db.prepare("SELECT * FROM brands ORDER BY created_at ASC").all() as Brand[];
  }

  getBrand(id: number): Brand | undefined {
    return db.prepare("SELECT * FROM brands WHERE id = ?").get(id) as Brand | undefined;
  }

  createBrand(name: string, slug: string, logoUrl?: string, description?: string, systemPrompt?: string, superlandingMerchantNo?: string, superlandingAccessKey?: string, returnFormUrl?: string): Brand {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare("INSERT INTO brands (name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key, return_form_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      name, slug, logoUrl || "", description || "", systemPrompt || "", superlandingMerchantNo || "", superlandingAccessKey || "", returnFormUrl || "", now
    );
    return db.prepare("SELECT * FROM brands WHERE id = ?").get(Number(result.lastInsertRowid)) as Brand;
  }

  updateBrand(id: number, data: Partial<Omit<Brand, "id" | "created_at">>): boolean {
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
    if (fields.length === 0) return false;
    values.push(id);
    const result = db.prepare(`UPDATE brands SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  deleteBrand(id: number): boolean {
    db.prepare("DELETE FROM channels WHERE brand_id = ?").run(id);
    const result = db.prepare("DELETE FROM brands WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getChannels(): ChannelWithBrand[] {
    return db.prepare(`
      SELECT c.*, b.name as brand_name, b.slug as brand_slug
      FROM channels c
      LEFT JOIN brands b ON c.brand_id = b.id
      ORDER BY c.created_at ASC
    `).all() as ChannelWithBrand[];
  }

  getChannelsByBrand(brandId: number): Channel[] {
    return db.prepare("SELECT * FROM channels WHERE brand_id = ? ORDER BY created_at ASC").all(brandId) as Channel[];
  }

  getChannel(id: number): Channel | undefined {
    return db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Channel | undefined;
  }

  getChannelByBotId(botId: string): ChannelWithBrand | undefined {
    return db.prepare(`
      SELECT c.*, b.name as brand_name, b.slug as brand_slug
      FROM channels c
      LEFT JOIN brands b ON c.brand_id = b.id
      WHERE c.bot_id = ? AND c.is_active = 1
    `).get(botId) as ChannelWithBrand | undefined;
  }

  createChannel(brandId: number, platform: string, channelName: string, botId?: string, accessToken?: string, channelSecret?: string): Channel {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare("INSERT INTO channels (brand_id, platform, channel_name, bot_id, access_token, channel_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      brandId, platform, channelName, botId || "", accessToken || "", channelSecret || "", now
    );
    return db.prepare("SELECT * FROM channels WHERE id = ?").get(Number(result.lastInsertRowid)) as Channel;
  }

  updateChannel(id: number, data: Partial<Omit<Channel, "id" | "created_at">>): boolean {
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
    if (fields.length === 0) return false;
    values.push(id);
    const result = db.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  deleteChannel(id: number): boolean {
    const result = db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getContacts(brandId?: number): ContactWithPreview[] {
    let query = "SELECT c.*, b.name as brand_name, ch.channel_name FROM contacts c LEFT JOIN brands b ON c.brand_id = b.id LEFT JOIN channels ch ON c.channel_id = ch.id";
    const params: any[] = [];
    if (brandId) {
      query += " WHERE c.brand_id = ?";
      params.push(brandId);
    }
    query += " ORDER BY c.is_pinned DESC, c.last_message_at DESC";
    const contacts = db.prepare(query).all(...params) as (Contact & { brand_name?: string; channel_name?: string })[];
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

  updateContactAiRating(id: number, rating: number): void {
    db.prepare("UPDATE contacts SET ai_rating = ? WHERE id = ?").run(rating, id);
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

  getOrCreateContact(platform: string, platformUserId: string, displayName: string, brandId?: number, channelId?: number): Contact {
    let contact = db.prepare("SELECT * FROM contacts WHERE platform = ? AND platform_user_id = ?").get(platform, platformUserId) as Contact | undefined;
    if (!contact) {
      const now = new Date().toISOString().replace("T", " ").substring(0, 19);
      const result = db.prepare("INSERT INTO contacts (platform, platform_user_id, display_name, needs_human, is_pinned, status, tags, vip_level, order_count, total_spent, brand_id, channel_id, created_at) VALUES (?, ?, ?, 0, 0, 'pending', '[]', 0, 0, 0, ?, ?, ?)").run(platform, platformUserId, displayName, brandId || null, channelId || null, now);
      contact = { id: Number(result.lastInsertRowid), platform, platform_user_id: platformUserId, display_name: displayName, avatar_url: null, needs_human: 0, is_pinned: 0, status: "pending", tags: "[]", vip_level: 0, order_count: 0, total_spent: 0, cs_rating: null, ai_rating: null, last_message_at: null, created_at: now, brand_id: brandId || null, channel_id: channelId || null };
    } else {
      let needsUpdate = false;
      let newBrandId = contact.brand_id;
      let newChannelId = contact.channel_id;
      
      if (brandId && !contact.brand_id) {
        newBrandId = brandId;
        needsUpdate = true;
      }
      if (channelId && !contact.channel_id) {
        newChannelId = channelId;
        needsUpdate = true;
      }
      
      if (needsUpdate) {
        db.prepare("UPDATE contacts SET brand_id = ?, channel_id = ? WHERE id = ?").run(newBrandId || null, newChannelId || null, contact.id);
        contact.brand_id = newBrandId;
        contact.channel_id = newChannelId;
      }
    }
    return contact;
  }

  getKnowledgeFiles(brandId?: number): KnowledgeFile[] {
    if (brandId) {
      return db.prepare("SELECT * FROM knowledge_files WHERE brand_id = ? ORDER BY created_at DESC").all(brandId) as KnowledgeFile[];
    }
    return db.prepare("SELECT * FROM knowledge_files ORDER BY created_at DESC").all() as KnowledgeFile[];
  }

  createKnowledgeFile(filename: string, originalName: string, size: number, brandId?: number, content?: string): KnowledgeFile {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare("INSERT INTO knowledge_files (filename, original_name, size, brand_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(filename, originalName, size, brandId || null, content || null, now);
    return { id: Number(result.lastInsertRowid), filename, original_name: originalName, size, content: content || null, created_at: now, brand_id: brandId || null };
  }

  updateKnowledgeFileContent(id: number, content: string): boolean {
    const result = db.prepare("UPDATE knowledge_files SET content = ? WHERE id = ?").run(content, id);
    return result.changes > 0;
  }

  deleteKnowledgeFile(id: number): boolean {
    const result = db.prepare("DELETE FROM knowledge_files WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getImageAssets(brandId?: number): ImageAsset[] {
    if (brandId) {
      return db.prepare("SELECT * FROM image_assets WHERE brand_id = ? ORDER BY created_at DESC").all(brandId) as ImageAsset[];
    }
    return db.prepare("SELECT * FROM image_assets ORDER BY created_at DESC").all() as ImageAsset[];
  }

  getImageAsset(id: number): ImageAsset | undefined {
    return db.prepare("SELECT * FROM image_assets WHERE id = ?").get(id) as ImageAsset | undefined;
  }

  getImageAssetByName(displayName: string, brandId?: number): ImageAsset | undefined {
    if (brandId) {
      return db.prepare("SELECT * FROM image_assets WHERE (display_name = ? OR original_name = ?) AND brand_id = ?").get(displayName, displayName, brandId) as ImageAsset | undefined;
    }
    return db.prepare("SELECT * FROM image_assets WHERE display_name = ? OR original_name = ?").get(displayName, displayName) as ImageAsset | undefined;
  }

  createImageAsset(filename: string, originalName: string, displayName: string, description: string, keywords: string, size: number, mimeType: string, brandId?: number): ImageAsset {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare("INSERT INTO image_assets (filename, original_name, display_name, description, keywords, size, mime_type, brand_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(filename, originalName, displayName, description, keywords, size, mimeType, brandId || null, now);
    return { id: Number(result.lastInsertRowid), filename, original_name: originalName, display_name: displayName, description, keywords, size, mime_type: mimeType, brand_id: brandId || null, created_at: now };
  }

  updateImageAsset(id: number, data: Partial<Omit<ImageAsset, "id" | "created_at">>): boolean {
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return false;
    values.push(id);
    const result = db.prepare(`UPDATE image_assets SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  deleteImageAsset(id: number): boolean {
    const result = db.prepare("DELETE FROM image_assets WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getMarketingRules(brandId?: number): MarketingRule[] {
    if (brandId) {
      return db.prepare("SELECT * FROM marketing_rules WHERE brand_id = ? ORDER BY created_at DESC").all(brandId) as MarketingRule[];
    }
    return db.prepare("SELECT * FROM marketing_rules ORDER BY created_at DESC").all() as MarketingRule[];
  }

  createMarketingRule(keyword: string, pitch: string, url: string, brandId?: number): MarketingRule {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare("INSERT INTO marketing_rules (keyword, pitch, url, brand_id, created_at) VALUES (?, ?, ?, ?, ?)").run(keyword, pitch, url, brandId || null, now);
    return { id: Number(result.lastInsertRowid), keyword, pitch, url, created_at: now, brand_id: brandId || null };
  }

  updateMarketingRule(id: number, keyword: string, pitch: string, url: string): boolean {
    const result = db.prepare("UPDATE marketing_rules SET keyword = ?, pitch = ?, url = ? WHERE id = ?").run(keyword, pitch, url, id);
    return result.changes > 0;
  }

  deleteMarketingRule(id: number): boolean {
    const result = db.prepare("DELETE FROM marketing_rules WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getAnalytics(startDate: string, endDate: string, brandId?: number): {
    totalMessages: number;
    userMessages: number;
    aiMessages: number;
    adminMessages: number;
    systemMessages: number;
    totalContacts: number;
    resolvedContacts: number;
    processingContacts: number;
    pendingContacts: number;
    needsHumanContacts: number;
    aiOnlyContacts: number;
    avgCsRating: number | null;
    avgAiRating: number | null;
    ratedCsCount: number;
    ratedAiCount: number;
    contactsByPlatform: { platform: string; count: number }[];
    messagesByType: { sender_type: string; count: number }[];
  } {
    const brandFilter = brandId ? " AND c.brand_id = ?" : "";
    const brandParam = brandId ? [brandId] : [];

    const msgStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN m.sender_type = 'user' THEN 1 ELSE 0 END) as user_msgs,
        SUM(CASE WHEN m.sender_type = 'ai' THEN 1 ELSE 0 END) as ai_msgs,
        SUM(CASE WHEN m.sender_type = 'admin' THEN 1 ELSE 0 END) as admin_msgs,
        SUM(CASE WHEN m.sender_type = 'system' THEN 1 ELSE 0 END) as system_msgs
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.created_at >= ? AND m.created_at <= ?${brandFilter}
    `).get(startDate, endDate, ...brandParam) as any;

    const contactStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN needs_human = 1 THEN 1 ELSE 0 END) as needs_human,
        SUM(CASE WHEN needs_human = 0 THEN 1 ELSE 0 END) as ai_only
      FROM contacts
      WHERE created_at >= ? AND created_at <= ?${brandId ? " AND brand_id = ?" : ""}
    `).get(startDate, endDate, ...brandParam) as any;

    const ratingStats = db.prepare(`
      SELECT 
        AVG(CASE WHEN cs_rating IS NOT NULL THEN cs_rating END) as avg_cs,
        AVG(CASE WHEN ai_rating IS NOT NULL THEN ai_rating END) as avg_ai,
        SUM(CASE WHEN cs_rating IS NOT NULL THEN 1 ELSE 0 END) as rated_cs,
        SUM(CASE WHEN ai_rating IS NOT NULL THEN 1 ELSE 0 END) as rated_ai
      FROM contacts
      WHERE created_at >= ? AND created_at <= ?${brandId ? " AND brand_id = ?" : ""}
    `).get(startDate, endDate, ...brandParam) as any;

    const platformStats = db.prepare(`
      SELECT platform, COUNT(*) as count
      FROM contacts
      WHERE created_at >= ? AND created_at <= ?${brandId ? " AND brand_id = ?" : ""}
      GROUP BY platform
    `).all(startDate, endDate, ...brandParam) as { platform: string; count: number }[];

    const msgByType = db.prepare(`
      SELECT m.sender_type, COUNT(*) as count
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.created_at >= ? AND m.created_at <= ?${brandFilter}
      GROUP BY m.sender_type
    `).all(startDate, endDate, ...brandParam) as { sender_type: string; count: number }[];

    return {
      totalMessages: msgStats?.total || 0,
      userMessages: msgStats?.user_msgs || 0,
      aiMessages: msgStats?.ai_msgs || 0,
      adminMessages: msgStats?.admin_msgs || 0,
      systemMessages: msgStats?.system_msgs || 0,
      totalContacts: contactStats?.total || 0,
      resolvedContacts: contactStats?.resolved || 0,
      processingContacts: contactStats?.processing || 0,
      pendingContacts: contactStats?.pending || 0,
      needsHumanContacts: contactStats?.needs_human || 0,
      aiOnlyContacts: contactStats?.ai_only || 0,
      avgCsRating: ratingStats?.avg_cs || null,
      avgAiRating: ratingStats?.avg_ai || null,
      ratedCsCount: ratingStats?.rated_cs || 0,
      ratedAiCount: ratingStats?.rated_ai || 0,
      contactsByPlatform: platformStats,
      messagesByType: msgByType,
    };
  }

  getTopKeywordsFromMessages(startDate: string, endDate: string, brandId?: number): { keyword: string; count: number }[] {
    const brandFilter = brandId ? " AND c.brand_id = ?" : "";
    const brandParam = brandId ? [brandId] : [];
    const messages = db.prepare(`
      SELECT m.content FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
      ORDER BY m.created_at DESC LIMIT 500
    `).all(startDate, endDate, ...brandParam) as { content: string }[];

    const keywordMap: Record<string, number> = {};
    const keywords = ["退換貨", "退貨", "換貨", "退款", "訂單", "查詢", "物流", "出貨", "寄送", "地址", "修改", "取消", "付款", "金額", "價格", "折扣", "優惠", "庫存", "缺貨", "商品", "尺寸", "顏色", "品質", "瑕疵", "損壞", "保固", "客訴", "投訴", "不滿", "真人", "轉接", "客服"];
    for (const msg of messages) {
      for (const kw of keywords) {
        if (msg.content.includes(kw)) {
          keywordMap[kw] = (keywordMap[kw] || 0) + 1;
        }
      }
    }
    return Object.entries(keywordMap)
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }
}

export const storage = new SQLiteStorage();
