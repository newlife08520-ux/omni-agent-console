# 交付驗證報告（最新 HEAD 完整專案 ZIP + 可驗證證據）

- **Git HEAD**：`3fad49f`（見 `delivery/evidence/git-rev.txt`）
- **打包範圍**：目前 branch / HEAD 之完整專案（含 server/, shared/, docs/, package.json, tsconfig*, drizzle.config.ts, 所有 server/scripts/*，及 DB schema/migration 相關）

---

## 1. 哪些檔案新增

| 檔案 | 說明 |
|------|------|
| `server/order-index.ts` | Phase 2 本地訂單索引與查單快取：getOrderByOrderId、getOrdersByPhone、getOrderLookupCache、setOrderLookupCache、upsertOrderNormalized、normalizePhone |
| `server/scripts/sync-orders-normalized.ts` | 手動同步訂單至 orders_normalized（目前僅一頁商店） |
| `server/scripts/query-order-index-stats.ts` | 查詢 orders_normalized / order_lookup_cache 統計（供報告與驗證） |
| `docs/PHASE2_IMPLEMENTATION_REPORT.md` | Phase 2 實作報告（Schema、Sync、本地 index 優先） |
| `docs/SHOPLINE_INTEGRATION_TRUTH_REPORT.md` | Shopline 對接真相報告（四層狀態、執行證據、必答問題、總結表） |
| `docs/PHASE1_ACCEPTANCE_RESULTS.md` | Phase 1 驗收結果（若存在） |
| `docs/PHASE1_CLOSEOUT_REPORT.md` | Phase 1 關門報告（若存在） |
| `docs/PHASE1_STOP_THE_BLEED_REPORT.md` | Phase 1 止血報告（若存在） |

**DB schema / migration**：Phase 2 表結構由 `server/db.ts` 內 `migratePhase2OrderIndex()` 在 `initDatabase()` 時建立（orders_normalized、order_items_normalized、product_aliases、order_lookup_cache），無獨立 migration 檔案目錄；專案另有 `drizzle.config.ts`（指向 PostgreSQL，與目前 SQLite 執行時分離）。

---

## 2. 哪些函式新增

| 模組 | 函式名 | 說明 |
|------|--------|------|
| server/order-index.ts | `getOrderByOrderId(brandId, orderId)` | 依訂單號從 orders_normalized 取一筆 |
| server/order-index.ts | `getOrdersByPhone(brandId, phone)` | 依正規化手機從 orders_normalized 取多筆 |
| server/order-index.ts | `getOrderLookupCache(cacheKey)` | 讀查單快取並檢查 TTL |
| server/order-index.ts | `setOrderLookupCache(cacheKey, result, ttlSeconds?)` | 寫入查單快取 |
| server/order-index.ts | `normalizePhone(phone)` | 手機號正規化（僅數字） |
| server/order-index.ts | `upsertOrderNormalized(brandId, source, order)` | 寫入或更新一筆正規化訂單 |
| server/order-service.ts | `unifiedLookupById(...)` | 依訂單號：先 cache → orders_normalized → API；支援 preferSource（superlanding/shopline） |
| server/order-service.ts | `unifiedLookupByPhoneGlobal(...)` | 依手機：先 cache → orders_normalized → API；同上 |
| server/order-service.ts | `unifiedLookupByProductAndPhone(...)` | 依商品+手機查單，含 Shopline fallback |
| server/order-service.ts | `unifiedLookupByDateAndContact(...)` | 依日期+聯絡方式查單，含 Shopline |
| server/order-service.ts | `getShoplineConfig(brandId)` | 自 storage 取得品牌 Shopline 設定 |
| server/order-service.ts | `shouldPreferShoplineLookup(userMessage, recent?)` | 是否優先以 Shopline 查單（官網等關鍵字） |
| server/order-service.ts | `getUnifiedStatusLabel(status, source?)` | 依 source 回傳狀態文案（含 Shopline） |
| server/order-service.ts | `getPaymentInterpretationForAI(...)` | 付款與出貨解讀供 AI 使用 |

既有 `server/shopline.ts` 之 `lookupShoplineOrderById`、`lookupShoplineOrdersByPhone`、`fetchShoplineOrders` 等已存在，本次為在 order-service 內整合為 unified 流程並 write-back。

---

## 3. 哪些 API 路徑改了

- **查單流程改為走 unified**：後端查單不再直接只打單一來源，改為：
  - **訂單號查單**：`unifiedLookupById(slConfig, orderId, brandId, preferSource, allowCrossBrand)`（routes 內多處呼叫，例如 AI 工具、官網查單等）。
  - **手機查單**：`unifiedLookupByPhoneGlobal(slConfig, phone, brandId, preferSource)`。
- **路徑本身**：未新增或刪除 HTTP 路徑；同一查單 API 內部改為「先本地 index/cache，再 API，成功後 write-back」。
- **品牌設定**：已有 `shopline_store_domain`、`shopline_api_token` 之讀寫（routes/storage），未改路徑。

---

## 4. 哪些驗收案例通過

| 項目 | 結果 | 證據 |
|------|------|------|
| `npm run check:server` | 通過 | `delivery/evidence/check-server.txt`（無錯誤） |
| Phase 2 驗收腳本 | 10 通過、0 失敗 | `delivery/evidence/phase2-verify.txt` |
| sync 腳本執行 | 成功寫入一頁商店訂單 | `delivery/evidence/sync-output.txt`（Brand 1 寫入 5151 筆） |
| index stats 查詢 | 正常輸出 | `delivery/evidence/query-order-index-stats.txt`（orders_normalized 依 source 筆數、cache 總數、最近 10 筆 shopline） |
| 本地優先查單（code path） | 已實作 | order-service.ts 先 cache → getOrderByOrderId/getOrdersByPhone → 再 API |
| Shopline API 查單 + write-back（code path） | 已實作 | runShopline() 成功後 setOrderLookupCache + upsertOrderNormalized |
| Shopline 同步進 orders_normalized | 未實作 | sync 腳本僅一頁商店；見 SHOPLINE_INTEGRATION_TRUTH_REPORT.md |

---

## 5. 哪些還沒通過 / 待補

| 項目 | 說明 |
|------|------|
| Shopline 批量同步 | sync-orders-normalized.ts 未呼叫 Shopline，orders_normalized 無 source=shopline 來自同步；需擴充腳本。 |
| 訂單號 cache hit / normalized hit 實測 | 需在曾寫入過該 key 的環境再查一次，本包未附該情境之終端輸出。 |
| 訂單號／手機 API fallback + write-back 實測 | 需具 **SHOPLINE 憑證環境**：一次訂單號查 SHOPLINE、一次手機查 SHOPLINE，查完再跑一次 `npx tsx server/scripts/query-order-index-stats.ts` 證明 cache 與 orders_normalized 有 write-back。本包未在該環境執行，故無此輸出。 |

---

## 6. 實際執行輸出（證據檔案一覽）

| 內容 | 檔案 |
|------|------|
| Git 版本 | `delivery/evidence/git-rev.txt` |
| npm run check:server | `delivery/evidence/check-server.txt` |
| sync（npx tsx server/scripts/sync-orders-normalized.ts 1 1） | `delivery/evidence/sync-output.txt` |
| index stats（npx tsx server/scripts/query-order-index-stats.ts） | `delivery/evidence/query-order-index-stats.txt` |
| Phase 2 verify（npx tsx server/phase2-verify.ts） | `delivery/evidence/phase2-verify.txt` |
| 訂單號／手機查 SHOPLINE + 查完後 index stats | **未執行**（需 SHOPLINE 憑證環境，請於該環境補跑並附輸出） |

---

## 7. ZIP 內容說明

- **Omni-Agent-Console-3fad49f.zip**（或同名）為 **最新 HEAD 完整專案**，至少包含：
  - `server/`（含所有 `server/scripts/*`）
  - `shared/`
  - `docs/`
  - `package.json`
  - `tsconfig.json`、`tsconfig.server.json`
  - `drizzle.config.ts`
  - DB schema 透過 `server/db.ts` 內 migration 建立；無獨立 migrations 目錄時仍以 db.ts 為準。
- 建議排除：`node_modules/`、`.git/`、`dist/`、`*.db`、`client.zip`、大檔或暫存檔，以利傳輸。
- **delivery/** 一併打包進 ZIP：內含本驗證報告與 `evidence/` 下所有文字輸出，以便「可驗證證據」一併交付。

若需在 SHOPLINE 憑證環境補測，請執行：
1. 一次用訂單號查 SHOPLINE（觸發 API + write-back）
2. 一次用手機查 SHOPLINE
3. 再跑一次 `npx tsx server/scripts/query-order-index-stats.ts`，確認 order_lookup_cache 與 orders_normalized 出現 source=shopline 筆數後，將終端輸出附上即可。
