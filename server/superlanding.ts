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

    while (true) {
      const queryParams = new URLSearchParams({
        merchant_no: config.merchantNo,
        access_key: config.accessKey,
        per_page: "100",
        page: String(pageNum),
      });

      const url = `${SUPERLANDING_API_BASE}/pages.json?${queryParams.toString()}`;
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
      allPages = allPages.concat(pages);

      if (pageNum === 1) {
        console.log(`[一頁商店] 銷售頁 API: total_entries=${data.total_entries || '?'} total_pages=${data.total_pages || '?'}`);
      }

      const totalPages = data.total_pages || 1;
      if (pageNum >= totalPages || pages.length === 0) break;
      pageNum++;
      if (pageNum > maxApiPages) break;
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

  if (totalEntries > 3000) {
    console.log(`[一頁商店] page_id=${pageId} 有 ${totalEntries} 筆訂單，使用日期窗口搜尋`);
    const dateWindows = [
      { days: 7 },
      { days: 30 },
      { days: 90 },
      { days: 365 },
    ];

    for (const window of dateWindows) {
      const today = new Date();
      const start = new Date(today.getTime() - window.days * 24 * 60 * 60 * 1000);
      const endDate = today.toISOString().split("T")[0];
      const beginDate = start.toISOString().split("T")[0];

      let allOrders: OrderInfo[] = [];
      let p = 1;
      const maxPages = 25;

      while (true) {
        const orders = await fetchOrders(config, {
          page_id: pageId,
          begin_date: beginDate,
          end_date: endDate,
          per_page: String(perPage),
          page: String(p),
        });
        allOrders = allOrders.concat(orders);
        if (orders.length < perPage) break;
        p++;
        if (p > maxPages) break;
      }

      const matched = allOrders.filter(o => {
        const orderPhone = o.buyer_phone.replace(/[-\s]/g, "");
        return orderPhone === normalizedPhone;
      });

      console.log(`[一頁商店] page_id=${pageId} ${window.days}天窗口: ${allOrders.length} 筆，電話匹配: ${matched.length} 筆`);

      if (matched.length > 0) {
        return { orders: matched, totalFetched: allOrders.length, truncated: false };
      }
    }

    return { orders: [], totalFetched: totalEntries, truncated: true };
  }

  let page = 1;
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
  const orders = await fetchOrders(config, { global_order_id: orderId });
  console.log("[一頁商店] 依訂單編號查詢:", orderId, "結果:", orders.length, "筆");
  return orders.length > 0 ? orders[0] : null;
}

export async function lookupOrdersByPhone(
  config: SuperLandingConfig,
  phone: string,
  productKeyword?: string
): Promise<DateFilterResult> {
  const normalizedPhone = phone.replace(/[-\s]/g, "");
  console.log("[一頁商店] 以手機號碼跨頁搜尋:", normalizedPhone, productKeyword ? `關鍵字: ${productKeyword}` : "");

  const pages = getCachedPages();
  if (pages.length === 0) {
    console.log("[一頁商店] 無快取銷售頁，無法搜尋");
    return { orders: [], totalFetched: 0, truncated: false };
  }

  let allMatched: OrderInfo[] = [];
  let totalScanned = 0;
  let truncated = false;
  const perPage = 200;

  const batchSize = 5;
  for (let i = 0; i < pages.length; i += batchSize) {
    const batch = pages.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (page) => {
        const orders = await fetchOrders(config, {
          page_id: page.pageId,
          per_page: String(perPage),
          page: "1",
        });
        return { page, orders };
      })
    );

    for (const { page, orders } of results) {
      totalScanned += orders.length;
      const phoneMatches = orders.filter(o => {
        const orderPhone = o.buyer_phone.replace(/[-\s]/g, "");
        return orderPhone === normalizedPhone;
      });
      if (phoneMatches.length > 0) {
        console.log(`[一頁商店] 銷售頁 ${page.pageId}（${page.productName}）找到 ${phoneMatches.length} 筆匹配`);
        allMatched = allMatched.concat(phoneMatches);
      }
    }

    if (allMatched.length >= 10) break;
  }

  if (allMatched.length > 0) {
    const matchedPageIds = [...new Set(allMatched.map(o => {
      const prefix = o.global_order_id.replace(/\d+$/, "");
      return pages.find(p => p.prefix === prefix)?.pageId;
    }).filter(Boolean))];

    for (const pageId of matchedPageIds) {
      const page = pages.find(p => p.pageId === pageId);
      if (!page) continue;
      for (let pNum = 2; pNum <= 5; pNum++) {
        const orders = await fetchOrders(config, {
          page_id: pageId,
          per_page: String(perPage),
          page: String(pNum),
        });
        totalScanned += orders.length;
        const phoneMatches = orders.filter(o => {
          const orderPhone = o.buyer_phone.replace(/[-\s]/g, "");
          return orderPhone === normalizedPhone;
        });
        if (phoneMatches.length > 0) {
          allMatched = allMatched.concat(phoneMatches);
        }
        if (orders.length < perPage) break;
      }
    }
  }

  console.log(`[一頁商店] 跨頁搜尋完成：掃描 ${totalScanned} 筆，找到 ${allMatched.length} 筆`);

  const uniqueOrders = Array.from(
    new Map(allMatched.map(o => [o.global_order_id, o])).values()
  );

  if (productKeyword && uniqueOrders.length > 0) {
    const kw = productKeyword.toLowerCase();
    const filtered = uniqueOrders.filter(o => o.product_list.toLowerCase().includes(kw));
    if (filtered.length > 0) {
      console.log(`[一頁商店] 關鍵字「${productKeyword}」篩選後 ${filtered.length} 筆`);
      return { orders: filtered, totalFetched: uniqueOrders.length, truncated };
    }
    console.log(`[一頁商店] 關鍵字「${productKeyword}」無匹配，回傳全部 ${uniqueOrders.length} 筆`);
  }

  return { orders: uniqueOrders, totalFetched: uniqueOrders.length, truncated };
}
