/**
 * Prompt 架構分層（SSOT）：
 * - Global（settings.system_prompt）：共通 SOP、安全底線、語氣基線
 * - Brand（brands.system_prompt）：品牌人設、語氣、品牌現實
 * - 本檔僅組裝結構區塊 + 排班等「系統資料」+ 極簡程式層流程標記；冗長業務話術應在 DB，不在此硬編。
 */
import { storage } from "../storage";
import * as assignment from "../assignment";
import { getSuperLandingConfig, ensurePagesCacheLoaded, buildProductCatalogPrompt } from "../superlanding";
import type { AgentScenario, ScenarioOverrideEntry } from "./phase1-types";
import type { MarketingRule } from "@shared/schema";
const IMAGE_PRECISION_COT_BLOCK = `

--- 圖片（工具契約）---
客戶傳圖時判斷是否與商品／訂單／物流相關；回覆遵守全域／品牌指令。傳圖給客戶用 send_image_to_customer（name 須對應下方 IMAGE 清單）；勿臆測隱私。
`;

/** 從完整 prompt 中依標題去重，避免同一個 "--- 標題 ---" 區塊重複出現（保留首次出現） */
export function normalizeSections(text: string): string {
  const re = /---\s*([^\n-]+?)\s*---/g;
  const matches: { title: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ title: m[1].trim().toLowerCase(), index: m.index });
  }
  if (matches.length === 0) return text;
  const seen = new Set<string>();
  const parts: string[] = [];
  let pos = 0;
  for (let i = 0; i < matches.length; i++) {
    const curr = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    if (seen.has(curr.title)) {
      pos = end;
      continue;
    }
    seen.add(curr.title);
    if (curr.index > pos) parts.push(text.slice(pos, curr.index));
    parts.push(text.slice(curr.index, end));
    pos = end;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return parts.join("");
}

/** 全域：安全與誠實、不亂編、不承諾未確認、不越權、輸出語言/簡潔度（從 DB system_prompt 讀取，僅做去重） */
export function buildGlobalPolicyPrompt(): string {
  const raw = storage.getSetting("system_prompt") || "你是一位熱情的品牌購物顧問，請誠實回覆、不捏造資訊。";
  return raw.trim();
}

/** 品牌：語氣、稱呼、emoji、語調、禁語 */
export function buildBrandPersonaPrompt(brandId?: number): string {
  if (!brandId) return "";
  const brand = storage.getBrand(brandId);
  if (!brand?.system_prompt?.trim()) return "";
  return "\n\n--- 品牌語氣與規範 ---\n" + brand.system_prompt.trim();
}

/** 排班資料（系統設定）；語氣安撫由 Global／Brand 承載 */
export function buildHumanHoursPrompt(): string {
  const schedule = storage.getGlobalSchedule();
  const unavailableReason = assignment.getUnavailableReason();
  const block = `

--- 排班時段（系統資料）---
上班 ${schedule.work_start_time}～${schedule.work_end_time}；午休 ${schedule.lunch_start_time}～${schedule.lunch_end_time}。
專人轉接請用 transfer_to_human；實際派案由程式依排班處理。`;
  const nowHint =
    unavailableReason === "weekend"
      ? "\n（目前：週末／非服務日）"
      : unavailableReason === "lunch"
        ? `\n（目前：午休 ${schedule.lunch_start_time}～${schedule.lunch_end_time}）`
        : unavailableReason === "after_hours"
          ? `\n（目前：非服務時段，已過 ${schedule.work_end_time}）`
          : "";
  return block + nowHint;
}

/** 情境隔離：僅標示本輪邊界（細節在 Global／Brand） */
export function buildScenarioIsolationBlock(scenario: AgentScenario): string {
  const blocks: Record<AgentScenario, string> = {
    ORDER_LOOKUP: `

--- 情境：訂單／物流（本輪唯一焦點）---
本輪你只負責查單與物流。
✅ 可以做：查單、回報物流狀態、協助追蹤。
❌ 禁止做：推薦商品、展開型錄、主動提起促銷活動、討論退換貨流程。
若客戶同時問了其他類型問題，簡短回應後引導回查單主題。`,
    AFTER_SALES: `

--- 情境：售後／退換貨（本輪唯一焦點）---
本輪你只負責售後處理。
✅ 可以做：安撫客戶、了解問題、引導退換流程、必要時轉接真人。
❌ 禁止做：推薦其他商品、展開型錄、主動提起促銷或新品。
需專人時使用 transfer_to_human。`,
    PRODUCT_CONSULT: `

--- 情境：商品諮詢（本輪唯一焦點）---
本輪你只負責商品諮詢。
✅ 可以做：回答規格、價格、庫存、使用方式，提供購買連結。
❌ 禁止做：主動查單（除非客戶本句已含單號）、展開退換貨流程。`,
    GENERAL: `

--- 情境：一般問答 ---
本輪為一般對話。不確定客戶需求時可簡單詢問或引導轉人工。
❌ 禁止做：未經確認就主動查單或展開退換貨。`,
  };
  return blocks[scenario] || "";
}

/** 僅注入 Phase1／營運在 flags 內明確覆寫的物流說明；其餘由 Brand／Global 文案承載 */
function resolveShippingHintLine(options: { shippingHintOverride?: string }): string {
  return options.shippingHintOverride?.trim() || "";
}

/**
 * Phase 1.5：情境專屬流程區塊（取代 iso 模式下混合式 buildFlowPrinciplesPrompt，避免跨情境污染）。
 */
export function buildScenarioFlowBlock(
  scenario: AgentScenario,
  opts: { returnFormUrl?: string; shippingHintOverride?: string }
): string {
  const ship = resolveShippingHintLine(opts);
  const form = opts.returnFormUrl?.trim();
  const formLine = form ? `\n退換貨表單（品牌設定）：${form}` : "";
  const shipLine = ship ? `\n物流補充（系統覆寫）：${ship}` : "";
  switch (scenario) {
    case "ORDER_LOOKUP":
      return `

--- 流程（訂單／物流）---${shipLine}
使用查單相關工具；查無或需專人時 transfer_to_human。`;
    case "AFTER_SALES":
      return `

--- 流程（售後／退換）---${formLine}${shipLine}
需專人判斷時 transfer_to_human。`;
    case "PRODUCT_CONSULT":
      return `

--- 流程（商品諮詢）---${shipLine}
除非本句已提供單號且要查物流，否則勿主動查單。`;
    case "GENERAL":
    default:
      return `

--- 流程（一般）---${shipLine}
超出權限或客戶要求專人時 transfer_to_human。`;
  }
}

/** 品牌 DB 全文易含跨情境規則；iso 模式下截斷為摘要，降低污染（flags 關閉仍用完整 buildBrandPersonaPrompt） */
export function buildBrandPersonaPromptIsoThin(brandId?: number): string {
  if (!brandId) return "";
  const brand = storage.getBrand(brandId);
  const raw = (brand?.system_prompt || "").trim();
  if (!raw) return "";
  const cap = 1800;
  if (raw.length <= cap) {
    return "\n\n--- 品牌語氣與規範（摘要）---\n" + raw;
  }
  const forbiddenIdx = raw.lastIndexOf("禁止");
  if (forbiddenIdx > 0 && forbiddenIdx < raw.length - 10) {
    const head = raw.slice(0, Math.min(cap - 400, forbiddenIdx));
    const tail = raw.slice(forbiddenIdx);
    const body = head + "\n...\n" + tail;
    return "\n\n--- 品牌語氣與規範（摘要）---\n" + body;
  }
  const body = raw.slice(0, cap) + "\n[以下品牌細節已截斷；請優先遵守本輪「情境」流程區塊]";
  return "\n\n--- 品牌語氣與規範（摘要）---\n" + body;
}

/** 非情境隔離時的極簡程式層提示；SOP 與語氣在 Global／Brand */
export function buildFlowPrinciplesPrompt(options: {
  returnFormUrl?: string;
  shippingHintOverride?: string;
}): string {
  const shippingHint = resolveShippingHintLine(options);
  const form = options.returnFormUrl?.trim();
  const lines = [
    "",
    "--- 流程約束（程式層）---",
    "查單／售後／轉接依工具結果與上文事實；需專人時使用 transfer_to_human。",
    "勿對客戶唸內部欄位名或原始 JSON。",
  ];
  if (shippingHint) lines.push(`物流補充（系統覆寫）：${shippingHint}`);
  if (form) lines.push(`退換貨表單（品牌設定）：${form}`);
  return "\n\n" + lines.join("\n");
}

/** 商品清單（catalog），穩定 section key 為 --- CATALOG --- */
export async function buildCatalogPrompt(brandId?: number): Promise<string> {
  const config = getSuperLandingConfig(brandId);
  const pages = await ensurePagesCacheLoaded(config);
  const body = buildProductCatalogPrompt(pages);
  if (!body.trim()) return "";
  return "\n\n--- CATALOG ---\n" + body.trim();
}

const CATALOG_LOAD_TIMEOUT_MS = 3000;

/** Phase 106.6：catalog 為加分項；超時則本輪略過，避免阻塞 webhook／首輪 LLM */
export async function buildCatalogPromptWithTimeout(brandId?: number): Promise<string> {
  return Promise.race([
    buildCatalogPrompt(brandId),
    new Promise<string>((resolve) => {
      setTimeout(() => {
        console.warn("[catalog] 載入超過 3 秒，本輪 prompt 不含 catalog 區塊");
        resolve("");
      }, CATALOG_LOAD_TIMEOUT_MS);
    }),
  ]);
}

/**
 * 從 marketing_rules 取出品牌的導購規則，注入 prompt。
 * 如果 userMessage 命中某條規則的 keyword，該規則會被標記為「本輪命中」優先顯示。
 */
export function buildMarketingPrompt(brandId?: number, userMessage?: string): string {
  const rules = storage.getMarketingRules(brandId);
  if (!rules || rules.length === 0) return "";

  const msg = (userMessage || "").toLowerCase();
  const hit: MarketingRule[] = [];
  const rest: MarketingRule[] = [];

  for (const r of rules) {
    const kw = (r.keyword || "").toLowerCase();
    if (kw && msg.includes(kw)) {
      hit.push(r);
    } else {
      rest.push(r);
    }
  }

  const lines: string[] = [];

  if (hit.length > 0) {
    lines.push("【本輪客人提到的商品/活動——請自然帶入推薦】");
    for (const r of hit) {
      const urlPart = r.url ? `\n  購買連結：${r.url}` : "";
      lines.push(`- 關鍵字「${r.keyword}」：${r.pitch}${urlPart}`);
    }
  }

  if (rest.length > 0) {
    lines.push("");
    lines.push("【品牌目前的活動/推薦（客人問到相關話題時可自然帶入，不要硬推）】");
    for (const r of rest) {
      const urlPart = r.url ? `（連結：${r.url}）` : "";
      lines.push(`- ${r.keyword}：${r.pitch}${urlPart}`);
    }
  }

  return "\n\n--- 產品導購規則 ---\n" + lines.join("\n");
}

/**
 * RAG-Lite 知識庫上限：8000 字元。
 * 即使外層傳入更大值（如 80000），也會被限制在此上限。
 * 因為 RAG-Lite 只取 Top 5 篇相關文件，不需要更多。
 * 商品資料走 product_catalog + recommend_products 工具，不走知識庫。
 */
const KNOWLEDGE_RAG_LITE_CAP = 8000;

export function buildKnowledgePrompt(
  brandId?: number,
  maxTotalChars = 8000,
  userMessage?: string,
  planMode?: string
): string {
  const cap = Math.min(maxTotalChars, KNOWLEDGE_RAG_LITE_CAP);
  const files = storage.getKnowledgeFiles(brandId);
  const withContent = files.filter((f) => f.content && f.content.trim().length > 0);
  if (withContent.length === 0) return "";

  const filtered = withContent.filter((f) => {
    if (planMode && f.forbidden_modes) {
      const forbidden = String(f.forbidden_modes)
        .toLowerCase()
        .split(/[,\s|]+/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (forbidden.includes(planMode.toLowerCase())) return false;
    }
    if (planMode && f.allowed_modes && String(f.allowed_modes).trim()) {
      const allowed = String(f.allowed_modes)
        .toLowerCase()
        .split(/[,\s|]+/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (!allowed.includes(planMode.toLowerCase())) return false;
    }
    return true;
  });

  const pool = filtered;
  if (pool.length === 0) return "";

  if (!userMessage || !userMessage.trim()) {
    return assembleKnowledgeBlock(pool.slice(0, 5), cap);
  }

  const keywords = extractSearchKeywords(userMessage);

  const scored = pool.map((f) => {
    const content = (f.content || "").toLowerCase();
    const name = (f.original_name || "").toLowerCase();
    const intent = (f.intent || "").toLowerCase();
    const category = (f.category || "").toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (name.includes(kwLower)) score += 3;
      if (intent.includes(kwLower)) score += 3;
      if (category.includes(kwLower)) score += 2;
      const matches = content.split(kwLower).length - 1;
      score += Math.min(matches, 5);
    }
    return { file: f, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((s) => s.score > 0).slice(0, 5);
  const selected = top.length > 0 ? top.map((s) => s.file) : pool.slice(0, 3);

  return assembleKnowledgeBlock(selected, cap);
}

/** 組裝知識庫區塊 */
function assembleKnowledgeBlock(files: { original_name: string; content?: string | null }[], maxTotalChars: number): string {
  let totalChars = 0;
  const blocks: string[] = [];
  for (const f of files) {
    const content = (f.content || "").trim();
    if (!content) continue;
    if (totalChars + content.length > maxTotalChars) {
      const remaining = maxTotalChars - totalChars;
      if (remaining > 200) {
        blocks.push(`[知識: ${f.original_name}]\n${content.substring(0, remaining)}\n[內容已截斷]`);
      }
      break;
    }
    blocks.push(`[知識: ${f.original_name}]\n${content}`);
    totalChars += content.length;
  }
  if (blocks.length === 0) return "";
  return "\n\n--- KNOWLEDGE ---\n" + blocks.join("\n\n");
}

/** 從使用者訊息提取搜尋關鍵字 */
function extractSearchKeywords(message: string): string[] {
  const s = message.trim();
  if (!s) return [];
  const keywords: string[] = [];
  const stopWords = new Set([
    "的", "了", "嗎", "呢", "啊", "吧", "我", "你", "他", "她",
    "這", "那", "是", "有", "在", "不", "也", "都", "就", "要",
    "會", "可以", "請", "問", "想", "幫", "看", "一下", "什麼", "怎麼",
  ]);
  const zhOnly = s.replace(/[^\u4e00-\u9fff]/g, "");
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i <= zhOnly.length - len; i++) {
      const gram = zhOnly.substring(i, i + len);
      if (!stopWords.has(gram)) keywords.push(gram);
    }
  }
  const enWords = s.match(/[a-zA-Z]{2,}/g) || [];
  keywords.push(...enWords);
  return [...new Set(keywords)];
}

/** 圖片資產清單與 CoT 說明 */
export function buildImagePrompt(brandId?: number): string {
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
  const catalog =
    "\n\n--- IMAGE ---\n僅供你參考，回覆時勿暴露內部清單。欲傳圖給客戶請使用 send_image_to_customer，傳入 name。\n以下為 name / description / keywords 對照：\n" +
    lines.join("\n");
  return IMAGE_PRECISION_COT_BLOCK + catalog;
}

export interface EnrichedPromptContext {
  planMode?: string;
  userMessage?: string;
  /** 已有訂單上下文（追問輪） */
  hasActiveOrderContext?: boolean;
  /** 使用者最近一則含圖 */
  recentUserHasImage?: boolean;
  /** Phase 1：情境隔離 */
  selectedScenario?: AgentScenario;
  scenarioIsolationEnabled?: boolean;
  logisticsHintOverride?: string;
  /** Phase 1.5：scenario_overrides 自 phase1_agent_ops_json */
  scenarioOverrides?: Partial<Record<AgentScenario, ScenarioOverrideEntry>>;
  /** contacts.waiting_for_customer，例如 cancel_form_submit（給 AI 判斷是否呼叫 mark_form_submitted） */
  waitingForCustomer?: string | null;
  /** Phase 106.6：除錯與 skipCatalog 判斷 */
  contactId?: number;
  /** contacts.customer_goal_locked（return / order_lookup / handoff 等） */
  customerGoalLocked?: string | null;
}

/** 動態注入：正在等客人填表時，提示 AI 用工具記錄「填好了」 */
export function buildWaitingFormStatusPrompt(waitingForCustomer: string | null | undefined): string {
  const waiting = waitingForCustomer?.trim() || "";
  if (!waiting || !waiting.endsWith("_form_submit")) return "";

  const formType = waiting.split("_")[0];
  const formTypeZh =
    formType === "cancel" ? "取消" : formType === "return" ? "退貨" : formType === "exchange" ? "換貨" : "";
  if (!formTypeZh) return "";

  return `

【⚠️ 目前狀態：等待客人填${formTypeZh}表單】

你之前已經給了客人${formTypeZh}表單連結。現在請特別注意客人下一句的真實意圖：

✅ 如果客人「真的明確表達已經填完表單」：
- 例如「我填好了」「填完了」「填寫送出了」「OK 填好了」「都填了」
- → 呼叫 mark_form_submitted 工具，form_type="${formType}"
- → 然後回覆「好的～收到囉，已經幫您加急處理 🙏 專員會盡快主動聯繫您」

❌ 如果客人說的是其他意思，不要呼叫 mark_form_submitted：
- 「算了 改成整筆取消好了」→ 客人改主意了，給取消表單
- 「錢還是不夠」→ 客人在補充原因，繼續陪聊
- 「填不出來」「不會填」→ 客人遇到困難，問是否要轉真人協助
- 「填到一半卡住」→ 協助客人或問是否要轉真人
- 「等等 我想換成換貨」→ 改主意，給換貨表單
- 客人問其他不相關的事 → 正常回應

判斷原則：要客人「明確表達填寫完成」才呼叫工具，
模糊、含糊、或其他話題都不要呼叫。

如果不確定，寧可問客人「請問您的表單填好了嗎？」也不要亂呼叫工具。
`;
}

export interface EnrichedPromptResult {
  full_prompt: string;
  prompt_profile: string;
  prompt_chars: number;
  sections: Array<{ key: string; title: string; length: number }>;
  includes: {
    global_policy: boolean;
    brand_persona: boolean;
    human_hours: boolean;
    flow_principles: boolean;
    catalog: boolean;
    marketing: boolean;
    knowledge: boolean;
    image: boolean;
  };
}

export function getBrandReplyMeta(brandId?: number): {
  salutationStyle: string;
  emojiPolicy: "minimal" | "allow";
  forbiddenPhrases: string[];
  terseOrderMode: boolean;
} {
  if (!brandId) {
    return { salutationStyle: "您好", emojiPolicy: "minimal", forbiddenPhrases: [], terseOrderMode: true };
  }
  const brand = storage.getBrand(brandId);
  const sp = (brand?.system_prompt || "").trim();
  const noEmoji = /勿用\s*emoji|不用\s*emoji|避免\s*emoji|少用\s*emoji/i.test(sp);
  return {
    salutationStyle: /親愛的/.test(sp) ? "親愛的顧客" : "您好",
    emojiPolicy: noEmoji ? "minimal" : "allow",
    forbiddenPhrases: [],
    terseOrderMode: true,
  };
}

/** @deprecated 保留相容 API；Minimal Safe Mode 下改為與完整 DB system_prompt 同源之濃縮片段 */
export function buildOrderLookupUltraLitePrompt(brandId?: number): string {
  const g = buildGlobalPolicyPrompt().slice(0, 1600);
  const b = buildBrandPersonaPrompt(brandId).slice(0, 500);
  return `${g}\n${b}\n\n--- 查單 ---\n依工具結果簡答，勿捏造；勿對客戶唸內部欄位或英文代碼。`;
}

export function buildOrderFollowupUltraLitePrompt(brandId?: number): string {
  return `${buildGlobalPolicyPrompt().slice(0, 800)}\n${buildBrandPersonaPrompt(brandId).slice(0, 400)}\n訂單追問：依上下文與工具，簡潔誠實。`;
}

/** @deprecated 保留相容 */
export function buildOrderLookupLitePrompt(brandId?: number): string {
  return buildOrderLookupUltraLitePrompt(brandId);
}

export function buildOrderFollowupLitePrompt(brandId?: number): string {
  return buildOrderFollowupUltraLitePrompt(brandId);
}

/**
 * 總組裝順序：Global → Brand → 情境／流程脈絡（隔離標籤 + 流程區塊 + 排班）→ CATALOG → KNOWLEDGE → IMAGE。
 * 最後 normalizeSections 去重；metadata 供 preview／除錯。
 */
export async function assembleEnrichedSystemPrompt(
  brandId?: number,
  context?: EnrichedPromptContext
): Promise<EnrichedPromptResult> {
  const useImageFull = !!context?.recentUserHasImage;
  const plan = context?.planMode || "";
  const orderLookupDietLegacy = plan === "order_lookup" || plan === "order_followup";
  const iso = !!(context?.scenarioIsolationEnabled && context?.selectedScenario);
  const sc = context?.selectedScenario;

  let orderLookupDiet = orderLookupDietLegacy;
  let skipCatalog = false;
  let skipKnowledge = false;
  let skipHumanHours = false;
  let skipFlow = false;
  let knowledgeMax = 8000;

  const scenOverride = iso && sc ? context?.scenarioOverrides?.[sc] : undefined;

  if (iso && sc) {
    orderLookupDiet = sc === "ORDER_LOOKUP";
    switch (sc) {
      case "ORDER_LOOKUP":
        skipCatalog = true;
        skipKnowledge = true;
        skipFlow = true;
        skipHumanHours = true;
        break;
      case "AFTER_SALES":
        skipCatalog = true;
        break;
      case "PRODUCT_CONSULT":
        break;
      case "GENERAL":
        skipCatalog = true;
        knowledgeMax = 8000;
        break;
    }
    if (scenOverride?.knowledge_mode === "none") {
      skipKnowledge = true;
    } else if (scenOverride?.knowledge_mode === "minimal") {
      skipKnowledge = false;
      knowledgeMax = 8000;
    } else if (scenOverride?.knowledge_mode === "full") {
      skipKnowledge = false;
      knowledgeMax = 8000;
    }
  }

  /** Phase 106.6：售後／表單／目標鎖定等情境不需塞入商品目錄（非 iso 時原先仍會拉 CATALOG） */
  {
    const planStr = plan;
    const wfc = (context?.waitingForCustomer || "").trim();
    const gl = (context?.customerGoalLocked || "").trim().toLowerCase();
    if (context?.selectedScenario === "ORDER_LOOKUP" || context?.selectedScenario === "AFTER_SALES") {
      skipCatalog = true;
    }
    if (
      planStr === "aftersales_comfort_first" ||
      planStr === "handoff" ||
      planStr === "return_form_first" ||
      planStr === "return_stage_1"
    ) {
      skipCatalog = true;
    }
    if (wfc.endsWith("_form_submit")) {
      skipCatalog = true;
    }
    if (["cancel", "return", "exchange", "order_lookup", "handoff"].includes(gl)) {
      skipCatalog = true;
    }
  }

  const catalogBlocked = orderLookupDiet || skipCatalog;
  console.log("[reply-trace] catalog_skip_decision", {
    contactId: context?.contactId ?? null,
    scenario: context?.selectedScenario ?? null,
    planMode: plan,
    waitingFor: context?.waitingForCustomer ?? null,
    goalLocked: context?.customerGoalLocked ?? null,
    skipCatalog,
    catalogBlocked,
  });

  const returnFormUrl = brandId ? storage.getBrand(brandId)?.return_form_url || undefined : undefined;
  const flowPrinciplesOpts = {
    returnFormUrl,
    shippingHintOverride: context?.logisticsHintOverride,
  };

  const globalBlock = buildGlobalPolicyPrompt();
  const brandBlock = iso && sc ? buildBrandPersonaPromptIsoThin(brandId) : buildBrandPersonaPrompt(brandId);
  const humanHoursBlock = orderLookupDiet || skipHumanHours ? "" : buildHumanHoursPrompt();
  /** iso + ORDER_LOOKUP 仍注入精簡「查單流程」區塊（舊版 order diet 會整段略過 flow） */
  const includeFlowBlock =
    (!orderLookupDiet && !skipFlow) || (iso && sc === "ORDER_LOOKUP");
  const flowBlock = includeFlowBlock
    ? iso && sc
      ? buildScenarioFlowBlock(sc, flowPrinciplesOpts)
      : buildFlowPrinciplesPrompt(flowPrinciplesOpts)
    : "";
  const catalogBlock = orderLookupDiet || skipCatalog ? "" : await buildCatalogPromptWithTimeout(brandId);
  const allowMarketing =
    !orderLookupDiet &&
    !skipKnowledge &&
    (!context?.selectedScenario ||
      context.selectedScenario === "PRODUCT_CONSULT" ||
      context.selectedScenario === "GENERAL");
  const marketingBlock = allowMarketing ? buildMarketingPrompt(brandId, context?.userMessage) : "";
  const waitingFormBlock = buildWaitingFormStatusPrompt(context?.waitingForCustomer ?? null);
  const knowledgeBlock =
    orderLookupDiet || skipKnowledge ? "" : buildKnowledgePrompt(brandId, knowledgeMax, context?.userMessage, context?.planMode);
  const imageBlock = buildImagePrompt(brandId);
  const scenarioBlock =
    (iso && sc ? buildScenarioIsolationBlock(sc) : "") +
    (iso && sc && scenOverride?.prompt_append ? `\n\n--- 品牌情境覆寫 ---\n${scenOverride.prompt_append.trim()}` : "");

  let prompt_profile: string;
  if (useImageFull) {
    prompt_profile = "image_lookup_full";
  } else {
    prompt_profile = orderLookupDiet ? "order_lookup_prompt_diet" : "answer_directly_full";
  }
  if (iso) {
    prompt_profile += "_phase1_iso";
  }

  let formUrlsBlock = "";
  if (brandId) {
    const urls = storage.getBrandFormUrls(brandId);
    const items: string[] = [];
    if (urls.cancel_form_url) items.push(`- 取消訂單表單：${urls.cancel_form_url}`);
    if (urls.return_form_url) items.push(`- 退貨表單：${urls.return_form_url}`);
    if (urls.exchange_form_url) items.push(`- 換貨表單：${urls.exchange_form_url}`);
    if (items.length > 0) {
      formUrlsBlock =
        "\n\n--- 這個品牌的表單連結 ---\n" +
        "當客人明確需要以下動作時，提供對應的表單連結給客人（客人填寫後由專人處理）：\n" +
        items.join("\n") +
        "\n\n提供時請先了解客人的原因和情況，再自然提供對應的表單。不要一看到關鍵字就丟連結。";
    }
  }

  const scenarioFlowContext = scenarioBlock + flowBlock + humanHoursBlock;
  const raw =
    globalBlock +
    brandBlock +
    formUrlsBlock +
    scenarioFlowContext +
    catalogBlock +
    marketingBlock +
    waitingFormBlock +
    knowledgeBlock +
    imageBlock;
  const full_prompt = normalizeSections(raw);
  const includes: EnrichedPromptResult["includes"] = {
    global_policy: !!globalBlock.trim(),
    brand_persona: !!brandBlock.trim(),
    human_hours: !!humanHoursBlock.trim(),
    flow_principles: !!flowBlock.trim(),
    catalog: full_prompt.includes("--- CATALOG ---"),
    marketing: full_prompt.includes("--- 產品導購規則 ---"),
    knowledge: full_prompt.includes("--- KNOWLEDGE ---"),
    image: full_prompt.includes("--- IMAGE ---"),
  };

  const sectionRe = /---\s*([^\n-]+?)\s*---/g;
  const matches: { key: string; title: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(full_prompt)) !== null) {
    const title = m[1].trim();
    const key = title.toUpperCase().replace(/\s+/g, "_");
    matches.push({ key, title, index: m.index });
  }
  const sections = matches.map((curr, i) => ({
    key: curr.key,
    title: curr.title,
    length: (i + 1 < matches.length ? matches[i + 1].index : full_prompt.length) - curr.index,
  }));

  return {
    full_prompt,
    prompt_profile,
    prompt_chars: full_prompt.length,
    sections,
    includes,
  };
}
