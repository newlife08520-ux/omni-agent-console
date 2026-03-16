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

/** Phase 1??????????? ? ???????????????? */
const LEGAL_RISK_KEYWORDS = [
  "??", "??", "??", "?????", "???", "??", "??", "??", "???",
  "??", "??", "??", "??", "???", "??", "??", "???", "???",
  "??", "??", "??",
];
/** Phase 1?????????????????????? high_risk_short_circuit */
const FRUSTRATED_ONLY_KEYWORDS = [
  "?", "??", "??", "??", "??", "?", "??", "??", "??",
  "??", "??", "??", "????", "????", "??", "??", "??", "??",
];

const RETURN_REFUND_KEYWORDS = ["??", "??", "??", "??", "??", "????", "???"];

const ISSUE_TYPE_KEYWORDS: Record<IssueType, string[]> = {
  order_inquiry: ["??", "??", "??", "??", "??", "??", "??", "??"],
  product_consult: ["??", "??", "??", "??", "??", "??", "??", "??", "??", "???"],
  return_refund: ["??", "??", "??", "??", "??", "??", "??", "??"],
  complaint: ["??", "??", "??", "??", "??", "??", "??"],
  order_modify: ["??", "???", "???", "???", "??"],
  general: ["????", "??", "??", "??", "??"],
  other: [],
};

/** Phase 1???? legal_risk??????frustrated_only??????none */
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
        blocks.push(`[????: ${f.original_name}]\n${content.substring(0, remaining)}\n[?????]`);
      }
      break;
    }
    blocks.push(`[????: ${f.original_name}]\n${content}`);
    totalChars += content.length;
  }
  return "\n\n--- ????? ---\n" + blocks.join("\n\n");
}

/** ???????? Chain-of-Thought ?????????????????? */
const IMAGE_PRECISION_COT_BLOCK = `

--- ???????????????---
??????????????????????????????????

?????????????????????????????????????????????T?????????????????????????????????

?????????????????????????????????????????????????????????????????????

????????????????????????????????????????????????????? name?description ? keywords ??????????????????????????????????????????????

?????????????????????? A ?????????? B ?????????????????????????????????????????????? send_image_to_customer?????? name??????? name ????
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
  return "\n\n--- ????? ---\n??????????????????????????????????????????????????????? send_image_to_customer?????? name?\n??????? name / description / keywords ?????????????\n" + lines.join("\n");
}

/** ?? system prompt ????????? mode????? gating????????? sweet ???? */
async function getEnrichedSystemPrompt(
  brandId?: number,
  context?: { productScope?: string | null; planMode?: ReplyPlanMode }
): Promise<string> {
  const basePrompt = storage.getSetting("system_prompt") || "????????????";
  let brandBlock = "";
  if (brandId) {
    const brand = storage.getBrand(brandId);
    if (brand?.system_prompt) {
      brandBlock = "\n\n--- ?????? ---\n" + brand.system_prompt;
    }
  }
  const config = getSuperLandingConfig(brandId);
  const pages = await ensurePagesCacheLoaded(config);
  const catalogBlock = buildProductCatalogPrompt(pages);
  const knowledgeBlock = buildKnowledgeBlock(brandId);
  const imageCatalog = buildImageAssetCatalog(brandId);
  const imageBlock = imageCatalog ? IMAGE_PRECISION_COT_BLOCK + imageCatalog : "";

  /** ??????????????????????? guard ?? */
  const toneBlock = `

--- ??????????????????---
??????????????????????????????????????????????????????
??????????????????????????????/??????????????? guard????????????????????????????????????????`;

  let returnFormUrl = "https://www.lovethelife.shop/returns";
  if (brandId) {
    const brandData = storage.getBrand(brandId);
    if (brandData?.return_form_url) returnFormUrl = brandData.return_form_url;
  }

  // Knowledge gating????????? productScope === "sweet" ?????????????????
  const isSweet = context?.productScope === "sweet";
  const isNonSweetLocked = context?.productScope && context.productScope !== "sweet";
  let shippingLogicBlock: string;
  if (isSweet) {
    shippingLogicBlock = `- ??????????? 3 ??????? 3 ??????????????????????????????????????????????????? 7?20 ????????????????
- ???????????? 7?20 ????????????????????????????????????? 7?20 ????????????????????????????????????????????????`;
  } else if (isNonSweetLocked) {
    shippingLogicBlock = `- ?????????????????????? 7?20 ?????????????????????????????????????????????3 ????????????????????????????????????`;
  } else {
    shippingLogicBlock = `- ????????????????????? 7?20 ?????????????????????????? 3 ????????????????????????????????
- ???????????? 7?20 ????????????????????????????`;
  }

  const handoffBlock = `

--- ??????????????????????---
????????????????????????????????????????????????????????????????????????????????????????????

???????????
` + shippingLogicBlock + `

??????????????????????????
??????????????????????????????????????????????**????**???????????? handoff????????????**????**?????????????????????????????????????????????????????????????????????????????????**???????**?????**???????**???????
- ????????????????????????????????
- ????????????? ?????? ?????????????????????????????????????
- ???????????????????????????????????????????????????????????????????????
- ???????????????? 3 ?????? 7?20 ???????????????????????
- ?????????????????????????????????????????????????????
- ??????????????????????????????????**???**????????????????**??????????? XXX ??????????**??????????????????????**????**????????????????
- **?????????????**?????**??????????????????**??????????????????**????**????????????????????????????????????????????????????????

??????????????
- ????????????????????????????????????????? 7?20 ???????????????????????????????
- ????????????????????????????????????????????????????????????${returnFormUrl}?????????
- ???????????????????????????????????????????????????

???????
??????????????????????????????????????????????????????????????????????AI ?????????????????
??????????????????????????????????????????????????????
?????????????????????????????????????**?????????**??????**????**??????????????????????? transfer_to_human?**??**????????????????????????????????????????????????????????????**??**???????????????????????????????? transfer_to_human????????????

???????
- ???????????????????????????????????????????????????????????????????????????????????????????
- ???????????????????????????????????????????????????????????????????????????????????????????????????????

--- AI ???? ---
?????????????? AI????????????????????????? transfer_to_human?
?????? found=false ??????????????????????????`;

  const schedule = storage.getGlobalSchedule();
  const unavailableReason = assignment.getUnavailableReason();
  const humanHoursBlock = `

--- ?????????????????? AI 24 ?????---
???????????? ${schedule.work_start_time}?${schedule.work_end_time}??? ${schedule.lunch_start_time}?${schedule.lunch_end_time}??? ${schedule.work_end_time} ??????
????? transfer_to_human ???????????????????????????????????????????????????????????????????????????????????????????`;
  const nowStatusHint = unavailableReason === "weekend"
    ? "?????????????????????????????????????????????"
    : unavailableReason === "lunch"
      ? `??????????????${schedule.lunch_start_time}?${schedule.lunch_end_time}?????????????????????`
      : unavailableReason === "after_hours"
        ? `??????????????????${schedule.work_end_time} ???????????????????????????`
        : "";
  const humanHoursBlockWithStatus = humanHoursBlock + (nowStatusHint ? "\n" + nowStatusHint : "");

  return basePrompt + brandBlock + toneBlock + handoffBlock + humanHoursBlockWithStatus + catalogBlock + knowledgeBlock + imageBlock;
}

const contactProcessingLocks = new Map<number, Promise<void>>();

const messageDebounceBuffers = new Map<number, { texts: string[]; timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
/** ???????????????????????????????1.2 ??????????? */
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

/** ?????????????????????????????????????????? */
function getTransferUnavailableSystemMessage(reason: "weekend" | "lunch" | "after_hours" | "all_paused" | null): string {
  const schedule = storage.getGlobalSchedule();
  if (reason === "weekend") return "?????????????????????????????????????????????";
  if (reason === "lunch") return `?????????????${schedule.lunch_start_time}?${schedule.lunch_end_time}?????????????????????????????`;
  if (reason === "after_hours") return "?????????????????????????????????????????????";
  return "????????????????????????????????";
}

/** Phase 2????????????? product_scope_locked?? bag/sweet? */
function getProductScopeFromMessage(text: string): "bag" | "sweet" | null {
  const t = (text || "").trim();
  if (/??|???|????|???|??|???|??/i.test(t)) return "bag";
  if (/??|???|??|??|??|??/i.test(t)) return "sweet";
  return null;
}

async function withContactLock<T>(contactId: number, fn: () => Promise<T>): Promise<T> {
  const existing = contactProcessingLocks.get(contactId);
  let resolve: () => void;
  const lockPromise = new Promise<void>(r => { resolve = r; });
  contactProcessingLocks.set(contactId, lockPromise);
  if (existing) {
    /** ??? AI ????? 25 ???????????????????????????? */
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
    try {
      client.write(payload);
      if (typeof (client as any).flush === "function") (client as any).flush();
    } catch (_e) {
      sseClients.delete(client);
    }
  }
}

/** ? stream chunk ? delta ????? message??? content + tool_calls ??? */
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
 * ?? OpenAI ?????????? content delta ? broadcast message_chunk?
 * ???????????????? message?content ? tool_calls??
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

/** ???? :id ???????????? null??????? 400 ??????? */
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

  // ?????????fetchPages/refreshPagesCache?????????? 500MB RAM ????????
  // ?????? ENABLE_SYNC=true ???????????????????????????????????
  if (process.env.ENABLE_SYNC === "true") {
    setTimeout(() => {
      refreshPagesCache(getSuperLandingConfig()).catch(() => {});
    }, 30 * 1000);
    setInterval(() => {
      const freshConfig = getSuperLandingConfig();
      refreshPagesCache(freshConfig).catch(() => {});
    }, 60 * 60 * 1000);
  } else {
    console.log("[server] ENABLE_SYNC ??? true??????????/????????? ENABLE_SYNC=true ???");
  }

  // ????????????? Railway / ????????????
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

  // SSE ?????Railway ??????? HTTP/2???? ERR_HTTP2_PROTOCOL_ERROR?
  // ?? no-transform?X-Accel-Buffering??? keepalive ??? flush ?????/??????????????????
  app.get("/api/events", (req, res) => {
    if (!(req as any).session?.authenticated) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    console.log("[SSE] Client connected, total clients:", sseClients.size + 1);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate, no-transform",
      Pragma: "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const flush = typeof (res as any).flush === "function" ? () => (res as any).flush() : () => {};
    res.write("event: connected\ndata: {}\n\n");
    flush();
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(":ping\n\n");
        flush();
      } catch (_e) {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 15000);
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
      return res.status(400).json({ success: false, message: "????????" });
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
        message: "????",
        user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
      });
    }
    return res.status(401).json({ success: false, message: "???????" });
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
    return res.status(401).json({ message: "???" });
  };

  const superAdminOnly = (req: any, res: any, next: any) => {
    if (req.session?.userRole === "super_admin") return next();
    return res.status(403).json({ message: "??????????????" });
  };

  const managerOrAbove = (req: any, res: any, next: any) => {
    if (["super_admin", "marketing_manager"].includes(req.session?.userRole)) return next();
    return res.status(403).json({ message: "???????????????" });
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
              const displayName = profile.displayName || (contact.display_name ?? "LINE??");
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
              storage.updateContactProfile(contact.id, fullName || (contact.display_name ?? "FB??"), avatarUrl ?? contact.avatar_url ?? null);
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
      return res.status(403).json({ message: "????" });
    }
    return res.json(getGuardStats());
  });

  /** ????? deploy ??????????? */
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
      if (req.session?.userRole !== "super_admin") return res.status(403).json({ message: "????????? API ??" });
    } else {
      if (!["super_admin", "marketing_manager"].includes(req.session?.userRole)) return res.status(403).json({ message: "????" });
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
          return res.json({ success: false, message: "???? OpenAI API ??" });
        }
        const openai = new OpenAI({ apiKey });
        await openai.chat.completions.create({
          model: getOpenAIModel(),
          messages: [{ role: "user", content: "hi" }],
          max_completion_tokens: 5,
        });
        return res.json({ success: true, message: `OpenAI ???? (??: ${getOpenAIModel()})` });
      }

      if (type === "line") {
        const token = storage.getSetting("line_channel_access_token");
        if (!token || token.trim() === "") {
          return res.json({ success: false, message: "???? LINE Channel Access Token" });
        }
        const verifyRes = await fetch("https://api.line.me/v2/bot/info", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (verifyRes.ok) {
          const botInfo = await verifyRes.json();
          return res.json({ success: true, message: `LINE ?????Bot ??: ${botInfo.displayName || botInfo.basicId || "OK"}` });
        }
        const errBody = await verifyRes.text();
        return res.json({ success: false, message: `LINE ???? (${verifyRes.status}): ${errBody}` });
      }

      if (type === "superlanding") {
        const merchantNo = storage.getSetting("superlanding_merchant_no");
        const accessKey = storage.getSetting("superlanding_access_key");
        if (!merchantNo || !accessKey) {
          return res.json({ success: false, message: "???????? merchant_no ? access_key" });
        }
        const slUrl = `https://api.super-landing.com/orders.json?merchant_no=${encodeURIComponent(merchantNo)}&access_key=${encodeURIComponent(accessKey)}&per_page=1`;
        try {
          const slRes = await fetch(slUrl, { headers: { Accept: "application/json" } });
          if (slRes.ok) {
            return res.json({ success: true, message: "??????????????????" });
          }
          const errText = await slRes.text().catch(() => "");
          return res.json({ success: false, message: `???????? (HTTP ${slRes.status})?${errText || "??????????? merchant_no ? access_key ????"}` });
        } catch (fetchErr: any) {
          const detail = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.message || "??????";
          return res.json({ success: false, message: `???????????????${detail}` });
        }
      }

      return res.json({ success: false, message: `???????: ${type}` });
    } catch (err: any) {
      const msg = err?.message || "????";
      return res.json({ success: false, message: `??????: ${msg}` });
    }
  });

  // --- Meta ?????? ---
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const row = riskRules.getRiskRule(id);
    if (!row) return res.status(404).json({ message: "?????" });
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const ok = riskRules.deleteRiskRule(id);
    if (!ok) return res.status(404).json({ message: "?????" });
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
      targetLineName = result.route_line_type === "after_sale" ? (pageSettings.line_after_sale || "?? LINE") : (pageSettings.line_general || "?? LINE");
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
  // ??????????????????? /:id ????
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const row = metaCommentsStorage.getMetaComment(id);
    if (!row) return res.status(404).json({ message: "?????" });
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const row = metaCommentsStorage.getMetaComment(id);
    if (!row) return res.status(404).json({ message: "?????" });
    const current = row.main_status || computeMainStatus(row);
    if (current !== "gray_area") return res.status(400).json({ message: "???????????" });
    metaCommentsStorage.updateMetaComment(id, { main_status: "completed" });
    return res.json({ success: true, main_status: "completed" });
  });
  // ?? Webhook????????? Meta ?? payload ????????
  app.post("/api/meta-comments/simulate-webhook", authMiddleware, (req: any, res) => {
    res.setHeader("Content-Type", "application/json");
    const body = req.body || {};
    const value = body.entry?.[0]?.changes?.[0]?.value ?? body;
    const commentId = value.comment_id || value.id || `sim_webhook_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const from = value.from ?? {};
    const commenterName = typeof from.name === "string" ? from.name : (body.commenter_name || "????");
    const commenterId = from.id ?? body.commenter_id ?? null;
    const message = value.message ?? body.message ?? "";
    const postId = value.post_id ?? body.post_id ?? "post_sim";
    const pageId = value.page_id ?? body.page_id ?? "page_sim";
    try {
      const resolved = resolveCommentMetadata({
        brand_id: body.brand_id ?? null,
        page_id: pageId,
        post_id: postId,
        post_name: body.post_name ?? "????",
        message: message || "(???)",
      });
      const row = metaCommentsStorage.createMetaComment({
        brand_id: body.brand_id ?? null,
        page_id: pageId,
        page_name: body.page_name ?? "????",
        post_id: postId,
        post_name: body.post_name ?? "????",
        comment_id: commentId,
        commenter_id: commenterId,
        commenter_name: commenterName,
        message: message || "(???)",
        is_simulated: 1,
        ...resolved,
      });
      console.log("[meta-comments] simulate-webhook ???? id=%s", row.id);
      setImmediate(() => runAutoExecution(row.id).catch((e: any) => console.error("[meta-comments] runAutoExecution error:", e?.message)));
      return res.json(row);
    } catch (e: any) {
      console.error("[meta-comments] simulate-webhook ??:", e?.message);
      if (e.message?.includes("UNIQUE")) return res.status(400).json({ message: "??? ID ???" });
      return res.status(500).json({ message: e?.message || "????" });
    }
  });

  // ????????????????????????????????
  app.post("/api/meta-comments/seed-test-cases", authMiddleware, (req: any, res) => {
    res.setHeader("Content-Type", "application/json");
    const body = req.body || {};
    const brandId = body.brand_id ?? null;
    const pageId = body.page_id || "page_demo";
    const pageName = body.page_name || "????";
    const postId = body.post_id || "post_001";
    const postName = body.post_name || "????";
    const cases = [
      { name: "??A", message: "???????????????", label: "??????" },
      { name: "??B", message: "????", label: "????" },
      { name: "??C", message: "??????", label: "???" },
      { name: "??D", message: "+1 ??", label: "????" },
      { name: "??E", message: "????????????????????", label: "??" },
      { name: "??F", message: "????", label: "??" },
    ];
    const created: MetaComment[] = [];
    const ts = Date.now();
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const commentId = `sim_seed_${ts}_${i}_${Math.random().toString(36).slice(2)}`;
      try {
        const isSensitive = ["??E", "??F"].includes(c.name) || ["??", "??"].some((l) => c.label.includes(l));
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
    console.log("[meta-comments] seed-test-cases ?? %s ?", created.length);
    setImmediate(() => {
      created.forEach((r) => runAutoExecution(r.id).catch((e: any) => console.error("[meta-comments] runAutoExecution error:", e?.message)));
    });
    return res.json({ created: created.length, ids: created.map((r) => r.id), comments: created });
  });

  // ??? mapping???????????????????????????
  app.post("/api/meta-comments/test-mapping", authMiddleware, (req: any, res) => {
    res.setHeader("Content-Type", "application/json");
    const mappingId = req.body?.mapping_id != null ? parseInt(String(req.body.mapping_id)) : NaN;
    if (Number.isNaN(mappingId)) return res.status(400).json({ message: "??? mapping_id" });
    const mappings = metaCommentsStorage.getMetaPostMappings();
    const mapping = mappings.find((m) => m.id === mappingId);
    if (!mapping) return res.status(404).json({ message: "??????" });
    const commentId = `sim_mapping_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      const resolved = resolveCommentMetadata({
        brand_id: mapping.brand_id,
        page_id: mapping.page_id || "page_demo",
        post_id: mapping.post_id,
        post_name: mapping.post_name || "????",
        message: "????????",
      });
      const row = metaCommentsStorage.createMetaComment({
        brand_id: mapping.brand_id,
        page_id: mapping.page_id || "page_demo",
        page_name: mapping.page_name || "????",
        post_id: mapping.post_id,
        post_name: mapping.post_name || "????",
        comment_id: commentId,
        commenter_name: "????",
        message: "????????",
        is_simulated: 1,
        ...resolved,
      });
      console.log("[meta-comments] test-mapping ???? id=%s for mapping id=%s", row.id, mappingId);
      return res.json(row);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "????" });
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
        commenter_name: body.commenter_name || "??",
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
      if (e.message?.includes("UNIQUE")) return res.status(400).json({ message: "??? ID ???" });
      return res.status(500).json({ message: e?.message || "????" });
    }
  });
  app.put("/api/meta-comments/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const row = metaCommentsStorage.getMetaComment(id);
    if (!row) return res.status(404).json({ message: "?????" });
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
  // ???????
  app.post("/api/meta-comments/:id/assign", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "?????" });
    const { agent_id, agent_name, agent_avatar_url } = req.body || {};
    if (agent_id == null) return res.status(400).json({ message: "??????" });
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
  // ?????
  app.post("/api/meta-comments/:id/unassign", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "?????" });
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "?????" });
    const openaiKey = storage.getSetting("openai_api_key");
    if (!openaiKey) return res.status(400).json({ message: "???? OpenAI API ??" });
    const model = process.env.OPENAI_MODEL || storage.getSetting("openai_model") || "gpt-4o-mini";
    const INTENTS = "product_inquiry, price_inquiry, where_to_buy, ingredient_effect, activity_engage, dm_guide, complaint, refund_after_sale, spam_competitor";

    try {
      const openai = new OpenAI({ apiKey: openaiKey });
      const msg = comment.message;
      let appliedRuleId: number | null = null;
      let appliedTemplateId: number | null = null;
      let useTemplateForReply: MetaCommentTemplate | null = null;

      // ---------- Step 0a: ????????????????????????? ? ????????????
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
          console.warn("[SafeAfterSale] ?? LINE ?????????", { page_id: comment.page_id, comment_id: id });
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

      // ---------- Step 0: Deterministic rule-based guardrail???/??/??/??/?????? ? ??+? LINE???? AI?
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

      // ---------- Step 0b: Deterministic???? LINE????????/??/???/???/????/???????? ????+? LINE???? AI
      const lineRedirectRule = checkLineRedirectByRule(msg);
      if (lineRedirectRule.matched) {
        console.log("[meta-comments] suggest-reply line_redirect rule hit: id=%s keyword=%s", id, lineRedirectRule.keyword);
        const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
        const lineSecond = (lineGeneralTpl?.reply_dm_guide || "???????????????????? LINE ????? ??").trim();
        const shortPrompt = "??????????????????????????????????? JSON?{\"reply_first\":\"...\"}";
        const shortRes = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: shortPrompt },
            { role: "user", content: `????${msg}?` },
          ],
          response_format: { type: "json_object" },
        });
        const shortText = shortRes.choices[0]?.message?.content || "{}";
        const shortParsed = JSON.parse(shortText) as { reply_first?: string };
        const reply_first_line = (shortParsed.reply_first || "???????").trim();
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

      // ---------- Step 1: ??????????????? priority ??????????????
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
            reply_first: "??????????????????????????????",
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
        break; // ??????????
      }

      // ---------- Step 2: AI ???????????/??/???/??/??? LINE/????/??/???
      const classifyPrompt = `??????????????? JSON????????
???????? exactly ????${INTENTS}
?????
- ?????????????????? price_inquiry?
- ??????????????? where_to_buy?
- ?????????????????? ingredient_effect?
- ?+1?????????????????? activity_engage?
- ????????????????????????????????????????????????????????? ?? dm_guide?suggest_human ? true?????? LINE ?????
- ?????????????????????????????????? complaint ? refund_after_sale?is_high_risk=true?
- ??????????? ? refund_after_sale?is_high_risk=true?
????????????dm_guide ????? LINE ??????
?????{"intent":"????", "is_high_risk": true?false, "suggest_hide": true?false, "suggest_human": true?false}`;
      const classifyRes = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: classifyPrompt },
          { role: "user", content: `????${msg}?` },
        ],
        response_format: { type: "json_object" },
      });
      const classifyText = classifyRes.choices[0]?.message?.content || "{}";
      const cls = JSON.parse(classifyText) as { intent?: string; is_high_risk?: boolean; suggest_hide?: boolean; suggest_human?: boolean };
      let isHighRisk = !!cls.is_high_risk;
      const suggestHide = !!cls.suggest_hide;
      let intent = cls.intent && INTENTS.includes(cls.intent) ? cls.intent : "product_inquiry";
      let suggestHuman = !!cls.suggest_human;
      if (msg.includes("??") && intent === "product_inquiry") isHighRisk = false;
      if (!isHighRisk && (msg.includes("??") || msg.includes("??") || msg.includes("???") || msg.includes("????") || msg.includes("???") || msg.includes("????"))) {
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

      // ---------- Step 3: ??? ? ????+? LINE????????? reply_flow_type=comfort_line
      if (isHighRisk) {
        const comfortTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_after_sale");
        const fallbackComfort = comfortTpl?.reply_comfort || comfortTpl?.reply_dm_guide || "??????????????????????????????????";
        const comfortPrompt = "?????????????/??/????????????????????????????????? JSON?{\"reply_comfort\":\"...\"}";
        const comfortRes = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: comfortPrompt },
            { role: "user", content: `????${msg}?` },
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

      // ---------- Step 3b: ??? LINE?dm_guide ? suggest_human?? ???? + ???? LINE ??
      const shouldRedirectLine = intent === "dm_guide" || suggestHuman;
      if (shouldRedirectLine) {
        const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
        const lineSecond = (lineGeneralTpl?.reply_dm_guide || "???????????????????? LINE ????? ??").trim();
        const shortPrompt = "??????????????????????????????????? JSON?{\"reply_first\":\"...\"}";
        const shortRes = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: shortPrompt },
            { role: "user", content: `????${msg}?` },
          ],
          response_format: { type: "json_object" },
        });
        const shortText = shortRes.choices[0]?.message?.content || "{}";
        const shortParsed = JSON.parse(shortText) as { reply_first?: string };
        const reply_first_line = (shortParsed.reply_first || "???????").trim();
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

      // ---------- Step 4: ?? mapping?? auto_comment_enabled=1???? fallback?? mapping ??????reply_link_source='none'
      const mapping = metaCommentsStorage.getMappingForComment(comment.brand_id, comment.page_id, comment.post_id);
      const productUrl = mapping ? (mapping.primary_url || mapping.fallback_url || "") : "";
      const linkSource = mapping ? "post_mapping" : "none";
      const toneHint = mapping?.tone_hint || "?????";
      const preferredFlow = (mapping as { preferred_flow?: string } | null)?.preferred_flow;

      // ---------- Step 4b: ????????? LINE???????? ?????+? LINE
      if (preferredFlow === "line_redirect" || preferredFlow === "support_only") {
        const lineGeneralTpl = metaCommentsStorage.getMetaCommentTemplateByCategory(comment.brand_id ?? undefined, "line_general");
        const lineSecond = (lineGeneralTpl?.reply_dm_guide || "???????????????????? LINE ????? ??").trim();
        const shortPrompt = "??????????????????????????????????? JSON?{\"reply_first\":\"...\"}";
        const shortRes = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: shortPrompt },
            { role: "user", content: `????${msg}?` },
          ],
          response_format: { type: "json_object" },
        });
        const shortText = shortRes.choices[0]?.message?.content || "{}";
        const shortParsed = JSON.parse(shortText) as { reply_first?: string };
        const reply_first_line = (shortParsed.reply_first || "???????").trim();
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

      // ---------- Step 5: ????????? use_template ?????? AI??? AI ????
      let reply_first: string;
      let reply_second: string;
      if (useTemplateForReply) {
        reply_first = useTemplateForReply.reply_first || "";
        reply_second = (useTemplateForReply.reply_second || "").replace(/\{primary_url\}/g, productUrl || "").trim();
        if (productUrl && !reply_second.includes(productUrl)) reply_second = reply_second ? reply_second + " " + productUrl : productUrl;
      } else {
        const dualPrompt = `?????????????????????????????????????????????${toneHint}?????????????
???????????????????????????????????????????????????`;
        const userContent = productUrl
          ? `????${msg}?\n??? JSON?{"reply_first":"?????", "reply_second":"??????????????${productUrl}"}`
          : `????${msg}?\n??? JSON?{"reply_first":"?????", "reply_second":"???????????????????????"}`;
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
      return res.status(500).json({ message: e?.message || "AI ????" });
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
      name: body.name || "???",
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const body = req.body || {};
    metaCommentsStorage.updateMetaCommentTemplate(id, body);
    return res.json(metaCommentsStorage.getMetaCommentTemplates().find((t) => t.id === id));
  });
  app.delete("/api/meta-comment-templates/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
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

  /** Meta ??????????? Meta ?????????????? User Access Token? */
  app.post("/api/meta/batch/available-pages", authMiddleware, superAdminOnly, async (req: any, res) => {
    const { user_access_token } = req.body || {};
    if (!user_access_token || typeof user_access_token !== "string") {
      return res.status(400).json({ message: "??? user_access_token" });
    }
    try {
      const url = `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(user_access_token)}`;
      const fbRes = await fetch(url);
      if (!fbRes.ok) {
        const errBody = await fbRes.text();
        return res.status(400).json({ message: "Meta API ??", detail: errBody.slice(0, 200) });
      }
      const data = (await fbRes.json()) as { data?: { id: string; name: string; access_token: string }[] };
      const pages = (data.data || []).map((p) => ({
        page_id: p.id,
        page_name: p.name || p.id,
        access_token: p.access_token,
      }));
      return res.json({ pages });
    } catch (e: any) {
      return res.status(500).json({ message: "????????", detail: e?.message });
    }
  });

  /** Meta ??????????????????? channel + meta_page_settings??? AI ???????????? */
  app.post("/api/meta/batch/import", authMiddleware, superAdminOnly, async (req: any, res) => {
    const { brand_id: brandId, pages: pagesInput } = req.body || {};
    const bid = brandId != null ? parseInt(String(brandId), 10) : NaN;
    if (!Number.isInteger(bid) || bid <= 0) {
      return res.status(400).json({ message: "?????? brand_id" });
    }
    const brand = storage.getBrand(bid);
    if (!brand) return res.status(404).json({ message: "?????" });
    if (!Array.isArray(pagesInput) || pagesInput.length === 0) {
      return res.status(400).json({ message: "??? pages ????????" });
    }
    const results: { page_id: string; page_name: string; channel_id?: number; settings_id?: number; error?: string }[] = [];
    for (const p of pagesInput) {
      const page_id = p?.page_id != null ? String(p.page_id) : "";
      const page_name = p?.page_name != null ? String(p.page_name) : page_id || "???";
      const access_token = p?.access_token != null ? String(p.access_token) : "";
      if (!page_id || !access_token) {
        results.push({ page_id: page_id || "?", page_name, error: "?? page_id ? access_token" });
        continue;
      }
      const existing = metaCommentsStorage.getMetaPageSettingsByPageId(page_id);
      if (existing) {
        results.push({ page_id, page_name, error: "??????" });
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
        results.push({ page_id, page_name, error: err?.message || "????" });
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
    if (!body.brand_id) return res.status(400).json({ message: "brand_id ??" });
    const pageId = body.page_id ?? null;
    const postId = (body.post_id || "").trim();
    if (!postId) return res.status(400).json({ message: "?? ID ??" });
    const enabled = body.auto_comment_enabled !== 0 ? 1 : 0;
    if (enabled && metaCommentsStorage.hasDuplicateEnabledMapping(body.brand_id, pageId, postId)) {
      return res.status(400).json({ message: "???????????????????????" });
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
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
        return res.status(400).json({ message: "?????????????????????" });
      }
    }
    metaCommentsStorage.updateMetaPostMapping(id, body);
    const list = metaCommentsStorage.getMetaPostMappings();
    return res.json(list.find((m) => m.id === id));
  });
  app.delete("/api/meta-post-mappings/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const existing = metaCommentsStorage.getMetaCommentRule(id);
    if (!existing) return res.status(404).json({ message: "?????" });
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const ok = metaCommentsStorage.deleteMetaCommentRule(id);
    return res.json({ success: ok });
  });

  app.post("/api/meta-comments/:id/resolve", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "?????" });
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "?????" });
    const message = (req.body?.message as string)?.trim();
    if (!message) return res.status(400).json({ message: "??? message??????" });
    const channel = storage.getChannelByBotId(comment.page_id);
    if (!channel?.access_token) {
      metaCommentsStorage.updateMetaComment(id, {
        reply_error: "?????? Page access token",
        platform_error: "??????? channel",
      });
      metaCommentsStorage.insertMetaCommentAction({ comment_id: id, action_type: "reply", success: 0, error_message: "?? Page token", executor: "user" });
      return res.status(400).json({ message: "??????? Page access token???????" });
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
      reply_error: result.error ?? "????",
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
      message: "????????",
      error: result.error,
      platform_code: result.platform_code,
    });
  });

  app.post("/api/meta-comments/:id/hide", authMiddleware, async (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const comment = metaCommentsStorage.getMetaComment(id);
    if (!comment) return res.status(404).json({ message: "?????" });
    const channel = storage.getChannelByBotId(comment.page_id);
    if (!channel?.access_token) {
      const errMsg = "?????? Page access token";
      metaCommentsStorage.updateMetaComment(id, { hide_error: errMsg, platform_error: "??????? channel" });
      metaCommentsStorage.insertMetaCommentAction({ comment_id: id, action_type: "hide", success: 0, error_message: errMsg, executor: "user" });
      return res.status(400).json({ message: "??????? Page access token???????" });
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
    metaCommentsStorage.updateMetaComment(id, { hide_error: result.error ?? "????", platform_error: errMsg, main_status: "failed" });
    metaCommentsStorage.insertMetaCommentAction({
      comment_id: id,
      action_type: "hide",
      success: 0,
      error_message: result.error ?? undefined,
      platform_response: result.platform_response ?? undefined,
      executor: "user",
    });
    return res.status(502).json({
      message: "????????",
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const row = metaCommentsStorage.getMetaPageSettings(id);
    if (!row) return res.status(404).json({ message: "??????" });
    return res.json(row);
  });
  app.get("/api/meta-page-settings/by-page/:pageId", authMiddleware, (req: any, res) => {
    const pageId = String(req.params.pageId || "");
    if (!pageId) return res.status(400).json({ message: "??? page_id" });
    const row = metaCommentsStorage.getMetaPageSettingsByPageId(pageId);
    if (!row) return res.status(404).json({ message: "????????" });
    return res.json(row);
  });
  app.post("/api/meta-page-settings", authMiddleware, (req: any, res) => {
    const body = req.body || {};
    if (!body.page_id?.trim()) return res.status(400).json({ message: "??? page_id" });
    if (body.brand_id == null) return res.status(400).json({ message: "??? brand_id" });
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
      if (e.message?.includes("UNIQUE")) return res.status(400).json({ message: "? page_id ?????" });
      return res.status(500).json({ message: e?.message || "????" });
    }
  });
  app.put("/api/meta-page-settings/:id", authMiddleware, (req: any, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const existing = metaCommentsStorage.getMetaPageSettings(id);
    if (!existing) return res.status(404).json({ message: "??????" });
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
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
    if (!body.keyword?.trim()) return res.status(400).json({ message: "??? keyword" });
    if (!body.product_name?.trim()) return res.status(400).json({ message: "??? product_name" });
    if (!["post", "comment"].includes(body.match_scope)) return res.status(400).json({ message: "match_scope ?? post ? comment" });
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
    if (Number.isNaN(id)) return res.status(400).json({ message: "??? ID" });
    const ok = metaCommentsStorage.deleteMetaProductKeyword(id);
    return res.json({ success: ok });
  });

  app.get("/api/brands", authMiddleware, (_req, res) => {
    const brands = storage.getBrands();
    return res.json(brands);
  });

  app.get("/api/brands/:id", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const brand = storage.getBrand(id);
    if (!brand) return res.status(404).json({ message: "?????" });
    return res.json(brand);
  });

  app.post("/api/brands", authMiddleware, managerOrAbove, async (req, res) => {
    const { name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key } = req.body;
    if (!name || !slug) return res.status(400).json({ message: "??????????" });
    try {
      const brand = await storage.createBrand(name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key);
      return res.json({ success: true, brand });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return res.status(400).json({ message: "???????" });
      }
      return res.status(500).json({ message: "????" });
    }
  });

  app.put("/api/brands/:id", authMiddleware, managerOrAbove, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
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
    if (!(await storage.updateBrand(id, data))) return res.status(404).json({ message: "?????" });
    return res.json({ success: true });
  });

  app.delete("/api/brands/:id", authMiddleware, managerOrAbove, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    if (!(await storage.deleteBrand(id))) return res.status(404).json({ message: "?????" });
    return res.json({ success: true });
  });

  app.get("/api/brands/:id/channels", authMiddleware, (req, res) => {
    const brandId = parseIdParam(req.params.id);
    if (brandId === null) return res.status(400).json({ message: "??? ID" });
    const channels = storage.getChannelsByBrand(brandId);
    return res.json(channels);
  });

  app.get("/api/brands/:id/assigned-agents", authMiddleware, (req, res) => {
    const brandId = parseIdParam(req.params.id);
    if (brandId === null) return res.status(400).json({ message: "??? ID" });
    const brand = storage.getBrand(brandId);
    if (!brand) return res.status(404).json({ message: "?????" });
    const agents = storage.getBrandAssignedAgents(brandId);
    return res.json(agents);
  });

  app.get("/api/channels", authMiddleware, (_req, res) => {
    const channels = storage.getChannels();
    return res.json(channels);
  });

  /** ??????????????? LINE access_token ???? */
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
    if (brandId === null) return res.status(400).json({ message: "??? ID" });
    const { platform, channel_name, bot_id, access_token, channel_secret } = req.body;
    if (!platform || !channel_name) return res.status(400).json({ message: "??????????" });
    if (!["line", "messenger"].includes(platform)) return res.status(400).json({ message: "???? line ? messenger" });
    if (platform === "line" && access_token) {
      const valid = await validateLineAccessToken(String(access_token));
      if (!valid) {
        return res.status(400).json({ message: "LINE Token ????????????" });
      }
    }
    const channel = await storage.createChannel(brandId, platform, channel_name, bot_id, access_token, channel_secret);
    return res.json({ success: true, channel });
  });

  app.put("/api/channels/:id", authMiddleware, managerOrAbove, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
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
          return res.status(400).json({ message: "LINE Token ????????????" });
        }
      }
    }
    if (!(await storage.updateChannel(id, data))) return res.status(404).json({ message: "?????" });
    return res.json({ success: true });
  });

  app.delete("/api/channels/:id", authMiddleware, managerOrAbove, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    if (!(await storage.deleteChannel(id))) return res.status(404).json({ message: "?????" });
    return res.json({ success: true });
  });

  /** ???????????? Token ?? LINE API???? DB??? bot_id ????? LINE ??? userId ??? */
  app.post("/api/channels/verify-line", authMiddleware, managerOrAbove, async (req, res) => {
    const { access_token, bot_id: formBotId } = req.body || {};
    if (!access_token || typeof access_token !== "string" || !access_token.trim()) {
      return res.json({ success: false, message: "???? Channel Access Token" });
    }
    try {
      const verifyRes = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${access_token.trim()}` },
      });
      if (!verifyRes.ok) {
        const errBody = await verifyRes.text();
        return res.json({ success: false, message: `LINE ???? (${verifyRes.status})?Token ???????${errBody.slice(0, 200)}` });
      }
      const botInfo = (await verifyRes.json()) as { userId?: string; displayName?: string; basicId?: string };
      const botUserId = (botInfo.userId || "").trim();
      let message = `LINE ?????Bot: ${botInfo.displayName || botInfo.basicId || "OK"}?userId?? Webhook destination?= ${botUserId || "(?)"}`;
      if (formBotId != null && typeof formBotId === "string") {
        const a = formBotId.trim();
        const b = botUserId;
        const match = a === b || a === (b.startsWith("U") ? b.slice(1) : "U" + b) || b === (a.startsWith("U") ? a.slice(1) : "U" + a);
        if (!match && botUserId) {
          message += `???? Bot ID ? LINE ??? userId ????Webhook ??? Bot ID ???${botUserId}`;
        } else if (match) {
          message += "????? Bot ID ????????????";
        }
      }
      return res.json({ success: true, message, botUserId: botUserId || undefined });
    } catch (err: any) {
      return res.json({ success: false, message: `?????${err.message}` });
    }
  });

  /** ??????????????????????????? LINE ???????????? */
  app.post("/api/admin/contacts/reassign-by-channel", authMiddleware, managerOrAbove, async (req, res) => {
    const channelId = req.body?.channel_id != null ? parseInt(String(req.body.channel_id), 10) : null;
    const brandId = req.body?.brand_id != null ? parseInt(String(req.body.brand_id), 10) : null;
    if (channelId == null || brandId == null || isNaN(channelId) || isNaN(brandId)) {
      return res.status(400).json({ message: "??? channel_id ? brand_id" });
    }
    const channel = storage.getChannel(channelId);
    if (!channel) return res.status(404).json({ message: "?????" });
    const brand = storage.getBrand(brandId);
    if (!brand) return res.status(404).json({ message: "?????" });
    const updated = storage.reassignContactsByChannel(channelId, brandId);
    return res.json({ success: true, updated, message: `?? ${updated} ????????${brand.name}?` });
  });

  app.post("/api/brands/:id/test-superlanding", authMiddleware, managerOrAbove, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const brand = storage.getBrand(id);
    if (!brand) return res.status(404).json({ message: "?????" });
    const merchantNo = brand.superlanding_merchant_no || storage.getSetting("superlanding_merchant_no") || "";
    const accessKey = brand.superlanding_access_key || storage.getSetting("superlanding_access_key") || "";
    if (!merchantNo || !accessKey) {
      return res.json({ success: false, message: "??????????? Merchant No ? Access Key?????????????" });
    }
    try {
      const slUrl = `https://api.super-landing.com/orders.json?merchant_no=${encodeURIComponent(merchantNo)}&access_key=${encodeURIComponent(accessKey)}&per_page=1`;
      const slRes = await fetch(slUrl, { headers: { Accept: "application/json" } });
      if (slRes.ok) {
        const data = await slRes.json();
        const total = data.total_entries || "N/A";
        return res.json({ success: true, message: `?????????? ${total} ???` });
      }
      const errText = await slRes.text().catch(() => "");
      return res.json({ success: false, message: `???????? (HTTP ${slRes.status})?${errText || "??? merchant_no ? access_key ????"}` });
    } catch (fetchErr: any) {
      const detail = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.message || "??????";
      return res.json({ success: false, message: `???????????????${detail}` });
    }
  });

  app.post("/api/brands/:id/test-shopline", authMiddleware, managerOrAbove, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const brand = storage.getBrand(id);
    if (!brand) return res.status(404).json({ message: "?????" });
    const apiToken = (brand.shopline_api_token || "").trim();
    if (!apiToken) {
      return res.json({ success: false, message: "??????? SHOPLINE API Token" });
    }
    // SHOPLINE Open API ???? base?https://open.shopline.io?Token ??????
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
        return res.json({ success: true, message: `SHOPLINE ??????????? (${total})` });
      }
      const errText = await slRes.text().catch(() => "");
      const errSummary = errText.length > 200 ? errText.slice(0, 200) + "?" : errText;
      return res.json({
        success: false,
        message: `SHOPLINE ???? (HTTP ${slRes.status})?${errSummary || "??? API Token ????????? SHOPLINE ?? OpenAPI ??"}`,
      });
    } catch (fetchErr: any) {
      const detail = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.message || "??????";
      return res.json({ success: false, message: `SHOPLINE ???????????${detail}` });
    }
  });

  app.get("/api/health/status", authMiddleware, async (_req, res) => {
    const results: Record<string, { status: "ok" | "error" | "unconfigured"; message: string }> = {};

    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") {
      results.openai = { status: "unconfigured", message: "???? API ??" };
    } else {
      try {
        const openai = new OpenAI({ apiKey });
        await openai.chat.completions.create({ model: getOpenAIModel(), messages: [{ role: "user", content: "hi" }], max_completion_tokens: 5 });
        results.openai = { status: "ok", message: "????" };
      } catch (err: any) {
        results.openai = { status: "error", message: `????: ${err.message}` };
      }
    }

    const brands = storage.getBrands();
    for (const brand of brands) {
      const merchantNo = brand.superlanding_merchant_no || storage.getSetting("superlanding_merchant_no") || "";
      const accessKey = brand.superlanding_access_key || storage.getSetting("superlanding_access_key") || "";
      const key = `superlanding_brand_${brand.id}`;
      if (!merchantNo || !accessKey) {
        results[key] = { status: "unconfigured", message: "????" };
      } else {
        try {
          const slUrl = `https://api.super-landing.com/orders.json?merchant_no=${encodeURIComponent(merchantNo)}&access_key=${encodeURIComponent(accessKey)}&per_page=1`;
          const slRes = await fetch(slUrl, { headers: { Accept: "application/json" } });
          if (slRes.ok) {
            results[key] = { status: "ok", message: "????" };
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
            results[chKey] = { status: "unconfigured", message: "???? Token" };
          } else {
            try {
              const verifyRes = await fetch("https://api.line.me/v2/bot/info", { headers: { Authorization: `Bearer ${ch.access_token}` } });
              if (verifyRes.ok) {
                results[chKey] = { status: "ok", message: "????" };
              } else {
                results[chKey] = { status: "error", message: `???? (${verifyRes.status})` };
              }
            } catch (err: any) {
              results[chKey] = { status: "error", message: err.message };
            }
          }
        } else {
          results[chKey] = ch.access_token ? { status: "ok", message: "??? Token" } : { status: "unconfigured", message: "???? Token" };
        }
      }
    }

    return res.json(results);
  });

  app.post("/api/channels/:id/test", authMiddleware, managerOrAbove, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const channel = storage.getChannel(id);
    if (!channel) return res.status(404).json({ message: "?????" });
    if (channel.platform === "line") {
      if (!channel.access_token) return res.json({ success: false, message: "???? Access Token" });
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
          return res.json({ success: true, message: `LINE ?????Bot: ${botInfo.displayName || botInfo.basicId || "OK"}`, botUserId });
        }
        const errBody = await verifyRes.text();
        return res.json({ success: false, message: `LINE ???? (${verifyRes.status}): ${errBody}` });
      } catch (err: any) {
        return res.json({ success: false, message: `????: ${err.message}` });
      }
    }
    if (channel.platform === "messenger") {
      if (!channel.access_token) return res.json({ success: false, message: "???? Page Access Token" });
      try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${encodeURIComponent(channel.access_token)}`);
        if (fbRes.ok) {
          const pageInfo = await fbRes.json();
          const pageId = pageInfo.id || "";
          if (pageId && !channel.bot_id) {
            await storage.updateChannel(id, { bot_id: pageId });
          }
          return res.json({ success: true, message: `Facebook ???????: ${pageInfo.name || "OK"} (ID: ${pageId})`, botId: pageId });
        }
        const errBody = await fbRes.text();
        let userMessage = `Facebook ???? (${fbRes.status}): ${errBody}`;
        try {
          const errJson = JSON.parse(errBody) as { error?: { code?: number; message?: string } };
          if (errJson?.error?.code === 100 && /permission|pages_read_engagement|Page Public|review/i.test(errJson.error.message || "")) {
            userMessage = "Facebook ?????????? Token ??? Facebook App ??????????? pages_read_engagement?????? App ????? Facebook ????? ? ?????????????????????????????? App ??????????????????https://developers.facebook.com/docs/apps/review";
          }
        } catch (_e) { /* ? JSON ????? */ }
        return res.json({ success: false, message: userMessage });
      } catch (err: any) {
        return res.json({ success: false, message: `????: ${err.message}` });
      }
    }
    return res.json({ success: false, message: `???? ${channel.platform} ????` });
  });

  /** ? FB ???? feed?????????????? Webhook?? Page Access Token ? pages_manage_metadata */
  app.post("/api/channels/:id/subscribe-feed", authMiddleware, managerOrAbove, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const channel = storage.getChannel(id);
    if (!channel) return res.status(404).json({ message: "?????" });
    if (channel.platform !== "messenger") return res.status(400).json({ message: "??? Facebook Messenger ??" });
    const pageId = (channel.bot_id || "").trim();
    const token = (channel.access_token || "").trim();
    if (!pageId || !token) return res.status(400).json({ message: "???? Bot ID (Page ID) ? Page Access Token" });
    try {
      const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=feed,messages&access_token=${encodeURIComponent(token)}`;
      const subRes = await fetch(url, { method: "POST" });
      const bodyText = await subRes.text();
      if (subRes.ok) {
        const data = JSON.parse(bodyText || "{}") as { success?: boolean };
        if (data.success !== false) {
          return res.json({ success: true, message: "??????? feed?????????????????????????????????????" });
        }
      }
      const errMsg = bodyText.slice(0, 400);
      console.log("[FB] subscribe-feed failed:", subRes.status, errMsg);
      return res.json({ success: false, message: `???? (${subRes.status})?${errMsg || subRes.statusText}` });
    } catch (e: any) {
      console.error("[FB] subscribe-feed error:", e?.message);
      return res.status(500).json({ message: e?.message || "????" });
    }
  });

  /** ????????????????UI ????????? status/case_priority? */
  const URGENT_TAGS = ["??", "??", "???", "????"];
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

  /** AI ????????????? issue_type / status / priority???????????? */
  function suggestAiFromMessages(contactId: number): { issue_type?: string; status?: string; priority?: string; tags?: string[] } {
    const messages = storage.getMessages(contactId, { limit: 20 });
    const text = messages.filter((m) => m.sender_type === "user").map((m) => m.content || "").join(" ");
    const lower = text.toLowerCase();
    const suggestions: { issue_type?: string; status?: string; priority?: string; tags?: string[] } = {};
    if (/\b(??|??|????|??)\b/.test(text)) { suggestions.issue_type = "return_refund"; (suggestions.tags = suggestions.tags || []).push("??"); }
    else if (/\b(??|??|??|??)\b/.test(text)) { suggestions.issue_type = "complaint"; (suggestions.tags = suggestions.tags || []).push("??"); }
    else if (/\b(??|??|??|??|???|??)\b/.test(text)) { suggestions.issue_type = "order_modify"; (suggestions.tags = suggestions.tags || []).push("????"); }
    else if (/\b(??|??|??|??)\b/.test(text)) { suggestions.issue_type = "order_inquiry"; }
    else if (/\b(??|??|??|??|???)\b/.test(text)) { suggestions.issue_type = "product_consult"; (suggestions.tags = suggestions.tags || []).push("????"); }
    if (/\b(???|???|??|??|??)\b/.test(text)) (suggestions.tags = suggestions.tags || []).push("?????");
    if (/\b(??|??|??|???|?|??)\b/.test(text) || (suggestions.issue_type === "complaint" || suggestions.issue_type === "return_refund")) suggestions.priority = "????";
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.sender_type === "user") suggestions.status = "???";
    else if (lastMsg?.sender_type === "admin" || lastMsg?.sender_type === "ai") suggestions.status = "?????";
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
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const contact = storage.getContact(id) as any;
    if (!contact) return res.status(404).json({ message: "??????" });
    // GET ????????????? DB ??? SSE??????????????????????
    // AI ???? Webhook ???????????????????
    if (!contact.ai_suggestions && (contact as any).ai_suggestions === undefined) contact.ai_suggestions = null;
    return res.json(contact);
  });

  app.put("/api/contacts/:id/human", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    storage.updateContactHumanFlag(id, req.body.needs_human ? 1 : 0);
    return res.json({ success: true });
  });

  function buildRatingFlexMessage(contactId: number, ratingType: "human" | "ai" = "human"): object {
    const actionPrefix = ratingType === "ai" ? "rate_ai" : "rate";
    // ?????1 ?????5 ?????????????????????????? emoji ????
    const starButtons = [1, 2, 3, 4, 5].map((score) => ({
      type: "button",
      action: {
        type: "postback",
        label: `${score} ??`,
        data: `action=${actionPrefix}&ticket_id=${contactId}&score=${score}`,
        displayText: `${"?".repeat(score)}`,
      },
      style: "link",
      height: "md",
      flex: 1,
    }));

    const headerText = ratingType === "ai" ? "???? AI ???" : "???????";
    const bodyText = ratingType === "ai"
      ? "???? AI ???????"
      : "????????????????????????";
    const headerColor = ratingType === "ai" ? "#6366F1" : "#1DB446";
    const bgColor = ratingType === "ai" ? "#F5F3FF" : "#F7FFF7";

    return {
      type: "flex",
      altText: ratingType === "ai" ? "AI ??????????? 1?5 ???" : "????????????? 1?5 ???",
      contents: {
        type: "bubble",
        size: "kilo",
        header: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: headerText, weight: "bold", size: "lg", color: headerColor, align: "center" },
            { type: "text", text: "??????????", size: "xs", color: "#888888", align: "center", margin: "4px" },
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
            { type: "text", text: "1 ? ??????5 ? ????", size: "xs", color: "#666666", align: "center", margin: "sm" },
            { type: "text", text: "?????1 ??????? 5 ??????", size: "xs", color: "#1DB446", align: "center", margin: "4px", weight: "bold" },
            { type: "text", text: "???????????????????", size: "xs", color: "#AAAAAA", align: "center", margin: "4px" },
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

  /** ???????????? LINE Token??? fallback ??? .env Token??????? */
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
    if (id === null) return res.status(400).json({ message: "??? ID" });
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
                storage.createMessage(id, contactForRating.platform, "system", "(????) ???????????????????");
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
                storage.createMessage(id, contactForRating.platform, "system", "(????) ????? AI ????????????");
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
    if (id === null) return res.status(400).json({ message: "??? ID" });
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
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const v = req.body?.case_priority;
    const priority = v === undefined || v === null || v === "" ? null : Number(v);
    if (priority !== null && (Number.isNaN(priority) || priority < 1 || priority > 5)) {
      return res.status(400).json({ message: "case_priority ?? 1?5 ? null" });
    }
    storage.updateContactCasePriority(id, priority);
    broadcastSSE("contacts_updated", { contact_id: id });
    return res.json({ success: true });
  });

  app.get("/api/contacts/:id/ai-logs", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const logs = storage.getAiLogs(id);
    return res.json(logs);
  });

  app.post("/api/contacts/:id/transfer-human", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const { reason } = req.body;
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "??????" });
    const transferReason = reason || "???????";
    storage.updateContactStatus(contactId, "awaiting_human");
    storage.updateContactHumanFlag(contactId, 1);
    storage.updateContactAssignmentStatus(contactId, "waiting_human");
    storage.createCaseNotification(contactId, "in_app");
    const assignedAgentId = assignment.assignCase(contactId);
    if (assignedAgentId == null && assignment.isAllAgentsUnavailable()) {
      storage.updateContactNeedsAssignment(contactId, 1);
      const tags = JSON.parse(contact.tags || "[]");
      if (!tags.includes("?????")) storage.updateContactTags(contactId, [...tags, "?????"]);
      const reason = assignment.getUnavailableReason();
      storage.createMessage(contactId, contact.platform, "system", getTransferUnavailableSystemMessage(reason));
    }
    const muteUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    storage.setAiMutedUntil(contactId, muteUntil);
    storage.createSystemAlert({ alert_type: "transfer", details: transferReason, brand_id: contact.brand_id || undefined, contact_id: contactId });
    broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
    broadcastSSE("new_message", { contact_id: contactId });
    console.log(`[Transfer] contact ${contactId} ???????: ${transferReason}${assignedAgentId != null ? `?????? ${assignedAgentId}` : "??????????"}`);
    return res.json({ success: true, status: assignedAgentId != null ? "assigned" : "awaiting_human", reason: transferReason, assigned_agent_id: assignedAgentId ?? undefined, all_busy: assignedAgentId == null && assignment.isAllAgentsUnavailable() });
  });

  app.post("/api/contacts/:id/restore-ai", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "??????" });
    storage.updateContactStatus(contactId, "ai_handling");
    storage.updateContactHumanFlag(contactId, 0);
    storage.clearAiMuted(contactId);
    storage.resetConsecutiveTimeouts(contactId);
    /** ???? AI ? ????????????????????????? AI ????????? */
    storage.updateContactConversationFields(contactId, {
      product_scope_locked: null,
      customer_goal_locked: null,
      human_reason: null,
      return_stage: 0,
      resolution_status: "open",
      waiting_for_customer: null,
    });
    const tags = JSON.parse(contact.tags || "[]") as string[];
    const withoutPending = tags.filter((t) => t !== "?????");
    if (withoutPending.length !== tags.length) storage.updateContactTags(contactId, withoutPending);
    const prevAgentId = contact.assigned_agent_id;
    storage.updateContactAssignment(contactId, null, undefined, undefined, 0);
    if (prevAgentId != null) assignment.syncAgentOpenCases(prevAgentId);
    broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
    console.log(`[Restore AI] contact ${contactId} ??? AI ??????????????????????`);
    return res.json({ success: true, status: "ai_handling" });
  });

  app.post("/api/contacts/:id/send-rating", authMiddleware, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const ratingType = (req.body?.type === "ai" ? "ai" : "human") as "human" | "ai";
    const contact = storage.getContact(id);
    if (!contact) return res.status(404).json({ message: "??????" });
    if (contact.platform !== "line") {
      return res.status(400).json({ message: "??? LINE ??" });
    }
    // ????????????????????????????????????????????
    if (ratingType === "ai" && contact.ai_rating != null) {
      storage.clearContactAiRating(id);
    }
    if (ratingType === "human" && contact.cs_rating != null) {
      storage.clearContactCsRating(id);
    }
    const token = getLineTokenForContact(contact);
    if (!token) {
      return res.status(400).json({ message: "???? LINE Channel Access Token" });
    }
    try {
      await sendRatingFlexMessage(contact, ratingType);
      const typeLabel = ratingType === "ai" ? "AI ??" : "????";
      storage.createMessage(id, contact.platform, "system", `(????) ?????${typeLabel}??????????`);
      broadcastSSE("contacts_updated", { contact_id: id });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ message: "????" });
    }
  });

  app.put("/api/contacts/:id/tags", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ message: "tags must be an array" });
    storage.updateContactTags(id, tags);
    return res.json({ success: true });
  });

  app.put("/api/contacts/:id/agent-flag", authMiddleware, (req: any, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "???" });
    const { flag } = req.body || {};
    const v = flag === "later" || flag === "tracking" ? flag : null;
    if (flag !== undefined && flag !== null && v === null) return res.status(400).json({ message: "flag ?? 'later'?'tracking' ? null" });
    storage.setAgentContactFlag(userId, id, v);
    return res.json({ success: true, flag: v });
  });

  app.put("/api/contacts/:id/pinned", authMiddleware, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
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
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const sinceId = parseInt(req.query.since_id as string) || 0;
    if (sinceId > 0) return res.json(storage.getMessagesSince(contactId, sinceId));
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 80, 1), 500);
    const beforeId = parseInt(req.query.before_id as string) || undefined;
    return res.json(storage.getMessages(contactId, { limit, beforeId: beforeId && beforeId > 0 ? beforeId : undefined }));
  });

  app.post("/api/contacts/:id/messages", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const { content, message_type, image_url } = req.body;
    if (!content && !image_url) return res.status(400).json({ message: "content or image_url is required" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "??????" });
    const msgType = message_type || "text";
    const message = storage.createMessage(contactId, contact.platform, "admin", content || "", msgType, image_url || null);
    storage.updateContactLastHumanReply(contactId);
    broadcastSSE("new_message", { contact_id: contactId, message, brand_id: contact.brand_id });
    broadcastSSE("contacts_updated", { brand_id: contact.brand_id });
    storage.updateContactHumanFlag(contactId, 1);

    const muteUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    storage.setAiMutedUntil(contactId, muteUntil);
    console.log(`[Hard Mute] ?????? contact ${contactId}, AI ??? ${muteUntil}`);

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
    if (!req.file) return res.status(400).json({ message: "??? JPG, PNG, GIF, WebP ???????????? 10MB" });
    const fileUrl = `/uploads/${req.file.filename}`;
    return res.json({ url: fileUrl, filename: fixMulterFilename(req.file.originalname), size: req.file.size });
  });

  app.get("/api/contacts/:id/orders", authMiddleware, async (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "??????" });
    const config = getSuperLandingConfig(contact.brand_id || undefined);
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ orders: [], error: "not_configured", message: "???????? API ??" });
    }
    try {
      const orders = await fetchOrders(config, { per_page: "50" });
      return res.json({ orders });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API ?????",
        invalid_credentials: "API ???????? merchant_no ? access_key?",
        connection_failed: "????????? API",
      };
      console.error("[????] ?????????:", err.message);
      return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `?????${err.message}` });
    }
  });

  app.post("/api/contacts/:id/link-order", authMiddleware, (req: any, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const orderId = (req.body?.order_id as string)?.trim();
    if (!orderId) return res.status(400).json({ message: "??? order_id" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "??????" });
    try {
      db.prepare(
        "INSERT OR IGNORE INTO contact_order_links (contact_id, global_order_id, source) VALUES (?, ?, 'manual')"
      ).run(contactId, orderId.toUpperCase());
      return res.json({ ok: true });
    } catch (e: any) {
      console.error("[link-order]", e);
      return res.status(500).json({ message: e?.message || "????" });
    }
  });

  app.get("/api/contacts/:id/linked-orders", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "??????" });
    const rows = db.prepare("SELECT global_order_id FROM contact_order_links WHERE contact_id = ? ORDER BY created_at DESC")
      .all(contactId) as { global_order_id: string }[];
    return res.json({ order_ids: rows.map((r) => r.global_order_id) });
  });

  app.get("/api/contacts/:id/active-order", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "??????" });
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
    if (!query) return res.status(400).json({ message: "???????" });
    const config = getSuperLandingConfig(brand_id ? parseInt(brand_id as string) : undefined);
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ orders: [], error: "not_configured", message: "???????? API ??" });
    }
    try {
      console.log("[????] ???????:", query, "(?????)");
      const order = await lookupOrderById(config, query);
      if (!order) {
        return res.json({ orders: [], message: "??????????????????????" });
      }
      return res.json({ orders: [order] });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API ?????",
        invalid_credentials: "API ???????? merchant_no ? access_key?",
        connection_failed: "????????? API",
      };
      console.error("[????] ??????:", err.message);
      return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `?????${err.message}` });
    }
  });

  app.get("/api/orders/search", authMiddleware, async (req, res) => {
    const { q, begin_date, end_date, brand_id } = req.query;
    const query = (q as string || "").trim();
    const beginDate = (begin_date as string || "").trim();
    const endDate = (end_date as string || "").trim();

    if (!query) return res.status(400).json({ message: "????????Email???????" });
    if (!beginDate || !endDate) return res.status(400).json({ message: "????????begin_date ? end_date?" });

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(beginDate) || !dateRegex.test(endDate)) {
      return res.status(400).json({ message: "?????? YYYY-MM-DD" });
    }

    const begin = new Date(beginDate + "T00:00:00");
    const end = new Date(endDate + "T00:00:00");
    if (isNaN(begin.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ message: "???????????????" });
    }
    const diffDays = Math.round((end.getTime() - begin.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return res.status(400).json({ message: "????????????" });
    if (diffDays >= 31) return res.status(400).json({ message: "???????? 31 ?????????" });

    const config = getSuperLandingConfig(brand_id ? parseInt(brand_id as string) : undefined);
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ orders: [], error: "not_configured", message: "???????? API ??" });
    }

    try {
      console.log(`[????] ????: q="${query}" ${beginDate}~${endDate}`);
      const result = await lookupOrdersByDateAndFilter(config, query, beginDate, endDate);
      if (result.orders.length === 0) {
        return res.json({ orders: [], totalFetched: result.totalFetched, message: `? ${beginDate} ~ ${endDate} ???????${query}???????? ${result.totalFetched} ??` });
      }
      return res.json({ orders: result.orders, totalFetched: result.totalFetched, truncated: result.truncated });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API ?????",
        invalid_credentials: "API ???????? merchant_no ? access_key?",
        connection_failed: "????????? API",
      };
      console.error("[????] ??????:", err.message);
      return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `?????${err.message}` });
    }
  });

  app.get("/api/orders/pages", authMiddleware, async (req, res) => {
    const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
    const config = getSuperLandingConfig(brandId);
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ pages: [], error: "not_configured", message: "???????? API ??" });
    }
    try {
      const forceRefresh = req.query.refresh === "1";
      const pages = forceRefresh
        ? await refreshPagesCache(config)
        : await ensurePagesCacheLoaded(config);
      return res.json({ pages, cached: !forceRefresh, cacheAge: Math.round(getCachedPagesAge() / 1000) });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API ?????",
        invalid_credentials: "API ????",
        connection_failed: "????????? API",
      };
      return res.json({ pages: [], error: err.message, message: errorMap[err.message] || `?????${err.message}` });
    }
  });

  app.get("/api/orders/by-product", authMiddleware, async (req, res) => {
    const { page_id, phone, brand_id } = req.query;
    const pageId = (page_id as string || "").trim();
    const phoneNum = (phone as string || "").trim();

    if (!pageId) return res.status(400).json({ message: "??????page_id?" });
    if (!phoneNum) return res.status(400).json({ message: "???????" });

    const config = getSuperLandingConfig(brand_id ? parseInt(brand_id as string) : undefined);
    if (!config.merchantNo || !config.accessKey) {
      return res.json({ orders: [], error: "not_configured", message: "???????? API ??" });
    }

    try {
      console.log(`[????] ????: page_id=${pageId} phone=${phoneNum}`);
      const result = await lookupOrdersByPageAndPhone(config, pageId, phoneNum);
      if (result.orders.length === 0) {
        return res.json({ orders: [], totalFetched: result.totalFetched, message: `?????????????${phoneNum}???????? ${result.totalFetched} ??` });
      }
      return res.json({ orders: result.orders, totalFetched: result.totalFetched, truncated: result.truncated });
    } catch (err: any) {
      const errorMap: Record<string, string> = {
        missing_credentials: "API ?????",
        invalid_credentials: "API ???????? merchant_no ? access_key?",
        connection_failed: "????????? API",
      };
      console.error("[????] ??????:", err.message);
      return res.json({ orders: [], error: err.message, message: errorMap[err.message] || `?????${err.message}` });
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
        ? "?? destination ??????????????? Token??????? [WEBHOOK] NO MATCH ??? channel_id????bot_id????????????? Bot ID ??? destination ?? Token?"
        : "???? ??????????? channel_id=" + channelIdForLog + " ??? Channel Access Token?";
      console.error("[downloadLineContent] Token ???access_token ????????? Get Content ?? ? messageId:", messageId, "channelId:", channelIdForLog ?? "unknown", "?", hint);
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
          console.log("[downloadLineContent] ???????:", uploadDir);
        }
        try {
          fs.writeFileSync(filePath, buffer);
        } catch (writeErr: any) {
          console.error("[downloadLineContent] ?????? ? path:", filePath, "error.message:", writeErr?.message, "error.code:", writeErr?.code, "channelId:", channelIdForLog ?? "unknown");
          if (writeErr?.stack) console.error("[downloadLineContent] writeFileSync stack:", writeErr.stack);
          return null;
        }
        console.log(`[downloadLineContent] Success: ${filename} (${buffer.length} bytes, attempt ${attempt})`);
        return `/uploads/${filename}`;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const cause = err?.cause != null ? (err.cause?.message ?? String(err.cause)) : "";
        const stack = err?.stack ?? "";
        console.error("[downloadLineContent] Attempt", attempt, "/", maxRetries, "catch ? messageId:", messageId, "error.message:", msg, "error.name:", err?.name, "error.cause:", cause, "channelId:", channelIdForLog ?? "unknown");
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

  /** ???????? vision-first ??? log */
  const IMAGE_INTENT_ORDER = "order_screenshot";
  const IMAGE_INTENT_PRODUCT_ISSUE = "product_issue_defect";
  const IMAGE_INTENT_PRODUCT_PAGE = "product_page_size";
  const IMAGE_INTENT_OFF_BRAND = "off_brand";
  const IMAGE_INTENT_UNREADABLE = "unreadable";

  /**
   * Vision-first ???????? + ???????????????????? fallback?
   * ?????? unreadable ??? SHORT_IMAGE_FALLBACK??? 1 ???????
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
    /** ?? order_id ???? vision ?????????????????? active_order_context?????/ECPay ??????? */
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
            if (order.global_order_id) lines.push(`?????${order.global_order_id}`);
            if (order.buyer_name) lines.push(`??????${order.buyer_name}`);
            if (order.buyer_phone) lines.push(`?????${order.buyer_phone}`);
            if (order.created_at) lines.push(`?????${order.created_at}`);
            if (order.payment_method) lines.push(`?????${order.payment_method}`);
            if (order.final_total_order_amount != null) lines.push(`???$${Number(order.final_total_order_amount).toLocaleString()}`);
            if (order.shipping_method) lines.push(`?????${order.shipping_method}`);
            if (order.tracking_number) lines.push(`?????${order.tracking_number}`);
            const isCvs = /??|??|??|7-11|???|OK|??/i.test(order.shipping_method || "");
            if (order.address) lines.push(isCvs ? `??????????${order.address}` : `?????${order.address}`);
            if (order.product_list) lines.push(`????????${order.product_list}`);
            lines.push(`?????${statusLabel}`);
            if (order.shipped_at) lines.push(`?????${order.shipped_at}`);
            const one_page_summary = lines.join("\n");
            const now = new Date().toISOString().replace("T", " ").substring(0, 19);
            let payment_status: "success" | "pending" | "failed" | "unknown" = "unknown";
            if (/??|???|?????/i.test(statusLabel) || (order.prepaid === false && !order.paid_at && !/????|??/i.test(order.payment_method || ""))) payment_status = "failed";
            else if (order.prepaid === true || order.paid_at || /???|???|???|???/i.test(statusLabel)) payment_status = "success";
            else if (/???|???|???|???/i.test(statusLabel)) payment_status = "pending";
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
            return { reply: "?????????????????\n\n" + one_page_summary, usedFallback: false, intent: IMAGE_INTENT_ORDER };
          }
        }
      }
    } catch (_e) { /* ???????????? vision ?? */ }
    const recentMessages = storage.getMessages(contactId).slice(-10);
    const tags = (contact?.tags && typeof contact.tags === "string") ? (() => { try { return JSON.parse(contact.tags) as string[]; } catch { return []; } })() : [];
    const productScope = (contact as any)?.product_scope_locked ?? null;
    const contextParts: string[] = [];
    for (const m of recentMessages) {
      if (m.sender_type === "user" && m.content && m.content !== "[????]" && !m.content.startsWith("[??")) {
        contextParts.push(`???${m.content.slice(0, 80)}`);
      } else if (m.sender_type === "ai" && m.content) {
        contextParts.push(`???${m.content.slice(0, 80)}`);
      }
    }
    if (tags.length) contextParts.push(`?????${tags.join("?")}`);
    if (productScope) contextParts.push(`????????${productScope === "bag" ? "??/??" : "???"}`);
    const contextStr = contextParts.length ? contextParts.join("\n") : "?????????";

    const systemPrompt = await getEnrichedSystemPrompt(brandId);
    const visionInstruction = `
????? - Vision First???????????????????????????
??????????
- order_screenshot???/??/???????????
- product_issue_defect?????????????
- product_page_size????????????
- off_brand????????????????????
- unreadable??????????????

???
${contextStr}

????? JSON ??????{"intent":"?????","confidence":"high ? low","reply_to_customer":"??????????????"}
???
- ? confidence ? low ? intent ? unreadable??? reply_to_customer ????? ""???????? fallback ???????
- ? confidence ? high?order_screenshot ???????????????????????????????product_issue_defect ?????????product_page_size ??????????off_brand ????????????
- reply_to_customer ?????? 50?120 ????????????????`;

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: "??????????????? JSON?" },
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
      systemPrompt += "\n\n????????????????????????????????????????????????????????????????(?? transfer_to_human ??)????????????????????????????????????????????????????????";

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
                { type: "text", text: msg.content || "???????" },
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
          { type: "text", text: "???????" },
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

      const reply = responseMessage?.content || "?????????????????";
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
      storage.createMessage(contactId, contactPlatform, "ai", "??????????????????");
    }
  }

  async function replyToLine(replyToken: string, messages: object[], token?: string | null) {
    const resolvedToken = token ?? null;
    if (!resolvedToken || !replyToken) {
      console.error("[LINE] replyToLine ???Token ? replyToken ??");
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
        console.error("[LINE] reply ?? ? Status:", res.status, "body:", errText);
      }
    } catch (err: any) {
      console.error("[LINE] replyToLine ?? ? error.message:", err?.message, "error.cause:", err?.cause);
    }
  }

  async function pushLineMessage(userId: string, messages: object[], token?: string | null) {
    const resolvedToken = token ?? null;
    if (!resolvedToken) {
      console.error("[LINE] pushLineMessage ???Token ??");
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
        console.error("[LINE] push ?? ? Status:", res.status, "body:", errText);
      }
    } catch (err: any) {
      console.error("[LINE] pushLineMessage ?? ? error.message:", err?.message, "error.cause:", err?.cause);
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
        console.log(`[AI Mute] Contact ${contact.id} status=${freshCheck.status}, AI ??? - ??`);
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
        /** ???? Handoff Loop?needs_human=1 ???? link ???? AI??????????? LLM?????????? */
        console.log(`[AI Mute] Contact ${contact.id} needs_human=1, AI ??? - ????????`);
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
      console.log(`[AI Mute] Contact ${contact.id} ??????? - ??`);
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
        console.log(`[AI Risk] ??/??????: ${riskCheck.reasons.join(", ")}`);
        storage.updateContactStatus(contact.id, "high_risk");
        storage.updateContactHumanFlag(contact.id, 1);
        storage.createMessage(contact.id, contact.platform, "system",
          `(????) ?????????????????????????${riskCheck.reasons.join("?")}`);
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
          prompt_summary: `?????: ${userMessage.slice(0, 100)}`,
          knowledge_hits: [],
          tools_called: [],
          transfer_triggered: true,
          transfer_reason: `legal_risk: ${riskCheck.reasons.join(", ")}`,
          result_summary: "??/?????????",
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

      // ????????????????????????? ? ????????????????
      // ???????????????????????????????????????????????????
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
          console.warn("[SafeAfterSale] ?? LINE ?????????", { contact_id: contact.id, brand_id: contact.brand_id });
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
              m.sender_type === "user" && (m.message_type === "image" || m.content === "[????]" || (m.content && m.content.startsWith("[??")))
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
            transfer_reason: safeConfirmDm.suggest_human ? `??????(${safeConfirmDm.type})` : undefined,
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

      // ???????????? ? ???????????????????????? webhook ????????
      // ?????????????????????????????????????
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

      // Bypass???????????/?????????????? AI ????????? awkward-repeat-handoff ???
      const ASK_ORDER_PHONE_FOR_BYPASS = /???????|????|???.*??|?.*????|???.*??|????|????|???|???.*??/i;
      function isUserProvidingOrderDetails(lastAiMessage: string | null | undefined, currentUserMessage: string): boolean {
        if (!lastAiMessage || !ASK_ORDER_PHONE_FOR_BYPASS.test(lastAiMessage)) return false;
        const trimmed = (currentUserMessage || "").trim();
        if (trimmed.length >= 15) return false;
        if (isHumanRequestMessage(trimmed)) return false;
        return true;
      }

      // ????????????????????????????????? AI ??????? ? ?????
      const awkwardCheck = shouldHandoffDueToAwkwardOrRepeat({
        userMessage,
        recentMessages: recentMessages.map((m: any) => ({ sender_type: m.sender_type, content: m.content })),
        primaryIntentOrderLookup: state.primary_intent === "order_lookup",
      });
      // ?????????????????????????????/??????
      const activeCtxForBypass = plan.mode === "order_lookup" ? storage.getActiveOrderContext(contact.id) : null;
      const isOrderFollowUpForBypass = activeCtxForBypass && (
        /??????|??????|?????|??????|??????|?????|??|??|??|??|???????|????/.test((userMessage || "").trim()) ||
        ((userMessage || "").trim().length <= 10 && /^[?????]+$/.test((userMessage || "").trim()))
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
          if (!tags.includes("?????")) storage.updateContactTags(contact.id, [...tags, "?????"]);
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
          transfer_reason: `??/??: ${awkwardCheck.reason ?? "unknown"}`,
          result_summary: "??????????",
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

      // Hotfix?handoff ??? ? ?? plan ? handoff????????????? LLM???????????????
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
          if (!tags.includes("?????")) {
            storage.updateContactTags(contact.id, [...tags, "?????"]);
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
          result_summary: "??????????????",
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

      // ??3???????????return_form_first
      if (plan.mode === "return_form_first") {
        const returnFormFirstText = `???????????? ???????????????????????????????????????????${returnFormUrl ? `\n?????${returnFormUrl}` : ""}\n??????????????????????????????????????????`;
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
          result_summary: "?????????F2 ???",
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

      // ???????off_topic_guard ???????????????????? systemPrompt ????????? LLM?

      // Phase 2 product_scope_locked?handoff/off_topic ???order_lookup/answer_directly ?????????
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
        systemPrompt += `\n\n??????????????${goalLocked}???????????????????`;
      }
      if (plan.mode === "handoff") {
        systemPrompt += "\n\n??????????????? transfer_to_human???????????????????????????????????????????????????????????????????????????????????????+??????????????/??/????????????????????";
      }
      if (plan.mode === "off_topic_guard") {
        systemPrompt += "\n\n??? ????????????????????????????????????????????????????????????????????????????????????????????????/??/???? 30?50 ??";
      }
      // ??2?F2 ?? ? ????????????????
      if (plan.must_not_include && plan.must_not_include.length > 0) {
        systemPrompt += "\n\n?????? F2?????????" + plan.must_not_include.map((p) => `?${p}?`).join("?") + "????????????????????????????????";
      }
      if (shouldNotLeadWithOrderLookup(plan, state)) {
        systemPrompt += "\n\n???????????????????????????????????????????????????????????";
      }
      if (isAftersalesComfortFirst(plan)) {
        systemPrompt += "\n\n??? ?????????????????????????????????????? ???????? ? ????/???? 7?20 ??? ? ??????????????????????????????????????????????????????**???????????**??????????????????**????**????????????????????????????";
      }
      if (plan.mode === "order_lookup") {
        const activeCtx = storage.getActiveOrderContext(contact.id);
        const msgTrim = (userMessage || "").trim();
        if (activeCtx && /???|???|??|????|???|?????|????/.test(msgTrim)) {
          storage.clearActiveOrderContext(contact.id);
        }
        const isOrderFollowUp = activeCtx && (
          /??????|??????|?????|??????|??????|?????|??|??|??|??|???????|????/.test(msgTrim) ||
          (msgTrim.length <= 10 && /^[?????]+$/.test(msgTrim))
        );
        if (activeCtx?.one_page_summary && isOrderFollowUp) {
          systemPrompt += "\n\n????????????????????????????\n\n" + activeCtx.one_page_summary;
        }
        systemPrompt += `\n\n<ORDER_LOOKUP_RULES>
???????????????????+?????????????????????
???????????????????????????????????????
?????????????????????????????????????
?????????/??????????????????????????????????????????
???????????????????????
</ORDER_LOOKUP_RULES>`;
      }
      /** ???????????????????????????????/????????????????????????????????????????????? */
      systemPrompt += "\n\n????????**????**??????????????????????????????????/??/??????????????**????**???????????**??**?????????????????????????????????????????????????????";
      // Mode-specific forbidden content???/??/handoff/order_lookup ?????????????????????
      if (isModeNoPromo(plan.mode)) {
        systemPrompt += "\n\n????????????????????????????????????????????????????????????????";
      }
      if (effectiveScope === "bag") {
        systemPrompt += "\n\n??? ???????????/?????????????????????????";
      }
      if (effectiveScope === "sweet") {
        systemPrompt += "\n\n??? ???????????????????????????????";
      }
      // Hotfix??????????????????
      if (contact.channel_id) {
        systemPrompt += "\n\n??? ??????????????? LINE/??????????????????????????????????????????????????????????????????????";
      }
      // Hotfix????????? ? ?????1. ???? 2. ???? vision 3. linked order???????????
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
            transfer_reason: "?????????????????",
            result_summary: "????????????",
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
        if (found.orderId) parts.push(`???? ${found.orderId}`);
        if (found.phone) parts.push(`?? ${found.phone}`);
        systemPrompt += "\n\n??? ????????????????????????????????????" + parts.join("?") + "?????????";
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
                { type: "text", text: msg.content || "???????" },
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
          console.log(`[AI Timeout] OpenAI ???? (>${AI_TIMEOUT_MS}ms) - contact ${contact.id}`);
          const timeoutCount = storage.incrementConsecutiveTimeouts(contact.id);
          storage.createSystemAlert({ alert_type: "timeout_escalation", details: `OpenAI ???? (?${timeoutCount}?)`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
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
            const comfortMsg = "?????????????????????????????????????????????????";
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
        console.log(`[Webhook AI] ?? ${responseMessage.tool_calls.length} ? Tool Call?? ${loopCount} ??`);
        chatMessages.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);

        const recentUserMessagesForLookup = recentMessages
          .filter((m: any) => m.sender_type === "user" && m.content && m.content !== "[????]")
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
            console.log(`[Webhook AI] ?? Tool: ${fnName}???:`, fnArgs);
            try {
              const toolResult = await callToolWithTimeout(fnName, fnArgs, toolCtx);
              return { toolCall, toolResult };
            } catch (toolErr: any) {
              if (toolErr?.message === "TOOL_TIMEOUT") {
                console.log(`[AI Timeout] ?? ${fnName} ?? (>${TOOL_TIMEOUT_MS}ms)`);
                storage.createSystemAlert({ alert_type: "timeout_escalation", details: `?? ${fnName} ??`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
                return { toolCall, toolResult: JSON.stringify({ error: true, message: "????????????" }) };
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
            transferReason = fnArgs.reason || "AI ????????";
            storage.updateContactStatus(contact.id, "awaiting_human");
            storage.updateContactHumanFlag(contact.id, 1);
            storage.updateContactAssignmentStatus(contact.id, "waiting_human");
            storage.createCaseNotification(contact.id, "in_app");
            const assignedId = assignment.assignCase(contact.id);
            if (assignedId == null && assignment.isAllAgentsUnavailable()) {
              storage.updateContactNeedsAssignment(contact.id, 1);
              const tags = JSON.parse(contact.tags || "[]");
              if (!tags.includes("?????")) {
                storage.updateContactTags(contact.id, [...tags, "?????"]);
              }
              const reason = assignment.getUnavailableReason();
              storage.createMessage(contact.id, contact.platform, "system", getTransferUnavailableSystemMessage(reason));
            }
            storage.createSystemAlert({ alert_type: "transfer", details: transferReason, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
            const freshContact = storage.getContact(contact.id);
            if (freshContact?.needs_human) {
              console.log(`[Webhook AI] transfer_to_human ?????? AI ????`);
            }
          }

          if (fnName.includes("lookup_order")) {
            try {
              const parsed = JSON.parse(toolResult);
              if (parsed.found === false) {
                orderLookupFailed++;
                const orderSource = parsed.source || "unknown";
                storage.createSystemAlert({ alert_type: "order_lookup_fail", details: `???? (${orderSource})`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
              }
              if (parsed.found === true && !contact.issue_type) {
                storage.updateContactIssueType(contact.id, "order_inquiry");
              }
            } catch (_e) {}
          }
        }

        /** ??????? LLM???? loopCount/orderLookupFailed ????? */

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
            console.log(`[AI Timeout] OpenAI ???????? - contact ${contact.id}`);
            const loopTimeoutCount = storage.incrementConsecutiveTimeouts(contact.id);
            storage.createSystemAlert({ alert_type: "timeout_escalation", details: `???????? (?${loopTimeoutCount}?)`, brand_id: effectiveBrandId || undefined, contact_id: contact.id });
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
      /** ???????? AI ??????????? needs_human ???????? */
      const shouldSkipPostHandoff = state && isAiHandlableIntent(state.primary_intent);
      if (!shouldSkipPostHandoff && (finalContact?.needs_human || storage.isAiMuted(contact.id) || finalContact?.status === "awaiting_human" || finalContact?.status === "high_risk")) {
        console.log(`[Webhook AI] ???????????? handoff ????? (needs_human=${finalContact?.needs_human}, status=${finalContact?.status})`);
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
          result_summary: "?????????????",
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
      // Post-generation content guard?????? mode ?????????
      if (reply && reply.trim()) {
        const guardResult = runPostGenerationGuard(reply, plan.mode, effectiveScope);
        if (!guardResult.pass) {
          const useCleaned = guardResult.cleaned && guardResult.cleaned.trim();
          reply = useCleaned ? guardResult.cleaned : "????????????????????";
          const outcome = useCleaned ? "cleaned" : "fallback";
          for (const r of (guardResult.reason || "").split(";").filter(Boolean)) {
            recordGuardHit(r as import("./content-guard-stats").GuardRuleId, outcome);
          }
        }
      }
      // Official channel hard guard??????????????????????????????????
      if (reply && reply.trim() && contact.channel_id) {
        const officialGuard = runOfficialChannelGuard(reply);
        if (!officialGuard.pass) {
          const useCleaned = officialGuard.cleaned && officialGuard.cleaned.trim();
          reply = useCleaned ? officialGuard.cleaned : "??????????????";
          recordGuardHit("official_channel_forbidden", useCleaned ? "cleaned" : "fallback");
        }
      }
      // ?? platform hard guard??????????????????????????? mode
      if (reply && reply.trim()) {
        const globalPlatformGuard = runGlobalPlatformGuard(reply);
        if (!globalPlatformGuard.pass) {
          const useCleaned = globalPlatformGuard.cleaned && globalPlatformGuard.cleaned.trim();
          reply = useCleaned ? globalPlatformGuard.cleaned : "??????????????";
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
      console.error("[Webhook AI] ??????:", err);
      storage.createAiLog({
        contact_id: contact.id,
        brand_id: contact.brand_id || brandId || undefined,
        prompt_summary: userMessage.slice(0, 200),
        knowledge_hits: [],
        tools_called: toolsCalled,
        transfer_triggered: false,
        result_summary: `??: ${(err as Error).message}`,
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
        description: "?????????????????????????? KBT58265?DEN12345?MRQ00001 ????????????????????????",
        parameters: {
          type: "object",
          properties: {
            order_id: {
              type: "string",
              description: "???????????? KBT58265????????",
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
        description: "????????????????????????? product_index?????????????????????? page_id??? page_id ???????????????????????????????????????????????????????????",
        parameters: {
          type: "object",
          properties: {
            product_index: {
              type: "integer",
              description: "???????????????? #3 ?? 3?????????????????????????????",
            },
            product_name: {
              type: "string",
              description: "????????????????????????????????? product_index ???????????? product_index??",
            },
            phone: {
              type: "string",
              description: "???????????",
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
        description: "????????????? page_id ????????? page_id??????????????????????? Email/??/?????????????",
        parameters: {
          type: "object",
          properties: {
            contact: {
              type: "string",
              description: "????????Email?????????",
            },
            begin_date: {
              type: "string",
              description: "??????? YYYY-MM-DD",
            },
            end_date: {
              type: "string",
              description: "??????? YYYY-MM-DD",
            },
            page_id: {
              type: "string",
              description: "??? ID???????????????? lookup_order_by_product_and_phone ???????",
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
        description: "??????????????????????????????????????????????????????????????????",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "??????????????????explicit_human_request | legal_or_reputation_threat | payment_or_order_risk | policy_exception | repeat_unresolved | return_stage_3_insist?",
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
        description: "????????????????????????????????????????? A ????????? A ????????????????? image_name ??????? name?keywords ????????????????????????????????? A ??????? B ??????????????????????????????????????????????????????",
        parameters: {
          type: "object",
          properties: {
            image_name: {
              type: "string",
              description: "????????? name?? display_name????????????????????????????????????????",
            },
            text_message: {
              type: "string",
              description: "???????????????",
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
        storage.createMessage(context.contactId, "line", "ai", `[??: ${asset.display_name}]`, "image", imageUrl);
      }
      return JSON.stringify({ success: true, message: `??????${asset.display_name}????` });
    }

    return JSON.stringify({
      success: true,
      message: `???${asset.display_name}????`,
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
      const reason = (args.reason || "AI ????????").trim();
      console.log(`[AI Tool Call] transfer_to_human???: ${reason}?contactId: ${context?.contactId}`);
      if (context?.contactId) {
        storage.updateContactHumanFlag(context.contactId, 1);
        storage.createMessage(context.contactId, context?.platform || "line", "system",
          `(????) AI ??????????????????${reason}`);
      }
      return JSON.stringify({ success: true, message: "?????????????????????????? AI ???????????" });
    }

    if (toolName === "send_image_to_customer") {
      const imageName = (args.image_name || "").trim();
      const textMessage = (args.text_message || "").trim();
      if (!imageName) return JSON.stringify({ success: false, error: "???????" });

      const asset = storage.getImageAssetByName(imageName, context?.brandId);
      if (!asset) {
        const allAssets = storage.getImageAssets(context?.brandId);
        const fuzzyMatch = allAssets.find(a =>
          a.display_name.includes(imageName) || imageName.includes(a.display_name) ||
          a.original_name.includes(imageName) || (a.keywords && a.keywords.includes(imageName))
        );
        if (!fuzzyMatch) return JSON.stringify({ success: false, error: `?????: ${imageName}` });
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
      return JSON.stringify({ success: false, error: "?????????? API ???????? SHOPLINE??????????????? ? ??????? API ???" });
    }

    /** ??????????????????????????????????????????????????????????????? */
    function formatOrderOnePage(o: { order_id?: string; buyer_name?: string; buyer_phone?: string; created_at?: string; payment_method?: string; amount?: number; shipping_method?: string; tracking_number?: string; address?: string; product_list?: string; status?: string; shipped_at?: string }): string {
      const lines: string[] = [];
      if (o.order_id) lines.push(`?????${o.order_id}`);
      if (o.buyer_name) lines.push(`??????${o.buyer_name}`);
      if (o.buyer_phone) lines.push(`?????${o.buyer_phone}`);
      if (o.created_at) lines.push(`?????${o.created_at}`);
      if (o.payment_method) lines.push(`?????${o.payment_method}`);
      if (o.amount != null) lines.push(`???$${Number(o.amount).toLocaleString()}`);
      if (o.shipping_method) lines.push(`?????${o.shipping_method}`);
      if (o.tracking_number) lines.push(`?????${o.tracking_number}`);
      const isCvs = /??|??|??|7-11|7-ELEVEN|???|OK|??/i.test(o.shipping_method || "");
      if (o.address) lines.push(isCvs ? `??????????${o.address}` : `?????${o.address}`);
      if (o.product_list) lines.push(`????????${o.product_list}`);
      if (o.status) lines.push(`?????${o.status}`);
      if (o.shipped_at) lines.push(`?????${o.shipped_at}`);
      return lines.join("\n");
    }

    /** ??????? ActiveOrderContext???????????????? */
    function buildActiveOrderContext(
      order: import("@shared/schema").OrderInfo,
      source: string,
      statusLabel: string,
      onePageSummary: string,
      matchedBy: "image" | "text" | "product_phone" | "manual"
    ): import("@shared/schema").ActiveOrderContext {
      const now = new Date().toISOString().replace("T", " ").substring(0, 19);
      let payment_status: "success" | "pending" | "failed" | "unknown" = "unknown";
      if (/??|???|?????|?????/i.test(statusLabel) || (order.prepaid === false && order.paid_at == null && !/????|??/i.test(order.payment_method || ""))) payment_status = "failed";
      else if (order.prepaid === true || order.paid_at || /???|???|???|???/i.test(statusLabel)) payment_status = "success";
      else if (/???|???|???|???/i.test(statusLabel)) payment_status = "pending";
      let fulfillment_status = statusLabel;
      if (/???|???/i.test(statusLabel)) fulfillment_status = "???";
      else if (/???|??|???/i.test(statusLabel)) fulfillment_status = "???";
      else if (/???|???|??/i.test(statusLabel)) fulfillment_status = "???";
      else if (/???|???/i.test(statusLabel)) fulfillment_status = "???";
      else if (/??/i.test(statusLabel)) fulfillment_status = "???";
      else if (payment_status === "failed") fulfillment_status = "????";
      else if (payment_status === "pending") fulfillment_status = "???";
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
        console.log(`[AI Tool Call] lookup_order_by_id???: ${orderId} (?????)???ID: ${context?.brandId || "?"}`);

        if (!orderId) {
          return JSON.stringify({ success: false, error: "??????" });
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
            message: "??????????????????????????????????????????????????????????????????????????????????????????????????????????????",
          });
        }
        if (numberType === "logistics_id") {
          return JSON.stringify({
            success: true,
            found: false,
            not_order_number: true,
            number_type: "logistics_id",
            message: "?????????????????????????????????????????????????????????????????????????????????????????",
          });
        }

        const preferSource = context?.preferShopline ? "shopline" as const : undefined;
        if (preferSource) console.log(`[AI Tool Call] ?? SHOPLINE ?????/SHOPLINE ???`);
        const result = await unifiedLookupById(config, orderId, context?.brandId, preferSource);

        if (!result.found || result.orders.length === 0) {
          console.log(`[AI Tool Call] ????: ${orderId}`);
          return JSON.stringify({ success: true, found: false, message: `????????? ${orderId} ????????????????????????????????????????????????????????????????????????????????????????????` });
        }

        const order = result.orders[0];
        const statusLabel = getUnifiedStatusLabel(order.status, result.source);
        console.log(`[AI Tool Call] ????: ${orderId}???: ${result.source}???: ${statusLabel}`);

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
        console.log("[AI Tool Call] lookup_order_by_product_and_phone???:", productName, "index:", productIndex, "??:", phone);

        if (!phone) {
          return JSON.stringify({ success: false, error: "???????" });
        }

        if (!productName && !productIndex) {
          console.log("[AI Tool Call] ????????????????????");
          return JSON.stringify({
            success: false,
            error: "????????? product_index ????????????????????????????????????????????",
            require_product: true,
          });
        }

        const pages = getCachedPages();

        const stripClean = (s: string) => s
          .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "")
          .replace(/[??????????????????????????]/g, "")
          .replace(/[^\p{L}\p{N}]/gu, "")
          .toLowerCase();

        let matchedPages: typeof pages = [];

        if (productIndex > 0 && productIndex <= pages.length) {
          matchedPages = [pages[productIndex - 1]];
          console.log("[AI Tool Call] ?? product_index #" + productIndex + " ????:", matchedPages[0].productName);
        }

        if (matchedPages.length === 0 && productName) {
          const cleanInput = stripClean(productName);
          const inputTokens = productName.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(t => t.length > 0);
          console.log("[AI Tool Call] ????????:", cleanInput, "??:", inputTokens);

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
                console.log("[AI Tool Call] ????????:", candidates.map(s => s.page.productName));
                const matchList = candidates.map((s, i) => `#${pages.indexOf(s.page) + 1}?${s.page.productName}`).join("\n");
                return JSON.stringify({
                  success: true,
                  found: false,
                  ambiguous: true,
                  message: `?????????????????????\n${matchList}`,
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

              const allNames = [officialName, ...(keywords ? keywords.split(/[?,?]/) : [])].map(n => stripClean(n.trim()));
              const cleanInput = stripClean(productName);
              const matched = allNames.some(n => n.length >= 2 && (n.includes(cleanInput) || cleanInput.includes(n)));
              if (matched) {
                console.log(`[AI Tool Call] ???????: ?${productName}???${officialName}?page_id=${pageId}`);
                matchedPages = [{ pageId: pageId.toString(), productName: officialName }];
                break;
              }
            }
            if (matchedPages.length > 0) break;
          }
        }

        if (matchedPages.length === 0) {
          console.log("[AI Tool Call] ??????????????????????????:", productName);
          return JSON.stringify({
            success: false,
            error: `????${productName}???????????????? page_id???????????????????????????`,
            require_product: true,
          });
        }

        console.log("[AI Tool Call] ????:", matchedPages.length, "????:", matchedPages.slice(0, 5).map(p => `${p.productName}(${p.pageId})`).join(", "), matchedPages.length > 5 ? "..." : "");
        let allResults: any[] = [];
        let orderSource: string = "superlanding";
        const preferSourceProduct = context?.preferShopline ? "shopline" as const : undefined;

        if (preferSourceProduct) {
          console.log(`[AI Tool Call] ??/SHOPLINE ?????? SHOPLINE ???????`);
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
          console.log(`[AI Tool Call] ?? ${context?.brandId || "??"} SuperLanding ???????????...`);
          const unifiedResult = await unifiedLookupByProductAndPhone(config, matchedPages, phone, context?.brandId, preferSourceProduct);
          if (unifiedResult.found) {
            allResults = unifiedResult.orders;
            orderSource = unifiedResult.source;
          }
        }

        if (allResults.length === 0) {
          return JSON.stringify({ success: true, found: false, message: `????????? + SHOPLINE???????????????? ${matchedPages.length} ?????????????????????????????????????` });
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

        console.log("[AI Tool Call] ??", uniqueOrders.length, "?????????");
        const formattedList = orderSummaries.map(o => `- **${o.order_id}** | ${o.created_at || ""} | $${o.amount ?? ""} | **${o.status || ""}**`).join("\n");
        const onePageBlocks = orderSummaries.map(o => formatOrderOnePage(o));
        const one_page_full = onePageBlocks.join("\n\n---\n\n");
        const multiOrderNote = uniqueOrders.length > 1
          ? `???????+???? ${uniqueOrders.length} ????????????????????????????????\n${formattedList}\n??????????????????????????`
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
        console.log("[AI Tool Call] lookup_order_by_date_and_contact???:", contact, "??:", beginDate, "~", endDate, "page_id:", pageId || "(?)");

        if (!contact || !beginDate || !endDate) {
          return JSON.stringify({ success: false, error: "????????????" });
        }

        const diffDays = Math.round((new Date(endDate).getTime() - new Date(beginDate).getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays > 31) {
          return JSON.stringify({ success: false, error: "???????? 31 ?????????" });
        }

        const fetchParams: Record<string, string> = {
          begin_date: beginDate,
          end_date: endDate,
        };
        if (pageId) {
          fetchParams.page_id = pageId;
        } else {
          console.warn("[AI Tool Call] lookup_order_by_date_and_contact ??? page_id??????????????31??????");
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
          console.log("[AI Tool Call] SuperLanding ??????????? SHOPLINE...");
          const preferSourceDate = context?.preferShopline ? "shopline" as const : undefined;
          const unifiedResult = await unifiedLookupByDateAndContact(config, contact, beginDate, endDate, pageId, context?.brandId, preferSourceDate);
          if (unifiedResult.found) {
            matched.push(...unifiedResult.orders);
            dateOrderSource = unifiedResult.source;
          }
        }

        if (matched.length === 0) {
          return JSON.stringify({ success: true, found: false, message: "????????? + SHOPLINE????????????????" });
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

        console.log("[AI Tool Call] ??", matched.length, "?????????");
        const dateFormattedList = orderSummaries.map(o => `- **${o.order_id}** | ${o.created_at || ""} | $${o.amount ?? ""} | **${o.status || ""}**`).join("\n");
        const onePageBlocks = orderSummaries.map(o => formatOrderOnePage(o));
        const one_page_full = onePageBlocks.join("\n\n---\n\n");
        const multiOrderNote = matched.length > 1
          ? `??????????????????? ${matched.length} ????????????????????????????????\n${dateFormattedList}\n??????????????????????????`
          : undefined;
        return JSON.stringify({ success: true, found: true, total: matched.length, orders: orderSummaries, truncated, note: multiOrderNote, formatted_list: matched.length > 1 ? dateFormattedList : undefined, one_page_summary: matched.length === 1 ? onePageBlocks[0] : undefined, one_page_full });
      }

      return JSON.stringify({ success: false, error: `?????: ${toolName}` });
    } catch (err: any) {
      console.error("[AI Tool Call] ????:", toolName, err.message);
      return JSON.stringify({ success: false, error: `?????${err.message}` });
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
        brand_name: brand?.name || "??",
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
      return res.status(400).json({ success: false, error: "no_api_key", message: "???????????? OpenAI API Key" });
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
        console.log(`[Sandbox] ?? ${chatMessages.length - 1} ?????? OpenAI?? Function Calling Tools?`);
      } else {
        chatMessages.push({ role: "user", content: message });
        console.log("[Sandbox] ??????????????? Function Calling Tools?");
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
        console.log(`[Sandbox] AI ?? ${responseMessage.tool_calls.length} ? Tool Call?? ${loopCount} ??`);

        chatMessages.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);

        for (const toolCall of responseMessage.tool_calls) {
          const fnName = toolCall.function.name;
          let fnArgs: Record<string, string> = {};
          try {
            fnArgs = JSON.parse(toolCall.function.arguments);
          } catch (_e) {
            console.error("[Sandbox] Tool Call ??????:", toolCall.function.arguments);
            chatMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ success: false, error: "???????????" }),
            });
            continue;
          }

          console.log(`[Sandbox] ?? Tool: ${fnName}???:`, fnArgs);
          sandboxToolLog.push(`Tool: ${fnName}(${JSON.stringify(fnArgs)})`);
          const toolResult = await executeToolCall(fnName, fnArgs, { brandId: brand_id ? parseInt(brand_id) : undefined });
          console.log(`[Sandbox] Tool ??????: ${toolResult.length} ??`);

          if (fnName === "transfer_to_human") {
            sandboxTransferTriggered = true;
            sandboxTransferReason = (fnArgs.reason || "AI ????????").trim();
            sandboxToolLog.push(`>>> AI ???????????????${sandboxTransferReason}`);
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

      let reply = responseMessage?.content || "???AI ???????";
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
      const errorMessage = err?.message || "????";
      if (errorMessage.includes("401") || errorMessage.includes("Incorrect API key") || errorMessage.includes("invalid_api_key")) {
        return res.status(400).json({ success: false, error: "invalid_api_key", message: "OpenAI API Key ???????????????" });
      }
      console.error("[Sandbox] AI ????:", errorMessage);
      return res.status(500).json({ success: false, error: "api_error", message: `AI ?????${errorMessage}` });
    }
  });

  app.post("/api/sandbox/upload", authMiddleware, sandboxUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "?????" });
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") {
      return res.status(400).json({ success: false, message: "???????????? OpenAI API Key" });
    }

    const decodedFilename = fixMulterFilename(req.file.originalname);
    console.log("[????] ???????:", decodedFilename);
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
        reply: `??????????${decodedFilename}??\n\n??? LINE ??????????????????????????????????\n\n?? ?????\n- ???????\n- ???????????\n- ???????????????????????`,
        fileUrl,
        fileType: "video",
        transferred: true,
        transfer_reason: "??????????",
        tool_log: ["Tool: auto_transfer_video()", ">>> ??????????????"],
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
            { type: "text", text: "??????????????????????????????????????????" },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        });

        const completion = await openai.chat.completions.create({
          model: getOpenAIModel(),
          messages: chatMessages,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
        const reply = completion.choices[0]?.message?.content || "?????????????????";
        return res.json({ success: true, reply, fileUrl, fileType: "image" });
      } catch (err: any) {
        console.error("[Sandbox Upload] AI Vision error:", err.message);
        return res.json({ success: true, reply: "????????AI ???????????????????", fileUrl, fileType: "image" });
      }
    }

    return res.status(400).json({ message: "????????" });
  });

  app.get("/api/knowledge-files", authMiddleware, (_req, res) => {
    return res.json(storage.getKnowledgeFiles());
  });

  app.post("/api/knowledge-files", authMiddleware, managerOrAbove, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "????????????????????.txt, .csv, .pdf, .docx, .xlsx, .md???????????????" });
    const decodedFilename = fixMulterFilename(req.file.originalname);
    console.log("[???] ???????:", decodedFilename);
    const ext = path.extname(decodedFilename).toLowerCase();
    if (isImageFile(decodedFilename)) {
      const filePath = path.join(uploadDir, req.file.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ message: "????????????????????????????????" });
    }
    const brandId = req.body.brand_id ? parseInt(req.body.brand_id) : undefined;
    let content: string | undefined;
    try {
      const filePath = path.join(uploadDir, req.file.filename);
      content = await parseFileContent(filePath, decodedFilename);
      if (content) content = stripBOM(content);
      if (content && content.length > 500000) {
        content = content.substring(0, 500000) + "\n\n[????????????]";
      }
    } catch (err) {
      console.error(`[???] ?????? ${decodedFilename}:`, err);
      content = `[??????: ${decodedFilename}]`;
    }
    const file = storage.createKnowledgeFile(req.file.filename, decodedFilename, req.file.size, brandId, content || undefined);
    return res.json(file);
  });

  app.delete("/api/knowledge-files/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const files = storage.getKnowledgeFiles();
    const file = files.find((f) => f.id === id);
    if (file) {
      const filePath = path.join(uploadDir, file.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    if (!storage.deleteKnowledgeFile(id)) return res.status(404).json({ message: "?????" });
    return res.json({ success: true });
  });

  app.get("/api/image-assets", authMiddleware, (req, res) => {
    const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
    return res.json(storage.getImageAssets(brandId));
  });

  app.post("/api/image-assets", authMiddleware, managerOrAbove, imageAssetUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "??????????????? .jpg, .jpeg, .png, .gif, .webp" });
    const decodedFilename = fixMulterFilename(req.file.originalname);
    console.log("[????] ???????:", decodedFilename);
    const brandId = req.body.brand_id ? parseInt(req.body.brand_id) : undefined;
    const displayName = req.body.display_name ? fixMulterFilename(req.body.display_name) : decodedFilename;
    const description = req.body.description || "";
    const keywords = req.body.keywords || "";
    const asset = storage.createImageAsset(req.file.filename, decodedFilename, displayName, description, keywords, req.file.size, req.file.mimetype, brandId);
    return res.json(asset);
  });

  app.put("/api/image-assets/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const { display_name, description, keywords } = req.body;
    const data: Record<string, string> = {};
    if (display_name !== undefined) data.display_name = display_name;
    if (description !== undefined) data.description = description;
    if (keywords !== undefined) data.keywords = keywords;
    if (!storage.updateImageAsset(id, data)) return res.status(404).json({ message: "?????" });
    return res.json({ success: true });
  });

  app.delete("/api/image-assets/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const asset = storage.getImageAsset(id);
    if (asset) {
      const filePath = path.join(imageAssetsDir, asset.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    if (!storage.deleteImageAsset(id)) return res.status(404).json({ message: "?????" });
    return res.json({ success: true });
  });

  app.get("/api/image-assets/file/:filename", (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(imageAssetsDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: "?????" });
    res.sendFile(filePath);
  });

  app.get("/api/team", authMiddleware, managerOrAbove, (_req, res) => {
    return res.json(storage.getTeamMembers());
  });

  app.post("/api/team", authMiddleware, superAdminOnly, (req, res) => {
    const { username, password, display_name, role } = req.body;
    if (!username || !password || !display_name) {
      return res.status(400).json({ message: "????????" });
    }
    if (!["super_admin", "marketing_manager", "cs_agent"].includes(role)) {
      return res.status(400).json({ message: "????? super_admin, marketing_manager ? cs_agent" });
    }
    try {
      const user = storage.createUser(username, password, display_name, role);
      return res.json({ success: true, member: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, created_at: user.created_at } });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return res.status(400).json({ message: "??????" });
      }
      return res.status(500).json({ message: "????" });
    }
  });

  app.put("/api/team/:id", authMiddleware, superAdminOnly, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const { display_name, role, password } = req.body;
    if (!display_name) return res.status(400).json({ message: "?????" });
    if (!["super_admin", "marketing_manager", "cs_agent"].includes(role)) return res.status(400).json({ message: "????" });
    if (!storage.updateUser(id, display_name, role, password || undefined)) {
      return res.status(404).json({ message: "?????" });
    }
    return res.json({ success: true });
  });

  app.delete("/api/team/:id", authMiddleware, superAdminOnly, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const s = (req as any).session;
    if (id === s.userId) {
      return res.status(400).json({ message: "???????????" });
    }
    if (!storage.deleteUser(id)) return res.status(404).json({ message: "?????" });
    return res.json({ success: true });
  });

  app.get("/api/team/:id/brand-assignments", authMiddleware, (req: any, res) => {
    const userId = parseIdParam(req.params.id);
    if (userId === null) return res.status(400).json({ message: "??? ID" });
    const me = req.session?.userId;
    const role = req.session?.userRole ?? req.session?.role;
    const isSupervisor = role === "super_admin" || role === "marketing_manager";
    if (userId !== me && !isSupervisor) return res.status(403).json({ message: "????????????" });
    const user = storage.getUserById(userId);
    if (!user) return res.status(404).json({ message: "?????" });
    const assignments = storage.getAgentBrandAssignments(userId);
    return res.json(assignments);
  });

  app.put("/api/team/:id/brand-assignments", authMiddleware, managerOrAbove, (req, res) => {
    const userId = parseIdParam(req.params.id);
    if (userId === null) return res.status(400).json({ message: "??? ID" });
    const { assignments } = req.body || {};
    if (!Array.isArray(assignments)) return res.status(400).json({ message: "??? assignments ??" });
    const user = storage.getUserById(userId);
    if (!user) return res.status(404).json({ message: "?????" });
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
    if (userId === null) return res.status(400).json({ message: "??? ID" });
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
    if (userId === null) return res.status(400).json({ message: "??? ID" });
    const me = req.session?.userId;
    const role = req.session?.userRole ?? req.session?.role;
    const isSelf = me === userId;
    const isAdmin = role === "super_admin";
    if (!isSelf && !isAdmin) return res.status(403).json({ message: "????????????????" });
    if (!req.file) return res.status(400).json({ message: "????? (file)" });
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
    if (!userId) return res.status(401).json({ message: "???" });
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
    if (!userId) return res.status(401).json({ message: "???" });
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
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "??????" });
    const byUserId = req.session?.userId;
    if (!byUserId) return res.status(401).json({ message: "???" });
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
        if (!isManager) return res.status(403).json({ message: "????????????????????" });
        const ok = assignment.assignCaseManual(contactId, bodyAgentId!, byUserId, req.body?.reason ?? null);
        if (!ok) {
          const members = storage.getTeamMembers().filter((m: { role: string }) => m.role === "cs_agent");
          const target = members.find((m: { id: number }) => m.id === bodyAgentId);
          if (!target) return res.status(400).json({ message: "?????????????" });
          const openCases = target.open_cases_count ?? storage.getOpenCasesCountForAgent(bodyAgentId!);
          const maxActive = target.max_active_conversations ?? 10;
          return res.status(400).json({ message: `????????? (${openCases}/${maxActive})` });
        }
        agentId = bodyAgentId;
      } else {
        agentId = assignment.assignCase(contactId);
        if (agentId == null) return res.status(503).json({ message: "?????????????1) ??????????? 2) ???????????????????" });
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
      console.error("[assign] ????", contactId, err);
      if (isConstraint) {
        return res.status(500).json({ message: "?????????????????????????????????" });
      }
      return res.status(500).json({ message: msg && msg.length < 200 ? msg : "??????????????" });
    }
  });

  app.post("/api/contacts/:id/unassign", authMiddleware, (req: any, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "??????" });
    const byUserId = req.session?.userId;
    if (!byUserId) return res.status(401).json({ message: "???" });
    const isManager = (req.session?.userRole ?? req.session?.role) === "super_admin" || (req.session?.userRole ?? req.session?.role) === "marketing_manager";
    if (!isManager) return res.status(403).json({ message: "?????????" });
    const ok = assignment.unassignCase(contactId, byUserId);
    if (!ok) return res.status(404).json({ message: "?????" });
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
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const contact = storage.getContact(contactId);
    if (!contact) return res.status(404).json({ message: "??????" });
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
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
    const { new_agent_id, note } = req.body || {};
    const newAgentId = new_agent_id != null ? Number(new_agent_id) : null;
    if (newAgentId == null || !Number.isInteger(newAgentId)) return res.status(400).json({ message: "??? new_agent_id" });
    const byAgentId = req.session?.userId;
    if (!byAgentId) return res.status(401).json({ message: "???" });
    try {
      const ok = assignment.reassignCase(contactId, newAgentId, byAgentId, note || null);
      if (!ok) return res.status(404).json({ message: "?????" });
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
        console.error("[reassign] ????", contactId, err);
        return res.status(500).json({ message: "?????????????????????????????????" });
      }
      throw err;
    }
  });

  app.get("/api/contacts/:id/assignment-history", authMiddleware, (req, res) => {
    const contactId = parseIdParam(req.params.id);
    if (contactId === null) return res.status(400).json({ message: "??? ID" });
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
    if (!userId) return res.status(401).json({ message: "???" });
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
    const statusLabels: Record<string, string> = { pending: "???", processing: "???", awaiting_human: "???", assigned: "???", waiting_customer: "?????", high_risk: "??", new_case: "???", closed: "???", resolved: "???" };
    const statusDistribution = Object.entries(statusCount).map(([status, count]) => ({ label: statusLabels[status] || status, count }));
    const unassignedThreshold = 5;
    const alerts: { type: string; count: number; threshold?: number }[] = [];
    if (overdue > 0) alerts.push({ type: "????", count: overdue });
    if (urgent > 0) alerts.push({ type: "????", count: urgent });
    if (vipUnhandled > 0) alerts.push({ type: "VIP ???", count: vipUnhandled });
    if (unassigned >= unassignedThreshold) alerts.push({ type: "?????", count: unassigned, threshold: unassignedThreshold });
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
    if (contactId !== undefined && Number.isNaN(contactId)) return res.status(400).json({ message: "??? contact_id" });
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
      { name: "????", value: userMsgs, pct: totalMsgs > 0 ? Math.round((userMsgs / totalMsgs) * 1000) / 10 : 0 },
      { name: "AI ??", value: aiMsgs, pct: totalMsgs > 0 ? Math.round((aiMsgs / totalMsgs) * 1000) / 10 : 0 },
      { name: "????", value: adminMsgs, pct: totalMsgs > 0 ? Math.round((adminMsgs / totalMsgs) * 1000) / 10 : 0 },
    ];

    const statusLabels: Record<string, string> = {
      pending: "???", processing: "???", resolved: "???",
      ai_handling: "AI ???", awaiting_human: "???", high_risk: "???", closed: "???",
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
      order_inquiry: "????", product_consult: "????", return_refund: "????",
      complaint: "??", order_modify: "????", general: "????", other: "??",
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
        "?????": ["???", "??", "??", "??", "??", "??", "??"],
        "????": ["??", "??", "??", "??", "??"],
        "????": ["??", "??", "??", "??"],
        "????": ["??", "??", "??", "??", "??", "??", "??", "??", "??"],
        "??/???": ["??", "??", "??", "??", "??", "??"],
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
      "???", "???", "???", "??", "??", "???", "???", "???", "???",
      "??", "???", "??", "???", "??", "??", "??", "???", "???",
      "??", "??", "???", "??", "??", "??", "??", "??", "??", "??",
      "???", "???", "??", "???", "??", "??", "??", "??", "??",
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
      "????": "?|??|??|??|??|??",
      "???": "???|??|??|???|?|?|?",
      "????": "??|??|??|???|???|???",
      "????": "??|??|??|??|??",
      "????": "???|???|??|??|???|?????",
      "????": "??|?????|???|??",
      "????": "???|???|??|??|??",
      "????": "??|??|??|??|??",
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
      painPoints.push(`????? ${transferRate}%?${transferCount}/${active} ??????????`);
    }
    if (issueTypeDistribution.length > 0) {
      const returnIssues = issueTypeDistribution.find(i => i.name === "????");
      if (returnIssues && active > 0 && (returnIssues.value / active) * 100 > 20) {
        painPoints.push(`??????????${returnIssues.value} ??? ${Math.round((returnIssues.value / active) * 100)}%??`);
        suggestions.push("??????? SOP ? AI ???????");
      }
    }
    if (completionRate !== null && completionRate < 30 && active > 3) {
      painPoints.push(`?????? ${completionRate}%?${resolvedCount}/${active}??????????`);
      suggestions.push("?????????????????????");
    }
    const alertTimeouts = (db.prepare(`
      SELECT COUNT(*) as cnt FROM system_alerts WHERE alert_type = 'timeout_escalation' AND created_at >= ? AND created_at <= ?
    `).get(startDate, endDate) as { cnt: number })?.cnt || 0;
    if (alertTimeouts > 0) {
      painPoints.push(`??/?????? ${alertTimeouts} ???????????`);
      suggestions.push("???? API ????????");
    }
    if (customerConcerns.length > 0) {
      const topConcern = customerConcerns[0];
      if (topConcern.count >= 2) {
        painPoints.push(`?????${topConcern.concern}????${topConcern.count} ?????????`);
      }
    }
    if (!aiHasData && aiMsgs === 0) {
      suggestions.push("???? AI ????????? AI ??????????");
    }
    if (orderQueryHasData && orderQuerySuccessRate !== null && orderQuerySuccessRate < 50) {
      suggestions.push(`?????? ${orderQuerySuccessRate}%??????? API ??????????`);
    }
    if (allTransferReasons.length > 0) {
      const topReason = allTransferReasons[0];
      suggestions.push(`??????????${topReason.reason}??${topReason.count} ???????????? AI ???`);
    }
    if (hotProducts.length > 0) {
      suggestions.push(`???????${hotProducts.slice(0, 3).map(p => p.name).join("?")}???????????`);
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
      webhook_sig_fail: "Webhook ????",
      dedupe_hit: "??????",
      lock_timeout: "?????",
      order_lookup_fail: "??????",
      timeout_escalation: "AI ????",
      transfer: "????",
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
    if (!keyword) return res.status(400).json({ message: "??????" });
    const rule = storage.createMarketingRule(keyword, pitch || "", url || "");
    return res.json({ success: true, rule });
  });

  app.put("/api/marketing-rules/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    const { keyword, pitch, url } = req.body;
    if (!keyword) return res.status(400).json({ message: "??????" });
    if (!storage.updateMarketingRule(id, keyword, pitch || "", url || "")) {
      return res.status(404).json({ message: "?????" });
    }
    return res.json({ success: true });
  });

  app.delete("/api/marketing-rules/:id", authMiddleware, managerOrAbove, (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ message: "??? ID" });
    if (!storage.deleteMarketingRule(id)) return res.status(404).json({ message: "?????" });
    return res.json({ success: true });
  });

  return httpServer;
}
