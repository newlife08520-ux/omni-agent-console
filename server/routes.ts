import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { fetchOrders, lookupOrderById, lookupOrdersByDateAndFilter, fetchPages, lookupOrdersByPageAndPhone, ensurePagesCacheLoaded, refreshPagesCache, getCachedPages, getCachedPagesAge, buildProductCatalogPrompt } from "./superlanding";
import type { SuperLandingConfig } from "./superlanding";
import type { OrderInfo, Contact } from "@shared/schema";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

function fixMulterFilename(originalname: string): string {
  try {
    const decoded = Buffer.from(originalname, 'latin1').toString('utf8');
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(decoded) || decoded !== originalname) {
      return decoded;
    }
  } catch {}
  return originalname;
}

function stripBOM(content: string): string {
  if (content.charCodeAt(0) === 0xFEFF) {
    return content.slice(1);
  }
  return content;
}
import OpenAI from "openai";
import { parseFileContent, isImageFile } from "./file-parser";

const uploadDir = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const imageAssetsDir = path.resolve(process.cwd(), "uploads", "image-assets");
if (!fs.existsSync(imageAssetsDir)) {
  fs.mkdirSync(imageAssetsDir, { recursive: true });
}

const ALLOWED_EXTENSIONS = [".txt", ".pdf", ".csv", ".docx", ".xlsx", ".md"];
const BLOCKED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".svg", ".ico"];
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
    if (BLOCKED_IMAGE_EXTENSIONS.includes(ext)) {
      return cb(null, false);
    }
    cb(null, ALLOWED_EXTENSIONS.includes(ext));
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

const imageAssetUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, imageAssetsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_IMAGE_EXTENSIONS.includes(ext));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
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

const ALLOWED_MEDIA_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".mov", ".avi", ".webm"];
const ALLOWED_MEDIA_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"];
const sandboxUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `sandbox-${Date.now()}-${crypto.randomUUID()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeOk = ALLOWED_MEDIA_MIMES.includes(file.mimetype);
    cb(null, ALLOWED_MEDIA_EXTENSIONS.includes(ext) && mimeOk);
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

function getSuperLandingConfig(brandId?: number): SuperLandingConfig {
  if (brandId) {
    const brand = storage.getBrand(brandId);
    if (brand && brand.superlanding_merchant_no && brand.superlanding_access_key) {
      return {
        merchantNo: brand.superlanding_merchant_no,
        accessKey: brand.superlanding_access_key,
      };
    }
  }
  return {
    merchantNo: storage.getSetting("superlanding_merchant_no") || "",
    accessKey: storage.getSetting("superlanding_access_key") || "",
  };
}

function buildKnowledgeBlock(brandId?: number): string {
  const files = storage.getKnowledgeFiles(brandId);
  const filesWithContent = files.filter(f => f.content && f.content.trim().length > 0);
  if (filesWithContent.length === 0) return "";
  const maxTotalChars = 80000;
  let totalChars = 0;
  const blocks: string[] = [];
  for (const f of filesWithContent) {
    const content = f.content!;
    if (totalChars + content.length > maxTotalChars) {
      const remaining = maxTotalChars - totalChars;
      if (remaining > 500) {
        blocks.push(`[知識檔案: ${f.original_name}]\n${content.substring(0, remaining)}\n[內容已截斷]`);
      }
      break;
    }
    blocks.push(`[知識檔案: ${f.original_name}]\n${content}`);
    totalChars += content.length;
  }
  return "\n\n--- 知識庫內容 ---\n" + blocks.join("\n\n");
}

function buildImageAssetCatalog(brandId?: number): string {
  const assets = storage.getImageAssets(brandId);
  if (assets.length === 0) return "";
  const lines = assets.map((a, i) => {
    const parts = [`#${i + 1} ${a.display_name}`];
    if (a.description) parts.push(`(${a.description})`);
    if (a.keywords) parts.push(`關鍵字: ${a.keywords}`);
    return parts.join(" ");
  });
  return "\n\n--- 圖片素材庫 ---\n你具備發送圖片的能力。如果客戶的問題用圖片回覆會更清晰，且素材庫中有對應圖片，請優先使用 send_image_to_customer 工具來回覆。\n可用圖片：\n" + lines.join("\n");
}

async function getEnrichedSystemPrompt(brandId?: number): Promise<string> {
  const basePrompt = storage.getSetting("system_prompt") || "你是一位專業的客服助理。";
  let brandBlock = "";
  if (brandId) {
    const brand = storage.getBrand(brandId);
    if (brand?.system_prompt) {
      brandBlock = "\n\n--- 品牌專屬指令 ---\n" + brand.system_prompt;
    }
  }
  const config = getSuperLandingConfig(brandId);
  const pages = await ensurePagesCacheLoaded(config);
  const catalogBlock = buildProductCatalogPrompt(pages);
  const knowledgeBlock = buildKnowledgeBlock(brandId);
  const imageBlock = buildImageAssetCatalog(brandId);

  let returnFormUrl = "https://www.lovethelife.shop/returns";
  if (brandId) {
    const brandData = storage.getBrand(brandId);
    if (brandData?.return_form_url) returnFormUrl = brandData.return_form_url;
  }

  const handoffBlock = `

--- 客服應對 SOP ---
你是 AI 客服小助手，請在回覆中誠實表明自己的 AI 身分。
請根據客戶的問題類型，採取以下應對邏輯：

【查詢/商品知識】：若詢問訂單進度、產地、使用方式、折扣碼，請直接從 API 或知識庫中給予精準答案，不需轉人工。

【修改/取消訂單】：請詢問客戶要修改的細節（例如地址、數量、品項），安撫客戶後回覆：「我已為您記錄並亮起急件燈號，專員會盡快為您攔截處理！」接著呼叫 transfer_to_human（reason 填寫「修改/取消訂單 - [具體修改項目]」）。

【退換貨/補寄/保固】：請溫柔道歉，嘗試探詢退換貨原因，並請客戶提供「照片/錄影」作為證據，或填寫售後表單：${returnFormUrl}。若客戶堅持退換貨，呼叫 transfer_to_human（reason 填寫「退換貨申請 - [原因摘要]」）。

【代客下單/付款失敗/重新出貨】：請告知客戶：「這部分牽涉到您的隱私與金流安全，我立刻請專員為您處理！」接著呼叫 transfer_to_human（reason 填寫「金流/下單相關 - [具體問題]」）。

--- 轉接真人客服機制 ---
當你遇到以下情況時，必須「先回覆一段明確的轉接詢問話術」，然後呼叫 transfer_to_human 工具：
1. 多次查詢仍查不到訂單（已嘗試不同查詢方式後仍無結果）
2. 知識庫中找不到客戶描述的商品或服務
3. 客戶問題過於複雜，超出你的能力範圍
4. 判斷為非本系統管轄的訂單（如 SHOPLINE 官網訂單、其他平台訂單）
5. 客戶反覆表達不滿或情緒激動
6. 客戶明確要求轉接真人（例如回覆「需要轉接」）
7. 退換貨 SOP：客戶堅持退換貨，你已完成安撫和挽留但客戶仍堅持，此時必須提供退換貨表單連結（${returnFormUrl}）並自動呼叫 transfer_to_human（reason 填寫「退換貨申請 - 客戶堅持退貨」）
8. 修改/取消訂單：安撫後必須轉人工
9. 代客下單/付款失敗/重新出貨：涉及金流隱私，必須立即轉人工

重要規則：
- 你必須誠實告知客戶你是 AI 客服小助手，不要假裝是真人
- 在呼叫 transfer_to_human 之前或同時，你的回覆必須明確說明查詢結果和轉接意圖，範例話術：
  「非常抱歉，我這邊目前查不到這筆資料。我是 AI 客服小助手，為了避免耽誤您的時間，請問需要幫您轉接給專人客服為您進一步查詢嗎？」
  「很抱歉，這個問題超出了我目前的處理範圍。我是 AI 客服小助手，建議為您轉接專人客服來協助處理，請問可以嗎？」
  「抱歉，我在系統中找不到您提到的商品資訊。我是 AI 助手，想幫您轉接給專人客服，讓他們為您查詢，您覺得可以嗎？」
- 嚴禁隱瞞 AI 身分或假裝仍在查詢
- 當客戶回覆「需要轉接」「轉人工」「找真人」等意圖時，直接呼叫 transfer_to_human 並回覆「好的，已為您轉接專人客服，請稍候片刻。」

(絕對規則) 當你呼叫訂單查詢工具，但後端回傳 found=false 或空陣列時，你必須立刻回覆：
「非常抱歉，我這邊目前查不到這筆資料 🥺 我是 AI 客服小助手，為了避免耽誤您的時間，請問需要幫您轉接給【專人客服】為您進一步查詢嗎？（請回覆：需要轉接）」
此規則優先級最高，不可被任何其他規則覆蓋。`;

  return basePrompt + brandBlock + handoffBlock + catalogBlock + knowledgeBlock + imageBlock;
}

const sseClients: Set<import("express").Response> = new Set();

function broadcastSSE(eventType: string, data: any) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "omnichannel_fb_verify_2024";

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

  app.get("/api/debug/status", (_req, res) => {
    try {
      const allChannels = storage.getChannels();
      const allBrands = storage.getBrands();
      const allContacts = storage.getContacts();
      const contactCount = allContacts.length;
      const recentContacts = allContacts
        .sort((a: any, b: any) => new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime())
        .slice(0, 8)
        .map((c: any) => ({
          id: c.id,
          display_name: c.display_name,
          platform: c.platform,
          brand_id: c.brand_id,
          last_message: c.last_message?.substring(0, 40),
          last_message_at: c.last_message_at,
        }));
      const globalToken = storage.getSetting("line_channel_access_token");
      const globalSecret = storage.getSetting("line_channel_secret");
      const testMode = storage.getSetting("test_mode");
      return res.json({
        timestamp: new Date().toISOString(),
        code_version: "v4-bulletproof",
        test_mode: testMode,
        brands: allBrands.map(b => ({ id: b.id, name: b.name, slug: b.slug })),
        channels: allChannels.map(c => ({
          id: c.id,
          brand_id: c.brand_id,
          brand_name: c.brand_name,
          platform: c.platform,
          channel_name: c.channel_name,
          bot_id: c.bot_id || "(EMPTY)",
          has_token: !!(c.access_token),
          has_secret: !!(c.channel_secret),
          is_active: c.is_active,
        })),
        global_settings: {
          has_token: !!globalToken,
          has_secret: !!globalSecret,
        },
        total_contacts: contactCount,
        recent_contacts: recentContacts,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/events", (req, res) => {
    if (!(req as any).session?.authenticated) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("event: connected\ndata: {}\n\n");
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try { res.write(":ping\n\n"); } catch { clearInterval(keepAlive); sseClients.delete(res); }
    }, 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

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

  app.get("/api/brands", authMiddleware, (_req, res) => {
    const brands = storage.getBrands();
    return res.json(brands);
  });

  app.get("/api/brands/:id", authMiddleware, (req, res) => {
    const brand = storage.getBrand(parseInt(req.params.id));
    if (!brand) return res.status(404).json({ message: "品牌不存在" });
    return res.json(brand);
  });

  app.post("/api/brands", authMiddleware, superAdminOnly, (req, res) => {
    const { name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key } = req.body;
    if (!name || !slug) return res.status(400).json({ message: "品牌名稱與代碼為必填" });
    try {
      const brand = storage.createBrand(name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key);
      return res.json({ success: true, brand });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return res.status(400).json({ message: "品牌代碼已存在" });
      }
      return res.status(500).json({ message: "建立失敗" });
    }
  });

  app.put("/api/brands/:id", authMiddleware, superAdminOnly, (req, res) => {
    const id = parseInt(req.params.id);
    const { name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key } = req.body;
    const data: Record<string, string> = {};
    if (name !== undefined) data.name = name;
    if (slug !== undefined) data.slug = slug;
    if (logo_url !== undefined) data.logo_url = logo_url;
    if (description !== undefined) data.description = description;
    if (system_prompt !== undefined) data.system_prompt = system_prompt;
    if (superlanding_merchant_no !== undefined) data.superlanding_merchant_no = superlanding_merchant_no;
    if (superlanding_access_key !== undefined) data.superlanding_access_key = superlanding_access_key;
    if (!storage.updateBrand(id, data)) return res.status(404).json({ message: "品牌不存在" });
    return res.json({ success: true });
  });

  app.delete("/api/brands/:id", authMiddleware, superAdminOnly, (req, res) => {
    const id = parseInt(req.params.id);
    if (!storage.deleteBrand(id)) return res.status(404).json({ message: "品牌不存在" });
    return res.json({ success: true });
  });

  app.get("/api/brands/:id/channels", authMiddleware, (req, res) => {
    const brandId = parseInt(req.params.id);
    const channels = storage.getChannelsByBrand(brandId);
    return res.json(channels);
  });

  app.get("/api/channels", authMiddleware, (_req, res) => {
    const channels = storage.getChannels();
    return res.json(channels);
  });

  app.post("/api/brands/:id/channels", authMiddleware, superAdminOnly, (req, res) => {
    const brandId = parseInt(req.params.id);
    const { platform, channel_name, bot_id, access_token, channel_secret } = req.body;
    if (!platform || !channel_name) return res.status(400).json({ message: "平台與頻道名稱為必填" });
    if (!["line", "messenger"].includes(platform)) return res.status(400).json({ message: "平台須為 line 或 messenger" });
    const channel = storage.createChannel(brandId, platform, channel_name, bot_id, access_token, channel_secret);
    return res.json({ success: true, channel });
  });

  app.put("/api/channels/:id", authMiddleware, superAdminOnly, (req, res) => {
    const id = parseInt(req.params.id);
    const { platform, channel_name, bot_id, access_token, channel_secret, is_active, brand_id } = req.body;
    const data: Record<string, any> = {};
    if (platform !== undefined) data.platform = platform;
    if (channel_name !== undefined) data.channel_name = channel_name;
    if (bot_id !== undefined) data.bot_id = bot_id;
    if (access_token !== undefined) data.access_token = access_token;
    if (channel_secret !== undefined) data.channel_secret = channel_secret;
    if (is_active !== undefined) data.is_active = is_active;
    if (brand_id !== undefined) data.brand_id = brand_id;
    if (!storage.updateChannel(id, data)) return res.status(404).json({ message: "頻道不存在" });
    return res.json({ success: true });
  });

  app.delete("/api/channels/:id", authMiddleware, superAdminOnly, (req, res) => {
    const id = parseInt(req.params.id);
    if (!storage.deleteChannel(id)) return res.status(404).json({ message: "頻道不存在" });
    return res.json({ success: true });
  });

  app.post("/api/brands/:id/test-superlanding", authMiddleware, superAdminOnly, async (req, res) => {
    const id = parseInt(req.params.id);
    const brand = storage.getBrand(id);
    if (!brand) return res.status(404).json({ message: "品牌不存在" });
    const merchantNo = brand.superlanding_merchant_no || storage.getSetting("superlanding_merchant_no") || "";
    const accessKey = brand.superlanding_access_key || storage.getSetting("superlanding_access_key") || "";
    if (!merchantNo || !accessKey) {
      return res.json({ success: false, message: "此品牌尚未設定一頁商店 Merchant No 或 Access Key（品牌專屬或全域預設皆無）" });
    }
    try {
      const slUrl = `https://api.super-landing.com/orders.json?merchant_no=${encodeURIComponent(merchantNo)}&access_key=${encodeURIComponent(accessKey)}&per_page=1`;
      const slRes = await fetch(slUrl, { headers: { Accept: "application/json" } });
      if (slRes.ok) {
        const data = await slRes.json();
        const total = data.total_entries || "N/A";
        return res.json({ success: true, message: `一頁商店連線成功！共 ${total} 筆訂單` });
      }
      const errText = await slRes.text().catch(() => "");
      return res.json({ success: false, message: `一頁商店連線失敗 (HTTP ${slRes.status})：${errText || "請確認 merchant_no 與 access_key 是否正確"}` });
    } catch (fetchErr: any) {
      const detail = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.message || "未知網路錯誤";
      return res.json({ success: false, message: `一頁商店連線失敗（網路錯誤）：${detail}` });
    }
  });

  app.get("/api/health/status", authMiddleware, async (_req, res) => {
    const results: Record<string, { status: "ok" | "error" | "unconfigured"; message: string }> = {};

    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") {
      results.openai = { status: "unconfigured", message: "尚未設定 API 金鑰" };
    } else {
      try {
        const openai = new OpenAI({ apiKey });
        await openai.chat.completions.create({ model: "gpt-5.2", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 5 });
        results.openai = { status: "ok", message: "連線正常" };
      } catch (err: any) {
        results.openai = { status: "error", message: `連線失敗: ${err.message}` };
      }
    }

    const brands = storage.getBrands();
    for (const brand of brands) {
      const merchantNo = brand.superlanding_merchant_no || storage.getSetting("superlanding_merchant_no") || "";
      const accessKey = brand.superlanding_access_key || storage.getSetting("superlanding_access_key") || "";
      const key = `superlanding_brand_${brand.id}`;
      if (!merchantNo || !accessKey) {
        results[key] = { status: "unconfigured", message: "尚未設定" };
      } else {
        try {
          const slUrl = `https://api.super-landing.com/orders.json?merchant_no=${encodeURIComponent(merchantNo)}&access_key=${encodeURIComponent(accessKey)}&per_page=1`;
          const slRes = await fetch(slUrl, { headers: { Accept: "application/json" } });
          if (slRes.ok) {
            results[key] = { status: "ok", message: "連線正常" };
          } else {
            results[key] = { status: "error", message: `HTTP ${slRes.status}` };
          }
        } catch (err: any) {
          results[key] = { status: "error", message: err.message };
        }
      }

      const channels = storage.getChannelsByBrand(brand.id);
      for (const ch of channels) {
        const chKey = `channel_${ch.id}`;
        if (ch.platform === "line") {
          if (!ch.access_token) {
            results[chKey] = { status: "unconfigured", message: "尚未設定 Token" };
          } else {
            try {
              const verifyRes = await fetch("https://api.line.me/v2/bot/info", { headers: { Authorization: `Bearer ${ch.access_token}` } });
              if (verifyRes.ok) {
                results[chKey] = { status: "ok", message: "連線正常" };
              } else {
                results[chKey] = { status: "error", message: `驗證失敗 (${verifyRes.status})` };
              }
            } catch (err: any) {
              results[chKey] = { status: "error", message: err.message };
            }
          }
        } else {
          results[chKey] = ch.access_token ? { status: "ok", message: "已設定 Token" } : { status: "unconfigured", message: "尚未設定 Token" };
        }
      }
    }

    return res.json(results);
  });

  app.post("/api/channels/:id/test", authMiddleware, superAdminOnly, async (req, res) => {
    const id = parseInt(req.params.id);
    const channel = storage.getChannel(id);
    if (!channel) return res.status(404).json({ message: "頻道不存在" });
    if (channel.platform === "line") {
      if (!channel.access_token) return res.json({ success: false, message: "尚未設定 Access Token" });
      try {
        const verifyRes = await fetch("https://api.line.me/v2/bot/info", {
          headers: { Authorization: `Bearer ${channel.access_token}` },
        });
        if (verifyRes.ok) {
          const botInfo = await verifyRes.json();
          const botUserId = botInfo.userId || "";
          if (botUserId && !channel.bot_id) {
            storage.updateChannel(id, { bot_id: botUserId });
          }
          return res.json({ success: true, message: `LINE 連線成功！Bot: ${botInfo.displayName || botInfo.basicId || "OK"}`, botUserId });
        }
        const errBody = await verifyRes.text();
        return res.json({ success: false, message: `LINE 驗證失敗 (${verifyRes.status}): ${errBody}` });
      } catch (err: any) {
        return res.json({ success: false, message: `連線失敗: ${err.message}` });
      }
    }
    if (channel.platform === "messenger") {
      if (!channel.access_token) return res.json({ success: false, message: "尚未設定 Page Access Token" });
      try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${encodeURIComponent(channel.access_token)}`);
        if (fbRes.ok) {
          const pageInfo = await fbRes.json();
          const pageId = pageInfo.id || "";
          if (pageId && !channel.bot_id) {
            storage.updateChannel(id, { bot_id: pageId });
          }
          return res.json({ success: true, message: `Facebook 連線成功！粉專: ${pageInfo.name || "OK"} (ID: ${pageId})`, botId: pageId });
        }
        const errBody = await fbRes.text();
        return res.json({ success: false, message: `Facebook 驗證失敗 (${fbRes.status}): ${errBody}` });
      } catch (err: any) {
        return res.json({ success: false, message: `連線失敗: ${err.message}` });
      }
    }
    return res.json({ success: false, message: `暫不支援 ${channel.platform} 頻道測試` });
  });

  app.get("/api/contacts", authMiddleware, (req: any, res) => {
    const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
    const contacts = storage.getContacts(brandId);
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

  function buildRatingFlexMessage(contactId: number, ratingType: "human" | "ai" = "human"): object {
    const actionPrefix = ratingType === "ai" ? "rate_ai" : "rate";
    const stars = [1, 2, 3, 4, 5].map((score) => ({
      type: "button",
      action: {
        type: "postback",
        label: "⭐",
        data: `action=${actionPrefix}&ticket_id=${contactId}&score=${score}`,
        displayText: `${"⭐".repeat(score)}`,
      },
      style: "link",
      height: "sm",
      flex: 1,
    }));

    const headerText = ratingType === "ai" ? "感謝使用 AI 客服！" : "感謝您的詢問！";
    const bodyText = ratingType === "ai" 
      ? "請為本次 AI 客服體驗評分：" 
      : "為了提供更優質的服務，請為本次真人客服體驗評分：";
    const headerColor = ratingType === "ai" ? "#6366F1" : "#1DB446";
    const bgColor = ratingType === "ai" ? "#F5F3FF" : "#F7FFF7";

    return {
      type: "flex",
      altText: ratingType === "ai" ? "AI 客服滿意度調查" : "真人客服滿意度調查",
      contents: {
        type: "bubble",
        size: "kilo",
        header: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: headerText, weight: "bold", size: "lg", color: headerColor, align: "center" },
          ],
          paddingAll: "16px",
          backgroundColor: bgColor,
        },
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: bodyText, size: "sm", color: "#555555", wrap: true, align: "center" },
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

  function getLineTokenForContact(contact: { channel_id?: number | null; brand_id?: number | null }): string | null {
    if (contact.channel_id) {
      const channel = storage.getChannel(contact.channel_id);
      if (channel?.platform === "line" && channel?.access_token) return channel.access_token;
    }
    if (contact.brand_id) {
      const channels = storage.getChannelsByBrand(contact.brand_id);
      const lineChannel = channels.find(c => c.platform === "line" && c.access_token);
      if (lineChannel?.access_token) return lineChannel.access_token;
    }
    return storage.getSetting("line_channel_access_token");
  }

  async function sendRatingFlexMessage(contact: { id: number; platform_user_id: string; channel_id?: number | null }, ratingType: "human" | "ai" = "human") {
    const token = getLineTokenForContact(contact);
    if (!token) return;
    try {
      const flexMsg = buildRatingFlexMessage(contact.id, ratingType);
      await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ to: contact.platform_user_id, messages: [flexMsg] }),
      });
    } catch (err) {
      console.error("LINE rating flex message push failed:", err);
    }
  }

  app.put("/api/contacts/:id/status", authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (!["pending", "processing", "resolved"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    storage.updateContactStatus(id, status);
    broadcastSSE("contacts_updated", { contact_id: id });

    if (status === "resolved") {
      const contact = storage.getContact(id);
      if (contact) {
        let ratingSent = false;
        if (contact.needs_human === 1 && contact.cs_rating == null) {
          if (contact.platform === "line") {
            const token = getLineTokenForContact(contact);
            if (token) {
              try {
                await sendRatingFlexMessage(contact, "human");
                storage.createMessage(id, contact.platform, "system", "(系統提示) 已自動發送真人客服滿意度調查卡片給客戶");
                ratingSent = true;
              } catch (err) {
                console.error("Auto rating (human) send failed:", err);
              }
            }
          }
        }
        if (!ratingSent && contact.ai_rating == null) {
          if (contact.platform === "line") {
            const token = getLineTokenForContact(contact);
            if (token) {
              try {
                await sendRatingFlexMessage(contact, "ai");
                storage.createMessage(id, contact.platform, "system", "(系統提示) 已自動發送 AI 客服滿意度調查卡片給客戶");
              } catch (err) {
                console.error("Auto rating (ai) send failed:", err);
              }
            }
          }
        }
      }
    }

    return res.json({ success: true });
  });

  app.post("/api/contacts/:id/send-rating", authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id);
    const ratingType = (req.body?.type === "ai" ? "ai" : "human") as "human" | "ai";
    const contact = storage.getContact(id);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    if (ratingType === "ai" && contact.ai_rating != null) {
      return res.status(400).json({ message: "此客戶 AI 評分已完成，無法重複發送" });
    }
    if (ratingType === "human" && contact.cs_rating != null) {
      return res.status(400).json({ message: "此客戶真人評分已完成，無法重複發送" });
    }
    if (contact.platform !== "line") {
      return res.status(400).json({ message: "僅支援 LINE 平台" });
    }
    const token = getLineTokenForContact(contact);
    if (!token) {
      return res.status(400).json({ message: "尚未設定 LINE Channel Access Token" });
    }
    try {
      await sendRatingFlexMessage(contact, ratingType);
      const typeLabel = ratingType === "ai" ? "AI 客服" : "真人客服";
      storage.createMessage(id, contact.platform, "system", `(系統提示) 已手動發送${typeLabel}滿意度調查卡片給客戶`);
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

  app.get("/api/messages/search", authMiddleware, (req, res) => {
    const q = (req.query.q as string || "").trim();
    if (!q || q.length < 2) return res.json([]);
    return res.json(storage.searchMessages(q));
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
    broadcastSSE("new_message", { contact_id: contactId, message, brand_id: contact.brand_id });
    broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
    storage.updateContactHumanFlag(contactId, 1);

    if (contact.platform === "line") {
      const token = getLineTokenForContact(contact);
      if (token) {
        if (image_url) {
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
        } else if (content) {
          pushLineMessage(contact.platform_user_id, [{ type: "text", text: content }], token).catch((err) =>
            console.error("LINE text push failed:", err)
          );
        }
      }
    } else if (contact.platform === "messenger") {
      const fbToken = contact.channel_id ? storage.getChannel(contact.channel_id)?.access_token : null;
      if (fbToken && content) {
        sendFBMessage(fbToken, contact.platform_user_id, content).catch((err) =>
          console.error("FB text push failed:", err)
        );
      }
    }

    return res.json(message);
  });

  app.post("/api/chat-upload", authMiddleware, chatUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "僅支援 JPG, PNG, GIF, WebP 圖片格式，檔案大小不超過 10MB" });
    const fileUrl = `/uploads/${req.file.filename}`;
    return res.json({ url: fileUrl, filename: fixMulterFilename(req.file.originalname), size: req.file.size });
  });

  app.get("/api/contacts/:id/orders", authMiddleware, async (req, res) => {
    const contactId = parseInt(req.params.id);
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const config = getSuperLandingConfig(contact.brand_id || undefined);
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
    const { q, brand_id } = req.query;
    const query = (q as string || "").trim().toUpperCase();
    if (!query) return res.status(400).json({ message: "請提供訂單編號" });
    const config = getSuperLandingConfig(brand_id ? parseInt(brand_id as string) : undefined);
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ orders: [], error: "not_configured", message: "尚未設定一頁商店 API 金鑰" });
    }
    try {
      console.log("[一頁商店] 以訂單編號查詢:", query, "(已自動大寫)");
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
    const { q, begin_date, end_date, brand_id } = req.query;
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

    const config = getSuperLandingConfig(brand_id ? parseInt(brand_id as string) : undefined);
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
    const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
    const config = getSuperLandingConfig(brandId);
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
    const { page_id, phone, brand_id } = req.query;
    const pageId = (page_id as string || "").trim();
    const phoneNum = (phone as string || "").trim();

    if (!pageId) return res.status(400).json({ message: "請選擇產品（page_id）" });
    if (!phoneNum) return res.status(400).json({ message: "請提供手機號碼" });

    const config = getSuperLandingConfig(brand_id ? parseInt(brand_id as string) : undefined);
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

  async function analyzeImageWithAI(imageFilePath: string, contactId: number, lineToken?: string | null) {
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") return;
    try {
      const absPath = path.join(process.cwd(), imageFilePath.startsWith("/") ? imageFilePath.slice(1) : imageFilePath);
      const imageBuffer = fs.readFileSync(absPath);
      const base64 = imageBuffer.toString("base64");
      const ext = path.extname(absPath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const dataUri = `data:${mimeType};base64,${base64}`;

      const contact = storage.getContact(contactId);
      let systemPrompt = await getEnrichedSystemPrompt(contact?.brand_id || undefined);

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

      const token = lineToken || getLineTokenForContact(contact || {});
      if (token && contact) {
        await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
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

  async function replyToLine(replyToken: string, messages: object[], token?: string | null) {
    const resolvedToken = token || storage.getSetting("line_channel_access_token");
    if (!resolvedToken || !replyToken) return;
    try {
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resolvedToken}` },
        body: JSON.stringify({ replyToken, messages }),
      });
    } catch (err) {
      console.error("LINE reply failed:", err);
    }
  }

  async function pushLineMessage(userId: string, messages: object[], token?: string | null) {
    const resolvedToken = token || storage.getSetting("line_channel_access_token");
    if (!resolvedToken) return;
    try {
      await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resolvedToken}` },
        body: JSON.stringify({ to: userId, messages }),
      });
    } catch (err) {
      console.error("LINE push failed:", err);
    }
  }

  async function sendFBMessage(pageAccessToken: string, recipientId: string, text: string) {
    await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    });
  }

  async function autoReplyWithAI(
    contact: Contact,
    userMessage: string,
    channelToken?: string | null,
    brandId?: number,
    platform?: string
  ) {
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") return;

    try {
      const systemPrompt = await getEnrichedSystemPrompt(contact.brand_id || brandId || undefined);
      const openai = new OpenAI({ apiKey });

      const recentMessages = storage.getMessages(contact.id).slice(-20);
      const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
      ];
      for (const msg of recentMessages) {
        if (msg.sender_type === "user") {
          chatMessages.push({ role: "user", content: msg.content });
        } else if (msg.sender_type === "ai") {
          chatMessages.push({ role: "assistant", content: msg.content });
        }
      }

      const effectiveBrandId = contact.brand_id || brandId;
      const hasImageAssets = storage.getImageAssets(effectiveBrandId || undefined).length > 0;
      const allTools = [...orderLookupTools, ...humanHandoffTools, ...(hasImageAssets ? imageTools : [])];

      let completion = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: chatMessages,
        tools: allTools,
        max_completion_tokens: 1000,
        temperature: 0.7,
      });

      let responseMessage = completion.choices[0]?.message;
      let loopCount = 0;
      const maxToolLoops = 3;

      while (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0 && loopCount < maxToolLoops) {
        loopCount++;
        console.log(`[Webhook AI] 觸發 ${responseMessage.tool_calls.length} 個 Tool Call（第 ${loopCount} 輪）`);
        chatMessages.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);

        for (const toolCall of responseMessage.tool_calls) {
          const fnName = toolCall.function.name;
          let fnArgs: Record<string, string> = {};
          try { fnArgs = JSON.parse(toolCall.function.arguments); } catch {}

          console.log(`[Webhook AI] 執行 Tool: ${fnName}，參數:`, fnArgs);
          const toolResult = await executeToolCall(fnName, fnArgs, {
            contactId: contact.id,
            brandId: effectiveBrandId || undefined,
            channelToken: channelToken || undefined,
            platform: contact.platform,
            platformUserId: contact.platform_user_id,
          });

          chatMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });

          if (fnName === "transfer_to_human") {
            const freshContact = storage.getContact(contact.id);
            if (freshContact?.needs_human) {
              console.log(`[Webhook AI] transfer_to_human 已觸發，停止 AI 回覆迴圈`);
            }
          }
        }

        const freshContact = storage.getContact(contact.id);
        if (freshContact?.needs_human) break;

        completion = await openai.chat.completions.create({
          model: "gpt-5.2",
          messages: chatMessages,
          tools: allTools,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
        responseMessage = completion.choices[0]?.message;
      }

      const finalContact = storage.getContact(contact.id);
      if (finalContact?.needs_human) {
        console.log(`[Webhook AI] 已轉接真人，跳過 AI 回覆`);
        return;
      }

      const reply = responseMessage?.content;
      if (reply && reply.trim()) {
        const contactPlatform = platform || contact.platform || "line";
        const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", reply);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, reply);
        } else {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: reply }], channelToken);
        }
      }
    } catch (err) {
      console.error("[Webhook AI] 自動回覆失敗:", err);
    }
  }

  app.post("/api/webhook/line", (req, res) => {
    try {
    console.log("===== [LINE WEBHOOK START] =====");
    console.log("[WEBHOOK] destination:", req.body?.destination);
    console.log("[WEBHOOK] events count:", req.body?.events?.length || 0);

    const signature = req.headers["x-line-signature"] as string | undefined;
    const destination = req.body?.destination as string | undefined;

    let channelToken: string | null = null;
    let channelSecretVal: string | null = null;
    let matchedChannel: import("@shared/schema").ChannelWithBrand | undefined;
    let matchedBrandId: number | undefined;

    if (destination) {
      console.log("[WEBHOOK] Looking up bot_id:", destination);
      matchedChannel = storage.getChannelByBotId(destination);
      if (matchedChannel) {
        channelToken = matchedChannel.access_token || null;
        channelSecretVal = matchedChannel.channel_secret || null;
        matchedBrandId = matchedChannel.brand_id;
        console.log("[WEBHOOK] MATCH FOUND - brand:", matchedChannel.brand_name, "channel:", matchedChannel.channel_name);
      } else {
        const allChannels = storage.getChannels();
        const botIds = allChannels.map(c => `${c.channel_name}(bot_id=${c.bot_id || "EMPTY"})`).join(", ");
        console.log("[WEBHOOK] NO MATCH for bot_id:", destination);
        console.log("[WEBHOOK] DB channels:", botIds || "NONE");
        const firstChannel = allChannels.find(c => c.platform === "line" && c.access_token);
        if (firstChannel) {
          console.log("[WEBHOOK] FALLBACK to first LINE channel:", firstChannel.channel_name);
          channelToken = firstChannel.access_token || null;
          channelSecretVal = firstChannel.channel_secret || null;
          matchedBrandId = firstChannel.brand_id;
          storage.updateChannel(firstChannel.id, { bot_id: destination });
          console.log("[WEBHOOK] AUTO-FIXED: Updated channel bot_id to", destination);
        }
      }
    } else {
      console.log("[WEBHOOK] No destination field in webhook body");
    }

    if (!channelSecretVal) {
      channelSecretVal = storage.getSetting("line_channel_secret");
      console.log("[WEBHOOK] Using global channel_secret, exists:", !!channelSecretVal);
    }
    if (!channelToken) {
      channelToken = storage.getSetting("line_channel_access_token");
      console.log("[WEBHOOK] Using global channel_token, exists:", !!channelToken);
    }

    console.log("[WEBHOOK] Token available:", !!channelToken, "Secret available:", !!channelSecretVal);

    if (channelSecretVal && signature && req.rawBody) {
      try {
        const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody as string);
        const hash = crypto.createHmac("SHA256", channelSecretVal).update(rawBody).digest("base64");
        if (hash !== signature) {
          console.log("[WEBHOOK] SIGNATURE MISMATCH (warning only, still processing) - Expected:", hash, "Got:", signature);
        } else {
          console.log("[WEBHOOK] Signature verified OK");
        }
      } catch (sigErr: any) {
        console.log("[WEBHOOK] Signature check error (continuing):", sigErr.message);
      }
    } else {
      console.log("[WEBHOOK] Skipping signature check - secret:", !!channelSecretVal, "sig:", !!signature, "rawBody:", !!req.rawBody);
    }

    res.status(200).json({ success: true });
    console.log("[WEBHOOK] Sent 200 OK to LINE, processing events async...");

    const humanKeywordsSetting = storage.getSetting("human_transfer_keywords");
    const HUMAN_KEYWORDS = humanKeywordsSetting
      ? humanKeywordsSetting.split(",").map((k) => k.trim()).filter(Boolean)
      : ["找客服", "真人", "轉人工", "人工客服", "真人客服"];

    const events = req.body?.events || [];
    (async () => {
    for (const event of events) {
      const webhookEventId = event.webhookEventId || event.timestamp?.toString();
      if (webhookEventId && storage.isEventProcessed(webhookEventId)) {
        continue;
      }

      try {
        console.log("[WEBHOOK] Processing event:", event.type, event.message?.type || "", "from:", event.source?.userId || "unknown");
        if (event.type === "message" && event.message?.type === "text") {
          const userId = event.source?.userId || "unknown";
          const displayName = event.source?.displayName || "LINE用戶";
          const text = event.message.text;
          console.log("[WEBHOOK] Text message from", userId, ":", text.substring(0, 50));
          const contact = storage.getOrCreateContact("line", userId, displayName, matchedBrandId, matchedChannel?.id);
          console.log("[WEBHOOK] Contact id:", contact.id, "brand_id:", contact.brand_id, "needs_human:", contact.needs_human);
          const userMsg = storage.createMessage(contact.id, "line", "user", text);
          console.log("[WEBHOOK] Message saved id:", userMsg.id);
          broadcastSSE("new_message", { contact_id: contact.id, message: userMsg, brand_id: matchedBrandId || contact.brand_id });
          broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
          const needsHuman = HUMAN_KEYWORDS.some((kw) => text.includes(kw));
          if (needsHuman) {
            storage.updateContactHumanFlag(contact.id, 1);
            const aiMsg = storage.createMessage(contact.id, "line", "ai", "好的，我已為您轉接真人客服，請稍候片刻。");
            broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: matchedBrandId || contact.brand_id });
            broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
          } else if (!contact.needs_human) {
            const testMode = storage.getSetting("test_mode");
            if (testMode === "true") {
              storage.createMessage(contact.id, "line", "ai", `[測試模式] 收到您的訊息：「${text}」。`);
            } else {
              autoReplyWithAI(contact, text, channelToken, matchedBrandId).catch(err =>
                console.error("[Webhook] AI 自動回覆失敗:", err)
              );
            }
          }
        } else if (event.type === "postback") {
          const data = event.postback?.data || "";
          const params = new URLSearchParams(data);
          const postbackAction = params.get("action");
          if (postbackAction === "rate" || postbackAction === "rate_ai") {
            const ticketId = parseInt(params.get("ticket_id") || "0");
            const score = parseInt(params.get("score") || "0");
            if (ticketId > 0 && score >= 1 && score <= 5) {
              const isAi = postbackAction === "rate_ai";
              if (isAi) {
                storage.updateContactAiRating(ticketId, score);
                storage.createMessage(ticketId, "line", "system", `(系統提示) 客戶 AI 客服評分：${"⭐".repeat(score)}（${score} 分）`);
              } else {
                storage.updateContactRating(ticketId, score);
                storage.createMessage(ticketId, "line", "system", `(系統提示) 客戶真人客服評分：${"⭐".repeat(score)}（${score} 分）`);
              }
              const typeLabel = isAi ? "AI 客服" : "真人客服";
              replyToLine(event.replyToken, [
                { type: "text", text: `已收到您對${typeLabel}的 ${"⭐".repeat(score)} 評分，感謝您的寶貴意見！祝您有美好的一天。` },
              ], channelToken);
            }
          }
        } else if (event.type === "follow" || event.type === "unfollow" || event.type === "join" || event.type === "leave" || event.type === "memberJoined" || event.type === "memberLeft") {
          // silently ignore lifecycle events
        } else if (event.type === "message" && event.message?.type === "image") {
          const userId = event.source?.userId || "unknown";
          const displayName = event.source?.displayName || "LINE用戶";
          const contact = storage.getOrCreateContact("line", userId, displayName, matchedBrandId, matchedChannel?.id);
          const messageId = event.message.id;
          const imageUrl = await downloadLineContent(messageId, ".jpg");
          if (imageUrl) {
            const imgMsg = storage.createMessage(contact.id, "line", "user", "[圖片訊息]", "image", imageUrl);
            broadcastSSE("new_message", { contact_id: contact.id, message: imgMsg, brand_id: matchedBrandId || contact.brand_id });
            broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
            if (!contact.needs_human) {
              analyzeImageWithAI(imageUrl, contact.id, channelToken).catch((err) =>
                console.error("AI image analysis background error:", err)
              );
            }
          } else {
            storage.createMessage(contact.id, "line", "user", "[圖片訊息] (下載失敗)");
          }
        } else if (event.type === "message" && event.message?.type === "video") {
          const userId = event.source?.userId || "unknown";
          const displayName = event.source?.displayName || "LINE用戶";
          const contact = storage.getOrCreateContact("line", userId, displayName, matchedBrandId, matchedChannel?.id);
          const messageId = event.message.id;
          const videoUrl = await downloadLineContent(messageId, ".mp4");
          if (videoUrl) {
            storage.createMessage(contact.id, "line", "user", "[影片訊息]", "video", videoUrl);
          } else {
            storage.createMessage(contact.id, "line", "user", "[影片訊息] (下載失敗)");
          }
          storage.createMessage(contact.id, "line", "ai", "(AI 系統提示) 已收到您的影片，將為您轉交專人檢視。");
          storage.updateContactHumanFlag(contact.id, 1);
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: "已收到您的影片，將為您轉交專人檢視。" }], channelToken);
        } else if (event.type === "message" && event.message?.type !== "text") {
          const userId = event.source?.userId || "unknown";
          const displayName = event.source?.displayName || "LINE用戶";
          const contact = storage.getOrCreateContact("line", userId, displayName, matchedBrandId, matchedChannel?.id);
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
    console.log("[WEBHOOK] All events processed");
    })().catch(err => console.error("[WEBHOOK] Async event processing error:", err));
    } catch (outerErr) {
      console.error("[WEBHOOK] FATAL ERROR in webhook handler:", outerErr);
      if (!res.headersSent) res.status(200).json({ success: true });
    }
  });

  app.get("/api/webhook/facebook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
      console.log("[FB Webhook] 驗證成功");
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ message: "驗證失敗" });
  });

  app.post("/api/webhook/facebook", async (req, res) => {
    const body = req.body;
    if (body.object !== "page") {
      return res.status(404).json({ message: "Not a page event" });
    }

    for (const entry of body.entry || []) {
      const pageId = entry.id;
      const matchedChannel = storage.getChannelByBotId(pageId);
      const matchedBrandId = matchedChannel?.brand_id;

      if (matchedChannel) {
        console.log(`[FB Webhook] 動態路由 → 品牌: ${matchedChannel.brand_name}, 頻道: ${matchedChannel.channel_name}`);
      } else {
        console.log(`[FB Webhook] 未匹配頻道，Page ID: ${pageId}`);
      }

      for (const messagingEvent of entry.messaging || []) {
        const senderId = messagingEvent.sender?.id;
        if (!senderId || senderId === pageId) continue;

        const msgMid = messagingEvent.message?.mid || messagingEvent.postback?.mid || "";
        const eventId = `fb_${messagingEvent.timestamp}_${senderId}_${msgMid}`;
        if (storage.isEventProcessed(eventId)) continue;

        try {
          if (messagingEvent.message) {
            const text = messagingEvent.message.text || "";
            const displayName = `FB用戶_${senderId.substring(0, 6)}`;
            const contact = storage.getOrCreateContact("messenger", senderId, displayName, matchedBrandId, matchedChannel?.id);

            if (messagingEvent.message.attachments) {
              for (const att of messagingEvent.message.attachments) {
                if (att.type === "image" && att.payload?.url) {
                  const imgMsg = storage.createMessage(contact.id, "messenger", "user", "[圖片訊息]", "image", att.payload.url);
                  broadcastSSE("new_message", { contact_id: contact.id, message: imgMsg, brand_id: matchedBrandId || contact.brand_id });
                } else {
                  storage.createMessage(contact.id, "messenger", "user", `[${att.type || "附件"}]`);
                }
              }
              broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
            }

            if (text) {
              const userMsg = storage.createMessage(contact.id, "messenger", "user", text);
              broadcastSSE("new_message", { contact_id: contact.id, message: userMsg, brand_id: matchedBrandId || contact.brand_id });
              broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });

              const humanKeywordsSetting2 = storage.getSetting("human_transfer_keywords");
              const HUMAN_KW2 = humanKeywordsSetting2
                ? humanKeywordsSetting2.split(",").map(k => k.trim()).filter(Boolean)
                : ["找客服", "真人", "轉人工", "人工客服", "真人客服"];
              const needsHuman2 = HUMAN_KW2.some(kw => text.includes(kw));
              if (needsHuman2) {
                storage.updateContactHumanFlag(contact.id, 1);
                const aiMsg2 = storage.createMessage(contact.id, "messenger", "ai", "好的，我已為您轉接真人客服，請稍候片刻。");
                broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg2, brand_id: matchedBrandId || contact.brand_id });
                broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
                if (matchedChannel?.access_token) {
                  sendFBMessage(matchedChannel.access_token, senderId, "好的，我已為您轉接真人客服，請稍候片刻。").catch(err =>
                    console.error("[FB Webhook] 轉人工回覆失敗:", err)
                  );
                }
              } else if (!contact.needs_human) {
                const testMode = storage.getSetting("test_mode");
                if (testMode !== "true" && matchedChannel?.access_token) {
                  autoReplyWithAI(contact, text, matchedChannel.access_token, matchedBrandId, "messenger").catch(err =>
                    console.error("[FB Webhook] AI 自動回覆失敗:", err)
                  );
                }
              }
            }
          }

          if (messagingEvent.postback) {
            const text = messagingEvent.postback.title || messagingEvent.postback.payload || "[Postback]";
            const displayName = `FB用戶_${senderId.substring(0, 6)}`;
            const contact = storage.getOrCreateContact("messenger", senderId, displayName, matchedBrandId, matchedChannel?.id);
            const pbMsg = storage.createMessage(contact.id, "messenger", "user", text);
            broadcastSSE("new_message", { contact_id: contact.id, message: pbMsg, brand_id: matchedBrandId || contact.brand_id });
            broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
          }
        } catch (err) {
          console.error("[FB Webhook] 事件處理錯誤:", err);
        }

        storage.markEventProcessed(eventId);
      }
    }
    return res.status(200).send("EVENT_RECEIVED");
  });

  const orderLookupTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "lookup_order_by_id",
        description: "用訂單編號直接查詢訂單狀態。當客戶提供了訂單編號（如 KBT58265、DEN12345、MRQ00001 等格式）時使用此工具。系統會自動將小寫轉為大寫。",
        parameters: {
          type: "object",
          properties: {
            order_id: {
              type: "string",
              description: "客戶提供的訂單編號，例如 KBT58265（不區分大小寫）",
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
        description: "用商品名稱＋手機號碼查詢訂單。必須提供商品名稱（或 product_index）和手機號碼。系統會根據商品名稱比對銷售頁的 page_id，再用 page_id 搭配手機號碼查詢訂單。如果客戶只提供手機號碼但沒有提供商品名稱，你必須先詢問客戶購買的是什麼商品，不要直接呼叫此工具。",
        parameters: {
          type: "object",
          properties: {
            product_index: {
              type: "integer",
              description: "商品在內部清單中的編號（如清單中 #3 就填 3）。如果你能從商品清單中確定對應的商品，請優先使用此欄位。",
            },
            product_name: {
              type: "string",
              description: "客戶購買的商品名稱（可以是簡稱、俗稱、關鍵字片段皆可）。當無法確定 product_index 時使用。必填（除非已提供 product_index）。",
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
        description: "用下單日期範圍、聯絡資訊和 page_id 查詢訂單。必須提供 page_id（從商品比對取得）。當客戶提供了下單日期區間和 Email/手機/姓名，且能確定商品時使用。",
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
            page_id: {
              type: "string",
              description: "銷售頁 ID（從商品比對結果取得，若無則先用 lookup_order_by_product_and_phone 找到對應商品）",
            },
          },
          required: ["contact", "begin_date", "end_date"],
        },
      },
    },
  ];

  const humanHandoffTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "transfer_to_human",
        description: "當你無法確定答案、多次查詢仍查不到訂單、知識庫中找不到客戶描述的商品、客戶問題過於複雜、或判斷為非本系統管轄的訂單（如 SHOPLINE 官網訂單）、或客戶明確要求轉接真人時，呼叫此工具將對話轉交給真人客服。注意：呼叫此工具前，你必須先誠實表明自己是 AI 客服小助手，並明確告知客戶查詢結果（如查不到訂單、找不到商品等），然後詢問客戶是否需要轉接專人客服。",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "轉接原因（內部記錄用，會顯示在中控台系統訊息中）",
            },
          },
          required: [],
        },
      },
    },
  ];

  const imageTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "send_image_to_customer",
        description: "發送圖片素材給客戶。當你認為客戶的問題用圖片回覆會更清晰（例如：產品特色圖、使用教學圖、活動海報），且圖片素材庫中有對應圖片時使用。",
        parameters: {
          type: "object",
          properties: {
            image_name: {
              type: "string",
              description: "圖片素材庫中的圖片名稱（display_name 或 original_name）",
            },
            text_message: {
              type: "string",
              description: "搭配圖片發送的文字訊息（選填）",
            },
          },
          required: ["image_name"],
        },
      },
    },
  ];

  async function sendImageAsset(
    asset: { id: number; filename: string; display_name: string },
    textMessage: string,
    context?: { contactId?: number; brandId?: number; channelToken?: string; platform?: string; platformUserId?: string }
  ): Promise<string> {
    const host = process.env.REPL_SLUG ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co` : `https://${process.env.REPLIT_DEV_DOMAIN || "localhost:5000"}`;
    const imageUrl = `${host}/api/image-assets/file/${asset.filename}`;

    if (context?.platform === "line" && context?.platformUserId && context?.channelToken) {
      const messages: object[] = [];
      if (textMessage) {
        messages.push({ type: "text", text: textMessage });
      }
      messages.push({
        type: "image",
        originalContentUrl: imageUrl,
        previewImageUrl: imageUrl,
      });
      await pushLineMessage(context.platformUserId, messages, context.channelToken);
      if (context.contactId) {
        if (textMessage) storage.createMessage(context.contactId, "line", "ai", textMessage);
        storage.createMessage(context.contactId, "line", "ai", `[圖片: ${asset.display_name}]`, "image", imageUrl);
      }
      return JSON.stringify({ success: true, message: `已發送圖片「${asset.display_name}」給客戶` });
    }

    return JSON.stringify({
      success: true,
      message: `圖片「${asset.display_name}」已準備`,
      image_url: imageUrl,
      text_message: textMessage,
    });
  }

  async function executeToolCall(
    toolName: string,
    args: Record<string, string>,
    context?: { contactId?: number; brandId?: number; channelToken?: string; platform?: string; platformUserId?: string }
  ): Promise<string> {
    if (toolName === "transfer_to_human") {
      const reason = (args.reason || "AI 判斷需要人工處理").trim();
      console.log(`[AI Tool Call] transfer_to_human，原因: ${reason}，contactId: ${context?.contactId}`);
      if (context?.contactId) {
        storage.updateContactHumanFlag(context.contactId, 1);
        storage.createMessage(context.contactId, context?.platform || "line", "system",
          `(系統提示) AI 已放棄查詢並轉接真人客服。轉接原因：${reason}`);
      }
      return JSON.stringify({ success: true, message: "已將對話轉交真人客服處理。請在回覆中誠實告知客戶你是 AI 助手，並說明轉接原因。" });
    }

    if (toolName === "send_image_to_customer") {
      const imageName = (args.image_name || "").trim();
      const textMessage = (args.text_message || "").trim();
      if (!imageName) return JSON.stringify({ success: false, error: "未提供圖片名稱" });

      const asset = storage.getImageAssetByName(imageName, context?.brandId);
      if (!asset) {
        const allAssets = storage.getImageAssets(context?.brandId);
        const fuzzyMatch = allAssets.find(a =>
          a.display_name.includes(imageName) || imageName.includes(a.display_name) ||
          a.original_name.includes(imageName) || (a.keywords && a.keywords.includes(imageName))
        );
        if (!fuzzyMatch) return JSON.stringify({ success: false, error: `找不到圖片: ${imageName}` });
        return await sendImageAsset(fuzzyMatch, textMessage, context);
      }
      return await sendImageAsset(asset, textMessage, context);
    }

    const config = getSuperLandingConfig(context?.brandId);
    if (!config.merchantNo || !config.accessKey) {
      return JSON.stringify({ success: false, error: "系統尚未設定一頁商店 API 金鑰，無法查詢訂單。請至系統設定 → 品牌管理中設定該品牌的一頁商店 API 金鑰。" });
    }

    try {
      if (toolName === "lookup_order_by_id") {
        const orderId = (args.order_id || "").trim().toUpperCase();
        console.log(`[AI Tool Call] lookup_order_by_id，單號: ${orderId} (已自動大寫)，品牌ID: ${context?.brandId || "無"}`);
        console.log(`[API 請求] 準備查詢單號: ${orderId}，使用 merchant_no: ${config.merchantNo}`);

        if (!orderId) {
          return JSON.stringify({ success: false, error: "訂單編號為空" });
        }

        let order = await lookupOrderById(config, orderId);

        if (!order) {
          console.log(`[AI Tool Call] 品牌 ${context?.brandId || "預設"} 查無訂單: ${orderId}，嘗試跨品牌查詢...`);
          const allBrands = storage.getBrands();
          for (const brand of allBrands) {
            if (brand.id === context?.brandId) continue;
            if (!brand.superlanding_merchant_no || !brand.superlanding_access_key) continue;
            const altConfig: SuperLandingConfig = {
              merchantNo: brand.superlanding_merchant_no,
              accessKey: brand.superlanding_access_key,
            };
            console.log(`[API 請求] 跨品牌查詢: 品牌「${brand.name}」(ID:${brand.id})，merchant_no: ${altConfig.merchantNo}`);
            try {
              const altOrder = await lookupOrderById(altConfig, orderId);
              if (altOrder) {
                console.log(`[API 回應] 在品牌「${brand.name}」找到訂單 ${orderId}`);
                order = altOrder;
                break;
              }
            } catch (altErr) {
              console.log(`[API 回應] 品牌「${brand.name}」查詢失敗:`, altErr);
            }
          }
        }

        if (!order) {
          console.log(`[AI Tool Call] 所有品牌皆查無訂單: ${orderId}`);
          return JSON.stringify({ success: true, found: false, message: `所有品牌帳戶皆查無訂單編號 ${orderId} 的紀錄。(絕對規則) 你現在必須立刻誠實表明你是 AI 客服小助手，告知客戶目前查不到這筆資料，並詢問是否需要轉接專人客服。` });
        }

        const statusLabel = (await import("./superlanding")).getStatusLabel(order.status);
        console.log(`[AI Tool Call] 查到訂單: ${orderId}，狀態: ${statusLabel}`);
        console.log(`[API 回應] 查詢結果:`, JSON.stringify({ order_id: order.global_order_id, status: statusLabel, amount: order.final_total_order_amount, buyer: order.buyer_name }));
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

        if (!productName && !productIndex) {
          console.log("[AI Tool Call] 禁止：僅手機號碼無商品名稱，拒絕全域搜尋");
          return JSON.stringify({
            success: false,
            error: "必須提供商品名稱或 product_index 才能查詢訂單。請先詢問客戶購買的是什麼商品，確認後再查詢。禁止僅用手機號碼進行全域搜尋。",
            require_product: true,
          });
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
          const knowledgeFiles = storage.getKnowledgeFiles(context?.brandId);
          for (const kf of knowledgeFiles) {
            if (!kf.content) continue;
            const lines = kf.content.split(/\r?\n/);
            for (const line of lines) {
              const cols = line.split(",");
              if (cols.length < 4) continue;
              const officialName = cols[0]?.trim();
              const keywords = cols[1]?.trim();
              const pageIdStr = cols[3]?.trim();
              const pageId = parseInt(pageIdStr);
              if (!officialName || isNaN(pageId) || pageId <= 0) continue;

              const allNames = [officialName, ...(keywords ? keywords.split(/[、,，]/) : [])].map(n => stripClean(n.trim()));
              const cleanInput = stripClean(productName);
              const matched = allNames.some(n => n.length >= 2 && (n.includes(cleanInput) || cleanInput.includes(n)));
              if (matched) {
                console.log(`[AI Tool Call] 知識庫匹配成功: 「${productName}」→「${officialName}」page_id=${pageId}`);
                matchedPages = [{ pageId: pageId.toString(), productName: officialName }];
                break;
              }
            }
            if (matchedPages.length > 0) break;
          }
        }

        if (matchedPages.length === 0) {
          console.log("[AI Tool Call] 禁止：無法從商品名稱比對到銷售頁，拒絕全域搜尋。商品:", productName);
          return JSON.stringify({
            success: false,
            error: `無法從「${productName}」比對到任何銷售頁商品，無法確定 page_id，禁止進行全域搜尋。請向客戶確認正確的商品名稱後再試。`,
            require_product: true,
          });
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
          console.log(`[AI Tool Call] 品牌 ${context?.brandId || "預設"} 查無結果，嘗試跨品牌查詢...`);
          const allBrands = storage.getBrands();
          for (const brand of allBrands) {
            if (brand.id === context?.brandId) continue;
            if (!brand.superlanding_merchant_no || !brand.superlanding_access_key) continue;
            const altConfig: SuperLandingConfig = {
              merchantNo: brand.superlanding_merchant_no,
              accessKey: brand.superlanding_access_key,
            };
            try {
              for (const mp of matchedPages) {
                const altResult = await lookupOrdersByPageAndPhone(altConfig, mp.pageId, phone);
                if (altResult.orders.length > 0) {
                  console.log(`[API 回應] 在品牌「${brand.name}」找到 ${altResult.orders.length} 筆訂單`);
                  allResults = altResult.orders;
                  break;
                }
              }
              if (allResults.length > 0) break;
            } catch (altErr) {
              console.log(`[API 回應] 品牌「${brand.name}」查詢失敗:`, altErr);
            }
          }
        }

        if (allResults.length === 0) {
          return JSON.stringify({ success: true, found: false, message: `所有品牌帳戶皆查無此手機號碼的訂單（已搜尋 ${matchedPages.length} 個相關銷售頁）。(絕對規則) 你現在必須立刻誠實表明你是 AI 客服小助手，告知客戶目前查不到這筆資料，並詢問是否需要轉接專人客服。` });
        }

        const { getStatusLabel: getSL } = await import("./superlanding");
        const orderSummaries = allResults.map(o => ({
          order_id: o.global_order_id,
          status: getSL(o.status),
          amount: o.final_total_order_amount,
          product_list: o.product_list,
          buyer_name: o.buyer_name,
          tracking_number: o.tracking_number,
          created_at: o.created_at,
          shipped_at: o.shipped_at,
        }));

        console.log("[AI Tool Call] 查到", allResults.length, "筆訂單（全部列出）");
        const multiOrderNote = allResults.length > 1
          ? `此手機號碼在此商品下有 ${allResults.length} 筆訂單，請全部列出摘要（單號、日期、金額、狀態），並詢問客戶要查看哪一筆的詳情。`
          : undefined;
        return JSON.stringify({ success: true, found: true, total: allResults.length, orders: orderSummaries, note: multiOrderNote });
      }

      if (toolName === "lookup_order_by_date_and_contact") {
        const contact = (args.contact || "").trim();
        const beginDate = (args.begin_date || "").trim();
        const endDate = (args.end_date || "").trim();
        const pageId = (args.page_id || "").trim();
        console.log("[AI Tool Call] lookup_order_by_date_and_contact，聯絡:", contact, "日期:", beginDate, "~", endDate, "page_id:", pageId || "(無)");

        if (!contact || !beginDate || !endDate) {
          return JSON.stringify({ success: false, error: "請提供聯絡資訊和日期範圍" });
        }

        const diffDays = Math.round((new Date(endDate).getTime() - new Date(beginDate).getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays > 31) {
          return JSON.stringify({ success: false, error: "日期範圍不可超過 31 天，請縮小查詢範圍" });
        }

        const fetchParams: Record<string, string> = {
          begin_date: beginDate,
          end_date: endDate,
        };
        if (pageId) {
          fetchParams.page_id = pageId;
        } else {
          console.warn("[AI Tool Call] lookup_order_by_date_and_contact 未提供 page_id，將在日期範圍內全域搜尋（受31天限制保護）");
        }

        let page = 1;
        const perPage = 200;
        const maxPages = 25;
        let allOrders: OrderInfo[] = [];
        let truncated = false;

        while (true) {
          const orders = await fetchOrders(config, {
            ...fetchParams,
            per_page: String(perPage),
            page: String(page),
          });
          allOrders = allOrders.concat(orders);
          if (orders.length < perPage) break;
          page++;
          if (page > maxPages) {
            truncated = true;
            break;
          }
        }

        const normalizedQuery = contact.replace(/[-\s]/g, "").toLowerCase();
        const matched = allOrders.filter((o) => {
          const phone = o.buyer_phone.replace(/[-\s]/g, "").toLowerCase();
          const email = o.buyer_email.toLowerCase();
          const name = o.buyer_name.toLowerCase();
          return (
            (phone && (phone.includes(normalizedQuery) || normalizedQuery.includes(phone))) ||
            (email && email === normalizedQuery) ||
            (name && name.includes(normalizedQuery))
          );
        });

        if (matched.length === 0) {
          return JSON.stringify({ success: true, found: false, message: "在指定日期範圍內查無相符紀錄" });
        }

        const { getStatusLabel: getSL2 } = await import("./superlanding");
        const orderSummaries = matched.map(o => ({
          order_id: o.global_order_id,
          status: getSL2(o.status),
          amount: o.final_total_order_amount,
          product_list: o.product_list,
          buyer_name: o.buyer_name,
          tracking_number: o.tracking_number,
          created_at: o.created_at,
          shipped_at: o.shipped_at,
        }));

        console.log("[AI Tool Call] 查到", matched.length, "筆訂單（全部列出）");
        const multiOrderNote = matched.length > 1
          ? `此聯絡資訊在指定日期範圍內有 ${matched.length} 筆訂單，請全部列出摘要（單號、日期、金額、狀態），並詢問客戶要查看哪一筆的詳情。`
          : undefined;
        return JSON.stringify({ success: true, found: true, total: matched.length, orders: orderSummaries, truncated, note: multiOrderNote });
      }

      return JSON.stringify({ success: false, error: `未知的工具: ${toolName}` });
    } catch (err: any) {
      console.error("[AI Tool Call] 執行失敗:", toolName, err.message);
      return JSON.stringify({ success: false, error: `查詢失敗：${err.message}` });
    }
  }

  app.post("/api/sandbox/chat", authMiddleware, async (req, res) => {
    const { message, history, brand_id } = req.body;
    if (!message) return res.status(400).json({ message: "message is required" });
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") {
      return res.status(400).json({ success: false, error: "no_api_key", message: "請先至系統設定填寫有效的 OpenAI API Key" });
    }
    const systemPrompt = await getEnrichedSystemPrompt(brand_id ? parseInt(brand_id) : undefined);
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

      const hasImageAssets = storage.getImageAssets(brand_id ? parseInt(brand_id) : undefined).length > 0;
      const allTools = [...orderLookupTools, ...humanHandoffTools, ...(hasImageAssets ? imageTools : [])];

      let completion = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: chatMessages,
        tools: allTools,
        max_completion_tokens: 1000,
        temperature: 0.7,
      });

      let responseMessage = completion.choices[0]?.message;
      let loopCount = 0;
      const maxToolLoops = 3;
      let sandboxImageResult: { image_url?: string; text_message?: string } | null = null;
      let sandboxTransferTriggered = false;
      let sandboxTransferReason = "";
      const sandboxToolLog: string[] = [];

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
          sandboxToolLog.push(`Tool: ${fnName}(${JSON.stringify(fnArgs)})`);
          const toolResult = await executeToolCall(fnName, fnArgs, { brandId: brand_id ? parseInt(brand_id) : undefined });
          console.log(`[Sandbox] Tool 回傳結果長度: ${toolResult.length} 字元`);

          if (fnName === "transfer_to_human") {
            sandboxTransferTriggered = true;
            sandboxTransferReason = (fnArgs.reason || "AI 判斷需要人工處理").trim();
            sandboxToolLog.push(`>>> AI 放棄查詢，觸發轉接真人。原因：${sandboxTransferReason}`);
          }

          if (fnName === "send_image_to_customer") {
            try {
              const parsed = JSON.parse(toolResult);
              if (parsed.image_url) sandboxImageResult = parsed;
            } catch {}
          }

          chatMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }

        completion = await openai.chat.completions.create({
          model: "gpt-5.2",
          messages: chatMessages,
          tools: allTools,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
        responseMessage = completion.choices[0]?.message;
      }

      let reply = responseMessage?.content || "抱歉，AI 無法生成回覆。";
      const result: Record<string, any> = { success: true, reply, transferred: sandboxTransferTriggered };
      if (sandboxTransferTriggered) {
        result.transfer_reason = sandboxTransferReason;
        result.tool_log = sandboxToolLog;
      }
      if (sandboxImageResult) {
        result.image_url = sandboxImageResult.image_url;
      }
      return res.json(result);
    } catch (err: any) {
      const errorMessage = err?.message || "未知錯誤";
      if (errorMessage.includes("401") || errorMessage.includes("Incorrect API key") || errorMessage.includes("invalid_api_key")) {
        return res.status(400).json({ success: false, error: "invalid_api_key", message: "OpenAI API Key 無效，請至系統設定更新您的金鑰" });
      }
      console.error("[Sandbox] AI 回覆失敗:", errorMessage);
      return res.status(500).json({ success: false, error: "api_error", message: `AI 回覆失敗：${errorMessage}` });
    }
  });

  app.post("/api/sandbox/upload", authMiddleware, sandboxUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "未上傳檔案" });
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") {
      return res.status(400).json({ success: false, message: "請先至系統設定填寫有效的 OpenAI API Key" });
    }

    const decodedFilename = fixMulterFilename(req.file.originalname);
    console.log("[沙盒上傳] 上傳的原始檔名:", decodedFilename);
    const ext = path.extname(decodedFilename).toLowerCase();
    const isVideo = [".mp4", ".mov", ".avi", ".webm"].includes(ext);
    const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext);
    const fileUrl = `/uploads/${req.file.filename}`;
    const historyRaw = req.body.history;
    let history: { role: string; content: string }[] = [];
    try { history = JSON.parse(historyRaw || "[]"); } catch {}

    if (isVideo) {
      return res.json({
        success: true,
        reply: `已收到您上傳的影片（${decodedFilename}）。\n\n在實際 LINE 對話中，系統會自動將影片訊息標記為「需要真人客服」，並通知專人檢視。\n\n📋 模擬結果：\n- 檔案類型：影片\n- 動作：自動轉接真人客服\n- 回覆：「已收到您的影片，將為您轉交專人檢視。」`,
        fileUrl,
        fileType: "video",
      });
    }

    if (isImage) {
      try {
        const filePath = path.join(uploadDir, req.file.filename);
        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString("base64");
        const mimeType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
        const dataUri = `data:${mimeType};base64,${base64}`;

        const systemPrompt = await getEnrichedSystemPrompt();
        const openai = new OpenAI({ apiKey });
        const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: "system", content: systemPrompt },
        ];
        if (history.length > 0) {
          for (const h of history.slice(-20)) {
            const role = h.role === "assistant" ? "assistant" as const : "user" as const;
            if (h.content && typeof h.content === "string") {
              chatMessages.push({ role, content: h.content });
            }
          }
        }
        chatMessages.push({
          role: "user",
          content: [
            { type: "text", text: "請以客服身分查看這張客戶上傳的圖片，判斷是否有商品瑕疵或任何問題，並給予適當的回覆。" },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        });

        const completion = await openai.chat.completions.create({
          model: "gpt-5.2",
          messages: chatMessages,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
        const reply = completion.choices[0]?.message?.content || "已收到您的圖片，將為您進一步處理。";
        return res.json({ success: true, reply, fileUrl, fileType: "image" });
      } catch (err: any) {
        console.error("[Sandbox Upload] AI Vision error:", err.message);
        return res.json({ success: true, reply: "已收到您的圖片，AI 分析暫時無法使用，將為您轉交專人檢視。", fileUrl, fileType: "image" });
      }
    }

    return res.status(400).json({ message: "不支援的檔案格式" });
  });

  app.get("/api/knowledge-files", authMiddleware, (_req, res) => {
    return res.json(storage.getKnowledgeFiles());
  });

  app.post("/api/knowledge-files", authMiddleware, managerOrAbove, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "未上傳檔案，或檔案格式不支援。支援格式：.txt, .csv, .pdf, .docx, .xlsx, .md。圖片檔案請上傳至圖片素材庫。" });
    const decodedFilename = fixMulterFilename(req.file.originalname);
    console.log("[知識庫] 上傳的原始檔名:", decodedFilename);
    const ext = path.extname(decodedFilename).toLowerCase();
    if (isImageFile(decodedFilename)) {
      const filePath = path.join(uploadDir, req.file.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ message: "圖片檔案不可上傳至知識庫。如需上傳圖片素材，請至「圖片素材庫」。" });
    }
    const brandId = req.body.brand_id ? parseInt(req.body.brand_id) : undefined;
    let content: string | undefined;
    try {
      const filePath = path.join(uploadDir, req.file.filename);
      content = await parseFileContent(filePath, decodedFilename);
      if (content) content = stripBOM(content);
      if (content && content.length > 500000) {
        content = content.substring(0, 500000) + "\n\n[內容已截斷，原始檔案過大]";
      }
    } catch (err) {
      console.error(`[知識庫] 檔案解析失敗 ${decodedFilename}:`, err);
      content = `[檔案解析失敗: ${decodedFilename}]`;
    }
    const file = storage.createKnowledgeFile(req.file.filename, decodedFilename, req.file.size, brandId, content || undefined);
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

  app.get("/api/image-assets", authMiddleware, (req, res) => {
    const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
    return res.json(storage.getImageAssets(brandId));
  });

  app.post("/api/image-assets", authMiddleware, managerOrAbove, imageAssetUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "未上傳檔案或格式不支援。僅支援 .jpg, .jpeg, .png, .gif, .webp" });
    const decodedFilename = fixMulterFilename(req.file.originalname);
    console.log("[圖片素材] 上傳的原始檔名:", decodedFilename);
    const brandId = req.body.brand_id ? parseInt(req.body.brand_id) : undefined;
    const displayName = req.body.display_name ? fixMulterFilename(req.body.display_name) : decodedFilename;
    const description = req.body.description || "";
    const keywords = req.body.keywords || "";
    const asset = storage.createImageAsset(req.file.filename, decodedFilename, displayName, description, keywords, req.file.size, req.file.mimetype, brandId);
    return res.json(asset);
  });

  app.put("/api/image-assets/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseInt(req.params.id);
    const { display_name, description, keywords } = req.body;
    const data: Record<string, string> = {};
    if (display_name !== undefined) data.display_name = display_name;
    if (description !== undefined) data.description = description;
    if (keywords !== undefined) data.keywords = keywords;
    if (!storage.updateImageAsset(id, data)) return res.status(404).json({ message: "素材不存在" });
    return res.json({ success: true });
  });

  app.delete("/api/image-assets/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseInt(req.params.id);
    const asset = storage.getImageAsset(id);
    if (asset) {
      const filePath = path.join(imageAssetsDir, asset.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    if (!storage.deleteImageAsset(id)) return res.status(404).json({ message: "素材不存在" });
    return res.json({ success: true });
  });

  app.get("/api/image-assets/file/:filename", (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(imageAssetsDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: "檔案不存在" });
    res.sendFile(filePath);
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

  app.get("/api/analytics", authMiddleware, managerOrAbove, (req: any, res) => {
    const range = (req.query.range as string) || "today";
    const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;

    const now = new Date();
    let startDate: string;
    let endDate: string = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().substring(0, 19).replace("T", " ");

    if (range === "custom" && req.query.start && req.query.end) {
      startDate = (req.query.start as string) + " 00:00:00";
      endDate = (req.query.end as string) + " 23:59:59";
    } else if (range === "30d") {
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().substring(0, 19).replace("T", " ");
    } else if (range === "7d") {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 19).replace("T", " ");
    } else {
      startDate = now.toISOString().substring(0, 10) + " 00:00:00";
    }

    const stats = storage.getAnalytics(startDate, endDate, brandId);
    const topKeywords = storage.getTopKeywordsFromMessages(startDate, endDate, brandId);

    const totalInbound = stats.userMessages;
    const completedCount = stats.resolvedContacts;
    const totalContacts = stats.totalContacts || 1;
    const completionRate = totalContacts > 0 ? Math.round((completedCount / totalContacts) * 1000) / 10 : 0;
    const aiInterceptRate = totalContacts > 0 ? Math.round((stats.aiOnlyContacts / totalContacts) * 1000) / 10 : 0;

    const agentPerformance = [
      { name: "AI 助理", cases: stats.aiMessages },
      { name: "真人客服", cases: stats.adminMessages },
    ];

    const intentCategories: Record<string, string[]> = {
      "退換貨諮詢": ["退換貨", "退貨", "換貨", "退款", "瑕疵", "損壞", "保固"],
      "訂單查詢": ["訂單", "查詢", "物流", "出貨", "寄送"],
      "訂單修改": ["修改", "取消", "地址", "付款"],
      "商品諮詢": ["商品", "尺寸", "顏色", "品質", "庫存", "缺貨", "價格", "折扣", "優惠"],
      "轉接客服": ["真人", "轉接", "客服", "客訴", "投訴", "不滿"],
    };

    const intentMap: Record<string, number> = {};
    let totalKeywordHits = 0;
    for (const [category, kws] of Object.entries(intentCategories)) {
      let catCount = 0;
      for (const kw of kws) {
        const found = topKeywords.find(k => k.keyword === kw);
        if (found) catCount += found.count;
      }
      if (catCount > 0) {
        intentMap[category] = catCount;
        totalKeywordHits += catCount;
      }
    }

    const intentDistribution = Object.entries(intentMap)
      .map(([name, count]) => ({
        name,
        value: totalKeywordHits > 0 ? Math.round((count / totalKeywordHits) * 100) : 0,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    if (intentDistribution.length === 0) {
      intentDistribution.push({ name: "尚無數據", value: 100 });
    }

    const painPoints: string[] = [];
    const suggestions: string[] = [];

    if (stats.needsHumanContacts > 0) {
      const humanRate = Math.round((stats.needsHumanContacts / totalContacts) * 100);
      painPoints.push(`${humanRate}% 的客戶需要轉接真人客服，共 ${stats.needsHumanContacts} 位客戶在此期間需要人工介入。`);
    }

    const returnKws = topKeywords.filter(k => ["退換貨", "退貨", "換貨", "退款"].includes(k.keyword));
    const returnCount = returnKws.reduce((sum, k) => sum + k.count, 0);
    if (returnCount > 0) {
      painPoints.push(`退換貨相關訊息共 ${returnCount} 則，是客戶最常提及的問題類型之一。`);
      suggestions.push("建議優化退換貨流程的自動化引導，減少真人客服介入率。");
    }

    const complaintKws = topKeywords.filter(k => ["客訴", "投訴", "不滿"].includes(k.keyword));
    const complaintCount = complaintKws.reduce((sum, k) => sum + k.count, 0);
    if (complaintCount > 0) {
      painPoints.push(`偵測到 ${complaintCount} 則客訴/不滿相關訊息，建議關注客戶情緒並及時介入。`);
    }

    if (stats.avgAiRating !== null) {
      if (stats.avgAiRating < 3.5) {
        painPoints.push(`AI 客服平均評分僅 ${stats.avgAiRating.toFixed(1)} 分（${stats.ratedAiCount} 人評價），需要改善 AI 回覆品質。`);
      } else {
        suggestions.push(`AI 客服平均評分 ${stats.avgAiRating.toFixed(1)} 分（${stats.ratedAiCount} 人評價），表現良好。`);
      }
    }
    if (stats.avgCsRating !== null) {
      suggestions.push(`真人客服平均評分 ${stats.avgCsRating.toFixed(1)} 分（${stats.ratedCsCount} 人評價）。`);
    }

    if (aiInterceptRate < 50 && totalContacts > 3) {
      suggestions.push("AI 攔截率偏低，建議豐富知識庫內容以提高 AI 自動處理率。");
    } else if (aiInterceptRate >= 80) {
      suggestions.push("AI 攔截率表現優異，大部分客戶問題都能由 AI 自動處理。");
    }

    if (painPoints.length === 0) painPoints.push("目前尚無明顯痛點，持續監控中。");
    if (suggestions.length === 0) suggestions.push("持續優化知識庫內容，提升客戶服務品質。");

    return res.json({
      kpi: {
        todayInbound: totalInbound,
        completedCount,
        completionRate,
        aiInterceptRate,
        avgFrtAi: stats.aiMessages > 0 ? "即時" : "N/A",
        avgFrtHuman: stats.adminMessages > 0 ? "依專員回覆" : "N/A",
      },
      agentPerformance,
      intentDistribution,
      aiInsights: { painPoints, suggestions },
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
