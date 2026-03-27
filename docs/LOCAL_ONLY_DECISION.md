# `local_only`：決策規則（非僅用詞）

> **`data_coverage === "local_only"`** 代表結果來自 **本地索引／cache**，**不得**當成與 live API 完全等價的**最終定案**。

## 單筆

- **禁止**使用「幫您查到了／我查到這筆了」等 **定案語**；改為 **候選摘要**（`formatLocalOnlyCandidateSummary`）。
- `shouldRequireApiConfirmBeforeSingleClaim`：在 `local_only` 且 **1 筆** 時視為需 **live 確認**（fast path 與 tool path 共用 policy）。

## 多筆與「還有其他訂單／我有幾筆／官網…」

- 僅本地合併的列表 **可能漏掉尚未進索引的訂單**，或 **來源誤判**（例如索引裡只有一頁商店列，使用者問官網）。
- **行為**：`shouldBypassLocalPhoneIndex()` 為 true 時，`unifiedLookupByPhoneGlobal(..., bypassLocalIndex: true)` **不**走本地早退，強制 **live API**（與 Phase 29「展開多筆」路徑一致）。

## 觸發 `bypassLocalIndex` 的語意（摘要）

1. **全部／其他／幾筆** 等（`deriveOrderLookupIntent` → `phone_all_orders`）。
2. **官網／SHOPLINE** 等來源意圖（`resolveOrderSourceIntent` → `shopline`）。
3. **純手機句**（`detectLookupSourceIntent` 仍回 `unknown`、不繼承「官網＋手機」上一句，以符合 phase33），但若 **僅上一則使用者訊息**含官網關鍵字且 **該句未含另一支 09 手機**，仍視為要查官網 → **bypass**（見 `shouldBypassLocalPhoneIndex` 內補充規則）。

## 相關程式

- `server/order-lookup-policy.ts`：`deriveOrderLookupIntent`、`shouldBypassLocalPhoneIndex`、`shouldRequireApiConfirmBeforeSingleClaim`
- `server/order-service.ts`：`unifiedLookupByPhoneGlobal`
- `server/routes.ts`：`lookup_order_by_phone` tool
- `server/order-fast-path.ts`
