---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包（含 106.1–106.17 與 debug endpoint）
檔案用途: 【檔案 5c】核心服務：prompt-builder、messaging、contact-classification、business-hours
---

## server/services/prompt-builder.ts

```typescript
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
  /** Phase 106.7：客人已在人工排隊（needs_human 或 awaiting_human／high_risk） */
  inHumanHandoffQueue?: boolean;
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

/** Phase 106.11：人工排隊中智能分流（查詢類可同輪 release + 接工具） */
export function buildHumanHandoffQueueStatusPrompt(): string {
  return `
【目前狀態：客人在人工排隊中】

這位客人目前已經在排隊等候真人客服。你要根據客人的需求類型做不同處理：

────────────────────────────────────
【類型 A：單純查詢類 → 主動呼叫 release_handoff_to_ai，然後直接幫客人處理】
────────────────────────────────────

涵蓋情境：
- 查詢訂單狀態、查物流、查訂單明細
- 查商品資訊、查價格、查運費
- 查營業時間、查門市位置
- 任何純資訊查詢的需求

做法：直接呼叫 release_handoff_to_ai，reason 欄位寫客人想做什麼。
**不要先用文字回覆說「我幫您查」**，要查就直接呼叫工具，工具呼叫成功後系統會讓你接著處理客人的需求。

────────────────────────────────────
【類型 B：情緒/業務複雜類 → 純安撫，保留排隊狀態】
────────────────────────────────────

涵蓋情境：
- 投訴、抱怨、不滿（「你們很爛」「為什麼這麼久」）
- 議價、討價還價（「能不能便宜點」「有折扣嗎」）
- 退貨、退款、換貨（這些有專門表單流程，要真人協助）
- 修改訂單內容、修改地址、修改數量
- 情緒激動、催促（「人呢」「等很久了」）
- 複雜的個人化問題

做法：簡短溫暖的安撫，告訴客人專員會盡快接手。
**不要呼叫 release_handoff_to_ai，保留排隊狀態。**

────────────────────────────────────
【類型 C：客人明確表達意願】
────────────────────────────────────

- 客人說「我不等了」「改用 AI 就好」「直接 AI 處理就行」
  → 呼叫 release_handoff_to_ai

- 客人說「我要等真人」「不要 AI」「找專員」
  → 純安撫，保留排隊

────────────────────────────────────
【判斷不清楚時】
────────────────────────────────────
傾向純安撫（類型 B）。客人選擇排隊一定有原因，AI 不要硬搶業務。

────────────────────────────────────
【純安撫模式的回覆原則】
────────────────────────────────────
- 簡短溫暖（3-5 句以內）
- 告知客人會記錄、專員盡快處理
- 如果客人情緒急，多一點安撫詞句
- **絕對不要說「給我訂單號我幫你查」這類話** —— 這會跟「正在排隊」自相矛盾，讓客人困惑

────────────────────────────────────
【正確範例】
────────────────────────────────────

範例 1（純查詢類）
客人：「幫我查 ESC12345」
你：[呼叫 release_handoff_to_ai({reason: "客人想查訂單 ESC12345"})]
   工具回應後系統自動進入正常處理流程，你會在下一輪對話中查單回覆

範例 2（純查詢類，給手機）
客人：「我要查訂單 0930196829」  
你：[呼叫 release_handoff_to_ai({reason: "客人想用手機 0930196829 查訂單"})]

範例 3（情緒類）
客人：「我等很久了！」
你：「真的非常不好意思讓您久等～目前還在排隊中，專員會盡快來協助您唷～」

範例 4（議價類）
客人：「可以再便宜一點嗎」
你：「優惠與價格會由專員為您說明，請再稍等一下唷～」

範例 5（客人改主意）
客人：「算了我不等了 用 AI 處理就好」
你：[呼叫 release_handoff_to_ai({reason: "客人改變心意不需要真人"})]

────────────────────────────────────
【絕對禁止】
────────────────────────────────────
❌ 不要說「給我訂單編號我先幫您查看看」「方便給我手機號嗎」這類話
   要查就直接呼叫 release_handoff_to_ai 工具，不要用文字要求客人重給資訊

❌ 不要繞圈子問客人已經給過的資訊（例如客人已經給了訂單號還問「請問訂單號是？」）

❌ 不要先講一段話再呼叫工具
   要不就純安撫不呼叫工具，要不就直接呼叫工具

❌ 純安撫時不要提到「查單」「處理」「幫您看看」這類業務動作詞
`.trim();
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
  const humanHandoffQueueBlock = context?.inHumanHandoffQueue ? buildHumanHandoffQueueStatusPrompt() : "";
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
    humanHandoffQueueBlock +
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

```
## server/services/messaging.service.ts

```typescript
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import crypto from "crypto";
import { storage } from "../storage";
import { uploadDir } from "../middlewares/upload.middleware";

/** Phase 106.2：集中擋空訊息；呼叫端可判斷 skipped（不 throw） */
export type MessagingOutboundSkipped = { skipped: true; reason: "empty_text" | "empty_messages" };

function sliceCallerStack(): string {
  return new Error().stack?.split("\n").slice(2, 8).join("\n") || "unknown";
}

function recordEmptyOutboundAlert(alert_type: string, payload: Record<string, unknown>): void {
  try {
    storage.createSystemAlert({
      alert_type,
      details: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
    });
  } catch {
    /* alert 失敗不影響主流程 */
  }
}

/**
 * LINE push/reply：擋下會觸發 API 400 的狀況（messages 為空、或任一 type=text 的 text 為空／僅空白）。
 * 非 text 類型（flex、image 等）不檢查。
 */
function lineMessagesBlockedReason(messages: object[] | null | undefined): "empty_messages" | "empty_text" | null {
  if (!messages || messages.length === 0) return "empty_messages";
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown>;
    if (m && m.type === "text") {
      const t = m.text;
      if (typeof t !== "string" || !t.trim()) return "empty_text";
    }
  }
  return null;
}

export function buildRatingFlexMessage(contactId: number, ratingType: "human" | "ai" = "human"): object {
  const actionPrefix = ratingType === "ai" ? "rate_ai" : "rate";
  const starButtons = [1, 2, 3, 4, 5].map((score) => ({
    type: "button",
    action: {
      type: "postback",
      label: `${score} 分`,
      data: `action=${actionPrefix}&ticket_id=${contactId}&score=${score}`,
      displayText: `已送出 ${score} 分，謝謝您！`,
    },
    style: "link",
    height: "md",
    flex: 1,
  }));

  const headerText = ratingType === "ai" ? "請為本次 AI 客服評分" : "請為本次真人客服評分";
  const bodyText =
    ratingType === "ai"
      ? "您的回饋能幫助我們把 AI 回覆調整得更好，謝謝您撥冗。"
      : "您的回饋能幫助我們改善真人客服品質，謝謝您撥冗。";
  const headerColor = ratingType === "ai" ? "#6366F1" : "#1DB446";
  const bgColor = ratingType === "ai" ? "#F5F3FF" : "#F7FFF7";

  return {
    type: "flex",
    altText:
      ratingType === "ai"
        ? "請為本次 AI 客服評分，點選 1～5 分"
        : "請為本次真人客服評分，點選 1～5 分",
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: headerText, weight: "bold", size: "lg", color: headerColor, align: "center" },
          { type: "text", text: "約十秒即可完成", size: "xs", color: "#888888", align: "center", margin: "4px" },
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
          { type: "text", text: "1 分代表最不滿意，5 分代表最滿意", size: "xs", color: "#666666", align: "center", margin: "sm" },
          { type: "text", text: "請點選下方 1～5 分按鈕完成評分", size: "xs", color: "#1DB446", align: "center", margin: "4px", weight: "bold" },
          { type: "text", text: "僅作為內部服務改善，不會公開顯示", size: "xs", color: "#AAAAAA", align: "center", margin: "4px" },
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

export function getLineTokenForContact(contact: { channel_id?: number | null; brand_id?: number | null }): string | null {
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

export function getFbTokenForContact(contact: { channel_id?: number | null; brand_id?: number | null }): string | null {
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

export async function replyToLine(
  replyToken: string,
  messages: object[],
  token?: string | null
): Promise<void | MessagingOutboundSkipped> {
  const resolvedToken = token ?? null;
  if (!resolvedToken || !replyToken) {
    console.error("[LINE] replyToLine ???Token ? replyToken ??");
    return;
  }
  const blockReason = lineMessagesBlockedReason(messages);
  if (blockReason) {
    const stack = sliceCallerStack();
    console.warn("[LINE reply] BLOCKED empty or invalid messages", {
      replyTokenPrefix: replyToken.slice(0, 8),
      reason: blockReason,
      messageCount: messages?.length ?? 0,
      callerStack: stack,
    });
    recordEmptyOutboundAlert("line_reply_empty_blocked", {
      api: "reply",
      reason: blockReason,
      callerStack: stack,
    });
    return { skipped: true, reason: blockReason === "empty_messages" ? "empty_messages" : "empty_text" };
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
  } catch (err: unknown) {
    const e = err as { message?: string; cause?: unknown };
    console.error("[LINE] replyToLine ?? ? error.message:", e?.message, "error.cause:", e?.cause);
  }
}

export async function pushLineMessage(
  userId: string,
  messages: object[],
  token?: string | null
): Promise<void | MessagingOutboundSkipped> {
  const resolvedToken = token ?? null;
  if (!resolvedToken) {
    console.error("[LINE] pushLineMessage ???Token ??");
    return;
  }
  const blockReason = lineMessagesBlockedReason(messages);
  if (blockReason) {
    const stack = sliceCallerStack();
    console.warn("[LINE push] BLOCKED empty message", {
      to: userId,
      reason: blockReason,
      messageCount: messages?.length ?? 0,
      callerStack: stack,
    });
    recordEmptyOutboundAlert("line_push_empty_blocked", {
      to: userId,
      reason: blockReason,
      callerStack: stack,
    });
    return { skipped: true, reason: blockReason === "empty_messages" ? "empty_messages" : "empty_text" };
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
  } catch (err: unknown) {
    const e = err as { message?: string; cause?: unknown };
    console.error("[LINE] pushLineMessage ?? ? error.message:", e?.message, "error.cause:", e?.cause);
  }
}

export async function sendFBMessage(
  pageAccessToken: string,
  recipientId: string,
  text: string
): Promise<void | MessagingOutboundSkipped> {
  if (text == null || typeof text !== "string" || !text.trim()) {
    const stack = sliceCallerStack();
    console.warn("[FB send] BLOCKED empty message", {
      recipientId,
      textLength: text?.length ?? 0,
      textType: typeof text,
      callerStack: stack,
    });
    recordEmptyOutboundAlert("fb_message_empty_blocked", {
      recipientId,
      callerStack: stack,
    });
    return { skipped: true, reason: "empty_text" };
  }
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

export async function sendRatingFlexMessage(
  contact: { id: number; platform_user_id: string; channel_id?: number | null },
  ratingType: "human" | "ai" = "human"
): Promise<void> {
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

export async function downloadLineContent(
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
      const filename = `line-${Date.now()}-${crypto.randomUUID()}${ext}`;
      const filePath = path.join(uploadDir, filename);
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
        console.log("[downloadLineContent] ???????:", uploadDir);
      }
      try {
        const body = resp.body;
        if (!body) {
          console.error("[downloadLineContent] No response body stream");
          return null;
        }
        const nodeIn = Readable.fromWeb(body as import("stream/web").ReadableStream);
        await pipeline(nodeIn, fs.createWriteStream(filePath));
      } catch (writeErr: any) {
        console.error("[downloadLineContent] ?????? ? path:", filePath, "error.message:", writeErr?.message, "error.code:", writeErr?.code, "channelId:", channelIdForLog ?? "unknown");
        if (writeErr?.stack) console.error("[downloadLineContent] writeFileSync stack:", writeErr.stack);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_u) {
          /* ignore */
        }
        return null;
      }
      let writtenSize = 0;
      try {
        writtenSize = fs.statSync(filePath).size;
      } catch (_s) {
        /* ignore */
      }
      console.log(`[downloadLineContent] Success: ${filename} (${writtenSize} bytes, attempt ${attempt})`);
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

export async function downloadExternalImage(imageUrl: string): Promise<string | null> {
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
    const filename = `fb-${Date.now()}-${crypto.randomUUID()}${ext}`;
    const filePath = path.join(uploadDir, filename);
    const body = resp.body;
    if (!body) {
      console.error("[downloadExternalImage] No response body stream");
      return null;
    }
    const nodeIn = Readable.fromWeb(body as import("stream/web").ReadableStream);
    await pipeline(nodeIn, fs.createWriteStream(filePath));
    let writtenSize = 0;
    try {
      writtenSize = fs.statSync(filePath).size;
    } catch (_s) {
      /* ignore */
    }
    console.log(`[downloadExternalImage] Success: ${filename} (${writtenSize} bytes)`);
    return `/uploads/${filename}`;
  } catch (err: any) {
    console.error("[downloadExternalImage] Error:", err.name === "AbortError" ? "Request timed out (15s)" : err.message);
    return null;
  }
}

```
## server/services/contact-classification.ts

```typescript
// === 對話分類常數 ===
// 未來想調整門檻，改這裡就好

/**
 * 「逾時」門檻：客戶最後發言超過此時間視為逾時
 * 影響：列表 is_overdue（API）、主管/客服面板的「逾時」COUNT
 */
export const OVERDUE_THRESHOLD_MS = 60 * 60 * 1000; // 1 小時

/**
 * 「VIP 逾時加緊急」門檻：VIP 客戶最後發言超過此時間視為緊急
 * 影響：列表 is_urgent（API）、主管/客服面板的「緊急」COUNT
 */
export const URGENT_VIP_OVERDUE_MS = 60 * 60 * 1000; // 1 小時

/**
 * 「高優先級」門檻：case_priority ≤ 此值視為緊急
 * 影響：所有「緊急」判斷
 */
export const URGENT_PRIORITY_THRESHOLD = 2;

/**
 * 緊急標籤關鍵字 regex
 * 影響：列表 is_urgent（API）、主管/客服面板的「緊急」COUNT
 */
export const URGENT_TAG_PATTERN = /緊急|投訴|客訴|急/;

export interface UrgencyEvaluationContext {
  contact: {
    id?: number;
    status?: string | null;
    case_priority?: number | null;
    vip_level?: number | null;
    tags?: string | string[] | null;
    last_message_sender_type?: string | null;
    last_message_at?: string | null;
    response_sla_deadline_at?: string | null;
  };
  now: Date;
}

export interface UrgencyResult {
  isUrgent: boolean;
  reasons: string[];
}

export interface OverdueEvaluationContext {
  contact: {
    last_message_sender_type?: string | null;
    last_message_at?: string | null;
    needs_human?: number | null;
    status?: string | null;
  };
  now: Date;
}

function parseDbDateTimeMs(s: string | null | undefined): number | null {
  if (s == null || String(s).trim() === "") return null;
  const ms = new Date(String(s).replace(" ", "T")).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function parseContactTags(tags: string | string[] | null | undefined): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((t) => String(t));
  try {
    const parsed = JSON.parse(tags || "[]");
    return Array.isArray(parsed) ? parsed.map((t: unknown) => String(t)) : [];
  } catch {
    return [];
  }
}

export function evaluateContactUrgency(ctx: UrgencyEvaluationContext): UrgencyResult {
  const { contact, now } = ctx;
  const reasons: string[] = [];
  const st = contact.status != null ? String(contact.status) : "";

  if (st === "closed" || st === "resolved") {
    return { isUrgent: false, reasons: [] };
  }

  if (st === "high_risk") {
    reasons.push("high_risk_status");
  }

  const priority = contact.case_priority ?? 999;
  if (priority <= URGENT_PRIORITY_THRESHOLD) {
    reasons.push(`high_priority_${priority}`);
  }

  const tagsArray = parseContactTags(contact.tags);
  const hasUrgentTag = tagsArray.some((t) => URGENT_TAG_PATTERN.test(t));
  if (hasUrgentTag) {
    reasons.push("urgent_tag");
  }

  const isVip = (contact.vip_level ?? 0) > 0;
  const lastSenderIsUser = String(contact.last_message_sender_type || "").toLowerCase() === "user";
  const lastMessageMs = parseDbDateTimeMs(contact.last_message_at ?? null);
  const isVipOverdue =
    isVip && lastSenderIsUser && lastMessageMs != null && now.getTime() - lastMessageMs > URGENT_VIP_OVERDUE_MS;
  if (isVipOverdue) {
    reasons.push("vip_overdue_1h");
  }

  if (contact.response_sla_deadline_at) {
    const slaMs = parseDbDateTimeMs(contact.response_sla_deadline_at);
    if (slaMs != null && slaMs < now.getTime()) {
      reasons.push("sla_breach");
    }
  }

  return {
    isUrgent: reasons.length > 0,
    reasons,
  };
}

export function evaluateContactOverdue(ctx: OverdueEvaluationContext): boolean {
  const { contact, now } = ctx;
  const st = contact.status != null ? String(contact.status) : "";
  if (st === "resolved" || st === "closed") {
    return false;
  }
  if (String(contact.last_message_sender_type || "").toLowerCase() !== "user") {
    return false;
  }
  if (!contact.last_message_at) return false;
  const lastMs = parseDbDateTimeMs(contact.last_message_at);
  if (lastMs == null) return false;
  return now.getTime() - lastMs > OVERDUE_THRESHOLD_MS;
}

```
## server/services/business-hours.ts

```typescript
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// === 營業時間設定 ===
export const BUSINESS_HOURS = {
  workDays: process.env.BUSINESS_WORK_DAYS
    ? process.env.BUSINESS_WORK_DAYS.split(",").map((s) => parseInt(s.trim(), 10))
    : [1, 2, 3, 4, 5], // 0=Sunday, 1=Monday, ..., 6=Saturday
  startHour: parseInt(process.env.BUSINESS_START_HOUR ?? "9", 10),
  endHour: parseInt(process.env.BUSINESS_END_HOUR ?? "18", 10),
  timezone: process.env.BUSINESS_TIMEZONE ?? "Asia/Taipei",
};

// === 國定假日載入 ===
interface HolidayEntry {
  date: string;
  name: string;
}

interface HolidayFile {
  year: number;
  holidays: HolidayEntry[];
}

const HOLIDAY_DATES = new Set<string>();
const HOLIDAY_NAMES = new Map<string, string>();

function resolveHolidaysDir(): string {
  const fromCwd = path.join(process.cwd(), "server", "data", "holidays");
  if (fs.existsSync(fromCwd)) return fromCwd;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(moduleDir, "..", "data", "holidays");
}

function loadHolidays(): void {
  const holidaysDir = resolveHolidaysDir();

  try {
    if (!fs.existsSync(holidaysDir)) {
      console.warn("[business-hours] holidays directory not found:", holidaysDir);
      return;
    }

    const files = fs.readdirSync(holidaysDir).filter((f) => f.endsWith(".json"));
    let totalLoaded = 0;

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(holidaysDir, file), "utf-8");
        const data = JSON.parse(content) as HolidayFile;

        if (!Array.isArray(data.holidays)) {
          console.warn(`[business-hours] ${file} 格式錯誤：holidays 不是陣列`);
          continue;
        }

        for (const h of data.holidays) {
          if (!h.date || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) {
            console.warn(`[business-hours] ${file} 跳過無效日期: ${h.date}`);
            continue;
          }
          HOLIDAY_DATES.add(h.date);
          HOLIDAY_NAMES.set(h.date, h.name ?? "國定假日");
          totalLoaded++;
        }

        console.log(`[business-hours] 載入 ${file}: ${data.holidays.length} 筆`);
      } catch (err) {
        console.error(`[business-hours] 載入 ${file} 失敗:`, err);
      }
    }

    console.log(`[business-hours] 國定假日總計載入 ${totalLoaded} 筆，涵蓋年份檔案 ${files.length} 個`);
  } catch (err) {
    console.error("[business-hours] 載入 holidays 失敗:", err);
  }
}

loadHolidays();

export function isHoliday(dateStr: string): boolean {
  return HOLIDAY_DATES.has(dateStr);
}

export function getHolidayStats(): { totalDates: number; sampleDates: string[] } {
  return {
    totalDates: HOLIDAY_DATES.size,
    sampleDates: Array.from(HOLIDAY_DATES).sort().slice(0, 10),
  };
}

const WEEKDAY_SHORT_TO_NUM: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function getTaipeiComponents(date: Date): {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
  dateStr: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_HOURS.timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";

  let hour = parseInt(get("hour"), 10);
  if (Number.isNaN(hour)) hour = 0;
  if (hour === 24) hour = 0;

  const year = parseInt(get("year"), 10);
  const month = parseInt(get("month"), 10);
  const day = parseInt(get("day"), 10);
  const wk = get("weekday");

  return {
    year,
    month,
    day,
    dayOfWeek: WEEKDAY_SHORT_TO_NUM[wk] ?? 1,
    hour,
    minute: parseInt(get("minute"), 10) || 0,
    dateStr: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/**
 * 將「台北牆上時間」轉成對應的 UTC Date（台北無夏令時間，固定 UTC+8）
 */
export function taipeiWallToUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
}

export function isWithinBusinessHours(date: Date): boolean {
  const taipei = getTaipeiComponents(date);

  if (isHoliday(taipei.dateStr)) return false;
  if (!BUSINESS_HOURS.workDays.includes(taipei.dayOfWeek)) return false;
  if (taipei.hour < BUSINESS_HOURS.startHour || taipei.hour >= BUSINESS_HOURS.endHour) return false;

  return true;
}

export function findNextBusinessMoment(from: Date): Date {
  if (isWithinBusinessHours(from)) {
    return new Date(from.getTime());
  }

  const MAX_HOURS = 30 * 24;
  const { startHour, workDays } = BUSINESS_HOURS;
  let cursor = new Date(from.getTime());

  for (let i = 0; i < MAX_HOURS; i++) {
    cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
    const taipei = getTaipeiComponents(cursor);

    const isWorkDay = workDays.includes(taipei.dayOfWeek);
    const isNotHoliday = !isHoliday(taipei.dateStr);
    const isStartHour = taipei.hour === startHour;

    if (isWorkDay && isNotHoliday && isStartHour) {
      return taipeiWallToUtcDate(taipei.year, taipei.month, taipei.day, startHour, 0, 0);
    }
  }

  console.warn("[business-hours] findNextBusinessMoment 超過 30 天還沒找到");
  return new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
}

```
