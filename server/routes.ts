import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import * as metaCommentsStorage from "./meta-comments-storage";
import { resolveCommentMetadata } from "./meta-comment-resolver";
import { replyToComment, hideComment } from "./meta-facebook-comment-api";
import { checkHighRiskByRule, checkLineRedirectByRule, checkSafeConfirmByRule, COMFORT_MESSAGE } from "./meta-comment-guardrail";
import {
  classifyMessageForSafeAfterSale,
  FALLBACK_AFTER_SALE_LINE_LABEL,
  SAFE_IMAGE_ONLY_REPLY,
  isShortOrAmbiguousImageCaption,
  getImageDmReplyForShortCaption,
  getImageDmTemplateNameForShortCaption,
  shouldEscalateImageSupplement,
  IMAGE_SUPPLEMENT_ESCALATE_MESSAGE,
} from "./safe-after-sale-classifier";
import { runAutoExecution, computeMainStatus } from "./meta-comment-auto-execute";
import * as riskRules from "./meta-comment-risk-rules";
import db from "./db";
import { fetchOrders, lookupOrderById, lookupOrdersByDateAndFilter, fetchPages, lookupOrdersByPageAndPhone, ensurePagesCacheLoaded, refreshPagesCache, getCachedPages, getCachedPagesAge, buildProductCatalogPrompt } from "./superlanding";
import type { SuperLandingConfig } from "./superlanding";
import type { OrderInfo, Contact, ContactStatus, IssueType, MetaCommentTemplate, MetaComment } from "@shared/schema";
import { unifiedLookupById, unifiedLookupByProductAndPhone, unifiedLookupByDateAndContact, getUnifiedStatusLabel } from "./order-service";
import * as assignment from "./assignment";
import {
  detectIntentLevel,
  classifyOrderNumber,
  computeCasePriority,
  suggestTagsFromContent,
} from "./intent-and-order";
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
  } catch (_e) {}
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
import { getUploadsDir, getDataDir } from "./data-dir";

const uploadDir = getUploadsDir();
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const imageAssetsDir = path.join(getUploadsDir(), "image-assets");
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

const avatarsDir = path.join(getUploadsDir(), "avatars");
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarsDir),
    filename: (req, file, cb) => {
      const userId = (req as any).params?.id || "0";
      const ext = (path.extname(file.originalname) || ".jpg").toLowerCase();
      if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) return cb(null, `avatar-${userId}-${Date.now()}.jpg`);
      cb(null, `avatar-${userId}-${Date.now()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_IMAGE_EXTENSIONS.includes(ext));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

const HIGH_RISK_KEYWORDS = [
  "投訴", "客訴", "消保", "消費者保護", "消基會", "法律", "律師", "告你", "告你們",
  "提告", "訴訟", "報警", "警察", "公平會", "媒體", "爆料", "上新聞", "找記者",
  "詐騙", "騙子", "垃圾", "廢物", "爛", "靠北", "幹", "他媽", "媽的", "狗屎",
  "去死", "白痴", "智障", "噁心", "極度不滿", "非常生氣", "太扯", "離譜",
];

const RETURN_REFUND_KEYWORDS = ["退貨", "退款", "換貨", "退錢", "退費", "取消訂單", "不要了"];

const ISSUE_TYPE_KEYWORDS: Record<IssueType, string[]> = {
  order_inquiry: ["訂單", "查詢", "出貨", "物流", "寄送", "追蹤", "到貨", "配送"],
  product_consult: ["商品", "產品", "尺寸", "顏色", "材質", "規格", "有貨", "庫存", "價格", "多少錢"],
  return_refund: ["退貨", "退款", "換貨", "退錢", "退費", "瑕疵", "損壞", "破損"],
  complaint: ["投訴", "客訴", "不滿", "太爛", "太差", "生氣", "憤怒"],
  order_modify: ["修改", "改地址", "改電話", "改數量", "取消"],
  general: ["營業時間", "門市", "活動", "優惠", "會員"],
  other: [],
};

function detectHighRisk(text: string): { isHighRisk: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const kw of HIGH_RISK_KEYWORDS) {
    if (text.includes(kw)) {
      reasons.push(`高風險關鍵字: ${kw}`);
    }
  }
  return { isHighRisk: reasons.length > 0, reasons };
}

function detectIssueType(messages: string[]): IssueType | null {
  const combined = messages.join(" ");
  let bestType: IssueType | null = null;
  let bestScore = 0;
  for (const [type, keywords] of Object.entries(ISSUE_TYPE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (combined.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestType = type as IssueType;
    }
  }
  return bestType;
}

function detectReturnRefund(text: string): boolean {
  return RETURN_REFUND_KEYWORDS.some(kw => text.includes(kw));
}

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

--- 客服應對 SOP（流程指引，不影響你的人格與語氣）---
以下是你在不同情境下應採取的處理流程。請用你自己的語氣和風格來執行這些流程，不要使用制式範本。
如果上方有「品牌專屬指令」定義了你的人設與語氣，你必須嚴格按照該人設回覆——SOP 只規範「做什麼」，人設規範「怎麼說」。

【查詢/商品知識】：若詢問訂單進度、產地、使用方式、折扣碼，請直接從 API 或知識庫中給予精準答案，不需轉人工。

【修改/取消訂單】：請詢問客戶要修改的細節（例如地址、數量、品項），安撫客戶後告知已記錄並將轉交專員處理，接著呼叫 transfer_to_human（reason 填寫「修改/取消訂單 - [具體修改項目]」）。

【退換貨/補寄/保固】：溫柔道歉，探詢退換貨原因，請客戶提供「照片/錄影」作為證據，或填寫售後表單：${returnFormUrl}。若客戶堅持退換貨，呼叫 transfer_to_human（reason 填寫「退換貨申請 - [原因摘要]」）。

【代客下單/付款失敗/重新出貨】：告知客戶涉及金流隱私需轉交專員，呼叫 transfer_to_human（reason 填寫「金流/下單相關 - [具體問題]」）。

--- 轉接真人客服觸發條件 ---
當遇到以下情況時，先用你自己的語氣回覆並說明轉接意圖，然後呼叫 transfer_to_human 工具：
1. 偵測到高風險關鍵字（威脅、法律、極端不滿等）
2. 客戶明確要求轉接真人（回覆「需要轉接」「轉人工」「找真人」等）
3. 退換貨：客戶反覆堅持退換貨（第三次以上仍堅持），安撫挽留無效後，提供退換貨表單（${returnFormUrl}）並轉人工
4. 多次查詢仍查不到訂單（2次以上工具查詢失敗）
5. 修改/取消訂單：安撫後轉人工
6. 代客下單/付款失敗/重新出貨：涉及金流，立即轉人工
7. 客戶反覆表達不滿或情緒激動

注意：訂單來源（一頁商店、SHOPLINE 等）不是轉接人工的判斷依據。無論訂單來自哪個平台，只要查到就正常回覆。查不到時，告知客戶並提供進一步協助，不要自動轉人工。

--- AI 身分透明規則 ---
- 你是 AI 助手，在適當時機（如首次互動、需要轉接時）自然地讓客戶知道你是 AI，但不需要每句話都強調
- 用你品牌人設的語氣來表達，不要用制式模板。例如不要說「我是 AI 客服小助手」這種生硬的話，而是用符合你人設的方式自然帶到
- 嚴禁假裝是真人
- 當客戶要求轉真人時，自然地回覆並呼叫 transfer_to_human

當訂單查詢工具回傳 found=false 或空陣列時，用你自己的語氣告知客戶查不到資料，並主動詢問是否有其他資訊可以協助查詢（例如其他訂單編號、手機號碼等）。不要使用制式模板回覆，也不要自動轉人工。`;

  const schedule = storage.getGlobalSchedule();
  const unavailableReason = assignment.getUnavailableReason();
  const humanHoursBlock = `

--- 人工客服服務時段（僅影響真人回覆，你 AI 24 小時在線）---
人工客服可接案時段：上班 ${schedule.work_start_time}–${schedule.work_end_time}，午休 ${schedule.lunch_start_time}–${schedule.lunch_end_time}，下班 ${schedule.work_end_time} 後無人接案。
當你要呼叫 transfer_to_human 時：若目前是午休或已下班，請在回覆中主動告知客人「目前是午休／已超過服務時間，轉人工可能暫時沒人即時回覆，需求會先記錄，專人會在午休後／上班後盡快處理，請稍候。」不要假裝有人正在看。`;
  const nowStatusHint = unavailableReason === "lunch"
    ? `【目前狀態】現在為午休時段（${schedule.lunch_start_time}–${schedule.lunch_end_time}），若轉人工請主動提醒客人稍後由專人回覆。`
    : unavailableReason === "after_hours"
      ? `【目前狀態】目前已超過人工服務時間（${schedule.work_end_time} 後），若轉人工請主動提醒客人需求已記錄，上班後會處理。`
      : "";
  const humanHoursBlockWithStatus = humanHoursBlock + (nowStatusHint ? "\n" + nowStatusHint : "");

  return basePrompt + brandBlock + handoffBlock + humanHoursBlockWithStatus + catalogBlock + knowledgeBlock + imageBlock;
}

const contactProcessingLocks = new Map<number, Promise<void>>();

const messageDebounceBuffers = new Map<number, { texts: string[]; timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
const DEBOUNCE_MS = 3000;

function debounceTextMessage(
  contactId: number,
  text: string,
  processCallback: (mergedText: string) => Promise<void>
): void {
  const existing = messageDebounceBuffers.get(contactId);
  if (existing) {
    existing.texts.push(text);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      const merged = existing.texts.join("\n");
      messageDebounceBuffers.delete(contactId);
      processCallback(merged).catch((err) => console.error("[Debounce] callback error:", err));
    }, DEBOUNCE_MS);
  } else {
    const timer = setTimeout(() => {
      const buf = messageDebounceBuffers.get(contactId);
      if (!buf) return;
      const merged = buf.texts.join("\n");
      messageDebounceBuffers.delete(contactId);
      processCallback(merged).catch((err) => console.error("[Debounce] callback error:", err));
    }, DEBOUNCE_MS);
    messageDebounceBuffers.set(contactId, { texts: [text], timer, resolve: () => {} });
  }
}

function maskSensitiveInfo(text: string): string {
  let result = text;
  result = result.replace(/09\d{8}/g, (m) => m.substring(0, 4) + "****" + m.substring(8));
  result = result.replace(/(\+?886)?\d{2,3}[-\s]?\d{3,4}[-\s]?\d{3,4}/g, (m) => {
    if (m.length < 8) return m;
    return m.substring(0, 3) + "****" + m.substring(m.length - 2);
  });
  result = result.replace(/([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, (m, local, domain) => {
    const maskedLocal = local.length > 2 ? local.substring(0, 2) + "***" : "***";
    return `${maskedLocal}@${domain}`;
  });
  return result;
}

/** 依目前人工服務時段設定，回傳轉人工無人可接時的系統提示（午休／下班／全員忙碌） */
function getTransferUnavailableSystemMessage(reason: "lunch" | "after_hours" | "all_paused" | null): string {
  const schedule = storage.getGlobalSchedule();
  if (reason === "lunch") return `目前客服同仁正在午休時段（${schedule.lunch_start_time}–${schedule.lunch_end_time}），我先幫您記錄需求，專人會在午休後盡快為您確認與回覆唷。`;
  if (reason === "after_hours") return "目前已超過客服服務時間，您的需求我已先幫您記錄，專人將於上班時段儘快為您處理，請您稍等唷。";
  return "目前人工客服暫時忙碌中，已幫您排入待處理清單，上班後會依序回覆。";
}

async function withContactLock<T>(contactId: number, fn: () => Promise<T>): Promise<T> {
  const existing = contactProcessingLocks.get(contactId);
  let resolve: () => void;
  const lockPromise = new Promise<void>(r => { resolve = r; });
  contactProcessingLocks.set(contactId, lockPromise);
  if (existing) {
    const timeout = new Promise<void>(r => setTimeout(r, 60000));
    await Promise.race([existing, timeout]);
  }
  try {
    return await fn();
  } finally {
    resolve!();
    if (contactProcessingLocks.get(contactId) === lockPromise) {
      contactProcessingLocks.delete(contactId);
    }
  }
}

const sseClients: Set<import("express").Response> = new Set();

function broadcastSSE(eventType: string, data: any) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_e) { sseClients.delete(client); }
  }
}

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "omnichannel_fb_verify_2024";

/** 解析路由 :id 參數為正整數，無效時回傳 null（用於統一回傳 400 避免靜默失敗） */
function parseIdParam(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 1 || !Number.isInteger(n)) return null;
  return n;
}

function getOpenAIModel(): string {
  return process.env.OPENAI_MODEL || storage.getSetting("openai_model") || "gpt-5.2";
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // 延後開機同步，避免一啟動就 133 次請求拖慢登入/首頁（造成「幾乎打不開」）
  const config = getSuperLandingConfig();
  setTimeout(() => {
    refreshPagesCache(getSuperLandingConfig()).catch(() => {});
  }, 30 * 1000);
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
    console.log("[SSE] Client connected, total clients:", sseClients.size + 1);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write("event: connected\ndata: {}\n\n");
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try { res.write(":ping\n\n"); } catch (_e) { clearInterval(keepAlive); sseClients.delete(res); }
    }, 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
      console.log("[SSE] Client disconnected, remaining:", sseClients.size);
    });
  });

  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "請輸入帳號與密碼" });
    }
    const user = storage.authenticateUser(username, password);
    if (user) {
      const s = (req as any).session;
      s.authenticated = true;
      s.userId = user.id;
      s.userRole = user.role;
      s.username = user.username;
      s.displayName = user.display_name;
      if (user.role === "cs_agent") {
        storage.updateUserOnline(user.id, 1, 1);
      }
      return res.json({
        success: true,
        message: "登入成功",
        user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
      });
    }
    return res.status(401).json({ success: false, message: "帳號或密碼錯誤" });
  });

  app.get("/api/version", (_req, res) => {
    try {
      const versionPath = path.join(__dirname, "public", "version.json");
      if (fs.existsSync(versionPath)) {
        const raw = fs.readFileSync(versionPath, "utf-8");
        const data = JSON.parse(raw) as { buildTime?: string; commit?: string };
        return res.json({ buildTime: data.buildTime, commit: data.commit });
      }
    } catch (_e) {}
    return res.json({ buildTime: null, commit: null });
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
    const userId = s?.userId;
    const role = s?.userRole ?? s?.role;
    if (userId != null && role === "cs_agent") {
      storage.updateUserOnline(userId, 0);
    }
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

  app.post("/api/admin/refresh-profiles", authMiddleware, superAdminOnly, async (_req, res) => {
    try {
      const contacts = storage.getContacts();
      const lineContacts = contacts.filter(c => c.platform === "line" && c.platform_user_id && c.platform_user_id !== "unknown");
      let updated = 0;
      let failed = 0;
      for (const contact of lineContacts) {
        const token = getLineTokenForContact(contact);
        if (!token) { failed++; continue; }
        try {
          const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${contact.platform_user_id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (profileRes.ok) {
            const profile = await profileRes.json() as { displayName?: string; pictureUrl?: string };
            if (profile.displayName) {
              storage.updateContactProfile(contact.id, profile.displayName, profile.pictureUrl || null);
              updated++;
            }
          } else {
            failed++;
          }
          await new Promise(r => setTimeout(r, 100));
        } catch (_e) {
          failed++;
        }
      }
      return res.json({ success: true, total: lineContacts.length, updated, failed });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

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
          model: getOpenAIModel(),
          messages: [{ role: "user", content: "hi" }],
          max_completion_tokens: 5,
        });
        return res.json({ success: true, message: `OpenAI 連線成功 (模型: ${getOpenAIModel()})` });
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

  // --- Meta 留言互動中心 ---
  app.get("/api/meta-comments", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const page_id = req.query.page_id ? String(req.query.page_id) : undefined;
    const post_id = req.query.post_id ? String(req.query.post_id) : undefined;
    const status = (req.query.status as metaCommentsStorage.MetaCommentStatusFilter) || "all";
    const source = (req.query.source as "all" | "real" | "simulated") || "all";
    const archive_delay_minutes = req.query.archive_delay_minutes != null ? parseInt(String(req.query.archive_delay_minutes)) : 5;
    const list = metaCommentsStorage.getMetaComments({ brand_id, page_id, post_id, status, source, archive_delay_minutes });
    const enriched = list.map((c) => {
      let brandName: string | null = null;
      if (c.brand_id != null) brandName = storage.getBrand(c.brand_id)?.name ?? null;
      if (brandName == null && c.page_id) {
        const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(c.page_id);
        if (pageSettings?.brand_id != null) brandName = storage.getBrand(pageSettings.brand_id)?.name ?? null;
      }
      const mainStatus = c.main_status || computeMainStatus(c);
      return { ...c, brand_name: brandName ?? null, main_status: mainStatus };
    });
    res.setHeader("Content-Type", "application/json");
    return res.json(enriched);
  });
  app.get("/api/meta-comments/summary", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const summary = metaCommentsStorage.getMetaCommentsSummary({ brand_id: brand_id ?? null });
    res.setHeader("Content-Type", "application/json");
    return res.json(summary);
  });
  app.get("/api/meta-comments/health", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const health = metaCommentsStorage.getMetaCommentsHealth({ brand_id: brand_id ?? null });
    res.setHeader("Content-Type", "application/json");
    return res.json(health);
  });
  app.get("/api/meta-comments/spot-check", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const limit = req.query.limit != null ? parseInt(String(req.query.limit)) : 20;
    const rows = metaCommentsStorage.getMetaCommentsRandomCompleted({ brand_id: brand_id ?? null, limit });
    const enriched = rows.map((c) => {
      let brandName: string | null = null;
      if (c.brand_id != null) brandName = storage.getBrand(c.brand_id)?.name ?? null;
      if (brandName == null && c.page_id) {
        const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(c.page_id);
        if (pageSettings?.brand_id != null) brandName = storage.getBrand(pageSettings.brand_id)?.name ?? null;
      }
      const mainStatus = c.main_status || computeMainStatus(c);
      return { ...c, brand_name: brandName ?? null, main_status: mainStatus };
    });
    res.setHeader("Content-Type", "application/json");
    return res.json(enriched);
  });
  app.get("/api/meta-comments/gray-spot-check", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const limit = req.query.limit != null ? parseInt(String(req.query.limit)) : 20;
    const rows = metaCommentsStorage.getMetaCommentsGraySpotCheck({ brand_id: brand_id ?? null, limit });
    const enriched = rows.map((c) => {
      let brandName: string | null = null;
      if (c.brand_id != null) brandName = storage.getBrand(c.brand_id)?.name ?? null;
      if (brandName == null && c.page_id) {
        const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(c.page_id);
        if (pageSettings?.brand_id != null) brandName = storage.getBrand(pageSettings.brand_id)?.name ?? null;
      }
      const mainStatus = c.main_status || computeMainStatus(c);
      return { ...c, brand_name: brandName ?? null, main_status: mainStatus };
    });
    res.setHeader("Content-Type", "application/json");
    return res.json(enriched);
  });
  app.get("/api/meta-comment-risk-rules", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const bucket = (req.query.bucket as "whitelist" | "direct_hide" | "hide_and_route" | "route_only" | "gray_area") || undefined;
    const page_id = req.query.page_id != null && req.query.page_id !== "" ? String(req.query.page_id) : undefined;
    const enabled = req.query.enabled === "1" ? 1 : req.query.enabled === "0" ? 0 : undefined;
    const q = req.query.q != null && String(req.query.q).trim() !== "" ? String(req.query.q).trim() : undefined;
    const list = riskRules.getRiskRules({ brand_id: brand_id ?? null, bucket: bucket ?? null, page_id: page_id ?? null, enabled: enabled ?? null, q: q ?? null });
    res.setHeader("Content-Type", "application/json");
    return res.json(list);
  });
  app.get("/api/meta-comment-risk-rules/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const row = riskRules.getRiskRule(id);
    if (!row) return res.status(404).json({ message: "規則不存在" });
    return res.json(row);
  });
  app.post("/api/meta-comment-risk-rules", authMiddleware, (req: any, res) => {
    const body = req.body || {};
    const row = riskRules.createRiskRule({
      rule_name: body.rule_name ?? "",
      rule_bucket: body.rule_bucket,
      keyword_pattern: body.keyword_pattern ?? "",
      match_type: body.match_type ?? "contains",
      priority: body.priority ?? 0,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1,
      brand_id: body.brand_id ?? null,
      page_id: body.page_id ?? null,
      action_reply: body.action_reply ? 1 : 0,
      action_hide: body.action_hide ? 1 : 0,
      action_route_line: body.action_route_line ? 1 : 0,
      route_line_type: body.route_line_type ?? null,
      action_mark_to_human: body.action_mark_to_human ? 1 : 0,
      action_use_template_id: body.action_use_template_id ?? null,
      notes: body.notes ?? null,
    });
    res.setHeader("Content-Type", "application/json");
    return res.json(row);
  });
  app.put("/api/meta-comment-risk-rules/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const body = req.body || {};
    riskRules.updateRiskRule(id, {
      rule_name: body.rule_name,
      rule_bucket: body.rule_bucket,
      keyword_pattern: body.keyword_pattern,
      match_type: body.match_type,
      priority: body.priority,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
      brand_id: body.brand_id,
      page_id: body.page_id,
      action_reply: body.action_reply !== undefined ? (body.action_reply ? 1 : 0) : undefined,
      action_hide: body.action_hide !== undefined ? (body.action_hide ? 1 : 0) : undefined,
      action_route_line: body.action_route_line !== undefined ? (body.action_route_line ? 1 : 0) : undefined,
      route_line_type: body.route_line_type,
      action_mark_to_human: body.action_mark_to_human !== undefined ? (body.action_mark_to_human ? 1 : 0) : undefined,
      action_use_template_id: body.action_use_template_id,
      notes: body.notes,
    });
    return res.json({ success: true });
  });
  app.delete("/api/meta-comment-risk-rules/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const ok = riskRules.deleteRiskRule(id);
    if (!ok) return res.status(404).json({ message: "規則不存在" });
    return res.json({ success: true });
  });
  app.post("/api/meta-comments/test-rules", authMiddleware, (req: any, res) => {
    const body = req.body || {};
    const message = (body.message ?? "").trim();
    const brand_id = body.brand_id != null ? parseInt(String(body.brand_id)) : undefined;
    const page_id = body.page_id ?? null;
    const { matches, final: result, reason, decisionSummary } = riskRules.evaluateRiskRulesWithCandidates(message, brand_id ?? null, page_id);
    const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(page_id || "");
    let targetLineName = "";
    if (result && result.action_route_line && result.route_line_type && pageSettings) {
      targetLineName = result.route_line_type === "after_sale" ? (pageSettings.line_after_sale || "售後 LINE") : (pageSettings.line_general || "一般 LINE");
    }
    res.setHeader("Content-Type", "application/json");
    return res.json({
      message,
      matches,
      final: result,
      reason,
      decisionSummary: decisionSummary ?? "",
      matched: !!result,
      matched_rule_id: result?.matched_rule_id ?? null,
      matched_rule_bucket: result?.matched_rule_bucket ?? null,
      matched_keyword: result?.matched_keyword ?? null,
      rule_name: result?.rule_name ?? null,
      action_reply: !!result?.action_reply,
      action_hide: !!result?.action_hide,
      action_route_line: !!result?.action_route_line,
      route_line_type: result?.route_line_type ?? null,
      target_line_display: targetLineName || (result?.route_line_type ?? ""),
      action_mark_to_human: !!result?.action_mark_to_human,
    });
  });
  // 可指派客服名單（用於留言分派下拉；須在 /:id 前註冊）
  app.get("/api/meta-comments/assignable-agents", authMiddleware, (req: any, res) => {
    const members = storage.getTeamMembers().filter((m: any) => m.role === "cs_agent" || m.role === "super_admin" || m.role === "marketing_manager");
    const list = members.map((m: any) => {
      const u = storage.getUserById(m.id);
      return {
        id: m.id,
        display_name: m.display_name || u?.display_name || m.username,
        avatar_url: (u as any)?.avatar_url ?? null,
      };
    });
    res.setHeader("Content-Type", "application/json");
    return res.json(list);
  });
  app.get("/api/meta-comments/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const row = metaCommentsStorage.getMetaComment(id);
    if (!row) return res.status(404).json({ message: "留言不存在" });
    let brandName: string | null = null;
    if (row.brand_id != null) brandName = storage.getBrand(row.brand_id)?.name ?? null;
    if (brandName == null && row.page_id) {
      const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(row.page_id);
      if (pageSettings?.brand_id != null) brandName = storage.getBrand(pageSettings.brand_id)?.name ?? null;
    }
    const mainStatus = row.main_status || computeMainStatus(row);
    return res.json({ ...row, brand_name: brandName ?? null, main_status: mainStatus });
  });
  app.post("/api/meta-comments/:id/mark-gray-reviewed", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const row = metaCommentsStorage.getMetaComment(id);
    if (!row) return res.status(404).json({ message: "留言不存在" });
    const current = row.main_status || computeMainStatus(row);
    if (current !== "gray_area") return res.status(400).json({ message: "僅灰區留言可標記已檢視" });
    metaCommentsStorage.updateMetaComment(id, { main_status: "completed" });
    return res.json({ success: true, main_status: "completed" });
  });
  // 模擬 Webhook：僅供內測，接收類 Meta 留言 payload 寫入一筆模擬留言
  app.post("/api/meta-comments/simulate-webhook", authMiddleware, (req: any, res) => {
    res.setHeader("Content-Type", "application/json");
    const body = req.body || {};
    const value = body.entry?.[0]?.changes?.[0]?.value ?? body;
    const commentId = value.comment_id || value.id || `sim_webhook_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const from = value.from ?? {};
    const commenterName = typeof from.name === "string" ? from.name : (body.commenter_name || "模擬用戶");
    const commenterId = from.id ?? body.commenter_id ?? null;
    const message = value.message ?? body.message ?? "";
    const postId = value.post_id ?? body.post_id ?? "post_sim";
    const pageId = value.page_id ?? body.page_id ?? "page_sim";
    try {
      const resolved = resolveCommentMetadata({
        brand_id: body.brand_id ?? null,
        page_id: pageId,
        post_id: postId,
        post_name: body.post_name ?? "模擬貼文",
        message: message || "(空訊息)",
      });
      const row = metaCommentsStorage.createMetaComment({
        brand_id: body.brand_id ?? null,
        page_id: pageId,
        page_name: body.page_name ?? "模擬粉專",
        post_id: postId,
        post_name: body.post_name ?? "模擬貼文",
        comment_id: commentId,
        commenter_id: commenterId,
        commenter_name: commenterName,
        message: message || "(空訊息)",
        is_simulated: 1,
        ...resolved,
      });
      console.log("[meta-comments] simulate-webhook 建立留言 id=%s", row.id);
      setImmediate(() => runAutoExecution(row.id).catch((e: any) => console.error("[meta-comments] runAutoExecution error:", e?.message)));
      return res.json(row);
    } catch (e: any) {
      console.error("[meta-comments] simulate-webhook 錯誤:", e?.message);
      if (e.message?.includes("UNIQUE")) return res.status(400).json({ message: "該留言 ID 已存在" });
      return res.status(500).json({ message: e?.message || "建立失敗" });
    }
  });

  // 一鍵建立預設測試案例（一般詢問、價格、哪裡買、活動、客訴、退款）
  app.post("/api/meta-comments/seed-test-cases", authMiddleware, (req: any, res) => {
    res.setHeader("Content-Type", "application/json");
    const body = req.body || {};
    const brandId = body.brand_id ?? null;
    const pageId = body.page_id || "page_demo";
    const pageName = body.page_name || "示範粉專";
    const postId = body.post_id || "post_001";
    const postName = body.post_name || "測試貼文";
    const cases = [
      { name: "測試A", message: "請問這款現在還有貨嗎？想買兩瓶", label: "一般商品詢問" },
      { name: "測試B", message: "多少錢？", label: "價格詢問" },
      { name: "測試C", message: "哪裡可以買？", label: "哪裡買" },
      { name: "測試D", message: "+1 想抽", label: "活動互動" },
      { name: "測試E", message: "我上週訂的還沒收到，你們是不是都不回訊息", label: "客訴" },
      { name: "測試F", message: "我要退款", label: "退款" },
    ];
    const created: MetaComment[] = [];
    const ts = Date.now();
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const commentId = `sim_seed_${ts}_${i}_${Math.random().toString(36).slice(2)}`;
      try {
        const isSensitive = ["測試E", "測試F"].includes(c.name) || ["客訴", "退款"].some((l) => c.label.includes(l));
        const resolved = resolveCommentMetadata({
          brand_id: brandId,
          page_id: pageId,
          post_id: postId,
          post_name: postName,
          message: c.message,
          is_sensitive_or_complaint: isSensitive,
        });
        const row = metaCommentsStorage.createMetaComment({
          brand_id: brandId,
          page_id: pageId,
          page_name: pageName,
          post_id: postId,
          post_name: postName,
          comment_id: commentId,
          commenter_name: c.name,
          message: c.message,
          is_simulated: 1,
          ...resolved,
        });
        created.push(row);
      } catch (_) {}
    }
    console.log("[meta-comments] seed-test-cases 建立 %s 筆", created.length);
    setImmediate(() => {
      created.forEach((r) => runAutoExecution(r.id).catch((e: any) => console.error("[meta-comments] runAutoExecution error:", e?.message)));
    });
    return res.json({ created: created.length, ids: created.map((r) => r.id), comments: created });
  });

  // 測試此 mapping：建立一筆模擬留言並回傳，供前端跳轉到該則驗證導購連結
  app.post("/api/meta-comments/test-mapping", authMiddleware, (req: any, res) => {
    res.setHeader("Content-Type", "application/json");
    const mappingId = req.body?.mapping_id != null ? parseInt(String(req.body.mapping_id)) : NaN;
    if (Number.isNaN(mappingId)) return res.status(400).json({ message: "請提供 mapping_id" });
    const mappings = metaCommentsStorage.getMetaPostMappings();
    const mapping = mappings.find((m) => m.id === mappingId);
    if (!mapping) return res.status(404).json({ message: "找不到該對應" });
    const commentId = `sim_mapping_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      const resolved = resolveCommentMetadata({
        brand_id: mapping.brand_id,
        page_id: mapping.page_id || "page_demo",
        post_id: mapping.post_id,
        post_name: mapping.post_name || "測試貼文",
        message: "請問這款哪裡買？",
      });
      const row = metaCommentsStorage.createMetaComment({
        brand_id: mapping.brand_id,
        page_id: mapping.page_id || "page_demo",
        page_name: mapping.page_name || "測試粉專",
        post_id: mapping.post_id,
        post_name: mapping.post_name || "測試貼文",
        comment_id: commentId,
        commenter_name: "測試用戶",
        message: "請問這款哪裡買？",
        is_simulated: 1,
        ...resolved,
      });
      console.log("[meta-comments] test-mapping 建立留言 id=%s for mapping id=%s", row.id, mappingId);
      return res.json(row);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "建立失敗" });
    }
  });

  app.post("/api/meta-comments", authMiddleware, (req: any, res) => {
    const body = req.body || {};
    const isSimulated = body.is_simulated ? 1 : 0;
    const commentId = body.comment_id || (isSimulated ? `sim_${Date.now()}_${Math.random().toString(36).slice(2)}` : `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    try {
      const resolved = resolveCommentMetadata({
        brand_id: body.brand_id ?? null,
        page_id: body.page_id || "page_sim",
        post_id: body.post_id || "post_sim",
        post_name: body.post_name,
        message: body.message || "",
        is_sensitive_or_complaint: body.priority === "urgent" || ["complaint", "refund_after_sale"].includes(body.ai_intent || ""),
      });
      const row = metaCommentsStorage.createMetaComment({
        brand_id: body.brand_id,
        page_id: body.page_id || "page_sim",
        page_name: body.page_name,
        post_id: body.post_id || "post_sim",
        post_name: body.post_name,
        comment_id: commentId,
        commenter_id: body.commenter_id,
        commenter_name: body.commenter_name || "未知",
        message: body.message || "",
        ai_intent: body.ai_intent,
        issue_type: body.issue_type,
        priority: body.priority || "normal",
        ai_suggest_hide: body.ai_suggest_hide ? 1 : 0,
        ai_suggest_human: body.ai_suggest_human ? 1 : 0,
        reply_first: body.reply_first,
        reply_second: body.reply_second,
        is_simulated: isSimulated,
        ...resolved,
      });
      return res.json(row);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return res.status(400).json({ message: "該留言 ID 已存在" });
      return res.status(500).json({ message: e?.message || "建立失敗" });
    }
  });
  app.put("/api/meta-comments/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const row = metaCommentsStorage.getMetaComment(id);
    if (!row) return res.status(404).json({ message: "留言不存在" });
    const body = req.body || {};
    metaCommentsStorage.updateMetaComment(id, {
      replied_at: body.replied_at !== undefined ? body.replied_at : undefined,
      is_hidden: body.is_hidden !== undefined ? (body.is_hidden ? 1 : 0) : undefined,
      is_dm_sent: body.is_dm_sent !== undefined ? (body.is_dm_sent ? 1 : 0) : undefined,
      is_human_handled: body.is_human_handled !== undefined ? (body.is_human_handled ? 1 : 0) : undefined,
      contact_id: body.contact_id !== undefined ? body.contact_id : undefined,
      reply_first: body.reply_first !== undefined ? body.reply_first : undefined,
      reply_second: body.reply_second !== undefined ? body.reply_second : undefined,
      issue_type: body.issue_type,
      priority: body.priority,
      tags: body.tags,
      ai_intent: body.ai_intent !== undefined ? body.ai_intent : undefined,
      applied_template_id: body.applied_template_id !== undefined ? body.applied_template_id : undefined,
      reply_link_source: body.reply_link_source !== undefined ? body.reply_link_source : undefined,
      assigned_agent_id: body.assigned_agent_id !== undefined ? body.assigned_agent_id : undefined,
      assigned_agent_name: body.assigned_agent_name !== undefined ? body.assigned_agent_name : undefined,
      assigned_agent_avatar_url: body.assigned_agent_avatar_url !== undefined ? body.assigned_agent_avatar_url : undefined,
      assignment_method: body.assignment_method !== undefined ? body.assignment_method : undefined,
      assigned_at: body.assigned_at !== undefined ? body.assigned_at : undefined,
      main_status: body.main_status !== undefined ? body.main_status : undefined,
    });
    const updated = metaCommentsStorage.getMetaComment(id)!;
    if (!updated.main_status && body.main_status == null) {
      metaCommentsStorage.updateMetaComment(id, { main_status: computeMainStatus(updated) });
    }
    return res.json(metaCommentsStorage.getMetaComment(id));
  });
  // 指派留言給客服
  app.post("/api/meta-comments/:id/assign", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "留言不存在" });
    const { agent_id, agent_name, agent_avatar_url } = req.body || {};
    if (agent_id == null) return res.status(400).json({ message: "請選擇負責人" });
    const now = new Date().toISOString();
    metaCommentsStorage.updateMetaComment(id, {
      assigned_agent_id: Number(agent_id),
      assigned_agent_name: agent_name ?? String(agent_id),
      assigned_agent_avatar_url: agent_avatar_url ?? null,
      assignment_method: "manual",
      assigned_at: now,
    });
    return res.json(metaCommentsStorage.getMetaComment(id));
  });
  // 移回待分配
  app.post("/api/meta-comments/:id/unassign", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "留言不存在" });
    metaCommentsStorage.updateMetaComment(id, {
      assigned_agent_id: null,
      assigned_agent_name: null,
      assigned_agent_avatar_url: null,
      assignment_method: null,
      assigned_at: null,
    });
    return res.json(metaCommentsStorage.getMetaComment(id));
  });
  app.post("/api/meta-comments/:id/suggest-reply", authMiddleware, async (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "留言不存在" });
    const openaiKey = storage.getSetting("openai_api_key");
    if (!openaiKey) return res.status(400).json({ message: "請先設定 OpenAI API 金鑰" });
    const model = process.env.OPENAI_MODEL || storage.getSetting("openai_model") || "gpt-4o-mini";
    const INTENTS = "product_inquiry, price_inquiry, where_to_buy, ingredient_effect, activity_engage, dm_guide, complaint, refund_after_sale, spam_competitor";

    try {
      const openai = new OpenAI({ apiKey: openaiKey });
      const msg = comment.message;
      let appliedRuleId: number | null = null;
      let appliedTemplateId: number | null = null;
      let useTemplateForReply: MetaCommentTemplate | null = null;

      // ---------- Step 0a: 共用安全確認分流（非本店／他平台／詐騙／待確認來源 → 安全模板，不先承認責任）
      const safeConfirm = checkSafeConfirmByRule(msg);
      if (safeConfirm.matched) {
        const categoryByType: Record<string, string> = {
          fraud_impersonation: "fraud_impersonation",
          external_platform: "external_platform_order",
          safe_confirm_order: "safe_confirm_order",
        };
        const tplCategory = categoryByType[safeConfirm.type];
        const tpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, tplCategory);
        const pageSettings = metaCommentsStorage.getMetaPageSettingsByPageId(comment.page_id || "");
        const rawLine = (pageSettings?.line_after_sale ?? "").trim();
        const lineUrl = rawLine || FALLBACK_AFTER_SALE_LINE_LABEL;
        if (!rawLine && comment.page_id) {
          console.warn("[SafeAfterSale] 售後 LINE 未設定（待補資料）", { page_id: comment.page_id, comment_id: id });
        }
        const replacePlaceholder = (s: string) => (s || "").replace(/\{after_sale_line_url\}/g, lineUrl);
        const first = replacePlaceholder(tpl?.reply_first ?? "").trim();
        const second = (tpl?.reply_second && replacePlaceholder(tpl.reply_second).trim()) || null;
        metaCommentsStorage.updateMetaComment(id, {
          ai_intent: safeConfirm.type === "fraud_impersonation" ? "fraud_impersonation" : "external_or_unknown_order",
          priority: "urgent",
          ai_suggest_hide: safeConfirm.suggest_hide ? 1 : 0,
          ai_suggest_human: safeConfirm.suggest_human ? 1 : 0,
          reply_first: first || null,
          reply_second: second,
          applied_rule_id: null,
          applied_template_id: tpl?.id ?? null,
          applied_mapping_id: null,
          reply_link_source: "none",
          classifier_source: "rule",
          matched_rule_keyword: safeConfirm.keyword,
          reply_flow_type: "comfort_line",
        });
        const updated = metaCommentsStorage.getMetaComment(id)!;
        return res.json({ ...updated, classifier_source: "rule" as const, matched_rule_keyword: safeConfirm.keyword });
      }

      // ---------- Step 0: Deterministic rule-based guardrail（客訴/退款/爆氣/催單/品質抱怨先擋 → 安撫+導 LINE，不交給 AI）
      const guardrail = checkHighRiskByRule(msg);
      if (guardrail.matched) {
        console.log("[meta-comments] suggest-reply guardrail hit: id=%s keyword=%s intent=%s", id, guardrail.keyword, guardrail.intent);
        const lineAfterSaleTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_after_sale");
        const comfortFirst = (lineAfterSaleTpl?.reply_comfort || lineAfterSaleTpl?.reply_dm_guide || COMFORT_MESSAGE).trim();
        metaCommentsStorage.updateMetaComment(id, {
          ai_intent: guardrail.intent,
          priority: "urgent",
          ai_suggest_hide: guardrail.suggest_hide ? 1 : 0,
          ai_suggest_human: 1,
          reply_first: comfortFirst || COMFORT_MESSAGE,
          reply_second: null,
          applied_rule_id: appliedRuleId,
          applied_template_id: lineAfterSaleTpl?.id ?? null,
          applied_mapping_id: null,
          reply_link_source: "none",
          classifier_source: "rule",
          matched_rule_keyword: guardrail.keyword,
          reply_flow_type: "comfort_line",
        });
        const updated = metaCommentsStorage.getMetaComment(id)!;
        return res.json({ ...updated, classifier_source: "rule" as const, matched_rule_keyword: guardrail.keyword });
      }

      // ---------- Step 0b: Deterministic「建議導 LINE」關鍵字（適合我/推薦/更詳細/幫我挑/哪款比較/不知道怎麼選）→ 直接簡答+導 LINE，不交給 AI
      const lineRedirectRule = checkLineRedirectByRule(msg);
      if (lineRedirectRule.matched) {
        console.log("[meta-comments] suggest-reply line_redirect rule hit: id=%s keyword=%s", id, lineRedirectRule.keyword);
        const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
        const lineSecond = (lineGeneralTpl?.reply_dm_guide || "這題比較適合由客服一對一幫你確認，我們把 LINE 放這邊給你 🤍").trim();
        const shortPrompt = "你是社群小編。請針對留言回覆「一則簡短公開回答」（一句話即可）。只回傳 JSON：{\"reply_first\":\"...\"}";
        const shortRes = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: shortPrompt },
            { role: "user", content: `留言：「${msg}」` },
          ],
          response_format: { type: "json_object" },
        });
        const shortText = shortRes.choices[0]?.message?.content || "{}";
        const shortParsed = JSON.parse(shortText) as { reply_first?: string };
        const reply_first_line = (shortParsed.reply_first || "感謝您的留言～").trim();
        metaCommentsStorage.updateMetaComment(id, {
          ai_intent: "dm_guide",
          priority: "normal",
          ai_suggest_hide: 0,
          ai_suggest_human: 1,
          reply_first: reply_first_line,
          reply_second: lineSecond,
          applied_rule_id: appliedRuleId,
          applied_template_id: lineGeneralTpl?.id ?? null,
          applied_mapping_id: null,
          reply_link_source: "none",
          classifier_source: "rule",
          matched_rule_keyword: lineRedirectRule.keyword,
          reply_flow_type: "line_redirect",
        });
        const updated = metaCommentsStorage.getMetaComment(id)!;
        return res.json({ ...updated, classifier_source: "rule" as const, matched_rule_keyword: lineRedirectRule.keyword });
      }

      // ---------- Step 1: 規則先判斷（僅啟用中的規則，依 priority 降序，關鍵字包含即視為命中）
      const allRules = metaCommentsStorage.getMetaCommentRules(comment.brand_id ?? undefined);
      const enabledRules = allRules.filter((r) => r.enabled !== 0).sort((a, b) => b.priority - a.priority);
      for (const r of enabledRules) {
        if (!r.keyword_pattern || !msg.includes(r.keyword_pattern)) continue;
        appliedRuleId = r.id;
        if (r.rule_type === "to_human") {
          metaCommentsStorage.updateMetaComment(id, {
            is_human_handled: 1,
            ai_intent: comment.ai_intent || "complaint",
            priority: "urgent",
            ai_suggest_human: 1,
            applied_rule_id: r.id,
            applied_template_id: null,
            applied_mapping_id: null,
            reply_first: "感謝您的留言，我們已轉專人為您處理，請私訊我們以利後續聯繫。",
            reply_second: null,
            reply_link_source: "none",
          });
          const updated = metaCommentsStorage.getMetaComment(id);
          return res.json(updated);
        }
        if (r.rule_type === "hide") {
          metaCommentsStorage.updateMetaComment(id, {
            is_hidden: 1,
            applied_rule_id: r.id,
            applied_template_id: null,
            applied_mapping_id: null,
            reply_first: null,
            reply_second: null,
            reply_link_source: "none",
          });
          const updated = metaCommentsStorage.getMetaComment(id);
          return res.json(updated);
        }
        if (r.rule_type === "use_template" && r.template_id) {
          const templates = metaCommentsStorage.getMetaCommentTemplates(comment.brand_id ?? undefined);
          const t = templates.find((x) => x.id === r.template_id);
          if (t) {
            useTemplateForReply = t;
            appliedTemplateId = t.id;
          }
        }
        break; // 只取第一條命中的規則
      }

      // ---------- Step 2: AI 分類意圖（先分流：商品/價格/哪裡買/活動/需要導 LINE/訂單售後/客訴/垃圾）
      const classifyPrompt = `你是粉專留言意圖分類器。只回傳 JSON，不要其他文字。
意圖必須是以下「 exactly 一個」：${INTENTS}
重要規則：
- 「多少錢」「價格」「價錢」「幾元」→ price_inquiry。
- 「哪裡買」「怎麼買」「下單」→ where_to_buy。
- 「成分」「功效」「敏感肌」「適用」→ ingredient_effect。
- 「+1」「抽」「已完成」「好燒」「想抽」→ activity_engage。
- 「哪款適合我」「哪款比較適合」「幫我推薦」「推薦」「想了解更詳細」「更詳細」「想拿優惠」「可以私訊嗎」「一對一」→ 一律 dm_guide，suggest_human 設 true（表示建議導 LINE 一對一）。
- 「沒收到」「還沒到」「退款」「品質差」「不回訊息」「客訴」「要退」→ complaint 或 refund_after_sale，is_high_risk=true。
- 售後、查訂單、物流問題 → refund_after_sale，is_high_risk=true。
高風險時只產安撫不導購。dm_guide 表示適合導 LINE 一對一協助。
回傳格式：{"intent":"上述其一", "is_high_risk": true或false, "suggest_hide": true或false, "suggest_human": true或false}`;
      const classifyRes = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: classifyPrompt },
          { role: "user", content: `留言：「${msg}」` },
        ],
        response_format: { type: "json_object" },
      });
      const classifyText = classifyRes.choices[0]?.message?.content || "{}";
      const cls = JSON.parse(classifyText) as { intent?: string; is_high_risk?: boolean; suggest_hide?: boolean; suggest_human?: boolean };
      let isHighRisk = !!cls.is_high_risk;
      const suggestHide = !!cls.suggest_hide;
      let intent = cls.intent && INTENTS.includes(cls.intent) ? cls.intent : "product_inquiry";
      let suggestHuman = !!cls.suggest_human;
      if (msg.includes("有貨") && intent === "product_inquiry") isHighRisk = false;
      if (!isHighRisk && (msg.includes("適合") || msg.includes("推薦") || msg.includes("更詳細") || msg.includes("想了解更") || msg.includes("幫我挑") || msg.includes("哪款比較"))) {
        intent = "dm_guide";
        suggestHuman = true;
      }
      const priority = isHighRisk ? "urgent" : (comment.priority || "normal");
      metaCommentsStorage.updateMetaComment(id, {
        ai_intent: intent,
        priority,
        ai_suggest_hide: suggestHide ? 1 : 0,
        ai_suggest_human: suggestHuman ? 1 : 0,
        classifier_source: "ai",
        matched_rule_keyword: null,
      });

      // ---------- Step 3: 高風險 → 只產安撫+導 LINE，不產第二則；寫入 reply_flow_type=comfort_line
      if (isHighRisk) {
        const comfortTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_after_sale");
        const fallbackComfort = comfortTpl?.reply_comfort || comfortTpl?.reply_dm_guide || "感謝您的留言，我們已收到並會盡快由專人與您聯繫，請私訊我們以利處理。";
        const comfortPrompt = "你是社群小編。此留言為客訴/退款/負面情緒，請回覆一段簡短安撫並引導私訊或專人處理，不要推銷。只回傳 JSON：{\"reply_comfort\":\"...\"}";
        const comfortRes = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: comfortPrompt },
            { role: "user", content: `留言：「${msg}」` },
          ],
          response_format: { type: "json_object" },
        });
        const comfortText = comfortRes.choices[0]?.message?.content || "{}";
        const comfortParsed = JSON.parse(comfortText) as { reply_comfort?: string };
        const reply_comfort = (comfortParsed.reply_comfort || fallbackComfort).trim();
        metaCommentsStorage.updateMetaComment(id, {
          reply_first: reply_comfort || fallbackComfort,
          reply_second: null,
          applied_rule_id: appliedRuleId,
          applied_template_id: appliedTemplateId,
          applied_mapping_id: null,
          reply_link_source: "none",
          classifier_source: "ai",
          matched_rule_keyword: null,
          reply_flow_type: "comfort_line",
        });
        const updated = metaCommentsStorage.getMetaComment(id)!;
        return res.json({ ...updated, classifier_source: "ai" as const, matched_rule_keyword: null });
      }

      // ---------- Step 3b: 需要導 LINE（dm_guide 或 suggest_human）→ 公開簡答 + 第二則導 LINE 話術
      const shouldRedirectLine = intent === "dm_guide" || suggestHuman;
      if (shouldRedirectLine) {
        const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
        const lineSecond = (lineGeneralTpl?.reply_dm_guide || "這題比較適合由客服一對一幫你確認，我們把 LINE 放這邊給你 🤍").trim();
        const shortPrompt = "你是社群小編。請針對留言回覆「一則簡短公開回答」（一句話即可）。只回傳 JSON：{\"reply_first\":\"...\"}";
        const shortRes = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: shortPrompt },
            { role: "user", content: `留言：「${msg}」` },
          ],
          response_format: { type: "json_object" },
        });
        const shortText = shortRes.choices[0]?.message?.content || "{}";
        const shortParsed = JSON.parse(shortText) as { reply_first?: string };
        const reply_first_line = (shortParsed.reply_first || "感謝您的留言～").trim();
        metaCommentsStorage.updateMetaComment(id, {
          reply_first: reply_first_line,
          reply_second: lineSecond,
          applied_rule_id: appliedRuleId,
          applied_template_id: lineGeneralTpl?.id ?? appliedTemplateId,
          applied_mapping_id: null,
          reply_link_source: "none",
          classifier_source: "ai",
          matched_rule_keyword: null,
          reply_flow_type: "line_redirect",
        });
        const updated = metaCommentsStorage.getMetaComment(id)!;
        return res.json({ ...updated, classifier_source: "ai" as const, matched_rule_keyword: null });
      }

      // ---------- Step 4: 取得 mapping（僅 auto_comment_enabled=1）；定義 fallback：無 mapping 時連結為空、reply_link_source='none'
      const mapping = metaCommentsStorage.getMappingForComment(comment.brand_id, comment.page_id, comment.post_id);
      const productUrl = mapping ? (mapping.primary_url || mapping.fallback_url || "") : "";
      const linkSource = mapping ? "post_mapping" : "none";
      const toneHint = mapping?.tone_hint || "親切、自然";
      const preferredFlow = (mapping as { preferred_flow?: string } | null)?.preferred_flow;

      // ---------- Step 4b: 貼文偏好為「優先導 LINE」或「僅售後」→ 此則走簡答+導 LINE
      if (preferredFlow === "line_redirect" || preferredFlow === "support_only") {
        const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
        const lineSecond = (lineGeneralTpl?.reply_dm_guide || "這題比較適合由客服一對一幫你確認，我們把 LINE 放這邊給你 🤍").trim();
        const shortPrompt = "你是社群小編。請針對留言回覆「一則簡短公開回答」（一句話即可）。只回傳 JSON：{\"reply_first\":\"...\"}";
        const shortRes = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: shortPrompt },
            { role: "user", content: `留言：「${msg}」` },
          ],
          response_format: { type: "json_object" },
        });
        const shortText = shortRes.choices[0]?.message?.content || "{}";
        const shortParsed = JSON.parse(shortText) as { reply_first?: string };
        const reply_first_line = (shortParsed.reply_first || "感謝您的留言～").trim();
        metaCommentsStorage.updateMetaComment(id, {
          reply_first: reply_first_line,
          reply_second: lineSecond,
          applied_rule_id: appliedRuleId,
          applied_template_id: lineGeneralTpl?.id ?? appliedTemplateId,
          applied_mapping_id: mapping?.id ?? null,
          reply_link_source: "none",
          classifier_source: "ai",
          matched_rule_keyword: null,
          reply_flow_type: "line_redirect",
        });
        const updated = metaCommentsStorage.getMetaComment(id)!;
        return res.json({ ...updated, classifier_source: "ai" as const, matched_rule_keyword: null });
      }

      // ---------- Step 5: 產生回覆（規則命中 use_template 時用模板覆蓋 AI；否則 AI 雙段式）
      let reply_first: string;
      let reply_second: string;
      if (useTemplateForReply) {
        reply_first = useTemplateForReply.reply_first || "";
        reply_second = (useTemplateForReply.reply_second || "").replace(/\{primary_url\}/g, productUrl || "").trim();
        if (productUrl && !reply_second.includes(productUrl)) reply_second = reply_second ? reply_second + " " + productUrl : productUrl;
      } else {
        const dualPrompt = `你是社群小編。請針對留言先回覆「第一則：解答問題」，再回覆「第二則：自然導購」，語氣參考：${toneHint}。簡短、有人味，不要罐頭。
若下方有提供導購連結，第二則必須自然帶入該連結。若沒有連結則第二則只溫和邀請官網或私訊，不要編造連結。`;
        const userContent = productUrl
          ? `留言：「${msg}」\n請回覆 JSON：{"reply_first":"第一則解答", "reply_second":"第二則導購，結尾帶入此連結：${productUrl}"}`
          : `留言：「${msg}」\n請回覆 JSON：{"reply_first":"第一則解答", "reply_second":"第二則溫和邀請至官網或私訊詢問，不要貼任何網址"}`;
        const dualRes = await openai.chat.completions.create({
          model,
          messages: [{ role: "system", content: dualPrompt }, { role: "user", content: userContent }],
          response_format: { type: "json_object" },
        });
        const dualText = dualRes.choices[0]?.message?.content || "{}";
        const dualParsed = JSON.parse(dualText) as { reply_first?: string; reply_second?: string };
        reply_first = dualParsed.reply_first || "";
        reply_second = dualParsed.reply_second || "";
        if (productUrl && reply_second && !reply_second.includes(productUrl)) reply_second = reply_second.trim() + " " + productUrl;
      }

      const replyFlowType = productUrl ? "product_link" : "public_only";
      metaCommentsStorage.updateMetaComment(id, {
        reply_first: reply_first || null,
        reply_second: reply_second || null,
        applied_rule_id: appliedRuleId,
        applied_template_id: appliedTemplateId,
        applied_mapping_id: mapping?.id ?? null,
        reply_link_source: linkSource,
        classifier_source: "ai",
        matched_rule_keyword: null,
        reply_flow_type: replyFlowType,
      });
      const updated = metaCommentsStorage.getMetaComment(id)!;
      return res.json({ ...updated, classifier_source: "ai" as const, matched_rule_keyword: null });
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "AI 建議失敗" });
    }
  });

  app.get("/api/meta-comment-templates", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const list = metaCommentsStorage.getMetaCommentTemplates(brand_id);
    return res.json(list);
  });
  app.post("/api/meta-comment-templates", authMiddleware, (req: any, res) => {
    const body = req.body || {};
    const row = metaCommentsStorage.createMetaCommentTemplate({
      brand_id: body.brand_id,
      category: body.category || "product_inquiry",
      name: body.name || "未命名",
      reply_first: body.reply_first,
      reply_second: body.reply_second,
      reply_comfort: body.reply_comfort,
      reply_dm_guide: body.reply_dm_guide,
      tone_hint: body.tone_hint,
    });
    return res.json(row);
  });
  app.put("/api/meta-comment-templates/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const body = req.body || {};
    metaCommentsStorage.updateMetaCommentTemplate(id, body);
    return res.json(metaCommentsStorage.getMetaCommentTemplates().find((t) => t.id === id));
  });
  app.delete("/api/meta-comment-templates/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const ok = metaCommentsStorage.deleteMetaCommentTemplate(id);
    return res.json({ success: ok });
  });

  app.get("/api/meta-pages", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const list = metaCommentsStorage.getMetaPagesForDropdown(brand_id ?? undefined);
    return res.json(list);
  });
  app.get("/api/meta-pages/:pageId/posts", authMiddleware, (req: any, res) => {
    const pageId = String(req.params.pageId || "");
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const list = metaCommentsStorage.getMetaPostsByPage(pageId, brand_id ?? undefined);
    return res.json(list);
  });
  app.get("/api/meta-products", authMiddleware, (req: any, res) => {
    const q = req.query.q ? String(req.query.q) : undefined;
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const list = metaCommentsStorage.searchMetaProducts(q, brand_id ?? undefined);
    return res.json(list);
  });
  app.get("/api/meta-post-mappings", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const q = (req.query.q as string) || "";
    let list = metaCommentsStorage.getMetaPostMappings(brand_id ?? undefined);
    if (q.trim()) {
      const lower = q.trim().toLowerCase();
      list = list.filter(
        (m) =>
          (m.page_name || "").toLowerCase().includes(lower) ||
          (m.post_name || "").toLowerCase().includes(lower) ||
          (m.post_id || "").toLowerCase().includes(lower) ||
          (m.product_name || "").toLowerCase().includes(lower)
      );
    }
    return res.json(list);
  });
  app.post("/api/meta-post-mappings", authMiddleware, (req: any, res) => {
    const body = req.body || {};
    if (!body.brand_id) return res.status(400).json({ message: "brand_id 必填" });
    const pageId = body.page_id ?? null;
    const postId = (body.post_id || "").trim();
    if (!postId) return res.status(400).json({ message: "貼文 ID 必填" });
    const enabled = body.auto_comment_enabled !== 0 ? 1 : 0;
    if (enabled && metaCommentsStorage.hasDuplicateEnabledMapping(body.brand_id, pageId, postId)) {
      return res.status(400).json({ message: "同一粉專＋貼文已存在啟用中的對應，請勿重複建立" });
    }
    const row = metaCommentsStorage.createMetaPostMapping({
      brand_id: body.brand_id,
      page_id: pageId,
      page_name: body.page_name,
      post_id: postId,
      post_name: body.post_name,
      product_name: body.product_name,
      primary_url: body.primary_url,
      fallback_url: body.fallback_url,
      tone_hint: body.tone_hint,
      auto_comment_enabled: enabled,
      preferred_flow: body.preferred_flow ?? null,
    });
    return res.json(row);
  });
  app.put("/api/meta-post-mappings/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const body = req.body || {};
    const pageId = body.page_id !== undefined ? body.page_id : undefined;
    const postId = body.post_id !== undefined ? (body.post_id || "").trim() : undefined;
    const enabled = body.auto_comment_enabled !== undefined ? (body.auto_comment_enabled !== 0 ? 1 : 0) : undefined;
    const existing = metaCommentsStorage.getMetaPostMappings().find((m) => m.id === id);
    if (existing && (pageId !== undefined || postId !== undefined || enabled !== undefined)) {
      const finalPageId = pageId !== undefined ? pageId : existing.page_id;
      const finalPostId = postId !== undefined ? postId : existing.post_id;
      const finalEnabled = enabled !== undefined ? enabled : existing.auto_comment_enabled;
      if (finalEnabled && metaCommentsStorage.hasDuplicateEnabledMapping(existing.brand_id, finalPageId, finalPostId, id)) {
        return res.status(400).json({ message: "同一粉專＋貼文已存在啟用中的對應，請勿重複" });
      }
    }
    metaCommentsStorage.updateMetaPostMapping(id, body);
    const list = metaCommentsStorage.getMetaPostMappings();
    return res.json(list.find((m) => m.id === id));
  });
  app.delete("/api/meta-post-mappings/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const ok = metaCommentsStorage.deleteMetaPostMapping(id);
    return res.json({ success: ok });
  });

  app.get("/api/meta-comment-rules", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const list = metaCommentsStorage.getMetaCommentRules(brand_id);
    return res.json(list);
  });
  app.post("/api/meta-comment-rules", authMiddleware, (req: any, res) => {
    const body = req.body || {};
    const row = metaCommentsStorage.createMetaCommentRule({
      brand_id: body.brand_id,
      page_id: body.page_id,
      post_id: body.post_id,
      priority: body.priority ?? 0,
      rule_type: body.rule_type || "use_template",
      keyword_pattern: body.keyword_pattern || "",
      template_id: body.template_id,
      tag_value: body.tag_value,
      enabled: body.enabled !== 0 ? 1 : 0,
    });
    return res.json(row);
  });
  app.put("/api/meta-comment-rules/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const existing = metaCommentsStorage.getMetaCommentRule(id);
    if (!existing) return res.status(404).json({ message: "規則不存在" });
    const body = req.body || {};
    metaCommentsStorage.updateMetaCommentRule(id, {
      brand_id: body.brand_id !== undefined ? body.brand_id : undefined,
      page_id: body.page_id !== undefined ? body.page_id : undefined,
      post_id: body.post_id !== undefined ? body.post_id : undefined,
      priority: body.priority !== undefined ? body.priority : undefined,
      rule_type: body.rule_type,
      keyword_pattern: body.keyword_pattern,
      template_id: body.template_id !== undefined ? body.template_id : undefined,
      tag_value: body.tag_value !== undefined ? body.tag_value : undefined,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
    });
    const updated = metaCommentsStorage.getMetaCommentRule(id);
    return res.json(updated);
  });
  app.delete("/api/meta-comment-rules/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const ok = metaCommentsStorage.deleteMetaCommentRule(id);
    return res.json({ success: ok });
  });

  app.post("/api/meta-comments/:id/resolve", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "留言不存在" });
    const resolved = resolveCommentMetadata({
      brand_id: comment.brand_id,
      page_id: comment.page_id,
      post_id: comment.post_id,
      post_name: comment.post_name,
      post_title_from_graph: (comment as any).post_display_name && (comment as any).detected_post_title_source === "graph_api" ? (comment as any).post_display_name : null,
      message: comment.message,
      is_sensitive_or_complaint: comment.priority === "urgent" || ["complaint", "refund_after_sale"].includes(comment.ai_intent || ""),
    });
    metaCommentsStorage.updateMetaComment(id, {
      post_display_name: resolved.post_display_name,
      detected_post_title_source: resolved.detected_post_title_source,
      detected_product_name: resolved.detected_product_name,
      detected_product_source: resolved.detected_product_source,
      target_line_type: resolved.target_line_type,
      target_line_value: resolved.target_line_value,
    });
    return res.json(metaCommentsStorage.getMetaComment(id));
  });

  app.post("/api/meta-comments/:id/reply", authMiddleware, async (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "留言不存在" });
    const message = (req.body?.message as string)?.trim();
    if (!message) return res.status(400).json({ message: "請提供 message（回覆內容）" });
    const channel = storage.getChannelByBotId(comment.page_id);
    if (!channel?.access_token) {
      metaCommentsStorage.updateMetaComment(id, {
        reply_error: "缺少該粉專的 Page access token",
        platform_error: "未設定或未匹配 channel",
      });
      metaCommentsStorage.insertMetaCommentAction({ comment_id: id, action_type: "reply", success: 0, error_message: "缺少 Page token", executor: "user" });
      return res.status(400).json({ message: "此粉專尚未設定 Page access token，無法發佈回覆" });
    }
    const result = await replyToComment({
      commentId: comment.comment_id,
      message,
      pageAccessToken: channel.access_token,
    });
    const now = new Date().toISOString();
    if (result.success) {
      metaCommentsStorage.updateMetaComment(id, {
        replied_at: now,
        reply_error: null,
        platform_error: null,
      });
      metaCommentsStorage.insertMetaCommentAction({
        comment_id: id,
        action_type: "reply",
        success: 1,
        platform_response: result.platform_response ?? null,
        executor: "user",
      });
      const updated = metaCommentsStorage.getMetaComment(id)!;
      metaCommentsStorage.updateMetaComment(id, { main_status: computeMainStatus(updated) });
      return res.json(metaCommentsStorage.getMetaComment(id));
    }
    const errMsg = [result.error, result.platform_code && `(code: ${result.platform_code})`].filter(Boolean).join(" ");
    metaCommentsStorage.updateMetaComment(id, {
      reply_error: result.error ?? "未知錯誤",
      platform_error: result.platform_response ?? errMsg,
      main_status: "failed",
    });
    metaCommentsStorage.insertMetaCommentAction({
      comment_id: id,
      action_type: "reply",
      success: 0,
      error_message: result.error ?? undefined,
      platform_response: result.platform_response ?? undefined,
      executor: "user",
    });
    return res.status(502).json({
      message: "平台發佈回覆失敗",
      error: result.error,
      platform_code: result.platform_code,
    });
  });

  app.post("/api/meta-comments/:id/hide", authMiddleware, async (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "留言不存在" });
    const channel = storage.getChannelByBotId(comment.page_id);
    if (!channel?.access_token) {
      const errMsg = "缺少該粉專的 Page access token";
      metaCommentsStorage.updateMetaComment(id, { hide_error: errMsg, platform_error: "未設定或未匹配 channel" });
      metaCommentsStorage.insertMetaCommentAction({ comment_id: id, action_type: "hide", success: 0, error_message: errMsg, executor: "user" });
      return res.status(400).json({ message: "此粉專尚未設定 Page access token，無法隱藏留言" });
    }
    const result = await hideComment({
      commentId: comment.comment_id,
      pageAccessToken: channel.access_token,
    });
    const now = new Date().toISOString();
    if (result.success) {
      metaCommentsStorage.updateMetaComment(id, {
        is_hidden: 1,
        auto_hidden_at: now,
        hide_error: null,
      });
      metaCommentsStorage.insertMetaCommentAction({
        comment_id: id,
        action_type: "hide",
        success: 1,
        platform_response: result.platform_response ?? null,
        executor: "user",
      });
      const updated = metaCommentsStorage.getMetaComment(id)!;
      metaCommentsStorage.updateMetaComment(id, { main_status: computeMainStatus(updated) });
      return res.json(metaCommentsStorage.getMetaComment(id));
    }
    const errMsg = [result.error, result.platform_code && `(code: ${result.platform_code})`].filter(Boolean).join(" ");
    metaCommentsStorage.updateMetaComment(id, { hide_error: result.error ?? "未知錯誤", platform_error: errMsg, main_status: "failed" });
    metaCommentsStorage.insertMetaCommentAction({
      comment_id: id,
      action_type: "hide",
      success: 0,
      error_message: result.error ?? undefined,
      platform_response: result.platform_response ?? undefined,
      executor: "user",
    });
    return res.status(502).json({
      message: "平台隱藏留言失敗",
      error: result.error,
      platform_code: result.platform_code,
    });
  });

  app.get("/api/meta-page-settings", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const list = metaCommentsStorage.getMetaPageSettingsList(brand_id);
    return res.json(list);
  });
  app.get("/api/meta-page-settings/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const row = metaCommentsStorage.getMetaPageSettings(id);
    if (!row) return res.status(404).json({ message: "找不到該設定" });
    return res.json(row);
  });
  app.get("/api/meta-page-settings/by-page/:pageId", authMiddleware, (req: any, res) => {
    const pageId = String(req.params.pageId || "");
    if (!pageId) return res.status(400).json({ message: "請提供 page_id" });
    const row = metaCommentsStorage.getMetaPageSettingsByPageId(pageId);
    if (!row) return res.status(404).json({ message: "找不到該粉專設定" });
    return res.json(row);
  });
  app.post("/api/meta-page-settings", authMiddleware, (req: any, res) => {
    const body = req.body || {};
    if (!body.page_id?.trim()) return res.status(400).json({ message: "請提供 page_id" });
    if (body.brand_id == null) return res.status(400).json({ message: "請提供 brand_id" });
    try {
      const row = metaCommentsStorage.createMetaPageSettings({
        page_id: body.page_id.trim(),
        page_name: body.page_name?.trim() || null,
        brand_id: Number(body.brand_id),
        line_general: body.line_general?.trim() || null,
        line_after_sale: body.line_after_sale?.trim() || null,
        auto_hide_sensitive: body.auto_hide_sensitive ? 1 : 0,
        auto_reply_enabled: body.auto_reply_enabled ? 1 : 0,
        auto_route_line_enabled: body.auto_route_line_enabled ? 1 : 0,
        default_reply_template_id: body.default_reply_template_id != null ? Number(body.default_reply_template_id) : null,
        default_sensitive_template_id: body.default_sensitive_template_id != null ? Number(body.default_sensitive_template_id) : null,
        default_flow: body.default_flow?.trim() || null,
        default_product_name: body.default_product_name?.trim() || null,
      });
      return res.json(row);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return res.status(400).json({ message: "該 page_id 已存在設定" });
      return res.status(500).json({ message: e?.message || "建立失敗" });
    }
  });
  app.put("/api/meta-page-settings/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const existing = metaCommentsStorage.getMetaPageSettings(id);
    if (!existing) return res.status(404).json({ message: "找不到該設定" });
    const body = req.body || {};
    metaCommentsStorage.updateMetaPageSettings(id, {
      page_name: body.page_name !== undefined ? body.page_name : undefined,
      brand_id: body.brand_id !== undefined ? Number(body.brand_id) : undefined,
      line_general: body.line_general !== undefined ? body.line_general : undefined,
      line_after_sale: body.line_after_sale !== undefined ? body.line_after_sale : undefined,
      auto_hide_sensitive: body.auto_hide_sensitive !== undefined ? (body.auto_hide_sensitive ? 1 : 0) : undefined,
      auto_reply_enabled: body.auto_reply_enabled !== undefined ? (body.auto_reply_enabled ? 1 : 0) : undefined,
      auto_route_line_enabled: body.auto_route_line_enabled !== undefined ? (body.auto_route_line_enabled ? 1 : 0) : undefined,
      default_reply_template_id: body.default_reply_template_id !== undefined ? (body.default_reply_template_id == null ? null : Number(body.default_reply_template_id)) : undefined,
      default_sensitive_template_id: body.default_sensitive_template_id !== undefined ? (body.default_sensitive_template_id == null ? null : Number(body.default_sensitive_template_id)) : undefined,
      default_flow: body.default_flow !== undefined ? body.default_flow : undefined,
      default_product_name: body.default_product_name !== undefined ? body.default_product_name : undefined,
    });
    return res.json(metaCommentsStorage.getMetaPageSettings(id));
  });
  app.delete("/api/meta-page-settings/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const ok = metaCommentsStorage.deleteMetaPageSettings(id);
    return res.json({ success: ok });
  });

  app.get("/api/meta-product-keywords", authMiddleware, (req: any, res) => {
    const brand_id = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const list = metaCommentsStorage.getMetaProductKeywords(brand_id);
    return res.json(list);
  });
  app.post("/api/meta-product-keywords", authMiddleware, (req: any, res) => {
    const body = req.body || {};
    if (!body.keyword?.trim()) return res.status(400).json({ message: "請提供 keyword" });
    if (!body.product_name?.trim()) return res.status(400).json({ message: "請提供 product_name" });
    if (!["post", "comment"].includes(body.match_scope)) return res.status(400).json({ message: "match_scope 須為 post 或 comment" });
    const row = metaCommentsStorage.createMetaProductKeyword({
      brand_id: body.brand_id != null ? Number(body.brand_id) : null,
      keyword: body.keyword.trim(),
      product_name: body.product_name.trim(),
      match_scope: body.match_scope,
    });
    return res.json(row);
  });
  app.delete("/api/meta-product-keywords/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "無效的 ID" });
    const ok = metaCommentsStorage.deleteMetaProductKeyword(id);
    return res.json({ success: ok });
  });

  app.get("/api/brands", authMiddleware, (_req, res) => {
    const brands = storage.getBrands();
    return res.json(brands);
  });

  app.get("/api/brands/:id", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const brand = storage.getBrand(id);
    if (!brand) return res.status(404).json({ message: "品牌不存在" });
    return res.json(brand);
  });

  app.post("/api/brands", authMiddleware, superAdminOnly, async (req, res) => {
    const { name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key } = req.body;
    if (!name || !slug) return res.status(400).json({ message: "品牌名稱與代碼為必填" });
    try {
      const brand = await storage.createBrand(name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key);
      return res.json({ success: true, brand });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return res.status(400).json({ message: "品牌代碼已存在" });
      }
      return res.status(500).json({ message: "建立失敗" });
    }
  });

  app.put("/api/brands/:id", authMiddleware, superAdminOnly, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const {
      name, slug, logo_url, description, system_prompt,
      superlanding_merchant_no, superlanding_access_key, return_form_url,
      shopline_store_domain, shopline_api_token,
    } = req.body;
    const data: Record<string, string> = {};
    if (name !== undefined) data.name = name;
    if (slug !== undefined) data.slug = slug;
    if (logo_url !== undefined) data.logo_url = logo_url;
    if (description !== undefined) data.description = description;
    if (system_prompt !== undefined) data.system_prompt = system_prompt;
    if (superlanding_merchant_no !== undefined) data.superlanding_merchant_no = superlanding_merchant_no;
    if (superlanding_access_key !== undefined) data.superlanding_access_key = superlanding_access_key;
    if (return_form_url !== undefined) data.return_form_url = return_form_url;
    if (shopline_store_domain !== undefined) data.shopline_store_domain = shopline_store_domain;
    if (shopline_api_token !== undefined) data.shopline_api_token = shopline_api_token;
    if (!(await storage.updateBrand(id, data))) return res.status(404).json({ message: "品牌不存在" });
    return res.json({ success: true });
  });

  app.delete("/api/brands/:id", authMiddleware, superAdminOnly, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    if (!(await storage.deleteBrand(id))) return res.status(404).json({ message: "品牌不存在" });
    return res.json({ success: true });
  });

  app.get("/api/brands/:id/channels", authMiddleware, (req, res) => {
    const brandId = parseIdParam(req.params.id);
    if (brandId === null) return res.status(400).json({ message: "無效的 ID" });
    const channels = storage.getChannelsByBrand(brandId);
    return res.json(channels);
  });

  app.get("/api/brands/:id/assigned-agents", authMiddleware, (req, res) => {
    const brandId = parseIdParam(req.params.id);
    if (brandId === null) return res.status(400).json({ message: "無效的 ID" });
    const brand = storage.getBrand(brandId);
    if (!brand) return res.status(404).json({ message: "品牌不存在" });
    const agents = storage.getBrandAssignedAgents(brandId);
    return res.json(agents);
  });

  app.get("/api/channels", authMiddleware, (_req, res) => {
    const channels = storage.getChannels();
    return res.json(channels);
  });

  app.post("/api/brands/:id/channels", authMiddleware, superAdminOnly, async (req, res) => {
    const brandId = parseIdParam(req.params.id);
    if (brandId === null) return res.status(400).json({ message: "無效的 ID" });
    const { platform, channel_name, bot_id, access_token, channel_secret } = req.body;
    if (!platform || !channel_name) return res.status(400).json({ message: "平台與頻道名稱為必填" });
    if (!["line", "messenger"].includes(platform)) return res.status(400).json({ message: "平台須為 line 或 messenger" });
    const channel = await storage.createChannel(brandId, platform, channel_name, bot_id, access_token, channel_secret);
    return res.json({ success: true, channel });
  });

  app.put("/api/channels/:id", authMiddleware, superAdminOnly, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const { platform, channel_name, bot_id, access_token, channel_secret, is_active, is_ai_enabled, brand_id } = req.body;
    const data: Record<string, any> = {};
    if (platform !== undefined) data.platform = platform;
    if (channel_name !== undefined) data.channel_name = channel_name;
    if (bot_id !== undefined) data.bot_id = bot_id;
    if (access_token !== undefined) data.access_token = access_token;
    if (channel_secret !== undefined) data.channel_secret = channel_secret;
    if (is_active !== undefined) data.is_active = is_active;
    if (is_ai_enabled !== undefined) data.is_ai_enabled = is_ai_enabled;
    if (brand_id !== undefined) data.brand_id = brand_id;
    if (!(await storage.updateChannel(id, data))) return res.status(404).json({ message: "頻道不存在" });
    return res.json({ success: true });
  });

  app.delete("/api/channels/:id", authMiddleware, superAdminOnly, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    if (!(await storage.deleteChannel(id))) return res.status(404).json({ message: "頻道不存在" });
    return res.json({ success: true });
  });

  app.post("/api/brands/:id/test-superlanding", authMiddleware, superAdminOnly, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
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

  app.post("/api/brands/:id/test-shopline", authMiddleware, superAdminOnly, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const brand = storage.getBrand(id);
    if (!brand) return res.status(404).json({ message: "品牌不存在" });
    const apiToken = (brand.shopline_api_token || "").trim();
    if (!apiToken) {
      return res.json({ success: false, message: "此品牌尚未設定 SHOPLINE API Token" });
    }
    // SHOPLINE Open API 使用固定 base：https://open.shopline.io（Token 會識別商店）
    const openApiBase = "https://open.shopline.io/v1";
    const testUrl = `${openApiBase}/orders?per_page=1`;
    try {
      const slRes = await fetch(testUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiToken}`,
          "User-Agent": process.env.SHOPLINE_USER_AGENT || "OmniAgentConsole/1.0",
        },
      });
      if (slRes.ok) {
        const data = await slRes.json();
        const items = data.items ?? data.orders ?? data.data ?? [];
        const total = data.pagination?.total ?? data.total ?? (Array.isArray(items) ? items.length : 0);
        return res.json({ success: true, message: `SHOPLINE 連線成功！取得訂單資料 (${total})` });
      }
      const errText = await slRes.text().catch(() => "");
      const errSummary = errText.length > 200 ? errText.slice(0, 200) + "…" : errText;
      return res.json({
        success: false,
        message: `SHOPLINE 連線失敗 (HTTP ${slRes.status})：${errSummary || "請確認 API Token 是否正確、是否已向 SHOPLINE 申請 OpenAPI 權限"}`,
      });
    } catch (fetchErr: any) {
      const detail = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.message || "未知網路錯誤";
      return res.json({ success: false, message: `SHOPLINE 連線失敗（網路錯誤）：${detail}` });
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
        await openai.chat.completions.create({ model: getOpenAIModel(), messages: [{ role: "user", content: "hi" }], max_completion_tokens: 5 });
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
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
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
            await storage.updateChannel(id, { bot_id: botUserId });
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
            await storage.updateChannel(id, { bot_id: pageId });
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

  /** 緊急案件判定：任一符合即為緊急（UI 顯示用，內部仍可用 status/case_priority） */
  const URGENT_TAGS = ["客訴", "退款", "轉主管", "緊急案件"];
  const OVERDUE_MS = 60 * 60 * 1000;
  const isUrgentContact = (c: any): boolean => {
    if (["closed", "resolved"].includes(c.status)) return false;
    if (c.status === "high_risk" || (c.case_priority != null && c.case_priority <= 2)) return true;
    try {
      const tags = JSON.parse(c.tags || "[]");
      if (Array.isArray(tags) && URGENT_TAGS.some((t: string) => tags.includes(t))) return true;
    } catch (_) {}
    if (c.vip_level > 0 && String(c.last_message_sender_type || "").toLowerCase() === "user" && c.last_message_at) {
      const t = new Date(String(c.last_message_at).replace(" ", "T")).getTime();
      if (Date.now() - t > OVERDUE_MS) return true;
    }
    if (c.response_sla_deadline_at) {
      const deadline = new Date(String(c.response_sla_deadline_at).replace(" ", "T")).getTime();
      if (Date.now() > deadline) return true;
    }
    return false;
  };
  const isOverdueContact = (c: any): boolean => {
    if (["closed", "resolved"].includes(c.status)) return false;
    if (String(c.last_message_sender_type || "").toLowerCase() !== "user" || !c.last_message_at) return false;
    const t = new Date(String(c.last_message_at).replace(" ", "T")).getTime();
    return Date.now() - t > OVERDUE_MS;
  };

  /** AI 建議：依最近訊息關鍵字建議 issue_type / status / priority（最小可行，人工可覆寫） */
  function suggestAiFromMessages(contactId: number): { issue_type?: string; status?: string; priority?: string; tags?: string[] } {
    const messages = storage.getMessages(contactId).slice(-20);
    const text = messages.filter((m) => m.sender_type === "user").map((m) => m.content || "").join(" ");
    const lower = text.toLowerCase();
    const suggestions: { issue_type?: string; status?: string; priority?: string; tags?: string[] } = {};
    if (/\b(退款|退費|取消訂單|退訂)\b/.test(text)) { suggestions.issue_type = "return_refund"; (suggestions.tags = suggestions.tags || []).push("退款"); }
    else if (/\b(客訴|投訴|抱怨|申訴)\b/.test(text)) { suggestions.issue_type = "complaint"; (suggestions.tags = suggestions.tags || []).push("客訴"); }
    else if (/\b(出貨|寄送|物流|漏件|沒收到|延遲)\b/.test(text)) { suggestions.issue_type = "order_modify"; (suggestions.tags = suggestions.tags || []).push("出貨問題"); }
    else if (/\b(訂單|查詢|編號|序號)\b/.test(text)) { suggestions.issue_type = "order_inquiry"; }
    else if (/\b(商品|規格|尺寸|顏色|怎麼用)\b/.test(text)) { suggestions.issue_type = "product_consult"; (suggestions.tags = suggestions.tags || []).push("商品諮詢"); }
    if (/\b(轉主管|找主管|人工|真人|客服)\b/.test(text)) (suggestions.tags = suggestions.tags || []).push("等主管確認");
    if (/\b(緊急|很急|快點|都不回|爛|負評)\b/.test(text) || (suggestions.issue_type === "complaint" || suggestions.issue_type === "return_refund")) suggestions.priority = "優先處理";
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.sender_type === "user") suggestions.status = "待處理";
    else if (lastMsg?.sender_type === "admin" || lastMsg?.sender_type === "ai") suggestions.status = "等客戶回覆";
    return suggestions;
  }

  app.get("/api/contacts", authMiddleware, (req: any, res) => {
    const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
    const assignedToMe = req.query.assigned_to_me === "1" || req.query.assigned_to_me === "true";
    const needReplyFirst = req.query.need_reply_first === "1" || req.query.need_reply_first === "true";
    const userId = req.session?.userId;
    const assignedToUserId = assignedToMe && userId ? userId : undefined;
    const agentIdForFlags = userId ?? undefined;
    let contacts = storage.getContacts(brandId, assignedToUserId, agentIdForFlags);
    if (needReplyFirst) {
      contacts = [...contacts].sort((a, b) => {
        const aNeeds = (a as any).last_message_sender_type === "user" ? 0 : 1;
        const bNeeds = (b as any).last_message_sender_type === "user" ? 0 : 1;
        if (aNeeds !== bNeeds) return aNeeds - bNeeds;
        const aAt = a.last_message_at || "";
        const bAt = b.last_message_at || "";
        return bAt.localeCompare(aAt);
      });
    }
    const withFlags = (contacts as any[]).map((c) => {
      if (!c || typeof c !== "object") return c;
      try {
        return {
          ...c,
          is_urgent: isUrgentContact(c),
          is_overdue: isOverdueContact(c),
        };
      } catch (err) {
        return { ...c, is_urgent: false, is_overdue: false };
      }
    });
    return res.json(withFlags);
  });

  app.get("/api/contacts/:id", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const contact = storage.getContact(id) as any;
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    if (!["closed", "resolved"].includes(contact.status)) {
      try {
        const suggested = suggestAiFromMessages(id);
        if (Object.keys(suggested).length > 0) {
          storage.updateContactAiSuggestions(id, suggested);
          contact.ai_suggestions = JSON.stringify(suggested);
        }
      } catch (_) {}
    }
    if (!contact.ai_suggestions && (contact as any).ai_suggestions === undefined) contact.ai_suggestions = null;
    return res.json(contact);
  });

  app.put("/api/contacts/:id/human", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
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
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const { status } = req.body;
    const validStatuses = ["pending", "processing", "resolved", "ai_handling", "awaiting_human", "high_risk", "closed", "new_case", "pending_info", "pending_order_id", "assigned", "waiting_customer", "resolved_observe", "reopened"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const contact = storage.getContact(id);
    if (status === "closed" && contact?.assigned_agent_id) {
      assignment.closeCase(id, contact.assigned_agent_id);
    } else {
      storage.updateContactStatus(id, status);
    }
    broadcastSSE("contacts_updated", { contact_id: id });

    if (status === "resolved" || status === "closed") {
      const contactForRating = storage.getContact(id);
      if (contactForRating) {
        let ratingSent = false;
        if (contactForRating.needs_human === 1 && contactForRating.cs_rating == null) {
          if (contactForRating.platform === "line") {
            const token = getLineTokenForContact(contactForRating);
            if (token) {
              try {
                await sendRatingFlexMessage(contactForRating, "human");
                storage.createMessage(id, contactForRating.platform, "system", "(系統提示) 已自動發送真人客服滿意度調查卡片給客戶");
                ratingSent = true;
              } catch (err) {
                console.error("Auto rating (human) send failed:", err);
              }
            }
          }
        }
        if (!ratingSent && contactForRating.ai_rating == null) {
          if (contactForRating.platform === "line") {
            const token = getLineTokenForContact(contactForRating);
            if (token) {
              try {
                await sendRatingFlexMessage(contactForRating, "ai");
                storage.createMessage(id, contactForRating.platform, "system", "(系統提示) 已自動發送 AI 客服滿意度調查卡片給客戶");
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

  app.put("/api/contacts/:id/issue-type", authMiddleware, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const { issue_type } = req.body;
    const validTypes = ["order_inquiry", "product_consult", "return_refund", "complaint", "order_modify", "general", "other"];
    if (issue_type && !validTypes.includes(issue_type)) {
      return res.status(400).json({ message: "Invalid issue type" });
    }
    storage.updateContactIssueType(id, issue_type || null);
    broadcastSSE("contacts_updated", { contact_id: id });
    return res.json({ success: true });
  });

  app.get("/api/contacts/:id/ai-logs", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const logs = storage.getAiLogs(id);
    return res.json(logs);
  });

  app.post("/api/contacts/:id/transfer-human", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const { reason } = req.body;
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const transferReason = reason || "管理員手動轉接";
    storage.updateContactStatus(contactId, "awaiting_human");
    storage.updateContactHumanFlag(contactId, 1);
    storage.updateContactAssignmentStatus(contactId, "waiting_human");
    storage.createCaseNotification(contactId, "in_app");
    const assignedAgentId = assignment.assignCase(contactId);
    if (assignedAgentId == null && assignment.isAllAgentsUnavailable()) {
      storage.updateContactNeedsAssignment(contactId, 1);
      const tags = JSON.parse(contact.tags || "[]");
      if (!tags.includes("午休待處理")) storage.updateContactTags(contactId, [...tags, "午休待處理"]);
      const reason = assignment.getUnavailableReason();
      storage.createMessage(contactId, contact.platform, "system", getTransferUnavailableSystemMessage(reason));
    }
    const muteUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    storage.setAiMutedUntil(contactId, muteUntil);
    storage.createSystemAlert({ alert_type: "transfer", details: transferReason, brand_id: contact.brand_id || undefined, contact_id: contactId });
    broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
    broadcastSSE("new_message", { contact_id: contactId });
    console.log(`[Transfer] contact ${contactId} 已轉人工，原因: ${transferReason}${assignedAgentId != null ? `，已分配客服 ${assignedAgentId}` : "，待分配（全員忙碌）"}`);
    return res.json({ success: true, status: assignedAgentId != null ? "assigned" : "awaiting_human", reason: transferReason, assigned_agent_id: assignedAgentId ?? undefined, all_busy: assignedAgentId == null && assignment.isAllAgentsUnavailable() });
  });

  app.post("/api/contacts/:id/restore-ai", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    storage.updateContactStatus(contactId, "ai_handling");
    storage.updateContactHumanFlag(contactId, 0);
    storage.clearAiMuted(contactId);
    storage.resetConsecutiveTimeouts(contactId);
    broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
    console.log(`[Restore AI] contact ${contactId} 已恢復 AI 接管`);
    return res.json({ success: true, status: "ai_handling" });
  });

  app.post("/api/contacts/:id/send-rating", authMiddleware, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
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
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ message: "tags must be an array" });
    storage.updateContactTags(id, tags);
    return res.json({ success: true });
  });

  app.put("/api/contacts/:id/agent-flag", authMiddleware, (req: any, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "未登入" });
    const { flag } = req.body || {};
    const v = flag === "later" || flag === "tracking" ? flag : null;
    if (flag !== undefined && flag !== null && v === null) return res.status(400).json({ message: "flag 須為 'later'、'tracking' 或 null" });
    storage.setAgentContactFlag(userId, id, v);
    return res.json({ success: true, flag: v });
  });

  app.put("/api/contacts/:id/pinned", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
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
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const sinceId = parseInt(req.query.since_id as string) || 0;
    if (sinceId > 0) return res.json(storage.getMessagesSince(contactId, sinceId));
    return res.json(storage.getMessages(contactId));
  });

  app.post("/api/contacts/:id/messages", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const { content, message_type, image_url } = req.body;
    if (!content && !image_url) return res.status(400).json({ message: "content or image_url is required" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const msgType = message_type || "text";
    const message = storage.createMessage(contactId, contact.platform, "admin", content || "", msgType, image_url || null);
    storage.updateContactLastHumanReply(contactId);
    broadcastSSE("new_message", { contact_id: contactId, message, brand_id: contact.brand_id });
    broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
    storage.updateContactHumanFlag(contactId, 1);

    const muteUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    storage.setAiMutedUntil(contactId, muteUntil);
    console.log(`[Hard Mute] 管理員傳訊給 contact ${contactId}, AI 靜音至 ${muteUntil}`);

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
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
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

  app.post("/api/contacts/:id/link-order", authMiddleware, (req: any, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const orderId = (req.body?.order_id as string)?.trim();
    if (!orderId) return res.status(400).json({ message: "請提供 order_id" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    try {
      db.prepare(
        "INSERT OR IGNORE INTO contact_order_links (contact_id, global_order_id, source) VALUES (?, ?, 'manual')"
      ).run(contactId, orderId.toUpperCase());
      return res.json({ ok: true });
    } catch (e: any) {
      console.error("[link-order]", e);
      return res.status(500).json({ message: e?.message || "寫入失敗" });
    }
  });

  app.get("/api/contacts/:id/linked-orders", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const rows = db.prepare("SELECT global_order_id FROM contact_order_links WHERE contact_id = ? ORDER BY created_at DESC")
      .all(contactId) as { global_order_id: string }[];
    return res.json({ order_ids: rows.map((r) => r.global_order_id) });
  });

  app.get("/api/orders/linked-contacts", authMiddleware, (req, res) => {
    const raw = (req.query.order_ids as string) || "";
    const orderIds = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (orderIds.length === 0) return res.json({});
    const placeholders = orderIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT global_order_id, contact_id FROM contact_order_links WHERE global_order_id IN (${placeholders})`
    ).all(...orderIds) as { global_order_id: string; contact_id: number }[];
    const map: Record<string, number> = {};
    for (const r of rows) {
      if (map[r.global_order_id] == null) map[r.global_order_id] = r.contact_id;
    }
    const result: Record<string, number | null> = {};
    for (const id of orderIds) result[id] = map[id] ?? null;
    return res.json(result);
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

  async function downloadLineContent(messageId: string, fallbackExt: string, channelAccessToken?: string | null): Promise<string | null> {
    const token = channelAccessToken || storage.getSetting("line_channel_access_token");
    if (!token) {
      console.error("[downloadLineContent] No token available for messageId:", messageId);
      return null;
    }
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
          headers: { "Authorization": `Bearer ${token}` },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          console.error(`[downloadLineContent] Attempt ${attempt}/${maxRetries} failed: HTTP ${resp.status} - ${errText} (msgId: ${messageId})`);
          if (resp.status === 404 || resp.status === 401 || resp.status === 403) break;
          if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
          return null;
        }
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
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
        console.log(`[downloadLineContent] Success: ${filename} (${buffer.length} bytes, attempt ${attempt})`);
        return `/uploads/${filename}`;
      } catch (err: any) {
        console.error(`[downloadLineContent] Attempt ${attempt}/${maxRetries} error (msgId: ${messageId}):`, err.name === "AbortError" ? "Request timed out (15s)" : err.message);
        if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
        return null;
      }
    }
    return null;
  }

  async function downloadExternalImage(imageUrl: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(imageUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) {
        console.error(`[downloadExternalImage] Failed: HTTP ${resp.status} for ${imageUrl}`);
        return null;
      }
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const contentType = resp.headers.get("content-type") || "image/jpeg";
      const extMap: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };
      const ext = extMap[contentType] || ".jpg";
      const buffer = Buffer.from(await resp.arrayBuffer());
      const filename = `fb-${Date.now()}-${crypto.randomUUID()}${ext}`;
      const filePath = path.join(uploadDir, filename);
      fs.writeFileSync(filePath, buffer);
      console.log(`[downloadExternalImage] Success: ${filename} (${buffer.length} bytes)`);
      return `/uploads/${filename}`;
    } catch (err: any) {
      console.error("[downloadExternalImage] Error:", err.name === "AbortError" ? "Request timed out (15s)" : err.message);
      return null;
    }
  }

  function imageFileToDataUri(imageFilePath: string): string | null {
    try {
      const absPath = path.join(getDataDir(), imageFilePath.startsWith("/") ? imageFilePath.slice(1) : imageFilePath);
      if (!fs.existsSync(absPath)) return null;
      const imageBuffer = fs.readFileSync(absPath);
      const ext = path.extname(absPath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
    } catch (_e) {
      return null;
    }
  }

  async function analyzeImageWithAI(imageFilePath: string, contactId: number, lineToken?: string | null, platform?: string) {
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") return;
    const contactPlatform = platform || "line";
    try {
      const currentImageDataUri = imageFileToDataUri(imageFilePath);
      if (!currentImageDataUri) {
        console.error("Cannot read image file for AI analysis:", imageFilePath);
        return;
      }

      const contact = storage.getContact(contactId);
      let systemPrompt = await getEnrichedSystemPrompt(contact?.brand_id || undefined);
      systemPrompt += "\n\n【圖片處理指引】如果你收到了圖片，請仔細觀察圖片內容。若是商品瑕疵或損壞照片，請先安撫客戶情緒，表示重視，並啟動轉接真人客服機制(呼叫 transfer_to_human 工具)；若是訂單截圖，請嘗試從圖中辨識訂單編號、手機號碼等資訊並協助查詢；若是其他內容，請根據圖片給予適當的客服回覆。";

      const recentMessages = storage.getMessages(contactId).slice(-15);
      const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
      ];
      let currentImageIncluded = false;
      for (const msg of recentMessages) {
        if (msg.sender_type === "user") {
          if (msg.message_type === "image" && msg.image_url) {
            const msgDataUri = imageFileToDataUri(msg.image_url);
            if (msgDataUri) {
              if (msg.image_url === imageFilePath || msg.image_url.endsWith(imageFilePath.split("/").pop() || "")) {
                currentImageIncluded = true;
              }
              chatMessages.push({ role: "user", content: [
                { type: "text", text: msg.content || "客戶傳送了圖片" },
                { type: "image_url", image_url: { url: msgDataUri } },
              ]});
            } else {
              chatMessages.push({ role: "user", content: msg.content });
            }
          } else {
            chatMessages.push({ role: "user", content: msg.content });
          }
        } else if (msg.sender_type === "ai") {
          chatMessages.push({ role: "assistant", content: msg.content });
        }
      }
      if (!currentImageIncluded) {
        chatMessages.push({ role: "user", content: [
          { type: "text", text: "客戶傳送了圖片" },
          { type: "image_url", image_url: { url: currentImageDataUri } },
        ]});
      }

      const effectiveBrandId = contact?.brand_id;
      const hasImageAssets = storage.getImageAssets(effectiveBrandId || undefined).length > 0;
      const allTools = [...orderLookupTools, ...humanHandoffTools, ...(hasImageAssets ? imageTools : [])];

      const openai = new OpenAI({ apiKey });
      let completion = await openai.chat.completions.create({
        model: getOpenAIModel(),
        messages: chatMessages,
        tools: allTools,
        max_completion_tokens: 1000,
        temperature: 0.7,
      });

      let responseMessage = completion.choices[0]?.message;
      let loopCount = 0;
      while (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0 && loopCount < 3) {
        loopCount++;
        chatMessages.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);
        for (const toolCall of responseMessage.tool_calls) {
          const fnName = toolCall.function.name;
          let fnArgs: Record<string, string> = {};
          try { fnArgs = JSON.parse(toolCall.function.arguments); } catch (_e) {}
          const toolResult = await executeToolCall(fnName, fnArgs, {
            contactId: contactId,
            brandId: effectiveBrandId || undefined,
            channelToken: lineToken || undefined,
            platform: contactPlatform,
            platformUserId: contact?.platform_user_id || "",
          });
          chatMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
        }
        const freshContact = storage.getContact(contactId);
        if (freshContact?.needs_human) break;
        completion = await openai.chat.completions.create({
          model: getOpenAIModel(),
          messages: chatMessages,
          tools: allTools,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
        responseMessage = completion.choices[0]?.message;
      }

      const finalContact = storage.getContact(contactId);
      if (finalContact?.needs_human) return;

      const reply = responseMessage?.content || "已收到您的圖片，將為您進一步處理。";
      const aiMsg = storage.createMessage(contactId, contactPlatform, "ai", reply);
      broadcastSSE("new_message", { contact_id: contactId, message: aiMsg, brand_id: contact?.brand_id });
      broadcastSSE("contacts_updated", { brand_id: contact?.brand_id });

      if (contactPlatform === "messenger") {
        const fbToken = contact?.channel_id ? storage.getChannel(contact.channel_id)?.access_token : null;
        if (fbToken) await sendFBMessage(fbToken, contact!.platform_user_id, reply);
      } else {
        const token = lineToken || getLineTokenForContact(contact || {});
        if (token && contact) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: reply }], token);
        }
      }
    } catch (err) {
      console.error("OpenAI Vision analysis error:", err);
      storage.createMessage(contactId, contactPlatform, "ai", "已收到您的圖片，將為您轉交專人檢視。");
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

    const freshCheck = storage.getContact(contact.id);
    if (freshCheck && (freshCheck.status === "awaiting_human" || freshCheck.status === "high_risk")) {
      console.log(`[AI Mute] Contact ${contact.id} status=${freshCheck.status}, AI 靜音中 - 跳過`);
      return;
    }
    if (freshCheck && freshCheck.needs_human) {
      console.log(`[AI Mute] Contact ${contact.id} needs_human=1, AI 靜音中 - 跳過`);
      return;
    }
    if (storage.isAiMuted(contact.id)) {
      console.log(`[AI Mute] Contact ${contact.id} 靜音窗尚未結束 - 跳過`);
      return;
    }

    const startTime = Date.now();
    const toolsCalled: string[] = [];
    let transferTriggered = false;
    let transferReason: string | undefined;
    let totalTokens = 0;
    let orderLookupFailed = 0;

    try {
      const effectiveBrandId = contact.brand_id || brandId;

      storage.updateContactStatus(contact.id, "ai_handling");
      broadcastSSE("contacts_updated", { brand_id: contact.brand_id });

      const riskCheck = detectHighRisk(userMessage);
      if (riskCheck.isHighRisk) {
        console.log(`[AI Risk] 高風險訊息偵測: ${riskCheck.reasons.join(", ")}`);
        storage.updateContactStatus(contact.id, "high_risk");
        storage.updateContactHumanFlag(contact.id, 1);
        storage.createMessage(contact.id, contact.platform, "system",
          `(系統提示) 偵測到高風險訊息，已自動標記並轉接真人客服。原因：${riskCheck.reasons.join("、")}`);
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });

        storage.createAiLog({
          contact_id: contact.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: `高風險偵測: ${userMessage.slice(0, 100)}`,
          knowledge_hits: [],
          tools_called: [],
          transfer_triggered: true,
          transfer_reason: `高風險關鍵字: ${riskCheck.reasons.join(", ")}`,
          result_summary: "高風險自動轉人工",
          token_usage: 0,
          model: "risk-detection",
          response_time_ms: Date.now() - startTime,
        });
        return;
      }

      // 共用安全確認分流：非本店／他平台／詐騙／待確認來源 → 私訊走安全模板，不進標準售後承諾
      const safeConfirmDm = classifyMessageForSafeAfterSale(userMessage);
      if (safeConfirmDm.matched) {
        const categoryByType: Record<string, string> = {
          fraud_impersonation: "fraud_impersonation",
          external_platform: "external_platform_order",
          safe_confirm_order: "safe_confirm_order",
        };
        const tplCategory = categoryByType[safeConfirmDm.type];
        const tpl = metaCommentsStorage.getMetaCommentTemplateByCategory(contact.brand_id ?? undefined, tplCategory);
        const pageList = metaCommentsStorage.getMetaPageSettingsList(contact.brand_id ?? undefined);
        const rawLine = (pageList[0]?.line_after_sale ?? "").trim();
        const lineUrl = rawLine || FALLBACK_AFTER_SALE_LINE_LABEL;
        if (!rawLine) {
          console.warn("[SafeAfterSale] 售後 LINE 未設定（待補資料）", { contact_id: contact.id, brand_id: contact.brand_id });
        }
        const replyTextRaw = (tpl as any)?.reply_private || tpl?.reply_first || "";
        const replyText = replyTextRaw.replace(/\{after_sale_line_url\}/g, lineUrl).trim();
        if (replyText) {
          const contactPlatform = platform || contact.platform || "line";
          const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", replyText);
          broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: contact.brand_id });
          broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
          if (contactPlatform === "messenger" && channelToken) {
            await sendFBMessage(channelToken, contact.platform_user_id, replyText);
          } else if (channelToken) {
            await pushLineMessage(contact.platform_user_id, [{ type: "text", text: replyText }], channelToken);
          }
          if (safeConfirmDm.suggest_human) {
            storage.updateContactStatus(contact.id, "awaiting_human");
            storage.updateContactHumanFlag(contact.id, 1);
            storage.createCaseNotification(contact.id, "in_app");
            broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
          }
          const recentForCaption = storage.getMessages(contact.id).slice(-6);
          const hadRecentImage = recentForCaption.some(
            (m: { sender_type: string; message_type?: string; content?: string }) =>
              m.sender_type === "user" && (m.message_type === "image" || m.content === "[圖片訊息]" || (m.content && m.content.startsWith("[圖片")))
          );
          const resultSummary = hadRecentImage
            ? `safe_confirm_template: ${tplCategory} | image_clear_caption`
            : `safe_confirm_template: ${tplCategory}`;
          storage.createAiLog({
            contact_id: contact.id,
            message_id: aiMsg.id,
            brand_id: effectiveBrandId || undefined,
            prompt_summary: userMessage.slice(0, 150),
            knowledge_hits: [],
            tools_called: ["safe_confirm_template"],
            transfer_triggered: safeConfirmDm.suggest_human,
            transfer_reason: safeConfirmDm.suggest_human ? `安全確認分流(${safeConfirmDm.type})` : undefined,
            result_summary: resultSummary,
            token_usage: 0,
            model: "safe-after-sale-classifier",
            response_time_ms: Date.now() - startTime,
          });
        }
        return;
      }

      // 圖片＋極短／模糊文字：不當成已確認情境，先回補充模板（不進一般 AI 售後承諾）
      const recentMsgs = storage.getMessages(contact.id).slice(-8);
      const hasRecentImageFromUser = recentMsgs.some(
        (m: { sender_type: string; message_type?: string; content?: string }) =>
          m.sender_type === "user" && (m.message_type === "image" || m.content === "[圖片訊息]" || (m.content && m.content.startsWith("[圖片")))
      );
      if (hasRecentImageFromUser && isShortOrAmbiguousImageCaption(userMessage)) {
        const escalate = shouldEscalateImageSupplement(recentMsgs);
        const replyText = escalate ? IMAGE_SUPPLEMENT_ESCALATE_MESSAGE : getImageDmReplyForShortCaption(userMessage);
        const templateName = getImageDmTemplateNameForShortCaption(userMessage);
        const contactPlatform = platform || contact.platform || "line";
        const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", replyText);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, replyText);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: replyText }], channelToken);
        }
        if (escalate) {
          storage.updateContactStatus(contact.id, "awaiting_human");
          storage.updateContactHumanFlag(contact.id, 1);
          storage.createCaseNotification(contact.id, "in_app");
          broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        }
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsg.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: userMessage.slice(0, 150),
          knowledge_hits: [],
          tools_called: ["image_dm_short_caption"],
          transfer_triggered: escalate,
          transfer_reason: escalate ? "連續無效圖片補充升級人工" : undefined,
          result_summary: escalate ? `image_short_caption | escalated_awaiting_human` : `image_short_caption | ${templateName}`,
          token_usage: 0,
          model: "safe-after-sale-classifier",
          response_time_ms: Date.now() - startTime,
        });
        return;
      }

      if (detectReturnRefund(userMessage)) {
        if (!contact.issue_type || contact.issue_type !== "return_refund") {
          storage.updateContactIssueType(contact.id, "return_refund");
        }
      }

      const recentUserMsgs = storage.getMessages(contact.id)
        .filter(m => m.sender_type === "user")
        .map(m => m.content);
      const detectedIssue = detectIssueType(recentUserMsgs);
      if (detectedIssue && !contact.issue_type) {
        storage.updateContactIssueType(contact.id, detectedIssue);
      }

      const intentLevel = detectIntentLevel(userMessage, recentUserMsgs);
      storage.updateContactIntentLevel(contact.id, intentLevel);
      const trimmed = userMessage.trim();
      if (/^[\w\-]{5,}$/.test(trimmed) || (/\d{5,}/.test(trimmed) && trimmed.length <= 25)) {
        const orderType = classifyOrderNumber(trimmed);
        storage.updateContactOrderNumberType(contact.id, orderType);
      }
      const currentTags: string[] = JSON.parse(contact.tags || "[]");
      const suggested = suggestTagsFromContent(userMessage, currentTags);
      if (suggested.length > 0) {
        const merged = [...new Set([...currentTags, ...suggested])];
        storage.updateContactTags(contact.id, merged);
      }
      const priority = computeCasePriority(intentLevel, [...currentTags, ...suggested]);
      storage.updateContactCasePriority(contact.id, priority);

      const systemPrompt = await getEnrichedSystemPrompt(contact.brand_id || brandId || undefined);
      const openai = new OpenAI({ apiKey });

      const recentMessages = storage.getMessages(contact.id).slice(-20);
      const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
      ];
      const knowledgeHits: string[] = [];

      for (const msg of recentMessages) {
        if (msg.sender_type === "user") {
          if (msg.message_type === "image" && msg.image_url) {
            const msgDataUri = imageFileToDataUri(msg.image_url);
            if (msgDataUri) {
              chatMessages.push({ role: "user", content: [
                { type: "text", text: msg.content || "客戶傳送了圖片" },
                { type: "image_url", image_url: { url: msgDataUri } },
              ]});
            } else {
              chatMessages.push({ role: "user", content: msg.content });
            }
          } else {
            chatMessages.push({ role: "user", content: msg.content });
          }
        } else if (msg.sender_type === "ai") {
          chatMessages.push({ role: "assistant", content: msg.content });
        }
      }

      const hasImageAssets = storage.getImageAssets(effectiveBrandId || undefined).length > 0;
      const allTools = [...orderLookupTools, ...humanHandoffTools, ...(hasImageAssets ? imageTools : [])];

      const AI_TIMEOUT_MS = 15000;
      const TOOL_TIMEOUT_MS = 12000;

      async function callOpenAIWithTimeout(params: Parameters<typeof openai.chat.completions.create>[0]) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
        try {
          const result = await openai.chat.completions.create(params, { signal: controller.signal as any });
          return result;
        } finally {
          clearTimeout(timer);
        }
      }

      async function callToolWithTimeout(fnName: string, fnArgs: Record<string, string>, ctx: any) {
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("TOOL_TIMEOUT")), TOOL_TIMEOUT_MS);
          executeToolCall(fnName, fnArgs, ctx).then(result => {
            clearTimeout(timer);
            resolve(result);
          }).catch(err => {
            clearTimeout(timer);
            reject(err);
          });
        });
      }

      let completion;
      try {
        completion = await callOpenAIWithTimeout({
          model: getOpenAIModel(),
          messages: chatMessages,
          tools: allTools,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
      } catch (timeoutErr: any) {
        if (timeoutErr?.name === "AbortError" || timeoutErr?.message?.includes("abort")) {
          console.log(`[AI Timeout] OpenAI 推理超時 (>${AI_TIMEOUT_MS}ms) - contact ${contact.id}`);
          const timeoutCount = storage.incrementConsecutiveTimeouts(contact.id);
          storage.createSystemAlert({ alert_type: "timeout_escalation", details: `OpenAI 推理超時 (第${timeoutCount}次)`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
          if (timeoutCount >= 2) {
            storage.updateContactStatus(contact.id, "awaiting_human");
            storage.updateContactHumanFlag(contact.id, 1);
            const comfortMsg = "不好意思，系統目前處理較慢，我已為您轉接專人客服，請稍候片刻。";
            storage.createMessage(contact.id, contact.platform, "ai", comfortMsg);
            if (platform === "messenger") {
              sendFBMessage(channelToken || "", contact.platform_user_id, comfortMsg).catch(() => {});
            } else if (channelToken) {
              pushLineMessage(contact.platform_user_id, [{ type: "text", text: comfortMsg }], channelToken).catch(() => {});
            }
            broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
          } else {
            const comfortMsg = "不好意思，讓您稍等了一下！請問您方便再提供一次您的問題嗎？例如訂單編號或商品名稱，我馬上幫您查詢。";
            storage.createMessage(contact.id, contact.platform, "ai", comfortMsg);
            if (platform === "messenger") {
              sendFBMessage(channelToken || "", contact.platform_user_id, comfortMsg).catch(() => {});
            } else if (channelToken) {
              pushLineMessage(contact.platform_user_id, [{ type: "text", text: comfortMsg }], channelToken).catch(() => {});
            }
            broadcastSSE("new_message", { contact_id: contact.id, brand_id: contact.brand_id });
          }
          return;
        }
        throw timeoutErr;
      }

      totalTokens += completion.usage?.total_tokens || 0;

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
          try { fnArgs = JSON.parse(toolCall.function.arguments); } catch (_e) {}

          toolsCalled.push(fnName);
          console.log(`[Webhook AI] 執行 Tool: ${fnName}，參數:`, fnArgs);

          let toolResult: string;
          try {
            toolResult = await callToolWithTimeout(fnName, fnArgs, {
              contactId: contact.id,
              brandId: effectiveBrandId || undefined,
              channelToken: channelToken || undefined,
              platform: contact.platform,
              platformUserId: contact.platform_user_id,
            });
          } catch (toolErr: any) {
            if (toolErr?.message === "TOOL_TIMEOUT") {
              console.log(`[AI Timeout] 工具 ${fnName} 超時 (>${TOOL_TIMEOUT_MS}ms)`);
              storage.createSystemAlert({ alert_type: "timeout_escalation", details: `工具 ${fnName} 超時`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
              toolResult = JSON.stringify({ error: true, message: "工具查詢超時，請稍後再試" });
            } else {
              throw toolErr;
            }
          }

          chatMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });

          if (fnName === "transfer_to_human") {
            transferTriggered = true;
            transferReason = fnArgs.reason || "AI 判斷需要人工處理";
            storage.updateContactStatus(contact.id, "awaiting_human");
            storage.updateContactHumanFlag(contact.id, 1);
            storage.updateContactAssignmentStatus(contact.id, "waiting_human");
            storage.createCaseNotification(contact.id, "in_app");
            const assignedId = assignment.assignCase(contact.id);
            if (assignedId == null && assignment.isAllAgentsUnavailable()) {
              storage.updateContactNeedsAssignment(contact.id, 1);
              const tags = JSON.parse(contact.tags || "[]");
              if (!tags.includes("午休待處理")) {
                storage.updateContactTags(contact.id, [...tags, "午休待處理"]);
              }
              const reason = assignment.getUnavailableReason();
              storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(reason));
            }
            storage.createSystemAlert({ alert_type: "transfer", details: transferReason, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
            const freshContact = storage.getContact(contact.id);
            if (freshContact?.needs_human) {
              console.log(`[Webhook AI] transfer_to_human 已觸發，停止 AI 回覆迴圈`);
            }
          }

          if (fnName.includes("lookup_order")) {
            try {
              const parsed = JSON.parse(toolResult);
              if (parsed.found === false) {
                orderLookupFailed++;
                const orderSource = parsed.source || "unknown";
                storage.createSystemAlert({ alert_type: "order_lookup_fail", details: `查單失敗 (${orderSource})`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
              }
              if (parsed.found === true && !contact.issue_type) {
                storage.updateContactIssueType(contact.id, "order_inquiry");
              }
            } catch (_e) {}
          }
        }

        if (orderLookupFailed >= 2 && !transferTriggered) {
          console.log(`[AI Risk] 多次查單失敗(${orderLookupFailed}次)，自動升級為待人工`);
          storage.updateContactStatus(contact.id, "awaiting_human");
          storage.updateContactHumanFlag(contact.id, 1);
          storage.createCaseNotification(contact.id, "in_app");
          storage.updateContactAssignmentStatus(contact.id, "waiting_human");
          const assignedOrder = assignment.assignCase(contact.id);
          if (assignedOrder == null && assignment.isAllAgentsUnavailable()) {
            storage.updateContactNeedsAssignment(contact.id, 1);
            const tags = JSON.parse(contact.tags || "[]");
            if (!tags.includes("午休待處理")) storage.updateContactTags(contact.id, [...tags, "午休待處理"]);
            const reason = assignment.getUnavailableReason();
            storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(reason));
          }
          transferTriggered = true;
          transferReason = `多次查單失敗(${orderLookupFailed}次)`;
          storage.createSystemAlert({ alert_type: "transfer", details: transferReason, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
        }

        if (loopCount >= maxToolLoops && !transferTriggered) {
          console.log(`[AI Risk] 達到最大工具呼叫次數(${maxToolLoops})，標記待人工`);
          storage.updateContactStatus(contact.id, "awaiting_human");
          storage.updateContactHumanFlag(contact.id, 1);
          storage.createCaseNotification(contact.id, "in_app");
          storage.updateContactAssignmentStatus(contact.id, "waiting_human");
          const assignedLoop = assignment.assignCase(contact.id);
          if (assignedLoop == null && assignment.isAllAgentsUnavailable()) {
            storage.updateContactNeedsAssignment(contact.id, 1);
            const tags = JSON.parse(contact.tags || "[]");
            if (!tags.includes("午休待處理")) storage.updateContactTags(contact.id, [...tags, "午休待處理"]);
            const reason = assignment.getUnavailableReason();
            storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(reason));
          }
          transferTriggered = true;
          transferReason = `AI 多輪工具呼叫未能解決(${loopCount}輪)`;
          storage.createSystemAlert({ alert_type: "transfer", details: transferReason, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
        }

        const freshContact = storage.getContact(contact.id);
        if (freshContact?.needs_human) break;

        try {
          completion = await callOpenAIWithTimeout({
            model: getOpenAIModel(),
            messages: chatMessages,
            tools: allTools,
            max_completion_tokens: 1000,
            temperature: 0.7,
          });
        } catch (loopTimeoutErr: any) {
          if (loopTimeoutErr?.name === "AbortError" || loopTimeoutErr?.message?.includes("abort")) {
            console.log(`[AI Timeout] OpenAI 工具迴圈推理超時 - contact ${contact.id}`);
            const loopTimeoutCount = storage.incrementConsecutiveTimeouts(contact.id);
            storage.createSystemAlert({ alert_type: "timeout_escalation", details: `工具迴圈推理超時 (第${loopTimeoutCount}次)`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
            if (loopTimeoutCount >= 2) {
              storage.updateContactStatus(contact.id, "awaiting_human");
              storage.updateContactHumanFlag(contact.id, 1);
              const comfortMsg = "不好意思，系統目前處理較慢，我已為您轉接專人客服，請稍候片刻。";
              storage.createMessage(contact.id, contact.platform, "ai", comfortMsg);
              if (platform === "messenger") {
                sendFBMessage(channelToken || "", contact.platform_user_id, comfortMsg).catch(() => {});
              } else if (channelToken) {
                pushLineMessage(contact.platform_user_id, [{ type: "text", text: comfortMsg }], channelToken).catch(() => {});
              }
              broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
            }
            break;
          }
          throw loopTimeoutErr;
        }
        totalTokens += completion.usage?.total_tokens || 0;
        responseMessage = completion.choices[0]?.message;
      }

      storage.resetConsecutiveTimeouts(contact.id);

      const finalContact = storage.getContact(contact.id);
      if (finalContact?.needs_human || storage.isAiMuted(contact.id) || finalContact?.status === "awaiting_human" || finalContact?.status === "high_risk") {
        console.log(`[Webhook AI] 已轉接真人或靜音中，跳過 AI 回覆 (needs_human=${finalContact?.needs_human}, status=${finalContact?.status})`);
        storage.createAiLog({
          contact_id: contact.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: userMessage.slice(0, 200),
          knowledge_hits: knowledgeHits,
          tools_called: toolsCalled,
          transfer_triggered: true,
          transfer_reason: transferReason,
          result_summary: "轉接真人客服",
          token_usage: totalTokens,
          model: getOpenAIModel(),
          response_time_ms: Date.now() - startTime,
        });
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

        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsg.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: userMessage.slice(0, 200),
          knowledge_hits: knowledgeHits,
          tools_called: toolsCalled,
          transfer_triggered: transferTriggered,
          transfer_reason: transferReason,
          result_summary: reply.slice(0, 300),
          token_usage: totalTokens,
          model: getOpenAIModel(),
          response_time_ms: Date.now() - startTime,
        });
      }
    } catch (err) {
      console.error("[Webhook AI] 自動回覆失敗:", err);
      storage.createAiLog({
        contact_id: contact.id,
        brand_id: contact.brand_id || brandId || undefined,
        prompt_summary: userMessage.slice(0, 200),
        knowledge_hits: [],
        tools_called: toolsCalled,
        transfer_triggered: false,
        result_summary: `錯誤: ${(err as Error).message}`,
        token_usage: totalTokens,
        model: getOpenAIModel(),
        response_time_ms: Date.now() - startTime,
      });
    }
  }

  app.post("/api/webhook/line", async (req, res) => {
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
        console.log("[WEBHOOK] 不 fallback，無法確認渠道時不進行自動回覆（fail-closed）");
      }
    } else {
      console.log("[WEBHOOK] No destination field in webhook body");
      console.log("[WEBHOOK] 無 destination，視為未匹配 channel，不自動回覆（fail-closed）");
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
          console.log("[WEBHOOK] SIGNATURE MISMATCH - rejecting request. Expected:", hash, "Got:", signature);
          storage.createSystemAlert({ alert_type: "webhook_sig_fail", details: "LINE signature mismatch", brand_id: matchedBrandId || undefined });
          return res.status(403).json({ message: "Invalid signature" });
        }
        console.log("[WEBHOOK] Signature verified OK");
      } catch (sigErr: any) {
        console.log("[WEBHOOK] Signature check error:", sigErr.message);
        storage.createSystemAlert({ alert_type: "webhook_sig_fail", details: `LINE sig error: ${sigErr.message}`, brand_id: matchedBrandId || undefined });
        return res.status(403).json({ message: "Signature verification failed" });
      }
    } else if (channelSecretVal && !signature) {
      console.log("[WEBHOOK] Missing x-line-signature header - rejecting");
      storage.createSystemAlert({ alert_type: "webhook_sig_fail", details: "LINE missing signature header", brand_id: matchedBrandId || undefined });
      return res.status(403).json({ message: "Missing signature" });
    } else {
      console.log("[WEBHOOK] Skipping signature check - no channel_secret configured");
    }

    res.status(200).json({ success: true });
    console.log("[WEBHOOK] Sent 200 OK to LINE (ACK < 2s), processing events async...");

    const humanKeywordsSetting = storage.getSetting("human_transfer_keywords");
    const HUMAN_KEYWORDS = humanKeywordsSetting
      ? humanKeywordsSetting.split(",").map((k) => k.trim()).filter(Boolean)
      : ["找客服", "真人", "轉人工", "人工客服", "真人客服"];

    async function fetchAndUpdateLineProfile(userId: string, contactId: number, token: string | null) {
      if (!token || userId === "unknown") return;
      try {
        const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (profileRes.ok) {
          const profile = await profileRes.json() as { displayName?: string; pictureUrl?: string };
          if (profile.displayName) {
            storage.updateContactProfile(contactId, profile.displayName, profile.pictureUrl || null);
            console.log("[WEBHOOK] Profile updated:", profile.displayName, profile.pictureUrl ? "(has avatar)" : "(no avatar)");
          }
        } else {
          console.log("[WEBHOOK] Profile fetch failed:", profileRes.status);
        }
      } catch (err: any) {
        console.log("[WEBHOOK] Profile fetch error:", err.message);
      }
    }

    const GHOST_REPLY_TOKEN = "00000000000000000000000000000000";
    const GHOST_USER_ID = "Udeadbeefdeadbeefdeadbeefdeadbeef";

    const events = req.body?.events || [];
    (async () => {
    for (const event of events) {
      if (event.replyToken === GHOST_REPLY_TOKEN || event.source?.userId === GHOST_USER_ID) {
        console.log("[WEBHOOK] Skipping ghost/verification event");
        continue;
      }

      const webhookEventId = event.webhookEventId || event.timestamp?.toString();
      if (webhookEventId && storage.isEventProcessed(webhookEventId)) {
        console.log("[WEBHOOK] Skipping duplicate event:", webhookEventId);
        storage.createSystemAlert({ alert_type: "dedupe_hit", details: `LINE event ${webhookEventId}`, brand_id: matchedBrandId || undefined });
        continue;
      }
      if (webhookEventId) {
        storage.markEventProcessed(webhookEventId);
      }

      try {
        console.log("[WEBHOOK] Processing event:", event.type, event.message?.type || "", "from:", event.source?.userId || "unknown");
        if (event.type === "message" && event.message?.type === "text") {
          const userId = event.source?.userId || "unknown";
          const text = event.message.text;
          console.log("[WEBHOOK] Text message from", userId, ":", text.substring(0, 50));
          const contact = storage.getOrCreateContact("line", userId, "LINE用戶", matchedBrandId, matchedChannel?.id);
          if (contact.display_name === "LINE用戶" || !contact.avatar_url) {
            fetchAndUpdateLineProfile(userId, contact.id, channelToken).catch(() => {});
          }
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
            const aiEnabled = matchedChannel ? matchedChannel.is_ai_enabled : 0;
            if (!aiEnabled) {
              if (!matchedChannel) console.log("[WEBHOOK] 無匹配 channel，跳過文字自動回覆（fail-closed）");
              else console.log("[WEBHOOK] AI 已關閉 (channel:", matchedChannel.channel_name, ") - 跳過自動回覆");
            } else {
              const testMode = storage.getSetting("test_mode");
              if (testMode === "true") {
                storage.createMessage(contact.id, "line", "ai", `[測試模式] 收到您的訊息：「${text}」。`);
              } else {
                debounceTextMessage(contact.id, text, (mergedText) =>
                  withContactLock(contact.id, () =>
                    autoReplyWithAI(contact, mergedText, channelToken, matchedBrandId)
                  )
                );
              }
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
          const contact = storage.getOrCreateContact("line", userId, "LINE用戶", matchedBrandId, matchedChannel?.id);
          if (contact.display_name === "LINE用戶" || !contact.avatar_url) {
            fetchAndUpdateLineProfile(userId, contact.id, channelToken).catch(() => {});
          }
          const messageId = event.message.id;
          const imageUrl = await downloadLineContent(messageId, ".jpg", channelToken);
          if (imageUrl) {
            const imgMsg = storage.createMessage(contact.id, "line", "user", "[圖片訊息]", "image", imageUrl);
            broadcastSSE("new_message", { contact_id: contact.id, message: imgMsg, brand_id: matchedBrandId || contact.brand_id });
            broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
            const aiEnabledImg = matchedChannel ? matchedChannel.is_ai_enabled : 0;
            if (!matchedChannel && !contact.needs_human) console.log("[WEBHOOK] 無匹配 channel，跳過圖片自動回覆（fail-closed）");
            if (!contact.needs_human && aiEnabledImg) {
              const recentMsgsForEscalate = storage.getMessages(contact.id).slice(-8);
              const escalate = shouldEscalateImageSupplement(recentMsgsForEscalate);
              const replyText = escalate ? IMAGE_SUPPLEMENT_ESCALATE_MESSAGE : SAFE_IMAGE_ONLY_REPLY;
              const aiMsg = storage.createMessage(contact.id, "line", "ai", replyText);
              broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: matchedBrandId || contact.brand_id });
              broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
              await pushLineMessage(contact.platform_user_id, [{ type: "text", text: replyText }], channelToken);
              if (escalate) {
                storage.updateContactStatus(contact.id, "awaiting_human");
                storage.updateContactHumanFlag(contact.id, 1);
                storage.createCaseNotification(contact.id, "in_app");
                broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
              }
              storage.createAiLog({
                contact_id: contact.id,
                message_id: aiMsg.id,
                brand_id: matchedBrandId || contact.brand_id || undefined,
                prompt_summary: "[圖片訊息]",
                knowledge_hits: [],
                tools_called: ["image_dm_only"],
                transfer_triggered: escalate,
                transfer_reason: escalate ? "連續無效圖片補充升級人工" : undefined,
                result_summary: escalate ? "image_only | escalated_awaiting_human" : "image_only | IMAGE_DM_GENERIC",
                token_usage: 0,
                model: "safe-after-sale-classifier",
                response_time_ms: 0,
              });
            }
          } else {
            storage.createMessage(contact.id, "line", "user", "[圖片訊息] (下載失敗)");
          }
        } else if (event.type === "message" && event.message?.type === "video") {
          const userId = event.source?.userId || "unknown";
          const contact = storage.getOrCreateContact("line", userId, "LINE用戶", matchedBrandId, matchedChannel?.id);
          if (contact.display_name === "LINE用戶" || !contact.avatar_url) {
            fetchAndUpdateLineProfile(userId, contact.id, channelToken).catch(() => {});
          }
          const messageId = event.message.id;
          const videoUrl = await downloadLineContent(messageId, ".mp4", channelToken);
          if (videoUrl) {
            console.log("[影片處理成功]:", videoUrl);
            const vidMsg = storage.createMessage(contact.id, "line", "user", "[影片訊息]", "video", videoUrl);
            broadcastSSE("new_message", { contact_id: contact.id, message: vidMsg, brand_id: matchedBrandId || contact.brand_id });
            broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
          } else {
            console.log("[影片處理失敗]: messageId:", messageId);
            storage.createMessage(contact.id, "line", "user", "[影片訊息] (下載失敗)");
          }
          const aiEnabledVid = matchedChannel ? matchedChannel.is_ai_enabled : 0;
          if (contact.needs_human) {
            console.log("[WEBHOOK] 案件已轉人工(needs_human=1)，跳過影片固定回覆 contact_id=", contact.id);
          } else if (!aiEnabledVid) {
            if (!matchedChannel) console.log("[WEBHOOK] 無匹配 channel，跳過影片固定回覆（fail-closed）");
            else console.log("[WEBHOOK] AI 已關閉 (channel:", matchedChannel.channel_name, ") - 跳過影片回覆");
          } else {
            storage.createMessage(contact.id, "line", "ai", "(AI 系統提示) 已收到您的影片，將為您轉交專人檢視。");
            storage.updateContactHumanFlag(contact.id, 1);
            await pushLineMessage(contact.platform_user_id, [{ type: "text", text: "已收到您的影片，將為您轉交專人檢視。" }], channelToken);
          }
        } else if (event.type === "message" && event.message?.type !== "text") {
          const userId = event.source?.userId || "unknown";
          const contact = storage.getOrCreateContact("line", userId, "LINE用戶", matchedBrandId, matchedChannel?.id);
          if (contact.display_name === "LINE用戶" || !contact.avatar_url) {
            fetchAndUpdateLineProfile(userId, contact.id, channelToken).catch(() => {});
          }
          const msgType = event.message?.type || "unknown";
          storage.createMessage(contact.id, "line", "user", `[${msgType === "sticker" ? "貼圖" : msgType === "audio" ? "音訊" : msgType === "location" ? "位置" : msgType === "file" ? "檔案" : msgType}訊息]`);
        }
      } catch (err) {
        console.error("Webhook event processing error:", err);
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

  app.post("/api/webhook/facebook", (req, res) => {
    const body = req.body;
    if (body.object !== "page") {
      return res.status(404).json({ message: "Not a page event" });
    }

    const fbAppSecret = storage.getSetting("fb_app_secret");
    if (fbAppSecret && req.rawBody) {
      const fbSignature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!fbSignature) {
        console.log("[FB Webhook] Missing x-hub-signature-256 header - rejecting");
        return res.status(403).json({ message: "Missing signature" });
      }
      try {
        const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody as string);
        const expectedSig = "sha256=" + crypto.createHmac("sha256", fbAppSecret).update(rawBody).digest("hex");
        if (expectedSig !== fbSignature) {
          console.log("[FB Webhook] SIGNATURE MISMATCH - rejecting");
          storage.createSystemAlert({ alert_type: "webhook_sig_fail", details: "FB signature mismatch" });
          return res.status(403).json({ message: "Invalid signature" });
        }
        console.log("[FB Webhook] Signature verified OK");
      } catch (sigErr: any) {
        console.log("[FB Webhook] Signature check error:", sigErr.message);
        storage.createSystemAlert({ alert_type: "webhook_sig_fail", details: `FB sig error: ${sigErr.message}` });
        return res.status(403).json({ message: "Signature verification failed" });
      }
    }

    res.status(200).send("EVENT_RECEIVED");
    console.log("[FB Webhook] Sent 200 OK (ACK < 2s), processing events async...");

    const humanKeywordsSetting2 = storage.getSetting("human_transfer_keywords");
    const HUMAN_KW2 = humanKeywordsSetting2
      ? humanKeywordsSetting2.split(",").map((k: string) => k.trim()).filter(Boolean)
      : ["找客服", "真人", "轉人工", "人工客服", "真人客服"];

    (async () => {
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
        if (storage.isEventProcessed(eventId)) {
          storage.createSystemAlert({ alert_type: "dedupe_hit", details: `FB event ${eventId}`, brand_id: matchedBrandId || undefined });
          continue;
        }
        storage.markEventProcessed(eventId);

        try {
          if (messagingEvent.message) {
            const text = messagingEvent.message.text || "";
            const displayName = `FB用戶_${senderId.substring(0, 6)}`;
            const contact = storage.getOrCreateContact("messenger", senderId, displayName, matchedBrandId, matchedChannel?.id);

            if (messagingEvent.message.attachments) {
              for (const att of messagingEvent.message.attachments) {
                if (att.type === "image" && att.payload?.url) {
                  const localImageUrl = await downloadExternalImage(att.payload.url);
                  const finalUrl = localImageUrl || att.payload.url;
                  const imgMsg = storage.createMessage(contact.id, "messenger", "user", "[圖片訊息]", "image", finalUrl);
                  broadcastSSE("new_message", { contact_id: contact.id, message: imgMsg, brand_id: matchedBrandId || contact.brand_id });
                  const fbAiEnabledImg = matchedChannel ? matchedChannel.is_ai_enabled : 1;
                  if (!contact.needs_human && fbAiEnabledImg && matchedChannel?.access_token) {
                    const recentMsgsForEscalate = storage.getMessages(contact.id).slice(-8);
                    const escalate = shouldEscalateImageSupplement(recentMsgsForEscalate);
                    const replyText = escalate ? IMAGE_SUPPLEMENT_ESCALATE_MESSAGE : SAFE_IMAGE_ONLY_REPLY;
                    const aiMsg = storage.createMessage(contact.id, "messenger", "ai", replyText);
                    broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: matchedBrandId || contact.brand_id });
                    broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
                    sendFBMessage(matchedChannel.access_token, senderId, replyText).catch(err =>
                      console.error("[FB Webhook] 圖片安全回覆失敗:", err)
                    );
                    if (escalate) {
                      storage.updateContactStatus(contact.id, "awaiting_human");
                      storage.updateContactHumanFlag(contact.id, 1);
                      storage.createCaseNotification(contact.id, "in_app");
                      broadcastSSE("contacts_updated", { brand_id: matchedBrandId || contact.brand_id });
                    }
                    storage.createAiLog({
                      contact_id: contact.id,
                      message_id: aiMsg.id,
                      brand_id: matchedBrandId || contact.brand_id || undefined,
                      prompt_summary: "[圖片訊息]",
                      knowledge_hits: [],
                      tools_called: ["image_dm_only"],
                      transfer_triggered: escalate,
                      transfer_reason: escalate ? "連續無效圖片補充升級人工" : undefined,
                      result_summary: escalate ? "image_only | escalated_awaiting_human" : "image_only | IMAGE_DM_GENERIC",
                      token_usage: 0,
                      model: "safe-after-sale-classifier",
                      response_time_ms: 0,
                    });
                  }
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

              const needsHuman2 = HUMAN_KW2.some((kw: string) => text.includes(kw));
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
                const fbAiEnabled = matchedChannel ? matchedChannel.is_ai_enabled : 1;
                if (!fbAiEnabled) {
                  console.log("[FB WEBHOOK] AI 已關閉 (channel:", matchedChannel?.channel_name, ") - 跳過自動回覆");
                } else {
                  const testMode = storage.getSetting("test_mode");
                  if (testMode !== "true" && matchedChannel?.access_token) {
                    debounceTextMessage(contact.id, text, (mergedText) =>
                      withContactLock(contact.id, () =>
                        autoReplyWithAI(contact, mergedText, matchedChannel.access_token, matchedBrandId, "messenger")
                      )
                    );
                  }
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
      }

      for (const change of entry.changes || []) {
        if (change.field !== "feed") continue;
        const value = change.value;
        if (!value || value.verb !== "add") continue;
        const commentId = value.comment_id || value.id;
        if (!commentId) continue;
        const eventId = `fb_comment_${pageId}_${commentId}_${value.created_time || Date.now()}`;
        if (storage.isEventProcessed(eventId)) {
          console.log("[FB Webhook] 重複留言事件已略過:", commentId);
          continue;
        }
        storage.markEventProcessed(eventId);
        try {
          const from = value.from || {};
          const recipient = value.recipient || {};
          const message = value.message || "";
          const postId = value.post_id || "";
          const parentId = value.parent_id || null;
          const createdTime = value.created_time != null ? new Date(value.created_time * 1000).toISOString() : new Date().toISOString();
          const commenterName = typeof from.name === "string" ? from.name : (from.id ? `用戶_${String(from.id).slice(0, 8)}` : "未知");
          const commenterId = from.id != null ? String(from.id) : null;
          const pageName = typeof recipient.name === "string" ? recipient.name : (pageId || "粉專");
          const rawPayload = JSON.stringify(value);
          const resolved = resolveCommentMetadata({
            brand_id: matchedBrandId ?? null,
            page_id: pageId,
            post_id: postId,
            post_name: null,
            message,
            is_sensitive_or_complaint: false,
          });
          const row = metaCommentsStorage.createMetaComment({
            brand_id: matchedBrandId ?? null,
            page_id: pageId,
            page_name: pageName,
            post_id: postId,
            post_name: null,
            comment_id: String(commentId),
            commenter_id: commenterId,
            commenter_name: commenterName,
            message: message || "(空)",
            is_simulated: 0,
            raw_webhook_payload: rawPayload,
            ...resolved,
          });
          metaCommentsStorage.updateMetaComment(row.id, { created_at: createdTime });
          console.log("[FB Webhook] 公開留言已寫入 meta_comments id=%s comment_id=%s", row.id, commentId);
          // Phase 3：規則命中後自動執行（非同步，不阻塞 webhook 回覆）
          setImmediate(() => {
            runAutoExecution(row.id).catch((e: any) => console.error("[FB Webhook] runAutoExecution error:", e?.message));
          });
        } catch (err: any) {
          console.error("[FB Webhook] 公開留言寫入失敗:", err?.message, value?.comment_id);
        }
      }
    }
    })().catch(err => console.error("[FB Webhook] Async processing error:", err));
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
    const host = process.env.APP_DOMAIN ? `https://${process.env.APP_DOMAIN}` : `http://localhost:5000`;
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
    const hasAnyCreds = (config.merchantNo && config.accessKey) || (() => {
      const shopBrand = context?.brandId ? storage.getBrand(context.brandId) : null;
      return !!shopBrand?.shopline_api_token?.trim();
    })();
    if (!hasAnyCreds) {
      return JSON.stringify({ success: false, error: "系統尚未設定訂單查詢 API 金鑰（一頁商店或 SHOPLINE），無法查詢訂單。請至系統設定 → 品牌管理中設定 API 金鑰。" });
    }

    try {
      if (toolName === "lookup_order_by_id") {
        const orderIdRaw = (args.order_id || "").trim();
        const orderId = orderIdRaw.toUpperCase();
        console.log(`[AI Tool Call] lookup_order_by_id，單號: ${orderId} (已自動大寫)，品牌ID: ${context?.brandId || "無"}`);

        if (!orderId) {
          return JSON.stringify({ success: false, error: "訂單編號為空" });
        }

        const numberType = classifyOrderNumber(orderIdRaw);
        if (context?.contactId) {
          storage.updateContactOrderNumberType(context.contactId, numberType);
        }
        if (numberType === "payment_id") {
          return JSON.stringify({
            success: true,
            found: false,
            not_order_number: true,
            number_type: "payment_id",
            message: "這組看起來比較像付款／金流資訊，不是訂單編號。正確的訂單編號通常會出現在：訂單成立通知信、簡訊、會員訂單頁。若方便也可以直接提供收件人姓名、手機後三碼，我們幫您協助確認。請用以上說法溫和回覆客戶，不要直接說「您填錯了」。",
          });
        }
        if (numberType === "logistics_id") {
          return JSON.stringify({
            success: true,
            found: false,
            not_order_number: true,
            number_type: "logistics_id",
            message: "這組看起來比較像物流單號，不是訂單編號。訂單編號通常會出現在訂單成立通知信、簡訊或會員訂單頁。若方便也可以提供收件人姓名、手機後三碼，我們幫您協助確認。請用以上說法溫和回覆客戶。",
          });
        }

        const result = await unifiedLookupById(config, orderId, context?.brandId);

        if (!result.found || result.orders.length === 0) {
          console.log(`[AI Tool Call] 所有平台皆查無訂單: ${orderId}`);
          return JSON.stringify({ success: true, found: false, message: `所有平台（一頁商店 + SHOPLINE）皆查無訂單編號 ${orderId} 的紀錄。請告知客戶目前查不到這筆資料，並詢問是否需要轉接專人客服。` });
        }

        const order = result.orders[0];
        const statusLabel = getUnifiedStatusLabel(order.status, result.source);
        console.log(`[AI Tool Call] 查到訂單: ${orderId}，來源: ${result.source}，狀態: ${statusLabel}`);

        if (context?.contactId) {
          storage.updateContactOrderSource(context.contactId, result.source);
        }

        return JSON.stringify({
          success: true,
          found: true,
          source: result.source,
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

        let orderSource: string = "superlanding";

        if (result.orders.length === 0) {
          console.log(`[AI Tool Call] 品牌 ${context?.brandId || "預設"} SuperLanding 查無結果，嘗試統一查詢...`);
          const unifiedResult = await unifiedLookupByProductAndPhone(config, matchedPages, phone, context?.brandId);
          if (unifiedResult.found) {
            allResults = unifiedResult.orders;
            orderSource = unifiedResult.source;
          }
        }

        if (allResults.length === 0) {
          return JSON.stringify({ success: true, found: false, message: `所有平台（一頁商店 + SHOPLINE）皆查無此手機號碼的訂單（已搜尋 ${matchedPages.length} 個相關銷售頁）。請告知客戶目前查不到這筆資料，並詢問是否需要轉接專人客服。` });
        }

        if (context?.contactId) {
          storage.updateContactOrderSource(context.contactId, orderSource);
        }

        const orderSummaries = allResults.map(o => ({
          order_id: o.global_order_id,
          status: getUnifiedStatusLabel(o.status, o.source || orderSource),
          amount: o.final_total_order_amount,
          product_list: o.product_list,
          buyer_name: o.buyer_name,
          tracking_number: o.tracking_number,
          created_at: o.created_at,
          shipped_at: o.shipped_at,
          source: o.source || orderSource,
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

        let dateOrderSource: string = "superlanding";

        if (matched.length === 0) {
          console.log("[AI Tool Call] SuperLanding 日期查詢查無結果，嘗試 SHOPLINE...");
          const unifiedResult = await unifiedLookupByDateAndContact(config, contact, beginDate, endDate, pageId, context?.brandId);
          if (unifiedResult.found) {
            matched.push(...unifiedResult.orders);
            dateOrderSource = unifiedResult.source;
          }
        }

        if (matched.length === 0) {
          return JSON.stringify({ success: true, found: false, message: "所有平台（一頁商店 + SHOPLINE）在指定日期範圍內均查無相符紀錄" });
        }

        if (context?.contactId) {
          storage.updateContactOrderSource(context.contactId, dateOrderSource);
        }

        const orderSummaries = matched.map(o => ({
          order_id: o.global_order_id,
          status: getUnifiedStatusLabel(o.status, o.source || dateOrderSource),
          amount: o.final_total_order_amount,
          product_list: o.product_list,
          buyer_name: o.buyer_name,
          tracking_number: o.tracking_number,
          created_at: o.created_at,
          shipped_at: o.shipped_at,
          source: o.source || dateOrderSource,
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

  app.get("/api/sandbox/prompt-preview", authMiddleware, async (req, res) => {
    try {
      const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
      const fullPrompt = await getEnrichedSystemPrompt(brandId);
      const brand = brandId ? storage.getBrand(brandId) : undefined;
      const knowledgeFiles = storage.getKnowledgeFiles(brandId);
      const marketingRules = storage.getMarketingRules(brandId);
      const imageAssets = storage.getImageAssets(brandId);
      const channels = brandId ? storage.getChannelsByBrand(brandId) : [];
      return res.json({
        success: true,
        brand_name: brand?.name || "全域",
        brand_prompt: brand?.system_prompt || "",
        global_prompt: storage.getSetting("system_prompt") || "",
        full_prompt_length: fullPrompt.length,
        full_prompt_preview: fullPrompt.substring(0, 2000) + (fullPrompt.length > 2000 ? "\n...(truncated)" : ""),
        context_stats: {
          knowledge_files: knowledgeFiles.length,
          marketing_rules: marketingRules.length,
          image_assets: imageAssets.length,
          channels: channels.length,
        },
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

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
        model: getOpenAIModel(),
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
          } catch (_e) {
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
            } catch (_e) {}
          }

          chatMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }

        completion = await openai.chat.completions.create({
          model: getOpenAIModel(),
          messages: chatMessages,
          tools: allTools,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
        responseMessage = completion.choices[0]?.message;
      }

      let reply = responseMessage?.content || "抱歉，AI 無法生成回覆。";
      const result: Record<string, any> = {
        success: true,
        reply,
        transferred: sandboxTransferTriggered,
        tool_log: sandboxToolLog,
      };
      if (sandboxTransferTriggered) {
        result.transfer_reason = sandboxTransferReason;
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
    try { history = JSON.parse(historyRaw || "[]"); } catch (_e) {}

    const brandIdParam = req.body.brand_id ? parseInt(req.body.brand_id) : undefined;

    if (isVideo) {
      return res.json({
        success: true,
        reply: `已收到您上傳的影片（${decodedFilename}）。\n\n在實際 LINE 對話中，系統會自動將影片訊息標記為「需要真人客服」，並通知專人檢視。\n\n📋 模擬結果：\n- 檔案類型：影片\n- 動作：自動轉接真人客服\n- 回覆：「已收到您的影片，將為您轉交專人檢視。」`,
        fileUrl,
        fileType: "video",
        transferred: true,
        transfer_reason: "影片訊息自動轉接真人",
        tool_log: ["Tool: auto_transfer_video()", ">>> 影片訊息自動觸發轉接真人客服"],
      });
    }

    if (isImage) {
      try {
        const filePath = path.join(uploadDir, req.file.filename);
        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString("base64");
        const mimeType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
        const dataUri = `data:${mimeType};base64,${base64}`;

        const systemPrompt = await getEnrichedSystemPrompt(brandIdParam);
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
          model: getOpenAIModel(),
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
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
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
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const { display_name, description, keywords } = req.body;
    const data: Record<string, string> = {};
    if (display_name !== undefined) data.display_name = display_name;
    if (description !== undefined) data.description = description;
    if (keywords !== undefined) data.keywords = keywords;
    if (!storage.updateImageAsset(id, data)) return res.status(404).json({ message: "素材不存在" });
    return res.json({ success: true });
  });

  app.delete("/api/image-assets/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
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
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const { display_name, role, password } = req.body;
    if (!display_name) return res.status(400).json({ message: "姓名為必填" });
    if (!["super_admin", "marketing_manager", "cs_agent"].includes(role)) return res.status(400).json({ message: "角色無效" });
    if (!storage.updateUser(id, display_name, role, password || undefined)) {
      return res.status(404).json({ message: "成員不存在" });
    }
    return res.json({ success: true });
  });

  app.delete("/api/team/:id", authMiddleware, superAdminOnly, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const s = (req as any).session;
    if (id === s.userId) {
      return res.status(400).json({ message: "無法刪除目前登入的帳號" });
    }
    if (!storage.deleteUser(id)) return res.status(404).json({ message: "成員不存在" });
    return res.json({ success: true });
  });

  app.get("/api/team/:id/brand-assignments", authMiddleware, (req: any, res) => {
    const userId = parseIdParam(req.params.id);
    if (userId === null) return res.status(400).json({ message: "無效的 ID" });
    const me = req.session?.userId;
    const role = req.session?.userRole ?? req.session?.role;
    const isSupervisor = role === "super_admin" || role === "marketing_manager";
    if (userId !== me && !isSupervisor) return res.status(403).json({ message: "僅能查看本人或由主管查看" });
    const user = storage.getUserById(userId);
    if (!user) return res.status(404).json({ message: "成員不存在" });
    const assignments = storage.getAgentBrandAssignments(userId);
    return res.json(assignments);
  });

  app.put("/api/team/:id/brand-assignments", authMiddleware, superAdminOnly, (req, res) => {
    const userId = parseIdParam(req.params.id);
    if (userId === null) return res.status(400).json({ message: "無效的 ID" });
    const { assignments } = req.body || {};
    if (!Array.isArray(assignments)) return res.status(400).json({ message: "請提供 assignments 陣列" });
    const user = storage.getUserById(userId);
    if (!user) return res.status(404).json({ message: "成員不存在" });
    const normalized = assignments.map((a: any) => {
      const brand_id = typeof a.brand_id === "number" ? a.brand_id : parseInt(String(a.brand_id), 10);
      const role = a.role === "backup" ? "backup" : "primary";
      return { brand_id, role };
    }).filter((a: { brand_id: number; role: string }) => !Number.isNaN(a.brand_id));
    storage.setAgentBrandAssignments(userId, normalized);
    return res.json({ success: true, assignments: storage.getAgentBrandAssignments(userId) });
  });

  app.get("/api/team/available-agents", authMiddleware, (req, res) => {
    const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
    const eligible = assignment.getEligibleAgents();
    const eligibleSet = new Set(eligible.map((e) => e.agentId));
    const list = members.map((m) => {
      const u = storage.getUserById(m.id);
      const status = storage.getAgentStatus(m.id);
      const openCases = m.open_cases_count ?? storage.getOpenCasesCountForAgent(m.id);
      return {
        id: m.id,
        display_name: m.display_name,
        avatar_url: m.avatar_url ?? u?.avatar_url ?? null,
        is_online: m.is_online ?? 0,
        is_available: m.is_available ?? 1,
        last_active_at: m.last_active_at ?? null,
        open_cases_count: openCases,
        max_active_conversations: m.max_active_conversations ?? 10,
        auto_assign_enabled: m.auto_assign_enabled ?? 1,
        can_assign: eligibleSet.has(m.id),
        on_duty: status?.on_duty ?? 1,
        work_start_time: status?.work_start_time ?? "09:00",
        work_end_time: status?.work_end_time ?? "18:00",
        is_in_work: assignment.isAgentInWork(m.id),
      };
    });
    return res.json(list);
  });

  app.put("/api/team/:id/agent-status", authMiddleware, superAdminOnly, (req: any, res) => {
    const userId = parseIdParam(req.params.id);
    if (userId === null) return res.status(400).json({ message: "無效的 ID" });
    const { auto_assign_enabled, max_active_conversations } = req.body || {};
    const status = storage.getAgentStatus(userId);
    storage.upsertAgentStatus({
      user_id: userId,
      auto_assign_enabled: auto_assign_enabled !== undefined ? (auto_assign_enabled ? 1 : 0) : status?.auto_assign_enabled ?? 1,
      max_active_conversations: max_active_conversations !== undefined ? Math.max(1, Math.min(50, parseInt(String(max_active_conversations), 10) || 10)) : status?.max_active_conversations ?? 10,
    });
    return res.json({ success: true });
  });

  app.post("/api/team/:id/avatar", authMiddleware, avatarUpload.single("file"), (req: any, res) => {
    const userId = parseIdParam(req.params.id);
    if (userId === null) return res.status(400).json({ message: "無效的 ID" });
    const me = req.session?.userId;
    const role = req.session?.userRole ?? req.session?.role;
    const isSelf = me === userId;
    const isAdmin = role === "super_admin";
    if (!isSelf && !isAdmin) return res.status(403).json({ message: "僅能上傳自己的頭像或由管理員上傳" });
    if (!req.file) return res.status(400).json({ message: "請上傳圖片 (file)" });
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    storage.updateUserAvatar(userId, avatarUrl);
    return res.json({ success: true, avatar_url: avatarUrl });
  });

  const isSupervisor = (req: any) => ["super_admin", "marketing_manager"].includes(req.session?.userRole);

  app.get("/api/agent-status", authMiddleware, (req: any, res) => {
    const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
    if (isSupervisor(req)) {
      const list = members.map((m) => {
        const status = storage.getAgentStatus(m.id);
        const openCases = m.open_cases_count ?? storage.getOpenCasesCountForAgent(m.id);
        const maxActive = status?.max_active_conversations ?? m.max_active_conversations ?? 10;
        return {
          user_id: m.id,
          display_name: m.display_name,
          is_online: m.is_online ?? 0,
          is_available: m.is_available ?? 1,
          last_active_at: m.last_active_at ?? null,
          priority: status?.priority ?? 1,
          on_duty: status?.on_duty ?? 1,
          lunch_break: status?.lunch_break ?? 0,
          pause_new_cases: status?.pause_new_cases ?? 0,
          today_assigned_count: status?.today_assigned_count ?? 0,
          open_cases_count: openCases,
          max_active_conversations: maxActive,
          work_start_time: status?.work_start_time ?? "09:00",
          work_end_time: status?.work_end_time ?? "18:00",
          lunch_start_time: status?.lunch_start_time ?? "12:00",
          lunch_end_time: status?.lunch_end_time ?? "13:00",
          updated_at: status?.updated_at,
        };
      });
      return res.json(list);
    }
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "未登入" });
    const status = storage.getAgentStatus(userId);
    const openCases = storage.getOpenCasesCountForAgent(userId);
    const me = members.find((m) => m.id === userId);
    if (!me) return res.json({ user_id: userId, priority: 1, on_duty: 1, lunch_break: 0, pause_new_cases: 0, today_assigned_count: 0, open_cases_count: openCases, max_active_conversations: 10, is_online: 0, is_available: 1, work_start_time: "09:00", work_end_time: "18:00", lunch_start_time: "12:00", lunch_end_time: "13:00", updated_at: null });
    const maxActive = status?.max_active_conversations ?? (me as any).max_active_conversations ?? 10;
    return res.json({ ...status, user_id: me.id, display_name: me.display_name, open_cases_count: openCases, max_active_conversations: maxActive, is_online: (me as any).is_online ?? 0, is_available: (me as any).is_available ?? 1 });
  });

  app.get("/api/agent-stats/me", authMiddleware, (req: any, res) => {
    const userId = req.session?.userId;
    const role = req.session?.userRole;
    if (!userId || role !== "cs_agent") {
      return res.json({ my_cases: 0, pending_reply: 0, urgent: 0, overdue: 0, tracking: 0, closed_today: 0, open_cases_count: 0, max_active_conversations: 10, is_online: 0, is_available: 1 });
    }
    const status = storage.getAgentStatus(userId);
    const openCases = storage.getOpenCasesCountForAgent(userId);
    const maxActive = status?.max_active_conversations ?? 10;
    const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
    const me = members.find((m) => m.id === userId);
    const isOnline = (me as any)?.is_online ?? 0;
    const isAvailable = (me as any)?.is_available ?? 1;
    const contacts = storage.getContacts(undefined, userId, userId) as any[];
    const today = new Date().toISOString().slice(0, 10);
    let pendingReply = 0;
    let urgent = 0;
    let overdue = 0;
    let tracking = 0;
    let closedToday = 0;
    for (const c of contacts) {
      if (["closed", "resolved"].includes(c.status)) {
        if (c.closed_at && String(c.closed_at).slice(0, 10) === today && c.closed_by_agent_id === userId) closedToday++;
        continue;
      }
      if (String(c.last_message_sender_type || "").toLowerCase() === "user") pendingReply++;
      if (isUrgentContact(c)) urgent++;
      if (isOverdueContact(c)) overdue++;
      if (c.my_flag === "tracking") tracking++;
    }
    return res.json({ my_cases: openCases, pending_reply: pendingReply, urgent, overdue, tracking, closed_today: closedToday, open_cases_count: openCases, max_active_conversations: maxActive, is_online: isOnline, is_available: isAvailable });
  });

  app.get("/api/manager-stats", authMiddleware, (req: any, res) => {
    if (!isSupervisor(req)) return res.json({ today_new: 0, unassigned: 0, urgent: 0, overdue: 0, closed_today: 0, vip_unhandled: 0, team: [] });
    const brandId = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const allContacts = storage.getContacts(brandId) as any[];
    const today = new Date().toISOString().slice(0, 10);
    let todayNew = 0;
    let unassigned = 0;
    let urgent = 0;
    let overdue = 0;
    let closedToday = 0;
    let vipUnhandled = 0;
    for (const c of allContacts) {
      if (c.created_at && String(c.created_at).slice(0, 10) === today) todayNew++;
      if (!c.assigned_agent_id && c.needs_human === 1) unassigned++;
      if (!["closed", "resolved"].includes(c.status)) {
        if (isUrgentContact(c)) urgent++;
        if (isOverdueContact(c)) overdue++;
        if (c.vip_level > 0 && String(c.last_message_sender_type || "").toLowerCase() === "user") vipUnhandled++;
      }
      if (["closed", "resolved"].includes(c.status) && c.closed_at && String(c.closed_at).slice(0, 10) === today) closedToday++;
    }
    const agents = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
    const team = agents.map((m) => {
      const st = storage.getAgentStatus(m.id);
      const openCases = storage.getOpenCasesCountForAgent(m.id);
      const agentContacts = storage.getContacts(brandId, m.id) as any[];
      let pendingReply = 0;
      for (const c of agentContacts) {
        if (["closed", "resolved"].includes(c.status)) continue;
        if (String(c.last_message_sender_type || "").toLowerCase() === "user") pendingReply++;
      }
      return {
        id: m.id,
        display_name: m.display_name,
        is_online: (m as any).is_online ?? 0,
        is_available: (m as any).is_available ?? 1,
        open_cases_count: openCases,
        max_active_conversations: st?.max_active_conversations ?? 10,
        pending_reply: pendingReply,
      };
    });
    return res.json({ today_new: todayNew, unassigned, urgent, overdue, closed_today: closedToday, vip_unhandled: vipUnhandled, team });
  });

  app.put("/api/agent-status/me", authMiddleware, (req: any, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "未登入" });
    const body = req.body || {};
    if (body.is_online !== undefined || body.is_available !== undefined) {
      storage.updateUserOnline(userId, body.is_online !== undefined ? (body.is_online ? 1 : 0) : 1, body.is_available !== undefined ? (body.is_available ? 1 : 0) : undefined);
    }
    storage.upsertAgentStatus({
      user_id: userId,
      priority: body.priority,
      on_duty: body.on_duty,
      lunch_break: body.lunch_break,
      pause_new_cases: body.pause_new_cases,
      work_start_time: body.work_start_time,
      work_end_time: body.work_end_time,
      lunch_start_time: body.lunch_start_time,
      lunch_end_time: body.lunch_end_time,
      max_active_conversations: body.max_active_conversations,
      auto_assign_enabled: body.auto_assign_enabled,
    });
    return res.json({ success: true });
  });

  app.post("/api/contacts/:id/assign", authMiddleware, (req: any, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const byUserId = req.session?.userId;
    if (!byUserId) return res.status(401).json({ message: "未登入" });
    const rawAgentId = req.body?.agent_id ?? req.get("x-assign-agent-id");
    const bodyAgentId = rawAgentId !== undefined && rawAgentId !== null && rawAgentId !== "" ? Number(rawAgentId) : null;
    const role = req.session?.userRole ?? req.session?.role;
    const isManager = role === "super_admin" || role === "marketing_manager";
    const wantsManualAssign = bodyAgentId != null && !Number.isNaN(bodyAgentId) && Number.isInteger(bodyAgentId);
    if (process.env.NODE_ENV !== "production") {
      const fromHeader = req.body?.agent_id === undefined && req.get("x-assign-agent-id");
      console.log("[assign]", { contactId, "body.agent_id": req.body?.agent_id, "x-assign-agent-id": req.get("x-assign-agent-id"), bodyAgentId, wantsManualAssign, role, isManager, usedHeaderFallback: !!fromHeader });
    }

    try {
      let agentId: number | null = null;
      if (wantsManualAssign) {
        if (!isManager) return res.status(403).json({ message: "僅主管可手動指定客服，請使用主管帳號操作" });
        const ok = assignment.assignCaseManual(contactId, bodyAgentId!, byUserId, req.body?.reason ?? null);
        if (!ok) {
          const members = storage.getTeamMembers().filter((m: { role: string }) => m.role === "cs_agent");
          const target = members.find((m: { id: number }) => m.id === bodyAgentId);
          if (!target) return res.status(400).json({ message: "指定客服不存在或非客服角色" });
          const openCases = target.open_cases_count ?? storage.getOpenCasesCountForAgent(bodyAgentId!);
          const maxActive = target.max_active_conversations ?? 10;
          return res.status(400).json({ message: `該客服目前負載已滿 (${openCases}/${maxActive})` });
        }
        agentId = bodyAgentId;
      } else {
        agentId = assignment.assignCase(contactId);
        if (agentId == null) return res.status(503).json({ message: "目前無可接案客服（請確認：1) 有客服在即時客服頁上線 2) 目前時間在您設定的上班時段內且非午休）" });
      }
      broadcastSSE("contacts_updated", { contact_id: contactId });
      const updated = storage.getContact(contactId);
      const assignedTo = agentId ? storage.getUserById(agentId) : null;
      return res.json({
        success: true,
        assigned_agent_id: agentId,
        assigned_to_user_id: updated?.assigned_agent_id ?? agentId,
        assigned_at: updated?.assigned_at ?? updated?.first_assigned_at ?? null,
        assignment_status: updated?.assignment_status ?? "assigned",
        assignment_method: updated?.assignment_method ?? (wantsManualAssign ? "manual" : "auto"),
        assigned_agent_name: assignedTo?.display_name ?? null,
        assigned_agent_avatar_url: assignedTo?.avatar_url ?? null,
        last_human_reply_at: updated?.last_human_reply_at ?? null,
        reassign_count: updated?.reassign_count ?? 0,
        needs_assignment: updated?.needs_assignment ?? 0,
        response_sla_deadline_at: updated?.response_sla_deadline_at ?? null,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const isConstraint = /CHECK constraint failed|constraint failed|SQLITE_CONSTRAINT/i.test(msg);
      console.error("[assign] 指派失敗", contactId, err);
      if (isConstraint) {
        return res.status(500).json({ message: "指派時更新狀態失敗，請重新整理頁面後再試。若持續發生請聯絡管理員。" });
      }
      return res.status(500).json({ message: msg && msg.length < 200 ? msg : "指派時發生錯誤，請稍後再試。" });
    }
  });

  app.post("/api/contacts/:id/unassign", authMiddleware, (req: any, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const byUserId = req.session?.userId;
    if (!byUserId) return res.status(401).json({ message: "未登入" });
    const isManager = (req.session?.userRole ?? req.session?.role) === "super_admin" || (req.session?.userRole ?? req.session?.role) === "marketing_manager";
    if (!isManager) return res.status(403).json({ message: "僅主管可移回待分配" });
    const ok = assignment.unassignCase(contactId, byUserId);
    if (!ok) return res.status(404).json({ message: "案件不存在" });
    broadcastSSE("contacts_updated", { contact_id: contactId });
    const updated = storage.getContact(contactId);
    return res.json({
      success: true,
      assigned_to_user_id: null,
      assigned_at: null,
      assignment_status: updated?.assignment_status ?? "waiting_human",
      assignment_method: null,
      assigned_agent_name: null,
      assigned_agent_avatar_url: null,
      last_human_reply_at: updated?.last_human_reply_at ?? null,
      reassign_count: updated?.reassign_count ?? 0,
      needs_assignment: updated?.needs_assignment ?? 1,
      response_sla_deadline_at: null,
    });
  });

  app.get("/api/contacts/:id/assignment", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const assignedTo = contact.assigned_agent_id ? storage.getUserById(contact.assigned_agent_id) : null;
    return res.json({
      assigned_to_user_id: contact.assigned_agent_id,
      assigned_at: contact.assigned_at ?? contact.first_assigned_at,
      assignment_status: contact.assignment_status,
      assignment_method: contact.assignment_method,
      assignment_reason: (contact as any).assignment_reason ?? null,
      last_human_reply_at: contact.last_human_reply_at,
      reassign_count: contact.reassign_count ?? 0,
      needs_assignment: contact.needs_assignment ?? 0,
      response_sla_deadline_at: contact.response_sla_deadline_at,
      assigned_agent_name: assignedTo?.display_name ?? null,
      assigned_agent_avatar_url: assignedTo?.avatar_url ?? null,
    });
  });

  app.post("/api/contacts/:id/reassign", authMiddleware, (req: any, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const { new_agent_id, note } = req.body || {};
    const newAgentId = new_agent_id != null ? Number(new_agent_id) : null;
    if (newAgentId == null || !Number.isInteger(newAgentId)) return res.status(400).json({ message: "請提供 new_agent_id" });
    const byAgentId = req.session?.userId;
    if (!byAgentId) return res.status(401).json({ message: "未登入" });
    try {
      const ok = assignment.reassignCase(contactId, newAgentId, byAgentId, note || null);
      if (!ok) return res.status(404).json({ message: "案件不存在" });
      broadcastSSE("contacts_updated", { contact_id: contactId });
      const updated = storage.getContact(contactId);
      const assignedTo = updated?.assigned_agent_id ? storage.getUserById(updated.assigned_agent_id) : null;
      return res.json({
        success: true,
        assigned_to_user_id: updated?.assigned_agent_id ?? null,
        assigned_at: updated?.assigned_at ?? updated?.first_assigned_at ?? null,
        assignment_status: updated?.assignment_status ?? "assigned",
        assignment_method: updated?.assignment_method ?? "reassign",
        assigned_agent_name: assignedTo?.display_name ?? null,
        assigned_agent_avatar_url: assignedTo?.avatar_url ?? null,
        last_human_reply_at: updated?.last_human_reply_at ?? null,
        reassign_count: updated?.reassign_count ?? 0,
        needs_assignment: updated?.needs_assignment ?? 0,
        response_sla_deadline_at: updated?.response_sla_deadline_at ?? null,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (/CHECK constraint failed|constraint failed|SQLITE_CONSTRAINT/i.test(msg)) {
        console.error("[reassign] 改派失敗", contactId, err);
        return res.status(500).json({ message: "改派時更新狀態失敗，請重新整理頁面後再試。若持續發生請聯絡管理員。" });
      }
      throw err;
    }
  });

  app.get("/api/contacts/:id/assignment-history", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const history = storage.getAssignmentHistory(contactId);
    const withNames = history.map((h) => {
      const toUser = storage.getUserById(h.assigned_to_agent_id);
      const byUser = h.assigned_by_agent_id ? storage.getUserById(h.assigned_by_agent_id) : null;
      return { ...h, assigned_to_name: toUser?.display_name, assigned_by_name: byUser?.display_name };
    });
    return res.json(withNames);
  });

  app.get("/api/performance/me", authMiddleware, (req: any, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "未登入" });
    const stats = storage.getAgentPerformanceStats(userId);
    return res.json(stats);
  });

  app.get("/api/performance", authMiddleware, managerOrAbove, (_req: any, res) => {
    const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
    const list = members.map((m) => ({ agent_id: m.id, display_name: m.display_name, ...storage.getAgentPerformanceStats(m.id) }));
    return res.json(list);
  });

  app.get("/api/supervisor/report", authMiddleware, managerOrAbove, (req: any, res) => {
    const report = storage.getSupervisorReport();
    return res.json(report);
  });

  app.get("/api/manager-dashboard", authMiddleware, (req: any, res) => {
    if (!isSupervisor(req)) return res.json({ cards: {}, status_distribution: [], agent_workload: [], alerts: [], issue_type_rank: [], tag_rank: [] });
    const brandId = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const allContacts = storage.getContacts(brandId) as any[];
    const report = storage.getSupervisorReport();
    const today = new Date().toISOString().slice(0, 10);
    let todayPending = 0;
    let urgent = 0;
    let unassigned = 0;
    let overdue = 0;
    let vipUnhandled = 0;
    let closedToday = 0;
    const statusCount: Record<string, number> = {};
    for (const c of allContacts) {
      if (!["closed", "resolved"].includes(c.status)) {
        todayPending++;
        if (isUrgentContact(c)) urgent++;
        if (isOverdueContact(c)) overdue++;
        if (c.vip_level > 0 && String(c.last_message_sender_type || "").toLowerCase() === "user") vipUnhandled++;
        statusCount[c.status || "pending"] = (statusCount[c.status || "pending"] || 0) + 1;
      }
      if (!c.assigned_agent_id && c.needs_human === 1) unassigned++;
      if (["closed", "resolved"].includes(c.status) && c.closed_at && String(c.closed_at).slice(0, 10) === today) closedToday++;
    }
    const totalToday = allContacts.filter((c) => c.created_at && String(c.created_at).slice(0, 10) === today).length;
    const todayCloseRate = totalToday > 0 ? Math.round((closedToday / totalToday) * 100) : 0;
    const agents = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
    const agentWorkload = agents.map((m) => {
      const st = storage.getAgentStatus(m.id);
      const openCases = storage.getOpenCasesCountForAgent(m.id);
      const maxActive = st?.max_active_conversations ?? 10;
      const agentContacts = storage.getContacts(brandId, m.id) as any[];
      let pendingReply = 0;
      for (const c of agentContacts) {
        if (["closed", "resolved"].includes(c.status)) continue;
        if (String(c.last_message_sender_type || "").toLowerCase() === "user") pendingReply++;
      }
      return { id: m.id, name: m.display_name, open: openCases, max: maxActive, pending: pendingReply };
    });
    const statusLabels: Record<string, string> = { pending: "待處理", processing: "處理中", awaiting_human: "待人工", assigned: "已分配", waiting_customer: "等客戶回覆", high_risk: "緊急", new_case: "新案件", closed: "已結案", resolved: "已解決" };
    const statusDistribution = Object.entries(statusCount).map(([status, count]) => ({ label: statusLabels[status] || status, count }));
    const unassignedThreshold = 5;
    const alerts: { type: string; count: number; threshold?: number }[] = [];
    if (overdue > 0) alerts.push({ type: "逾時未回", count: overdue });
    if (urgent > 0) alerts.push({ type: "緊急案件", count: urgent });
    if (vipUnhandled > 0) alerts.push({ type: "VIP 未處理", count: vipUnhandled });
    if (unassigned >= unassignedThreshold) alerts.push({ type: "待分配過多", count: unassigned, threshold: unassignedThreshold });
    const issueTypeRank = (report.category_ratio || []).map((c: { label: string; count: number }) => ({ name: c.label, count: c.count }));
    const tagRank = (report.tag_rank || []).map((t: { tag: string; count: number }) => ({ name: t.tag, count: t.count }));
    return res.json({
      cards: { today_pending: todayPending, urgent, unassigned, today_close_rate: todayCloseRate, closed_today: closedToday, today_new: totalToday },
      status_distribution: statusDistribution,
      agent_workload: agentWorkload,
      alerts,
      issue_type_rank: issueTypeRank,
      tag_rank: tagRank,
    });
  });

  app.get("/api/settings/tag-shortcuts", authMiddleware, (req, res) => {
    const list = storage.getTagShortcuts();
    return res.json(list);
  });

  app.put("/api/settings/tag-shortcuts", authMiddleware, managerOrAbove, (req: any, res) => {
    const body = req.body;
    const list = Array.isArray(body) ? body : (body?.tags ?? body?.list ?? []);
    const tags = list.map((t: any, i: number) => ({ name: String(t?.name ?? t).trim(), order: typeof t?.order === "number" ? t.order : i })).filter((t) => t.name);
    storage.setTagShortcuts(tags);
    return res.json(storage.getTagShortcuts());
  });

  app.get("/api/notifications/unread-count", authMiddleware, (req, res) => {
    const count = storage.getUnreadHumanCaseCount();
    return res.json({ count });
  });

  app.post("/api/notifications/mark-read", authMiddleware, (req: any, res) => {
    const contactId = req.body?.contact_id != null ? parseInt(String(req.body.contact_id), 10) : undefined;
    if (contactId !== undefined && Number.isNaN(contactId)) return res.status(400).json({ message: "無效的 contact_id" });
    storage.markCaseNotificationsRead(contactId);
    return res.json({ success: true });
  });

  app.get("/api/assignment/eligible", authMiddleware, (req, res) => {
    const eligible = assignment.getEligibleAgents();
    const withNames = eligible.map((e) => ({ ...e, display_name: storage.getUserById(e.agentId)?.display_name }));
    return res.json(withNames);
  });

  app.get("/api/assignment/unavailable-reason", authMiddleware, (req, res) => {
    const reason = assignment.getUnavailableReason();
    return res.json({ reason });
  });

  app.post("/api/assignment/run-overdue-reassign", authMiddleware, managerOrAbove, (req, res) => {
    const results = assignment.runOverdueReassign();
    return res.json({ results });
  });

  app.get("/api/settings/schedule", authMiddleware, (req, res) => {
    const schedule = storage.getGlobalSchedule();
    return res.json(schedule);
  });

  app.put("/api/settings/schedule", authMiddleware, superAdminOnly, (req: any, res) => {
    const { work_start_time, work_end_time, lunch_start_time, lunch_end_time } = req.body || {};
    if (work_start_time != null) storage.setSetting("work_start_time", String(work_start_time));
    if (work_end_time != null) storage.setSetting("work_end_time", String(work_end_time));
    if (lunch_start_time != null) storage.setSetting("lunch_start_time", String(lunch_start_time));
    if (lunch_end_time != null) storage.setSetting("lunch_end_time", String(lunch_end_time));
    return res.json(storage.getGlobalSchedule());
  });

  app.get("/api/settings/assignment-rules", authMiddleware, (req, res) => {
    return res.json({
      human_first_reply_sla_minutes: storage.getSlaMinutes(),
      assignment_auto_enabled: storage.getAssignmentAutoEnabled(),
      assignment_timeout_reassign_enabled: storage.getAssignmentTimeoutReassignEnabled(),
    });
  });

  app.put("/api/settings/assignment-rules", authMiddleware, superAdminOnly, (req: any, res) => {
    const { human_first_reply_sla_minutes, assignment_auto_enabled, assignment_timeout_reassign_enabled } = req.body || {};
    if (human_first_reply_sla_minutes != null) {
      const n = Math.min(120, Math.max(1, parseInt(String(human_first_reply_sla_minutes), 10) || 10));
      storage.setSetting("human_first_reply_sla_minutes", String(n));
    }
    if (assignment_auto_enabled !== undefined) storage.setSetting("assignment_auto_enabled", assignment_auto_enabled ? "1" : "0");
    if (assignment_timeout_reassign_enabled !== undefined) storage.setSetting("assignment_timeout_reassign_enabled", assignment_timeout_reassign_enabled ? "1" : "0");
    return res.json({
      human_first_reply_sla_minutes: storage.getSlaMinutes(),
      assignment_auto_enabled: storage.getAssignmentAutoEnabled(),
      assignment_timeout_reassign_enabled: storage.getAssignmentTimeoutReassignEnabled(),
    });
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

    const brandFilter = brandId ? " AND c.brand_id = ?" : "";
    const brandParam = brandId ? [brandId] : [];

    const msgStats = db.prepare(`
      SELECT 
        SUM(CASE WHEN m.sender_type = 'user' THEN 1 ELSE 0 END) as user_msgs,
        SUM(CASE WHEN m.sender_type = 'ai' THEN 1 ELSE 0 END) as ai_msgs,
        SUM(CASE WHEN m.sender_type = 'admin' THEN 1 ELSE 0 END) as admin_msgs
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.created_at >= ? AND m.created_at <= ?${brandFilter}
    `).get(startDate, endDate, ...brandParam) as any;
    const userMsgs: number = msgStats?.user_msgs || 0;
    const aiMsgs: number = msgStats?.ai_msgs || 0;
    const adminMsgs: number = msgStats?.admin_msgs || 0;

    const activeContactsRow = db.prepare(`
      SELECT COUNT(DISTINCT c.id) as cnt FROM contacts c
      JOIN messages m ON m.contact_id = c.id
      WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
    `).get(startDate, endDate, ...brandParam) as { cnt: number };
    const active = activeContactsRow?.cnt || 0;

    const contactStatusInRange = db.prepare(`
      SELECT c.status, COUNT(DISTINCT c.id) as cnt
      FROM contacts c
      JOIN messages m ON m.contact_id = c.id
      WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
      GROUP BY c.status
    `).all(startDate, endDate, ...brandParam) as { status: string; cnt: number }[];

    let resolvedCount = 0;
    const statusMap: Record<string, number> = {};
    for (const row of contactStatusInRange) {
      statusMap[row.status] = (statusMap[row.status] || 0) + row.cnt;
      if (row.status === "resolved") resolvedCount += row.cnt;
    }
    const completionRate = active > 0 ? Math.round((resolvedCount / active) * 1000) / 10 : null;

    const transferCount = (db.prepare(`
      SELECT COUNT(DISTINCT c.id) as cnt FROM contacts c
      JOIN messages m ON m.contact_id = c.id
      WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
        AND (c.status IN ('awaiting_human', 'high_risk') OR c.needs_human = 1)
    `).get(startDate, endDate, ...brandParam) as { cnt: number })?.cnt || 0;
    const transferRate = active > 0 ? Math.round((transferCount / active) * 1000) / 10 : null;

    const aiLogStats = storage.getAiLogStats(startDate, endDate, brandId);
    const aiHasData = aiLogStats.totalAiResponses > 0;
    const aiResolutionRate = aiHasData
      ? Math.round(((aiLogStats.totalAiResponses - aiLogStats.transferTriggered) / aiLogStats.totalAiResponses) * 1000) / 10
      : null;
    const orderQueryHasData = aiLogStats.orderQueryCount > 0;
    const orderQuerySuccessRate = orderQueryHasData
      ? Math.round((aiLogStats.orderQuerySuccess / aiLogStats.orderQueryCount) * 1000) / 10
      : null;

    const avgMessagesPerContact = active > 0 ? Math.round((userMsgs / active) * 10) / 10 : null;

    const totalMsgs = userMsgs + aiMsgs + adminMsgs;
    const messageSplit = [
      { name: "客戶訊息", value: userMsgs, pct: totalMsgs > 0 ? Math.round((userMsgs / totalMsgs) * 1000) / 10 : 0 },
      { name: "AI 回覆", value: aiMsgs, pct: totalMsgs > 0 ? Math.round((aiMsgs / totalMsgs) * 1000) / 10 : 0 },
      { name: "真人回覆", value: adminMsgs, pct: totalMsgs > 0 ? Math.round((adminMsgs / totalMsgs) * 1000) / 10 : 0 },
    ];

    const statusLabels: Record<string, string> = {
      pending: "待處理", processing: "處理中", resolved: "已解決",
      ai_handling: "AI 處理中", awaiting_human: "待人工", high_risk: "高風險", closed: "已結案",
    };
    const statusDistribution = Object.entries(statusMap)
      .map(([status, count]) => ({ name: statusLabels[status] || status, value: count }))
      .sort((a, b) => b.value - a.value);

    const issueTypeDistribution: { name: string; value: number }[] = [];
    const issueTypeCounts = db.prepare(`
      SELECT c.issue_type, COUNT(DISTINCT c.id) as count FROM contacts c
      JOIN messages m ON m.contact_id = c.id
      WHERE c.issue_type IS NOT NULL AND m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
      GROUP BY c.issue_type ORDER BY count DESC
    `).all(startDate, endDate, ...brandParam) as { issue_type: string; count: number }[];
    const issueTypeLabels: Record<string, string> = {
      order_inquiry: "訂單查詢", product_consult: "商品諮詢", return_refund: "退貨退款",
      complaint: "客訴", order_modify: "訂單修改", general: "一般諮詢", other: "其他",
    };
    for (const it of issueTypeCounts) {
      issueTypeDistribution.push({ name: issueTypeLabels[it.issue_type] || it.issue_type, value: it.count });
    }
    const classifiedCount = issueTypeDistribution.reduce((s, d) => s + d.value, 0);
    const intentUnclassifiedPct = active > 0 ? Math.round(((active - classifiedCount) / active) * 100) : 0;

    const intentDistribution: { name: string; value: number; isEstimate: boolean }[] = [];
    if (issueTypeDistribution.length > 0) {
      for (const it of issueTypeDistribution) {
        intentDistribution.push({ name: it.name, value: it.value, isEstimate: false });
      }
    } else if (userMsgs > 0) {
      const topKeywords = storage.getTopKeywordsFromMessages(startDate, endDate, brandId);
      const intentCategories: Record<string, string[]> = {
        "退換貨諮詢": ["退換貨", "退貨", "換貨", "退款", "瑕疵", "損壞", "保固"],
        "訂單查詢": ["訂單", "查詢", "物流", "出貨", "寄送"],
        "訂單修改": ["修改", "取消", "地址", "付款"],
        "商品諮詢": ["商品", "尺寸", "顏色", "品質", "庫存", "缺貨", "價格", "折扣", "優惠"],
        "客訴/高風險": ["真人", "轉接", "客服", "客訴", "投訴", "不滿"],
      };
      for (const [category, kws] of Object.entries(intentCategories)) {
        let catCount = 0;
        for (const kw of kws) {
          const found = topKeywords.find(k => k.keyword === kw);
          if (found) catCount += found.count;
        }
        if (catCount > 0) {
          intentDistribution.push({ name: category, value: catCount, isEstimate: true });
        }
      }
      intentDistribution.sort((a, b) => b.value - a.value);
    }

    const transferReasons = aiLogStats.transferReasons.map(r => ({ ...r, reason: maskSensitiveInfo(r.reason) }));
    const systemTransferReasons = db.prepare(`
      SELECT details, COUNT(*) as count FROM system_alerts
      WHERE alert_type = 'transfer' AND created_at >= ? AND created_at <= ?
      GROUP BY details ORDER BY count DESC LIMIT 10
    `).all(startDate, endDate) as { details: string; count: number }[];
    const allTransferReasons = transferReasons.length > 0 ? transferReasons : systemTransferReasons.map(r => ({ reason: maskSensitiveInfo(r.details), count: r.count }));

    const platformStats = db.prepare(`
      SELECT c.platform, COUNT(DISTINCT c.id) as count FROM contacts c
      JOIN messages m ON m.contact_id = c.id
      WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
      GROUP BY c.platform
    `).all(startDate, endDate, ...brandParam) as { platform: string; count: number }[];
    const platformDistribution = platformStats.map(p => ({
      name: p.platform === "line" ? "LINE" : p.platform === "messenger" ? "Messenger" : p.platform,
      value: p.count,
    }));

    const dailyVolumeRaw = db.prepare(`
      SELECT date(m.created_at) as d,
        SUM(CASE WHEN m.sender_type='user' THEN 1 ELSE 0 END) as user_cnt,
        SUM(CASE WHEN m.sender_type='ai' THEN 1 ELSE 0 END) as ai_cnt,
        SUM(CASE WHEN m.sender_type='admin' THEN 1 ELSE 0 END) as admin_cnt
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.created_at >= ? AND m.created_at <= ?${brandFilter}
      GROUP BY date(m.created_at) ORDER BY d
    `).all(startDate, endDate, ...brandParam) as { d: string; user_cnt: number; ai_cnt: number; admin_cnt: number }[];
    const dailyVolume = dailyVolumeRaw.map(r => ({
      date: r.d,
      user: r.user_cnt || 0,
      ai: r.ai_cnt || 0,
      admin: r.admin_cnt || 0,
    }));

    const topKeywordsAll = storage.getTopKeywordsFromMessages(startDate, endDate, brandId);

    const userMessages = db.prepare(`
      SELECT m.content FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.sender_type = 'user' AND m.created_at >= ? AND m.created_at <= ?${brandFilter}
      ORDER BY m.created_at DESC LIMIT 500
    `).all(startDate, endDate, ...brandParam) as { content: string }[];

    const productKeywords = [
      "保潔墊", "烘衣機", "涼感墊", "夢枕", "冰絲", "飛行機", "驚喜盒", "電暖毯", "落沙墊",
      "燙衣", "攪拌杯", "內褲", "水彩盤", "背心", "掛燙", "包包", "精華液", "保養品",
      "面膜", "乳液", "洗面乳", "防曬", "口紅", "粉底", "眼霜", "沐浴", "洗髮", "牙膏",
      "手機殼", "充電線", "耳機", "行李箱", "鞋子", "衣服", "褲子", "裙子", "帽子",
    ];
    const productMentions: Record<string, number> = {};
    for (const msg of userMessages) {
      for (const pk of productKeywords) {
        if (msg.content.includes(pk)) {
          productMentions[pk] = (productMentions[pk] || 0) + 1;
        }
      }
    }
    const hotProducts = Object.entries(productMentions)
      .map(([name, mentions]) => ({ name, mentions }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 8);

    const concernKeywords: Record<string, string> = {
      "價格太貴": "貴|太貴|便宜|降價|打折|特價",
      "等太久": "等很久|好慢|太慢|快一點|急|趕|催",
      "品質問題": "瑕疵|壞掉|破損|品質差|不好用|有問題",
      "尺寸不合": "太大|太小|不合|尺寸|版型",
      "物流延遲": "還沒到|沒收到|物流|運送|寄到哪|什麼時候到",
      "退款進度": "退款|什麼時候退|退多少|帳號",
      "操作困難": "不會用|怎麼用|操作|設定|步驟",
      "態度不滿": "態度|不理|沒回|敷衍|不滿",
    };
    const concernCounts: Record<string, number> = {};
    for (const msg of userMessages) {
      for (const [concern, pattern] of Object.entries(concernKeywords)) {
        const regex = new RegExp(pattern);
        if (regex.test(msg.content)) {
          concernCounts[concern] = (concernCounts[concern] || 0) + 1;
        }
      }
    }
    const customerConcerns = Object.entries(concernCounts)
      .map(([concern, count]) => ({ concern, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const painPoints: string[] = [];
    const suggestions: string[] = [];

    if (transferRate !== null && transferRate > 15) {
      painPoints.push(`轉人工率達 ${transferRate}%（${transferCount}/${active} 位），人工負擔偏高。`);
    }
    if (issueTypeDistribution.length > 0) {
      const returnIssues = issueTypeDistribution.find(i => i.name === "退貨退款");
      if (returnIssues && active > 0 && (returnIssues.value / active) * 100 > 20) {
        painPoints.push(`退換貨問題佔比偏高（${returnIssues.value} 位，佔 ${Math.round((returnIssues.value / active) * 100)}%）。`);
        suggestions.push("建議優化退換貨 SOP 與 AI 自動引導流程。");
      }
    }
    if (completionRate !== null && completionRate < 30 && active > 3) {
      painPoints.push(`處理完成率僅 ${completionRate}%（${resolvedCount}/${active}），待處理對話偏多。`);
      suggestions.push("建議定期巡檢對話，將已解決的對話標記結案。");
    }
    const alertTimeouts = (db.prepare(`
      SELECT COUNT(*) as cnt FROM system_alerts WHERE alert_type = 'timeout_escalation' AND created_at >= ? AND created_at <= ?
    `).get(startDate, endDate) as { cnt: number })?.cnt || 0;
    if (alertTimeouts > 0) {
      painPoints.push(`系統/外部服務超時 ${alertTimeouts} 次，可能影響客戶體驗。`);
      suggestions.push("建議檢查 API 連線與回應效率。");
    }
    if (customerConcerns.length > 0) {
      const topConcern = customerConcerns[0];
      if (topConcern.count >= 2) {
        painPoints.push(`客戶反映「${topConcern.concern}」最多（${topConcern.count} 次），需重點關注。`);
      }
    }
    if (!aiHasData && aiMsgs === 0) {
      suggestions.push("尚未啟用 AI 自動處理，建議設定 AI 回覆以減輕客服負擔。");
    }
    if (orderQueryHasData && orderQuerySuccessRate !== null && orderQuerySuccessRate < 50) {
      suggestions.push(`查單成功率僅 ${orderQuerySuccessRate}%，建議檢查訂單 API 連線或優化查單引導。`);
    }
    if (allTransferReasons.length > 0) {
      const topReason = allTransferReasons[0];
      suggestions.push(`轉人工最常見原因為「${topReason.reason}」（${topReason.count} 次），建議針對此情境優化 AI 回覆。`);
    }
    if (hotProducts.length > 0) {
      suggestions.push(`熱門詢問商品：${hotProducts.slice(0, 3).map(p => p.name).join("、")}。建議確認庫存與物流。`);
    }

    return res.json({
      kpi: {
        customerMessages: userMsgs,
        activeContacts: active,
        resolvedCount,
        completionRate,
        transferCount,
        transferRate,
        aiResolutionRate,
        aiHasData,
        orderQuerySuccessRate,
        orderQueryHasData,
        avgMessagesPerContact,
      },
      messageSplit,
      statusDistribution,
      intentDistribution,
      intentUnclassifiedPct: intentUnclassifiedPct,
      aiInsights: { painPoints, suggestions, hotProducts, customerConcerns },
      issueTypeDistribution,
      transferReasons: allTransferReasons,
      platformDistribution,
      topKeywords: topKeywordsAll.slice(0, 15),
      dailyVolume,
    });
  });

  app.get("/api/analytics/health", authMiddleware, managerOrAbove, (req: any, res) => {
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

    const alertStats = storage.getSystemAlertStats(startDate, endDate, brandId);

    const maskedTransferReasons = alertStats.transferReasonTop5.map(r => ({
      reason: maskSensitiveInfo(r.reason),
      count: r.count,
    }));

    const alertTypeLabels: Record<string, string> = {
      webhook_sig_fail: "Webhook 簽章失敗",
      dedupe_hit: "重複事件攔截",
      lock_timeout: "處理鎖逾時",
      order_lookup_fail: "訂單查詢失敗",
      timeout_escalation: "AI 超時升級",
      transfer: "轉接真人",
    };

    const alertsByTypeLabeled = alertStats.alertsByType.map(a => ({
      type: alertTypeLabels[a.type] || a.type,
      count: a.count,
    }));

    return res.json({
      webhookSigFails: alertStats.webhookSigFails,
      dedupeHits: alertStats.dedupeHits,
      lockTimeouts: alertStats.lockTimeouts,
      orderLookupFails: alertStats.orderLookupFails,
      timeoutEscalations: alertStats.timeoutEscalations,
      totalAlerts: alertStats.totalAlerts,
      transferReasonTop5: maskedTransferReasons,
      alertsByType: alertsByTypeLabeled,
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
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const { keyword, pitch, url } = req.body;
    if (!keyword) return res.status(400).json({ message: "關鍵字為必填" });
    if (!storage.updateMarketingRule(id, keyword, pitch || "", url || "")) {
      return res.status(404).json({ message: "規則不存在" });
    }
    return res.json({ success: true });
  });

  app.delete("/api/marketing-rules/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    if (!storage.deleteMarketingRule(id)) return res.status(404).json({ message: "規則不存在" });
    return res.json({ success: true });
  });

  return httpServer;
}
