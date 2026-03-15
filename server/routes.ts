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
  SHORT_IMAGE_FALLBACK,
  shouldEscalateImageSupplement,
  IMAGE_SUPPLEMENT_ESCALATE_MESSAGE,
} from "./safe-after-sale-classifier";
import { runAutoExecution, computeMainStatus } from "./meta-comment-auto-execute";
import * as riskRules from "./meta-comment-risk-rules";
import { resolveConversationState, isHumanRequestMessage, isAlreadyProvidedMessage, isLinkRequestMessage, isLinkRequestCorrectionMessage, ORDER_LOOKUP_PATTERNS, looksLikeOrderNumber, isAiHandlableIntent } from "./conversation-state-resolver";
import { buildReplyPlan, shouldNotLeadWithOrderLookup, isAftersalesComfortFirst, type ReplyPlanMode } from "./reply-plan-builder";
import { enforceOutputGuard, HANDOFF_MANDATORY_OPENING, buildHandoffReply, getHandoffReplyForCustomer } from "./phase2-output";
import { runPostGenerationGuard, isModeNoPromo, runOfficialChannelGuard, runGlobalPlatformGuard } from "./content-guard";
import { recordGuardHit, getGuardStats } from "./content-guard-stats";
import { searchOrderInfoThreeLayers, searchOrderInfoInRecentMessages, extractOrderInfoFromImage } from "./already-provided-search";
import { shouldHandoffDueToAwkwardOrRepeat } from "./awkward-repeat-handoff";
import { isRatingEligible } from "./rating-eligibility";
import db from "./db";
import { fetchOrders, lookupOrderById, lookupOrdersByDateAndFilter, fetchPages, lookupOrdersByPageAndPhone, ensurePagesCacheLoaded, refreshPagesCache, getCachedPages, getCachedPagesAge, buildProductCatalogPrompt } from "./superlanding";
import type { SuperLandingConfig } from "./superlanding";
import type { OrderInfo, Contact, ContactStatus, IssueType, MetaCommentTemplate, MetaComment } from "@shared/schema";
import { unifiedLookupById, unifiedLookupByProductAndPhone, unifiedLookupByDateAndContact, getUnifiedStatusLabel, getPaymentInterpretationForAI, shouldPreferShoplineLookup } from "./order-service";
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
import { addAiReplyJob, enqueueDebouncedAiReply } from "./queue/ai-reply.queue";
import { handleLineWebhook } from "./controllers/line-webhook.controller";
import { handleFacebookWebhook, handleFacebookVerify, type FacebookWebhookDeps } from "./controllers/facebook-webhook.controller";

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

/** Phase 1：法務／公關／詐騙風險 → 才走高風險短路；其餘情緒字不短路 */
const LEGAL_RISK_KEYWORDS = [
  "投訴", "客訴", "消保", "消費者保護", "消基會", "法律", "律師", "告你", "告你們",
  "提告", "訴訟", "報警", "警察", "公平會", "媒體", "爆料", "上新聞", "找記者",
  "詐騙", "騙子", "去死",
];
/** Phase 1：僅標記情緒，不走高風險短路；不可因這些字就 high_risk_short_circuit */
const FRUSTRATED_ONLY_KEYWORDS = [
  "爛", "很煩", "很慢", "不爽", "靠北", "幹", "他媽", "媽的", "狗屎",
  "垃圾", "廢物", "噁心", "極度不滿", "非常生氣", "太扯", "離譜", "白痴", "智障",
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

/** Phase 1：拆級為 legal_risk（才短路）／frustrated_only（不短路）／none */
function detectHighRisk(text: string): { level: "legal_risk" | "frustrated_only" | "none"; reasons: string[] } {
  const reasons: string[] = [];
  for (const kw of LEGAL_RISK_KEYWORDS) {
    if (text.includes(kw)) {
      reasons.push(`legal_risk: ${kw}`);
    }
  }
  if (reasons.length > 0) return { level: "legal_risk", reasons };
  for (const kw of FRUSTRATED_ONLY_KEYWORDS) {
    if (text.includes(kw)) {
      reasons.push(`frustrated_only: ${kw}`);
    }
  }
  if (reasons.length > 0) return { level: "frustrated_only", reasons };
  return { level: "none", reasons: [] };
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

/** 精準發圖與導購的 Chain-of-Thought 規範（與知識庫、圖片素材庫搭配使用） */
const IMAGE_PRECISION_COT_BLOCK = `

--- 【精準發圖與導購最高指導原則】---
以下為使用【知識庫】與【圖片素材庫】時的強制思考鏈，請嚴格依序執行。

步驟一（語意翻譯）：當客戶詢問商品時，極可能使用「俗稱、簡稱或錯字」（例如：空氣戰神、胖子T）。你必須先利用【知識庫】將客戶用語翻譯為標準的【官方產品名稱】。

步驟二（意圖判斷）：判斷客戶是否需要視覺輔助（例如：詢問尺寸、長相、材質、保存方式、食用方式、內容物）。若不需要發圖，則以純文字回覆即可。

步驟三（精準匹配圖片）：若需要發圖，請以【官方產品名稱】結合意圖，去比對下方【圖片素材庫】列表。確保圖片的 name、description 或 keywords 嚴格對應該官方商品或該意圖（如尺寸表、保存方式）。只選「確定屬於客戶所問商品／情境」的圖片。

步驟四（寧缺勿濫）：絕對禁止張冠李戴（例如把 A 商品的尺寸表發給詢問 B 商品的客戶）。若無確切對應的圖片，請純文字回覆即可，不要猜測發圖。若找到確切對應，請主動呼叫 send_image_to_customer，傳入該圖的 name（即下方列表的 name 欄位）。
`;

function buildImageAssetCatalog(brandId?: number): string {
  const assets = storage.getImageAssets(brandId);
  if (assets.length === 0) return "";
  const lines = assets.map((a, i) => {
    const name = a.display_name || a.original_name || "";
    const desc = (a.description || "").trim();
    const kw = (a.keywords || "").trim();
    const parts = [`#${i + 1} name: ${name}`];
    if (desc) parts.push(`description: ${desc}`);
    if (kw) parts.push(`keywords: ${kw}`);
    return parts.join(" ");
  });
  return "\n\n--- 圖片素材庫 ---\n你具備發送圖片的能力。若客戶問題用圖片回覆更清晰，且下方列表中有「與客戶所問商品／意圖確切對應」的圖片，請使用 send_image_to_customer，傳入該圖的 name。\n可用圖片（請依 name / description / keywords 精準匹配官方商品與意圖）：\n" + lines.join("\n");
}

/** 組裝 system prompt 時可傳入當前品類與 mode，用於知識 gating（甜點出貨說明僅在 sweet 時注入） */
async function getEnrichedSystemPrompt(
  brandId?: number,
  context?: { productScope?: string | null; planMode?: ReplyPlanMode }
): Promise<string> {
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
  const imageCatalog = buildImageAssetCatalog(brandId);
  const imageBlock = imageCatalog ? IMAGE_PRECISION_COT_BLOCK + imageCatalog : "";

  /** 表現層總則：像一般聊天，底線由下方規則與發送前 guard 把關 */
  const toneBlock = `

--- 回覆風格（表現層，不與下方底線衝突）---
請像一般對話一樣自然接話，減少問卷感、選單感與公告感。招呼、承接、引導時用口語短句即可，不必列點或制式開場。
公司底線（查單只收兩種方式、不講其他平台、轉人工必明講、午休/下班必明講、高風險短路、發送前 guard）由下方規則與系統發送前檢查把關，你只需在回覆中自然遵守，不需在每句前背誦規則。`;

  let returnFormUrl = "https://www.lovethelife.shop/returns";
  if (brandId) {
    const brandData = storage.getBrand(brandId);
    if (brandData?.return_form_url) returnFormUrl = brandData.return_form_url;
  }

  // Knowledge gating：甜點出貨說明僅在 productScope === "sweet" 時注入；非甜點品類禁止提及甜點較快
  const isSweet = context?.productScope === "sweet";
  const isNonSweetLocked = context?.productScope && context.productScope !== "sweet";
  let shippingLogicBlock: string;
  if (isSweet) {
    shippingLogicBlock = `- 甜點類：多為現貨，通常 3 天內出貨。客人 3 天內詢問時不要過度渲染延誤，以「幫您查詢、若有現貨會盡快安排」為主。若倉庫缺貨可自然說明可能改為預購約 7–20 工作天，並補「會盡量協助加快」。
- 其他產品：多為預售，常見 7–20 個工作天。先道歉、說明目前排單／預售，若有現貨就盡快安排；若無則誠實說明約 7–20 工作天，一定要補「會盡量幫您加快」或「這邊幫您備註加急」。不要回得像推託，要像真的在幫客人處理。`;
  } else if (isNonSweetLocked) {
    shippingLogicBlock = `- 【當前已鎖定為非甜點品類】出貨多為預售，常見 7–20 個工作天。先道歉、說明排單／預售，補「會盡量幫您加快／備註加急」。禁止提及甜點、甜點較快、3 天內出貨、巴斯克、蛋糕等；不得說「甜點通常比較快」或任何甜點類出貨說明。`;
  } else {
    shippingLogicBlock = `- 出貨時程依商品類型與庫存（現貨較快、預售約 7–20 工作天）。未鎖定品類前勿主動說「甜點比較快」或「甜點 3 天」；僅在客人明確為甜點類且已鎖定為甜點時，才可說甜點通常較快。
- 其他產品：多為預售，常見 7–20 個工作天。先道歉、說明排單／預售，補「會盡量幫您加快」。`;
  }

  const handoffBlock = `

--- 訂單出貨與退換貨規則（營運邏輯版，嚴格遵守）---
總原則：第一優先「先接住客人」。問出貨、等太久、想取消、想退貨、不耐煩時，先一句自然承接與安撫。查單只收兩種資料，查不到就轉人工；禁止提及其他平台、官方通路、該平台等任何平台來源話術。

一、商品類型與出貨邏輯
` + shippingLogicBlock + `

二、詢問訂單／出貨進度（查單唯一合法輸入，底線不變）
【最高指導原則】當用戶提供的資訊不完整（例如：只有商品名沒有電話、或只有電話沒有商品名）時，**絕對禁止**立刻呼叫轉人工工具或判定 handoff。你必須以友善的客服口吻**主動追問**缺少的資訊（例如：「好的，請提供您購買天鷹包時留的手機號碼喔！」「請問您買的是哪一款商品呢？再提供下單時留的手機號碼我就能幫您查～」），直到湊齊參數為止。僅在客戶**明確要求找真人**、客訴、或**多次追問仍無效**時才可轉人工。
- 觸發：訂單、查單、出貨、物流、單號、出貨進度、還沒寄、等太久等。
- 只允許引導兩種方式之一：① 訂單編號；② 產品名稱＋手機號碼。不得再問其他欄位（如購買頁面、收件資料、官方通路等）。
- 回覆方式：用一兩句自然承接即可（如「好喔我幫您查一下」「不好意思久等～我來看一下進度」），再依情境只問其中一種，不要列成選單或一次丟很多欄位。
- 有查到：依商品類型分流回覆（甜點 3 天節奏／其他 7–20 工作天），語氣柔和，可加會盡快安排／備註加急。
- 查不到：直接轉人工，明講「幫您轉接真人專員處理」。不得再繞、不得再問其他問法、不得提及其他平台或官方通路。
- 同一句或同輪已取得訂單編號或產品＋手機即不得再重問。若近期訊息中客人**已提供**手機或訂單編號，直接使用於查詢，**勿再請客人「確認手機是 XXX 對嗎」或重複問同一項**；查詢失敗／逾時時可說明原因後重試，或僅補問**尚未提供**的資訊（如下單日期）以縮小範圍。
- **已有訂單編號且客戶說想等時**：若對話中**已出現訂單編號且你已查詢／回覆過該筆**，且客戶已表態「想等」「願意等」，則**禁止再問**商品名稱、訂單明細、截圖；直接依既有訂單回覆（如已備註加急、出貨會通知即可），勿補問任何查單欄位，避免客戶困惑。

三、退換貨／取消（分型處理）
- 久候型（等太久、不想等、想取消但尚未堅持）：先安撫、先查詢出貨、說明能否加急或約需 7–20 工作天、優先嘗試留單。不要一開口就丟表單、不要一開口就轉人工。
- 商品問題型（瑕疵、損壞、錯貨、缺件、漏寄、收到有問題）：一律先道歉、表示會協助處理，導向正式退換貨／售後表單（售後表單：${returnFormUrl}），必要時轉人工。
- 明確堅持退款退貨（我就是要退、直接幫我退、不要其他方案等）：可轉人工或提供表單，但仍先一句安撫再處理。

四、轉人工條件
可轉：明確要求真人；明確堅持退款／退貨／取消且不接受等待；商品損壞／瑕疵且情況較複雜；補償、爭議、金流異常；情緒高風險、投訴、公開負評風險；AI 已嘗試一輪仍無法推進；查單查不到。
不可太快轉：不要只因為第一次問進度、第一次抱怨久候、語氣有點急、或只提到「退貨」兩字但尚未說明原因就轉人工。
【重要】「真人感」≠「轉真人客服」：真人感是指回覆語氣自然、溫暖、像真人，**絕不表示要轉接真人**。只有當顧客**明確說出**要轉人工、找真人、找主管、不要機器人時，才呼叫 transfer_to_human。**禁止**因以下情況就轉接：打招呼（在嗎、哈囉）、一般情緒或催促（太誇張了、等一下、怎麼還沒）、短句、或僅因希望回覆有人味而轉接。**禁止**因查單時「用戶只給了商品名還沒給電話」或「只給了部分資訊」就呼叫 transfer_to_human；必須先追問缺少的項目。

五、語氣與禁止
- 像真人對話即可：自然短句、口語承接，不必制式開場或列點問卷。例：「我先幫您確認看看」「這邊幫您查一下」「不好意思久等～」「有現貨會盡快幫您安排」。此處「像真人」僅指語氣，不觸發轉接。
- 全域禁止（發送前也會檢查）：不得出現「其他平台」「該平台」「官方通路」「非官方」「若是其他平台購買」「建議向該平台客服確認」「不是我們這邊的單」等任何平台來源判斷。能查就查，查不到就轉人工，不討論平台來源。

--- AI 身分透明 ---
在適當時機自然讓客戶知道你是 AI，嚴禁假裝是真人。客戶要求轉真人時，自然回覆並呼叫 transfer_to_human。
訂單查詢回傳 found=false 時：告知查不到後直接轉接真人專員，不要再問其他問法。`;

  const schedule = storage.getGlobalSchedule();
  const unavailableReason = assignment.getUnavailableReason();
  const humanHoursBlock = `

--- 人工客服服務時段（僅影響真人回覆，你 AI 24 小時在線）---
人工客服可接案時段：上班 ${schedule.work_start_time}–${schedule.work_end_time}，午休 ${schedule.lunch_start_time}–${schedule.lunch_end_time}，下班 ${schedule.work_end_time} 後無人接案。
當你要呼叫 transfer_to_human 時：若目前是午休或已下班，請在回覆中主動告知客人「目前是午休／已超過服務時間，轉人工可能暫時沒人即時回覆，需求會先記錄，專人會在午休後／上班後盡快處理，請稍候。」不要假裝有人正在看。`;
  const nowStatusHint = unavailableReason === "weekend"
    ? "【目前狀態】現在為週休二日非服務時間，若轉人工請主動提醒客人需求已記錄，下個工作日會處理。"
    : unavailableReason === "lunch"
      ? `【目前狀態】現在為午休時段（${schedule.lunch_start_time}–${schedule.lunch_end_time}），若轉人工請主動提醒客人稍後由專人回覆。`
      : unavailableReason === "after_hours"
        ? `【目前狀態】目前已超過人工服務時間（${schedule.work_end_time} 後），若轉人工請主動提醒客人需求已記錄，上班後會處理。`
        : "";
  const humanHoursBlockWithStatus = humanHoursBlock + (nowStatusHint ? "\n" + nowStatusHint : "");

  return basePrompt + brandBlock + toneBlock + handoffBlock + humanHoursBlockWithStatus + catalogBlock + knowledgeBlock + imageBlock;
}

const contactProcessingLocks = new Map<number, Promise<void>>();

const messageDebounceBuffers = new Map<number, { texts: string[]; timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
/** 文字合併防抖：過短會合併不到連續訊息，過長會讓用戶覺得回覆慢。1.2 秒可兼顧合併與體感速度 */
const DEBOUNCE_MS = 1200;

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

/** 依目前人工服務時段設定，回傳轉人工無人可接時的系統提示（週末／午休／下班／全員忙碌） */
function getTransferUnavailableSystemMessage(reason: "weekend" | "lunch" | "after_hours" | "all_paused" | null): string {
  const schedule = storage.getGlobalSchedule();
  if (reason === "weekend") return "目前為假日非服務時間，您的需求我已先幫您記錄，我們將於下個工作日儘快為您處理，請您稍等唷。";
  if (reason === "lunch") return `目前客服同仁正在午休時段（${schedule.lunch_start_time}–${schedule.lunch_end_time}），我先幫您記錄需求，專人會在午休後盡快為您確認與回覆唷。`;
  if (reason === "after_hours") return "目前已超過客服服務時間，您的需求我已先幫您記錄，專人將於上班時段儘快為您處理，請您稍等唷。";
  return "目前人工客服暫時忙碌中，已幫您排入待處理清單，上班後會依序回覆。";
}

/** Phase 2：從訊息推斷商品範圍，用於 product_scope_locked（存 bag/sweet） */
function getProductScopeFromMessage(text: string): "bag" | "sweet" | null {
  const t = (text || "").trim();
  if (/包包|通勤包|城市輕旅|輕旅包|托特|後背包|背包/i.test(t)) return "bag";
  if (/甜點|巴斯克|蛋糕|餅乾|點心|禮盒/i.test(t)) return "sweet";
  return null;
}

async function withContactLock<T>(contactId: number, fn: () => Promise<T>): Promise<T> {
  const existing = contactProcessingLocks.get(contactId);
  let resolve: () => void;
  const lockPromise = new Promise<void>(r => { resolve = r; });
  contactProcessingLocks.set(contactId, lockPromise);
  if (existing) {
    /** 前一個 AI 處理最長等 25 秒，避免「回覆要等兩分鐘」；逾時則並行跑，由後端控管並發 */
    const timeout = new Promise<void>(r => setTimeout(r, 25000));
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

/** 將 stream chunk 的 delta 合併成完整 message（用於 content + tool_calls 累積） */
function mergeStreamDelta(
  prev: OpenAI.Chat.Completions.ChatCompletionMessage,
  delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta
): OpenAI.Chat.Completions.ChatCompletionMessage {
  const out: OpenAI.Chat.Completions.ChatCompletionMessage = { ...prev, role: prev.role || (delta.role as any) || "assistant" };
  if (delta.content != null && delta.content !== "") {
    out.content = (out.content || "") + delta.content;
  }
  if (delta.tool_calls != null && delta.tool_calls.length > 0) {
    const arr = (out.tool_calls || []) as OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
    for (const d of delta.tool_calls) {
      const i = d.index ?? arr.length;
      while (arr.length <= i) arr.push({ id: "", type: "function", function: { name: "", arguments: "" } });
      const t = arr[i];
      if (d.id != null) (t as any).id = d.id;
      if (d.function != null) {
        if (d.function.name != null) t.function.name = (t.function.name || "") + d.function.name;
        if (d.function.arguments != null) t.function.arguments = (t.function.arguments || "") + d.function.arguments;
      }
    }
    out.tool_calls = arr;
  }
  return out;
}

/**
 * 呼叫 OpenAI 並以串流回傳：每收到 content delta 就 broadcast message_chunk，
 * 前端可即時顯示打字效果。回傳完整 message（content 或 tool_calls）。
 */
async function runOpenAIStream(
  openai: OpenAI,
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "stream">,
  contactId: number,
  brandId: number | undefined,
  signal?: AbortSignal
): Promise<OpenAI.Chat.Completions.ChatCompletionMessage> {
  const stream = await openai.chat.completions.create(
    { ...params, stream: true },
    { signal: signal as any }
  );
  let message: OpenAI.Chat.Completions.ChatCompletionMessage = { role: "assistant", content: "" };
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice?.delta) continue;
    message = mergeStreamDelta(message, choice.delta);
    if (choice.delta.content) {
      broadcastSSE("message_chunk", { contact_id: contactId, brand_id: brandId, chunk: choice.delta.content });
    }
  }
  return message;
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

  // 一頁商店全量同步（fetchPages/refreshPagesCache）會拉取大量資料，在 500MB RAM 環境易導致假死。
  // 僅在明確設定 ENABLE_SYNC=true 時才啟用開機延後同步與每小時定時同步（預設關閉，保證客服主系統存活）。
  if (process.env.ENABLE_SYNC === "true") {
    setTimeout(() => {
      refreshPagesCache(getSuperLandingConfig()).catch(() => {});
    }, 30 * 1000);
    setInterval(() => {
      const freshConfig = getSuperLandingConfig();
      refreshPagesCache(freshConfig).catch(() => {});
    }, 60 * 60 * 1000);
  } else {
    console.log("[server] ENABLE_SYNC 未設為 true，已略過一頁商店開機/定時全量同步（可設 ENABLE_SYNC=true 啟用）");
  }

  // 輕量健康檢查：不需登入，供 Railway / 負載平衡器確認服務已就緒
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

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
    const removeClient = () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
      console.log("[SSE] Client disconnected, remaining:", sseClients.size);
    };
    req.on("close", removeClient);
    res.on("error", () => { removeClient(); });
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
      const fbContacts = contacts.filter(c => c.platform === "messenger" && c.platform_user_id);
      let lineUpdated = 0;
      let lineFailed = 0;
      for (const contact of lineContacts) {
        const token = getLineTokenForContact(contact);
        if (!token) { lineFailed++; continue; }
        try {
          const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${contact.platform_user_id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (profileRes.ok) {
            const profile = await profileRes.json() as { displayName?: string; pictureUrl?: string };
            if (profile.displayName || profile.pictureUrl) {
              const displayName = profile.displayName || (contact.display_name ?? "LINE用戶");
              const avatarUrl = profile.pictureUrl ?? contact.avatar_url ?? null;
              storage.updateContactProfile(contact.id, displayName, avatarUrl);
              lineUpdated++;
            }
          } else {
            lineFailed++;
          }
          await new Promise(r => setTimeout(r, 100));
        } catch (_e) {
          lineFailed++;
        }
      }
      let fbUpdated = 0;
      let fbFailed = 0;
      for (const contact of fbContacts) {
        const token = getFbTokenForContact(contact);
        if (!token) { fbFailed++; continue; }
        try {
          const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(contact.platform_user_id)}?fields=first_name,last_name,name,picture.type(large)&access_token=${encodeURIComponent(token)}`;
          const profileRes = await fetch(url);
          if (profileRes.ok) {
            const profile = await profileRes.json() as { first_name?: string; last_name?: string; name?: string; picture?: { data?: { url?: string } } };
            const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim()
              || (typeof profile.name === "string" ? profile.name.trim() : undefined);
            const avatarUrl = profile.picture?.data?.url || null;
            if (fullName || avatarUrl) {
              storage.updateContactProfile(contact.id, fullName || (contact.display_name ?? "FB用戶"), avatarUrl ?? contact.avatar_url ?? null);
              fbUpdated++;
            }
          } else {
            fbFailed++;
          }
          await new Promise(r => setTimeout(r, 100));
        } catch (_e) {
          fbFailed++;
        }
      }
      return res.json({
        success: true,
        line: { total: lineContacts.length, updated: lineUpdated, failed: lineFailed },
        facebook: { total: fbContacts.length, updated: fbUpdated, failed: fbFailed },
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get("/api/internal/guard-stats", authMiddleware, (req: any, res) => {
    if (!["super_admin", "marketing_manager"].includes(req.session?.userRole)) {
      return res.status(403).json({ message: "權限不足" });
    }
    return res.json(getGuardStats());
  });

  /** 供確認線上 deploy 與重啟時間（不需登入） */
  app.get("/api/version", (_req, res) => {
    const startTime = (globalThis as any).__serverStartTime ?? null;
    res.json({
      version: process.env.VERSION || process.env.npm_package_version || "1.0.0",
      commit: process.env.COMMIT_SHA || "unknown",
      startTime,
    });
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

  /** Meta 粉專批次串接：拉出目前 Meta 帳號可管理的粉專列表（需傳入 User Access Token） */
  app.post("/api/meta/batch/available-pages", authMiddleware, superAdminOnly, async (req: any, res) => {
    const { user_access_token } = req.body || {};
    if (!user_access_token || typeof user_access_token !== "string") {
      return res.status(400).json({ message: "請提供 user_access_token" });
    }
    try {
      const url = `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(user_access_token)}`;
      const fbRes = await fetch(url);
      if (!fbRes.ok) {
        const errBody = await fbRes.text();
        return res.status(400).json({ message: "Meta API 失敗", detail: errBody.slice(0, 200) });
      }
      const data = (await fbRes.json()) as { data?: { id: string; name: string; access_token: string }[] };
      const pages = (data.data || []).map((p) => ({
        page_id: p.id,
        page_name: p.name || p.id,
        access_token: p.access_token,
      }));
      return res.json({ pages });
    } catch (e: any) {
      return res.status(500).json({ message: "無法取得粉專列表", detail: e?.message });
    }
  });

  /** Meta 粉專批次串接：依選取粉專與品牌一鍵建立 channel + meta_page_settings（預設 AI 關、自動留言關、只收訊） */
  app.post("/api/meta/batch/import", authMiddleware, superAdminOnly, async (req: any, res) => {
    const { brand_id: brandId, pages: pagesInput } = req.body || {};
    const bid = brandId != null ? parseInt(String(brandId), 10) : NaN;
    if (!Number.isInteger(bid) || bid <= 0) {
      return res.status(400).json({ message: "請提供有效的 brand_id" });
    }
    const brand = storage.getBrand(bid);
    if (!brand) return res.status(404).json({ message: "品牌不存在" });
    if (!Array.isArray(pagesInput) || pagesInput.length === 0) {
      return res.status(400).json({ message: "請提供 pages 陣列（至少一筆）" });
    }
    const results: { page_id: string; page_name: string; channel_id?: number; settings_id?: number; error?: string }[] = [];
    for (const p of pagesInput) {
      const page_id = p?.page_id != null ? String(p.page_id) : "";
      const page_name = p?.page_name != null ? String(p.page_name) : page_id || "未命名";
      const access_token = p?.access_token != null ? String(p.access_token) : "";
      if (!page_id || !access_token) {
        results.push({ page_id: page_id || "?", page_name, error: "缺少 page_id 或 access_token" });
        continue;
      }
      const existing = metaCommentsStorage.getMetaPageSettingsByPageId(page_id);
      if (existing) {
        results.push({ page_id, page_name, error: "該粉專已存在" });
        continue;
      }
      try {
        const channel = await storage.createChannel(bid, "messenger", page_name, page_id, access_token, "");
        if (channel.is_ai_enabled !== 0) await storage.updateChannel(channel.id, { is_ai_enabled: 0 });
        const settings = metaCommentsStorage.createMetaPageSettings({
          page_id,
          page_name,
          brand_id: bid,
          auto_reply_enabled: 0,
          auto_hide_sensitive: 0,
          auto_route_line_enabled: 0,
        });
        results.push({ page_id, page_name, channel_id: channel.id, settings_id: settings.id });
      } catch (err: any) {
        results.push({ page_id, page_name, error: err?.message || "建立失敗" });
      }
    }
    return res.json({ results });
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

  app.post("/api/brands", authMiddleware, managerOrAbove, async (req, res) => {
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

  app.put("/api/brands/:id", authMiddleware, managerOrAbove, async (req, res) => {
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

  app.delete("/api/brands/:id", authMiddleware, managerOrAbove, async (req, res) => {
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

  /** 新增渠道自動驗證器：儲存前驗證 LINE access_token 是否有效 */
  async function validateLineAccessToken(token: string): Promise<boolean> {
    const t = (token || "").trim();
    if (!t) return false;
    try {
      const res = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${t}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  app.post("/api/brands/:id/channels", authMiddleware, managerOrAbove, async (req, res) => {
    const brandId = parseIdParam(req.params.id);
    if (brandId === null) return res.status(400).json({ message: "無效的 ID" });
    const { platform, channel_name, bot_id, access_token, channel_secret } = req.body;
    if (!platform || !channel_name) return res.status(400).json({ message: "平台與頻道名稱為必填" });
    if (!["line", "messenger"].includes(platform)) return res.status(400).json({ message: "平台須為 line 或 messenger" });
    if (platform === "line" && access_token) {
      const valid = await validateLineAccessToken(String(access_token));
      if (!valid) {
        return res.status(400).json({ message: "LINE Token 無效或已過期，請重新確認" });
      }
    }
    const channel = await storage.createChannel(brandId, platform, channel_name, bot_id, access_token, channel_secret);
    return res.json({ success: true, channel });
  });

  app.put("/api/channels/:id", authMiddleware, managerOrAbove, async (req, res) => {
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
    if (is_ai_enabled !== undefined) data.is_ai_enabled = (is_ai_enabled === true || is_ai_enabled === 1) ? 1 : 0;
    if (brand_id !== undefined) data.brand_id = brand_id;
    if (access_token !== undefined) {
      const existing = storage.getChannel(id);
      const isLine = (platform ?? existing?.platform) === "line";
      const tokenChanged = !existing || (String(access_token || "").trim() !== String(existing.access_token || "").trim());
      if (isLine && access_token && tokenChanged) {
        const valid = await validateLineAccessToken(String(access_token));
        if (!valid) {
          return res.status(400).json({ message: "LINE Token 無效或已過期，請重新確認" });
        }
      }
    }
    if (!(await storage.updateChannel(id, data))) return res.status(404).json({ message: "頻道不存在" });
    return res.json({ success: true });
  });

  app.delete("/api/channels/:id", authMiddleware, managerOrAbove, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    if (!(await storage.deleteChannel(id))) return res.status(404).json({ message: "頻道不存在" });
    return res.json({ success: true });
  });

  /** 綁定前／表單內驗證：僅用 Token 呼叫 LINE API，不寫入 DB。可帶 bot_id 比對是否與 LINE 回傳的 userId 一致。 */
  app.post("/api/channels/verify-line", authMiddleware, managerOrAbove, async (req, res) => {
    const { access_token, bot_id: formBotId } = req.body || {};
    if (!access_token || typeof access_token !== "string" || !access_token.trim()) {
      return res.json({ success: false, message: "請先填寫 Channel Access Token" });
    }
    try {
      const verifyRes = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${access_token.trim()}` },
      });
      if (!verifyRes.ok) {
        const errBody = await verifyRes.text();
        return res.json({ success: false, message: `LINE 驗證失敗 (${verifyRes.status})：Token 無效或已過期。${errBody.slice(0, 200)}` });
      }
      const botInfo = (await verifyRes.json()) as { userId?: string; displayName?: string; basicId?: string };
      const botUserId = (botInfo.userId || "").trim();
      let message = `LINE 連線成功！Bot: ${botInfo.displayName || botInfo.basicId || "OK"}，userId（即 Webhook destination）= ${botUserId || "(空)"}`;
      if (formBotId != null && typeof formBotId === "string") {
        const a = formBotId.trim();
        const b = botUserId;
        const match = a === b || a === (b.startsWith("U") ? b.slice(1) : "U" + b) || b === (a.startsWith("U") ? a.slice(1) : "U" + a);
        if (!match && botUserId) {
          message += `。您填的 Bot ID 與 LINE 回傳的 userId 不一致，Webhook 時請將 Bot ID 設為：${botUserId}`;
        } else if (match) {
          message += "，與您填的 Bot ID 一致，綁定後可正常收發。";
        }
      }
      return res.json({ success: true, message, botUserId: botUserId || undefined });
    } catch (err: any) {
      return res.json({ success: false, message: `連線失敗：${err.message}` });
    }
  });

  /** 批次修正：將「某渠道下所有聯絡人」改歸到指定品牌（用於 LINE 錯歸後一次拉回正確品牌） */
  app.post("/api/admin/contacts/reassign-by-channel", authMiddleware, managerOrAbove, async (req, res) => {
    const channelId = req.body?.channel_id != null ? parseInt(String(req.body.channel_id), 10) : null;
    const brandId = req.body?.brand_id != null ? parseInt(String(req.body.brand_id), 10) : null;
    if (channelId == null || brandId == null || isNaN(channelId) || isNaN(brandId)) {
      return res.status(400).json({ message: "請提供 channel_id 與 brand_id" });
    }
    const channel = storage.getChannel(channelId);
    if (!channel) return res.status(404).json({ message: "渠道不存在" });
    const brand = storage.getBrand(brandId);
    if (!brand) return res.status(404).json({ message: "品牌不存在" });
    const updated = storage.reassignContactsByChannel(channelId, brandId);
    return res.json({ success: true, updated, message: `已將 ${updated} 位聯絡人改歸到「${brand.name}」` });
  });

  app.post("/api/brands/:id/test-superlanding", authMiddleware, managerOrAbove, async (req, res) => {
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

  app.post("/api/brands/:id/test-shopline", authMiddleware, managerOrAbove, async (req, res) => {
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

  app.post("/api/channels/:id/test", authMiddleware, managerOrAbove, async (req, res) => {
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
        let userMessage = `Facebook 驗證失敗 (${fbRes.status}): ${errBody}`;
        try {
          const errJson = JSON.parse(errBody) as { error?: { code?: number; message?: string } };
          if (errJson?.error?.code === 100 && /permission|pages_read_engagement|Page Public|review/i.test(errJson.error.message || "")) {
            userMessage = "Facebook 應用程式權限不足：此 Token 所屬的 Facebook App 尚未取得所需權限（例如 pages_read_engagement）或尚未通過 App 審核。請至 Facebook 開發者後台 → 應用程式審查，申請「粉絲專頁公開內容存取」或相關權限，或確認 App 已從「開發中」切換為「上線」。詳見：https://developers.facebook.com/docs/apps/review";
          }
        } catch (_e) { /* 非 JSON 則用原訊息 */ }
        return res.json({ success: false, message: userMessage });
      } catch (err: any) {
        return res.json({ success: false, message: `連線失敗: ${err.message}` });
      }
    }
    return res.json({ success: false, message: `暫不支援 ${channel.platform} 頻道測試` });
  });

  /** 為 FB 粉專訂閱 feed（貼文與留言），留言才會送進 Webhook；需 Page Access Token 具 pages_manage_metadata */
  app.post("/api/channels/:id/subscribe-feed", authMiddleware, managerOrAbove, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const channel = storage.getChannel(id);
    if (!channel) return res.status(404).json({ message: "頻道不存在" });
    if (channel.platform !== "messenger") return res.status(400).json({ message: "僅支援 Facebook Messenger 渠道" });
    const pageId = (channel.bot_id || "").trim();
    const token = (channel.access_token || "").trim();
    if (!pageId || !token) return res.status(400).json({ message: "請先設定 Bot ID (Page ID) 與 Page Access Token" });
    try {
      const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=feed,messages&access_token=${encodeURIComponent(token)}`;
      const subRes = await fetch(url, { method: "POST" });
      const bodyText = await subRes.text();
      if (subRes.ok) {
        const data = JSON.parse(bodyText || "{}") as { success?: boolean };
        if (data.success !== false) {
          return res.json({ success: true, message: "已為此粉專訂閱 feed（貼文與留言），貼文底下留言應會送進留言收件匣。請到粉專貼文留一則言測試。" });
        }
      }
      const errMsg = bodyText.slice(0, 400);
      console.log("[FB] subscribe-feed failed:", subRes.status, errMsg);
      return res.json({ success: false, message: `訂閱失敗 (${subRes.status})：${errMsg || subRes.statusText}` });
    } catch (e: any) {
      console.error("[FB] subscribe-feed error:", e?.message);
      return res.status(500).json({ message: e?.message || "訂閱失敗" });
    }
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
    const messages = storage.getMessages(contactId, { limit: 20 });
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
    const routeStart = Date.now();
    const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
    const assignedToMe = req.query.assigned_to_me === "1" || req.query.assigned_to_me === "true";
    const needReplyFirst = req.query.need_reply_first === "1" || req.query.need_reply_first === "true";
    const userId = req.session?.userId;
    const assignedToUserId = assignedToMe && userId ? userId : undefined;
    const agentIdForFlags = userId ?? undefined;
    const limitParam = req.query.limit != null ? parseInt(String(req.query.limit), 10) : undefined;
    const offsetParam = req.query.offset != null ? parseInt(String(req.query.offset), 10) : undefined;
    const limit = (limitParam > 0 && limitParam <= 500) ? limitParam : 100;
    const offset = (offsetParam != null && offsetParam >= 0) ? offsetParam : 0;
    let contacts = storage.getContacts(brandId, assignedToUserId, agentIdForFlags, limit, offset);
    const afterGet = Date.now();
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
    const totalMs = Date.now() - routeStart;
    if (totalMs > 2000) {
      console.warn(`[api/contacts] slow: total=${totalMs}ms getContacts=${afterGet - routeStart}ms serialize=${Date.now() - afterGet}ms n=${withFlags.length}`);
    }
    return res.json(withFlags);
  });

  app.get("/api/contacts/:id", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const contact = storage.getContact(id) as any;
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    // GET 必須冪等：禁止在讀取時寫入 DB 或廣播 SSE，避免「讀取→寫入→廣播→重新讀取」死循環。
    // AI 建議僅在 Webhook 新訊息或客服手動觸發時更新，不在此處。
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
    // 按鈕標示「1 顆星」～「5 顆星」：客戶一眼知道點下去代表幾分；用文字避免桌面版 emoji 顯示異常
    const starButtons = [1, 2, 3, 4, 5].map((score) => ({
      type: "button",
      action: {
        type: "postback",
        label: `${score} 顆星`,
        data: `action=${actionPrefix}&ticket_id=${contactId}&score=${score}`,
        displayText: `${"⭐".repeat(score)}`,
      },
      style: "link",
      height: "md",
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
      altText: ratingType === "ai" ? "AI 客服滿意度調查（請點選 1～5 顆星）" : "真人客服滿意度調查（請點選 1～5 顆星）",
      contents: {
        type: "bubble",
        size: "kilo",
        header: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: headerText, weight: "bold", size: "lg", color: headerColor, align: "center" },
            { type: "text", text: "您的回饋對我們很重要", size: "xs", color: "#888888", align: "center", margin: "4px" },
          ],
          paddingAll: "16px",
          backgroundColor: bgColor,
        },
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: bodyText, size: "sm", color: "#333333", wrap: true, align: "center" },
            { type: "separator", margin: "lg" },
            { type: "text", text: "1 ＝ 很不滿意　　5 ＝ 非常滿意", size: "xs", color: "#666666", align: "center", margin: "sm" },
            { type: "text", text: "由左到右：1 顆星（最低）～ 5 顆星（最高）", size: "xs", color: "#1DB446", align: "center", margin: "4px", weight: "bold" },
            { type: "text", text: "請點選下方一個選項（點哪個就代表幾分）", size: "xs", color: "#AAAAAA", align: "center", margin: "4px" },
          ],
          paddingAll: "16px",
        },
        footer: {
          type: "box",
          layout: "horizontal",
          contents: starButtons,
          spacing: "sm",
          paddingAll: "12px",
        },
      },
    };
  }

  /** 僅回傳該聯絡人對應渠道的 LINE Token，絕不 fallback 到全域 .env Token（多租戶隔離） */
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
    return null;
  }

  function getFbTokenForContact(contact: { channel_id?: number | null; brand_id?: number | null }): string | null {
    if (contact.channel_id) {
      const channel = storage.getChannel(contact.channel_id);
      if (channel?.platform === "messenger" && channel?.access_token) return channel.access_token;
    }
    if (contact.brand_id) {
      const channels = storage.getChannelsByBrand(contact.brand_id);
      const fbChannel = channels.find(c => c.platform === "messenger" && c.access_token);
      if (fbChannel?.access_token) return fbChannel.access_token;
    }
    return null;
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
      storage.updateContactConversationFields(id, { customer_goal_locked: null });
      const contactForRating = storage.getContact(id);
      if (contactForRating && isRatingEligible({ contact: contactForRating, state: null })) {
        let ratingSent = false;
        if (contactForRating.needs_human === 1 && contactForRating.cs_rating == null) {
          if (contactForRating.platform === "line") {
            const token = getLineTokenForContact(contactForRating);
            if (token) {
              try {
                await sendRatingFlexMessage(contactForRating, "human");
                storage.createMessage(id, contactForRating.platform, "system", "(系統提示) 已自動發送真人客服滿意度調查卡片給客戶");
                const now = new Date().toISOString().replace("T", " ").substring(0, 19);
                storage.updateContactConversationFields(id, { rating_invited_at: now });
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
                const now = new Date().toISOString().replace("T", " ").substring(0, 19);
                storage.updateContactConversationFields(id, { rating_invited_at: now });
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

  app.put("/api/contacts/:id/case-priority", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const v = req.body?.case_priority;
    const priority = v === undefined || v === null || v === "" ? null : Number(v);
    if (priority !== null && (Number.isNaN(priority) || priority < 1 || priority > 5)) {
      return res.status(400).json({ message: "case_priority 須為 1–5 或 null" });
    }
    storage.updateContactCasePriority(id, priority);
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
    /** 手動轉回 AI ＝ 一次新的開始：清掉轉人工期間的對話狀態與標籤，避免 AI 沿用「待人工」脈絡 */
    storage.updateContactConversationFields(contactId, {
      product_scope_locked: null,
      customer_goal_locked: null,
      human_reason: null,
      return_stage: 0,
      resolution_status: "open",
      waiting_for_customer: null,
    });
    const tags = JSON.parse(contact.tags || "[]") as string[];
    const withoutPending = tags.filter((t) => t !== "午休待處理");
    if (withoutPending.length !== tags.length) storage.updateContactTags(contactId, withoutPending);
    const prevAgentId = contact.assigned_agent_id;
    storage.updateContactAssignment(contactId, null, undefined, undefined, 0);
    if (prevAgentId != null) assignment.syncAgentOpenCases(prevAgentId);
    broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
    console.log(`[Restore AI] contact ${contactId} 已恢復 AI 接管（一次新的開始，已清除轉人工狀態與分配）`);
    return res.json({ success: true, status: "ai_handling" });
  });

  app.post("/api/contacts/:id/send-rating", authMiddleware, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "無效的 ID" });
    const ratingType = (req.body?.type === "ai" ? "ai" : "human") as "human" | "ai";
    const contact = storage.getContact(id);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    if (contact.platform !== "line") {
      return res.status(400).json({ message: "僅支援 LINE 平台" });
    }
    // 人工重新發送時：若該客戶已評過該類型，先清除舊評分，再發新卡，客戶即可再評一次（僅一次）
    if (ratingType === "ai" && contact.ai_rating != null) {
      storage.clearContactAiRating(id);
    }
    if (ratingType === "human" && contact.cs_rating != null) {
      storage.clearContactCsRating(id);
    }
    const token = getLineTokenForContact(contact);
    if (!token) {
      return res.status(400).json({ message: "尚未設定 LINE Channel Access Token" });
    }
    try {
      await sendRatingFlexMessage(contact, ratingType);
      const typeLabel = ratingType === "ai" ? "AI 客服" : "真人客服";
      storage.createMessage(id, contact.platform, "system", `(系統提示) 已手動發送${typeLabel}滿意度調查卡片給客戶`);
      broadcastSSE("contacts_updated", { contact_id: id });
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
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 80, 1), 500);
    const beforeId = parseInt(req.query.before_id as string) || undefined;
    return res.json(storage.getMessages(contactId, { limit, beforeId: beforeId && beforeId > 0 ? beforeId : undefined }));
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

  app.get("/api/contacts/:id/active-order", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "無效的 ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "聯絡人不存在" });
    const ctx = storage.getActiveOrderContext(contactId);
    return res.json(ctx ? { active_order: ctx } : { active_order: null });
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

  async function downloadLineContent(
    messageId: string,
    fallbackExt: string,
    channelAccessToken?: string | null,
    channelIdForLog?: number | null
  ): Promise<string | null> {
    const token = channelAccessToken ?? null;
    if (!token || (typeof token === "string" && token.trim() === "")) {
      const hint = channelIdForLog == null
        ? "本則 destination 未對到任何渠道或對到的渠道未填 Token。請看日誌上方 [WEBHOOK] NO MATCH 列出的 channel_id／名稱／bot_id，將「要收此機器人」的渠道 Bot ID 設為該 destination 並填 Token。"
        : "請到後台 設定→品牌與渠道，找到 channel_id=" + channelIdForLog + " 並填寫 Channel Access Token。";
      console.error("[downloadLineContent] Token 防呆：access_token 為空或未定義，跳過 Get Content 請求 — messageId:", messageId, "channelId:", channelIdForLog ?? "unknown", "→", hint);
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
          console.error("[LINE API Error] Channel ID:", channelIdForLog ?? "unknown", "Status:", resp.status, errText);
          console.error(`[downloadLineContent] Attempt ${attempt}/${maxRetries} failed: HTTP ${resp.status} - ${errText} (msgId: ${messageId})`);
          if (resp.status === 404 || resp.status === 401 || resp.status === 403) break;
          if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
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
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
          console.log("[downloadLineContent] 已自動建立目錄:", uploadDir);
        }
        try {
          fs.writeFileSync(filePath, buffer);
        } catch (writeErr: any) {
          console.error("[downloadLineContent] 寫入檔案失敗 — path:", filePath, "error.message:", writeErr?.message, "error.code:", writeErr?.code, "channelId:", channelIdForLog ?? "unknown");
          if (writeErr?.stack) console.error("[downloadLineContent] writeFileSync stack:", writeErr.stack);
          return null;
        }
        console.log(`[downloadLineContent] Success: ${filename} (${buffer.length} bytes, attempt ${attempt})`);
        return `/uploads/${filename}`;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const cause = err?.cause != null ? (err.cause?.message ?? String(err.cause)) : "";
        const stack = err?.stack ?? "";
        console.error("[downloadLineContent] Attempt", attempt, "/", maxRetries, "catch — messageId:", messageId, "error.message:", msg, "error.name:", err?.name, "error.cause:", cause, "channelId:", channelIdForLog ?? "unknown");
        if (stack) console.error("[downloadLineContent] catch stack:", stack);
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

  async function imageFileToDataUri(imageFilePath: string): Promise<string | null> {
    try {
      const absPath = path.join(getDataDir(), imageFilePath.startsWith("/") ? imageFilePath.slice(1) : imageFilePath);
      if (!fs.existsSync(absPath)) return null;
      const imageBuffer = await fs.promises.readFile(absPath);
      const ext = path.extname(absPath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
    } catch (_e) {
      return null;
    }
  }

  /** 圖片意圖類型：供 vision-first 判讀與 log */
  const IMAGE_INTENT_ORDER = "order_screenshot";
  const IMAGE_INTENT_PRODUCT_ISSUE = "product_issue_defect";
  const IMAGE_INTENT_PRODUCT_PAGE = "product_page_size";
  const IMAGE_INTENT_OFF_BRAND = "off_brand";
  const IMAGE_INTENT_UNREADABLE = "unreadable";

  /**
   * Vision-first 圖片處理：先看圖 + 近期對話與脈絡，判讀意圖後回覆或使用縮短 fallback。
   * 僅在低信心或 unreadable 時使用 SHORT_IMAGE_FALLBACK（只問 1 個關鍵問題）。
   */
  async function handleImageVisionFirst(
    imageFilePath: string,
    contactId: number
  ): Promise<{ reply: string; usedFallback: boolean; intent?: string; confidence?: string }> {
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey?.trim()) {
      return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true };
    }
    const dataUri = await imageFileToDataUri(imageFilePath);
    if (!dataUri) {
      return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true };
    }
    const contact = storage.getContact(contactId);
    const brandId = contact?.brand_id;
    /** 圖片 order_id 優先：若 vision 抽到合法訂單編號，先查單；有對到則設 active_order_context，不因綠界/ECPay 誤判為付款截圖 */
    try {
      const openaiForImage = new OpenAI({ apiKey: apiKey.trim() });
      const extracted = await extractOrderInfoFromImage(openaiForImage, dataUri);
      const orderIdRaw = (extracted.orderId || "").trim();
      if (orderIdRaw.length >= 5 && /^[A-Za-z0-9\-]+$/.test(orderIdRaw)) {
        const config = getSuperLandingConfig(brandId ?? undefined);
        const hasCreds = (config.merchantNo && config.accessKey) || (brandId ? !!storage.getBrand(brandId)?.shopline_api_token?.trim() : false);
        if (hasCreds) {
          const result = await unifiedLookupById(config, orderIdRaw.toUpperCase(), brandId ?? undefined);
          if (result.found && result.orders.length > 0) {
            const order = result.orders[0];
            const statusLabel = getUnifiedStatusLabel(order.status, result.source);
            const lines: string[] = [];
            if (order.global_order_id) lines.push(`訂單編號：${order.global_order_id}`);
            if (order.buyer_name) lines.push(`收件人姓名：${order.buyer_name}`);
            if (order.buyer_phone) lines.push(`聯絡電話：${order.buyer_phone}`);
            if (order.created_at) lines.push(`下單時間：${order.created_at}`);
            if (order.payment_method) lines.push(`付款方式：${order.payment_method}`);
            if (order.final_total_order_amount != null) lines.push(`金額：$${Number(order.final_total_order_amount).toLocaleString()}`);
            if (order.shipping_method) lines.push(`配送方式：${order.shipping_method}`);
            if (order.tracking_number) lines.push(`物流單號：${order.tracking_number}`);
            const isCvs = /超商|門市|全家|7-11|萊爾富|OK|取貨/i.test(order.shipping_method || "");
            if (order.address) lines.push(isCvs ? `取貨門市／收件地址：${order.address}` : `收件地址：${order.address}`);
            if (order.product_list) lines.push(`訂單內容／商品：${order.product_list}`);
            lines.push(`訂單狀態：${statusLabel}`);
            if (order.shipped_at) lines.push(`出貨時間：${order.shipped_at}`);
            const one_page_summary = lines.join("\n");
            const now = new Date().toISOString().replace("T", " ").substring(0, 19);
            let payment_status: "success" | "pending" | "failed" | "unknown" = "unknown";
            if (/失敗|未成功|未完成付款/i.test(statusLabel) || (order.prepaid === false && !order.paid_at && !/貨到付款|到付/i.test(order.payment_method || ""))) payment_status = "failed";
            else if (order.prepaid === true || order.paid_at || /已出貨|已完成|待出貨|已確認/i.test(statusLabel)) payment_status = "success";
            else if (/待付款|未付款|確認中|新訂單/i.test(statusLabel)) payment_status = "pending";
            storage.linkOrderForContact(contactId, order.global_order_id, "ai_lookup");
            storage.setActiveOrderContext(contactId, {
              order_id: order.global_order_id,
              matched_by: "image",
              matched_confidence: "high",
              last_fetched_at: now,
              payment_status,
              payment_method: order.payment_method,
              fulfillment_status: statusLabel,
              shipping_method: order.shipping_method,
              tracking_no: order.tracking_number,
              receiver_name: order.buyer_name,
              receiver_phone: order.buyer_phone,
              address_or_store: order.address,
              items: order.product_list,
              order_time: order.created_at || order.order_created_at,
              one_page_summary,
              source: result.source as import("@shared/schema").OrderSource,
            });
            return { reply: "已收到您的圖片，幫您查到這筆訂單：\n\n" + one_page_summary, usedFallback: false, intent: IMAGE_INTENT_ORDER };
          }
        }
      }
    } catch (_e) { /* 抽不到或查單失敗則繼續走 vision 意圖 */ }
    const recentMessages = storage.getMessages(contactId).slice(-10);
    const tags = (contact?.tags && typeof contact.tags === "string") ? (() => { try { return JSON.parse(contact.tags) as string[]; } catch { return []; } })() : [];
    const productScope = (contact as any)?.product_scope_locked ?? null;
    const contextParts: string[] = [];
    for (const m of recentMessages) {
      if (m.sender_type === "user" && m.content && m.content !== "[圖片訊息]" && !m.content.startsWith("[圖片")) {
        contextParts.push(`顧客：${m.content.slice(0, 80)}`);
      } else if (m.sender_type === "ai" && m.content) {
        contextParts.push(`客服：${m.content.slice(0, 80)}`);
      }
    }
    if (tags.length) contextParts.push(`案件標籤：${tags.join("、")}`);
    if (productScope) contextParts.push(`已鎖定商品範圍：${productScope === "bag" ? "包包/袋類" : "甜點類"}`);
    const contextStr = contextParts.length ? contextParts.join("\n") : "（無近期文字對話）";

    const systemPrompt = await getEnrichedSystemPrompt(brandId);
    const visionInstruction = `
【圖片處理 - Vision First】請根據客戶傳送的圖片與以下脈絡，判讀圖片意圖並回覆。
意圖分類（五選一）：
- order_screenshot：訂單/物流/客服對話截圖、出貨畫面
- product_issue_defect：商品瑕疵、損壞、問題照片
- product_page_size：商品頁、尺寸圖、款式圖
- off_brand：與品牌無關的圖片（如生活照、無關內容）
- unreadable：無法判讀、模糊、或無法歸類

脈絡：
${contextStr}

請回傳一個 JSON 物件，格式：{"intent":"上述五選一","confidence":"high 或 low","reply_to_customer":"給顧客的簡短回覆（繁體中文）"}
規則：
- 若 confidence 為 low 或 intent 為 unreadable，請將 reply_to_customer 設為空字串 ""，系統會改用簡短 fallback 只問一個問題。
- 若 confidence 為 high：order_screenshot 可簡短說明會協助查單並只問一個最必要欄位（如訂單編號或手機）；product_issue_defect 先安撫並引導售後；product_page_size 可簡短回答商品相關；off_brand 短句收邊界拉回客服範圍。
- reply_to_customer 務必簡短（約 50～120 字），不要多段、不要問卷式多選。`;

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: "請根據此圖與脈絡判讀意圖並回傳 JSON。" },
      { type: "image_url", image_url: { url: dataUri } },
    ];

    try {
      const openai = new OpenAI({ apiKey: apiKey.trim() });
      const completion = await openai.chat.completions.create({
        model: getOpenAIModel(),
        messages: [
          { role: "system", content: systemPrompt + "\n\n" + visionInstruction },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 400,
        temperature: 0.3,
      });
      const raw = completion.choices[0]?.message?.content?.trim();
      if (!raw) return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true };
      let parsed: { intent?: string; confidence?: string; reply_to_customer?: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true };
      }
      const intent = parsed.intent ?? "";
      const confidence = (parsed.confidence ?? "low").toLowerCase();
      const replyText = (parsed.reply_to_customer ?? "").trim();
      const useFallback =
        confidence === "low" ||
        intent === IMAGE_INTENT_UNREADABLE ||
        replyText.length === 0;
      if (useFallback) {
        return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true, intent, confidence };
      }
      const guarded = enforceOutputGuard(replyText, "answer_directly");
      return { reply: guarded, usedFallback: false, intent, confidence };
    } catch (err: any) {
      console.error("[handleImageVisionFirst] Vision error:", err?.message);
      return { reply: SHORT_IMAGE_FALLBACK, usedFallback: true };
    }
  }

  async function analyzeImageWithAI(imageFilePath: string, contactId: number, lineToken?: string | null, platform?: string) {
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") return;
    const contactPlatform = platform || "line";
    try {
      const currentImageDataUri = await imageFileToDataUri(imageFilePath);
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
            const msgDataUri = await imageFileToDataUri(msg.image_url);
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
    const resolvedToken = token ?? null;
    if (!resolvedToken || !replyToken) {
      console.error("[LINE] replyToLine 跳過：Token 或 replyToken 為空");
      return;
    }
    try {
      const res = await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resolvedToken}` },
        body: JSON.stringify({ replyToken, messages }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("[LINE] reply 失敗 — Status:", res.status, "body:", errText);
      }
    } catch (err: any) {
      console.error("[LINE] replyToLine 例外 — error.message:", err?.message, "error.cause:", err?.cause);
    }
  }

  async function pushLineMessage(userId: string, messages: object[], token?: string | null) {
    const resolvedToken = token ?? null;
    if (!resolvedToken) {
      console.error("[LINE] pushLineMessage 跳過：Token 為空");
      return;
    }
    try {
      const res = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resolvedToken}` },
        body: JSON.stringify({ to: userId, messages }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("[LINE] push 失敗 — Status:", res.status, "body:", errText);
      }
    } catch (err: any) {
      console.error("[LINE] pushLineMessage 例外 — error.message:", err?.message, "error.cause:", err?.cause);
    }
  }

  async function sendFBMessage(pageAccessToken: string, recipientId: string, text: string) {
    const res = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("[FB] send message failed:", res.status, errText);
      throw new Error(`FB API ${res.status}: ${errText.slice(0, 200)}`);
    }
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

    const startTime = Date.now();
    const effectiveBrandIdForLog = contact.brand_id || brandId;

    const freshCheck = storage.getContact(contact.id);
    if (freshCheck && (freshCheck.status === "awaiting_human" || freshCheck.status === "high_risk")) {
      const isLinkAsk = isLinkRequestMessage(userMessage) || isLinkRequestCorrectionMessage(userMessage);
      if (isLinkAsk) {
        storage.updateContactHumanFlag(contact.id, 0);
        storage.updateContactStatus(contact.id, "ai_handling");
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
      } else {
        console.log(`[AI Mute] Contact ${contact.id} status=${freshCheck.status}, AI 靜音中 - 跳過`);
        storage.createAiLog({
          contact_id: contact.id,
          brand_id: effectiveBrandIdForLog || undefined,
          prompt_summary: userMessage.slice(0, 200),
          knowledge_hits: [],
          tools_called: [],
          transfer_triggered: false,
          result_summary: "gate_skip:status",
          token_usage: 0,
          model: "gate",
          response_time_ms: Date.now() - startTime,
          reply_source: "gate_skip",
          used_llm: 0,
          plan_mode: null,
          reason_if_bypassed: `status=${freshCheck.status}`,
        });
        return;
      }
    }
    if (freshCheck && freshCheck.needs_human) {
      const isLinkAsk = isLinkRequestMessage(userMessage) || isLinkRequestCorrectionMessage(userMessage);
      if (isLinkAsk) {
        storage.updateContactHumanFlag(contact.id, 0);
        storage.updateContactStatus(contact.id, "ai_handling");
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
      } else {
        /** 徹底封殺 Handoff Loop：needs_human=1 時僅允許 link 請求恢復 AI；其餘只存訊息、不喚醒 LLM、不送任何轉接罐頭句 */
        console.log(`[AI Mute] Contact ${contact.id} needs_human=1, AI 靜音中 - 跳過（僅存訊息）`);
        storage.createAiLog({
          contact_id: contact.id,
          brand_id: effectiveBrandIdForLog || undefined,
          prompt_summary: userMessage.slice(0, 200),
          knowledge_hits: [],
          tools_called: [],
          transfer_triggered: false,
          result_summary: "gate_skip:needs_human",
          token_usage: 0,
          model: "gate",
          response_time_ms: Date.now() - startTime,
          reply_source: "gate_skip",
          used_llm: 0,
          plan_mode: null,
          reason_if_bypassed: "needs_human",
        });
        return;
      }
    }
    if (storage.isAiMuted(contact.id)) {
      console.log(`[AI Mute] Contact ${contact.id} 靜音窗尚未結束 - 跳過`);
      storage.createAiLog({
        contact_id: contact.id,
        brand_id: effectiveBrandIdForLog || undefined,
        prompt_summary: userMessage.slice(0, 200),
        knowledge_hits: [],
        tools_called: [],
        transfer_triggered: false,
        result_summary: "gate_skip:ai_muted",
        token_usage: 0,
        model: "gate",
        response_time_ms: Date.now() - startTime,
        reply_source: "gate_skip",
        used_llm: 0,
        plan_mode: null,
        reason_if_bypassed: "ai_muted",
      });
      return;
    }

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
      if (riskCheck.level === "legal_risk") {
        console.log("[Webhook AI] needs_human=1 source=high_risk_short_circuit reasons=" + riskCheck.reasons.join(","));
        console.log(`[AI Risk] 法務/公關風險偵測: ${riskCheck.reasons.join(", ")}`);
        storage.updateContactStatus(contact.id, "high_risk");
        storage.updateContactHumanFlag(contact.id, 1);
        storage.createMessage(contact.id, contact.platform, "system",
          `(系統提示) 偵測到高風險訊息，已自動標記並轉接真人客服。原因：${riskCheck.reasons.join("、")}`);
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        const handoffReplyLegal = buildHandoffReply({ customerEmotion: "high_risk" });
        const handoffTextLegal = getHandoffReplyForCustomer(handoffReplyLegal, assignment.getUnavailableReason());
        const aiMsgRisk = storage.createMessage(contact.id, contact.platform, "ai", handoffTextLegal);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsgRisk, brand_id: contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contact.platform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, handoffTextLegal);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: handoffTextLegal }], channelToken);
        }

        storage.createAiLog({
          contact_id: contact.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: `高風險偵測: ${userMessage.slice(0, 100)}`,
          knowledge_hits: [],
          tools_called: [],
          transfer_triggered: true,
          transfer_reason: `legal_risk: ${riskCheck.reasons.join(", ")}`,
          result_summary: "法務/公關風險自動轉人工",
          token_usage: 0,
          model: "risk-detection",
          response_time_ms: Date.now() - startTime,
          reply_source: "high_risk_short_circuit",
          used_llm: 0,
          plan_mode: null,
          reason_if_bypassed: "high_risk",
        });
        return;
      }

      // 共用安全確認分流：非本店／他平台／詐騙／待確認來源 → 私訊走安全模板，不進標準售後承諾
      // 例外：若本句明確為「購買連結／商品頁」需求，優先走一般回覆（從知識庫貼連結），不回防詐模板、不切待人工
      const safeConfirmDm = classifyMessageForSafeAfterSale(userMessage);
      if (safeConfirmDm.matched && !isLinkRequestMessage(userMessage)) {
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
            reply_source: "safe_confirm_template",
            used_llm: 0,
            plan_mode: null,
            reason_if_bypassed: "safe_confirm",
          });
        }
        return;
      }

      // 第一階段收斂：圖片＋短句 — 僅「純圖片、完全無文字」才允許固定模板（該情境在 webhook 圖片分支處理）。
      // 本流程為「有文字」的訊息，一律先進主流程理解，不再因近期有圖＋短句就短路。
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

      const recentMessages = storage.getMessages(contact.id).slice(-20);
      const recentAiMessages = recentMessages.filter((m) => m.sender_type === "ai").map((m) => m.content || "");
      const lastUserMsg = recentMessages.filter((m) => m.sender_type === "user").pop();
      const lastAiMsg = recentMessages.filter((m) => m.sender_type === "ai").pop();
      const lastMessageAtBySender = lastUserMsg && lastAiMsg
        ? { user: lastUserMsg.created_at, ai: lastAiMsg.created_at }
        : undefined;
      const freshContact = storage.getContact(contact.id) || contact;
      const state = resolveConversationState({
        contact: freshContact,
        userMessage,
        recentUserMessages: recentUserMsgs,
        recentAiMessages,
        lastMessageAtBySender,
      });
      let returnFormUrl = "https://www.lovethelife.shop/returns";
      if (effectiveBrandId) {
        const brandData = storage.getBrand(effectiveBrandId);
        if (brandData?.return_form_url) returnFormUrl = brandData.return_form_url;
      }
      const isReturnFirstRound = (freshContact as any).return_stage == null || (freshContact as any).return_stage === 0;
      const plan = buildReplyPlan({ state, returnFormUrl, isReturnFirstRound });

      // Bypass：查單中用戶僅回商品名/短補件時，不因尷尬轉人工，讓 AI 繼續處理（不改底層 awkward-repeat-handoff 邏輯）
      const ASK_ORDER_PHONE_FOR_BYPASS = /請提供訂單編號|訂單編號|請提供.*手機|請.*手機號碼|請提供.*商品|商品名稱|下單手機|收件人|請提供.*資訊/i;
      function isUserProvidingOrderDetails(lastAiMessage: string | null | undefined, currentUserMessage: string): boolean {
        if (!lastAiMessage || !ASK_ORDER_PHONE_FOR_BYPASS.test(lastAiMessage)) return false;
        const trimmed = (currentUserMessage || "").trim();
        if (trimmed.length >= 15) return false;
        if (isHumanRequestMessage(trimmed)) return false;
        return true;
      }

      // 尷尬／重複轉人工：同一種資料重問兩次、同一模板重複、用戶說已給過但 AI 答錯、類別跳錯 → 直接轉人工
      const awkwardCheck = shouldHandoffDueToAwkwardOrRepeat({
        userMessage,
        recentMessages: recentMessages.map((m: any) => ({ sender_type: m.sender_type, content: m.content })),
        primaryIntentOrderLookup: state.primary_intent === "order_lookup",
      });
      // 查單主線收斂：已有當前訂單且本輪為訂單延伸問句時，不因尷尬/重複就轉人工
      const activeCtxForBypass = plan.mode === "order_lookup" ? storage.getActiveOrderContext(contact.id) : null;
      const isOrderFollowUpForBypass = activeCtxForBypass && (
        /什麼時候到貨|什麼時候出貨|有沒有出貨|付款有成功嗎|為什麼還沒到|可以取消嗎|好的|謝謝|收到|了解|重點是什麼時候|何時會到/.test((userMessage || "").trim()) ||
        ((userMessage || "").trim().length <= 10 && /^[好謝收解了]+$/.test((userMessage || "").trim()))
      );
      const skipAwkwardHandoffDueToActiveOrder = !!(isOrderFollowUpForBypass && activeCtxForBypass?.one_page_summary);
      if (awkwardCheck.shouldHandoff && !skipAwkwardHandoffDueToActiveOrder && !isUserProvidingOrderDetails(lastAiMsg?.content ?? null, userMessage || "")) {
        console.log("[Webhook AI] needs_human=1 source=awkward_repeat reason=" + (awkwardCheck.reason ?? "unknown") + " msg=" + (userMessage || "").slice(0, 60));
        storage.updateContactConversationFields(contact.id, { product_scope_locked: null, customer_goal_locked: null });
        storage.updateContactHumanFlag(contact.id, 1);
        storage.updateContactStatus(contact.id, "awaiting_human");
        storage.createCaseNotification(contact.id, "in_app");
        storage.updateContactAssignmentStatus(contact.id, "waiting_human");
        const assignedIdAwk = assignment.assignCase(contact.id);
        if (assignedIdAwk == null && assignment.isAllAgentsUnavailable()) {
          const tags = JSON.parse(contact.tags || "[]");
          if (!tags.includes("午休待處理")) storage.updateContactTags(contact.id, [...tags, "午休待處理"]);
          storage.updateContactNeedsAssignment(contact.id, 1);
          storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(assignment.getUnavailableReason()));
        }
        const handoffReplyAwk = buildHandoffReply({ customerEmotion: state.customer_emotion });
        const handoffTextAwk = getHandoffReplyForCustomer(handoffReplyAwk, assignment.getUnavailableReason());
        const contactPlatformAwk = platform || contact.platform || "line";
        const aiMsgAwk = storage.createMessage(contact.id, contactPlatformAwk, "ai", handoffTextAwk);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsgAwk, brand_id: effectiveBrandId || contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatformAwk === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, handoffTextAwk);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: handoffTextAwk }], channelToken);
        }
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsgAwk.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: `awkward_repeat_handoff: ${awkwardCheck.reason ?? "unknown"} - ${userMessage.slice(0, 60)}`,
          knowledge_hits: [],
          tools_called: ["awkward_repeat_handoff"],
          transfer_triggered: true,
          transfer_reason: `尷尬/重複: ${awkwardCheck.reason ?? "unknown"}`,
          result_summary: "尷尬或重複觸發轉人工",
          token_usage: 0,
          model: "reply-plan",
          response_time_ms: Date.now() - startTime,
          reply_source: "handoff",
          used_llm: 0,
          plan_mode: plan.mode,
          reason_if_bypassed: `awkward_repeat: ${awkwardCheck.reason ?? "unknown"}`,
        });
        return;
      }

      // Hotfix：handoff 原子化 — 一旦 plan 為 handoff，只送一則強制告知句，不進 LLM，避免先出一大段再出第二則轉接
      if (plan.mode === "handoff") {
        console.log("[Webhook AI] needs_human=1 source=state_resolver reason=" + (state.human_reason ?? "handoff") + " msg=" + (userMessage || "").slice(0, 60));
        storage.updateContactConversationFields(contact.id, { product_scope_locked: null, customer_goal_locked: null });
        storage.updateContactHumanFlag(contact.id, 1);
        storage.updateContactStatus(contact.id, "awaiting_human");
        storage.createCaseNotification(contact.id, "in_app");
        storage.updateContactAssignmentStatus(contact.id, "waiting_human");
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
        const recentMessagesForHandoff = storage.getMessages(contact.id).slice(-12).map((m: any) => ({ sender_type: m.sender_type, content: m.content, message_type: m.message_type, image_url: m.image_url }));
        const orderInfoInRecent = searchOrderInfoInRecentMessages(recentMessagesForHandoff);
        const handoffReply = buildHandoffReply({
          customerEmotion: state.customer_emotion,
          humanReason: state.human_reason ?? undefined,
          isOrderLookupContext: ORDER_LOOKUP_PATTERNS.test(userMessage),
          hasOrderInfo: !!orderInfoInRecent.orderId,
        });
        const unavailableReason = assignment.getUnavailableReason();
        const handoffTextToSend = getHandoffReplyForCustomer(handoffReply, unavailableReason);
        const contactPlatform = platform || contact.platform || "line";
        const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", handoffTextToSend);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: effectiveBrandId || contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, handoffTextToSend);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: handoffTextToSend }], channelToken);
        }
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsg.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: `handoff_short_circuit: ${userMessage.slice(0, 80)}`,
          knowledge_hits: [],
          tools_called: ["handoff_short_circuit"],
          transfer_triggered: true,
          transfer_reason: state.human_reason || "explicit_human_request",
          result_summary: "轉接真人（僅一則強制告知句）",
          token_usage: 0,
          model: "reply-plan",
          response_time_ms: Date.now() - startTime,
          reply_source: "handoff",
          used_llm: 0,
          plan_mode: "handoff",
          reason_if_bypassed: "handoff_short_circuit",
        });
        return;
      }

      // 地雷3：固定回覆短路「僅限」return_form_first
      if (plan.mode === "return_form_first") {
        const returnFormFirstText = `了解，這邊先幫您處理🙏 若您要申請退換貨，麻煩先幫我填寫退換貨表單，填完後我們的專人會接續協助您確認後續流程。${returnFormUrl ? `\n表單連結：${returnFormUrl}` : ""}\n若您是因為等太久、商品異常，或其他原因，也可以在表單裡一起備註，這樣我們處理會更快。`;
        const contactPlatform = platform || contact.platform || "line";
        const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", returnFormFirstText);
        storage.updateContactConversationFields(contact.id, { return_stage: 1, resolution_status: "awaiting_customer", waiting_for_customer: "return_form_submit" });
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: effectiveBrandId || contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, returnFormFirstText);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: returnFormFirstText }], channelToken);
        }
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsg.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: `return_form_first: ${userMessage.slice(0, 80)}`,
          knowledge_hits: [],
          tools_called: ["return_form_first"],
          transfer_triggered: false,
          result_summary: "退換貨優先導表單（F2 合規）",
          token_usage: 0,
          model: "reply-plan",
          response_time_ms: Date.now() - startTime,
          reply_source: "return_form_first",
          used_llm: 0,
          plan_mode: "return_form_first",
          reason_if_bypassed: "return_form_first",
        });
        return;
      }

      // 第一階段收斂：off_topic_guard 改由模型簡短收邊界，不再固定公告句（下方 systemPrompt 會加入指引，本輪進 LLM）

      // Phase 2 product_scope_locked：handoff/off_topic 清除；order_lookup/answer_directly 可從本句推斷並寫入
      if (plan.mode === "handoff") {
        storage.updateContactConversationFields(contact.id, { product_scope_locked: null, customer_goal_locked: "handoff" });
      } else if (plan.mode === "off_topic_guard") {
        storage.updateContactConversationFields(contact.id, { product_scope_locked: null, customer_goal_locked: null });
      } else if (plan.mode === "order_lookup" || plan.mode === "answer_directly") {
        const inferredScope = getProductScopeFromMessage(userMessage);
        if (inferredScope) {
          storage.updateContactConversationFields(contact.id, { product_scope_locked: inferredScope });
        }
        if (plan.mode === "order_lookup") {
          storage.updateContactConversationFields(contact.id, { customer_goal_locked: "order_lookup" });
        }
      }
      let goalLocked: string | null = null;
      if (plan.mode === "return_form_first" || plan.mode === "return_stage_1") {
        goalLocked = "return";
        storage.updateContactConversationFields(contact.id, { customer_goal_locked: "return" });
      } else if (plan.mode === "handoff") {
        goalLocked = "handoff";
      } else if (plan.mode === "order_lookup") {
        goalLocked = "order_lookup";
      } else if (plan.mode === "off_topic_guard") {
        goalLocked = null;
      } else {
        goalLocked = (contact as any)?.customer_goal_locked ?? null;
      }

      const effectiveScope = state.product_scope_locked || ((plan.mode === "order_lookup" || plan.mode === "answer_directly") ? getProductScopeFromMessage(userMessage) : null);

      let systemPrompt = await getEnrichedSystemPrompt(contact.brand_id || brandId || undefined, { productScope: effectiveScope, planMode: plan.mode });
      if (goalLocked) {
        systemPrompt += `\n\n【本輪重點】這輪先專心處理「${goalLocked}」，不要岔到商品推薦、其他品類或推銷。`;
      }
      if (plan.mode === "handoff") {
        systemPrompt += "\n\n【本輪】已判斷需轉人工。請呼叫 transfer_to_human，並用一兩句自然話告知會轉真人接手即可（例：好喔我幫您轉真人客服處理～）。顧客已明確要真人時直接說已安排接手，不得再問「您是想找真人嗎」。不得在轉人工回覆中補問訂單編號或產品+手機（除非同一句明確提到查單/訂單/出貨且真的缺關鍵資料時由系統另行處理）。";
      }
      if (plan.mode === "off_topic_guard") {
        systemPrompt += "\n\n【本輪 品牌外話題】此為品牌服務範圍外的問題（如晚餐吃什麼、電影推薦等）。用一兩句自然帶過、友善收邊即可（像朋友隨口說「這塊我們比較沒辦法幫上忙～有商品或訂單問題再跟我說」），不要像公告、不得推薦菜單/餐廳/電影，約 30～50 字。";
      }
      // 地雷2：F2 規則 — 全域禁止平台來源話術，不分情境。
      if (plan.must_not_include && plan.must_not_include.length > 0) {
        systemPrompt += "\n\n【本輪硬規則 F2】回覆中禁止出現：" + plan.must_not_include.map((p) => `「${p}」`).join("、") + "。不得提及其他平台、官方通路、該平台、非官方等任何平台來源判斷。";
      }
      if (shouldNotLeadWithOrderLookup(plan, state)) {
        systemPrompt += "\n\n【本輪】本輪為商品問題型退換貨。先一兩句自然道歉與承接，再引導填寫售後表單（可附表單連結）。不可先走訂單查詢為主流程。";
      }
      if (isAftersalesComfortFirst(plan)) {
        systemPrompt += "\n\n【本輪 久候型售後】客人等太久／不想等／想取消。先一句自然安撫（如不好意思久等～）→ 主動幫他查詢出貨 → 說明現貨/加急或約 7–20 工作天 → 補一句會盡量幫您加快。不要一開口就丟表單、不要一開口就轉人工、不要先提其他平台。可呼叫訂單查詢工具。若對話中**已有訂單編號且已查詢過**、客戶並表態「想等」或「願意等」，則**不得再問**商品名稱或訂單截圖；直接確認已備註加急／會通知出貨即可。";
      }
      if (plan.mode === "order_lookup") {
        const activeCtx = storage.getActiveOrderContext(contact.id);
        const msgTrim = (userMessage || "").trim();
        if (activeCtx && /另一筆|新訂單|別筆|其他訂單|換一筆|我要查別的|不是這筆/.test(msgTrim)) {
          storage.clearActiveOrderContext(contact.id);
        }
        const isOrderFollowUp = activeCtx && (
          /什麼時候到貨|什麼時候出貨|有沒有出貨|付款有成功嗎|為什麼還沒到|可以取消嗎|好的|謝謝|收到|了解|重點是什麼時候|何時會到/.test(msgTrim) ||
          (msgTrim.length <= 10 && /^[好謝收解了]+$/.test(msgTrim))
        );
        if (activeCtx?.one_page_summary && isOrderFollowUp) {
          systemPrompt += "\n\n【當前訂單】以下為已對到的訂單資訊，本輪請直接依此回答。\n\n" + activeCtx.one_page_summary;
        }
        systemPrompt += `\n\n<ORDER_LOOKUP_RULES>
目標：引導客戶提供「訂單編號」或「商品+手機」來查單。缺參數時友善追問，湊齊再查。
呈現：若工具回傳訂單資訊，必須直接將內容自然且完整地貼給客戶，多筆則逐筆列出。
誠實：依據工具回傳的真實資料回覆，有什麼說什麼，不要推卸給系統介面沒顯示。
自主權：客戶問到貨/出貨時間，請依訂單狀態回答。若查無訂單，溫和請客戶確認號碼，絕對不要輕易呼叫轉人工。
收尾：問題解決後，自然結束對話，不要無故追問。
</ORDER_LOOKUP_RULES>`;
      }
      /** 對話收尾：由你判斷「感覺能收尾了」就自然收尾，不限於客人說好的/謝謝。任何情況只要話題已解決、客人無新問題、或明顯在道別，就簡短結束，勿再開新題、勿追問。 */
      systemPrompt += "\n\n【收尾判斷】由你**自己判斷**何時可以收尾。只要感覺這輪能結束了（例如：問題已回答完、客人表示收到/謝謝/好的、或對話已告一段落），就**自然收尾**：用一句簡短回覆即可，**不要**再主動問新問題、不要給多個選項、不要追問。不限於客人是否說「好的」「謝謝」；任何情況只要判斷能收尾就收尾。";
      // Mode-specific forbidden content：退貨/取消/handoff/order_lookup 禁止賣點、行銷、推薦、價格組合（底線不變）
      if (isModeNoPromo(plan.mode)) {
        systemPrompt += "\n\n【本輪禁止】不得輸出：商品賣點、行銷詞、推薦語、價格組合、無關品類補充、主動銷售。本輪只做承接／查單／表單／安撫／轉接，不推銷。";
      }
      if (effectiveScope === "bag") {
        systemPrompt += "\n\n【本輪 商品範圍】已鎖定為包包/袋類，回覆中不得提及甜點、蛋糕、巴斯克等無關品類。";
      }
      if (effectiveScope === "sweet") {
        systemPrompt += "\n\n【本輪 商品範圍】已鎖定為甜點類，回覆中不得提及包包、袋類等無關品類。";
      }
      // Hotfix：官方渠道時不得出現任何平台來源話術
      if (contact.channel_id) {
        systemPrompt += "\n\n【本輪 官方渠道】客人目前透過品牌官方 LINE/渠道與你對話。回覆中禁止出現「其他平台」「該平台」「官方通路」「非官方」「若是其他平台購買」等任何平台來源話術；直接依其需求協助查單或售後。";
      }
      // Hotfix：客戶說已給過資料 → 三層搜尋（1. 近期文字 2. 最近圖片 vision 3. linked order）；三層都沒有才轉真人
      if (isAlreadyProvidedMessage(userMessage)) {
        const openaiForSearch = apiKey ? new OpenAI({ apiKey }) : null;
        const found = await searchOrderInfoThreeLayers(contact.id, recentMessages, {
          imageFileToDataUri,
          openai: openaiForSearch,
        });
        if (!found || (!found.orderId && !found.phone)) {
          const contactPlatform = platform || contact.platform || "line";
          const alreadyHandoffText = getHandoffReplyForCustomer(HANDOFF_MANDATORY_OPENING, assignment.getUnavailableReason());
          const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", alreadyHandoffText);
          broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: effectiveBrandId || contact.brand_id });
          broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
          if (contactPlatform === "messenger" && channelToken) {
            await sendFBMessage(channelToken, contact.platform_user_id, alreadyHandoffText);
          } else if (channelToken) {
            await pushLineMessage(contact.platform_user_id, [{ type: "text", text: alreadyHandoffText }], channelToken);
          }
          console.log("[Webhook AI] needs_human=1 source=already_provided_not_found msg=" + (userMessage || "").slice(0, 60));
          storage.updateContactHumanFlag(contact.id, 1);
          storage.updateContactStatus(contact.id, "awaiting_human");
          storage.createCaseNotification(contact.id, "in_app");
          storage.updateContactAssignmentStatus(contact.id, "waiting_human");
          assignment.assignCase(contact.id);
          storage.createAiLog({
            contact_id: contact.id,
            message_id: aiMsg.id,
            brand_id: effectiveBrandId || undefined,
            prompt_summary: `already_provided_not_found: ${userMessage.slice(0, 60)}`,
            knowledge_hits: [],
            tools_called: ["already_provided_handoff"],
            transfer_triggered: true,
            transfer_reason: "客戶表示已給過但系統未找到，勿再問",
            result_summary: "已給過未找到→道歉轉真人",
            token_usage: 0,
            model: "reply-plan",
            response_time_ms: Date.now() - startTime,
            reply_source: "handoff",
            used_llm: 0,
            plan_mode: plan.mode,
            reason_if_bypassed: "already_provided_not_found",
          });
          return;
        }
        const parts = [];
        if (found.orderId) parts.push(`訂單編號 ${found.orderId}`);
        if (found.phone) parts.push(`手機 ${found.phone}`);
        systemPrompt += "\n\n【本輪 已給過】客戶表示已提供過資料。以下為近期對話中曾出現的資訊，請直接使用：" + parts.join("、") + "。勿再重問同一項。";
      }
      const openai = new OpenAI({ apiKey });

      const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
      ];
      const knowledgeHits: string[] = [];

      for (const msg of recentMessages) {
        if (msg.sender_type === "user") {
          if (msg.message_type === "image" && msg.image_url) {
            const msgDataUri = await imageFileToDataUri(msg.image_url);
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

      const AI_TIMEOUT_MS = 45000;
      const TOOL_TIMEOUT_MS = 25000;

      const streamAbortController = new AbortController();
      const streamTimeout = setTimeout(() => streamAbortController.abort(), AI_TIMEOUT_MS);

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

      let responseMessage: OpenAI.Chat.Completions.ChatCompletionMessage | undefined;
      try {
        responseMessage = await runOpenAIStream(
          openai,
          {
            model: getOpenAIModel(),
            messages: chatMessages,
            tools: allTools,
            max_completion_tokens: 1000,
            temperature: 0.7,
          },
          contact.id,
          contact.brand_id ?? undefined,
          streamAbortController.signal
        );
      } catch (timeoutErr: any) {
        clearTimeout(streamTimeout);
        if (timeoutErr?.name === "AbortError" || timeoutErr?.message?.includes("abort")) {
          console.log(`[AI Timeout] OpenAI 推理超時 (>${AI_TIMEOUT_MS}ms) - contact ${contact.id}`);
          const timeoutCount = storage.incrementConsecutiveTimeouts(contact.id);
          storage.createSystemAlert({ alert_type: "timeout_escalation", details: `OpenAI 推理超時 (第${timeoutCount}次)`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
          if (timeoutCount >= 2) {
            storage.updateContactStatus(contact.id, "awaiting_human");
            storage.updateContactHumanFlag(contact.id, 1);
            const comfortMsg = getHandoffReplyForCustomer(HANDOFF_MANDATORY_OPENING, assignment.getUnavailableReason());
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
      clearTimeout(streamTimeout);
      let loopCount = 0;
      const maxToolLoops = 3;

      while (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0 && loopCount < maxToolLoops) {
        loopCount++;
        console.log(`[Webhook AI] 觸發 ${responseMessage.tool_calls.length} 個 Tool Call（第 ${loopCount} 輪）`);
        chatMessages.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);

        const recentUserMessagesForLookup = recentMessages
          .filter((m: any) => m.sender_type === "user" && m.content && m.content !== "[圖片訊息]")
          .map((m: any) => (m.content || "").trim())
          .filter(Boolean);
        const toolCtx = {
          contactId: contact.id,
          brandId: effectiveBrandId || undefined,
          channelToken: channelToken || undefined,
          platform: contact.platform,
          platformUserId: contact.platform_user_id,
          preferShopline: shouldPreferShoplineLookup(userMessage, recentUserMessagesForLookup),
        };

        const toolResults = await Promise.all(
          responseMessage.tool_calls.map(async (toolCall) => {
            const fnName = toolCall.function.name;
            let fnArgs: Record<string, string> = {};
            try { fnArgs = JSON.parse(toolCall.function.arguments); } catch (_e) {}
            toolsCalled.push(fnName);
            console.log(`[Webhook AI] 執行 Tool: ${fnName}，參數:`, fnArgs);
            try {
              const toolResult = await callToolWithTimeout(fnName, fnArgs, toolCtx);
              return { toolCall, toolResult };
            } catch (toolErr: any) {
              if (toolErr?.message === "TOOL_TIMEOUT") {
                console.log(`[AI Timeout] 工具 ${fnName} 超時 (>${TOOL_TIMEOUT_MS}ms)`);
                storage.createSystemAlert({ alert_type: "timeout_escalation", details: `工具 ${fnName} 超時`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
                return { toolCall, toolResult: JSON.stringify({ error: true, message: "工具查詢超時，請稍後再試" }) };
              }
              throw toolErr;
            }
          })
        );

        for (const { toolCall, toolResult } of toolResults) {
          chatMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
          const fnName = toolCall.function.name;
          let fnArgs: Record<string, string> = {};
          try { fnArgs = JSON.parse(toolCall.function.arguments); } catch (_e) {}

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

        /** 判斷權完全交還 LLM：不再因 loopCount/orderLookupFailed 強制轉人工 */

        const freshContact = storage.getContact(contact.id);
        if (freshContact?.needs_human) break;

        const loopAbort = new AbortController();
        const loopTimer = setTimeout(() => loopAbort.abort(), AI_TIMEOUT_MS);
        try {
          responseMessage = await runOpenAIStream(
            openai,
            {
              model: getOpenAIModel(),
              messages: chatMessages,
              tools: allTools,
              max_completion_tokens: 1000,
              temperature: 0.7,
            },
            contact.id,
            contact.brand_id ?? undefined,
            loopAbort.signal
          );
        } catch (loopTimeoutErr: any) {
          clearTimeout(loopTimer);
          if (loopTimeoutErr?.name === "AbortError" || loopTimeoutErr?.message?.includes("abort")) {
            console.log(`[AI Timeout] OpenAI 工具迴圈推理超時 - contact ${contact.id}`);
            const loopTimeoutCount = storage.incrementConsecutiveTimeouts(contact.id);
            storage.createSystemAlert({ alert_type: "timeout_escalation", details: `工具迴圈推理超時 (第${loopTimeoutCount}次)`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
            if (loopTimeoutCount >= 2) {
              storage.updateContactStatus(contact.id, "awaiting_human");
              storage.updateContactHumanFlag(contact.id, 1);
              const comfortMsg = getHandoffReplyForCustomer(HANDOFF_MANDATORY_OPENING, assignment.getUnavailableReason());
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
        clearTimeout(loopTimer);
      }

      storage.resetConsecutiveTimeouts(contact.id);

      const finalContact = storage.getContact(contact.id);
      /** 緊急止血：本輪為 AI 可處理意圖時，不因舊的 needs_human 再補轉人工訊息。 */
      const shouldSkipPostHandoff = state && isAiHandlableIntent(state.primary_intent);
      if (!shouldSkipPostHandoff && (finalContact?.needs_human || storage.isAiMuted(contact.id) || finalContact?.status === "awaiting_human" || finalContact?.status === "high_risk")) {
        console.log(`[Webhook AI] 已轉接真人或靜音中，送出 handoff 強制告知句 (needs_human=${finalContact?.needs_human}, status=${finalContact?.status})`);
        const recentForHandoff = storage.getMessages(contact.id).slice(-12).map((m: any) => ({ sender_type: m.sender_type, content: m.content, message_type: m.message_type, image_url: m.image_url }));
        const orderInfoForHandoff = searchOrderInfoInRecentMessages(recentForHandoff);
        const handoffReply = buildHandoffReply({
          customerEmotion: state.customer_emotion,
          humanReason: state.human_reason ?? undefined,
          isOrderLookupContext: ORDER_LOOKUP_PATTERNS.test(userMessage),
          hasOrderInfo: !!orderInfoForHandoff.orderId,
        });
        const unavailableReasonPost = assignment.getUnavailableReason();
        const handoffTextToSendPost = getHandoffReplyForCustomer(handoffReply, unavailableReasonPost);
        const contactPlatform = platform || contact.platform || "line";
        const aiMsg = storage.createMessage(contact.id, contactPlatform, "ai", handoffTextToSendPost);
        broadcastSSE("new_message", { contact_id: contact.id, message: aiMsg, brand_id: contact.brand_id });
        broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
        if (contactPlatform === "messenger" && channelToken) {
          await sendFBMessage(channelToken, contact.platform_user_id, handoffTextToSendPost);
        } else if (channelToken) {
          await pushLineMessage(contact.platform_user_id, [{ type: "text", text: handoffTextToSendPost }], channelToken);
        }
        storage.createAiLog({
          contact_id: contact.id,
          message_id: aiMsg.id,
          brand_id: effectiveBrandId || undefined,
          prompt_summary: userMessage.slice(0, 200),
          knowledge_hits: knowledgeHits,
          tools_called: toolsCalled,
          transfer_triggered: true,
          transfer_reason: transferReason ?? undefined,
          result_summary: "轉接真人客服（強制告知句）",
          token_usage: totalTokens,
          model: getOpenAIModel(),
          response_time_ms: Date.now() - startTime,
          reply_source: "handoff",
          used_llm: 1,
          plan_mode: plan.mode,
          reason_if_bypassed: null,
        });
        return;
      }

      const rawReply = responseMessage?.content;
      let reply = rawReply && rawReply.trim() ? enforceOutputGuard(rawReply.trim(), plan.mode) : rawReply;
      // Post-generation content guard：品類不符或 mode 禁語則清洗後再送出
      if (reply && reply.trim()) {
        const guardResult = runPostGenerationGuard(reply, plan.mode, effectiveScope);
        if (!guardResult.pass) {
          const useCleaned = guardResult.cleaned && guardResult.cleaned.trim();
          reply = useCleaned ? guardResult.cleaned : "了解，這邊幫您記錄，稍後由專人為您處理。";
          const outcome = useCleaned ? "cleaned" : "fallback";
          for (const r of (guardResult.reason || "").split(";").filter(Boolean)) {
            recordGuardHit(r as import("./content-guard-stats").GuardRuleId, outcome);
          }
        }
      }
      // Official channel hard guard：已知官方渠道時，回覆不得出現「是否官方下單」「若是其他平台購買」等
      if (reply && reply.trim() && contact.channel_id) {
        const officialGuard = runOfficialChannelGuard(reply);
        if (!officialGuard.pass) {
          const useCleaned = officialGuard.cleaned && officialGuard.cleaned.trim();
          reply = useCleaned ? officialGuard.cleaned : "了解，這邊幫您處理，請稍候。";
          recordGuardHit("official_channel_forbidden", useCleaned ? "cleaned" : "fallback");
        }
      }
      // 全域 platform hard guard：任一回覆不得含「其他平台／該平台／官方通路」等，不分 mode
      if (reply && reply.trim()) {
        const globalPlatformGuard = runGlobalPlatformGuard(reply);
        if (!globalPlatformGuard.pass) {
          const useCleaned = globalPlatformGuard.cleaned && globalPlatformGuard.cleaned.trim();
          reply = useCleaned ? globalPlatformGuard.cleaned : "了解，這邊幫您處理，請稍候。";
          recordGuardHit("global_platform_forbidden", useCleaned ? "cleaned" : "fallback");
        }
      }
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
          reply_source: "llm",
          used_llm: 1,
          plan_mode: plan.mode,
          reason_if_bypassed: null,
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
        reply_source: "error",
        used_llm: 0,
        plan_mode: null,
        reason_if_bypassed: `error: ${(err as Error).message}`.slice(0, 200),
      });
    }
  }


  app.post("/internal/run-ai-reply", (req, res) => {
    const secret = req.headers["x-internal-secret"];
    if (secret !== process.env.INTERNAL_API_SECRET) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const { contactId, message, channelToken, matchedBrandId, platform } = req.body || {};
    if (!contactId || message == null) {
      return res.status(400).json({ message: "contactId and message required" });
    }
    const contact = storage.getContact(Number(contactId));
    if (!contact) {
      return res.status(404).json({ message: "contact not found" });
    }
    autoReplyWithAI(
      contact, String(message), channelToken ?? undefined,
      matchedBrandId != null ? Number(matchedBrandId) : undefined,
      platform ? String(platform) : undefined
    )
      .then(() => res.status(200).json({ ok: true }))
      .catch((err) => {
        console.error("[internal/run-ai-reply]", err);
        res.status(500).json({ message: err?.message || "Internal Server Error" });
      });
  });

  const fbWebhookDeps = {
    storage,
    broadcastSSE,
    sendFBMessage,
    downloadExternalImage,
    handleImageVisionFirst,
    enqueueDebouncedAiReply: process.env.REDIS_URL ? enqueueDebouncedAiReply : undefined,
    debounceTextMessage,
    addAiReplyJob,
    getHandoffReplyForCustomer,
    HANDOFF_MANDATORY_OPENING,
    SHORT_IMAGE_FALLBACK,
    getUnavailableReason: () => assignment.getUnavailableReason(),
    resolveCommentMetadata,
    metaCommentsStorage,
    runAutoExecution,
    FB_VERIFY_TOKEN,
  };

  app.post("/api/webhook/line", (req, res) => {
    handleLineWebhook(req, res, {
      storage,
      broadcastSSE,
      pushLineMessage,
      replyToLine,
      downloadLineContent,
      debounceTextMessage,
      addAiReplyJob,
      enqueueDebouncedAiReply: process.env.REDIS_URL ? enqueueDebouncedAiReply : undefined,
      autoReplyWithAI,
      handleImageVisionFirst,
      getHandoffReplyForCustomer,
      HANDOFF_MANDATORY_OPENING,
      getUnavailableReason: () => assignment.getUnavailableReason(),
    });
  });

  app.get("/api/webhook/facebook", (req, res) => handleFacebookVerify(req, res, fbWebhookDeps));
  app.post("/api/webhook/facebook", (req, res) => handleFacebookWebhook(req, res, fbWebhookDeps));


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
        description: "將對話轉交給真人客服。當客戶明確強烈要求找真人、客訴，或你已多次嘗試索取資訊仍無法解決時使用。初期缺乏參數請引導補充，切勿輕易呼叫。",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "轉接原因代碼（內部記錄用，建議使用：explicit_human_request | legal_or_reputation_threat | payment_or_order_risk | policy_exception | repeat_unresolved | return_stage_3_insist）",
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
        description: "發送圖片素材給客戶。僅在「客戶所問商品／意圖」與該圖片確切對應時使用（例如：客戶問 A 商品尺寸，則只能發 A 商品的尺寸表）。請務必確認：傳入的 image_name 對應的圖片，其 name／keywords 所屬的官方商品，與客戶當前詢問的商品完全一致。禁止張冠李戴（例如把 A 商品的圖發給問 B 商品的客戶）。當客戶問題用圖片回覆更清晰（如：尺寸、長相、保存方式、食用方式），且素材庫中有對應圖片時呼叫。",
        parameters: {
          type: "object",
          properties: {
            image_name: {
              type: "string",
              description: "圖片素材庫列表中的 name（即 display_name）。必須與客戶當前詢問的「官方產品名稱」或該意圖（如尺寸表、保存說明）確切對應。",
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
    context?: { contactId?: number; brandId?: number; channelToken?: string; platform?: string; platformUserId?: string; preferShopline?: boolean }
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

    /** 一頁式訂單：完整訂單資訊一段貼給客戶（姓名、電話、下單時間、付款、金額、物流、訂單內容等），有幾筆就貼幾筆，後續從已貼內容回覆 */
    function formatOrderOnePage(o: { order_id?: string; buyer_name?: string; buyer_phone?: string; created_at?: string; payment_method?: string; amount?: number; shipping_method?: string; tracking_number?: string; address?: string; product_list?: string; status?: string; shipped_at?: string }): string {
      const lines: string[] = [];
      if (o.order_id) lines.push(`訂單編號：${o.order_id}`);
      if (o.buyer_name) lines.push(`收件人姓名：${o.buyer_name}`);
      if (o.buyer_phone) lines.push(`聯絡電話：${o.buyer_phone}`);
      if (o.created_at) lines.push(`下單時間：${o.created_at}`);
      if (o.payment_method) lines.push(`付款方式：${o.payment_method}`);
      if (o.amount != null) lines.push(`金額：$${Number(o.amount).toLocaleString()}`);
      if (o.shipping_method) lines.push(`配送方式：${o.shipping_method}`);
      if (o.tracking_number) lines.push(`物流單號：${o.tracking_number}`);
      const isCvs = /超商|門市|全家|7-11|7-ELEVEN|萊爾富|OK|取貨/i.test(o.shipping_method || "");
      if (o.address) lines.push(isCvs ? `取貨門市／收件地址：${o.address}` : `收件地址：${o.address}`);
      if (o.product_list) lines.push(`訂單內容／商品：${o.product_list}`);
      if (o.status) lines.push(`訂單狀態：${o.status}`);
      if (o.shipped_at) lines.push(`出貨時間：${o.shipped_at}`);
      return lines.join("\n");
    }

    /** 從查單結果組出 ActiveOrderContext，供後續同一筆單延伸問題直接使用 */
    function buildActiveOrderContext(
      order: import("@shared/schema").OrderInfo,
      source: string,
      statusLabel: string,
      onePageSummary: string,
      matchedBy: "image" | "text" | "product_phone" | "manual"
    ): import("@shared/schema").ActiveOrderContext {
      const now = new Date().toISOString().replace("T", " ").substring(0, 19);
      let payment_status: "success" | "pending" | "failed" | "unknown" = "unknown";
      if (/失敗|未成功|未完成付款|付款未完成/i.test(statusLabel) || (order.prepaid === false && order.paid_at == null && !/貨到付款|到付/i.test(order.payment_method || ""))) payment_status = "failed";
      else if (order.prepaid === true || order.paid_at || /已出貨|已完成|待出貨|已確認/i.test(statusLabel)) payment_status = "success";
      else if (/待付款|未付款|確認中|新訂單/i.test(statusLabel)) payment_status = "pending";
      let fulfillment_status = statusLabel;
      if (/新訂單|確認中/i.test(statusLabel)) fulfillment_status = "新訂單";
      else if (/待出貨|備貨|處理中/i.test(statusLabel)) fulfillment_status = "備貨中";
      else if (/已出貨|出貨中|配送/i.test(statusLabel)) fulfillment_status = "已出貨";
      else if (/已完成|已送達/i.test(statusLabel)) fulfillment_status = "已完成";
      else if (/取消/i.test(statusLabel)) fulfillment_status = "已取消";
      else if (payment_status === "failed") fulfillment_status = "付款失敗";
      else if (payment_status === "pending") fulfillment_status = "待付款";
      return {
        order_id: order.global_order_id,
        matched_by: matchedBy,
        matched_confidence: "high",
        last_fetched_at: now,
        payment_status,
        payment_method: order.payment_method,
        fulfillment_status,
        shipping_method: order.shipping_method,
        tracking_no: order.tracking_number,
        receiver_name: order.buyer_name,
        receiver_phone: order.buyer_phone,
        address_or_store: order.address,
        items: order.product_list,
        order_time: order.created_at || order.order_created_at,
        one_page_summary: onePageSummary,
        source: source as import("@shared/schema").OrderSource,
      };
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

        const preferSource = context?.preferShopline ? "shopline" as const : undefined;
        if (preferSource) console.log(`[AI Tool Call] 優先 SHOPLINE 查單（官網/SHOPLINE 線索）`);
        const result = await unifiedLookupById(config, orderId, context?.brandId, preferSource);

        if (!result.found || result.orders.length === 0) {
          console.log(`[AI Tool Call] 查無訂單: ${orderId}`);
          return JSON.stringify({ success: true, found: false, message: `目前查不到訂單編號 ${orderId} 的紀錄。請如實告知客戶「這筆訂單編號目前查不到紀錄」，可請客戶確認編號是否正確或是否為不同商品／不同管道下單；若客戶需要可再詢問是否轉專人協助查詢。勿主動強制轉人工，除非客戶明確要求。` });
        }

        const order = result.orders[0];
        const statusLabel = getUnifiedStatusLabel(order.status, result.source);
        console.log(`[AI Tool Call] 查到訂單: ${orderId}，來源: ${result.source}，狀態: ${statusLabel}`);

        if (context?.contactId) {
          storage.updateContactOrderSource(context.contactId, result.source);
        }

        const payment_interpretation = getPaymentInterpretationForAI(order.payment_method, statusLabel, {
          prepaid: order.prepaid,
          paid_at: order.paid_at,
        });
        const orderPayload = {
          order_id: order.global_order_id,
          status: statusLabel,
          amount: order.final_total_order_amount,
          product_list: order.product_list,
          buyer_name: order.buyer_name,
          buyer_phone: order.buyer_phone,
          address: order.address,
          tracking_number: order.tracking_number,
          created_at: order.created_at,
          shipped_at: order.shipped_at,
          shipping_method: order.shipping_method,
          payment_method: order.payment_method,
        };
        const one_page_summary = formatOrderOnePage(orderPayload);
        if (context?.contactId) {
          storage.linkOrderForContact(context.contactId, order.global_order_id, "ai_lookup");
          const activeCtx = buildActiveOrderContext(order, result.source, statusLabel, one_page_summary, "text");
          storage.setActiveOrderContext(context.contactId, activeCtx);
        }
        return JSON.stringify({
          success: true,
          found: true,
          source: result.source,
          order: orderPayload,
          payment_interpretation,
          one_page_summary,
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
        let orderSource: string = "superlanding";
        const preferSourceProduct = context?.preferShopline ? "shopline" as const : undefined;

        if (preferSourceProduct) {
          console.log(`[AI Tool Call] 官網/SHOPLINE 線索，直接以 SHOPLINE 優先做統一查詢`);
          const unifiedResult = await unifiedLookupByProductAndPhone(config, matchedPages, phone, context?.brandId, preferSourceProduct);
          if (unifiedResult.found) {
            allResults = unifiedResult.orders;
            orderSource = unifiedResult.source;
          }
        }
        if (allResults.length === 0) {
          const searchBatchSize = 3;
          for (let bi = 0; bi < matchedPages.length; bi += searchBatchSize) {
            const batch = matchedPages.slice(bi, bi + searchBatchSize);
            const batchResults = await Promise.all(
              batch.map(mp => lookupOrdersByPageAndPhone(config, mp.pageId, phone))
            );
            for (const br of batchResults) {
              allResults = allResults.concat(br.orders);
            }
          }
        }
        if (allResults.length === 0) {
          console.log(`[AI Tool Call] 品牌 ${context?.brandId || "預設"} SuperLanding 查無結果，嘗試統一查詢...`);
          const unifiedResult = await unifiedLookupByProductAndPhone(config, matchedPages, phone, context?.brandId, preferSourceProduct);
          if (unifiedResult.found) {
            allResults = unifiedResult.orders;
            orderSource = unifiedResult.source;
          }
        }

        if (allResults.length === 0) {
          return JSON.stringify({ success: true, found: false, message: `所有平台（一頁商店 + SHOPLINE）皆查無此手機號碼的訂單（已搜尋 ${matchedPages.length} 個相關銷售頁）。請告知客戶目前查不到這筆資料，並詢問是否需要轉接專人客服。` });
        }

        const seenIds = new Set<string>();
        const uniqueOrders = allResults.filter(o => {
          const id = (o.global_order_id || "").trim().toUpperCase();
          if (!id || seenIds.has(id)) return false;
          seenIds.add(id);
          return true;
        });

        if (context?.contactId) {
          storage.updateContactOrderSource(context.contactId, orderSource);
        }

        const orderSummaries = uniqueOrders.map(o => ({
          order_id: o.global_order_id,
          status: getUnifiedStatusLabel(o.status, o.source || orderSource),
          amount: o.final_total_order_amount,
          product_list: o.product_list,
          buyer_name: o.buyer_name,
          buyer_phone: o.buyer_phone,
          address: o.address,
          tracking_number: o.tracking_number,
          created_at: o.created_at,
          shipped_at: o.shipped_at,
          shipping_method: o.shipping_method,
          payment_method: o.payment_method,
          source: o.source || orderSource,
        }));

        console.log("[AI Tool Call] 查到", uniqueOrders.length, "筆訂單（全部列出）");
        const formattedList = orderSummaries.map(o => `- **${o.order_id}** | ${o.created_at || ""} | $${o.amount ?? ""} | **${o.status || ""}**`).join("\n");
        const onePageBlocks = orderSummaries.map(o => formatOrderOnePage(o));
        const one_page_full = onePageBlocks.join("\n\n---\n\n");
        const multiOrderNote = uniqueOrders.length > 1
          ? `【重要】此手機+商品共有 ${uniqueOrders.length} 筆訂單，你必須在回覆中「逐筆列出」以下全部，不可只列一筆或省略：\n${formattedList}\n請照上述格式全部列出後，再問客戶要查看哪一筆的詳情。`
          : undefined;
        if (context?.contactId && uniqueOrders.length === 1) {
          const o0 = uniqueOrders[0];
          const statusLabel0 = getUnifiedStatusLabel(o0.status, o0.source || orderSource);
          storage.linkOrderForContact(context.contactId, o0.global_order_id, "ai_lookup");
          const activeCtx = buildActiveOrderContext(o0, o0.source || orderSource, statusLabel0, onePageBlocks[0], "product_phone");
          storage.setActiveOrderContext(context.contactId, activeCtx);
        }
        return JSON.stringify({ success: true, found: true, total: uniqueOrders.length, orders: orderSummaries, note: multiOrderNote, formatted_list: uniqueOrders.length > 1 ? formattedList : undefined, one_page_summary: uniqueOrders.length === 1 ? onePageBlocks[0] : undefined, one_page_full });
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
          const preferSourceDate = context?.preferShopline ? "shopline" as const : undefined;
          const unifiedResult = await unifiedLookupByDateAndContact(config, contact, beginDate, endDate, pageId, context?.brandId, preferSourceDate);
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
          buyer_phone: o.buyer_phone,
          address: o.address,
          tracking_number: o.tracking_number,
          created_at: o.created_at,
          shipped_at: o.shipped_at,
          shipping_method: o.shipping_method,
          payment_method: o.payment_method,
          source: o.source || dateOrderSource,
        }));

        console.log("[AI Tool Call] 查到", matched.length, "筆訂單（全部列出）");
        const dateFormattedList = orderSummaries.map(o => `- **${o.order_id}** | ${o.created_at || ""} | $${o.amount ?? ""} | **${o.status || ""}**`).join("\n");
        const onePageBlocks = orderSummaries.map(o => formatOrderOnePage(o));
        const one_page_full = onePageBlocks.join("\n\n---\n\n");
        const multiOrderNote = matched.length > 1
          ? `【重要】此聯絡資訊在指定日期範圍內共有 ${matched.length} 筆訂單，你必須在回覆中「逐筆列出」以下全部，不可只列一筆或省略：\n${dateFormattedList}\n請照上述格式全部列出後，再問客戶要查看哪一筆的詳情。`
          : undefined;
        return JSON.stringify({ success: true, found: true, total: matched.length, orders: orderSummaries, truncated, note: multiOrderNote, formatted_list: matched.length > 1 ? dateFormattedList : undefined, one_page_summary: matched.length === 1 ? onePageBlocks[0] : undefined, one_page_full });
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
      const testMessage = (req.query.message as string)?.trim() || undefined;
      const globalPrompt = storage.getSetting("system_prompt") || "";
      const brand = brandId ? storage.getBrand(brandId) : undefined;
      const brandPrompt = brand?.system_prompt || "";
      const fullPrompt = await getEnrichedSystemPrompt(brandId);
      const knowledgeFiles = storage.getKnowledgeFiles(brandId);
      const marketingRules = storage.getMarketingRules(brandId);
      const imageAssets = storage.getImageAssets(brandId);
      const channels = brandId ? storage.getChannelsByBrand(brandId) : [];
      const channelId = channels[0]?.id ?? null;
      const globalPromptHash = crypto.createHash("sha256").update(globalPrompt).digest("hex").slice(0, 8);
      const brandPromptHash = crypto.createHash("sha256").update(brandPrompt).digest("hex").slice(0, 8);
      let simulatedReplySource: string | null = null;
      let wouldUseLlm: boolean | null = null;
      if (testMessage) {
        const riskCheck = detectHighRisk(testMessage);
        const safeConfirmDm = classifyMessageForSafeAfterSale(testMessage);
        if (riskCheck.level === "legal_risk") {
          simulatedReplySource = "high_risk_short_circuit";
          wouldUseLlm = false;
        } else if (safeConfirmDm.matched) {
          simulatedReplySource = "safe_confirm_template";
          wouldUseLlm = false;
        } else {
          const stubContact = {
            id: 0,
            brand_id: brandId ?? null,
            status: "pending",
            needs_human: 0,
            tags: "[]",
            platform: "line",
            order_number_type: null,
            last_message_at: null,
          } as any;
          const state = resolveConversationState({
            contact: stubContact,
            userMessage: testMessage,
            recentUserMessages: [testMessage],
            recentAiMessages: [],
          });
          const returnFormUrl = brand?.return_form_url || "https://www.lovethelife.shop/returns";
          const plan = buildReplyPlan({ state, returnFormUrl, isReturnFirstRound: true });
          if (plan.mode === "off_topic_guard") {
            simulatedReplySource = "off_topic_guard";
            wouldUseLlm = false;
          } else if (plan.mode === "return_form_first") {
            simulatedReplySource = "return_form_first";
            wouldUseLlm = false;
          } else if (plan.mode === "handoff") {
            simulatedReplySource = "handoff";
            wouldUseLlm = true;
          } else {
            simulatedReplySource = "llm";
            wouldUseLlm = true;
          }
        }
      }
      return res.json({
        success: true,
        brand_id: brandId ?? null,
        brand_name: brand?.name || "全域",
        channel_id: channelId,
        global_prompt: globalPrompt,
        brand_prompt: brandPrompt,
        global_prompt_hash: globalPromptHash,
        brand_prompt_hash: brandPromptHash,
        full_prompt_length: fullPrompt.length,
        full_prompt_preview: fullPrompt.substring(0, 2000) + (fullPrompt.length > 2000 ? "\n...(truncated)" : ""),
        final_assembled_preview: fullPrompt.substring(0, 2000) + (fullPrompt.length > 2000 ? "\n...(truncated)" : ""),
        final_assembled_length: fullPrompt.length,
        context_stats: {
          knowledge_files: knowledgeFiles.length,
          marketing_rules: marketingRules.length,
          image_assets: imageAssets.length,
          channels: channels.length,
        },
        ...(testMessage
          ? { simulated_reply_source: simulatedReplySource, would_use_llm: wouldUseLlm, test_message: testMessage }
          : {}),
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

  app.get("/api/team", authMiddleware, managerOrAbove, (_req, res) => {
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

  app.put("/api/team/:id/brand-assignments", authMiddleware, managerOrAbove, (req, res) => {
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
    const counts = storage.getAgentStatsCounts(userId);
    return res.json({ my_cases: openCases, pending_reply: counts.pending_reply, urgent: counts.urgent_simple, overdue: counts.overdue, tracking: counts.tracking, closed_today: counts.closed_today, open_cases_count: openCases, max_active_conversations: maxActive, is_online: isOnline, is_available: isAvailable });
  });

  app.get("/api/manager-stats", authMiddleware, (req: any, res) => {
    if (!isSupervisor(req)) return res.json({ today_new: 0, unassigned: 0, urgent: 0, overdue: 0, closed_today: 0, vip_unhandled: 0, team: [] });
    const brandId = req.query.brand_id ? parseInt(String(req.query.brand_id)) : undefined;
    const counts = storage.getManagerStatsCounts(brandId);
    const agents = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
    const team = agents.map((m) => {
      const st = storage.getAgentStatus(m.id);
      const openCases = storage.getOpenCasesCountForAgent(m.id);
      const pendingReply = storage.getAgentPendingReplyCount(m.id);
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
    return res.json({ today_new: counts.today_new, unassigned: counts.unassigned, urgent: counts.urgent_simple, overdue: counts.overdue, closed_today: counts.closed_today, vip_unhandled: counts.vip_unhandled, team });
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
