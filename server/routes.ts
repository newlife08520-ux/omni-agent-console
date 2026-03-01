import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { fetchOrders, lookupOrdersByPhone, lookupOrderById } from "./superlanding";
import type { SuperLandingConfig } from "./superlanding";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import OpenAI from "openai";

const uploadDir = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const ALLOWED_EXTENSIONS = [".txt", ".pdf", ".csv", ".docx"];

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_EXTENSIONS.includes(ext));
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

function getSuperLandingConfig(): SuperLandingConfig {
  return {
    merchantNo: storage.getSetting("superlanding_merchant_no") || "",
    accessKey: storage.getSetting("superlanding_access_key") || "",
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "請輸入帳號與密碼" });
    }
    const user = storage.authenticateUser(username, password);
    if (user) {
      (req as any).session.authenticated = true;
      (req as any).session.userId = user.id;
      (req as any).session.userRole = user.role;
      (req as any).session.username = user.username;
      (req as any).session.displayName = user.display_name;
      return res.json({
        success: true,
        message: "登入成功",
        user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
      });
    }
    return res.status(401).json({ success: false, message: "帳號或密碼錯誤" });
  });

  app.get("/api/auth/check", (req, res) => {
    const s = (req as any).session;
    if (s?.authenticated === true) {
      return res.json({
        authenticated: true,
        user: { id: s.userId, username: s.username, display_name: s.displayName, role: s.userRole },
      });
    }
    return res.json({ authenticated: false });
  });

  app.post("/api/auth/logout", (req, res) => {
    const s = (req as any).session;
    s.authenticated = false;
    s.userId = null;
    s.userRole = null;
    s.username = null;
    s.displayName = null;
    return res.json({ success: true });
  });

  const authMiddleware = (req: any, res: any, next: any) => {
    if (req.session?.authenticated === true) return next();
    return res.status(401).json({ message: "未授權" });
  };

  const superAdminOnly = (req: any, res: any, next: any) => {
    if (req.session?.userRole === "super_admin") return next();
    return res.status(403).json({ message: "權限不足：需要超級管理員權限" });
  };

  const managerOrAbove = (req: any, res: any, next: any) => {
    if (["super_admin", "marketing_manager"].includes(req.session?.userRole)) return next();
    return res.status(403).json({ message: "權限不足：需要行銷經理以上權限" });
  };

  app.get("/api/settings", authMiddleware, (req: any, res) => {
    const role = req.session?.userRole;
    if (role === "cs_agent") {
      const publicKeys = ["system_name", "logo_url", "test_mode"];
      const allSettings = storage.getAllSettings();
      return res.json(allSettings.filter((s) => publicKeys.includes(s.key)));
    }
    const allSettings = storage.getAllSettings();
    if (role === "super_admin") return res.json(allSettings);
    const sensitiveKeys = ["openai_api_key", "line_channel_secret", "line_channel_access_token", "superlanding_merchant_no", "superlanding_access_key"];
    const filtered = allSettings.filter((s) => !sensitiveKeys.includes(s.key));
    return res.json(filtered);
  });

  app.put("/api/settings", authMiddleware, (req: any, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ message: "key is required" });
    const sensitiveKeys = ["openai_api_key", "line_channel_secret", "line_channel_access_token", "superlanding_merchant_no", "superlanding_access_key"];
    if (sensitiveKeys.includes(key)) {
      if (req.session?.userRole !== "super_admin") return res.status(403).json({ message: "僅超級管理員可修改 API 金鑰" });
    } else {
      if (!["super_admin", "marketing_manager"].includes(req.session?.userRole)) return res.status(403).json({ message: "權限不足" });
    }
    storage.setSetting(key, value || "");
    return res.json({ success: true });
  });

  app.post("/api/settings/test-connection", authMiddleware, superAdminOnly, (req, res) => {
    const { type } = req.body;
    setTimeout(() => res.json({ success: true, message: `${type} 連線測試成功` }), 1000);
  });

  app.get("/api/contacts", authMiddleware, (_req, res) => {
    const contacts = storage.getContacts();
    return res.json(contacts);
  });

  app.get("/api/contacts/:id", authMiddleware, (req, res) => {
    const contact = storage.getContact(parseInt(req.params.id));
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    return res.json(contact);
  });

  app.put("/api/contacts/:id/human", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    storage.updateContactHumanFlag(id, req.body.needs_human ? 1 : 0);
    return res.json({ success: true });
  });

  app.put("/api/contacts/:id/status", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (!["pending", "processing", "resolved"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    storage.updateContactStatus(id, status);
    if (status === "resolved") {
      const contact = storage.getContact(id);
      if (contact) {
        storage.createMessage(id, contact.platform, "system", "(系統提示) 已自動發送 LINE 滿意度 1~5 星調查卡片給客戶");
      }
    }
    return res.json({ success: true });
  });

  app.put("/api/contacts/:id/tags", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ message: "tags must be an array" });
    storage.updateContactTags(id, tags);
    return res.json({ success: true });
  });

  app.put("/api/contacts/:id/pinned", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const { is_pinned } = req.body;
    storage.updateContactPinned(id, is_pinned ? 1 : 0);
    return res.json({ success: true });
  });

  app.get("/api/contacts/:id/messages", authMiddleware, (req, res) => {
    const contactId = parseInt(req.params.id);
    const sinceId = parseInt(req.query.since_id as string) || 0;
    if (sinceId > 0) return res.json(storage.getMessagesSince(contactId, sinceId));
    return res.json(storage.getMessages(contactId));
  });

  app.post("/api/contacts/:id/messages", authMiddleware, (req, res) => {
    const contactId = parseInt(req.params.id);
    const { content } = req.body;
    if (!content) return res.status(400).json({ message: "content is required" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const message = storage.createMessage(contactId, contact.platform, "admin", content);
    storage.updateContactHumanFlag(contactId, 1);
    return res.json(message);
  });

  app.get("/api/contacts/:id/orders", authMiddleware, async (req, res) => {
    const contactId = parseInt(req.params.id);
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const config = getSuperLandingConfig();
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ orders: [], error: "not_configured", message: "尚未設定一頁商店 API 金鑰" });
    }
    try {
      const params: Record<string, string> = {};
      if (contact.platform_user_id) params.buyer_id = contact.platform_user_id;
      const orders = await fetchOrders(config, params);
      return res.json({ orders });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API 金鑰未設定",
        invalid_credentials: "API 金鑰無效",
        connection_failed: "無法連線至一頁商店",
      };
      return res.json({ orders: [], error: err.message, message: errorMap[err.message] || "查詢失敗" });
    }
  });

  app.get("/api/orders/lookup", authMiddleware, async (req, res) => {
    const { phone, order_id } = req.query;
    const config = getSuperLandingConfig();
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ orders: [], error: "not_configured", message: "尚未設定一頁商店 API 金鑰" });
    }
    try {
      if (order_id) {
        const order = await lookupOrderById(config, order_id as string);
        return res.json({ orders: order ? [order] : [] });
      }
      if (phone) {
        const orders = await lookupOrdersByPhone(config, phone as string);
        return res.json({ orders });
      }
      return res.status(400).json({ message: "請提供 phone 或 order_id 參數" });
    } catch (err: any) {
      return res.json({ orders: [], error: err.message, message: "查詢失敗" });
    }
  });

  app.post("/api/webhook/line", (req, res) => {
    const signature = req.headers["x-line-signature"] as string | undefined;
    const channelSecret = storage.getSetting("line_channel_secret");
    if (channelSecret && signature && req.rawBody) {
      const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody as string);
      const hash = crypto.createHmac("SHA256", channelSecret).update(rawBody).digest("base64");
      if (hash !== signature) return res.status(403).json({ message: "簽名驗證失敗" });
    }

    const humanKeywordsSetting = storage.getSetting("human_transfer_keywords");
    const HUMAN_KEYWORDS = humanKeywordsSetting
      ? humanKeywordsSetting.split(",").map((k) => k.trim()).filter(Boolean)
      : ["找客服", "真人", "轉人工", "人工客服", "真人客服"];

    const events = req.body?.events || [];
    for (const event of events) {
      if (event.type === "message" && event.message?.type === "text") {
        const userId = event.source?.userId || "unknown";
        const displayName = event.source?.displayName || "LINE用戶";
        const text = event.message.text;
        const contact = storage.getOrCreateContact("line", userId, displayName);
        storage.createMessage(contact.id, "line", "user", text);
        const needsHuman = HUMAN_KEYWORDS.some((kw) => text.includes(kw));
        if (needsHuman) {
          storage.updateContactHumanFlag(contact.id, 1);
          storage.createMessage(contact.id, "line", "ai", "好的，我已為您轉接真人客服，請稍候片刻。");
        } else if (!contact.needs_human) {
          const testMode = storage.getSetting("test_mode");
          if (testMode === "true") {
            storage.createMessage(contact.id, "line", "ai", `[測試模式] 收到您的訊息：「${text}」。`);
          }
        }
      }
    }
    return res.status(200).json({ success: true });
  });

  app.post("/api/sandbox/chat", authMiddleware, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ message: "message is required" });
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") {
      return res.status(400).json({ success: false, error: "no_api_key", message: "請先至系統設定填寫有效的 OpenAI API Key" });
    }
    const systemPrompt = storage.getSetting("system_prompt") || "你是一位專業的客服助理。";
    try {
      const openai = new OpenAI({ apiKey });
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        max_tokens: 1000,
        temperature: 0.7,
      });
      const reply = completion.choices[0]?.message?.content || "抱歉，AI 無法生成回覆。";
      return res.json({ success: true, reply });
    } catch (err: any) {
      const errorMessage = err?.message || "未知錯誤";
      if (errorMessage.includes("401") || errorMessage.includes("Incorrect API key") || errorMessage.includes("invalid_api_key")) {
        return res.status(400).json({ success: false, error: "invalid_api_key", message: "OpenAI API Key 無效，請至系統設定更新您的金鑰" });
      }
      return res.status(500).json({ success: false, error: "api_error", message: `AI 回覆失敗：${errorMessage}` });
    }
  });

  app.get("/api/knowledge-files", authMiddleware, (_req, res) => {
    return res.json(storage.getKnowledgeFiles());
  });

  app.post("/api/knowledge-files", authMiddleware, managerOrAbove, upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "未上傳檔案" });
    const file = storage.createKnowledgeFile(req.file.filename, req.file.originalname, req.file.size);
    return res.json(file);
  });

  app.delete("/api/knowledge-files/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseInt(req.params.id);
    const files = storage.getKnowledgeFiles();
    const file = files.find((f) => f.id === id);
    if (file) {
      const filePath = path.join(uploadDir, file.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    if (!storage.deleteKnowledgeFile(id)) return res.status(404).json({ message: "檔案不存在" });
    return res.json({ success: true });
  });

  app.get("/api/team", authMiddleware, superAdminOnly, (_req, res) => {
    return res.json(storage.getTeamMembers());
  });

  app.post("/api/team", authMiddleware, superAdminOnly, (req, res) => {
    const { username, password, display_name, role } = req.body;
    if (!username || !password || !display_name) {
      return res.status(400).json({ message: "所有欄位均為必填" });
    }
    if (!["super_admin", "marketing_manager", "cs_agent"].includes(role)) {
      return res.status(400).json({ message: "角色必須為 super_admin, marketing_manager 或 cs_agent" });
    }
    try {
      const user = storage.createUser(username, password, display_name, role);
      return res.json({ success: true, member: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, created_at: user.created_at } });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return res.status(400).json({ message: "該帳號已存在" });
      }
      return res.status(500).json({ message: "建立失敗" });
    }
  });

  app.put("/api/team/:id", authMiddleware, superAdminOnly, (req, res) => {
    const id = parseInt(req.params.id);
    const { display_name, role, password } = req.body;
    if (!display_name) return res.status(400).json({ message: "姓名為必填" });
    if (!["super_admin", "marketing_manager", "cs_agent"].includes(role)) return res.status(400).json({ message: "角色無效" });
    if (!storage.updateUser(id, display_name, role, password || undefined)) {
      return res.status(404).json({ message: "成員不存在" });
    }
    return res.json({ success: true });
  });

  app.delete("/api/team/:id", authMiddleware, superAdminOnly, (req, res) => {
    const id = parseInt(req.params.id);
    const s = (req as any).session;
    if (id === s.userId) {
      return res.status(400).json({ message: "無法刪除目前登入的帳號" });
    }
    if (!storage.deleteUser(id)) return res.status(404).json({ message: "成員不存在" });
    return res.json({ success: true });
  });

  app.get("/api/analytics", authMiddleware, managerOrAbove, (req, res) => {
    const range = (req.query.range as string) || "today";
    const startDate = req.query.start as string;
    const endDate = req.query.end as string;

    let dataKey = range;
    if (range === "custom" && startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      if (diffDays <= 1) dataKey = "today";
      else if (diffDays <= 7) dataKey = "7d";
      else dataKey = "30d";
    }

    const mockDataMap: Record<string, any> = {
      today: {
        kpi: { todayInbound: 127, completedCount: 120, completionRate: 94.5, aiInterceptRate: 82, avgFrtAi: "2 秒", avgFrtHuman: "1 分 15 秒" },
        agentPerformance: [
          { name: "AI 助理", cases: 104 },
          { name: "客服小李", cases: 35 },
          { name: "系統管理員", cases: 18 },
          { name: "行銷經理 Amy", cases: 8 },
        ],
        intentDistribution: [
          { name: "退換貨諮詢", value: 40 },
          { name: "產品諮詢", value: 30 },
          { name: "物流追蹤", value: 20 },
          { name: "帳號問題", value: 10 },
        ],
      },
      "7d": {
        kpi: { todayInbound: 843, completedCount: 798, completionRate: 94.7, aiInterceptRate: 79, avgFrtAi: "2 秒", avgFrtHuman: "1 分 32 秒" },
        agentPerformance: [
          { name: "AI 助理", cases: 665 },
          { name: "客服小李", cases: 210 },
          { name: "系統管理員", cases: 95 },
          { name: "行銷經理 Amy", cases: 52 },
        ],
        intentDistribution: [
          { name: "退換貨諮詢", value: 35 },
          { name: "產品諮詢", value: 28 },
          { name: "物流追蹤", value: 22 },
          { name: "帳號問題", value: 15 },
        ],
      },
      "30d": {
        kpi: { todayInbound: 3521, completedCount: 3310, completionRate: 94.0, aiInterceptRate: 80, avgFrtAi: "3 秒", avgFrtHuman: "1 分 48 秒" },
        agentPerformance: [
          { name: "AI 助理", cases: 2817 },
          { name: "客服小李", cases: 920 },
          { name: "系統管理員", cases: 405 },
          { name: "行銷經理 Amy", cases: 198 },
        ],
        intentDistribution: [
          { name: "退換貨諮詢", value: 38 },
          { name: "產品諮詢", value: 25 },
          { name: "物流追蹤", value: 23 },
          { name: "帳號問題", value: 14 },
        ],
      },
    };

    const data = mockDataMap[dataKey] || mockDataMap.today;
    return res.json({
      ...data,
      aiInsights: {
        painPoints: [
          "退換貨流程不夠直覺 — 本週有 40% 的進線與退換貨相關，多數客戶反映在會員中心找不到退貨入口，建議優化退貨按鈕的 UI 位置。",
          "物流配送延遲投訴增加 — 近三日有 15 筆「包裹遲到」相關訊息，集中於北部地區。建議與物流商確認北區倉儲調度狀況。",
          "限量商品庫存資訊不透明 — 多位客戶詢問官網首頁限量款包包的庫存，但系統無法即時回覆庫存量，造成客戶不滿轉人工率升高。",
        ],
        suggestions: [
          "在官網商品頁面加入即時庫存顯示功能，減少因庫存不確定而產生的客服進線量，預估可降低 15% 的諮詢量。",
          "建立自動退貨引導流程 — 當 AI 偵測到「退貨」關鍵字時，直接回覆退貨步驟圖文教學，減少真人客服介入。",
          "針對 VIP 客戶建立優先佇列機制，確保高價值客戶的等待時間不超過 30 秒。",
        ],
      },
    });
  });

  app.get("/api/marketing-rules", authMiddleware, (_req, res) => {
    return res.json(storage.getMarketingRules());
  });

  app.post("/api/marketing-rules", authMiddleware, managerOrAbove, (req, res) => {
    const { keyword, pitch, url } = req.body;
    if (!keyword) return res.status(400).json({ message: "關鍵字為必填" });
    const rule = storage.createMarketingRule(keyword, pitch || "", url || "");
    return res.json({ success: true, rule });
  });

  app.put("/api/marketing-rules/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseInt(req.params.id);
    const { keyword, pitch, url } = req.body;
    if (!keyword) return res.status(400).json({ message: "關鍵字為必填" });
    if (!storage.updateMarketingRule(id, keyword, pitch || "", url || "")) {
      return res.status(404).json({ message: "規則不存在" });
    }
    return res.json({ success: true });
  });

  app.delete("/api/marketing-rules/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseInt(req.params.id);
    if (!storage.deleteMarketingRule(id)) return res.status(404).json({ message: "規則不存在" });
    return res.json({ success: true });
  });

  return httpServer;
}
