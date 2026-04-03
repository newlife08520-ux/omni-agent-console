# 多品牌驗證矩陣

**狀態**：Phase 0 文件；**實際跑測**待 Phase 2+ 實作後填寫各 `*_TEST_RESULTS.md`。

---

## 1. 代表品牌（範例，請替換為真實品牌 id／名稱）

| 代號 | 類型 | 選取條件 |
|------|------|-----------|
| B1 | 查單密集 | 對話中 order_lookup 比例高、SuperLanding 為主 |
| B2 | 售後密集 | 退換貨、客訴句多 |
| B3 | 導購／商品諮詢 | product_consult、價格連結多 |

---

## 2. 意圖 × 品牌矩陣（每格至少 3 句測試句）

|  | ORDER_LOOKUP | AFTER_SALES | PRODUCT_CONSULT | GENERAL |
|--|--------------|-------------|-----------------|---------|
| B1 | ✓ | ✓ | ✓ | ✓ |
| B2 | ✓ | ✓ | ✓ | ✓ |
| B3 | ✓ | ✓ | ✓ | ✓ |

---

## 3. 驗證項目（每格勾選）

- [ ] Router intent 正確（rule/llm 標籤合理）  
- [ ] Scenario 與 Plan 不衝突（無雙主線）  
- [ ] Tools available ⊆ 預期白名單；未呼叫禁用 tool  
- [ ] Prompt 字數 vs 舊版基線（預期 **下降**於 ORDER_LOOKUP / AFTER_SALES）  
- [ ] Brand override 生效（改 draft → publish 後可觀察）  
- [ ] Publish / rollback 可運作  
- [ ] 舊 flag off 時與現行行為一致（迴歸）

---

## 4. 執行方式建議

- **手動**：內部測試 LINE/Messenger 測試號。  
- **半自動**：`sandbox.routes` 或新增 `scripts/agent-ops-fixture-run.ts`（Phase 2 後）。  
- **自動**：精選 12 則 golden utterances 做 unit/integration（不要求全覆蓋）。

---

## 5. 報告回填

結果寫入：`ROUTER_TEST_RESULTS.md`、`TOOL_ISOLATION_TEST_RESULTS.md`、`BRAND_OVERRIDE_TEST_RESULTS.md`、`REGRESSION_TEST_RESULTS.md`。
