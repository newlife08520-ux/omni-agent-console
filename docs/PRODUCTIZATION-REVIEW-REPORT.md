# Omni-Agent-Console 產品化整理 — Review / Spec-check 報告

> **本文件為第一步：僅審查與規劃，不包含任何程式實作。**  
> 完成日期：依審查執行日。  
> 目的：盤點現況、資訊架構、耦合、命名、文件一致性，產出 P0/P1/P2 改造順序與修改計畫。

---

## 一、目前一級導航與二級導航的實際結構

### 1.1 前端路由（App.tsx）

| 路徑 | 元件 | 權限 |
|------|------|------|
| `/` | ChatPage | 全角色 |
| `/comment-center` | CommentCenterPage | 全角色 |
| `/settings` | SettingsPage | super_admin, marketing_manager |
| `/knowledge` | KnowledgePage | super_admin, marketing_manager |
| `/team` | TeamPage | super_admin |
| `/analytics` | AnalyticsPage | super_admin, marketing_manager |
| `/performance` | PerformancePage | 全角色 |
| 其他 | NotFound | - |

**結論：**
- **無 `/workspace/*` 前綴**，全部為一層扁平路由。
- **無真正二級路由**：comment-center、settings、knowledge、performance 均以 **同頁內 Tabs + hash** 模擬多個「子頁」。

### 1.2 Sidebar 選單（app-sidebar.tsx）

`allMenuItems` 定義：

| 選單標題 | url | 說明 |
|----------|-----|------|
| 即時客服 | `/` | 對話與案件處理 |
| AI 自動處理監控台 | `/comment-center` | 預設只看例外，監控 AI 處理狀態 |
| **粉專與 LINE 設定** | **`/comment-center#page-settings`** | 粉專導向哪個 LINE 一眼看清 |
| 客服績效 | `/performance` | 個人與團隊表現 |
| AI 與知識庫 | `/knowledge` | AI 設定與知識管理 |
| 數據戰情室 | `/analytics` | 數據與報表 |
| 團隊管理 | `/team` | 成員與排班 |
| 系統設定 | `/settings` | 全域設定 |

**結論：**
- **「粉專與 LINE 設定」與「AI 自動處理監控台」指向同一頁**，僅 hash 不同（`#page-settings` vs 預設），屬「同一頁不同 tab 偽裝成不同主模組」。
- Sidebar 同時承擔：**導航**、**品牌選擇**、**客服「我的工作」摘要**（我的/待回/緊急/追蹤/逾時/結案）、**主管「今日戰情」摘要**（今日新進/待分配/緊急/逾時/結案/VIP）、**團隊狀況列表**、**主管快捷**（待分配/逾時未回/全部案件）、**渠道列表**。導航與 dashboard 混在一起，資訊密度高。

### 1.3 各頁「偽二級」結構（hash / tab）

| 頁面 | 識別方式 | 實際子區 |
|------|----------|----------|
| **comment-center** | `activeMainTab` + `window.location.hash` | inbox, rules, mapping, page-settings, risk-rules, simulate（6 個 TabsContent） |
| **settings** | 無 hash，單頁多區塊 | 品牌工作區管理、渠道管理、系統設定區（API 金鑰/外觀/迎賓/轉人工/標籤/排班/派案規則/一頁商店/SHOPLINE）、TagShortcuts、Schedule、AssignmentRules 等全部垂直堆疊 |
| **knowledge** | Tabs | prompt, images, marketing, sandbox（4 個 tab） |
| **performance** | Tabs | 客服視角 / 主管視角 / 經理戰情（3 個 tab） |
| **chat** | `viewMode` + hash `#view=my|pending|...` | 左側列表篩選（全部/我的/待回/緊急/追蹤/待分配/逾時），無獨立 route |

**結論：**
- 一級導航僅 7 條 route；「二級」全是同頁 tab 或 hash，**沒有獨立 route、沒有獨立頁面標題、無法直接深連結到子功能**（除 hash 外）。
- 主管與客服在 **同一套 route** 下，僅依 `userRole` 顯示/隱藏選單與區塊，**首頁與工作台未分層**（皆為 `/`）。

---

## 二、哪些頁面同時承擔太多責任

### 2.1 comment-center.tsx（約 2,355 行）

**單頁內含 6 大塊（Tabs）：**

1. **留言收件匣 (inbox)**  
   戰情摘要、狀態篩選、留言列表、詳情/回覆/隱藏/導 LINE、已完成區、抽查/灰區抽查。

2. **自動規則 (rules)**  
   規則類型、模板選擇、標籤、規則列表 CRUD。

3. **模板與商品對應 (mapping)**  
   貼文 mapping、商品、導向流程、品牌/粉專/貼文/商品選擇。

4. **粉專與 LINE 導向設定 (page-settings)**  
   粉專↔LINE、一般/售後 LINE、敏感件、自動回覆/隱藏/導 LINE 開關。

5. **留言風險與導流規則 (risk-rules)**  
   五桶規則、規則測試器、規則 CRUD、篩選、批次新增。

6. **內測模擬 (simulate)**  
   模擬 webhook、種子資料、測試 mapping。

**問題：**
- 營運監控（收件匣、例外、灰區）、規則設定、模板管理、渠道綁定、導流設定、內部測試 **全部擠在同一頁**，違反「每頁一個主任務」。
- 「粉專與 LINE 設定」在 sidebar 是獨立選單項，但實際是 comment-center 的一個 tab，**命名與心智模型不一致**。

### 2.2 settings.tsx（約 1,292 行）

**同一頁內含：**

- **BrandChannelManager**（品牌工作區管理 + 渠道管理 + 連結 Facebook）
- 系統名稱 / Logo（品牌外觀）
- LINE 迎賓與快捷按鈕
- 轉人工關鍵字
- 標籤快捷（TagShortcutsManager）
- 客服排班（ScheduleForm）
- 派案規則（AssignmentRulesForm）
- 一頁商店 / SHOPLINE 全域設定
- （super_admin）安全測試模式、API 金鑰與連線測試

**問題：**
- **品牌/渠道/粉專綁定** 屬於「渠道與品牌管理」營運型設定，不應與「系統全域設定」混在一起。
- **派案規則、排班** 更貼近「團隊與派案」模組，與系統金鑰、外觀並列易造成設定分散。
- 文案寫「管理品牌工作區、渠道連線、API 金鑰與各項系統設定」，等於承認本頁是混合型設定桶。

### 2.3 chat.tsx（約 2,240 行）

**單頁內含：**

- 左：聯絡人/案件列表（多 viewMode：全部/我的/待回/緊急/追蹤/待分配/逾時）
- 中：對話區、訊息列表、回覆輸入、AI 建議
- 右：案件詳情、狀態/標籤/訂單/備註、轉派、訂單查詢、商品查詢、標籤快捷、知識庫觸發等

**問題：**
- 高頻（選案、看訊息、回覆、標記、轉派）與低頻（訂單查詢、商品查詢、進階搜尋、標籤維護）**同層展示**，主流程與工具未分層。
- 右側面板責任過多，未明確區分「上下文/操作」與「進階工具」。
- 主管與客服用同一 layout，僅資料篩選不同，**視角差異化不足**。

### 2.4 knowledge.tsx（約 1,019 行）

**4 個 tab：**

- prompt：全域/品牌 system prompt、預覽
- images：圖片素材上傳/編輯/關鍵字
- marketing：導購規則（關鍵字/話術/連結）
- sandbox：AI 測試對話

**問題：**
- 知識庫、素材、導購規則、AI 測試 **平鋪在同一層**，未分區為「AI 與 Prompt」「產品知識」「素材」「測試」，容易變成第二個雜物間。

### 2.5 analytics.tsx（約 568 行）

**單頁：**

- 日期區間選擇
- KPI、圖表、健康警報、轉人工原因、AI insights、關鍵字、風險與建議等 **一次全部呈現**

**問題：**
- 沒有「先給答案再給細節」的兩層結構；主管無法在 10 秒內先看「今天哪裡出問題」。

### 2.6 team.tsx（約 334 行）

**目前：**

- 成員列表、新增/編輯/刪除、頭像上傳、角色
- **沒有**：排班、最大負載、可分配條件、技能標籤、派案規則整合（派案規則在 settings）

**問題：**
- 團隊營運（排班、負載、派案）與「帳號管理」混在不同頁，**未整合成單一「團隊與派案」模組**。

---

## 三、哪些設定應該從工作頁移出

| 設定類型 | 目前位置 | 建議歸屬 |
|----------|----------|----------|
| 品牌 CRUD、渠道 CRUD、粉專/LINE 綁定、連結 Facebook | settings（BrandChannelManager） | 渠道與品牌管理（獨立模組） |
| 粉專與 LINE 導向、渠道導流 | comment-center#page-settings | 渠道與品牌管理 |
| 派案規則、排班 | settings | 團隊與派案（與 team 整合或獨立二級頁） |
| LINE 迎賓、轉人工關鍵字 | settings | 可保留系統設定或移至「渠道/品牌」依品牌設定 |
| 標籤快捷 | settings | 可保留（對話相關）或收斂到 chat 右側進階區 |
| 留言風險規則、自動規則、模板與對應 | comment-center 多 tab | 留言自動化「規則/設定」子頁，與收件匣監控分離 |
| 內測模擬、種子資料 | comment-center#simulate | 獨立「內測」或開發用頁，不與正式收件匣同層 |

---

## 四、哪些頁面只是同一頁不同 hash / tab 偽裝成不同模組

- **「粉專與 LINE 設定」**：sidebar 獨立選單，實際為 `/comment-center#page-settings`，與「AI 自動處理監控台」同一頁。
- **comment-center 其餘 5 個 tab**：inbox / rules / mapping / risk-rules / simulate 皆為同一頁不同 tab，**無獨立 route**。
- **performance**：客服/主管/經理為同頁三 tab，**無獨立 route**。
- **knowledge**：prompt / images / marketing / sandbox 為同頁四 tab。
- **chat**：viewMode（my/pending/high_risk/…）為 hash `#view=xxx`，**無獨立 route**，列表篩選即「子視圖」。

---

## 五、哪些 component / route / state 耦合過高

### 5.1 前端

- **BrandProvider / ChatViewProvider**：包在 App 最外層，brand 與 chat viewMode 被多頁共用；**settings 的 BrandChannelManager 直接依賴 useBrand()**，品牌/渠道一改，全站 brand 與 channels 重拉。
- **comment-center**：單檔 2,355 行，**activeMainTab、數十個 useState、多支 useQuery**（meta-comments、templates、mappings、risk-rules、page-settings…）全在一個元件內，**tab 切換不卸載**，狀態與請求混在一起。
- **settings**：BrandChannelManager、TagShortcutsManager、ScheduleForm、AssignmentRulesForm、API 金鑰、外觀、迎賓、轉人工等 **全部垂直堆疊**，表單與區塊強耦合於單一長頁。
- **chat**：viewMode、selectedContact、assignDialog、orderDialog、knowledgeDialog 等與列表/對話/右側面板 **高度耦合**，難以抽成「列表 / 對話 / 面板」獨立子元件而不動 state 結構。

### 5.2 後端

- **server/routes.ts**：約 **5,935 行、151 個 route**，auth、settings、meta-comments、meta-comment-rules、meta-templates、meta-pages、meta-post-mappings、meta-page-settings、brands、channels、integrations、contacts、messages、AI、webhook、analytics、team、performance、health、notifications 等 **全部集中單檔**，耦合極高。
- **storage**：品牌/渠道/聯絡人/訊息/訂單/知識庫/設定/團隊/派案等 **同一 storage 介面**，routes 直接依賴單一 storage 實例，未按領域拆分。

### 5.3 資料流

- **品牌/渠道**：GET /api/brands、GET /api/brands/:id/channels 被 sidebar、settings、comment-center、chat 等多處使用；**渠道變更後依賴各頁自行 invalidate**，易遺漏。
- **留言與規則**：comment-center 內多個 tab 共用/各自 useQuery，**無統一「留言領域」的 data layer**，重構時易漏改。

---

## 六、哪些 API 應拆分

- **依領域拆成多個 router**，而不是單一 routes 檔：
  - auth.routes
  - chat.routes（contacts, messages, 轉派、狀態）
  - comments.routes（meta-comments、templates、rules、risk-rules、mappings、page-settings、assignable-agents、test-rules、simulate 等）
  - brands.routes、channels.routes（或合併為 brands-channels.routes）
  - knowledge.routes（knowledge-files、marketing-rules、image-assets）
  - analytics.routes、team.routes、settings.routes
  - integrations.routes（meta OAuth、link-pages）
  - health.routes、notifications、webhook（LINE/FB）可單獨或併入對應領域
- **現有 API 路徑與行為建議儘量保留**，以「搬移 + 抽共用 middleware/util」為主，避免破壞前端。

---

## 七、哪些命名不一致

- **導航 vs 頁面標題**：「AI 自動處理監控台」vs 留言「收件匣」「監控台」混用；「粉專與 LINE 設定」vs 「粉專與 LINE 導向設定」。
- **模組稱呼**：「留言中心」「留言自動化」「comment-center」「Meta 留言」並存；「渠道」「頻道」混用；「戰情室」「數據」「analytics」「報表」混用。
- **角色**：sidebar 用「管理員/主管/客服」，App 用「超級管理員/行銷經理/客服人員」，ROLE_LABEL 與 ROUTE_ACCESS 角色鍵一致但顯示名不統一。
- **設定層級**：「系統設定」「全域設定」「品牌工作區管理」「渠道管理」混在一起，未區分「系統級 vs 營運級 vs 品牌級」。

---

## 八、哪些文件與程式碼不一致

- **HEALTH-CHECK-REPORT.md**：記載 `routes.ts` 約 3,251 行，**實際已約 5,935 行**；記載 session 用 memorystore，**實際 production 已用 Redis**（見 index.ts）；記載監聽 127.0.0.1，需再確認目前 deploy 是否已改。
- **BUG-AUDIT-LIST.md**：路由參數 `:id` 未驗證、更新 0 筆仍回 success 等仍為有效問題；**db:push 與 SQLite/Postgres 不一致**仍存在。
- **README**：專案根目錄無 README（搜尋為 0 結果），**缺少專案說明、啟動方式、環境變數總表**。
- **.env.example**：有 SESSION_SECRET、REDIS_URL、DATA_DIR、APP_DOMAIN、FB_VERIFY_TOKEN、OPENAI_MODEL；**缺少 META_APP_ID、META_APP_SECRET、ENCRYPTION_KEY、PUBLIC_URL** 等（Meta 整合與加密用）。
- **DEPLOYMENT_READINESS_AND_PLAN.md / RAILWAY_***.md**：若存在，需對照目前 **Redis、Session、SQLite、Volume、必填 env** 再校訂。

---

## 九、風險分級（P0 / P1 / P2）

### P0（不處理會阻礙產品化與維護）

1. **comment-center 單頁承載 6 大塊**：營運監控、規則、模板、導向、風險規則、內測全在一起，難以維護與擴充；**必須拆成至少 3 個獨立模組/頁**（收件匣監控、規則與導向設定、內測分離）。
2. **settings 承載品牌/渠道/派案/排班/系統設定**：營運型設定與系統設定混在一起；**必須將品牌與渠道移出**，派案/排班規劃與團隊整合。
3. **sidebar 導航與 dashboard 混在一起**：選單與戰情摘要、團隊狀況、快捷鈕同區，**必須重構為「導航為主、摘要可收合或極簡」**。
4. **routes.ts 單檔 151 個 route、約 6k 行**：**必須拆成多個 router 模組**，否則任何改動風險都高。
5. **API 輸入驗證不足**：`:id` 未驗證導致 NaN、更新 0 筆仍回 success；**必須補齊並統一回傳語義**。

### P1（本輪應完成，否則架構仍混亂）

6. **chat 工作台**：高頻與低頻操作未分層、右側面板過載；**三欄布局與操作分層、主管/客服視角差異化**。
7. **analytics**：**拆成 Overview（先給答案）與 Deep Dive（完整圖表）**。
8. **knowledge**：**分區明確（Prompt / 產品知識 / 素材 / 測試）**，避免與 comment-center 一樣變成大雜燴。
9. **team**：**整合排班、負載、派案規則**（或明確二級頁），與 settings 派案區脫鉤。
10. **路由與資訊架構**：**引入 /workspace/* 或明確一級模組 route**，每個主模組獨立 route、標題；**「粉專與 LINE 設定」改為獨立 route**，不再用 hash 偽裝。

### P2（命名、文件、視覺收斂）

11. **命名與文案統一**：主模組/子頁/狀態/CTA 術語對齊；「監控」「設定」「管理」「工作台」層級分清。
12. **文件同步**：README、.env.example、HEALTH-CHECK、BUG-AUDIT、deploy 文件與現況一致；**DB 策略（SQLite vs Postgres）與腳本、文件一致**。
13. **UI 收斂**：每頁一個主任務、區塊標題與 CTA 一致、長頁面折疊/二級導航、視覺減法。

---

## 十、整改順序建議（對應任務書 H 執行順序）

### 第一步（本階段）：只做 review / spec-check，不實作 ✅

- 產出本報告。
- 回報現況與 P0/P1/P2 清單，待確認後再進入第二步。

### 第二步：P0 實作

- Sidebar / 導航重構（導航為主、摘要可收合；「粉專與 LINE 設定」改為獨立模組或 route）。
- comment-center 拆頁（至少：留言收件匣/監控、規則與導向設定、內測分離）。
- chat 工作台分層（三欄、高頻/低頻分離、主管/客服視角）。
- settings 與 team / brands-channels 職責切分（品牌與渠道移出 settings；派案/排班規劃整合進團隊模組）。
- routes 模組拆分起手式（auth、settings、brands、channels、comments 等拆成獨立 router）。
- 輸入驗證補齊（:id、body、query；更新 0 筆不回 success）。
- 文件同步第一輪（README、.env.example、HEALTH-CHECK 與現況對齊）。

### 第三步：P1 實作

- analytics Overview / Deep Dive 分層。
- knowledge 分區整理（Prompt、產品、素材、測試）。
- 團隊派案中心整合（排班、負載、派案規則）。
- UI 收斂與互動改善。

### 第四步：P2 實作

- 命名收斂、細節 polish、視覺一致性、補漏驗收。

---

## 十一、建議新路由與資訊架構（對應任務書 B1/B2）

### 主模組與一級 route（建議）

| 主模組 | 建議一級 route | 說明 |
|--------|----------------|------|
| 客服工作台 | `/workspace` 或 `/` | 對話、案件、待回覆、待分配、轉派（chat 主頁） |
| 留言自動化中心 | `/workspace/comments` | 收件匣、例外監控、灰區抽查（可再二級） |
| 渠道與品牌管理 | `/workspace/brands` | 品牌、渠道、粉專綁定、LINE 導向、健康檢查 |
| AI 與知識庫 | `/workspace/knowledge` | Prompt、知識項、素材、導購規則、測試沙盒 |
| 團隊與派案 | `/workspace/team` | 成員、排班、負載、派案規則 |
| 數據戰情室 | `/workspace/analytics` | Overview + Deep Dive（可二級） |
| 系統設定 | `/workspace/settings` | 僅全域、金鑰、安全、健康檢測 |

### 二級 route（可選）

- `/workspace/comments/inbox`、`/workspace/comments/rules`、`/workspace/comments/channel-binding`
- `/workspace/brands/channels`
- `/workspace/team/members`、`/workspace/team/assignment`
- `/workspace/analytics/overview`、`/workspace/analytics/deep-dive`

**注意：** 是否採用 `/workspace` 前綴可依團隊習慣調整，重點是 **每個主模組有獨立 route、獨立頁面標題，不再用同一頁 + hash 偽裝多模組**。

---

## 十二、需拆分頁面與元件清單（對應任務書 C）

| 現頁面 | 建議拆分結果 |
|--------|--------------|
| comment-center | 留言收件匣頁、規則/導向設定頁（或二級）、內測頁（獨立或收合） |
| settings | 僅保留系統設定；BrandChannelManager → 移至 brands 模組；派案/排班 → 規劃至 team |
| chat | 抽「聯絡人列表」「對話區」「右側面板」為子元件；低頻工具下沉至抽屜/彈窗/進階區 |
| analytics | Overview 頁 + Deep Dive 頁（或同 route 兩區塊明確分層） |
| knowledge | 保持 tab 可接受，但區塊標題與 CTA 分區明確（Prompt / 產品 / 素材 / 測試） |
| team | 成員管理 + 排班/負載/派案規則（同一模組下 tab 或二級頁） |

---

## 十三、需拆分後端 routes 與 module 規劃（對應任務書 D）

| 模組檔名 | 建議涵蓋 API |
|----------|--------------|
| auth.routes | /api/auth/* |
| settings.routes | /api/settings, /api/settings/test-connection, /api/settings/schedule, /api/settings/assignment-rules, /api/settings/tag-shortcuts |
| brands.routes | /api/brands, /api/brands/:id, test-superlanding, test-shopline |
| channels.routes | /api/channels, /api/brands/:id/channels, /api/channels/:id/test, delete 時 Meta 取消訂閱 |
| comments.routes | /api/meta-comments/*, /api/meta-comment-*, /api/meta-pages/*, /api/meta-post-mappings/*, /api/meta-page-settings/*, /api/meta-product-keywords/* |
| knowledge.routes | /api/knowledge-files, /api/marketing-rules, /api/image-assets |
| chat.routes | /api/contacts, /api/contacts/:id/*, messages, 轉派、狀態、訂單查詢等 |
| analytics.routes | /api/analytics, /api/analytics/health |
| team.routes | /api/team, /api/team/:id, agent-status, manager-stats 等 |
| integrations.routes | /api/integrations/meta/* |
| health.routes | /api/health/status, /api/debug/status |
| notifications | /api/notifications/* |
| webhook | /api/webhook/line, /api/webhook/facebook（可保留在單獨檔或併入對應領域） |

**共同：** parseIdParam、authMiddleware、superAdminOnly、managerOrAbove、metaIntegrationAllowed 等抽成共用 middleware；錯誤處理與回傳格式統一。

---

## 十四、總結

- **導航**：目前 7 條扁平 route，多個「子模組」以 hash/tab 存在同一頁；sidebar 同時是導航與 dashboard，責任過重。
- **頁面**：comment-center、settings、chat 單頁責任過多；analytics、knowledge、team 需分層或分區。
- **後端**：單一 routes 檔約 6k 行、151 個 route，需按領域拆成多個 router。
- **設定歸屬**：品牌/渠道/粉專導向應移出 settings；派案/排班應與團隊整合。
- **文件**：HEALTH-CHECK、BUG-AUDIT、.env.example、README 與現況有落差，需同步。
- **風險**：P0 以「拆 comment-center、拆 settings、重構 sidebar、拆 routes、補驗證」為主；P1 以 chat/analytics/knowledge/team 分層與整合為主；P2 以命名、文件、UI 收斂為主。

**下一步**：請確認本報告與 P0/P1/P2 順序後，再開始第二步（P0 實作）；每輪完成後依任務書 I 格式回報「完成項目 / 未完成項目 / 風險 / 驗收方式 / 自我檢查結果」。
