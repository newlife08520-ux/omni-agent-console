/**
 * SHOPLINE 訂單 payload 稽核
 * 依 CURSOR_ORDER_CX_WORLDCLASS_PLAN.md C 章 Step C1。
 * 目的：抓真實 API 欄位，遮罩後輸出，供欄位映射盤點用。
 *
 * 執行：npx tsx server/scripts/audit-shopline-order-payload.ts
 * 產出：docs/runtime-audit/shopline-order-sample.sanitized.json
 *       docs/runtime-audit/shopline-order-keys.md
 */
import fs from "fs";
import path from "path";
import {
  maskName,
  maskPhone,
  maskEmail,
  maskAddress,
  collectKeys,
  uniqueSortedKeys,
} from "./audit-utils";

const SHOPLINE_OPEN_API_BASE = "https://open.shopline.io";
const SHOPLINE_API_VERSION = "v1";

function getOutDir(): string {
  const root = process.cwd();
  const outDir = path.join(root, "docs", "runtime-audit");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

/** 遞迴遮罩物件中的 PII 欄位 */
function sanitizeObj(obj: unknown): unknown {
  if (obj == null) return obj;
  if (typeof obj !== "object") return obj;
  const o = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const nameKeys = ["name", "recipient_name", "customer_name", "buyer_name", "receiver_name"];
  const phoneKeys = ["phone", "recipient_phone", "customer_phone", "buyer_phone", "receiver_phone"];
  const emailKeys = ["email", "customer_email", "buyer_email"];
  const addrKeys = ["address_1", "address_2", "address1", "address2", "store_address", "full_address", "district", "city", "state", "province", "country"];

  for (const [k, v] of Object.entries(o)) {
    if (nameKeys.includes(k) && typeof v === "string") {
      out[k] = maskName(v);
    } else if (phoneKeys.includes(k) && typeof v === "string") {
      out[k] = maskPhone(v);
    } else if (emailKeys.includes(k) && typeof v === "string") {
      out[k] = maskEmail(v);
    } else if (addrKeys.includes(k) && typeof v === "string") {
      out[k] = maskAddress(v);
    } else if (k === "address" && typeof v === "string") {
      out[k] = maskAddress(v);
    } else if (v != null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitizeObj(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (item != null && typeof item === "object" ? sanitizeObj(item) : item));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 從 raw order 收集指定 nested 區塊的 keys */
function getNestedKeys(o: Record<string, unknown>, section: string): string[] {
  const v = o[section];
  if (v == null || typeof v !== "object") return [];
  return collectKeys(v, section);
}

async function main() {
  const { storage } = await import("../storage");

  const brands = storage.getBrands();
  const brandWithShopline = brands.find((b) => b.shopline_api_token?.trim());
  if (!brandWithShopline?.shopline_api_token?.trim()) {
    console.error("缺少 SHOPLINE 設定：請在任一品牌中填寫 shopline_api_token");
    process.exit(1);
  }

  const config = {
    storeDomain: brandWithShopline.shopline_store_domain?.trim() || "",
    apiToken: brandWithShopline.shopline_api_token.trim(),
  };

  const baseUrl = `${SHOPLINE_OPEN_API_BASE}/${SHOPLINE_API_VERSION}`;
  const url = `${baseUrl}/orders?per_page=5`;
  console.log("[audit-shopline] 請求訂單…", url);

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
    console.error("[audit-shopline] API 錯誤:", res.status, await res.text());
    process.exit(1);
  }

  const data = (await res.json()) as { items?: unknown[]; orders?: unknown[]; data?: unknown[] };
  const rawOrders = Array.isArray(data.items) ? data.items : Array.isArray(data.orders) ? data.orders : Array.isArray(data.data) ? data.data : [];
  console.log("[audit-shopline] 取得", rawOrders.length, "筆訂單");

  const allKeys: string[] = [];
  const sections = ["order_payment", "order_delivery", "delivery_address", "delivery_data", "subtotal_items", "customer_info", "invoice"];
  const sectionKeys: Record<string, string[]> = {};

  const sanitized: unknown[] = [];

  for (const raw of rawOrders) {
    const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    sanitized.push(sanitizeObj(o));
    allKeys.push(...collectKeys(o));
    for (const sec of sections) {
      const keys = getNestedKeys(o, sec);
      if (keys.length > 0) {
        if (!sectionKeys[sec]) sectionKeys[sec] = [];
        sectionKeys[sec].push(...keys);
      }
    }
  }

  const outDir = getOutDir();

  fs.writeFileSync(
    path.join(outDir, "shopline-order-sample.sanitized.json"),
    JSON.stringify(sanitized, null, 2),
    "utf-8"
  );
  console.log("[audit-shopline] 已寫入 shopline-order-sample.sanitized.json");

  const keysUnique = uniqueSortedKeys(allKeys);
  const mdLines = [
    "# SHOPLINE 訂單 API 欄位盤點（runtime audit）",
    "",
    "來源：`/orders?per_page=5` 最近 5 筆訂單，遮罩後盤點。",
    "",
    "## 1. Top-level 與 nested keys（合併所有訂單）",
    "",
    "```",
    ...keysUnique,
    "```",
    "",
    "## 2. 指定區塊 nested keys",
    "",
  ];

  for (const sec of sections) {
    const uniq = uniqueSortedKeys(sectionKeys[sec] || []);
    mdLines.push("### " + sec);
    mdLines.push(uniq.length > 0 ? "```\n" + uniq.join("\n") + "\n```" : "（本批訂單無此區塊）");
    mdLines.push("");
  }

  mdLines.push("---");
  mdLines.push("產出時間：" + new Date().toISOString());

  fs.writeFileSync(path.join(outDir, "shopline-order-keys.md"), mdLines.join("\n"), "utf-8");
  console.log("[audit-shopline] 已寫入 shopline-order-keys.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
