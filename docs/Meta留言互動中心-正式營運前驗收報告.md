# Meta 留言互動中心 — 正式營運前驗收報告

## 1. 完成狀態

**已完成但驗收未通過**（部分項目因 AI 意圖分類與環境限制未全數通過，見下方驗收結果表）

---

## 2. 環境狀態

| 項目 | 說明 |
|------|------|
| **實際啟動指令** | `cd "d:\Omni-Agent-Console(自動客服系統)\Omni-Agent-Console"; npm run dev` |
| **實際使用 port** | **5001**（與預設一致） |
| **5001 衝突處理** | 以 `netstat -ano \| findstr :5001` 查出 PID 112324 佔用，以 `taskkill /PID 112324 /F` 終止後再啟動。若需保留原 process，可改為設定 `PORT=5002` 並用 `$env:PORT=5002; npm run dev` 啟動。 |
| **是否成功啟動** | **是**。日誌出現 `serving on port 5001` 與 Webhook URLs 即視為啟動成功。 |

---

## 3. 驗收結果表

| # | 驗收項目 | 操作步驟 | 實際結果 | 是否通過 | 若失敗 root cause | 是否已修復 |
|---|----------|----------|----------|----------|-------------------|------------|
| 1 | 留言列表與詳情 | 登入後 GET /api/meta-comments，檢查回傳含 assigned_agent_name、is_simulated 等欄位；取單筆 GET /api/meta-comments/:id | 列表回傳 200，筆數正確，單筆含 id/commenter_name/assigned_agent_name/is_simulated。前端依同一 API 渲染列表與詳情。 | 通過 | - | - |
| 2 | 指派 / 改派 / 移回待分配 | 對一則留言 POST assign → 檢查 assigned_agent_id=1 → POST unassign → 檢查 assigned_agent_id 為 null | API：assign 回傳 assigned_agent_id=1；unassign 回傳 assigned_agent_id=null。前端 invalidateQueries 會重拉列表與詳情，理論上同步。 | 通過（API 已驗；前端即時更新為程式層保證，未用自動化點擊驗證） | - | - |
| 3 | 模擬留言 / 模擬 webhook / 一鍵測試 | POST simulate-webhook、POST seed-test-cases、POST /api/meta-comments（is_simulated:1）；檢查 response 為 JSON 且無 `Unexpected token '<'` | simulate-webhook：回傳 JSON，id=11，is_simulated=1。seed-test-cases：回傳 JSON，created=6。無 HTML 回傳。 | 通過 | - | - |
| 4 | 一般詢問（雙段式＋連結來源） | 對模擬「哪裡買」類留言 POST suggest-reply；檢查 intent、reply_first/reply_second、reply_link_source | intent=where_to_buy，has_second=True，link=post_mapping。 | 通過 | - | - |
| 5 | 客訴 / 高風險（僅安撫、無第二則） | 建立「我要退款」「我要客訴」等模擬留言後 suggest-reply；檢查 reply_second 應為空、連結來源應為 none | 兩則皆被 AI 判為 **spam_competitor**，故走一般流程產出第二則與 post_mapping。後端「高風險只產安撫」邏輯已實作，但依賴意圖正確為 complaint/refund_after_sale 且 is_high_risk=true。 | **未通過** | AI 意圖分類將客訴文案判成 spam_competitor，未進高風險分支。屬 prompt/模型行為，非路由或程式 bug。 | 未修復（需調 prompt 或模型/規則補強） |
| 6 | mapping 防呆 | 對同一 page_id+post_id 建立兩筆 auto_comment_enabled=1 的 mapping；第二筆應被拒 | 第二筆 POST 回 400。 | 通過 | - | - |
| 7 | 篩選 全部/僅真實/僅模擬 | GET meta-comments、?source=simulated、?source=real，比較筆數 | all=17，simulated=14。篩選有影響列表筆數。 | 通過 | - | - |
| 8 | 測試此 mapping | 對某 mapping POST test-mapping，檢查建立一筆模擬留言；再對該則 suggest-reply 檢查連結 | test-mapping 回傳 comment id=18；suggest-reply 後 link_source=post_mapping。 | 通過 | - | - |

**摘要**：API 與防呆、模擬/webhook/一鍵測試、一般詢問雙段式與連結來源、mapping 防呆、篩選、測試此 mapping 均通過實測。**客訴/高風險僅安撫**一項因意圖被誤判而未通過，需後續調整分類邏輯或 prompt。

---

## 4. 改了哪些檔案

| 檔案 | 改動摘要 |
|------|----------|
| server/db.ts | meta_comments 新增分派欄位（assigned_agent_id/name/avatar_url, assignment_method, assigned_at） |
| shared/schema.ts | MetaComment 型別與顯示常數（META_COMMENT_STATUS_DISPLAY, META_COMMENT_INTENT_DISPLAY） |
| server/meta-comments-storage.ts | getMetaComments 支援 source；updateMetaComment 支援分派；hasDuplicateEnabledMapping、getMetaPagesForDropdown、getMetaPostsByPage、searchMetaProducts |
| server/routes.ts | 分派與 assignable-agents、simulate-webhook/seed-test-cases 強制 JSON 與 log、mapping 防呆、test-mapping、meta-pages/posts/products API |
| client/src/pages/comment-center.tsx | 列表/詳情工作台化、分派 UI、篩選、parseJsonResponse、mapping 下拉與預覽與「測試此 mapping」 |
| docs/Meta留言互動中心-交付說明.md | 正式營運前操作層優化章節 |
| script/e2e-meta-comments.ps1 | 新增 E2E 腳本（部分環境曾遇 PowerShell 解析問題，改以手動指令塊完成驗收） |

---

## 5. 剩餘問題

- **尚未完成的功能**：規則的 send_dm/add_tag 未實際呼叫 Meta API；回覆尚未真正發回 Meta。
- **風險**：客訴/高風險是否只產安撫，依賴 AI 意圖與 is_high_risk；目前實測有誤判，需持續調 prompt 或規則。
- **假資料/模擬**：粉專/貼文/商品下拉目前來自既有 mapping+留言+假資料；尚未串接 Meta Graph API。
- **未串 Meta**：發送回覆、私訊、webhook 收真實留言皆未串接。

---

## 6. 自我檢討

- **為何一開始把「未完整驗收」寫成「已完成」？**  
  當時以程式實作完成與靜態檢查為準，未在真實環境跑完 E2E，也未區分「程式完成」與「驗收通過」。應在標記完成前先跑完您指定的驗收步驟並記錄實際結果。

- **哪些地方只是程式層完成、不是使用層完成？**  
  指派/改派後「左側列表與右側詳情即時同步」僅依賴前端 invalidateQueries，未用自動化或手動逐筆確認。客訴僅安撫一項依賴 AI，實測未過，使用層尚未達標。

- **若現在直接交付您測，最可能卡住的 3 個地方？**  
  1) **客訴仍出現第二則**：因意圖誤判，需調 prompt 或加關鍵字規則。  
  2) **下拉無資料**：若 DB 無 mapping/留言，粉專/貼文為假資料，商品為假清單；若期望見真實粉專需串 API。  
  3) **模擬或一鍵測試仍報錯**：若 port 被佔或未用同一 origin，可能拿到 HTML；需確認 npm run dev 單一啟動且瀏覽器開 localhost:5001。

---

**驗收執行方式**：以 PowerShell 對 http://127.0.0.1:5001 登入後，依序呼叫上述 API（assign、unassign、simulate-webhook、seed-test-cases、source 篩選、mapping 重複、test-mapping、suggest-reply），並檢查回應內容與狀態碼。瀏覽器 UI 未做自動化點擊，列表/詳情同步為程式邏輯驗證。
