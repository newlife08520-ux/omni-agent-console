import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage, getOrderStatus } from "./storage";
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
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("不支援的檔案格式"));
    }
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

const HUMAN_KEYWORDS = ["找客服", "真人", "轉人工", "人工客服", "真人客服"];

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
      return res.json({
        success: true,
        message: "登入成功",
        user: { id: user.id, username: user.username, role: user.role },
      });
    }
    return res.status(401).json({ success: false, message: "帳號或密碼錯誤" });
  });

  app.get("/api/auth/check", (req, res) => {
    const session = (req as any).session;
    if (session?.authenticated === true) {
      return res.json({
        authenticated: true,
        user: { id: session.userId, username: session.username, role: session.userRole },
      });
    }
    return res.json({ authenticated: false });
  });

  app.post("/api/auth/logout", (req, res) => {
    (req as any).session.authenticated = false;
    (req as any).session.userId = null;
    (req as any).session.userRole = null;
    (req as any).session.username = null;
    return res.json({ success: true });
  });

  const authMiddleware = (req: any, res: any, next: any) => {
    if (req.session?.authenticated === true) {
      return next();
    }
    return res.status(401).json({ message: "未授權" });
  };

  const adminOnly = (req: any, res: any, next: any) => {
    if (req.session?.userRole === "admin") {
      return next();
    }
    return res.status(403).json({ message: "權限不足" });
  };

  app.get("/api/settings", authMiddleware, (_req, res) => {
    const settings = storage.getAllSettings();
    return res.json(settings);
  });

  app.put("/api/settings", authMiddleware, adminOnly, (req, res) => {
    const { key, value } = req.body;
    if (!key) {
      return res.status(400).json({ message: "key is required" });
    }
    storage.setSetting(key, value || "");
    return res.json({ success: true });
  });

  app.post("/api/settings/test-connection", authMiddleware, adminOnly, (req, res) => {
    const { type } = req.body;
    setTimeout(() => {
      return res.json({ success: true, message: `${type} 連線測試成功` });
    }, 1000);
  });

  app.get("/api/contacts", authMiddleware, (_req, res) => {
    const contacts = storage.getContacts();
    return res.json(contacts);
  });

  app.get("/api/contacts/:id", authMiddleware, (req, res) => {
    const contact = storage.getContact(parseInt(req.params.id));
    if (!contact) {
      return res.status(404).json({ message: "聯絡人不存在" });
    }
    return res.json(contact);
  });

  app.put("/api/contacts/:id/human", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const { needs_human } = req.body;
    storage.updateContactHumanFlag(id, needs_human ? 1 : 0);
    return res.json({ success: true });
  });

  app.put("/api/contacts/:id/status", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (!["pending", "processing", "resolved"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    storage.updateContactStatus(id, status);
    return res.json({ success: true });
  });

  app.put("/api/contacts/:id/tags", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const { tags } = req.body;
    if (!Array.isArray(tags)) {
      return res.status(400).json({ message: "tags must be an array" });
    }
    storage.updateContactTags(id, tags);
    return res.json({ success: true });
  });

  app.get("/api/contacts/:id/messages", authMiddleware, (req, res) => {
    const contactId = parseInt(req.params.id);
    const sinceId = parseInt(req.query.since_id as string) || 0;
    if (sinceId > 0) {
      const messages = storage.getMessagesSince(contactId, sinceId);
      return res.json(messages);
    }
    const messages = storage.getMessages(contactId);
    return res.json(messages);
  });

  app.post("/api/contacts/:id/messages", authMiddleware, (req, res) => {
    const contactId = parseInt(req.params.id);
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ message: "content is required" });
    }
    const contact = storage.getContact(contactId);
    if (!contact) {
      return res.status(404).json({ message: "聯絡人不存在" });
    }
    const message = storage.createMessage(contactId, contact.platform, "admin", content);
    storage.updateContactHumanFlag(contactId, 1);
    return res.json(message);
  });

  app.post("/api/webhook/line", (req, res) => {
    const signature = req.headers["x-line-signature"] as string | undefined;
    const channelSecret = storage.getSetting("line_channel_secret");

    if (channelSecret && signature && req.rawBody) {
      const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody as string);
      const hash = crypto.createHmac("SHA256", channelSecret).update(rawBody).digest("base64");
      if (hash !== signature) {
        return res.status(403).json({ message: "簽名驗證失敗" });
      }
    }

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
            storage.createMessage(contact.id, "line", "ai", `[測試模式] 收到您的訊息：「${text}」。正式上線後將由 AI 為您服務。`);
          }
        }
      }
    }
    return res.status(200).json({ success: true });
  });

  app.post("/api/sandbox/chat", authMiddleware, async (req, res) => {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ message: "message is required" });
    }

    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "no_api_key",
        message: "請先至系統設定填寫有效的 OpenAI API Key",
      });
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
        return res.status(400).json({
          success: false,
          error: "invalid_api_key",
          message: "OpenAI API Key 無效，請至系統設定更新您的金鑰",
        });
      }
      return res.status(500).json({
        success: false,
        error: "api_error",
        message: `AI 回覆失敗：${errorMessage}`,
      });
    }
  });

  app.post("/api/ai/sandbox", authMiddleware, (req, res) => {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ message: "message is required" });
    }
    const mockResponses = [
      `收到您的訊息：「${message}」。我是您的 AI 助理，很高興為您服務！`,
      `感謝您的提問！關於「${message}」，我會盡力為您解答。`,
      `您好！已收到您的訊息。針對您提到的「${message}」，建議您可以參考我們的常見問題頁面。`,
    ];
    const reply = mockResponses[Math.floor(Math.random() * mockResponses.length)];
    setTimeout(() => {
      return res.json({ reply });
    }, 800);
  });

  app.get("/api/order-status", authMiddleware, (req, res) => {
    const phone = (req.query.phone as string) || "";
    const result = getOrderStatus(phone);
    return res.json(result);
  });

  app.get("/api/knowledge-files", authMiddleware, (_req, res) => {
    const files = storage.getKnowledgeFiles();
    return res.json(files);
  });

  app.post("/api/knowledge-files", authMiddleware, upload.single("file"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "未上傳檔案" });
    }
    const file = storage.createKnowledgeFile(req.file.filename, req.file.originalname, req.file.size);
    return res.json(file);
  });

  app.delete("/api/knowledge-files/:id", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const files = storage.getKnowledgeFiles();
    const file = files.find((f) => f.id === id);
    if (file) {
      const filePath = path.join(uploadDir, file.filename);
      if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
    }
    const deleted = storage.deleteKnowledgeFile(id);
    if (!deleted) { return res.status(404).json({ message: "檔案不存在" }); }
    return res.json({ success: true });
  });

  app.get("/api/team", authMiddleware, adminOnly, (_req, res) => {
    const members = storage.getTeamMembers();
    return res.json(members);
  });

  return httpServer;
}
