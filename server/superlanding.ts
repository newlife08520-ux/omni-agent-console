import type { OrderInfo, DeliveryTargetType } from "@shared/schema";
import { storage } from "./storage";

const SUPERLANDING_API_BASE = "https://api.super-landing.com";

/** 延遲 ms 毫秒，用於分頁請求間隔，避免 Rate Limit */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 讓出 Event Loop 給其他請求（如客服 API），避免 TTFB 飆高、網頁載入被卡住 */
function yieldEventLoop(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 單次 fetch 失敗時重試（如 ECONNRESET），最多 retries 次，每次間隔 3 秒 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err: any) {
      if (attempt < retries) {
        console.warn(`[一頁商店] 請求失敗 (${attempt}/${retries})，3 秒後重試:`, err?.message || err);
        await sleep(3000);
      } else {
        throw err;
      }
    }
  }
  throw new Error("fetchWithRetry exhausted");
}

const ORDER_STATUS_MAP: Record<string, string> = {
  new_order: "新訂單",
  confirming: "確認中",
  confirmed: "已確認",
  awaiting_for_shipment: "待出貨",
  shipping: "出貨中",
  shipped: "已出貨",
  delay_handling: "延遲出貨",
  other: "其他",
  refunding: "退款中",
  refunded: "已退款",
  replacement: "換貨中",
  temp: "臨時",
  returned: "已退貨",
  pending: "待處理",
  canceled: "已取消",
};

export interface SuperLandingConfig {
  merchantNo: string;
  accessKey: string;
}

export function getSuperLandingConfig(brandId?: number): SuperLandingConfig {
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

/** 一頁商店 convenient_store 格式：BRAND_STORECODE_門市名_地址，解析為結構化欄位 */
export function parseConvenienceStore(raw: string | null | undefined): {
  cvs_brand: string;
  cvs_store_code: string;
  cvs_store_name: string;
  full_address: string;
} {
  const empty = { cvs_brand: "", cvs_store_code: "", cvs_store_name: "", full_address: "" };
  if (typeof raw !== "string" || !raw.trim()) return empty;
  const parts = raw.trim().split("_");
  if (parts.length < 4) return empty;
  const brandCode = (parts[0] || "").toUpperCase();
  const cvsBrandMap: Record<string, string> = {
    FAMI: "全家",
    UNIMART: "萊爾富",
    ELEVEN: "7-11",
    "7-11": "7-11",
    OK: "OK",
  };
  return {
    cvs_brand: cvsBrandMap[brandCode] ?? brandCode,
    cvs_store_code: parts[1] ?? "",
    cvs_store_name: parts[2] ?? "",
    full_address: parts.slice(3).join("_").trim() || "",
  };
}

/** 依 shipping_method / convenient_store 判斷宅配或超商 */
export function deriveDeliveryTargetType(
  shippingMethod: string | null | undefined,
  convenientStore: string | null | undefined
): DeliveryTargetType {
  const sm = (shippingMethod || "").toLowerCase();
  if (sm && (sm.includes("home") || sm.includes("宅配") || sm.includes("delivery"))) return "home";
  if (sm && (sm.includes("store") || sm.includes("cvs") || sm.includes("超商") || sm === "to_store")) return "cvs";
  if (typeof convenientStore === "string" && convenientStore.trim().length > 0) return "cvs";
  return "unknown";
}

/**
 * 一頁商店：從真實 payload 組出 payment_status_raw，供 derivePaymentStatus 判斷失敗／pending。
 * 不可再把 payment_method 直接當作 payment_status_raw（會把 credit_card/pending 誤當成「支付狀態」）。
 */
export function deriveSuperlandingPaymentStatusRaw(o: Record<string, unknown>): string | undefined {
  const chunks: string[] = [];
  const sn = o.system_note;
  if (sn && typeof sn === "object") {
    const note = sn as Record<string, unknown>;
    const t = String(note.type ?? "").trim();
    const m = String(note.message ?? "").trim();
    if (m) chunks.push(m);
    if (t) chunks.push(`type:${t}`);
  }
  const extraKeys = [
    "payment_status",
    "pay_status",
    "gateway_status",
    "gateway_payment_status",
    "line_pay_status",
    "payment_result",
    "ecpay_status",
    "payment_error_message",
  ] as const;
  for (const k of extraKeys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) chunks.push(v.trim());
    if (v && typeof v === "object" && !Array.isArray(v)) {
      try {
        chunks.push(JSON.stringify(v));
      } catch {
        /* skip */
      }
    }
  }
  if (typeof o.tag === "string" && o.tag.trim()) chunks.push(`tag:${o.tag.trim()}`);
  const st = o.status != null ? String(o.status) : "";
  if (st && /cancel|void|fail|refund|closed|error/i.test(st)) {
    chunks.push(`order.status=${st}`);
  }
  /** 少數 webhook／同步層會包一層 nested `order`（與 orders.json 扁平欄位並存時仍要吃失敗訊號） */
  const nested = o.order;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const no = nested as Record<string, unknown>;
    if (no.status != null) chunks.push(`nested.order.status=${String(no.status)}`);
    const ng = no.gateway_status;
    if (typeof ng === "string" && ng.trim()) chunks.push(ng.trim());
    const sn2 = no.system_note;
    if (sn2 && typeof sn2 === "object") {
      const m2 = String((sn2 as Record<string, unknown>).message ?? "").trim();
      if (m2) chunks.push(m2);
    }
  }
  const joined = chunks.join(" | ").trim();
  return joined || undefined;
}

/** 除錯用：對照單筆 API payload 與 derivePaymentStatus 輸入（勿依賴於正式邏輯） */
function isDebugEsc21137SlOrder(o: any): boolean {
  if (!o || typeof o !== "object") return false;
  if (o.order_id === "ESC21137" || o.order_number === "ESC21137" || o.global_order_id === "ESC21137") {
    return true;
  }
  if (typeof o.id === "string" && o.id.includes("ESC21137")) return true;
  return false;
}

function mapOrder(o: any): OrderInfo {
  if (isDebugEsc21137SlOrder(o)) {
    console.log("[DEBUG_SL_ESC21137_RAW]", JSON.stringify(o, null, 2).slice(0, 5000));
    console.log("[DEBUG_SL_PAY_INPUT]", {
      order_id: o.order_id || o.order_number || o.global_order_id,
      payment_method: o.payment_method,
      payment_method_code: o.payment_method_code,
      payment_type: o.payment_type,
      pay_method: o.pay_method,
      shipping_method: o.shipping_method,
      shipping_method_code: o.shipping_method_code,
      delivery_method: o.delivery_method,
      ship_method: o.ship_method,
    });
  }

  let trackingNumber = "";
  if (Array.isArray(o.tracking_codes) && o.tracking_codes.length > 0) {
    trackingNumber = o.tracking_codes.map((t: any) => t.tracking_code || t).join(", ");
  }

  let productListStr = "";
  let itemsStructured: string | undefined;
  if (Array.isArray(o.product_list)) {
    productListStr = JSON.stringify(o.product_list);
    itemsStructured = productListStr;
  } else if (typeof o.product_list === "string") {
    productListStr = o.product_list;
  }

  let address = "";
  let addressRaw: string | undefined;
  let fullAddress: string | undefined;
  if (typeof o.address === "string") {
    addressRaw = o.address;
    try {
      const parsed = JSON.parse(o.address);
      address = [parsed.state, parsed.city, parsed.addr1, parsed.addr2].filter(Boolean).join("");
      fullAddress = address || o.address;
    } catch (_e) {
      address = o.address;
      fullAddress = o.address;
    }
  } else if (o.address != null) {
    addressRaw = JSON.stringify(o.address);
  }

  const convenientStore = o.convenient_store;
  const deliveryTargetType = deriveDeliveryTargetType(o.shipping_method, convenientStore);
  const cvsParsed = parseConvenienceStore(convenientStore);
  if (deliveryTargetType === "cvs" && cvsParsed.full_address) {
    fullAddress = cvsParsed.full_address;
  } else if (fullAddress === undefined && address) {
    fullAddress = address;
  }

  return {
    global_order_id: o.global_order_id || String(o.id || ""),
    status: o.status || "unknown",
    final_total_order_amount: Number(o.final_total_order_amount || 0),
    product_list: productListStr,
    buyer_name: o.recipient || "",
    buyer_phone: o.mobile || "",
    buyer_email: o.email || "",
    tracking_number: trackingNumber,
    created_at: o.created_date || o.order_created_at || "",
    shipped_at: o.shipped_at || "",
    order_created_at: o.order_created_at || "",
    shipping_method: o.shipping_method || "",
    payment_method: o.payment_method || "",
    prepaid: o.prepaid === true,
    paid_at: o.paid_at || null,
    address,
    note: o.note || "",
    page_id: o.page_id != null ? String(o.page_id) : undefined,
    page_title: typeof o.page_title === "string" ? o.page_title : undefined,
    payment_status_raw: deriveSuperlandingPaymentStatusRaw(o as Record<string, unknown>),
    delivery_status_raw: o.status != null ? String(o.status) : undefined,
    delivery_target_type: deliveryTargetType,
    cvs_brand: cvsParsed.cvs_brand || undefined,
    cvs_store_code: cvsParsed.cvs_store_code || undefined,
    cvs_store_name: cvsParsed.cvs_store_name || undefined,
    full_address: fullAddress,
    address_raw: addressRaw,
    payment_transaction_id: typeof o.payment_transaction_id === "string" ? o.payment_transaction_id : undefined,
    items_structured: itemsStructured,
  };
}

/** Phase34B：供 fixture / verify 走完整 payload → mapOrder → derivePaymentStatus */
export function mapSuperlandingOrderFromApiPayload(raw: Record<string, unknown>): OrderInfo {
  return mapOrder(raw as any);
}

export function getStatusLabel(status: string): string {
  return ORDER_STATUS_MAP[status] || status;
}

export async function fetchOrders(
  config: SuperLandingConfig,
  params: Record<string, string> = {}
): Promise<OrderInfo[]> {
  if (!config.merchantNo || !config.accessKey) {
    throw new Error("missing_credentials");
  }

  const queryParams = new URLSearchParams({
    merchant_no: config.merchantNo,
    access_key: config.accessKey,
    ...params,
  });

  const url = `${SUPERLANDING_API_BASE}/orders.json?${queryParams.toString()}`;
  console.log("[一頁商店] 正在查詢訂單，請求網址為:", url.replace(config.accessKey, "***"));

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[一頁商店] API 回傳錯誤:", res.status, errText);
      if (res.status === 401) throw new Error("invalid_credentials");
      throw new Error(`api_error_${res.status}`);
    }

    const data = await res.json();
    console.log("[一頁商店] 回傳結果: current_page=", data.current_page, "total_entries=", data.total_entries, "orders count=", Array.isArray(data.orders) ? data.orders.length : "N/A");

    const orders = Array.isArray(data) ? data : data?.orders || [];

    return orders.map(mapOrder);
  } catch (err: any) {
    if (err.message === "missing_credentials" || err.message === "invalid_credentials") throw err;
    if (err.message?.startsWith("api_error_")) throw err;
    console.error("[一頁商店] 連線失敗:", err);
    throw new Error("connection_failed");
  }
}

export interface DateFilterResult {
  orders: OrderInfo[];
  totalFetched: number;
  truncated: boolean;
}

export async function lookupOrdersByDateAndFilter(
  config: SuperLandingConfig,
  query: string,
  beginDate: string,
  endDate: string
): Promise<DateFilterResult> {
  let page = 1;
  const perPage = 200;
  const maxPages = 25;
  let allOrders: OrderInfo[] = [];
  let truncated = false;

  while (true) {
    const orders = await fetchOrders(config, {
      begin_date: beginDate,
      end_date: endDate,
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

  console.log(`[一頁商店] 日期範圍 ${beginDate}~${endDate} 共取得 ${allOrders.length} 筆${truncated ? "（已截斷）" : ""}，開始比對 "${query}"`);

  const normalizedQuery = query.replace(/[-\s]/g, "").toLowerCase();
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

  return { orders: matched, totalFetched: allOrders.length, truncated };
}

export interface ProductPageMapping {
  id: string;
  pageId: string;
  prefix: string;
  productName: string;
}

let cachedPages: ProductPageMapping[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

export function getCachedPages(): ProductPageMapping[] {
  return cachedPages;
}

export function getCachedPagesAge(): number {
  return cacheTimestamp > 0 ? Date.now() - cacheTimestamp : Infinity;
}

export async function refreshPagesCache(config: SuperLandingConfig): Promise<ProductPageMapping[]> {
  if (!config.merchantNo || !config.accessKey) {
    console.log("[銷售頁快取] 尚未設定 API 金鑰，略過同步");
    return cachedPages;
  }
  try {
    const pages = await fetchPages(config);
    cachedPages = pages;
    cacheTimestamp = Date.now();
    console.log(`[銷售頁快取] 同步完成，共 ${pages.length} 個銷售頁`);
    return pages;
  } catch (err: any) {
    console.error("[銷售頁快取] 同步失敗:", err.message);
    cacheTimestamp = Date.now();
    return cachedPages;
  }
}

export async function ensurePagesCacheLoaded(config: SuperLandingConfig): Promise<ProductPageMapping[]> {
  /** review bundle：僅匯出 prompt 快照時勿打銷售頁 API（避免 100+ 頁輪詢卡住打包） */
  if (process.env.REVIEW_PROMPT_EXPORT_SKIP_CATALOG === "1") {
    return [];
  }
  if (cachedPages.length > 0 && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedPages;
  }
  return refreshPagesCache(config);
}

export function buildProductCatalogPrompt(pages: ProductPageMapping[]): string {
  if (pages.length === 0) return "";
  const displayPages = pages.slice(0, 100);
  const lines = displayPages.map((p, i) => `- #${i + 1}｜${p.productName}`);
  const extraNote = pages.length > displayPages.length ? `\n（以上僅列出前 ${displayPages.length} 項，共 ${pages.length} 項商品。查詢工具已包含完整商品清單的模糊比對功能，直接將客戶描述的商品名稱傳入即可。）` : "";
  return `\n\n## [內部參考·商品清單]（自動同步，共 ${pages.length} 項）\n以下為本店部分商品，僅供你內部語意比對使用。禁止將編號、清單格式或任何內部資訊展示給客戶：\n${lines.join("\n")}${extraNote}\n\n## [內部規則] 產品辨識與查詢流程\n\n### 模糊匹配\n- 客戶可能用錯字、簡稱、俗稱或用途描述來指稱商品。\n- 你必須從上方商品清單中，用語意理解推論最佳匹配。\n\n### 二次確認（防呆）\n- 若客戶描述可能對應多個商品，用溫暖口語化的方式列出選項讓客戶確認。\n- 話術範例：「了解～因為跟○○相關的商品有幾款，想跟您確認一下，您購買的是『A商品名稱』還是『B商品名稱』呢？」\n- 只列出人類可讀的產品名稱，禁止顯示編號或任何代碼。\n\n### 自動觸發查詢\n- 確認唯一商品後，連同客戶手機號碼觸發訂單查詢。\n- 若完全找不到匹配商品，友善回覆：「不好意思，目前沒有找到跟您描述相符的商品，可以再確認一下商品名稱嗎？或者直接提供訂單編號我也能幫您查詢唷！」\n\n## [內部規則] 嚴格保密限制\n- **絕對禁止**在對話中顯示任何內部編號、API 欄位、系統代碼、技術參數。\n- **絕對禁止**提及「對應表」「商品清單」「備用查詢」「Function Calling」等系統用語。\n- 所有回覆必須像一位溫暖、專業的真人客服，使用口語化、親切的語氣。\n- 禁止使用條列式的系統說明（如「步驟一」「走備用查詢」），改用自然對話語氣。\n\n## [內部規則] 上下文實體提取\n- 執行查詢前，務必回顧整段歷史對話。\n- 若客戶先前已提過產品名稱或手機號碼，直接合併使用，**絕對不可重複詢問已提供過的資訊**。\n- 從整段對話中提取所有「產品名稱」和「電話號碼」實體，而非僅看最後一則訊息。\n\n## [內部規則] 回覆語氣指南\n- 語氣溫暖親切，像朋友般自然，適度使用「唷」「呢」「～」等語助詞。\n- 用「了解」「沒問題」「好的」開場，避免「根據系統」「依照規則」等機械用語。\n- 適度使用 emoji（😊、✨）但不過度。\n- 回覆簡潔有力，不冗長囉嗦。`;
}

export async function fetchPages(config: SuperLandingConfig): Promise<ProductPageMapping[]> {
  if (!config.merchantNo || !config.accessKey) {
    throw new Error("missing_credentials");
  }

  console.log("[一頁商店] 正在取得銷售頁列表...");

  try {
    let allPages: any[] = [];
    let pageNum = 1;
    const maxApiPages = 200;
    const delayBetweenPagesMs = 800;

    while (true) {
      const queryParams = new URLSearchParams({
        merchant_no: config.merchantNo,
        access_key: config.accessKey,
        per_page: "100",
        page: String(pageNum),
      });

      const url = `${SUPERLANDING_API_BASE}/pages.json?${queryParams.toString()}`;
      let res: Response;
      try {
        res = await fetchWithRetry(url, {
          method: "GET",
          headers: { "Accept": "application/json" },
        });
      } catch (fetchErr: any) {
        console.error(`[一頁商店] 銷售頁第 ${pageNum} 頁在重試後仍失敗:`, fetchErr?.message || fetchErr);
        break;
      }

      if (!res.ok) {
        if (res.status === 401) throw new Error("invalid_credentials");
        throw new Error(`api_error_${res.status}`);
      }

      const data = await res.json();
      const pages = Array.isArray(data) ? data : data?.pages || [];
      allPages = allPages.concat(pages);

      if (pageNum === 1) {
        console.log(`[一頁商店] 銷售頁 API: total_entries=${data.total_entries || "?"} total_pages=${data.total_pages || "?"}`);
      }

      await yieldEventLoop(300);

      const totalPages = data.total_pages || 1;
      if (pageNum >= totalPages || pages.length === 0) break;
      pageNum++;
      if (pageNum > maxApiPages) break;

      await sleep(delayBetweenPagesMs);
    }

    console.log(`[一頁商店] 取得 ${allPages.length} 個銷售頁（${pageNum} 頁 API 請求）`);

    const mapped = allPages.map((p: any) => ({
      id: String(p.id),
      pageId: String(p.id),
      prefix: p.id_prefix || "",
      productName: p.title || p.name || `銷售頁 ${p.id}`,
    }));

    if (mapped.length > 0 && mapped.length <= 50) {
      console.log("[一頁商店] 產品清單:");
      mapped.forEach((m: ProductPageMapping) => console.log(`  - [${m.pageId}] ${m.productName}`));
    } else if (mapped.length > 50) {
      console.log(`[一頁商店] 產品清單（顯示前 20 筆 / 共 ${mapped.length} 筆）:`);
      mapped.slice(0, 20).forEach((m: ProductPageMapping) => console.log(`  - [${m.pageId}] ${m.productName}`));
      console.log("  ... 略");
    }

    return mapped;
  } catch (err: any) {
    if (err.message === "missing_credentials" || err.message === "invalid_credentials") throw err;
    if (err.message?.startsWith("api_error_")) throw err;
    console.error("[一頁商店] 取得銷售頁失敗:", err);
    throw new Error("connection_failed");
  }
}

export async function lookupOrdersByPageAndPhone(
  config: SuperLandingConfig,
  pageId: string,
  phone: string
): Promise<DateFilterResult> {
  const normalizedPhone = phone.replace(/[-\s]/g, "");
  const perPage = 200;

  let totalEntries = 0;
  try {
    const probeRes = await fetch(
      `${SUPERLANDING_API_BASE}/orders.json?${new URLSearchParams({
        merchant_no: config.merchantNo,
        access_key: config.accessKey,
        page_id: pageId,
        per_page: "1",
        page: "1",
      }).toString()}`,
      { method: "GET", headers: { "Accept": "application/json" } }
    );
    if (probeRes.ok) {
      const probeData = await probeRes.json();
      totalEntries = probeData.total_entries || 0;
    }
  } catch (err: any) {
    console.error(`[一頁商店] page_id=${pageId} 探測失敗:`, err.message);
  }

  /** Phase 30：多日期視窗合併去重，不可第一個視窗命中就早退（與 lookupOrdersByPhone 一致） */
  if (totalEntries > 3000) {
    console.log(`[一頁商店] page_id=${pageId} 有 ${totalEntries} 筆訂單，使用日期窗口合併搜尋`);
    const dateWindows = [{ days: 7 }, { days: 30 }, { days: 90 }, { days: 365 }];
    const byOrderId = new Map<string, OrderInfo>();
    let totalFetched = 0;

    for (const window of dateWindows) {
      const today = new Date();
      const start = new Date(today.getTime() - window.days * 24 * 60 * 60 * 1000);
      const endDate = today.toISOString().split("T")[0];
      const beginDate = start.toISOString().split("T")[0];

      let allOrders: OrderInfo[] = [];
      let p = 1;
      const maxPages = 50;

      while (true) {
        const orders = await fetchOrders(config, {
          page_id: pageId,
          begin_date: beginDate,
          end_date: endDate,
          per_page: String(perPage),
          page: String(p),
        });
        allOrders = allOrders.concat(orders);
        await yieldEventLoop(300);
        if (orders.length < perPage) break;
        p++;
        if (p > maxPages) break;
      }

      totalFetched += allOrders.length;
      const windowHits = allOrders.filter((o) => o.buyer_phone.replace(/[-\s]/g, "") === normalizedPhone).length;
      for (const o of allOrders) {
        const orderPhone = o.buyer_phone.replace(/[-\s]/g, "");
        if (orderPhone === normalizedPhone) byOrderId.set(o.global_order_id, o);
      }
      const cumulativeUnique = byOrderId.size;
      console.log(
        `[一頁商店] page_phone_window=${window.days} window_hits=${windowHits} cumulative_unique_hits=${cumulativeUnique} 累計不重複匹配 ${cumulativeUnique} page_id=${pageId}`
      );
    }

    const merged = Array.from(byOrderId.values());
    return { orders: merged, totalFetched, truncated: merged.length === 0 && totalEntries > 0 };
  }

  let page = 1;
  const maxPages = 40;
  let allOrders: OrderInfo[] = [];
  let truncated = false;

  while (true) {
    const orders = await fetchOrders(config, {
      page_id: pageId,
      per_page: String(perPage),
      page: String(page),
    });
    allOrders = allOrders.concat(orders);
    await yieldEventLoop(300);
    if (orders.length < perPage) break;
    page++;
    if (page > maxPages) {
      truncated = true;
      break;
    }
  }

  console.log(`[一頁商店] page_id=${pageId} 共取得 ${allOrders.length} 筆${truncated ? "（已截斷）" : ""}，開始比對電話 "${normalizedPhone}"`);

  const matched = allOrders.filter(o => {
    const orderPhone = o.buyer_phone.replace(/[-\s]/g, "");
    return orderPhone === normalizedPhone;
  });

  return { orders: matched, totalFetched: allOrders.length, truncated };
}

export async function lookupOrderById(
  config: SuperLandingConfig,
  orderId: string
): Promise<OrderInfo | null> {
  const normalizedId = orderId.trim().toUpperCase();
  console.log(`[API 請求] 準備查詢單號: ${normalizedId}，merchant_no: ${config.merchantNo}`);
  const orders = await fetchOrders(config, { global_order_id: normalizedId });
  console.log(`[API 回應] 查詢結果: ${orders.length} 筆`, orders.length > 0 ? `→ 找到訂單 ${orders[0].global_order_id} 狀態=${orders[0].status}` : "→ 查無資料");
  return orders.length > 0 ? orders[0] : null;
}

export async function lookupOrdersByPhone(
  config: SuperLandingConfig,
  phone: string,
  productKeyword?: string
): Promise<DateFilterResult> {
  const normalizedPhone = phone.replace(/[-\s]/g, "");
  console.log("[一頁商店] 以手機號碼全域搜尋:", normalizedPhone, productKeyword ? `關鍵字: ${productKeyword}` : "");

  let allMatched: OrderInfo[] = [];
  let totalScanned = 0;
  let wasTruncated = false;
  const perPage = 200;
  const parallelBatch = 5;

  /** Phase 2.9：各日期視窗皆掃完並合併去重，不可「第一個視窗命中就 break」以免漏單 */
  const dateWindows = [
    { days: 1, label: "今天" },
    { days: 3, label: "3天" },
    { days: 7, label: "7天" },
    { days: 30, label: "30天" },
    { days: 90, label: "90天" },
    { days: 180, label: "180天" },
  ];
  const byOrderId = new Map<string, OrderInfo>();

  for (const window of dateWindows) {
    const today = new Date();
    const start = new Date(today.getTime() - (window.days - 1) * 24 * 60 * 60 * 1000);
    const endDate = today.toISOString().split("T")[0];
    const beginDate = start.toISOString().split("T")[0];

    let totalEntries = 0;
    try {
      const probeRes = await fetch(
        `${SUPERLANDING_API_BASE}/orders.json?${new URLSearchParams({
          merchant_no: config.merchantNo,
          access_key: config.accessKey,
          begin_date: beginDate,
          end_date: endDate,
          per_page: "1",
          page: "1",
        }).toString()}`,
        { method: "GET", headers: { "Accept": "application/json" } }
      );
      const probeData = await probeRes.json();
      totalEntries = probeData.total_entries || 0;
    } catch (err: any) {
      console.error(`[一頁商店] ${window.label}窗口探測失敗:`, err.message);
      continue;
    }
    const totalPages = Math.ceil(totalEntries / perPage);
    const maxPages = Math.min(totalPages, 150);
    if (totalPages > maxPages) wasTruncated = true;

    console.log(`[一頁商店] ${window.label}窗口（${beginDate}~${endDate}）: ${totalEntries} 筆，掃描 ${maxPages} 頁${totalPages > maxPages ? "（截斷）" : ""}`);

    if (totalEntries === 0) continue;

    let windowHits = 0;
    for (let batchStart = 1; batchStart <= maxPages; batchStart += parallelBatch) {
      const pageNums = [];
      for (let p = batchStart; p < batchStart + parallelBatch && p <= maxPages; p++) {
        pageNums.push(p);
      }

      const batchResults = await Promise.all(
        pageNums.map(p =>
          fetchOrders(config, {
            begin_date: beginDate,
            end_date: endDate,
            per_page: String(perPage),
            page: String(p),
          })
        )
      );

      for (const orders of batchResults) {
        totalScanned += orders.length;
        for (const o of orders) {
          const orderPhone = o.buyer_phone.replace(/[-\s]/g, "");
          if (orderPhone === normalizedPhone) {
            byOrderId.set(o.global_order_id, o);
            windowHits++;
          }
        }
      }

      await yieldEventLoop(300);
    }

    console.log(
      `[一頁商店] ${window.label}窗口掃描完成，本視窗手機命中 ${windowHits} 筆（累計不重複 ${byOrderId.size}）`
    );
  }

  const uniqueOrders = Array.from(byOrderId.values());

  if (productKeyword && uniqueOrders.length > 0) {
    const kw = productKeyword.toLowerCase();
    const filtered = uniqueOrders.filter(o => o.product_list.toLowerCase().includes(kw));
    if (filtered.length > 0) {
      console.log(`[一頁商店] 關鍵字「${productKeyword}」篩選後 ${filtered.length} 筆`);
      return { orders: filtered, totalFetched: totalScanned, truncated: false };
    }
    console.log(`[一頁商店] 關鍵字「${productKeyword}」無匹配，回傳全部 ${uniqueOrders.length} 筆`);
  }

  console.log(`[一頁商店] 全域搜尋完成：掃描 ${totalScanned} 筆，找到 ${uniqueOrders.length} 筆`);
  return { orders: uniqueOrders, totalFetched: totalScanned, truncated: wasTruncated };
}

/** Phase 1：依手機號碼全域查單（不限定 page_id）之別名 */
export const lookup_order_by_phone_global = lookupOrdersByPhone;
