import type { OrderInfo, DeliveryTargetType } from "@shared/schema";

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
  /** Phase 2.2：搜尋 API 實際翻頁次數（供 latency log） */
  pagesFetched?: number;
}

/** SHOPLINE Open API 固定 base（Token 識別商店），見 https://open-api.docs.shoplineapp.com/docs/openapi-request-example */
const SHOPLINE_OPEN_API_BASE = "https://open.shopline.io";

function buildBaseUrl(_config: ShoplineConfig): string {
  return `${SHOPLINE_OPEN_API_BASE}/${SHOPLINE_API_VERSION}`;
}

/** 從 order_payment 取付款狀態原始值 */
export function getShoplinePaymentStatusRaw(o: any): string | undefined {
  const status = o?.order_payment?.status;
  return typeof status === "string" ? status : undefined;
}

/** 從 order_delivery 取配送狀態原始值 */
export function getShoplineDeliveryStatusRaw(o: any): string | undefined {
  const s = o?.order_delivery?.delivery_status ?? o?.order_delivery?.status;
  return typeof s === "string" ? s : undefined;
}

/** 依 order_delivery / delivery_data 判斷宅配或超商 */
export function getShoplineDeliveryTargetType(o: any): DeliveryTargetType {
  const del = o?.order_delivery;
  const data = o?.delivery_data;
  const deliveryType = typeof del?.delivery_type === "string" ? del.delivery_type.toLowerCase() : "";
  const nameZh = del?.name_translations?.["zh-hant"] ?? del?.name_translations?.["zh-Hant"] ?? "";
  if (deliveryType === "pickup" || /超商|門市|取貨|store|cvs/i.test(nameZh)) return "cvs";
  if (data?.location_code || data?.location_name || (data?.store_address && !del?.requires_customer_address)) return "cvs";
  if (deliveryType === "custom" || del?.requires_customer_address === true || /宅配|到府|home|delivery/i.test(nameZh)) return "home";
  return "unknown";
}

function mapShoplineOrder(o: any): OrderInfo {
  const deliveryData = o?.delivery_data;
  const orderDelivery = o?.order_delivery;
  const deliveryAddr = o?.delivery_address;
  const orderPayment = o?.order_payment;

  let trackingNumber = "";
  if (deliveryData && typeof deliveryData.tracking_number === "string" && deliveryData.tracking_number) {
    trackingNumber = deliveryData.tracking_number;
  } else if (Array.isArray(o.fulfillments)) {
    trackingNumber = o.fulfillments
      .map((f: any) => f.tracking_number || f.tracking_code || "")
      .filter(Boolean)
      .join(", ");
  } else if (typeof o.tracking_number === "string") {
    trackingNumber = o.tracking_number;
  }

  let productListStr = "";
  let itemsStructured: string | undefined;
  const rawItems = o.order_items ?? o.line_items ?? o.items;
  if (Array.isArray(rawItems)) {
    const mapped = rawItems.map((item: any) => ({
      name: item.name ?? item.product_name ?? item.title ?? "",
      code: item.sku ?? item.product_id ?? "",
      qty: item.quantity ?? item.qty ?? 1,
      price: item.price ?? item.sale_price ?? 0,
    }));
    productListStr = JSON.stringify(mapped);
    itemsStructured = productListStr;
  } else if (typeof o.product_list === "string") {
    productListStr = o.product_list;
  }

  const subRaw = o.subtotal_items ?? o.subtotal_line_items;
  if (Array.isArray(subRaw) && subRaw.length > 0) {
    const fromSub = subRaw.map((item: any) => ({
      name: item.title ?? item.name ?? item.product_name ?? item.product_title ?? "",
      code: item.sku ?? item.variant_id ?? item.product_id ?? "",
      qty: item.quantity ?? item.qty ?? 1,
      price:
        item.price?.dollars ??
        (item.price?.cents != null ? item.price.cents / 100 : undefined) ??
        item.price ??
        item.subtotal?.dollars ??
        0,
    }));
    const needSub =
      !productListStr ||
      productListStr === "[]" ||
      (() => {
        try {
          const p = JSON.parse(productListStr);
          return Array.isArray(p) && p.length === 0;
        } catch {
          return true;
        }
      })();
    if (needSub) {
      productListStr = JSON.stringify(fromSub);
      itemsStructured = productListStr;
    }
  }

  let address = "";
  let fullAddress: string | undefined;
  let addressRaw: string | undefined;
  if (deliveryAddr && typeof deliveryAddr === "object") {
    address = [
      deliveryAddr.country,
      deliveryAddr.state,
      deliveryAddr.city,
      deliveryAddr.district,
      deliveryAddr.address_1 ?? deliveryAddr.address1,
      deliveryAddr.address_2 ?? deliveryAddr.address2,
    ]
      .filter(Boolean)
      .join("");
    if (address) fullAddress = address;
    addressRaw = JSON.stringify(deliveryAddr);
  } else if (o.shipping_address && typeof o.shipping_address === "object") {
    const addr = o.shipping_address;
    address = [
      addr.country,
      addr.province ?? addr.state,
      addr.city,
      addr.district,
      addr.address1 ?? addr.address_1,
      addr.address2 ?? addr.address_2,
    ]
      .filter(Boolean)
      .join("");
    if (address) fullAddress = address;
  } else if (typeof o.shipping_address === "string") {
    address = o.shipping_address;
    fullAddress = o.shipping_address;
  } else if (typeof o.address === "string") {
    address = o.address;
    fullAddress = o.address;
  }

  const buyerName =
    o.customer_name ??
    deliveryData?.recipient_name ??
    deliveryAddr?.recipient_name ??
    o.shipping_address?.name ??
    o.customer?.name ??
    o.buyer?.name ??
    o.billing_address?.name ??
    o.recipient_name ??
    o.recipient?.name ??
    "";
  const buyerPhone =
    o.customer_phone ??
    deliveryData?.recipient_phone ??
    deliveryAddr?.recipient_phone ??
    o.shipping_address?.phone ??
    o.customer?.phone ??
    o.buyer?.phone ??
    o.billing_address?.phone ??
    o.mobile ??
    o.phone ??
    o.recipient_phone ??
    o.recipient?.phone ??
    "";
  const buyerEmail = o.customer_email ?? o.customer?.email ?? o.email ?? "";

  const orderNumber = o.order_number ?? o.order_no ?? o.name ?? o.id ?? "";
  const totalDollars = o.total?.dollars ?? (o.total?.cents != null ? o.total.cents / 100 : undefined);
  const totalFromPayment = orderPayment?.total?.dollars ?? (orderPayment?.total?.cents != null ? orderPayment.total.cents / 100 : undefined);
  const finalTotal = Number(totalDollars ?? totalFromPayment ?? 0);

  const deliveryTargetType = getShoplineDeliveryTargetType(o);
  const payStatus = (orderPayment?.status || "").toLowerCase();
  const paidAt =
    orderPayment?.paid_at ??
    orderPayment?.completed_at ??
    orderPayment?.payment_at ??
    (payStatus === "completed" || payStatus === "paid" ? o.updated_at : null);

  const mapped: OrderInfo = {
    global_order_id: String(orderNumber),
    status: typeof o.status === "string" ? o.status : (o.order_status ?? "unknown"),
    final_total_order_amount: finalTotal,
    product_list: productListStr,
    buyer_name: buyerName,
    buyer_phone: buyerPhone,
    buyer_email: buyerEmail,
    tracking_number: trackingNumber,
    created_at: orderDelivery?.created_at ?? o.created_at ?? o.created_date ?? "",
    shipped_at: orderDelivery?.shipped_at ?? o.shipped_at ?? o.fulfilled_at ?? "",
    order_created_at: o.created_at ?? o.order_created_at ?? "",
    shipping_method: orderDelivery?.name_translations?.["zh-hant"] ?? orderDelivery?.name_translations?.["zh-Hant"] ?? o.shipping_method ?? o.delivery_method ?? "",
    payment_method: orderPayment?.payment_type ?? orderPayment?.name_translations?.["zh-hant"] ?? o.payment_method ?? o.payment_type ?? "",
    prepaid: /paid|complete|success|authorized|captured/i.test(payStatus) ? true : /pending|unpaid|awaiting/i.test(payStatus) ? false : undefined,
    paid_at: paidAt != null ? String(paidAt) : null,
    address,
    note: o.note ?? o.customer_note ?? o.order_remarks ?? o.remark ?? "",
    page_id: o.page_id != null ? String(o.page_id) : undefined,
    page_title: typeof o.page_title === "string" ? o.page_title : undefined,
    payment_status_raw: getShoplinePaymentStatusRaw(o),
    delivery_status_raw: getShoplineDeliveryStatusRaw(o),
    delivery_target_type: deliveryTargetType,
    cvs_brand: deliveryTargetType === "cvs" && deliveryData?.location_name ? "超商" : undefined,
    cvs_store_code: deliveryTargetType === "cvs" ? deliveryData?.location_code : undefined,
    cvs_store_name: deliveryTargetType === "cvs" ? deliveryData?.location_name : undefined,
    full_address: fullAddress ?? (deliveryTargetType === "cvs" ? deliveryData?.store_address : undefined),
    address_raw: addressRaw,
    payment_transaction_id: orderPayment?.payment_data?.info?.transactionId ?? undefined,
    items_structured: itemsStructured,
  };

  const rawPm = String(mapped.payment_method ?? "").trim();
  if (/tw_.*b2c_pay|cash_on_delivery|home_delivery_cod/i.test(rawPm)) {
    mapped.payment_method = "貨到付款";
  } else if (/credit|信用卡/i.test(rawPm)) {
    mapped.payment_method = "信用卡";
  } else if (/line.?pay/i.test(rawPm)) {
    mapped.payment_method = "LINE Pay";
  } else if (/atm|轉帳/i.test(rawPm)) {
    mapped.payment_method = "ATM 轉帳";
  }

  return mapped;
}

export function getShoplineStatusLabel(status: string): string {
  return SHOPLINE_ORDER_STATUS_MAP[status] || status;
}

async function shoplineRequest(
  config: ShoplineConfig,
  endpoint: string,
  params: Record<string, string> = {}
): Promise<any> {
  const domain = String(config.storeDomain || "").trim();
  const token = String(config.apiToken || "").trim();
  if (!domain || !token) {
    throw new Error("MISSING_SHOPLINE_CONFIG: shopline_store_domain and shopline_api_token are required");
  }

  const baseUrl = buildBaseUrl(config);
  const queryParams = new URLSearchParams(params);
  const url = `${baseUrl}${endpoint}?${queryParams.toString()}`;

  console.log(
    "[SHOPLINE] API 請求:",
    url.replace(token, "***")
  );

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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
      err.message === "invalid_credentials" ||
      (typeof err.message === "string" && err.message.startsWith("MISSING_SHOPLINE_CONFIG"))
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

/** 手機僅保留數字，供精準比對 */
export function normalizeShoplinePhoneDigits(phone: string): string {
  return (phone || "").replace(/\D/g, "");
}

function rawOrderIdExactMatch(raw: any, id: string): boolean {
  const u = id.trim().toUpperCase();
  const vals = [
    raw?.order_number,
    raw?.order_no,
    raw?.name,
    raw?.system_order_number,
    raw?.display_number,
    raw?.order_number_display,
    raw?.id,
  ];
  return vals.some((v) => String(v ?? "").trim().toUpperCase() === u);
}

/**
 * Phase 2.2：/orders/search 分頁拉滿（最多 maxPages），再於應用層做精準過濾。
 */
export async function fetchShoplineSearchAllPages(
  config: ShoplineConfig,
  query: string,
  opts?: { maxPages?: number; perPage?: number }
): Promise<{ raws: any[]; pagesFetched: number; truncated: boolean }> {
  const maxPages = opts?.maxPages ?? 30;
  const perPage = Math.min(250, Math.max(1, opts?.perPage ?? 100));
  const seen = new Set<string>();
  const raws: any[] = [];
  let pagesFetched = 0;
  let truncated = false;
  const q = (query || "").trim();
  if (!q) return { raws: [], pagesFetched: 0, truncated: false };

  for (let page = 1; page <= maxPages; page++) {
    const data = await shoplineRequest(config, "/orders/search", {
      query: q,
      per_page: String(perPage),
      page: String(page),
    });
    const items = parseOrdersResponse(data);
    pagesFetched++;
    if (!items.length) break;
    for (const item of items) {
      const id = String(item?.id ?? item?._id ?? "");
      const key = id || JSON.stringify(item).slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      raws.push(item);
    }
    const total = data.pagination?.total;
    if (typeof total === "number" && raws.length >= total) break;
    if (items.length < perPage) break;
  }
  if (pagesFetched >= maxPages && raws.length > 0) truncated = true;
  /** 暫時診斷：map 之前看 Shopline /orders/search 原始訂單結構（商品明細欄位名） */
  if (raws.length > 0) {
    console.log("[SHOPLINE_RAW_ITEM_DEBUG]", JSON.stringify(raws[0]).slice(0, 2000));
  }
  return { raws, pagesFetched, truncated };
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

  /** 暫時診斷：map 之前看 Shopline 原始訂單（/orders 或 /orders/search） */
  if (orders.length > 0) {
    console.log("[SHOPLINE_RAW_ITEM_DEBUG]", JSON.stringify(orders[0]).slice(0, 2000));
  }

  return orders.map(mapShoplineOrder);
}

export async function lookupShoplineOrderById(
  config: ShoplineConfig,
  orderId: string
): Promise<OrderInfo | null> {
  const normalizedId = orderId.trim();
  const domain = String(config.storeDomain || "").trim();
  const token = String(config.apiToken || "").trim();
  console.log("[SHOPLINE_DEBUG] 查詢開始", {
    action: "lookup_by_id",
    query: normalizedId,
    domain: domain?.slice(0, 30),
    hasToken: !!token,
    tokenPrefix: token?.slice(0, 8),
  });
  console.log(`[SHOPLINE] 查詢單號（精準）: ${normalizedId}`);

  try {
    const { raws, pagesFetched } = await fetchShoplineSearchAllPages(config, normalizedId, {
      maxPages: 12,
      perPage: 100,
    });
    for (const raw of raws) {
      if (rawOrderIdExactMatch(raw, normalizedId)) {
        const o = mapShoplineOrder(raw);
        console.log(
          `[SHOPLINE] 精準命中 ${o.global_order_id} pagesFetched=${pagesFetched} 狀態=${o.status}`
        );
        const payload = { hit: true, global_order_id: o.global_order_id, status: o.status, pagesFetched, scanned: raws.length };
        console.log("[SHOPLINE_DEBUG] 查詢結果", {
          action: "lookup_by_id",
          query: normalizedId,
          resultCount: 1,
          firstResult: JSON.stringify(payload).slice(0, 300),
        });
        return o;
      }
    }
    console.log("[SHOPLINE] 查無精準符合訂單:", normalizedId, "pagesFetched=", pagesFetched);
    const dbgMiss = {
      hit: false,
      pagesFetched,
      scanned: raws.length,
      sampleIds: raws.slice(0, 3).map((r: any) => r?.order_number ?? r?.name ?? r?.id),
    };
    console.log("[SHOPLINE_DEBUG] 查詢結果", {
      action: "lookup_by_id",
      query: normalizedId,
      resultCount: 0,
      firstResult: JSON.stringify(dbgMiss).slice(0, 300),
    });
    return null;
  } catch (e: unknown) {
    const err = e as Error;
    console.error("[SHOPLINE_DEBUG] 查詢失敗", {
      action: "lookup_by_id",
      query: normalizedId,
      error: err?.message,
      stack: err?.stack?.slice(0, 300),
    });
    console.error("[SHOPLINE] 查詢單號失敗:", err?.message);
    throw e;
  }
}

/** Phase 2.2：分頁搜尋後僅保留「手機數字完全一致」的訂單 */
export async function lookupShoplineOrdersByPhoneExact(
  config: ShoplineConfig,
  phone: string,
  opts?: { maxPages?: number }
): Promise<ShoplineDateFilterResult> {
  const digits = normalizeShoplinePhoneDigits(phone);
  const domain = String(config.storeDomain || "").trim();
  const token = String(config.apiToken || "").trim();
  const queryStr = phone.replace(/[-\s]/g, "").trim() || digits;
  console.log("[SHOPLINE_DEBUG] 查詢開始", {
    action: "lookup_by_phone",
    query: queryStr,
    domain: domain?.slice(0, 30),
    hasToken: !!token,
    tokenPrefix: token?.slice(0, 8),
  });
  console.log("[SHOPLINE] 手機精準查詢 digits=", digits);
  if (digits.length < 8) {
    console.log("[SHOPLINE_DEBUG] 查詢結果", {
      action: "lookup_by_phone",
      query: queryStr,
      resultCount: 0,
      firstResult: JSON.stringify({ reason: "digits_too_short", digitsLen: digits.length }).slice(0, 300),
    });
    return { orders: [], totalFetched: 0, truncated: false, source: "shopline", pagesFetched: 0 };
  }
  const query = queryStr;
  try {
    const { raws, pagesFetched, truncated } = await fetchShoplineSearchAllPages(config, query, {
      maxPages: opts?.maxPages ?? 30,
      perPage: 100,
    });
    const matched: OrderInfo[] = [];
    for (const raw of raws) {
      const o = mapShoplineOrder(raw);
      if (normalizeShoplinePhoneDigits(o.buyer_phone || "") === digits) matched.push(o);
    }
    matched.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    console.log(
      `[SHOPLINE] 手機精準: pagesFetched=${pagesFetched} scanned=${raws.length} matched=${matched.length} truncated=${truncated}`
    );
    const dbgResult = {
      matchedCount: matched.length,
      pagesFetched,
      scanned: raws.length,
      truncated,
      firstOrderId: matched[0]?.global_order_id,
    };
    console.log("[SHOPLINE_DEBUG] 查詢結果", {
      action: "lookup_by_phone",
      query,
      resultCount: matched.length,
      firstResult: JSON.stringify(dbgResult).slice(0, 300),
    });
    return {
      orders: matched,
      totalFetched: raws.length,
      truncated,
      source: "shopline",
      pagesFetched,
    };
  } catch (e: unknown) {
    const err = e as Error;
    console.error("[SHOPLINE_DEBUG] 查詢失敗", {
      action: "lookup_by_phone",
      query,
      error: err?.message,
      stack: err?.stack?.slice(0, 300),
    });
    throw e;
  }
}

export async function lookupShoplineOrdersByPhone(
  config: ShoplineConfig,
  phone: string
): Promise<ShoplineDateFilterResult> {
  return lookupShoplineOrdersByPhoneExact(config, phone);
}

export async function lookupShoplineOrdersByEmailExact(
  config: ShoplineConfig,
  email: string,
  opts?: { maxPages?: number }
): Promise<ShoplineDateFilterResult> {
  const normalizedEmail = email.trim().toLowerCase();
  console.log("[SHOPLINE] Email 精準搜尋:", normalizedEmail);
  if (!normalizedEmail.includes("@")) {
    return { orders: [], totalFetched: 0, truncated: false, source: "shopline", pagesFetched: 0 };
  }
  const { raws, pagesFetched, truncated } = await fetchShoplineSearchAllPages(config, normalizedEmail, {
    maxPages: opts?.maxPages ?? 25,
    perPage: 100,
  });
  const matched = raws
    .map(mapShoplineOrder)
    .filter((o) => (o.buyer_email || "").trim().toLowerCase() === normalizedEmail);
  matched.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  console.log(`[SHOPLINE] Email 精準: pagesFetched=${pagesFetched} matched=${matched.length}`);
  return {
    orders: matched,
    totalFetched: raws.length,
    truncated,
    source: "shopline",
    pagesFetched,
  };
}

export async function lookupShoplineOrdersByEmail(
  config: ShoplineConfig,
  email: string
): Promise<ShoplineDateFilterResult> {
  return lookupShoplineOrdersByEmailExact(config, email);
}

function normalizeShoplinePersonName(s: string): string {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

export async function lookupShoplineOrdersByNameExact(
  config: ShoplineConfig,
  name: string,
  opts?: { maxPages?: number }
): Promise<ShoplineDateFilterResult> {
  const norm = normalizeShoplinePersonName(name);
  console.log("[SHOPLINE] 姓名精準搜尋:", norm);
  if (norm.length < 1) {
    return { orders: [], totalFetched: 0, truncated: false, source: "shopline", pagesFetched: 0 };
  }
  const { raws, pagesFetched, truncated } = await fetchShoplineSearchAllPages(config, name.trim(), {
    maxPages: opts?.maxPages ?? 20,
    perPage: 100,
  });
  const matched = raws
    .map(mapShoplineOrder)
    .filter((o) => normalizeShoplinePersonName(o.buyer_name || "") === norm);
  matched.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  console.log(`[SHOPLINE] 姓名精準: pagesFetched=${pagesFetched} matched=${matched.length}`);
  return {
    orders: matched,
    totalFetched: raws.length,
    truncated,
    source: "shopline",
    pagesFetched,
  };
}

export async function lookupShoplineOrdersByName(
  config: ShoplineConfig,
  name: string
): Promise<ShoplineDateFilterResult> {
  return lookupShoplineOrdersByNameExact(config, name);
}

/**
 * Phase 2.2：同步最近訂單至本地（GET /orders 分頁，依 created_at 由新到舊）。
 */
export async function fetchShoplineOrdersListPaginated(
  config: ShoplineConfig,
  opts?: { maxPages?: number; perPage?: number; createdAfter?: string }
): Promise<{ orders: OrderInfo[]; pagesFetched: number }> {
  const domain = String(config.storeDomain || "").trim();
  const token = String(config.apiToken || "").trim();
  console.log(
    "[SHOPLINE_DEBUG] fetchShoplineOrdersListPaginated domain:",
    domain,
    "token:",
    token ? `${token.slice(0, 8)}...` : "(empty)",
    "createdAfter:",
    opts?.createdAfter ?? "(none)"
  );
  const maxPages = opts?.maxPages ?? 40;
  const perPage = Math.min(250, Math.max(1, opts?.perPage ?? 100));
  const params: Record<string, string> = { per_page: String(perPage) };
  if (opts?.createdAfter) params.created_at_min = opts.createdAfter;
  const out: OrderInfo[] = [];
  let pagesFetched = 0;
  for (let page = 1; page <= maxPages; page++) {
    const data = await shoplineRequest(config, "/orders", { ...params, page: String(page) });
    const rawList = parseOrdersResponse(data);
    pagesFetched++;
    if (!rawList.length) break;
    if (page === 1 && rawList && rawList.length > 0) {
      console.log("[SHOPLINE_RAW_ITEM_DEBUG]", JSON.stringify(rawList[0]).slice(0, 3000));
    }
    for (const raw of rawList) out.push(mapShoplineOrder(raw));
    if (rawList.length < perPage) break;
  }
  const dbg = { action: "list_paginated", ordersCount: out.length, pagesFetched };
  console.log("[SHOPLINE_DEBUG] result:", JSON.stringify(dbg).slice(0, 500));
  return { orders: out, pagesFetched };
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
