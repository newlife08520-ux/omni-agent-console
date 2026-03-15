import db, { initDatabase, hashPassword } from "./db";
import type { User, Contact, ContactWithPreview, Message, Setting, KnowledgeFile, TeamMember, MarketingRule, Brand, Channel, ChannelWithBrand, ImageAsset, AiLog, AgentStatus, AssignmentRecord, AgentBrandAssignment, AgentBrandRole, ActiveOrderContext } from "@shared/schema";
import { CONTACT_STATUS_ALLOWED } from "@shared/schema";
import { getRedisClient } from "./redis-client";
import * as redisBC from "./redis-brands-channels";

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
  createBrand(name: string, slug: string, logoUrl?: string, description?: string, systemPrompt?: string, superlandingMerchantNo?: string, superlandingAccessKey?: string, returnFormUrl?: string): Promise<Brand>;
  updateBrand(id: number, data: Partial<Omit<Brand, "id" | "created_at">>): Promise<boolean>;
  deleteBrand(id: number): Promise<boolean>;
  getChannels(): ChannelWithBrand[];
  getChannelsByBrand(brandId: number): Channel[];
  getChannel(id: number): Channel | undefined;
  getChannelByBotId(botId: string): ChannelWithBrand | undefined;
  getAgentBrandAssignments(userId: number): AgentBrandAssignment[];
  setAgentBrandAssignments(userId: number, assignments: { brand_id: number; role: AgentBrandRole }[]): void;
  getBrandAssignedAgents(brandId: number): { user_id: number; display_name: string; role: AgentBrandRole }[];
  createChannel(brandId: number, platform: string, channelName: string, botId?: string, accessToken?: string, channelSecret?: string): Promise<Channel>;
  updateChannel(id: number, data: Partial<Omit<Channel, "id" | "created_at">>): Promise<boolean>;
  deleteChannel(id: number): Promise<boolean>;
  getContacts(brandId?: number, assignedToUserId?: number, agentIdForFlags?: number, limit?: number, offset?: number): ContactWithPreview[];
  getContact(id: number): Contact | undefined;
  updateContactHumanFlag(id: number, needsHuman: number): void;
  updateContactStatus(id: number, status: string): void;
  updateContactTags(id: number, tags: string[]): void;
  updateContactPinned(id: number, isPinned: number): void;
  updateContactVipData(id: number, vipLevel: number, orderCount: number, totalSpent: number): void;
  updateContactRating(id: number, rating: number): void;
  updateContactAiRating(id: number, rating: number): void;
  clearContactCsRating(id: number): void;
  clearContactAiRating(id: number): void;
  updateContactProfile(id: number, displayName: string, avatarUrl: string | null): void;
  getTagShortcuts(): { name: string; order: number }[];
  setTagShortcuts(tags: { name: string; order: number }[]): void;
  updateContactAiSuggestions(id: number, suggestions: { issue_type?: string; status?: string; priority?: string; tags?: string[] }): void;
  getContactByPlatformUser(platform: string, platformUserId: string): Contact | undefined;
  isEventProcessed(eventId: string): boolean;
  markEventProcessed(eventId: string): void;
  getMessages(contactId: number, options?: { limit?: number; beforeId?: number }): Message[];
  getMessagesSince(contactId: number, sinceId: number): Message[];
  searchMessages(query: string): { contact_id: number; contact_name: string; message_id: number; content: string; sender_type: string; created_at: string }[];
  createMessage(contactId: number, platform: string, senderType: string, content: string, messageType?: string, imageUrl?: string | null): Message;
  getOrCreateContact(platform: string, platformUserId: string, displayName: string, brandId?: number, channelId?: number): Contact;
  /** 將指定 channel 下的所有聯絡人改為隸屬指定品牌（用於修正錯歸） */
  reassignContactsByChannel(channelId: number, brandId: number): number;
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
  createAiLog(data: {
    contact_id?: number;
    message_id?: number;
    brand_id?: number;
    prompt_summary: string;
    knowledge_hits: string[];
    tools_called: string[];
    transfer_triggered: boolean;
    transfer_reason?: string;
    result_summary: string;
    token_usage: number;
    model: string;
    response_time_ms: number;
    /** Phase 0: reply_source (gate_skip | high_risk_short_circuit | safe_confirm_template | image_short_caption | image_dm_only | return_form_first | llm | handoff | error) */
    reply_source?: string;
    /** Phase 0: 本輪是否曾呼叫 LLM (1/0) */
    used_llm?: number;
    /** Phase 0: 本輪 plan.mode */
    plan_mode?: string | null;
    /** Phase 0: 未進 LLM 時原因 */
    reason_if_bypassed?: string | null;
  }): AiLog;
  getAiLogs(contactId: number): AiLog[];
  getAiLogStats(startDate: string, endDate: string, brandId?: number): {
    totalAiResponses: number;
    transferTriggered: number;
    avgResponseTime: number;
    toolCallCount: number;
    orderQueryCount: number;
    orderQuerySuccess: number;
    transferReasons: { reason: string; count: number }[];
  };
  updateContactIssueType(id: number, issueType: string | null): void;
  updateContactOrderSource(id: number, orderSource: string): void;
  /** 建立對話與訂單連結（AI 查單成功或手動綁定時呼叫） */
  linkOrderForContact(contactId: number, globalOrderId: string, source?: "manual" | "ai_lookup"): void;
  getActiveOrderContext(contactId: number): ActiveOrderContext | null;
  setActiveOrderContext(contactId: number, ctx: ActiveOrderContext): void;
  clearActiveOrderContext(contactId: number): void;
  setAiMutedUntil(id: number, until: string): void;
  isAiMuted(id: number): boolean;
  clearAiMuted(id: number): void;
  resetConsecutiveTimeouts(id: number): void;
  incrementConsecutiveTimeouts(id: number): number;
  createSystemAlert(data: { alert_type: string; details: string; brand_id?: number; contact_id?: number }): void;
  getSystemAlertStats(startDate: string, endDate: string, brandId?: number): {
    webhookSigFails: number;
    dedupeHits: number;
    lockTimeouts: number;
    orderLookupFails: number;
    timeoutEscalations: number;
    totalAlerts: number;
    transferReasonTop5: { reason: string; count: number }[];
    alertsByType: { type: string; count: number }[];
  };
  getAgentStatus(userId: number): AgentStatus | undefined;
  upsertAgentStatus(data: Partial<AgentStatus> & { user_id: number }): void;
  getAssignmentHistory(contactId: number): AssignmentRecord[];
  createAssignmentRecord(contactId: number, assignedToAgentId: number, assignedByAgentId: number | null, reassignedFromAgentId: number | null, note: string | null): AssignmentRecord;
  updateContactAssignment(contactId: number, assignedAgentId: number | null, firstAssignedAt?: string): void;
  getOpenCasesCountForAgent(agentId: number): number;
  /** 主管戰情：僅用 COUNT 查詢，不載入全表。用於 /api/manager-stats。 */
  getManagerStatsCounts(brandId?: number): { today_new: number; unassigned: number; closed_today: number; overdue: number; urgent_simple: number; vip_unhandled: number };
  /** 客服個人戰情：僅用 COUNT，不載入全表。用於 /api/agent-stats/me。 */
  getAgentStatsCounts(agentId: number): { pending_reply: number; closed_today: number; overdue: number; tracking: number; urgent_simple: number };
  /** 單一客服的「待回覆」數（最後一則為 user 且未結案）。用於 manager-stats 的 team[].pending_reply。 */
  getAgentPendingReplyCount(agentId: number): number;
  incrementAgentTodayAssigned(agentId: number): void;
  resetAgentDailyCountsIfNewDay(): void;
  updateContactIntentLevel(contactId: number, level: string | null): void;
  updateContactOrderNumberType(contactId: number, type: string | null): void;
  updateContactCasePriority(contactId: number, priority: number | null): void;
  updateContactClosed(contactId: number, closedByAgentId: number, closeReason?: string | null): void;
  updateContactConversationFields(contactId: number, fields: { resolution_status?: string | null; waiting_for_customer?: string | null; human_reason?: string | null; return_stage?: number | null; rating_invited_at?: string | null; close_reason?: string | null; qa_score?: number | null; qa_score_reason?: string | null; product_scope_locked?: string | null; customer_goal_locked?: string | null }): void;
  getUnreadHumanCaseCount(): number;
  markCaseNotificationsRead(contactId?: number): void;
  createCaseNotification(contactId: number, channel?: string): void;
  updateUserOnline(userId: number, isOnline: number, isAvailable?: number): void;
  updateUserLastActive(userId: number): void;
  getAgentContactFlags(agentId: number, contactIds: number[]): Record<number, "later" | "tracking">;
  setAgentContactFlag(agentId: number, contactId: number, flag: "later" | "tracking" | null): void;
  updateContactLastHumanReply(contactId: number): void;
  incrementContactReassignCount(contactId: number): void;
  updateContactAssignmentStatus(contactId: number, status: string): void;
  getGlobalSchedule(): { work_start_time: string; work_end_time: string; lunch_start_time: string; lunch_end_time: string };
  getAgentPerformanceStats(agentId: number): {
    today_new: number;
    open_cases: number;
    processing: number;
    closed_today: number;
    closed_total: number;
    avg_first_reply_minutes: number | null;
    avg_close_minutes: number | null;
    close_rate: number | null;
    resolve_rate: number | null;
  };
  getSupervisorReport(): {
    today_total: number;
    pending_count: number;
    transfer_count: number;
    lunch_pending_count: number;
    by_agent: { agent_id: number; display_name: string; today_assigned: number; open_cases: number; closed_today: number }[];
    tag_rank: { tag: string; count: number }[];
    category_ratio: { label: string; count: number }[];
  };
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
    const rows = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.created_at, u.avatar_url,
             u.is_online, u.is_available, u.last_active_at,
             a.max_active_conversations, a.auto_assign_enabled
      FROM users u
      LEFT JOIN agent_status a ON u.id = a.user_id
      ORDER BY u.created_at ASC
    `).all() as (TeamMember & { max_active_conversations?: number; auto_assign_enabled?: number })[];
    return rows.map((r) => {
      const open = this.getOpenCasesCountForAgent(r.id);
      return {
        id: r.id,
        username: r.username,
        display_name: r.display_name,
        role: r.role,
        created_at: r.created_at,
        avatar_url: r.avatar_url ?? null,
        is_online: r.is_online ?? 0,
        is_available: r.is_available ?? 1,
        last_active_at: r.last_active_at ?? null,
        max_active_conversations: r.max_active_conversations ?? 10,
        open_cases_count: open,
        auto_assign_enabled: r.auto_assign_enabled ?? 1,
      };
    });
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

  async createBrand(name: string, slug: string, logoUrl?: string, description?: string, systemPrompt?: string, superlandingMerchantNo?: string, superlandingAccessKey?: string, returnFormUrl?: string): Promise<Brand> {
    const client = getRedisClient();
    if (client) {
      const brand = await redisBC.createBrand(client, name, slug, logoUrl, description, systemPrompt, superlandingMerchantNo, superlandingAccessKey, returnFormUrl);
      try {
        db.prepare(`
          INSERT OR REPLACE INTO brands (id, name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key, return_form_url, shopline_store_domain, shopline_api_token, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(brand.id, brand.name, brand.slug, brand.logo_url ?? "", brand.description ?? "", brand.system_prompt ?? "", brand.superlanding_merchant_no ?? "", brand.superlanding_access_key ?? "", brand.return_form_url ?? "", brand.shopline_store_domain ?? "", brand.shopline_api_token ?? "", brand.created_at ?? "");
      } catch (_e) { /* SQLite 可能缺欄位，忽略 */ }
      return brand;
    }
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare("INSERT INTO brands (name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key, return_form_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      name, slug, logoUrl || "", description || "", systemPrompt || "", superlandingMerchantNo || "", superlandingAccessKey || "", returnFormUrl || "", now
    );
    return db.prepare("SELECT * FROM brands WHERE id = ?").get(Number(result.lastInsertRowid)) as Brand;
  }

  async updateBrand(id: number, data: Partial<Omit<Brand, "id" | "created_at">>): Promise<boolean> {
    const client = getRedisClient();
    if (client) {
      let ok = await redisBC.updateBrand(client, id, data);
      if (!ok) {
        const brand = this.getBrand(id);
        if (!brand) return false;
        const fields: string[] = [];
        const values: any[] = [];
        for (const [key, val] of Object.entries(data)) {
          fields.push(`${key} = ?`);
          values.push(val);
        }
        if (fields.length > 0) {
          values.push(id);
          try { db.prepare(`UPDATE brands SET ${fields.join(", ")} WHERE id = ?`).run(...values); } catch (_e) { /* ignore */ }
        }
        const fullBrand: Brand = { ...brand, ...data };
        await redisBC.syncBrandToRedis(client, fullBrand);
        return true;
      }
      const fields: string[] = [];
      const values: any[] = [];
      for (const [key, val] of Object.entries(data)) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
      if (fields.length > 0) {
        values.push(id);
        try { db.prepare(`UPDATE brands SET ${fields.join(", ")} WHERE id = ?`).run(...values); } catch (_e) { /* ignore */ }
      }
      return true;
    }
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

  async deleteBrand(id: number): Promise<boolean> {
    const client = getRedisClient();
    // 以 SQLite 為準：先刪除 channels / brands，避免因 Redis 未同步導致刪除失敗
    try {
      db.prepare("DELETE FROM channels WHERE brand_id = ?").run(id);
      const result = db.prepare("DELETE FROM brands WHERE id = ?").run(id);
      if (result.changes === 0) return false;
    } catch (e) {
      return false;
    }
    if (client) {
      try {
        await redisBC.deleteBrand(client, id);
      } catch (_e) { /* 僅同步 Redis，失敗不影響已完成的刪除 */ }
    }
    return true;
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

  /** LINE：bot_id 存的是 Webhook 請求體的 destination（Bot User ID，通常 U 開頭 33 碼），用於多渠道路由匹配；非後台數字 Channel ID。 */
  getChannelByBotId(botId: string): ChannelWithBrand | undefined {
    const raw = (botId || "").trim();
    if (!raw) return undefined;
    let row = db.prepare(`
      SELECT c.*, b.name as brand_name, b.slug as brand_slug
      FROM channels c
      LEFT JOIN brands b ON c.brand_id = b.id
      WHERE TRIM(COALESCE(c.bot_id, '')) = ? AND c.is_active = 1
    `).get(raw) as ChannelWithBrand | undefined;
    if (row) return row;
    /** LINE 有時送 U 開頭、有時不送；後台可能只填 200f74dd...，兩邊都試一次避免「填對卻沒反應」 */
    const alt = raw.startsWith("U") ? raw.slice(1) : "U" + raw;
    row = db.prepare(`
      SELECT c.*, b.name as brand_name, b.slug as brand_slug
      FROM channels c
      LEFT JOIN brands b ON c.brand_id = b.id
      WHERE TRIM(COALESCE(c.bot_id, '')) = ? AND c.is_active = 1
    `).get(alt) as ChannelWithBrand | undefined;
    return row;
  }

  getAgentBrandAssignments(userId: number): AgentBrandAssignment[] {
    return db.prepare(`
      SELECT user_id, brand_id, role, created_at
      FROM agent_brand_assignments
      WHERE user_id = ?
      ORDER BY brand_id
    `).all(userId) as AgentBrandAssignment[];
  }

  setAgentBrandAssignments(userId: number, assignments: { brand_id: number; role: AgentBrandRole }[]): void {
    db.prepare("DELETE FROM agent_brand_assignments WHERE user_id = ?").run(userId);
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const stmt = db.prepare("INSERT INTO agent_brand_assignments (user_id, brand_id, role, created_at) VALUES (?, ?, ?, ?)");
    for (const a of assignments) {
      stmt.run(userId, a.brand_id, a.role, now);
    }
  }

  getBrandAssignedAgents(brandId: number): { user_id: number; display_name: string; role: AgentBrandRole }[] {
    const rows = db.prepare(`
      SELECT a.user_id, u.display_name, a.role
      FROM agent_brand_assignments a
      JOIN users u ON u.id = a.user_id
      WHERE a.brand_id = ?
      ORDER BY a.role, u.display_name
    `).all(brandId) as { user_id: number; display_name: string; role: AgentBrandRole }[];
    return rows;
  }

  async createChannel(brandId: number, platform: string, channelName: string, botId?: string, accessToken?: string, channelSecret?: string): Promise<Channel> {
    const client = getRedisClient();
    if (client) {
      const channel = await redisBC.createChannel(client, brandId, platform, channelName, botId, accessToken, channelSecret);
      try {
        db.prepare(`
          INSERT OR REPLACE INTO channels (id, brand_id, platform, channel_name, bot_id, access_token, channel_secret, is_active, is_ai_enabled, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(channel.id, channel.brand_id, channel.platform, channel.channel_name, channel.bot_id ?? "", channel.access_token ?? "", channel.channel_secret ?? "", channel.is_active ?? 1, channel.is_ai_enabled ?? 0, channel.created_at ?? "");
      } catch (_e) { /* ignore */ }
      return channel;
    }
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const result = db.prepare("INSERT INTO channels (brand_id, platform, channel_name, bot_id, access_token, channel_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      brandId, platform, channelName, botId || "", accessToken || "", channelSecret || "", now
    );
    return db.prepare("SELECT * FROM channels WHERE id = ?").get(Number(result.lastInsertRowid)) as Channel;
  }

  async updateChannel(id: number, data: Partial<Omit<Channel, "id" | "created_at">>): Promise<boolean> {
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
    if (fields.length === 0) return false;
    values.push(id);
    const runSqlite = () => {
      const result = db.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      return result.changes > 0;
    };
    const client = getRedisClient();
    if (client) {
      const ok = await redisBC.updateChannel(client, id, data);
      if (ok) {
        try { runSqlite(); } catch (_e) { /* ignore */ }
        return true;
      }
      // Redis 無此 id（例如僅存在 SQLite 或 Redis 曾清空）時仍更新 SQLite，避免 PUT 回 404
      return runSqlite();
    }
    return runSqlite();
  }

  async deleteChannel(id: number): Promise<boolean> {
    const client = getRedisClient();
    if (client) {
      const ok = await redisBC.deleteChannel(client, id);
      if (ok) {
        try { db.prepare("DELETE FROM channels WHERE id = ?").run(id); } catch (_e) { /* ignore */ }
      }
      return ok;
    }
    const result = db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getContacts(brandId?: number, assignedToUserId?: number, agentIdForFlags?: number, limit?: number, offset?: number): ContactWithPreview[] {
    const t0 = Date.now();
    let query = "SELECT c.*, b.name as brand_name, ch.channel_name, u.display_name as assigned_agent_name, u.avatar_url as assigned_agent_avatar_url FROM contacts c LEFT JOIN brands b ON c.brand_id = b.id LEFT JOIN channels ch ON c.channel_id = ch.id LEFT JOIN users u ON c.assigned_agent_id = u.id";
    const params: any[] = [];
    const conditions: string[] = [];
    if (brandId) {
      conditions.push("c.brand_id = ?");
      params.push(brandId);
    }
    if (assignedToUserId != null) {
      conditions.push("c.assigned_agent_id = ?");
      params.push(assignedToUserId);
    }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY c.is_pinned DESC, (CASE WHEN c.case_priority IS NULL THEN 999 ELSE c.case_priority END) ASC, c.last_message_at DESC";
    if (limit != null && limit > 0) {
      query += " LIMIT " + Math.min(Math.floor(limit), 2000);
      if (offset != null && offset > 0) query += " OFFSET " + Math.floor(offset);
    }
    const contacts = db.prepare(query).all(...params) as (Contact & { brand_name?: string; channel_name?: string; assigned_agent_name?: string; assigned_agent_avatar_url?: string | null })[];
    const t1 = Date.now();
    const contactIds = contacts.map((c) => c.id);
    const lastMessageByContact = new Map<number, { content: string; sender_type: string }>();
    if (contactIds.length > 0) {
      const placeholders = contactIds.map(() => "?").join(",");
      const lastRows = db.prepare(`
        SELECT m.contact_id, m.content, m.sender_type
        FROM messages m
        INNER JOIN (SELECT contact_id, MAX(id) AS max_id FROM messages WHERE contact_id IN (${placeholders}) GROUP BY contact_id) t
        ON m.contact_id = t.contact_id AND m.id = t.max_id
      `).all(...contactIds) as { contact_id: number; content: string; sender_type: string }[];
      for (const row of lastRows) lastMessageByContact.set(row.contact_id, { content: row.content, sender_type: row.sender_type });
    }
    const t2 = Date.now();
    const withPreview = contacts.map((c) => {
      const lastRow = lastMessageByContact.get(c.id);
      const rawType = lastRow?.sender_type;
      const senderType = (rawType != null && ["user", "ai", "admin", "system"].includes(String(rawType).toLowerCase()))
        ? (String(rawType).toLowerCase() as ContactWithPreview["last_message_sender_type"])
        : undefined;
      return { ...c, last_message: lastRow?.content || "", last_message_sender_type: senderType };
    });
    const agentId = assignedToUserId ?? agentIdForFlags;
    if (agentId != null && withPreview.length > 0) {
      const flags = this.getAgentContactFlags(agentId, withPreview.map((c) => c.id));
      const t3 = Date.now();
      const total = Date.now() - t0;
      if (total > 2000) {
        console.warn(`[contacts] getContacts slow: total=${total}ms db=${t1 - t0}ms lastMsg=${t2 - t1}ms flags=${t3 - t2}ms n=${contacts.length}`);
      }
      return withPreview.map((c) => ({ ...c, my_flag: flags[c.id] ?? null }));
    }
    const total = Date.now() - t0;
    if (total > 2000) {
      console.warn(`[contacts] getContacts slow: total=${total}ms db=${t1 - t0}ms lastMsg=${t2 - t1}ms n=${contacts.length}`);
    }
    return withPreview;
  }

  getContact(id: number): Contact | undefined {
    return db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Contact | undefined;
  }

  updateContactHumanFlag(id: number, needsHuman: number): void {
    db.prepare("UPDATE contacts SET needs_human = ? WHERE id = ?").run(needsHuman, id);
  }

  updateContactStatus(id: number, status: string): void {
    if (!CONTACT_STATUS_ALLOWED.includes(status as any)) {
      throw new Error(`不合法的 contact status: ${status}，允許值: ${CONTACT_STATUS_ALLOWED.join(", ")}`);
    }
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

  clearContactCsRating(id: number): void {
    db.prepare("UPDATE contacts SET cs_rating = NULL WHERE id = ?").run(id);
  }

  clearContactAiRating(id: number): void {
    db.prepare("UPDATE contacts SET ai_rating = NULL WHERE id = ?").run(id);
  }

  updateContactProfile(id: number, displayName: string, avatarUrl: string | null): void {
    db.prepare("UPDATE contacts SET display_name = ?, avatar_url = ? WHERE id = ?").run(displayName, avatarUrl, id);
  }

  getTagShortcuts(): { name: string; order: number }[] {
    try {
      const raw = this.getSetting("tag_shortcuts");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter((t: any) => t && typeof t.name === "string").map((t: any, i: number) => ({ name: String(t.name).trim(), order: typeof t.order === "number" ? t.order : i }));
    } catch {
      return [];
    }
  }

  setTagShortcuts(tags: { name: string; order: number }[]): void {
    const valid = tags.filter((t) => t && typeof t.name === "string").map((t, i) => ({ name: String(t.name).trim(), order: typeof t.order === "number" ? t.order : i }));
    this.setSetting("tag_shortcuts", JSON.stringify(valid));
  }

  updateContactAiSuggestions(id: number, suggestions: { issue_type?: string; status?: string; priority?: string; tags?: string[] }): void {
    const json = JSON.stringify(suggestions);
    db.prepare("UPDATE contacts SET ai_suggestions = ? WHERE id = ?").run(json, id);
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

  /** 取得對話紀錄，支援分頁。預設回傳最近 500 筆（避免一次載入過多）。 */
  getMessages(contactId: number, options?: { limit?: number; beforeId?: number }): Message[] {
    const limit = Math.min(Math.max(options?.limit ?? 500, 1), 2000);
    if (options?.beforeId != null) {
      const rows = db.prepare("SELECT * FROM messages WHERE contact_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(contactId, options.beforeId, limit) as Message[];
      return rows.reverse();
    }
    const rows = db.prepare("SELECT * FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT ?").all(contactId, limit) as Message[];
    return rows.reverse();
  }

  getMessagesSince(contactId: number, sinceId: number): Message[] {
    return db.prepare("SELECT * FROM messages WHERE contact_id = ? AND id > ? ORDER BY id ASC LIMIT 500").all(contactId, sinceId) as Message[];
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
      contact = { id: Number(result.lastInsertRowid), platform, platform_user_id: platformUserId, display_name: displayName, avatar_url: null, needs_human: 0, is_pinned: 0, status: "pending", tags: "[]", vip_level: 0, order_count: 0, total_spent: 0, cs_rating: null, ai_rating: null, last_message_at: null, created_at: now, brand_id: brandId || null, channel_id: channelId || null, issue_type: null, order_source: null, assigned_agent_id: null, intent_level: null, order_number_type: null, first_assigned_at: null, closed_at: null, closed_by_agent_id: null, case_priority: null };
    } else {
      // 每次有帶入 brand/channel（例如 Webhook 匹配到渠道）就更新，讓「這則訊息從哪個渠道來」為準，避免錯歸一次就永遠錯
      let needsUpdate = false;
      let newBrandId = contact.brand_id;
      let newChannelId = contact.channel_id;
      if (brandId != null && contact.brand_id !== brandId) {
        newBrandId = brandId;
        needsUpdate = true;
      }
      if (channelId != null && contact.channel_id !== channelId) {
        newChannelId = channelId;
        needsUpdate = true;
      }
      if (needsUpdate) {
        db.prepare("UPDATE contacts SET brand_id = ?, channel_id = ? WHERE id = ?").run(newBrandId ?? null, newChannelId ?? null, contact.id);
        contact.brand_id = newBrandId ?? null;
        contact.channel_id = newChannelId ?? null;
      }
    }
    return contact as Contact;
  }

  /** 將指定 channel 下所有聯絡人改歸到指定品牌，並把 channel_id 改為該品牌同平台的渠道（若有），避免 brand 與 channel 不同步導致列表異常 */
  reassignContactsByChannel(channelId: number, brandId: number): number {
    const fromChannel = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as { platform?: string } | undefined;
    const targetChannels = db.prepare("SELECT * FROM channels WHERE brand_id = ? ORDER BY id ASC").all(brandId) as { id: number; platform?: string }[];
    const samePlatform = fromChannel?.platform
      ? targetChannels.find((c) => c.platform === fromChannel.platform)
      : targetChannels[0];
    const newChannelId = samePlatform?.id ?? null;
    const result = db.prepare("UPDATE contacts SET brand_id = ?, channel_id = ? WHERE channel_id = ?").run(brandId, newChannelId, channelId);
    return result.changes;
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

  createAiLog(data: {
    contact_id?: number;
    message_id?: number;
    brand_id?: number;
    prompt_summary: string;
    knowledge_hits: string[];
    tools_called: string[];
    transfer_triggered: boolean;
    transfer_reason?: string;
    result_summary: string;
    token_usage: number;
    model: string;
    response_time_ms: number;
    reply_source?: string;
    used_llm?: number;
    plan_mode?: string | null;
    reason_if_bypassed?: string | null;
  }): AiLog {
    const result = db.prepare(`
      INSERT INTO ai_logs (contact_id, message_id, brand_id, prompt_summary, knowledge_hits, tools_called, transfer_triggered, transfer_reason, result_summary, token_usage, model, response_time_ms, reply_source, used_llm, plan_mode, reason_if_bypassed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.contact_id || null,
      data.message_id || null,
      data.brand_id || null,
      data.prompt_summary,
      JSON.stringify(data.knowledge_hits),
      JSON.stringify(data.tools_called),
      data.transfer_triggered ? 1 : 0,
      data.transfer_reason || null,
      data.result_summary,
      data.token_usage,
      data.model,
      data.response_time_ms,
      data.reply_source ?? "",
      data.used_llm ?? 0,
      data.plan_mode ?? null,
      data.reason_if_bypassed ?? null
    );
    return db.prepare("SELECT * FROM ai_logs WHERE id = ?").get(Number(result.lastInsertRowid)) as AiLog;
  }

  getAiLogs(contactId: number): AiLog[] {
    return db.prepare("SELECT * FROM ai_logs WHERE contact_id = ? ORDER BY created_at DESC LIMIT 50").all(contactId) as AiLog[];
  }

  getAiLogStats(startDate: string, endDate: string, brandId?: number): {
    totalAiResponses: number;
    transferTriggered: number;
    avgResponseTime: number;
    toolCallCount: number;
    orderQueryCount: number;
    orderQuerySuccess: number;
    transferReasons: { reason: string; count: number }[];
  } {
    const brandFilter = brandId ? " AND brand_id = ?" : "";
    const brandParam = brandId ? [brandId] : [];

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN transfer_triggered = 1 THEN 1 ELSE 0 END) as transfers,
        AVG(response_time_ms) as avg_time,
        SUM(CASE WHEN tools_called != '[]' THEN 1 ELSE 0 END) as tool_calls
      FROM ai_logs
      WHERE created_at >= ? AND created_at <= ?${brandFilter}
    `).get(startDate, endDate, ...brandParam) as any;

    const orderStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN result_summary LIKE '%found%' OR result_summary LIKE '%查到%' OR result_summary LIKE '%success%' THEN 1 ELSE 0 END) as success
      FROM ai_logs
      WHERE tools_called LIKE '%lookup_order%' AND created_at >= ? AND created_at <= ?${brandFilter}
    `).get(startDate, endDate, ...brandParam) as any;

    const reasons = db.prepare(`
      SELECT transfer_reason as reason, COUNT(*) as count
      FROM ai_logs
      WHERE transfer_triggered = 1 AND transfer_reason IS NOT NULL AND created_at >= ? AND created_at <= ?${brandFilter}
      GROUP BY transfer_reason
      ORDER BY count DESC
      LIMIT 10
    `).all(startDate, endDate, ...brandParam) as { reason: string; count: number }[];

    return {
      totalAiResponses: stats?.total || 0,
      transferTriggered: stats?.transfers || 0,
      avgResponseTime: Math.round(stats?.avg_time || 0),
      toolCallCount: stats?.tool_calls || 0,
      orderQueryCount: orderStats?.total || 0,
      orderQuerySuccess: orderStats?.success || 0,
      transferReasons: reasons,
    };
  }

  updateContactIssueType(id: number, issueType: string | null): void {
    db.prepare("UPDATE contacts SET issue_type = ? WHERE id = ?").run(issueType, id);
  }

  updateContactOrderSource(id: number, orderSource: string): void {
    db.prepare("UPDATE contacts SET order_source = ? WHERE id = ?").run(orderSource, id);
  }

  linkOrderForContact(contactId: number, globalOrderId: string, source: "manual" | "ai_lookup" = "ai_lookup"): void {
    try {
      db.prepare(
        "INSERT OR IGNORE INTO contact_order_links (contact_id, global_order_id, source) VALUES (?, ?, ?)"
      ).run(contactId, (globalOrderId || "").trim().toUpperCase(), source);
    } catch (_e) { /* ignore */ }
  }

  getActiveOrderContext(contactId: number): ActiveOrderContext | null {
    const row = db.prepare(
      "SELECT order_id, matched_by, matched_confidence, payload, last_fetched_at FROM contact_active_order WHERE contact_id = ?"
    ).get(contactId) as { order_id: string; matched_by: string; matched_confidence: string | null; payload: string; last_fetched_at: string } | undefined;
    if (!row?.payload) return null;
    try {
      const payload = JSON.parse(row.payload) as Omit<ActiveOrderContext, "order_id" | "matched_by" | "matched_confidence" | "last_fetched_at">;
      return {
        order_id: row.order_id,
        matched_by: row.matched_by as ActiveOrderContext["matched_by"],
        matched_confidence: (row.matched_confidence as ActiveOrderContext["matched_confidence"]) ?? undefined,
        last_fetched_at: row.last_fetched_at,
        ...payload,
      };
    } catch {
      return null;
    }
  }

  setActiveOrderContext(contactId: number, ctx: ActiveOrderContext): void {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const { order_id, matched_by, matched_confidence, last_fetched_at, ...rest } = ctx;
    const payload = JSON.stringify(rest);
    db.prepare(`
      INSERT INTO contact_active_order (contact_id, order_id, matched_by, matched_confidence, payload, last_fetched_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET
        order_id = excluded.order_id,
        matched_by = excluded.matched_by,
        matched_confidence = excluded.matched_confidence,
        payload = excluded.payload,
        last_fetched_at = excluded.last_fetched_at,
        updated_at = excluded.updated_at
    `).run(contactId, order_id, matched_by, matched_confidence ?? null, payload, last_fetched_at, now);
  }

  clearActiveOrderContext(contactId: number): void {
    db.prepare("DELETE FROM contact_active_order WHERE contact_id = ?").run(contactId);
  }

  setAiMutedUntil(id: number, until: string): void {
    db.prepare("UPDATE contacts SET ai_muted_until = ? WHERE id = ?").run(until, id);
  }

  isAiMuted(id: number): boolean {
    const row = db.prepare("SELECT ai_muted_until FROM contacts WHERE id = ?").get(id) as { ai_muted_until: string | null } | undefined;
    if (!row?.ai_muted_until) return false;
    return new Date(row.ai_muted_until) > new Date();
  }

  clearAiMuted(id: number): void {
    db.prepare("UPDATE contacts SET ai_muted_until = NULL WHERE id = ?").run(id);
  }

  resetConsecutiveTimeouts(id: number): void {
    db.prepare("UPDATE contacts SET consecutive_timeouts = 0 WHERE id = ?").run(id);
  }

  incrementConsecutiveTimeouts(id: number): number {
    db.prepare("UPDATE contacts SET consecutive_timeouts = consecutive_timeouts + 1 WHERE id = ?").run(id);
    const row = db.prepare("SELECT consecutive_timeouts FROM contacts WHERE id = ?").get(id) as { consecutive_timeouts: number } | undefined;
    return row?.consecutive_timeouts || 1;
  }

  createSystemAlert(data: { alert_type: string; details: string; brand_id?: number; contact_id?: number }): void {
    db.prepare("INSERT INTO system_alerts (alert_type, details, brand_id, contact_id) VALUES (?, ?, ?, ?)").run(
      data.alert_type, data.details, data.brand_id || null, data.contact_id || null
    );
  }

  getSystemAlertStats(startDate: string, endDate: string, brandId?: number): {
    webhookSigFails: number;
    dedupeHits: number;
    lockTimeouts: number;
    orderLookupFails: number;
    timeoutEscalations: number;
    totalAlerts: number;
    transferReasonTop5: { reason: string; count: number }[];
    alertsByType: { type: string; count: number }[];
  } {
    const brandFilter = brandId ? " AND brand_id = ?" : "";
    const params = brandId ? [startDate, endDate, brandId] : [startDate, endDate];

    const countByType = (type: string) => {
      const row = db.prepare(`SELECT COUNT(*) as count FROM system_alerts WHERE alert_type = ? AND created_at >= ? AND created_at <= ?${brandFilter}`).get(type, ...params) as { count: number };
      return row?.count || 0;
    };

    const totalRow = db.prepare(`SELECT COUNT(*) as count FROM system_alerts WHERE created_at >= ? AND created_at <= ?${brandFilter}`).get(...params) as { count: number };

    const transferReasons = db.prepare(`
      SELECT details as reason, COUNT(*) as count FROM system_alerts
      WHERE alert_type = 'transfer' AND created_at >= ? AND created_at <= ?${brandFilter}
      GROUP BY details ORDER BY count DESC LIMIT 5
    `).all(...params) as { reason: string; count: number }[];

    const alertsByType = db.prepare(`
      SELECT alert_type as type, COUNT(*) as count FROM system_alerts
      WHERE created_at >= ? AND created_at <= ?${brandFilter}
      GROUP BY alert_type ORDER BY count DESC
    `).all(...params) as { type: string; count: number }[];

    return {
      webhookSigFails: countByType("webhook_sig_fail"),
      dedupeHits: countByType("dedupe_hit"),
      lockTimeouts: countByType("lock_timeout"),
      orderLookupFails: countByType("order_lookup_fail"),
      timeoutEscalations: countByType("timeout_escalation"),
      totalAlerts: totalRow?.count || 0,
      transferReasonTop5: transferReasons,
      alertsByType,
    };
  }

  getAgentStatus(userId: number): AgentStatus | undefined {
    return db.prepare("SELECT * FROM agent_status WHERE user_id = ?").get(userId) as AgentStatus | undefined;
  }

  upsertAgentStatus(data: Partial<AgentStatus> & { user_id: number }): void {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const existing = db.prepare("SELECT user_id FROM agent_status WHERE user_id = ?").get(data.user_id);
    const cols = ["priority", "on_duty", "lunch_break", "pause_new_cases", "today_assigned_count", "open_cases_count", "work_start_time", "work_end_time", "lunch_start_time", "lunch_end_time", "max_active_conversations", "auto_assign_enabled", "updated_at"];
    const vals = [
      data.priority ?? 1,
      data.on_duty ?? 1,
      data.lunch_break ?? 0,
      data.pause_new_cases ?? 0,
      data.today_assigned_count ?? 0,
      data.open_cases_count ?? 0,
      data.work_start_time ?? "09:00",
      data.work_end_time ?? "18:00",
      data.lunch_start_time ?? "12:00",
      data.lunch_end_time ?? "13:00",
      data.max_active_conversations ?? 10,
      data.auto_assign_enabled ?? 1,
      now,
    ];
    if (existing) {
      db.prepare(`UPDATE agent_status SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE user_id = ?`).run(...vals, data.user_id);
    } else {
      db.prepare(`INSERT INTO agent_status (user_id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`).run(data.user_id, ...vals);
    }
  }

  getAssignmentHistory(contactId: number): AssignmentRecord[] {
    return db.prepare("SELECT * FROM assignment_history WHERE contact_id = ? ORDER BY assigned_at ASC").all(contactId) as AssignmentRecord[];
  }

  createAssignmentRecord(
    contactId: number,
    assignedToAgentId: number,
    assignedByAgentId: number | null,
    reassignedFromAgentId: number | null,
    note: string | null,
    actionType?: string | null,
    operatorUserId?: number | null
  ): AssignmentRecord {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const hasExtra = actionType != null || operatorUserId != null;
    if (hasExtra) {
      const result = db.prepare(
        "INSERT INTO assignment_history (contact_id, assigned_to_agent_id, assigned_by_agent_id, reassigned_from_agent_id, note, action_type, operator_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(contactId, assignedToAgentId, assignedByAgentId, reassignedFromAgentId, note, actionType ?? null, operatorUserId ?? null);
      return {
        id: Number(result.lastInsertRowid),
        contact_id: contactId,
        assigned_to_agent_id: assignedToAgentId,
        assigned_at: now,
        assigned_by_agent_id: assignedByAgentId,
        reassigned_from_agent_id: reassignedFromAgentId,
        note,
        action_type: actionType ?? null,
        operator_user_id: operatorUserId ?? null,
      };
    }
    const result = db.prepare(
      "INSERT INTO assignment_history (contact_id, assigned_to_agent_id, assigned_by_agent_id, reassigned_from_agent_id, note) VALUES (?, ?, ?, ?, ?)"
    ).run(contactId, assignedToAgentId, assignedByAgentId, reassignedFromAgentId, note);
    return {
      id: Number(result.lastInsertRowid),
      contact_id: contactId,
      assigned_to_agent_id: assignedToAgentId,
      assigned_at: now,
      assigned_by_agent_id: assignedByAgentId,
      reassigned_from_agent_id: reassignedFromAgentId,
      note,
    };
  }

  updateContactAssignment(
    contactId: number,
    assignedAgentId: number | null,
    firstAssignedAt?: string,
    assignmentMethod?: string | null,
    needsAssignment?: number,
    assignmentReason?: string | null,
    responseSlaDeadlineAt?: string | null
  ): void {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    if (assignedAgentId == null) {
      db.prepare(
        "UPDATE contacts SET assigned_agent_id = NULL, assigned_at = NULL, assignment_status = ?, assignment_method = NULL, needs_assignment = ? WHERE id = ?"
      ).run("unassigned", needsAssignment ?? 1, contactId);
      return;
    }
    if (firstAssignedAt !== undefined) {
      db.prepare(
        "UPDATE contacts SET assigned_agent_id = ?, first_assigned_at = ?, assigned_at = ?, assignment_status = 'assigned', assignment_method = ?, needs_assignment = 0, assignment_reason = ?, response_sla_deadline_at = ? WHERE id = ?"
      ).run(
        assignedAgentId,
        firstAssignedAt || null,
        now,
        assignmentMethod ?? "auto",
        assignmentReason ?? null,
        responseSlaDeadlineAt ?? null,
        contactId
      );
    } else {
      db.prepare(
        "UPDATE contacts SET assigned_agent_id = ?, assigned_at = ?, assignment_status = 'assigned', assignment_method = ? WHERE id = ?"
      ).run(assignedAgentId, now, assignmentMethod ?? "reassign", contactId);
    }
  }

  getOpenCasesCountForAgent(agentId: number): number {
    const row = db.prepare(
      "SELECT COUNT(*) as count FROM contacts WHERE assigned_agent_id = ? AND status NOT IN ('closed', 'resolved')"
    ).get(agentId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** 最後一則訊息的 sender_type：用於 overdue / pending_reply / vip_unhandled 的 COUNT。 */
  private static lastMessageSenderSubquery(): string {
    return `(SELECT m.sender_type FROM messages m INNER JOIN (SELECT contact_id, MAX(id) AS mid FROM messages GROUP BY contact_id) t ON m.contact_id = t.contact_id AND m.id = t.mid WHERE m.contact_id = c.id)`;
  }

  getManagerStatsCounts(brandId?: number): { today_new: number; unassigned: number; closed_today: number; overdue: number; urgent_simple: number; vip_unhandled: number } {
    const today = new Date().toISOString().slice(0, 10);
    const brandCond = brandId != null ? " c.brand_id = ? " : " 1=1 ";
    const params = brandId != null ? [brandId] : [];
    const todayNewRow = db.prepare(
      `SELECT COUNT(*) as c FROM contacts c WHERE ${brandCond} AND date(c.created_at) = ?`
    ).get(...params, today) as { c: number };
    const unassignedRow = db.prepare(
      `SELECT COUNT(*) as c FROM contacts c WHERE ${brandCond} AND c.needs_human = 1 AND (c.assigned_agent_id IS NULL OR c.assigned_agent_id = 0)`
    ).get(...params) as { c: number };
    const closedTodayRow = db.prepare(
      `SELECT COUNT(*) as c FROM contacts c WHERE ${brandCond} AND c.status IN ('closed','resolved') AND c.closed_at IS NOT NULL AND date(c.closed_at) = ?`
    ).get(...params, today) as { c: number };
    const lastSender = SQLiteStorage.lastMessageSenderSubquery();
    const overdueRow = db.prepare(
      `SELECT COUNT(*) as c FROM contacts c WHERE ${brandCond} AND c.status NOT IN ('closed','resolved') AND c.last_message_at IS NOT NULL AND datetime(c.last_message_at) <= datetime('now','-1 hour') AND LOWER(${lastSender}) = 'user'`
    ).get(...params) as { c: number };
    const urgentRow = db.prepare(
      `SELECT COUNT(*) as c FROM contacts c WHERE ${brandCond} AND c.status NOT IN ('closed','resolved') AND (c.status = 'high_risk' OR (c.case_priority IS NOT NULL AND c.case_priority <= 2))`
    ).get(...params) as { c: number };
    const vipRow = db.prepare(
      `SELECT COUNT(*) as c FROM contacts c WHERE ${brandCond} AND c.status NOT IN ('closed','resolved') AND c.vip_level > 0 AND LOWER(${lastSender}) = 'user'`
    ).get(...params) as { c: number };
    return {
      today_new: todayNewRow?.c ?? 0,
      unassigned: unassignedRow?.c ?? 0,
      closed_today: closedTodayRow?.c ?? 0,
      overdue: overdueRow?.c ?? 0,
      urgent_simple: urgentRow?.c ?? 0,
      vip_unhandled: vipRow?.c ?? 0,
    };
  }

  getAgentStatsCounts(agentId: number): { pending_reply: number; closed_today: number; overdue: number; tracking: number; urgent_simple: number } {
    const today = new Date().toISOString().slice(0, 10);
    const lastSender = SQLiteStorage.lastMessageSenderSubquery();
    const pendingRow = db.prepare(
      `SELECT COUNT(*) as c FROM contacts c WHERE c.assigned_agent_id = ? AND c.status NOT IN ('closed','resolved') AND LOWER(${lastSender}) = 'user'`
    ).get(agentId) as { c: number };
    const closedTodayRow = db.prepare(
      "SELECT COUNT(*) as c FROM contacts WHERE assigned_agent_id = ? AND status IN ('closed','resolved') AND closed_at IS NOT NULL AND date(closed_at) = ?"
    ).get(agentId, today) as { c: number };
    const overdueRow = db.prepare(
      `SELECT COUNT(*) as c FROM contacts c WHERE c.assigned_agent_id = ? AND c.status NOT IN ('closed','resolved') AND c.last_message_at IS NOT NULL AND datetime(c.last_message_at) <= datetime('now','-1 hour') AND LOWER(${lastSender}) = 'user'`
    ).get(agentId) as { c: number };
    const trackingRow = db.prepare(
      "SELECT COUNT(*) as c FROM agent_contact_flags WHERE agent_id = ? AND flag = 'tracking'"
    ).get(agentId) as { c: number };
    const urgentRow = db.prepare(
      "SELECT COUNT(*) as c FROM contacts WHERE assigned_agent_id = ? AND status NOT IN ('closed','resolved') AND (status = 'high_risk' OR (case_priority IS NOT NULL AND case_priority <= 2))"
    ).get(agentId) as { c: number };
    return {
      pending_reply: pendingRow?.c ?? 0,
      closed_today: closedTodayRow?.c ?? 0,
      overdue: overdueRow?.c ?? 0,
      tracking: trackingRow?.c ?? 0,
      urgent_simple: urgentRow?.c ?? 0,
    };
  }

  getAgentPendingReplyCount(agentId: number): number {
    const lastSender = SQLiteStorage.lastMessageSenderSubquery();
    const row = db.prepare(
      `SELECT COUNT(*) as c FROM contacts c WHERE c.assigned_agent_id = ? AND c.status NOT IN ('closed','resolved') AND LOWER(${lastSender}) = 'user'`
    ).get(agentId) as { c: number };
    return row?.c ?? 0;
  }

  incrementAgentTodayAssigned(agentId: number): void {
    db.prepare("UPDATE agent_status SET today_assigned_count = today_assigned_count + 1, updated_at = datetime('now') WHERE user_id = ?").run(agentId);
  }

  resetAgentDailyCountsIfNewDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    const rows = db.prepare("SELECT user_id, updated_at FROM agent_status").all() as { user_id: number; updated_at: string }[];
    for (const r of rows) {
      const updatedDate = r.updated_at?.slice(0, 10) || "";
      if (updatedDate && updatedDate !== today) {
        db.prepare("UPDATE agent_status SET today_assigned_count = 0, updated_at = datetime('now') WHERE user_id = ?").run(r.user_id);
      }
    }
  }

  updateContactIntentLevel(contactId: number, level: string | null): void {
    db.prepare("UPDATE contacts SET intent_level = ? WHERE id = ?").run(level, contactId);
  }

  updateContactOrderNumberType(contactId: number, type: string | null): void {
    db.prepare("UPDATE contacts SET order_number_type = ? WHERE id = ?").run(type, contactId);
  }

  updateContactCasePriority(contactId: number, priority: number | null): void {
    db.prepare("UPDATE contacts SET case_priority = ? WHERE id = ?").run(priority, contactId);
  }

  updateContactClosed(contactId: number, closedByAgentId: number, closeReason?: string | null): void {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const reason = closeReason ?? null;
    try {
      db.prepare("UPDATE contacts SET closed_at = ?, closed_by_agent_id = ?, status = 'closed', close_reason = ? WHERE id = ?").run(now, closedByAgentId, reason, contactId);
    } catch (_e) {
      db.prepare("UPDATE contacts SET closed_at = ?, closed_by_agent_id = ?, status = 'closed' WHERE id = ?").run(now, closedByAgentId, contactId);
    }
  }

  /** 更新對話狀態／結案／評價／QA 等欄位（僅更新傳入的鍵） */
  updateContactConversationFields(contactId: number, fields: {
    resolution_status?: string | null;
    waiting_for_customer?: string | null;
    human_reason?: string | null;
    return_stage?: number | null;
    rating_invited_at?: string | null;
    close_reason?: string | null;
    qa_score?: number | null;
    qa_score_reason?: string | null;
    product_scope_locked?: string | null;
    customer_goal_locked?: string | null;
  }): void {
    const allowed = ["resolution_status", "waiting_for_customer", "human_reason", "return_stage", "rating_invited_at", "close_reason", "qa_score", "qa_score_reason", "product_scope_locked", "customer_goal_locked"];
    const setParts: string[] = [];
    const values: any[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      setParts.push(`${k} = ?`);
      values.push(v ?? null);
    }
    if (setParts.length === 0) return;
    values.push(contactId);
    try {
      db.prepare(`UPDATE contacts SET ${setParts.join(", ")} WHERE id = ?`).run(...values);
    } catch (_e) { /* 欄位可能尚未 migrate */ }
  }

  getUnreadHumanCaseCount(): number {
    const row = db.prepare(
      "SELECT COUNT(*) as count FROM case_notifications WHERE read_at IS NULL"
    ).get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  markCaseNotificationsRead(contactId?: number): void {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    if (contactId != null) {
      db.prepare("UPDATE case_notifications SET read_at = ? WHERE contact_id = ? AND read_at IS NULL").run(now, contactId);
    } else {
      db.prepare("UPDATE case_notifications SET read_at = ? WHERE read_at IS NULL").run(now);
    }
  }

  createCaseNotification(contactId: number, channel: string = "in_app"): void {
    db.prepare("INSERT INTO case_notifications (contact_id, channel) VALUES (?, ?)").run(contactId, channel);
  }

  updateUserOnline(userId: number, isOnline: number, isAvailable?: number): void {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    if (isAvailable !== undefined) {
      db.prepare("UPDATE users SET is_online = ?, is_available = ?, last_active_at = ? WHERE id = ?").run(isOnline, isAvailable, now, userId);
    } else {
      db.prepare("UPDATE users SET is_online = ?, last_active_at = ? WHERE id = ?").run(isOnline, now, userId);
    }
  }

  updateUserLastActive(userId: number): void {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now, userId);
  }

  getAgentContactFlags(agentId: number, contactIds: number[]): Record<number, "later" | "tracking"> {
    const out: Record<number, "later" | "tracking"> = {};
    if (contactIds.length === 0) return out;
    const placeholders = contactIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT contact_id, flag FROM agent_contact_flags WHERE agent_id = ? AND contact_id IN (${placeholders})`).all(agentId, ...contactIds) as { contact_id: number; flag: string }[];
    for (const r of rows) {
      if (r.flag === "later" || r.flag === "tracking") out[r.contact_id] = r.flag;
    }
    return out;
  }

  setAgentContactFlag(agentId: number, contactId: number, flag: "later" | "tracking" | null): void {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    if (flag == null) {
      db.prepare("DELETE FROM agent_contact_flags WHERE agent_id = ? AND contact_id = ?").run(agentId, contactId);
    } else {
      db.prepare("INSERT INTO agent_contact_flags (agent_id, contact_id, flag, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, contact_id) DO UPDATE SET flag = ?, updated_at = ?").run(agentId, contactId, flag, now, flag, now);
    }
  }

  updateUserAvatar(userId: number, avatarUrl: string | null): void {
    db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatarUrl, userId);
  }

  updateContactLastHumanReply(contactId: number): void {
    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    db.prepare("UPDATE contacts SET last_human_reply_at = ? WHERE id = ?").run(now, contactId);
  }

  incrementContactReassignCount(contactId: number): void {
    db.prepare("UPDATE contacts SET reassign_count = COALESCE(reassign_count, 0) + 1 WHERE id = ?").run(contactId);
  }

  updateContactAssignmentStatus(contactId: number, status: string): void {
    db.prepare("UPDATE contacts SET assignment_status = ? WHERE id = ?").run(status, contactId);
  }

  updateContactNeedsAssignment(contactId: number, value: number): void {
    db.prepare("UPDATE contacts SET needs_assignment = ? WHERE id = ?").run(value, contactId);
  }

  getGlobalSchedule(): { work_start_time: string; work_end_time: string; lunch_start_time: string; lunch_end_time: string } {
    const workStart = this.getSetting("work_start_time") || "09:00";
    const workEnd = this.getSetting("work_end_time") || "18:00";
    const lunchStart = this.getSetting("lunch_start_time") || "12:30";
    const lunchEnd = this.getSetting("lunch_end_time") || "13:30";
    return { work_start_time: workStart, work_end_time: workEnd, lunch_start_time: lunchStart, lunch_end_time: lunchEnd };
  }

  getSlaMinutes(): number {
    const v = this.getSetting("human_first_reply_sla_minutes");
    const n = parseInt(v || "10", 10);
    return isNaN(n) || n < 1 ? 10 : Math.min(n, 120);
  }

  getAssignmentAutoEnabled(): boolean {
    return this.getSetting("assignment_auto_enabled") !== "0";
  }

  getAssignmentTimeoutReassignEnabled(): boolean {
    return this.getSetting("assignment_timeout_reassign_enabled") !== "0";
  }

  getAgentPerformanceStats(agentId: number): {
    today_new: number;
    open_cases: number;
    processing: number;
    closed_today: number;
    closed_total: number;
    avg_first_reply_minutes: number | null;
    avg_close_minutes: number | null;
    close_rate: number | null;
    resolve_rate: number | null;
  } {
    const today = new Date().toISOString().slice(0, 10);
    const todayNewRow = db.prepare(
      "SELECT COUNT(*) as c FROM contacts WHERE assigned_agent_id = ? AND date(first_assigned_at) = date(?)"
    ).get(agentId, today) as { c: number };
    const openCases = this.getOpenCasesCountForAgent(agentId);
    const processingRow = db.prepare(
      "SELECT COUNT(*) as c FROM contacts WHERE assigned_agent_id = ? AND status IN ('assigned','processing','waiting_customer')"
    ).get(agentId) as { c: number };
    const closedTodayRow = db.prepare(
      "SELECT COUNT(*) as c FROM contacts WHERE closed_by_agent_id = ? AND date(closed_at) = date(?)"
    ).get(agentId, today) as { c: number };
    const closedTotalRow = db.prepare(
      "SELECT COUNT(*) as c FROM contacts WHERE closed_by_agent_id = ?"
    ).get(agentId) as { c: number };
    const closedTotal = closedTotalRow?.c ?? 0;
    const totalHandled = closedTotal + openCases;
    const closeRate = totalHandled > 0 ? closedTotal / totalHandled : null;
    let avgFirstReply: number | null = null;
    let avgClose: number | null = null;
    const firstReplyRows = db.prepare(`
      SELECT c.id, c.first_assigned_at,
             (SELECT MIN(m.created_at) FROM messages m WHERE m.contact_id = c.id AND m.sender_type = 'admin' AND m.created_at >= c.first_assigned_at) as first_admin_at
      FROM contacts c WHERE c.assigned_agent_id = ? AND c.first_assigned_at IS NOT NULL
    `).all(agentId) as { id: number; first_assigned_at: string; first_admin_at: string | null }[];
    const diffs = firstReplyRows.filter((r) => r.first_admin_at).map((r) => (new Date(r.first_admin_at!).getTime() - new Date(r.first_assigned_at).getTime()) / 60000);
    if (diffs.length > 0) avgFirstReply = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const closeTimeRows = db.prepare(
      "SELECT first_assigned_at, closed_at FROM contacts WHERE closed_by_agent_id = ? AND closed_at IS NOT NULL AND first_assigned_at IS NOT NULL"
    ).all(agentId) as { first_assigned_at: string; closed_at: string }[];
    const closeDiffs = closeTimeRows.map((r) => (new Date(r.closed_at).getTime() - new Date(r.first_assigned_at).getTime()) / 60000);
    if (closeDiffs.length > 0) avgClose = closeDiffs.reduce((a, b) => a + b, 0) / closeDiffs.length;
    return {
      today_new: todayNewRow?.c ?? 0,
      open_cases: openCases,
      processing: processingRow?.c ?? 0,
      closed_today: closedTodayRow?.c ?? 0,
      closed_total: closedTotal,
      avg_first_reply_minutes: avgFirstReply,
      avg_close_minutes: avgClose,
      close_rate: closeRate,
      resolve_rate: closeRate,
    };
  }

  getSupervisorReport(): {
    today_total: number;
    pending_count: number;
    transfer_count: number;
    lunch_pending_count: number;
    by_agent: { agent_id: number; display_name: string; today_assigned: number; open_cases: number; closed_today: number }[];
    tag_rank: { tag: string; count: number }[];
    category_ratio: { label: string; count: number }[];
  } {
    const today = new Date().toISOString().slice(0, 10);
    const todayTotalRow = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE date(created_at) = date(?)").get(today) as { c: number };
    const pendingRow = db.prepare(
      "SELECT COUNT(*) as c FROM contacts WHERE status IN ('awaiting_human','pending','new_case','pending_info','pending_order_id') AND (status != 'closed' AND status != 'resolved')"
    ).get() as { c: number };
    const transferRow = db.prepare(
      "SELECT COUNT(*) as c FROM contacts WHERE needs_human = 1 AND date(created_at) <= date(?)"
    ).get(today) as { c: number };
    const members = this.getTeamMembers().filter((m) => m.role === "cs_agent");
    const byAgent = members.map((m) => {
      const todayAssignedRow = db.prepare(
        "SELECT COUNT(*) as c FROM contacts WHERE assigned_agent_id = ? AND date(first_assigned_at) = date(?)"
      ).get(m.id, today) as { c: number };
      const openCases = this.getOpenCasesCountForAgent(m.id);
      const closedTodayRow = db.prepare(
        "SELECT COUNT(*) as c FROM contacts WHERE closed_by_agent_id = ? AND date(closed_at) = date(?)"
      ).get(m.id, today) as { c: number };
      return {
        agent_id: m.id,
        display_name: m.display_name,
        today_assigned: todayAssignedRow?.c ?? 0,
        open_cases: openCases,
        closed_today: closedTodayRow?.c ?? 0,
      };
    });
    const contacts = db.prepare("SELECT tags FROM contacts").all() as { tags: string }[];
    const tagCount: Record<string, number> = {};
    for (const c of contacts) {
      try {
        const arr = JSON.parse(c.tags || "[]");
        for (const t of arr) {
          tagCount[t] = (tagCount[t] || 0) + 1;
        }
      } catch (_) {}
    }
    const tagRank = Object.entries(tagCount).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 10);
    const categoryLabels = ["訂單查詢", "出貨延遲", "缺貨/欠貨", "退款/取消", "商品諮詢", "優惠詢問", "客訴"];
    const categoryRatio = categoryLabels.map((label) => {
      const count = contacts.filter((c) => {
        try {
          const arr = JSON.parse(c.tags || "[]");
          return arr.includes(label);
        } catch (_) {
          return false;
        }
      }).length;
      return { label, count };
    }).filter((r) => r.count > 0);
    return {
      today_total: todayTotalRow?.c ?? 0,
      pending_count: pendingRow?.c ?? 0,
      transfer_count: transferRow?.c ?? 0,
      lunch_pending_count: 0,
      by_agent: byAgent,
      tag_rank: tagRank,
      category_ratio: categoryRatio,
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
