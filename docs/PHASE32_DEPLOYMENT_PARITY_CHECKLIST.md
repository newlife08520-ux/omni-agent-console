# Phase 32 部署一致性檢查表

本表用於確認 **source 與 live 行為一致**，避免「code 有改、部署沒生效」或 build-time 環境未正確打進前端。

---

## 1. 查單政策與來源意圖

| 檢查項 | 說明 | 驗證方式 |
|--------|------|----------|
| 官網偏好不殘留 | 下一句純手機或「不是官網的」時，不再帶 (官網) | 手動：官網 0910… → 0963… → 回覆無「官網」；verify:phase32 行為級通過 |
| 單一 source intent | fast path、tool path、LLM 規則皆用 resolveOrderSourceIntent / shouldPreferShoplineLookup（薄封裝） | 程式碼：order-fast-path、routes、order-service 皆用同一套 resolver |
| phone-only 不直接單筆 | 純手機未明確「全部／其他訂單」時，要商品+手機或摘要 | verify:phase32 行為級；手動送手機號檢查回覆型態 |
| local_only 單筆不定案 | 回覆帶「目前先看到 1 筆…」或補問 | verify:phase31/32；手動看回覆文案 |

---

## 2. 後端 Runtime

| 檢查項 | 說明 | 驗證方式 |
|--------|------|----------|
| 多視窗合併無早退 | lookupOrdersByPageAndPhone 大單量時走多視窗、合併去重 | verify:phase32 靜態 + log 含 page_phone_window、cumulative_unique_hits |
| CLEAR_ACTIVE_ORDER_KW | 含換另一筆、查另一張、不是這張、重查一下 | verify:phase32 靜態 |
| 商品格式 | 對客輸出經 formatProductLinesForCustomer，無 raw JSON | verify:phase32；手動看回覆內容 |

---

## 3. 前端 Build 與連線

| 檢查項 | 說明 | 驗證方式 |
|--------|------|----------|
| VITE_DISABLE_SSE | 需在 build 時注入，前端可讀 | 前端碼含 VITE_DISABLE_SSE / import.meta.env；verify:phase32 靜態 |
| SSE / Polling 可辨識 | 畫面上可區分即時 vs 輪詢 | 前端有「即時」「輪詢」或類似文案；chat 可觀測 |
| 關閉 SSE 時不建 EventSource | 避免 ERR_HTTP2 / EventSource 錯誤 | 前端邏輯：VITE_DISABLE_SSE=1 時不 new EventSource |

---

## 4. Bundle 與匯出

| 檢查項 | 說明 | 驗證方式 |
|--------|------|----------|
| export 預設 redact | 敏感鍵不原樣輸出 | verify:bundle-safety；檢視產出 JSON |
| PII 遮罩 | 電話、email 等遮罩 | export script 含 maskPII；產出無明文個資 |
| 打包說明 | README 註明 bundle 已做 secret/PII scrub | pack-ai-analysis-bundle.ps1 或 README 註記 |

---

## 5. Verify 鏈

| 指令 | 預期 |
|------|------|
| `npm run check:server` | 無 TypeScript 錯誤 |
| `npm run verify:phase31` | phase31 靜態與行為通過 |
| `npm run verify:phase32` | Tickets 1–10 靜態與行為通過 |
| `npm run verify:bundle-safety` | export 具 redact 與 PII mask |

---

## 6. 部署後建議人工抽測

- [ ] 官網 0910… → 換一支手機：回覆無「（官網）」  
- [ ] 我要查訂單 → 只給手機：不直接單筆定案，有補問或摘要  
- [ ] 換另一筆 / 重查一下：active context 清除，下一句重新查單  
- [ ] 查單回覆商品欄為人類可讀，無 `[{"code":` 等 JSON  
- [ ] 若關閉 SSE：畫面顯示輪詢、console 無 EventSource 錯誤  

完成上述檢查並通過 `npm run verify:phase32` 後，可視為 Phase 32 部署一致性達標。
