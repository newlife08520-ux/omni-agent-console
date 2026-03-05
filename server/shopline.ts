import type { OrderInfo } from "@shared/schema";

const SHOPLINE_API_VERSION = "v1";

const SHOPLINE_ORDER_STATUS_MAP: Record<string, string> = {
  pending: "待處理",
  confirmed: "已確認",
  completed: "已完成",
  cancelled: "已取消",
  refunded: "已退款",
  partially_refunded: "部分退款",
  shipped: "已出貨",
  delivered: "已送達",
  returned: "已退貨",
  processing: "處理中",
  on_hold: "保留中",
};

export interface ShoplineConfig {
  storeDomain: string;
  apiToken: string;
}

export interface ShoplineDateFilterResult {
  orders: OrderInfo[];
  totalFetched: number;
  truncated: boolean;
  source: "shopline";
}

/** SHOPLINE Open API 固定 base（Token 識別商店），見 https://open-api.docs.shoplineapp.com/docs/openapi-request-example */
const SHOPLINE_OPEN_API_BASE = "https://open.shopline.io";

function buildBaseUrl(_config: ShoplineConfig): string {
  return `${SHOPLINE_OPEN_API_BASE}/${SHOPLINE_API_VERSION}`;
}

function mapShoplineOrder(o: any): OrderInfo {
  let trackingNumber = "";
  if (o.fulfillments && Array.isArray(o.fulfillments)) {
    trackingNumber = o.fulfillments
      .map((f: any) => f.tracking_number || f.tracking_code || "")
      .filter(Boolean)
      .join(", ");
  } else if (o.tracking_number) {
    trackingNumber = o.tracking_number;
  }

  let productListStr = "";
  if (Array.isArray(o.order_items || o.line_items || o.items)) {
    const items = o.order_items || o.line_items || o.items;
    productListStr = JSON.stringify(
      items.map((item: any) => ({
        name: item.name || item.product_name || item.title || "",
        code: item.sku || item.product_id || "",
        qty: item.quantity || item.qty || 1,
        price: item.price || item.sale_price || 0,
      }))
    );
  } else if (typeof o.product_list === "string") {
    productListStr = o.product_list;
  }

  let address = "";
  if (o.shipping_address) {
    const addr = o.shipping_address;
    if (typeof addr === "string") {
      address = addr;
    } else {
      address = [
        addr.country,
        addr.province || addr.state,
        addr.city,
        addr.district,
        addr.address1 || addr.address_1,
        addr.address2 || addr.address_2,
      ]
        .filter(Boolean)
        .join("");
    }
  } else if (o.address) {
    address = typeof o.address === "string" ? o.address : JSON.stringify(o.address);
  }

  let buyerName = "";
  if (o.customer_name) {
    buyerName = o.customer_name;
  } else if (o.shipping_address?.name) {
    buyerName = o.shipping_address.name;
  } else if (o.customer?.name) {
    buyerName = o.customer.name;
  } else if (o.billing_address?.name) {
    buyerName = o.billing_address.name;
  } else if (o.recipient_name) {
    buyerName = o.recipient_name;
  }

  let buyerPhone = "";
  if (o.customer_phone) {
    buyerPhone = o.customer_phone;
  } else if (o.shipping_address?.phone) {
    buyerPhone = o.shipping_address.phone;
  } else if (o.customer?.phone) {
    buyerPhone = o.customer.phone;
  } else if (o.billing_address?.phone) {
    buyerPhone = o.billing_address.phone;
  }

  let buyerEmail = "";
  if (o.customer_email) {
    buyerEmail = o.customer_email;
  } else if (o.customer?.email) {
    buyerEmail = o.customer.email;
  } else if (o.email) {
    buyerEmail = o.email;
  }

  const orderNumber = o.order_number || o.order_no || o.name || o.id || "";

  return {
    global_order_id: String(orderNumber),
    status: o.status || o.order_status || "unknown",
    final_total_order_amount: Number(o.total || o.total_price || o.grand_total || 0),
    product_list: productListStr,
    buyer_name: buyerName,
    buyer_phone: buyerPhone,
    buyer_email: buyerEmail,
    tracking_number: trackingNumber,
    created_at: o.created_at || o.created_date || "",
    shipped_at: o.shipped_at || o.fulfilled_at || "",
    order_created_at: o.created_at || o.order_created_at || "",
    shipping_method: o.shipping_method || o.delivery_method || "",
    payment_method: o.payment_method || o.payment_type || "",
    address,
    note: o.note || o.customer_note || o.remark || "",
  };
}

export function getShoplineStatusLabel(status: string): string {
  return SHOPLINE_ORDER_STATUS_MAP[status] || status;
}

async function shoplineRequest(
  config: ShoplineConfig,
  endpoint: string,
  params: Record<string, string> = {}
): Promise<any> {
  if (!config.storeDomain || !config.apiToken) {
    throw new Error("missing_credentials");
  }

  const baseUrl = buildBaseUrl(config);
  const queryParams = new URLSearchParams(params);
  const url = `${baseUrl}${endpoint}?${queryParams.toString()}`;

  console.log(
    "[SHOPLINE] API 請求:",
    url.replace(config.apiToken, "***")
  );

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiToken}`,
        "User-Agent": process.env.SHOPLINE_USER_AGENT || "OmniAgentConsole/1.0",
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[SHOPLINE] API 回傳錯誤:", res.status, errText);
      if (res.status === 401 || res.status === 403) throw new Error("invalid_credentials");
      throw new Error(`api_error_${res.status}`);
    }

    const data = await res.json();
    return data;
  } catch (err: any) {
    if (
      err.message === "missing_credentials" ||
      err.message === "invalid_credentials"
    )
      throw err;
    if (err.message?.startsWith("api_error_")) throw err;
    console.error("[SHOPLINE] 連線失敗:", err);
    throw new Error("connection_failed");
  }
}

/** 官方 Get Orders 回傳 items；Search Orders 亦同。相容舊格式 orders / data */
function parseOrdersResponse(data: any): any[] {
  const raw = data.items ?? data.orders ?? data.data ?? [];
  return Array.isArray(raw) ? raw : [];
}

export async function fetchShoplineOrders(
  config: ShoplineConfig,
  params: Record<string, string> = {}
): Promise<OrderInfo[]> {
  const query = params.query ?? params.keyword ?? params.order_number;
  const endpoint = query != null && String(query).trim() !== ""
    ? "/orders/search"
    : "/orders";
  const searchParams: Record<string, string> = { ...params };
  if (endpoint === "/orders/search" && query !== undefined) {
    searchParams.query = String(query).trim();
    delete searchParams.keyword;
    delete searchParams.order_number;
  }
  const data = await shoplineRequest(config, endpoint, searchParams);

  const orders = parseOrdersResponse(data);
  console.log(
    "[SHOPLINE] 回傳結果:",
    endpoint,
    "count=",
    orders.length,
    "total=",
    data.pagination?.total ?? data.total ?? "N/A"
  );

  if (!Array.isArray(orders)) {
    console.error("[SHOPLINE] 回傳格式異常，非陣列:", typeof orders);
    return [];
  }

  return orders.map(mapShoplineOrder);
}

export async function lookupShoplineOrderById(
  config: ShoplineConfig,
  orderId: string
): Promise<OrderInfo | null> {
  const normalizedId = orderId.trim();
  console.log(`[SHOPLINE] 查詢單號: ${normalizedId}`);

  try {
    const orders = await fetchShoplineOrders(config, {
      order_number: normalizedId,
    });

    if (orders.length > 0) {
      console.log(
        `[SHOPLINE] 找到訂單 ${orders[0].global_order_id} 狀態=${orders[0].status}`
      );
      return orders[0];
    }

    const ordersAlt = await fetchShoplineOrders(config, {
      keyword: normalizedId,
    });

    if (ordersAlt.length > 0) {
      const exact = ordersAlt.find(
        (o) => o.global_order_id.toUpperCase() === normalizedId.toUpperCase()
      );
      if (exact) {
        console.log(
          `[SHOPLINE] 關鍵字搜尋找到訂單 ${exact.global_order_id} 狀態=${exact.status}`
        );
        return exact;
      }
    }

    console.log("[SHOPLINE] 查無訂單:", normalizedId);
    return null;
  } catch (err: any) {
    console.error("[SHOPLINE] 查詢單號失敗:", err.message);
    throw err;
  }
}

export async function lookupShoplineOrdersByPhone(
  config: ShoplineConfig,
  phone: string
): Promise<ShoplineDateFilterResult> {
  const normalizedPhone = phone.replace(/[-\s]/g, "");
  console.log("[SHOPLINE] 以手機號碼搜尋:", normalizedPhone);

  let allMatched: OrderInfo[] = [];
  let totalFetched = 0;

  try {
    const orders = await fetchShoplineOrders(config, {
      keyword: normalizedPhone,
      per_page: "50",
    });
    totalFetched += orders.length;

    allMatched = orders.filter((o) => {
      const orderPhone = o.buyer_phone.replace(/[-\s]/g, "");
      return (
        orderPhone === normalizedPhone ||
        orderPhone.includes(normalizedPhone) ||
        normalizedPhone.includes(orderPhone)
      );
    });

    if (allMatched.length === 0 && orders.length > 0) {
      allMatched = orders;
    }

    console.log(
      `[SHOPLINE] 手機搜尋完成: 取得 ${totalFetched} 筆，匹配 ${allMatched.length} 筆`
    );
  } catch (err: any) {
    console.error("[SHOPLINE] 手機搜尋失敗:", err.message);
    throw err;
  }

  return {
    orders: allMatched,
    totalFetched,
    truncated: false,
    source: "shopline",
  };
}

export async function lookupShoplineOrdersByEmail(
  config: ShoplineConfig,
  email: string
): Promise<ShoplineDateFilterResult> {
  const normalizedEmail = email.trim().toLowerCase();
  console.log("[SHOPLINE] 以 Email 搜尋:", normalizedEmail);

  let allMatched: OrderInfo[] = [];
  let totalFetched = 0;

  try {
    const orders = await fetchShoplineOrders(config, {
      keyword: normalizedEmail,
      per_page: "50",
    });
    totalFetched += orders.length;

    allMatched = orders.filter((o) => {
      return o.buyer_email.toLowerCase() === normalizedEmail;
    });

    if (allMatched.length === 0 && orders.length > 0) {
      allMatched = orders;
    }

    console.log(
      `[SHOPLINE] Email 搜尋完成: 取得 ${totalFetched} 筆，匹配 ${allMatched.length} 筆`
    );
  } catch (err: any) {
    console.error("[SHOPLINE] Email 搜尋失敗:", err.message);
    throw err;
  }

  return {
    orders: allMatched,
    totalFetched,
    truncated: false,
    source: "shopline",
  };
}

export async function lookupShoplineOrdersByName(
  config: ShoplineConfig,
  name: string
): Promise<ShoplineDateFilterResult> {
  const normalizedName = name.trim().toLowerCase();
  console.log("[SHOPLINE] 以姓名搜尋:", normalizedName);

  let allMatched: OrderInfo[] = [];
  let totalFetched = 0;

  try {
    const orders = await fetchShoplineOrders(config, {
      keyword: normalizedName,
      per_page: "50",
    });
    totalFetched += orders.length;

    allMatched = orders.filter((o) => {
      return o.buyer_name.toLowerCase().includes(normalizedName);
    });

    if (allMatched.length === 0 && orders.length > 0) {
      allMatched = orders;
    }

    console.log(
      `[SHOPLINE] 姓名搜尋完成: 取得 ${totalFetched} 筆，匹配 ${allMatched.length} 筆`
    );
  } catch (err: any) {
    console.error("[SHOPLINE] 姓名搜尋失敗:", err.message);
    throw err;
  }

  return {
    orders: allMatched,
    totalFetched,
    truncated: false,
    source: "shopline",
  };
}

export async function lookupShoplineOrders(
  config: ShoplineConfig,
  query: string,
  queryType: "order_number" | "phone" | "email" | "name" = "order_number"
): Promise<ShoplineDateFilterResult> {
  switch (queryType) {
    case "order_number": {
      const order = await lookupShoplineOrderById(config, query);
      return {
        orders: order ? [order] : [],
        totalFetched: order ? 1 : 0,
        truncated: false,
        source: "shopline",
      };
    }
    case "phone":
      return lookupShoplineOrdersByPhone(config, query);
    case "email":
      return lookupShoplineOrdersByEmail(config, query);
    case "name":
      return lookupShoplineOrdersByName(config, query);
    default:
      return {
        orders: [],
        totalFetched: 0,
        truncated: false,
        source: "shopline",
      };
  }
}

export function detectQueryType(
  query: string
): "order_number" | "phone" | "email" | "name" {
  const trimmed = query.trim();

  if (trimmed.includes("@") && trimmed.includes(".")) {
    return "email";
  }

  const digitsOnly = trimmed.replace(/[-\s+()]/g, "");
  if (/^\d{7,}$/.test(digitsOnly) && digitsOnly.length <= 15) {
    return "phone";
  }

  if (/^[A-Za-z0-9#-]+$/.test(trimmed) && trimmed.length >= 4) {
    return "order_number";
  }

  return "name";
}
