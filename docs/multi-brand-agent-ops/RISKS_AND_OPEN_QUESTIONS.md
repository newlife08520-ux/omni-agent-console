# 風險清單與未決議題

**本檔為誠實標註**：推測處會標「待確認」。

---

## 高風險

| ID | 風險 | 影響 | 緩解 |
|----|------|------|------|
| R1 | Tool 白名單過窄 | 該回查單時無 tool → 胡說或卡住 | 預設白名單寬鬆 + 監控 `tool_calls`；分品牌灰度 |
| R2 | Router 誤判 intent | 錯情境 prompt → 體驗崩 | Hybrid 保留現有規則優先；LLM router 僅低信心 |
| R3 | Dual read/write 不一致 | 後台改 A、執行讀 B | 短期 dual write；UI 明確顯示「生效版本」 |
| R4 | `settings.system_prompt` 過長 | 即使拆表，若仍整包注入則無效 | Phase 1 同步 **瘦身 global**（需營運同意） |
| R5 | Meta 與一對一 合併過急 | 兩條產品線互相拖慢 | 分里程碑；Meta 沿用 `meta_page_settings` 先行 |

---

## 中風險

| ID | 風險 | 說明 |
|----|------|------|
| M1 | `ai_logs` 欄位膨脹 | JSON 欄位過大影響 SQLite 效能 | 大 trace 改存檔案或截斷摘要 |
| M2 | 版本表與 UI 複雜度 | 內部 10 品牌仍可能被搞混 | Publish 前 diff 摘要、僅超管可 rollback |
| M3 | 知識檔無情境標籤 | 僅靠「品牌內全掃」→ 隔離不完整 | Phase 1 先 **metadata 欄位**（JSON tags）或分資料夾約定 |

---

## 待確認（需與業務對齊）

1. 四情境是否 **足夠**涵蓋現有 `PrimaryIntent`（例如 `complaint` 併入 AFTER_SALES 或獨立？）。
2. **Instagram** 是否納入 Phase 1 channel binding（schema 已多處 Messenger/LINE）。
3. 是否允許 **同一品牌** 多個 `Agent Profile` 同時上線，或先 **單 Profile + 四情境** 即可。
4. 現有 **Shopline / SuperLanding** 憑證是否每品牌獨立（schema 上已是 brand 欄位）— **技術上已支援**，營運流程待確認。

---

## Breaking change 警戒線

以下若做，需獨立評審：

- 刪除或重命名 `ai_logs` 既有欄位。
- 改變 `contacts` / `messages` 核心 schema。
- 移除 `orderLookupTools` 中任一 tool 名稱（破壞歷史 log / 微調資料）。
