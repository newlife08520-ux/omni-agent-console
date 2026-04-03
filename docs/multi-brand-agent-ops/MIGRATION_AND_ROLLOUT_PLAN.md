# 遷移與上線計畫（Migration & Rollout）

**前提**：每階段可回滾；**舊設定不刪**，以 backfill + 讀取優先序完成切換。

---

## 1. 階段總覽

| Phase | 內容 | 可回滾方式 |
|-------|------|------------|
| 0 | 文件盤點與審核 | N/A |
| 1 | 配置模型 + DB migration + 讀取 shim | 關閉 flag，回退到現有 `assembleEnrichedSystemPrompt` 路徑 |
| 2 | Hybrid router + scenario prompt + tool whitelist | Per-brand flag；關閉後回到「全集 tools + 現有 plan」 |
| 3 | Trace 欄位 + API + 最小 debug UI | 新欄位可 NULL；UI 隱藏 |
| 4 | Lite Admin 頁面擴充 | Feature flag |

---

## 2. Feature flag 建議（需新增）

現有 `order-feature-flags.ts` 為 **環境層**。建議新增 **品牌層**（擇一實作）：

- `brands` 新增欄位 `agent_ops_config_version_id` + `use_agent_ops_v2`（INTEGER 0/1），或
- `settings` key：`agent_ops_rollout_brand_ids` = JSON array，或
- 新表 `brand_feature_flags`（brand_id, key, value）。

**試跑**：僅 1 個 `brand_id` 為 on，其餘 off。

---

## 3. 資料遷移（Phase 1）

1. **建立** `agent_config_versions`（或等價）見 `MULTI_BRAND_SCHEMA_DIFF.md`。
2. **Backfill**：從現有 `brands.system_prompt` + `settings.system_prompt` 產出 **published v1**（內容可粗切：global 與 brand 分層寫入 JSON blob）。
3. **Dual read**：  
   - `use_agent_ops_v2=0` → 現有 `buildGlobalPolicyPrompt` + `buildBrandPersonaPrompt` 不變。  
   - `=1` → `ResolvedAgentConfig` from version row。
4. **Dual write（可選、短期）**：後台儲存時寫舊欄位 + 新 draft（降低營運錯亂）。

---

## 4. 程式切換點（高風險列表）

| 切換點 | 檔案 | 風險 |
|--------|------|------|
| Prompt 組裝 | `prompt-builder.ts` | 行為差異最大 |
| Tool 列表 | `ai-reply.service.ts` | 模型行為變化、需回歸查單 |
| 意圖 | `conversation-state-resolver.ts` / 新 router | 誤分類 |
| Log | `storage.createAiLog` | Schema 變更需 migration |

---

## 5. 驗證節點（每階段必跑）

- `npm run check:server` + `npm run build`
- 既有 phase-verify（依團隊慣例）
- `MULTI_BRAND_TEST_MATRIX.md` 中 **3 品牌 × 4 情境** 手動或腳本驗收（Phase 2 後）

---

## 6. 回滾劇本（簡版）

1. 將試跑品牌 `use_agent_ops_v2=0`。
2. 若 DB migration 已執行：不必 rollback migration（向前相容），僅關閉讀取路徑。
3. 若曾改 `settings.system_prompt`：還原備份或 git 還原。

---

## 7. 誠實限制

- **無 staging 專用 DB 時**，試跑風險高；建議複製 `omnichannel.db` 或使用獨立環境。
- **長期** global prompt 若仍過長，僅加表無法解決，需 **營運配合** 把 SOP 搬到 Scenario 與文件。
