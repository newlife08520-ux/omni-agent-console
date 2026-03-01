import type { OrderInfo } from "@shared/schema";

const SUPERLANDING_API_BASE = "https://superlanding.tw/api";

export interface SuperLandingConfig {
  merchantNo: string;
  accessKey: string;
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
    const orders = Array.isArray(data) ? data : data?.orders || data?.data || [];

    return orders.map((o: any) => ({
      global_order_id: o.global_order_id || o.id || "",
      status: o.status || "unknown",
      final_total_order_amount: Number(o.final_total_order_amount || o.total || 0),
      product_list: typeof o.product_list === "string" ? o.product_list : JSON.stringify(o.product_list || o.items || []),
      buyer_name: o.buyer_name || o.name || "",
      buyer_phone: o.buyer_phone || o.phone || "",
      tracking_number: o.tracking_number || o.tracking_no || "",
      created_at: o.created_at || o.order_date || "",
    }));
  } catch (err: any) {
    if (err.message === "missing_credentials" || err.message === "invalid_credentials") throw err;
    if (err.message?.startsWith("api_error_")) throw err;
    throw new Error("connection_failed");
  }
}

export async function lookupOrdersByPhone(
  config: SuperLandingConfig,
  phone: string
): Promise<OrderInfo[]> {
  return fetchOrders(config, { buyer_phone: phone });
}

export async function lookupOrderById(
  config: SuperLandingConfig,
  orderId: string
): Promise<OrderInfo | null> {
  const orders = await fetchOrders(config, { global_order_id: orderId });
  return orders.length > 0 ? orders[0] : null;
}
