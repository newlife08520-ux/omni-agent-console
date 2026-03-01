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

export async function lookupOrderById(
  config: SuperLandingConfig,
  orderId: string
): Promise<OrderInfo | null> {
  const orders = await fetchOrders(config, { global_order_id: orderId });
  console.log("[一頁商店] 依訂單編號查詢:", orderId, "結果:", orders.length, "筆");
  return orders.length > 0 ? orders[0] : null;
}
