import type { OrderInfo } from "@shared/schema";

const SUPERLANDING_API_BASE = "https://api.super-landing.com";

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

function mapOrder(o: any): OrderInfo {
  let trackingNumber = "";
  if (Array.isArray(o.tracking_codes) && o.tracking_codes.length > 0) {
    trackingNumber = o.tracking_codes.map((t: any) => t.tracking_code || t).join(", ");
  }

  let productListStr = "";
  if (Array.isArray(o.product_list)) {
    productListStr = JSON.stringify(o.product_list);
  } else if (typeof o.product_list === "string") {
    productListStr = o.product_list;
  }

  let address = "";
  if (typeof o.address === "string") {
    try {
      const parsed = JSON.parse(o.address);
      address = [parsed.state, parsed.city, parsed.addr1, parsed.addr2].filter(Boolean).join("");
    } catch {
      address = o.address;
    }
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
    address,
    note: o.note || "",
  };
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
  if (cachedPages.length > 0 && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedPages;
  }
  return refreshPagesCache(config);
}

export function buildProductCatalogPrompt(pages: ProductPageMapping[]): string {
  if (pages.length === 0) return "";
  const lines = pages.map((p) => `- page_id=${p.pageId}｜${p.productName}`);
  return `\n\n## 🛍️ 目前商店產品對應表（自動同步，共 ${pages.length} 項）\n以下是目前所有可查詢的產品與其對應的 page_id，AI 必須依此表進行模糊匹配：\n${lines.join("\n")}\n\n## 🔍 產品模糊匹配規則\n1. 當客戶提到購買的產品時（可能包含錯字、簡稱、俗稱、用途描述，如「洗馬桶的」→潔廁泡泡、「蛋糕」→巴斯克），你必須從上方「產品對應表」中，使用語意理解推論出最符合的正確產品名稱與 page_id。\n2. **二次確認（防呆）**：如果客戶的描述太過模糊，可能對應到多個商品（例如只說「筋膜」，但對應表中有多款筋膜類產品），你必須主動列出所有可能的選項讓客戶確認，例如：「請問您購買的是『日本懶人舒壓筋膜圈』還是『雲感筋膜 SPA 軸』呢？」\n3. **自動觸發查詢**：當你成功推論出唯一的產品後，提取該產品的 page_id，連同客戶提供的手機號碼，呼叫「商品+電話」進階查詢功能來搜尋訂單。\n4. 若客戶描述的產品完全無法在對應表中找到任何匹配，請告知客戶「目前查無此商品，請確認商品名稱或提供訂單編號」。\n\n## ⚠️ 上下文實體提取規則（嚴格遵守）\n當你需要執行「產品＋電話」的訂單查詢前，請務必先檢視「整段歷史對話紀錄」。\n- 如果客戶在前面的對話中已經提過產品名稱（如巴斯克、筋膜圈），請直接結合最新的電話號碼來觸發查詢，**絕對不可以重複詢問客戶已經提供過的資訊**。\n- 同理，若客戶先提供了手機號碼，之後才提供產品名稱，也應直接合併觸發查詢。\n- 你必須從整段對話中提取所有已知的「產品名稱」和「電話號碼」實體，而非僅看最後一則訊息。`;
}

export async function fetchPages(config: SuperLandingConfig): Promise<ProductPageMapping[]> {
  if (!config.merchantNo || !config.accessKey) {
    throw new Error("missing_credentials");
  }

  const queryParams = new URLSearchParams({
    merchant_no: config.merchantNo,
    access_key: config.accessKey,
  });

  const url = `${SUPERLANDING_API_BASE}/pages.json?${queryParams.toString()}`;
  console.log("[一頁商店] 正在取得銷售頁列表...");

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("invalid_credentials");
      throw new Error(`api_error_${res.status}`);
    }

    const data = await res.json();
    const pages = Array.isArray(data) ? data : data?.pages || [];
    console.log(`[一頁商店] 取得 ${pages.length} 個銷售頁`);

    return pages.map((p: any) => ({
      id: String(p.id),
      pageId: String(p.id),
      prefix: p.id_prefix || "",
      productName: p.title || p.name || `銷售頁 ${p.id}`,
    }));
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
  let page = 1;
  const perPage = 200;
  const maxPages = 15;
  let allOrders: OrderInfo[] = [];
  let truncated = false;

  while (true) {
    const orders = await fetchOrders(config, {
      page_id: pageId,
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

  console.log(`[一頁商店] page_id=${pageId} 共取得 ${allOrders.length} 筆${truncated ? "（已截斷）" : ""}，開始比對電話 "${phone}"`);

  const normalizedPhone = phone.replace(/[-\s]/g, "");
  const matched = allOrders.filter((o) => {
    const orderPhone = o.buyer_phone.replace(/[-\s]/g, "");
    return orderPhone.includes(normalizedPhone) || normalizedPhone.includes(orderPhone);
  });

  return { orders: matched, totalFetched: allOrders.length, truncated };
}

export async function lookupOrderById(
  config: SuperLandingConfig,
  orderId: string
): Promise<OrderInfo | null> {
  const orders = await fetchOrders(config, { global_order_id: orderId });
  console.log("[一頁商店] 依訂單編號查詢:", orderId, "結果:", orders.length, "筆");
  return orders.length > 0 ? orders[0] : null;
}
