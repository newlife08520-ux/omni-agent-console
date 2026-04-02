/**
 * Prompt 架構分層：人格 vs 流程。
 * - 全域：安全與誠實原則、輸出語言/簡潔度
 * - 品牌：語氣、稱呼、emoji、禁語
 * - 流程：查單條件、轉人工高層原則、非服務時段（由總 builder 組裝，並做 runtime 去重）
 */
import { storage } from "../storage";
import * as assignment from "../assignment";
import { getSuperLandingConfig, ensurePagesCacheLoaded, buildProductCatalogPrompt } from "../superlanding";
import type { AgentScenario, ScenarioOverrideEntry } from "./phase1-types";
const IMAGE_PRECISION_COT_BLOCK = `

--- 圖片辨識與回覆規範 ---
你具備圖片辨識能力。當客戶傳圖時，請先判斷是否與商品、訂單、出貨、物流或客服相關。
若與商品或訂單相關，可結合內部商品清單與圖片內容回覆。
嚴禁根據圖片臆測客戶隱私或與客服無關的內容。

回覆時請簡潔、溫暖。若圖片無法辨識或與客服無關，可禮貌請客戶用文字補充。
若辨識到明確商品或訂單資訊，可對照 name/description / keywords 與內部清單後回覆。

若客戶傳圖是為了指定某款商品（例如「我要這個」），請對照清單找出最符合的選項，必要時列出 A/B 讓客戶確認，再以 send_image_to_customer 時請用 name；若無對應則勿亂用 name。
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

/** 服務時段與非服務時段提示；非服務時段傾向轉人工由程式處理，此處僅提示 */
export function buildHumanHoursPrompt(): string {
  const schedule = storage.getGlobalSchedule();
  const unavailableReason = assignment.getUnavailableReason();
  const block = `

--- 服務時段說明（僅供參考）---
客服時段為 ${schedule.work_start_time}～${schedule.work_end_time}，午休 ${schedule.lunch_start_time}～${schedule.lunch_end_time}。${schedule.work_end_time} 後為非服務時段。
若客戶要求轉接專人，請使用 transfer_to_human 工具；程式會依實際排班決定是否即時分配。`;
  const nowHint =
    unavailableReason === "weekend"
      ? "\n目前為週末或非服務日，轉接後將由專人於上班時間處理。"
      : unavailableReason === "lunch"
        ? `\n目前為午休時段（${schedule.lunch_start_time}～${schedule.lunch_end_time}），轉接後將盡快處理。`
        : unavailableReason === "after_hours"
          ? `\n目前為非服務時段（${schedule.work_end_time} 後），轉接後將於上班時間處理。`
          : "";
  return block + nowHint;
}

/** 情境隔離時附加的簡短行為邊界（不取代全域安全規則） */
export function buildScenarioIsolationBlock(scenario: AgentScenario): string {
  const blocks: Record<AgentScenario, string> = {
    ORDER_LOOKUP: `

--- 情境：訂單／物流 ---
聚焦查單、物流與出貨進度；勿主動展開與當前查單無關的完整型錄或促銷。`,
    AFTER_SALES: `

--- 情境：售後／退換貨 ---
優先同理與釐清；退換貨以品牌政策與表單為準，需專人判斷時使用 transfer_to_human。`,
    PRODUCT_CONSULT: `

--- 情境：商品諮詢 ---
以規格、使用方式、優惠及知識庫為主；除非客戶同時提供明確訂單編號且意在查物流，否則勿主動查單。`,
    GENERAL: `

--- 情境：一般 ---
簡潔有禮；不確定時可簡問需求或適度引導轉人工。`,
  };
  return blocks[scenario] || "";
}

/** 共用物流一句（情境流程區塊內可重用） */
function resolveShippingHintLine(options: {
  productScope?: string | null;
  shippingHintOverride?: string;
}): string {
  if (options.shippingHintOverride?.trim()) return options.shippingHintOverride.trim();
  if (options.productScope === "sweet") {
    return "甜點/食品類：宅配約 3 工作天、超商約 3 工作天；7-ELEVEN 約 7～20 日到店。";
  }
  if (options.productScope && options.productScope !== "sweet") {
    return "非甜點類：以 7-ELEVEN 到店約 7～20 日為準；宅配約 3 工作天。";
  }
  return "物流時效依通路不同，宅配約 7～20 日或 3 工作天；超商到店依門市。";
}

/**
 * Phase 1.5：情境專屬流程區塊（取代 iso 模式下混合式 buildFlowPrinciplesPrompt，避免跨情境污染）。
 */
export function buildScenarioFlowBlock(
  scenario: AgentScenario,
  opts: { returnFormUrl?: string; productScope?: string | null; shippingHintOverride?: string }
): string {
  const returnFormUrl = opts.returnFormUrl || "https://www.lovethelife.shop/returns";
  const ship = resolveShippingHintLine(opts);
  switch (scenario) {
    case "ORDER_LOOKUP":
      return `

--- 流程（訂單／物流）---
${ship}
有單號或已同意提供之身分線索時，使用查單相關工具；查無、例外或客戶堅持專人時可 transfer_to_human。本輪勿主動展開完整退換貨表單流程，除非客戶已明確提出售後需求。`;
    case "AFTER_SALES":
      return `

--- 流程（售後／退換）---
以同理與釐清為先；可提供退換貨表單連結 ${returnFormUrl}。需政策例外、僵持或高風險時使用 transfer_to_human。勿主動引導「全系統訂單查詢步驟」；僅在客戶要查物流且已提供單號時再協助查詢。`;
    case "PRODUCT_CONSULT":
      return `

--- 流程（商品諮詢）---
回答規格、用途、優惠與常見問題；不要主動索取訂單編號或進入查單流程，除非客戶同句已提供單號且明確要查物流。`;
    case "GENERAL":
    default:
      return `

--- 流程（一般）---
簡潔有禮；超出權限或客戶要求專人時使用 transfer_to_human。不要主動進入查單或退貨程序。`;
  }
}

/** 品牌 DB 全文易含跨情境規則；iso 模式下截斷為摘要，降低污染（flags 關閉仍用完整 buildBrandPersonaPrompt） */
export function buildBrandPersonaPromptIsoThin(brandId?: number): string {
  if (!brandId) return "";
  const brand = storage.getBrand(brandId);
  const raw = (brand?.system_prompt || "").trim();
  if (!raw) return "";
  const cap = 1400;
  const body = raw.length > cap ? `${raw.slice(0, cap)}\n[以下品牌細節已截斷；請優先遵守本輪「情境」流程區塊]` : raw;
  return "\n\n--- 品牌語氣與規範（摘要）---\n" + body;
}

/** 流程相關：高層轉人工原則（不重複承載 deterministic SOP，細節在程式）＋退換貨表單等簡短說明 */
export function buildFlowPrinciplesPrompt(options: {
  returnFormUrl?: string;
  productScope?: string | null;
  /** 品牌／設定覆寫物流說明，避免甜點／非甜點硬編碼 */
  shippingHintOverride?: string;
}): string {
  const returnFormUrl = options.returnFormUrl || "https://www.lovethelife.shop/returns";
  const shippingHint = resolveShippingHintLine(options);
  return `

--- 流程與轉接原則（高層）---
${shippingHint}
退換貨：可提供表單連結 ${returnFormUrl}；若客戶堅持退換貨，請安撫後提供表單並呼叫 transfer_to_human（reason 簡述原因）。
訂單查詢：有單號直接查；無單號可詢問商品名與手機。查無結果或客戶明確要求專人時，可呼叫 transfer_to_human。
回覆語氣：溫暖親切、簡潔，禁止系統用語與內部代碼。訂單查詢失敗（found=false）時可考慮轉接專人。`;
}

/** 商品清單（catalog），穩定 section key 為 --- CATALOG --- */
export async function buildCatalogPrompt(brandId?: number): Promise<string> {
  const config = getSuperLandingConfig(brandId);
  const pages = await ensurePagesCacheLoaded(config);
  const body = buildProductCatalogPrompt(pages);
  if (!body.trim()) return "";
  return "\n\n--- CATALOG ---\n" + body.trim();
}

/** 知識庫 */
export function buildKnowledgePrompt(brandId?: number, maxTotalChars = 80000): string {
  const files = storage.getKnowledgeFiles(brandId);
  const withContent = files.filter((f) => f.content && f.content.trim().length > 0);
  if (withContent.length === 0) return "";
  let totalChars = 0;
  const blocks: string[] = [];
  for (const f of withContent) {
    const content = f.content!;
    if (totalChars + content.length > maxTotalChars) {
      const remaining = maxTotalChars - totalChars;
      if (remaining > 500) {
        blocks.push(`[知識: ${f.original_name}]\n${content.substring(0, remaining)}\n[內容已截斷]`);
      }
      break;
    }
    blocks.push(`[知識: ${f.original_name}]\n${content}`);
    totalChars += content.length;
  }
  return "\n\n--- KNOWLEDGE ---\n" + blocks.join("\n\n");
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
  productScope?: string | null;
  planMode?: string;
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
 * 總組裝：依序拼接各區塊，最後做一次 section 去重（normalizeSections）。
 * 回傳 full_prompt 與 metadata（sections、includes）供 preview 與除錯使用。
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
  let knowledgeMax = 80000;

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
        knowledgeMax = 24000;
        break;
    }
    if (scenOverride?.knowledge_mode === "none") {
      skipKnowledge = true;
    } else if (scenOverride?.knowledge_mode === "minimal") {
      skipKnowledge = false;
      knowledgeMax = 12000;
    } else if (scenOverride?.knowledge_mode === "full") {
      skipKnowledge = false;
      knowledgeMax = 80000;
    }
  }

  const returnFormUrl = brandId ? storage.getBrand(brandId)?.return_form_url || undefined : undefined;
  const flowPrinciplesOpts = {
    returnFormUrl,
    productScope: context?.productScope,
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
  const catalogBlock = orderLookupDiet || skipCatalog ? "" : await buildCatalogPrompt(brandId);
  const knowledgeBlock = orderLookupDiet || skipKnowledge ? "" : buildKnowledgePrompt(brandId, knowledgeMax);
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

  const raw =
    globalBlock +
    brandBlock +
    humanHoursBlock +
    flowBlock +
    catalogBlock +
    knowledgeBlock +
    imageBlock +
    scenarioBlock;
  const full_prompt = normalizeSections(raw);
  const includes: EnrichedPromptResult["includes"] = {
    global_policy: !!globalBlock.trim(),
    brand_persona: !!brandBlock.trim(),
    human_hours: !!humanHoursBlock.trim(),
    flow_principles: !!flowBlock.trim(),
    catalog: full_prompt.includes("--- CATALOG ---"),
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
