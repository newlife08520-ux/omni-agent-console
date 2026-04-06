/**
 * Minimal Safe Mode：在 Tool JSON 送進 LLM 前做物理清洗（刪 raw、內部英文運送碼、local_only 狀態覆寫）。
 * Phase 95：姓名／電話隱碼，避免錯單號時 LLM 看見他人完整個資。
 */

/** Phase 95：中文／一般姓名隱碼（2 字首+尾規則；純英文前 2 字母 + ***）。 */
export function maskName(name: string): string {
  const s = String(name ?? "").trim();
  if (!s) return "";
  const lettersOnly = s.replace(/\s+/g, "");
  if (/^[a-zA-Z]+$/.test(lettersOnly)) {
    if (lettersOnly.length <= 1) return `${lettersOnly}***`;
    return `${lettersOnly.slice(0, 2)}***`;
  }
  const chars = Array.from(s);
  const n = chars.length;
  if (n <= 1) return "*";
  if (n === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(n - 2)}${chars[n - 1]}`;
}

/** Phase 95：電話隱碼：保留前 4、後 3，中間 ***（數字化後計算）。 */
export function maskPhone(phone: string): string {
  const raw = String(phone ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `${digits.slice(0, 4)}***${digits.slice(-3)}`;
}

const PII_NAME_KEYS = ["buyer_name", "receiver_name"] as const;
const PII_PHONE_KEYS = ["buyer_phone", "receiver_phone"] as const;

function maskPiiFieldsOnOrderLike(o: Record<string, unknown>): void {
  for (const k of PII_NAME_KEYS) {
    if (o[k] != null && typeof o[k] === "string") o[k] = maskName(o[k] as string);
  }
  for (const k of PII_PHONE_KEYS) {
    if (o[k] != null && typeof o[k] === "string") o[k] = maskPhone(o[k] as string);
  }
}

/** 對客友善：避免 LLM 唸出「同步中」等工程感狀態 */
function humanizeStatusFields(o: Record<string, unknown>): void {
  const payStatus = String(o.payment_status_label || o.payment_status || "").trim();
  if (/同步中|確認中|processing|syncing/i.test(payStatus)) {
    o.payment_status_label = "確認中（請稍候）";
  }
  const orderStatus = String(o.status || "").trim();
  if (/同步中|syncing|processing/i.test(orderStatus)) {
    o.status = "處理中";
  } else if (/\[本地快取.*\]/i.test(orderStatus)) {
    o.status = "確認中";
  }
}

/** Phase 96：營運小抄—請融進自己的話，不要條列照唸（降低工程腔） */
export const SHIPPING_SOP_INSTRUCTION =
  "（出貨／久候小抄—請融進一段話，勿列點唸稿）先致歉；現貨約五工作天內寄出、預購約七到二十工作天；別保證幾號一定到；可說會幫問倉儲／物流並在需要時幫催或加急。";

export function shouldInjectShippingSopForToolContext(
  userMessage?: string,
  recentUserMessages?: string[]
): boolean {
  const shippingKeywords =
    /出貨|寄出|物流|配送|到貨|久等|多久|何時出|什麼時候.*寄|還沒收到|還沒到|等很久|怎麼還沒|貨態|包裹|寄了嗎|出了嗎|發貨/;

  if (userMessage && shippingKeywords.test(userMessage)) return true;

  if (recentUserMessages?.length) {
    const last = recentUserMessages[recentUserMessages.length - 1];
    if (last && shippingKeywords.test(last)) return true;
  }

  return false;
}

const LOOKUP_TOOL_NAMES = new Set([
  "lookup_order_by_id",
  "lookup_order_by_product_and_phone",
  "lookup_order_by_date_and_contact",
  "lookup_more_orders",
  "lookup_more_orders_shopline",
  "lookup_order_by_phone",
]);

const LOCAL_ONLY_STATUS = "[本地快取：連線確認中]";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 將配送相關欄位轉成人類可讀，保留欄位不刪除 */
function humanizeShippingFields(o: Record<string, unknown>): void {
  const sm = String(o.shipping_method ?? "").trim();
  const dtt = String(o.delivery_target_type ?? "").trim();
  const joint = `${sm} ${dtt}`.toLowerCase();

  let human: string | undefined;
  if (/to_store|cvs|seven|family|hilife|超商|門市|取貨|pickup/.test(joint)) {
    human = "超商取貨";
  } else if (/home|宅配|到府|address|delivery/.test(joint)) {
    human = "宅配到府";
  }

  const storeName = String(o.cvs_store_name ?? "").trim();
  if (human && storeName) {
    human = `${human}（${storeName}）`;
  }

  if (human) {
    o.shipping_display = human;
  } else if (sm && !/^[a-z0-9_\-]+$/i.test(sm)) {
    o.shipping_display = sm;
  } else {
    o.shipping_display = "一般配送";
  }

  if (/to_store/i.test(sm)) {
    o.shipping_method = "超商取貨";
  }
  if (/home|delivery/i.test(dtt)) {
    o.delivery_target_type = "宅配";
  } else if (/cvs|store/i.test(dtt)) {
    o.delivery_target_type = "超商";
  }

  const statusText = String(o.status ?? "");
  if (/預購|pre[-_]?order/i.test(`${joint} ${statusText}`)) {
    o.fulfillment_timing_hint = "預購";
  } else {
    o.fulfillment_timing_hint = "現貨";
  }
}

function stripRawAndGateway(o: Record<string, unknown>): void {
  for (const k of Object.keys(o)) {
    if (k.endsWith("_raw") || k === "gateway_status") {
      delete o[k];
    }
  }
}

function sanitizeOrderLike(o: Record<string, unknown>, opts: { localOnly?: boolean }): void {
  stripRawAndGateway(o);
  humanizeShippingFields(o);
  maskPiiFieldsOnOrderLike(o);
  if (opts.localOnly) {
    o.status = LOCAL_ONLY_STATUS;
    const prev = o.sys_note != null ? String(o.sys_note) : "";
    o.sys_note = [
      prev,
      "（語氣小抄）資料還在和主機同步，請說得鬆一點請客人稍等，別講死成已經定案。",
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  const items = o.items;
  if (Array.isArray(items)) {
    for (const it of items) {
      if (isPlainObject(it)) {
        stripRawAndGateway(it);
      }
    }
  }
  humanizeStatusFields(o);
}

function walkPayload(root: Record<string, unknown>, dataCoverage?: string): void {
  const localRoot = dataCoverage === "local_only" || root.data_coverage === "local_only";

  const orders = root.orders;
  if (Array.isArray(orders)) {
    for (const row of orders) {
      if (isPlainObject(row)) {
        sanitizeOrderLike(row, { localOnly: localRoot });
      }
    }
  }
  const ord = root.order;
  if (isPlainObject(ord)) {
    sanitizeOrderLike(ord, { localOnly: localRoot });
  }

  // 清洗已組好的字串摘要（移除可能殘留的來源；收件人／電話已改隱碼顯示，勿整行刪除）
  const STRING_KEYS_TO_SANITIZE = ["one_page_summary", "one_page_full", "formatted_list", "deterministicReply"];
  for (const key of STRING_KEYS_TO_SANITIZE) {
    const val = root[key];
    if (typeof val === "string" && val.length > 0) {
      root[key] = val
        .replace(/來源：[^\n]*/g, "")
        .replace(/\n{2,}/g, "\n")
        .trim();
    }
  }

  for (const k of Object.keys(root)) {
    if (k.endsWith("_raw") || k === "gateway_status") {
      delete root[k];
    }
  }
}

/**
 * 深層清洗給 LLM 的 Tool JSON（僅處理查單類 tool 的 payload）。
 */
export function sanitizeToolPayloadForLLM(root: Record<string, unknown>): Record<string, unknown> {
  let cloned: Record<string, unknown>;
  try {
    cloned = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  } catch {
    return root;
  }
  const dc = typeof cloned.data_coverage === "string" ? cloned.data_coverage : undefined;
  walkPayload(cloned, dc);
  return cloned;
}

export interface FinalizeLlmToolJsonOptions {
  userMessage?: string;
  recentUserMessages?: string[];
}

/** Phase 96：語氣小抄—避免「照念營運指導」腔（仍保留邊界） */
const WARM_GUIDE_PHONE_SUMMARY_ONLY =
  "（語氣小抄）訂單太多無法全列，像聊天一樣請客人說一下買了什麼商品或大概什麼時候下的單。";

const WARM_GUIDE_SHOPLINE_ID_MISS =
  "（語氣小抄）官網這邊沒查到單：口氣要像真人櫃台，溫和說明並問是否可能在一頁式或別通路下過，別只丟一句查無。";

const WARM_GUIDE_MIXED_SOURCES =
  "（語氣小抄）多筆混在一起：用人話幫他整理每筆大概狀態就好，不要講官網、一頁式等內部來源名詞。";

const WARM_GUIDE_PAYMENT_FAILED =
  "（語氣小抄）付款沒成功（可能是驗證或連線）：婉轉、不責怪；可建議換張卡再試，或重新下一張單，別只冷冰冰說失敗。";

function orderPayloadLooksPaymentFailed(o: Record<string, unknown>): boolean {
  if (o.payment_status === "failed") return true;
  const lab = String(o.payment_status_label ?? "");
  return lab.includes("失敗");
}

function appendSoftPaymentFailureSysNote(p: Record<string, unknown>): void {
  const ord = p.order;
  if (isPlainObject(ord) && orderPayloadLooksPaymentFailed(ord)) {
    const prev = String(p.sys_note ?? "").trim();
    p.sys_note = [prev, WARM_GUIDE_PAYMENT_FAILED].filter(Boolean).join(" ").trim();
    return;
  }
  const orders = p.orders;
  if (!Array.isArray(orders)) return;
  for (const row of orders) {
    if (isPlainObject(row) && orderPayloadLooksPaymentFailed(row)) {
      const prev = String(p.sys_note ?? "").trim();
      p.sys_note = [prev, WARM_GUIDE_PAYMENT_FAILED].filter(Boolean).join(" ").trim();
      return;
    }
  }
}

function applyWarmOpsSysNotes(toolName: string, p: Record<string, unknown>): void {
  if (toolName === "lookup_order_by_phone" && p.summary_only === true) {
    const prevNote = String(p.sys_note ?? "").trim();
    p.sys_note = [prevNote, WARM_GUIDE_PHONE_SUMMARY_ONLY].filter(Boolean).join(" ");
  } else if (
    toolName === "lookup_order_by_id" &&
    p.success === true &&
    p.found === false &&
    p.not_order_number !== true
  ) {
    const prev = String(p.sys_note ?? "").trim();
    p.sys_note = [prev, WARM_GUIDE_SHOPLINE_ID_MISS].filter(Boolean).join(" ");
  } else if (
    (toolName === "lookup_more_orders" || toolName === "lookup_more_orders_shopline") &&
    p.source === "mixed"
  ) {
    const prev = String(p.sys_note ?? "").trim();
    p.sys_note = [prev, WARM_GUIDE_MIXED_SOURCES].filter(Boolean).join(" ");
  }
  appendSoftPaymentFailureSysNote(p);
}

export function finalizeLlmToolJsonString(
  toolName: string,
  jsonStr: string,
  opts?: FinalizeLlmToolJsonOptions
): string {
  if (!LOOKUP_TOOL_NAMES.has(toolName)) return jsonStr;
  try {
    const p = sanitizeToolPayloadForLLM(JSON.parse(jsonStr) as Record<string, unknown>);
    applyWarmOpsSysNotes(toolName, p);
    if (opts && shouldInjectShippingSopForToolContext(opts.userMessage, opts.recentUserMessages)) {
      p.SOP_INSTRUCTION = SHIPPING_SOP_INSTRUCTION;
    }
    return JSON.stringify(p);
  } catch {
    return jsonStr;
  }
}
