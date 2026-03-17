/**
 * SuperLanding / 一頁商店 訂單 payload 稽核
 * 依 CURSOR_ORDER_CX_WORLDCLASS_PLAN.md C 章 Step C1。
 * 目的：抓真實 API 欄位，遮罩後輸出，供欄位映射盤點用。
 *
 * 執行：npx tsx server/scripts/audit-superlanding-order-payload.ts
 * 產出：docs/runtime-audit/superlanding-order-sample.sanitized.json
 *       docs/runtime-audit/superlanding-order-keys.md
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

const SUPERLANDING_API_BASE = "https://api.super-landing.com";

function getOutDir(): string {
  const root = process.cwd();
  const outDir = path.join(root, "docs", "runtime-audit");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

/** 單筆 order 遮罩：姓名、電話、email、地址 */
function sanitizeOrder(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const nameKeys = ["recipient", "name", "buyer_name", "receiver_name", "customer_name"];
  const phoneKeys = ["mobile", "phone", "buyer_phone", "receiver_phone", "customer_phone"];
  const emailKeys = ["email", "buyer_email", "customer_email"];
  const addrKeys = ["address", "addr1", "addr2", "full_address", "shipping_address"];

  for (const [k, v] of Object.entries(o)) {
    if (nameKeys.includes(k) && typeof v === "string") {
      out[k] = maskName(v);
    } else if (phoneKeys.includes(k) && typeof v === "string") {
      out[k] = maskPhone(v);
    } else if (emailKeys.includes(k) && typeof v === "string") {
      out[k] = maskEmail(v);
    } else if (k === "address") {
      if (typeof v === "string") {
        try {
          const parsed = JSON.parse(v) as Record<string, unknown>;
          const masked: Record<string, unknown> = {};
          for (const [pk, pv] of Object.entries(parsed)) {
            if (typeof pv === "string" && (pk.includes("addr") || pk === "address1" || pk === "address2" || pk === "state" || pk === "city" || pk === "district")) {
              masked[pk] = maskAddress(pv);
            } else {
              masked[pk] = pv;
            }
          }
          out[k] = masked;
        } catch {
          out[k] = maskAddress(v);
        }
      } else {
        out[k] = v;
      }
    } else if (addrKeys.includes(k) && k !== "address" && typeof v === "string") {
      out[k] = maskAddress(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 從 raw order 收集 keys 並記錄 product_list / address / tracking_codes 型態 */
function analyzeOrder(o: Record<string, unknown>): { keys: string[]; productListType: string; addressType: string; trackingCodesKeys: string[] } {
  const keys = collectKeys(o);
  let productListType = "absent";
  if (o.product_list !== undefined) {
    if (Array.isArray(o.product_list)) productListType = "array";
    else if (typeof o.product_list === "string") {
      try {
        JSON.parse(o.product_list);
        productListType = "json_string";
      } catch {
        productListType = "string";
      }
    } else productListType = typeof o.product_list;
  }
  let addressType = "absent";
  if (o.address !== undefined) {
    if (typeof o.address === "string") {
      try {
        JSON.parse(o.address);
        addressType = "json_string";
      } catch {
        addressType = "string";
      }
    } else addressType = typeof o.address;
  }
  const trackingCodesKeys: string[] = [];
  if (Array.isArray(o.tracking_codes) && o.tracking_codes.length > 0) {
    const first = o.tracking_codes[0];
    if (first && typeof first === "object") trackingCodesKeys.push(...Object.keys(first as Record<string, unknown>));
  }
  return { keys, productListType, addressType, trackingCodesKeys };
}

async function main() {
  // 依賴 storage，故需載入 db（storage 會 init db）
  const { storage } = await import("../storage");
  const { getSuperLandingConfig } = await import("../superlanding");

  const config = getSuperLandingConfig(undefined);
  if (!config.merchantNo || !config.accessKey) {
    console.error("缺少 SuperLanding 設定：請在系統設定或品牌設定中填寫 superlanding_merchant_no 與 superlanding_access_key");
    process.exit(1);
  }

  const url = `${SUPERLANDING_API_BASE}/orders.json?${new URLSearchParams({
    merchant_no: config.merchantNo,
    access_key: config.accessKey,
    per_page: "5",
    page: "1",
  }).toString()}`;

  console.log("[audit-superlanding] 請求訂單…", url.replace(config.accessKey, "***"));
  const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) {
    console.error("[audit-superlanding] API 錯誤:", res.status, await res.text());
    process.exit(1);
  }

  const data = (await res.json()) as { orders?: unknown[]; current_page?: number; total_entries?: number };
  const rawOrders = Array.isArray(data.orders) ? data.orders : Array.isArray(data) ? data : [];
  console.log("[audit-superlanding] 取得", rawOrders.length, "筆訂單");

  const allKeys: string[] = [];
  const productListTypes: string[] = [];
  const addressTypes: string[] = [];
  const allTrackingCodesKeys: string[] = [];
  const sanitized: unknown[] = [];

  for (const raw of rawOrders) {
    const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    sanitized.push(sanitizeOrder(o));
    const { keys, productListType, addressType, trackingCodesKeys } = analyzeOrder(o);
    allKeys.push(...keys);
    productListTypes.push(productListType);
    addressTypes.push(addressType);
    allTrackingCodesKeys.push(...trackingCodesKeys);
  }

  const outDir = getOutDir();

  fs.writeFileSync(
    path.join(outDir, "superlanding-order-sample.sanitized.json"),
    JSON.stringify(sanitized, null, 2),
    "utf-8"
  );
  console.log("[audit-superlanding] 已寫入 superlanding-order-sample.sanitized.json");

  const keysUnique = uniqueSortedKeys(allKeys);
  const md = [
    "# SuperLanding 訂單 API 欄位盤點（runtime audit）",
    "",
    "來源：`orders.json?per_page=5&page=1` 最近 5 筆訂單，遮罩後盤點。",
    "",
    "## 1. Top-level 與 nested keys（合併所有訂單）",
    "",
    "```",
    keysUnique.join("\n"),
    "```",
    "",
    "## 2. product_list 型態",
    "",
    "本批訂單出現的型態：`" + [...new Set(productListTypes)].join("`, `") + "`",
    "",
    "## 3. address 型態",
    "",
    "本批訂單出現的型態：`" + [...new Set(addressTypes)].join("`, `") + "`",
    "",
    "## 4. tracking_codes 內每個 item 的 key",
    "",
    [...new Set(allTrackingCodesKeys)].length > 0 ? "`" + [...new Set(allTrackingCodesKeys)].join("`, `") + "`" : "（本批無 tracking_codes 或為空）",
    "",
    "---",
    "產出時間：" + new Date().toISOString(),
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "superlanding-order-keys.md"), md, "utf-8");
  console.log("[audit-superlanding] 已寫入 superlanding-order-keys.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
