# Debug View 需求（對話頁）

**目標讀者**：內部客服／營運／工程。**非**終端消費者。

---

## 1. 入口

- 在 `chat.tsx`（或側欄）新增 **「本則 AI 除錯」** 抽屜，僅具權限使用者可見（可先 `super_admin` / `marketing_manager`）。

---

## 2. 必顯欄位（MVP）

| 欄位 | 說明 |
|------|------|
| 時間 | 該則 AI 訊息 `created_at` |
| Scenario | ORDER_LOOKUP / … |
| Router | rule vs llm + confidence |
| Plan mode | `ReplyPlanMode` |
| Tools available | 列表 |
| Tools called | 列表 + 每個簡短結果（found / error） |
| Reply source | template / tool / llm / handoff |
| Handoff | 是否觸發 + reason |
| Config version | id + published_at |
| Prompt sections | 標題 + 字數（不預設展開全文） |

---

## 3. 次級（Phase 3.1）

- Policy hits（查單政策哪條命中）  
- Risk hits  
- Scenario 切換歷史（本對話最近 5 次）

---

## 4. 非目標

- 不在此頁做 **編輯** Agent 設定（導向 Publish Center）。  
- 不顯示完整 OpenAI request（太大）；提供「下載 masked 摘要」即可。

---

## 5. 技術

- 資料來自 `GET` messages 附帶 `ai_log_id` 或獨立 `GET /api/ai-logs?message_id=`。  
- 若 `trace_json` 為空（舊資料）：顯示「僅舊版欄位」fallback。
