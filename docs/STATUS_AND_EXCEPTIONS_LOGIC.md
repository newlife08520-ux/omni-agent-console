# 主狀態與例外列表邏輯說明

本文件明確說明：① 例外列表中「已完成」案件的顯示邏輯；② completed / auto_replied 的推導條件；③ 三種情境下 completed、hidden_completed、to_human 的進入條件，以及與你原則的對齊情況。

---

## 一、例外列表中「已完成」案件是否還看得到？

**不會。**（已依需求修正）

- 例外列表（status = exceptions）**不包含** completed / human_replied / auto_replied。
- 條件為兩段 AND，其中第二段為：  
  `(main_status NOT IN ('completed','human_replied','auto_replied') OR 有 reply_error/hide_error OR is_hidden=1)`  
  **已不再**使用「5 分鐘內 replied_at」讓已完成出現在例外列表。
- 結論：**例外優先時，主列表不顯示已完成**；要看已完成請勾選「顯示已完成」展開下方「已完成（最近 50 筆）」區塊，或切換篩選為「全部」。詳見 `docs/INBOX_DISPLAY_RULES.md`。

---

## 二、客訴／敏感／建議隱藏類：是否「只要公開回覆成功就可能變 completed」？

**要分兩種情況：粉專有開「自動隱藏敏感」 vs 沒開。**

### 2-1. 目前 completed / auto_replied 的推導來源

- **computeMainStatus()**（依 DB 欄位計算）**不會**回傳字串 `"completed"`，只會回傳：  
  `failed` / `partial_success` / `hidden_completed` / `hidden` / `human_replied` / `auto_replied` / `to_human` / `routed_line` / `pending_send` / `unhandled`。
- 所以流程上「已完成」在畫面上通常對應的是：
  - **auto_replied**：有 `replied_at`、沒有錯誤、未隱藏時，由 computeMainStatus 算出。
  - **human_replied**：`is_human_handled=1` 且 `replied_at` 有值。
  - **completed**：目前僅在**灰區標記已檢視**時由 API 直接寫入 `main_status = 'completed'`。

因此，你問的「只要公開回覆成功就可能直接變成 completed」在程式裡實際是：  
**回覆成功且未隱藏時，會變成 `auto_replied`**（前端/報表常把 completed / human_replied / auto_replied 都視為「已完成」）。

### 2-2. 客訴／敏感／建議隱藏類的實際行為

- **有開「自動隱藏敏感」**（`autoHideSensitive = 1`）時：
  - 客訴／敏感／hide_and_route 會走 **敏感 SOP（step 4）**：先安撫回覆（若有），**再一定會執行隱藏**。
  - 隱藏成功後：`is_hidden = 1`，computeMainStatus 會給 **`hidden`**（有回覆）或 **`hidden_completed`**（無回覆），**不會**給 `auto_replied`。
  - 若隱藏失敗：會寫入 `hide_error`，computeMainStatus 會給 **`partial_success` 或 `failed`**，一樣不會變成「只因為回覆成功就 completed/auto_replied」。
- **沒開「自動隱藏敏感」**（`autoHideSensitive = 0`）時：
  - 不會進敏感 SOP，敏感件會落到**一般回覆（step 6）**：只做公開回覆。
  - 回覆成功後就會被算成 **`auto_replied`**，**即使該案是客訴／敏感／建議隱藏**，也不會執行隱藏，等於「只回覆就當完成」。

所以：  
- **有開自動隱藏敏感**：符合你的原則——稍微敏感的會優先隱藏，不會「只因為回覆成功就直接完成」。  
- **沒開自動隱藏敏感**：**不符合**——客訴／敏感件可能只回覆、不隱藏，就變成 auto_replied（在畫面上視為已完成）。

---

## 三、三種情境的 completed / hidden_completed / to_human 進入條件

以下用「主狀態」表示實際 DB 的 main_status；「已完成」表示畫面上視為完成的那幾種狀態（completed / human_replied / auto_replied）。

### 3-1. 一般詢問

| 條件 | 主狀態 | 說明 |
|------|--------|------|
| 有回覆、無錯誤、未隱藏 | **auto_replied** | computeMainStatus：replied_at 有值、無 reply_error/hide_error、is_hidden≠1 → auto_replied |
| 人工處理且已回覆 | **human_replied** | is_human_handled=1 且 replied_at 有值 |

- **進入 completed**：僅灰區「標記已檢視」會直接寫 `completed`；一般詢問不會由流程寫入 `completed`，而是 **auto_replied**，在例外/報表上被當成「已完成」。
- **進入 to_human**：一般詢問若被標記 is_human_handled=1 且尚未回覆，會是 to_human。

**是否符合「回完就完成」**：是。回覆成功、無錯誤、未隱藏 → auto_replied，並在 5 分鐘後自例外列表消失。

---

### 3-2. 純負評／亂入（direct_hide）

| 條件 | 主狀態 | 說明 |
|------|--------|------|
| 只隱藏、未回覆、隱藏成功 | **hidden_completed** | computeMainStatus：is_hidden=1 且無 reply 內容 → hidden_completed |
| 隱藏失敗 | **failed**（或 partial_success） | 有 hide_error |

- **進入 completed / auto_replied**：不會。direct_hide 流程不寫回覆、不導 LINE，只執行隱藏。
- **進入 to_human**：不會。direct_hide 不設 is_human_handled。

**是否符合「隱藏就完成」**：是。隱藏成功 → hidden_completed；5 分鐘後也會從例外列表消失（hidden_completed 不在「未完成」那幾類，且無錯誤時不會被第一段例外條件留住，第二段若無 replied_at 或已過 5 分鐘就不會再出現）。

---

### 3-3. 客訴／訂單／售後／敏感件（hide_and_route 或 guardrail 敏感）

| 條件 | 主狀態 | 說明 |
|------|--------|------|
| 有開自動隱藏敏感：回覆+隱藏都成功 | **hidden** | is_hidden=1、有回覆內容 → hidden（流程並設 is_human_handled=1） |
| 有開自動隱藏敏感：只隱藏、未回覆，隱藏成功 | **hidden_completed** | 同上邏輯，無回覆內容則 hidden_completed |
| 有開自動隱藏敏感：回覆成功、隱藏失敗 | **partial_success** 或 **failed** | 有 hide_error，不會變成 auto_replied |
| **沒開**自動隱藏敏感：只做一般回覆 | **auto_replied** | 敏感件仍只回覆、不隱藏，被算成「已完成」 |

- **進入 completed / auto_replied**：  
  - 有開自動隱藏敏感：**不會**只因為回覆成功就完成；會是 hidden / hidden_completed 或 partial_success / failed。  
  - 沒開自動隱藏敏感：**會**變成 auto_replied（不符合「該隱藏未隱藏應留在例外」）。
- **進入 to_human**：敏感 SOP 會設 is_human_handled=1；若後續有「待人工」邏輯或列表篩選，會出現在 to_human／待人工視圖。

**是否符合「不該只因回覆成功就直接完成；該隱藏未隱藏應還是例外」**：  
- **有開自動隱藏敏感**：符合。  
- **沒開自動隱藏敏感**：不符合；目前會變成 auto_replied 並從例外列表在 5 分鐘後消失。

---

## 四、總結對齊情況

| 情境 | 預期 | 目前系統（有開自動隱藏敏感） | 目前系統（沒開自動隱藏敏感） |
|------|------|------------------------------|------------------------------|
| 一般詢問 | 回完就完成 | auto_replied，5 分鐘後自例外消失 ✓ | 同左 ✓ |
| 純負評／亂入 | 隱藏就完成 | hidden_completed ✓ | 同左 ✓ |
| 客訴／敏感 | 不該只回覆就完成；該隱藏未隱藏應留例外 | hidden / hidden_completed 或 partial_success / failed，不會只回覆就完成 ✓ | 會只回覆→auto_replied，不隱藏 ✗ |

**建議**：若要嚴格符合「客訴／敏感：該隱藏未隱藏就不算完成」，可考慮在程式加一層防呆：當 `ai_suggest_hide=1` 或 `priority='urgent'`（或 matched_rule_bucket=hide_and_route）且 **未**執行隱藏（is_hidden≠1）時，**不要**給 auto_replied，改給 routed_line 或 to_human，讓該案繼續留在例外列表。這樣即使粉專關閉自動隱藏敏感，敏感件也不會「只回覆就當完成」。
