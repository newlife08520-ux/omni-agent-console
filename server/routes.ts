import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { fetchOrders, lookupOrderById, lookupOrdersByDateAndFilter, lookupOrdersByPhone, fetchPages, lookupOrdersByPageAndPhone, ensurePagesCacheLoaded, refreshPagesCache, getCachedPages, getCachedPagesAge, buildProductCatalogPrompt } from "./superlanding";
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
const ALLOWED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".webm"];

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

const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `chat-${Date.now()}-${crypto.randomUUID()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_IMAGE_EXTENSIONS.includes(ext));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

function getSuperLandingConfig(): SuperLandingConfig {
  return {
    merchantNo: storage.getSetting("superlanding_merchant_no") || "",
    accessKey: storage.getSetting("superlanding_access_key") || "",
  };
}

async function getEnrichedSystemPrompt(): Promise<string> {
  const basePrompt = storage.getSetting("system_prompt") || "你是一位專業的客服助理。";
  const config = getSuperLandingConfig();
  const pages = await ensurePagesCacheLoaded(config);
  const catalogBlock = buildProductCatalogPrompt(pages);
  return basePrompt + catalogBlock;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  const config = getSuperLandingConfig();
  refreshPagesCache(config).catch(() => {});
  setInterval(() => {
    const freshConfig = getSuperLandingConfig();
    refreshPagesCache(freshConfig).catch(() => {});
  }, 60 * 60 * 1000);

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

  app.post("/api/settings/test-connection", authMiddleware, superAdminOnly, async (req, res) => {
    const { type } = req.body;
    try {
      if (type === "openai") {
        const apiKey = storage.getSetting("openai_api_key");
        if (!apiKey || apiKey.trim() === "") {
          return res.json({ success: false, message: "尚未設定 OpenAI API 金鑰" });
        }
        const openai = new OpenAI({ apiKey });
        await openai.chat.completions.create({
          model: "gpt-5.2",
          messages: [{ role: "user", content: "hi" }],
          max_completion_tokens: 5,
        });
        return res.json({ success: true, message: "OpenAI 連線成功 (模型: gpt-5.2)" });
      }

      if (type === "line") {
        const token = storage.getSetting("line_channel_access_token");
        if (!token || token.trim() === "") {
          return res.json({ success: false, message: "尚未設定 LINE Channel Access Token" });
        }
        const verifyRes = await fetch("https://api.line.me/v2/bot/info", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (verifyRes.ok) {
          const botInfo = await verifyRes.json();
          return res.json({ success: true, message: `LINE 連線成功！Bot 名稱: ${botInfo.displayName || botInfo.basicId || "OK"}` });
        }
        const errBody = await verifyRes.text();
        return res.json({ success: false, message: `LINE 驗證失敗 (${verifyRes.status}): ${errBody}` });
      }

      if (type === "superlanding") {
        const merchantNo = storage.getSetting("superlanding_merchant_no");
        const accessKey = storage.getSetting("superlanding_access_key");
        if (!merchantNo || !accessKey) {
          return res.json({ success: false, message: "尚未設定一頁商店 merchant_no 或 access_key" });
        }
        const slUrl = `https://api.super-landing.com/orders.json?merchant_no=${encodeURIComponent(merchantNo)}&access_key=${encodeURIComponent(accessKey)}&per_page=1`;
        try {
          const slRes = await fetch(slUrl, { headers: { Accept: "application/json" } });
          if (slRes.ok) {
            return res.json({ success: true, message: "一頁商店連線成功！已成功取得訂單資料" });
          }
          const errText = await slRes.text().catch(() => "");
          return res.json({ success: false, message: `一頁商店連線失敗 (HTTP ${slRes.status})：${errText || "伺服器拒絕請求，請確認 merchant_no 與 access_key 是否正確"}` });
        } catch (fetchErr: any) {
          const detail = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.message || "未知網路錯誤";
          return res.json({ success: false, message: `一頁商店連線失敗（網路錯誤）：${detail}` });
        }
      }

      return res.json({ success: false, message: `未知的測試類型: ${type}` });
    } catch (err: any) {
      const msg = err?.message || "未知錯誤";
      return res.json({ success: false, message: `連線測試失敗: ${msg}` });
    }
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

  function buildRatingFlexMessage(contactId: number): object {
    const stars = [1, 2, 3, 4, 5].map((score) => ({
      type: "button",
      action: {
        type: "postback",
        label: "⭐",
        data: `action=rate&ticket_id=${contactId}&score=${score}`,
        displayText: `${"⭐".repeat(score)}`,
      },
      style: "link",
      height: "sm",
      flex: 1,
    }));

    return {
      type: "flex",
      altText: "滿意度調查",
      contents: {
        type: "bubble",
        size: "kilo",
        header: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "感謝您的詢問！", weight: "bold", size: "lg", color: "#1DB446", align: "center" },
          ],
          paddingAll: "16px",
          backgroundColor: "#F7FFF7",
        },
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "為了提供更優質的服務，請為本次客服體驗評分：", size: "sm", color: "#555555", wrap: true, align: "center" },
            { type: "separator", margin: "lg" },
            { type: "text", text: "點擊星星評分（1~5 顆星）", size: "xs", color: "#AAAAAA", align: "center", margin: "md" },
          ],
          paddingAll: "16px",
        },
        footer: {
          type: "box",
          layout: "horizontal",
          contents: stars,
          spacing: "none",
          paddingAll: "8px",
        },
      },
    };
  }

  async function sendRatingFlexMessage(contact: { id: number; platform_user_id: string }) {
    const token = storage.getSetting("line_channel_access_token");
    if (!token) return;
    try {
      const flexMsg = buildRatingFlexMessage(contact.id);
      await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ to: contact.platform_user_id, messages: [flexMsg] }),
      });
    } catch (err) {
      console.error("LINE rating flex message push failed:", err);
    }
  }

  app.put("/api/contacts/:id/status", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (!["pending", "processing", "resolved"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    storage.updateContactStatus(id, status);
    return res.json({ success: true });
  });

  app.post("/api/contacts/:id/send-rating", authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id);
    const contact = storage.getContact(id);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    if (contact.cs_rating != null) {
      return res.status(400).json({ message: "此客戶已評分過，無法重複發送" });
    }
    if (contact.platform !== "line") {
      return res.status(400).json({ message: "僅支援 LINE 平台" });
    }
    const token = storage.getSetting("line_channel_access_token");
    if (!token) {
      return res.status(400).json({ message: "尚未設定 LINE Channel Access Token" });
    }
    try {
      await sendRatingFlexMessage(contact);
      storage.createMessage(id, contact.platform, "system", "(系統提示) 已手動發送滿意度調查卡片給客戶");
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ message: "發送失敗" });
    }
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
    const { content, message_type, image_url } = req.body;
    if (!content && !image_url) return res.status(400).json({ message: "content or image_url is required" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const msgType = message_type || "text";
    const message = storage.createMessage(contactId, contact.platform, "admin", content || "", msgType, image_url || null);
    storage.updateContactHumanFlag(contactId, 1);

    if (image_url && contact.platform === "line") {
      const token = storage.getSetting("line_channel_access_token");
      if (token) {
        const protocol = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const fullImageUrl = image_url.startsWith("http") ? image_url : `${protocol}://${host}${image_url}`;
        fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({
            to: contact.platform_user_id,
            messages: [{ type: "image", originalContentUrl: fullImageUrl, previewImageUrl: fullImageUrl }],
          }),
        }).catch((err) => console.error("LINE image push failed:", err));
      }
    }

    return res.json(message);
  });

  app.post("/api/chat-upload", authMiddleware, chatUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "僅支援 JPG, PNG, GIF, WebP 圖片格式，檔案大小不超過 10MB" });
    const fileUrl = `/uploads/${req.file.filename}`;
    return res.json({ url: fileUrl, filename: req.file.originalname, size: req.file.size });
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
      const orders = await fetchOrders(config, { per_page: "50" });
      return res.json({ orders });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API 金鑰未設定",
        invalid_credentials: "API 金鑰無效（請確認 merchant_no 與 access_key）",
        connection_failed: "無法連線至一頁商店 API",
      };
      console.error("[一頁商店] 聯絡人訂單查詢失敗:", err.message);
      return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `查詢失敗：${err.message}` });
    }
  });

  app.get("/api/orders/lookup", authMiddleware, async (req, res) => {
    const { q } = req.query;
    const query = (q as string || "").trim();
    if (!query) return res.status(400).json({ message: "請提供訂單編號" });
    const config = getSuperLandingConfig();
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ orders: [], error: "not_configured", message: "尚未設定一頁商店 API 金鑰" });
    }
    try {
      console.log("[一頁商店] 以訂單編號查詢:", query);
      const order = await lookupOrderById(config, query);
      if (!order) {
        return res.json({ orders: [], message: "於一頁商店查無此訂單編號，請確認編號是否正確" });
      }
      return res.json({ orders: [order] });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API 金鑰未設定",
        invalid_credentials: "API 金鑰無效（請確認 merchant_no 與 access_key）",
        connection_failed: "無法連線至一頁商店 API",
      };
      console.error("[一頁商店] 訂單查詢失敗:", err.message);
      return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `查詢失敗：${err.message}` });
    }
  });

  app.get("/api/orders/search", authMiddleware, async (req, res) => {
    const { q, begin_date, end_date } = req.query;
    const query = (q as string || "").trim();
    const beginDate = (begin_date as string || "").trim();
    const endDate = (end_date as string || "").trim();

    if (!query) return res.status(400).json({ message: "請提供查詢條件（Email、電話或姓名）" });
    if (!beginDate || !endDate) return res.status(400).json({ message: "請提供日期區間（begin_date 與 end_date）" });

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(beginDate) || !dateRegex.test(endDate)) {
      return res.status(400).json({ message: "日期格式須為 YYYY-MM-DD" });
    }

    const begin = new Date(beginDate + "T00:00:00");
    const end = new Date(endDate + "T00:00:00");
    if (isNaN(begin.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ message: "無效的日期，請確認日期是否正確" });
    }
    const diffDays = Math.round((end.getTime() - begin.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return res.status(400).json({ message: "結束日期不可早於開始日期" });
    if (diffDays >= 31) return res.status(400).json({ message: "日期範圍不可超過 31 天，請縮小查詢範圍" });

    const config = getSuperLandingConfig();
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ orders: [], error: "not_configured", message: "尚未設定一頁商店 API 金鑰" });
    }

    try {
      console.log(`[一頁商店] 進階查詢: q="${query}" ${beginDate}~${endDate}`);
      const result = await lookupOrdersByDateAndFilter(config, query, beginDate, endDate);
      if (result.orders.length === 0) {
        return res.json({ orders: [], totalFetched: result.totalFetched, message: `在 ${beginDate} ~ ${endDate} 期間查無符合「${query}」的訂單（共掃描 ${result.totalFetched} 筆）` });
      }
      return res.json({ orders: result.orders, totalFetched: result.totalFetched, truncated: result.truncated });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API 金鑰未設定",
        invalid_credentials: "API 金鑰無效（請確認 merchant_no 與 access_key）",
        connection_failed: "無法連線至一頁商店 API",
      };
      console.error("[一頁商店] 進階查詢失敗:", err.message);
      return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `查詢失敗：${err.message}` });
    }
  });

  app.get("/api/orders/pages", authMiddleware, async (req, res) => {
    const config = getSuperLandingConfig();
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ pages: [], error: "not_configured", message: "尚未設定一頁商店 API 金鑰" });
    }
    try {
      const forceRefresh = req.query.refresh === "1";
      const pages = forceRefresh
        ? await refreshPagesCache(config)
        : await ensurePagesCacheLoaded(config);
      return res.json({ pages, cached: !forceRefresh, cacheAge: Math.round(getCachedPagesAge() / 1000) });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API 金鑰未設定",
        invalid_credentials: "API 金鑰無效",
        connection_failed: "無法連線至一頁商店 API",
      };
      return res.json({ pages: [], error: err.message, message: errorMap[err.message] || `查詢失敗：${err.message}` });
    }
  });

  app.get("/api/orders/by-product", authMiddleware, async (req, res) => {
    const { page_id, phone } = req.query;
    const pageId = (page_id as string || "").trim();
    const phoneNum = (phone as string || "").trim();

    if (!pageId) return res.status(400).json({ message: "請選擇產品（page_id）" });
    if (!phoneNum) return res.status(400).json({ message: "請提供手機號碼" });

    const config = getSuperLandingConfig();
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ orders: [], error: "not_configured", message: "尚未設定一頁商店 API 金鑰" });
    }

    try {
      console.log(`[一頁商店] 產品查詢: page_id=${pageId} phone=${phoneNum}`);
      const result = await lookupOrdersByPageAndPhone(config, pageId, phoneNum);
      if (result.orders.length === 0) {
        return res.json({ orders: [], totalFetched: result.totalFetched, message: `此產品下查無符合手機號碼「${phoneNum}」的訂單（共掃描 ${result.totalFetched} 筆）` });
      }
      return res.json({ orders: result.orders, totalFetched: result.totalFetched, truncated: result.truncated });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API 金鑰未設定",
        invalid_credentials: "API 金鑰無效（請確認 merchant_no 與 access_key）",
        connection_failed: "無法連線至一頁商店 API",
      };
      console.error("[一頁商店] 產品查詢失敗:", err.message);
      return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `查詢失敗：${err.message}` });
    }
  });

  async function downloadLineContent(messageId: string, fallbackExt: string): Promise<string | null> {
    const token = storage.getSetting("line_channel_access_token");
    if (!token) return null;
    try {
      const resp = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (!resp.ok) {
        console.error("LINE content download failed:", resp.status, await resp.text());
        return null;
      }
      const contentType = resp.headers.get("content-type") || "";
      const mimeExtMap: Record<string, string> = {
        "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
        "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
      };
      const ext = mimeExtMap[contentType] || fallbackExt;
      const buffer = Buffer.from(await resp.arrayBuffer());
      const filename = `line-${Date.now()}-${crypto.randomUUID()}${ext}`;
      const filePath = path.join(uploadDir, filename);
      fs.writeFileSync(filePath, buffer);
      return `/uploads/${filename}`;
    } catch (err) {
      console.error("LINE content download error:", err);
      return null;
    }
  }

  async function analyzeImageWithAI(imageFilePath: string, contactId: number) {
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") return;
    try {
      const absPath = path.join(process.cwd(), imageFilePath.startsWith("/") ? imageFilePath.slice(1) : imageFilePath);
      const imageBuffer = fs.readFileSync(absPath);
      const base64 = imageBuffer.toString("base64");
      const ext = path.extname(absPath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const dataUri = `data:${mimeType};base64,${base64}`;

      const systemPrompt = await getEnrichedSystemPrompt();
      const openai = new OpenAI({ apiKey });
      const completion = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: "請以客服身分查看這張客戶上傳的圖片，判斷是否有商品瑕疵或任何問題，並給予適當的回覆。" },
              { type: "image_url", image_url: { url: dataUri } },
            ],
          },
        ],
        max_completion_tokens: 1000,
        temperature: 0.7,
      });
      const reply = completion.choices[0]?.message?.content || "已收到您的圖片，將為您進一步處理。";
      storage.createMessage(contactId, "line", "ai", reply);

      const lineToken = storage.getSetting("line_channel_access_token");
      const contact = storage.getContact(contactId);
      if (lineToken && contact) {
        await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${lineToken}` },
          body: JSON.stringify({
            to: contact.platform_user_id,
            messages: [{ type: "text", text: reply }],
          }),
        }).catch((err) => console.error("LINE AI image reply push failed:", err));
      }
    } catch (err) {
      console.error("OpenAI Vision analysis error:", err);
      storage.createMessage(contactId, "line", "ai", "已收到您的圖片，將為您轉交專人檢視。");
    }
  }

  async function replyToLine(replyToken: string, messages: object[]) {
    const token = storage.getSetting("line_channel_access_token");
    if (!token || !replyToken) return;
    try {
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ replyToken, messages }),
      });
    } catch (err) {
      console.error("LINE reply failed:", err);
    }
  }

  app.post("/api/webhook/line", async (req, res) => {
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
      const webhookEventId = event.webhookEventId || event.timestamp?.toString();
      if (webhookEventId && storage.isEventProcessed(webhookEventId)) {
        continue;
      }

      try {
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
        } else if (event.type === "postback") {
          const data = event.postback?.data || "";
          const params = new URLSearchParams(data);
          if (params.get("action") === "rate") {
            const ticketId = parseInt(params.get("ticket_id") || "0");
            const score = parseInt(params.get("score") || "0");
            if (ticketId > 0 && score >= 1 && score <= 5) {
              storage.updateContactRating(ticketId, score);
              storage.createMessage(ticketId, "line", "system", `(系統提示) 客戶評分：${"⭐".repeat(score)}（${score} 分）`);
              replyToLine(event.replyToken, [
                { type: "text", text: `已收到您的 ${"⭐".repeat(score)} 評分，感謝您的寶貴意見！祝您有美好的一天。` },
              ]);
            }
          }
        } else if (event.type === "follow" || event.type === "unfollow" || event.type === "join" || event.type === "leave" || event.type === "memberJoined" || event.type === "memberLeft") {
          // silently ignore lifecycle events
        } else if (event.type === "message" && event.message?.type === "image") {
          const userId = event.source?.userId || "unknown";
          const displayName = event.source?.displayName || "LINE用戶";
          const contact = storage.getOrCreateContact("line", userId, displayName);
          const messageId = event.message.id;
          const imageUrl = await downloadLineContent(messageId, ".jpg");
          if (imageUrl) {
            storage.createMessage(contact.id, "line", "user", "[圖片訊息]", "image", imageUrl);
            if (!contact.needs_human) {
              analyzeImageWithAI(imageUrl, contact.id).catch((err) =>
                console.error("AI image analysis background error:", err)
              );
            }
          } else {
            storage.createMessage(contact.id, "line", "user", "[圖片訊息] (下載失敗)");
          }
        } else if (event.type === "message" && event.message?.type === "video") {
          const userId = event.source?.userId || "unknown";
          const displayName = event.source?.displayName || "LINE用戶";
          const contact = storage.getOrCreateContact("line", userId, displayName);
          const messageId = event.message.id;
          const videoUrl = await downloadLineContent(messageId, ".mp4");
          if (videoUrl) {
            storage.createMessage(contact.id, "line", "user", "[影片訊息]", "video", videoUrl);
          } else {
            storage.createMessage(contact.id, "line", "user", "[影片訊息] (下載失敗)");
          }
          storage.createMessage(contact.id, "line", "ai", "(AI 系統提示) 已收到您的影片，將為您轉交專人檢視。");
          storage.updateContactHumanFlag(contact.id, 1);
          const lineToken = storage.getSetting("line_channel_access_token");
          if (lineToken && contact) {
            await fetch("https://api.line.me/v2/bot/message/push", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${lineToken}` },
              body: JSON.stringify({
                to: contact.platform_user_id,
                messages: [{ type: "text", text: "已收到您的影片，將為您轉交專人檢視。" }],
              }),
            }).catch((err) => console.error("LINE video reply push failed:", err));
          }
        } else if (event.type === "message" && event.message?.type !== "text") {
          const userId = event.source?.userId || "unknown";
          const displayName = event.source?.displayName || "LINE用戶";
          const contact = storage.getOrCreateContact("line", userId, displayName);
          const msgType = event.message?.type || "unknown";
          storage.createMessage(contact.id, "line", "user", `[${msgType === "sticker" ? "貼圖" : msgType === "audio" ? "音訊" : msgType === "location" ? "位置" : msgType === "file" ? "檔案" : msgType}訊息]`);
        }
      } catch (err) {
        console.error("Webhook event processing error:", err);
      }

      if (webhookEventId) {
        storage.markEventProcessed(webhookEventId);
      }
    }
    return res.status(200).json({ success: true });
  });

  const orderLookupTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "lookup_order_by_id",
        description: "用訂單編號直接查詢訂單狀態。當客戶提供了訂單編號（如 KBT58265、DEN12345、MRQ00001 等格式）時使用此工具。",
        parameters: {
          type: "object",
          properties: {
            order_id: {
              type: "string",
              description: "客戶提供的訂單編號，例如 KBT58265",
            },
          },
          required: ["order_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "lookup_order_by_product_and_phone",
        description: "用商品名稱和手機號碼查詢訂單。當客戶沒有訂單編號，但提供了購買的商品名稱和手機號碼時使用此工具。你可以用 product_index（商品清單中的編號，如 #3）來精確指定商品，或用 product_name 讓系統模糊匹配。即使客戶說的商品名稱不在銷售頁清單中（例如品項名稱、口味、規格等），系統也會自動用手機號碼搜尋近期訂單並比對商品關鍵字，所以請直接呼叫此工具，不要因為商品名稱不在清單中就拒絕查詢或詢問客戶其他問題。",
        parameters: {
          type: "object",
          properties: {
            product_index: {
              type: "integer",
              description: "商品在內部清單中的編號（如清單中 #3 就填 3）。如果你能從商品清單中確定對應的商品，請優先使用此欄位。",
            },
            product_name: {
              type: "string",
              description: "客戶購買的商品名稱（可以是簡稱、俗稱、關鍵字片段皆可）。當無法確定 product_index 時使用。",
            },
            phone: {
              type: "string",
              description: "客戶下單時留的手機號碼",
            },
          },
          required: ["phone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "lookup_order_by_date_and_contact",
        description: "用下單日期範圍和聯絡資訊查詢訂單。當客戶無法提供單號和商品名稱，但能提供下單日期區間和 Email/手機/姓名時使用。",
        parameters: {
          type: "object",
          properties: {
            contact: {
              type: "string",
              description: "客戶的聯絡資訊（Email、手機號碼或姓名）",
            },
            begin_date: {
              type: "string",
              description: "開始日期，格式 YYYY-MM-DD",
            },
            end_date: {
              type: "string",
              description: "結束日期，格式 YYYY-MM-DD",
            },
          },
          required: ["contact", "begin_date", "end_date"],
        },
      },
    },
  ];

  async function executeToolCall(
    toolName: string,
    args: Record<string, string>
  ): Promise<string> {
    const config = getSuperLandingConfig();
    if (!config.merchantNo || !config.accessKey) {
      return JSON.stringify({ success: false, error: "系統尚未設定一頁商店 API 金鑰，無法查詢訂單。" });
    }

    try {
      if (toolName === "lookup_order_by_id") {
        const orderId = (args.order_id || "").trim();
        console.log("[AI Tool Call] lookup_order_by_id，單號:", orderId);

        if (!orderId) {
          return JSON.stringify({ success: false, error: "訂單編號為空" });
        }

        const order = await lookupOrderById(config, orderId);
        if (!order) {
          console.log("[AI Tool Call] 查無訂單:", orderId);
          return JSON.stringify({ success: true, found: false, message: `查無訂單編號 ${orderId} 的紀錄` });
        }

        const statusLabel = (await import("./superlanding")).getStatusLabel(order.status);
        console.log("[AI Tool Call] 查到訂單:", orderId, "狀態:", statusLabel);
        return JSON.stringify({
          success: true,
          found: true,
          order: {
            order_id: order.global_order_id,
            status: statusLabel,
            amount: order.final_total_order_amount,
            product_list: order.product_list,
            buyer_name: order.buyer_name,
            tracking_number: order.tracking_number,
            created_at: order.created_at,
            shipped_at: order.shipped_at,
            shipping_method: order.shipping_method,
            payment_method: order.payment_method,
          },
        });
      }

      if (toolName === "lookup_order_by_product_and_phone") {
        const productName = (args.product_name || "").trim();
        const productIndex = args.product_index ? parseInt(String(args.product_index)) : 0;
        const phone = (args.phone || "").trim();
        console.log("[AI Tool Call] lookup_order_by_product_and_phone，商品:", productName, "index:", productIndex, "電話:", phone);

        if (!phone) {
          return JSON.stringify({ success: false, error: "請提供手機號碼" });
        }

        const pages = getCachedPages();

        const stripClean = (s: string) => s
          .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "")
          .replace(/[●✨💕💎🔴❄✔✵🛏💦🎨🥘🎩🔥✈💥]/g, "")
          .replace(/[^\p{L}\p{N}]/gu, "")
          .toLowerCase();

        let matchedPages: typeof pages = [];

        if (productIndex > 0 && productIndex <= pages.length) {
          matchedPages = [pages[productIndex - 1]];
          console.log("[AI Tool Call] 使用 product_index #" + productIndex + " 直接對應:", matchedPages[0].productName);
        }

        if (matchedPages.length === 0 && productName) {
          const cleanInput = stripClean(productName);
          const inputTokens = productName.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(t => t.length > 0);
          console.log("[AI Tool Call] 模糊匹配，清理後:", cleanInput, "分詞:", inputTokens);

          matchedPages = pages.filter(p => stripClean(p.productName) === cleanInput);

          if (matchedPages.length === 0) {
            matchedPages = pages.filter(p => stripClean(p.productName).includes(cleanInput));
          }

          if (matchedPages.length === 0 && cleanInput.length >= 2) {
            matchedPages = pages.filter(p => cleanInput.includes(stripClean(p.productName)));
          }

          if (matchedPages.length === 0 && inputTokens.length > 0) {
            const scored = pages.map(p => {
              const cleanName = stripClean(p.productName);
              let score = 0;
              for (const token of inputTokens) {
                const cleanToken = stripClean(token);
                if (cleanToken.length >= 2 && cleanName.includes(cleanToken)) {
                  score += cleanToken.length;
                }
              }
              return { page: p, score };
            }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

            if (scored.length > 0) {
              const topScore = scored[0].score;
              const topMatches = scored.filter(s => s.score === topScore);
              const uniqueNames = new Set(topMatches.map(s => stripClean(s.page.productName)));
              if (uniqueNames.size <= 3) {
                matchedPages = topMatches.map(s => s.page);
              } else {
                const candidates = topMatches.slice(0, 5);
                console.log("[AI Tool Call] 多個不同商品匹配:", candidates.map(s => s.page.productName));
                const matchList = candidates.map((s, i) => `#${pages.indexOf(s.page) + 1}｜${s.page.productName}`).join("\n");
                return JSON.stringify({
                  success: true,
                  found: false,
                  ambiguous: true,
                  message: `找到多個可能的商品，請請客戶確認是哪一個：\n${matchList}`,
                  candidates: candidates.map(s => ({ index: pages.indexOf(s.page) + 1, name: s.page.productName })),
                });
              }
            }
          }
        }

        if (matchedPages.length === 0) {
          console.log("[AI Tool Call] 銷售頁標題無匹配，改用手機號碼直查:", phone, "關鍵字:", productName);

          try {
            const phoneResult = await lookupOrdersByPhone(config, phone, productName || undefined);

            if (phoneResult.orders.length > 0) {
              const { getStatusLabel: getSL } = await import("./superlanding");
              const orderSummaries = phoneResult.orders.slice(0, 5).map(o => ({
                order_id: o.global_order_id,
                status: getSL(o.status),
                amount: o.final_total_order_amount,
                product_list: o.product_list,
                buyer_name: o.buyer_name,
                tracking_number: o.tracking_number,
                created_at: o.created_at,
                shipped_at: o.shipped_at,
              }));
              const hasKeywordMatch = productName && phoneResult.orders.some(o => o.product_list.toLowerCase().includes(productName.toLowerCase()));
              console.log("[AI Tool Call] 手機號碼查到", phoneResult.orders.length, "筆訂單", hasKeywordMatch ? "(含關鍵字匹配)" : "(無關鍵字匹配，回傳全部)");
              return JSON.stringify({
                success: true,
                found: true,
                total: phoneResult.orders.length,
                orders: orderSummaries,
                note: hasKeywordMatch ? undefined : `手機號碼的訂單中未找到包含「${productName}」的商品，以下是該手機號碼的所有訂單，請協助客戶確認。`,
              });
            }

            console.log("[AI Tool Call] 手機號碼查無訂單");
            return JSON.stringify({
              success: true,
              found: false,
              message: `查無手機號碼 ${phone} 的訂單紀錄。`,
            });
          } catch (err: any) {
            console.error("[AI Tool Call] 手機號碼查詢失敗:", err.message);
            return JSON.stringify({ success: false, error: `查詢失敗：${err.message}` });
          }
        }

        console.log("[AI Tool Call] 匹配商品:", matchedPages.length, "個銷售頁:", matchedPages.slice(0, 5).map(p => `${p.productName}(${p.pageId})`).join(", "), matchedPages.length > 5 ? "..." : "");
        let allResults: any[] = [];
        const searchBatchSize = 3;
        for (let bi = 0; bi < matchedPages.length; bi += searchBatchSize) {
          const batch = matchedPages.slice(bi, bi + searchBatchSize);
          const batchResults = await Promise.all(
            batch.map(mp => lookupOrdersByPageAndPhone(config, mp.pageId, phone))
          );
          for (const br of batchResults) {
            allResults = allResults.concat(br.orders);
          }
          if (allResults.length > 0) break;
        }
        const result = { orders: allResults, totalFetched: allResults.length, truncated: false };

        if (result.orders.length === 0) {
          return JSON.stringify({ success: true, found: false, message: `在「${matchedPages[0].productName}」中查無此手機號碼的訂單（已搜尋 ${matchedPages.length} 個相關銷售頁）` });
        }

        const { getStatusLabel: getSL } = await import("./superlanding");
        const orderSummaries = result.orders.slice(0, 5).map(o => ({
          order_id: o.global_order_id,
          status: getSL(o.status),
          amount: o.final_total_order_amount,
          product_list: o.product_list,
          buyer_name: o.buyer_name,
          tracking_number: o.tracking_number,
          created_at: o.created_at,
          shipped_at: o.shipped_at,
        }));

        console.log("[AI Tool Call] 查到", result.orders.length, "筆訂單");
        return JSON.stringify({ success: true, found: true, total: result.orders.length, orders: orderSummaries });
      }

      if (toolName === "lookup_order_by_date_and_contact") {
        const contact = (args.contact || "").trim();
        const beginDate = (args.begin_date || "").trim();
        const endDate = (args.end_date || "").trim();
        console.log("[AI Tool Call] lookup_order_by_date_and_contact，聯絡:", contact, "日期:", beginDate, "~", endDate);

        if (!contact || !beginDate || !endDate) {
          return JSON.stringify({ success: false, error: "請提供聯絡資訊和日期範圍" });
        }

        const result = await lookupOrdersByDateAndFilter(config, contact, beginDate, endDate);

        if (result.orders.length === 0) {
          return JSON.stringify({ success: true, found: false, message: "在指定日期範圍內查無相符紀錄" });
        }

        const { getStatusLabel: getSL2 } = await import("./superlanding");
        const orderSummaries = result.orders.slice(0, 5).map(o => ({
          order_id: o.global_order_id,
          status: getSL2(o.status),
          amount: o.final_total_order_amount,
          product_list: o.product_list,
          buyer_name: o.buyer_name,
          tracking_number: o.tracking_number,
          created_at: o.created_at,
        }));

        console.log("[AI Tool Call] 查到", result.orders.length, "筆訂單");
        return JSON.stringify({ success: true, found: true, total: result.orders.length, orders: orderSummaries, truncated: result.truncated });
      }

      return JSON.stringify({ success: false, error: `未知的工具: ${toolName}` });
    } catch (err: any) {
      console.error("[AI Tool Call] 執行失敗:", toolName, err.message);
      return JSON.stringify({ success: false, error: `查詢失敗：${err.message}` });
    }
  }

  app.post("/api/sandbox/chat", authMiddleware, async (req, res) => {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ message: "message is required" });
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") {
      return res.status(400).json({ success: false, error: "no_api_key", message: "請先至系統設定填寫有效的 OpenAI API Key" });
    }
    const systemPrompt = await getEnrichedSystemPrompt();
    try {
      const openai = new OpenAI({ apiKey });
      const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
      ];
      if (Array.isArray(history) && history.length > 0) {
        for (const h of history.slice(-20)) {
          const role = h.role === "assistant" ? "assistant" as const : "user" as const;
          if (h.content && typeof h.content === "string") {
            chatMessages.push({ role, content: h.content });
          }
        }
        console.log(`[Sandbox] 傳送 ${chatMessages.length - 1} 筆對話歷史至 OpenAI（含 Function Calling Tools）`);
      } else {
        chatMessages.push({ role: "user", content: message });
        console.log("[Sandbox] 無對話歷史，僅傳送單筆訊息（含 Function Calling Tools）");
      }

      let completion = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: chatMessages,
        tools: orderLookupTools,
        max_completion_tokens: 1000,
        temperature: 0.7,
      });

      let responseMessage = completion.choices[0]?.message;
      let loopCount = 0;
      const maxToolLoops = 3;

      while (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0 && loopCount < maxToolLoops) {
        loopCount++;
        console.log(`[Sandbox] AI 觸發 ${responseMessage.tool_calls.length} 個 Tool Call（第 ${loopCount} 輪）`);

        chatMessages.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);

        for (const toolCall of responseMessage.tool_calls) {
          const fnName = toolCall.function.name;
          let fnArgs: Record<string, string> = {};
          try {
            fnArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            console.error("[Sandbox] Tool Call 參數解析失敗:", toolCall.function.arguments);
            chatMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ success: false, error: "參數格式錯誤，無法解析" }),
            });
            continue;
          }

          console.log(`[Sandbox] 執行 Tool: ${fnName}，參數:`, fnArgs);
          const toolResult = await executeToolCall(fnName, fnArgs);
          console.log(`[Sandbox] Tool 回傳結果長度: ${toolResult.length} 字元`);

          chatMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }

        completion = await openai.chat.completions.create({
          model: "gpt-5.2",
          messages: chatMessages,
          tools: orderLookupTools,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
        responseMessage = completion.choices[0]?.message;
      }

      const reply = responseMessage?.content || "抱歉，AI 無法生成回覆。";
      return res.json({ success: true, reply });
    } catch (err: any) {
      const errorMessage = err?.message || "未知錯誤";
      if (errorMessage.includes("401") || errorMessage.includes("Incorrect API key") || errorMessage.includes("invalid_api_key")) {
        return res.status(400).json({ success: false, error: "invalid_api_key", message: "OpenAI API Key 無效，請至系統設定更新您的金鑰" });
      }
      console.error("[Sandbox] AI 回覆失敗:", errorMessage);
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
