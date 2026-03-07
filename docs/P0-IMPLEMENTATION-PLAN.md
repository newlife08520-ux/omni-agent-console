# P0 Implementation Plan（實作藍圖與風險收斂）

> **本文件為 P0 實作前必經的規劃產物；未經確認不進行任何 code 修改。**  
> 原則：舊路由相容、舊功能不掉、權限不破、API 形狀不亂改；分階段 P0-A → P0-B → P0-C，每輪附可操作驗收。  
> 本計畫與 [PRODUCTIZATION-REVIEW-REPORT.md](./PRODUCTIZATION-REVIEW-REPORT.md) 之結論與 P0 建議對齊，作為實作依據。

---

## 一、P0 分階段總覽

| 階段 | 範圍 | 目標 | 風險等級 |
|------|------|------|----------|
| **P0-A** | Sidebar 導航重構 + Comment-center 拆頁（route/頁面先拆，內部功能不大改） | 導航清楚、留言中心拆成獨立 route 與頁面，舊路徑可導轉 | 中 |
| **P0-B** | Settings / Brands-Channels / Team 職責切分 | 品牌與渠道移出 settings；派案/排班與 team 整合或明確歸屬 | 中 |
| **P0-C** | routes.ts 模組拆分起手式 + API 驗證補齊 + 文件同步 | 後端可維護、輸入驗證一致、文件與現況對齊 | 中高 |

**Chat 工作台**：列入 P0 但**不第一刀大改**。先產出 layout 拆分與元件邊界方案，經確認後再實作（可放在 P0-A 尾或 P0-B 前交付方案，實作時機另定）。

**路由策略**：P0 **不強制全面替換為 `/workspace/*`**。以「保留舊路由相容 + 新頁結構清楚」為主；必要時用 **redirect / alias**，避免書籤或內部連結失效。

**P0-A 決策（已確認）**：  
- **粉專 / LINE 基礎綁定、一般件／售後件／敏感件預設導向**：統一放在 **`/brands/channels`**（或 `/brands` 下的 channels／routing 區）；P0-B 實作。P0-A 暫保留在 comment-center 子頁 **`/comment-center/channel-binding`**，不在此輪搬進 brands。  
- **留言規則命中後的流程處理**（自動回覆、隱藏、標記、導流類型、灰區／風險件規則）：放在 **`/comment-center/rules`**。  
- **留言規則頁不維護粉專對 LINE 的基礎綁定**，避免雙重設定來源；該綁定僅在 **channel-binding**（未來 brands/channels）維護。

---

## 二、新 Sitemap / Route Map（P0 目標狀態）

### 2.1 一級 Route（保留舊路徑，新增僅為必要之「獨立頁」）

| 路徑 | 用途 | 備註 |
|------|------|------|
| `/` | 即時客服（Chat） | 不變 |
| `/comment-center` | 留言收件匣（預設） | **相容**：可 redirect 到 `/comment-center/inbox` 或維持現頁並以 hash 對應 inbox |
| `/comment-center/inbox` | 留言收件匣 | **新增**（或保留 `/comment-center` 僅顯示 inbox，其餘改子路徑見下） |
| `/comment-center/rules` | 自動規則 + 模板與對應 | **新增**（可合併 rules + mapping 一頁兩區） |
| `/comment-center/routing` | 粉專與 LINE 導向 / 風險與導流規則 | **新增**（原 page-settings + risk-rules 合併或分兩 tab） |
| `/comment-center/simulate` | 內測模擬 | **新增**（獨立頁，低頻） |
| `/brands` | 渠道與品牌管理 | **新增**（從 settings 移出；舊用書籤 `/settings` 仍可進「系統設定」） |
| `/settings` | 系統設定（僅全域、金鑰、迎賓、轉人工、排班等） | **保留**；移除品牌/渠道區塊 |
| `/team` | 團隊管理（成員 + 排班 + 派案規則） | **保留**；可加二級或同頁區塊整合排班/派案 |
| `/knowledge` | AI 與知識庫 | 不變 |
| `/analytics` | 數據戰情室 | 不變 |
| `/performance` | 客服績效 | 不變 |

**說明**：  
- 不引入 `/workspace` 前綴，一級路徑維持簡短。  
- 「粉專與 LINE 設定」不再用 `/comment-center#page-settings`，改為 **`/comment-center/routing`** 或 **`/brands`**（粉專導向若歸在 brands 則用 `/brands`）。  
- 舊連結 `/comment-center#page-settings` → 用 **client 端 redirect** 導向新路徑（或 301/302 若用 server 導向）。

### 2.2 二級 Route（Comment-center 拆頁後）

| 路徑 | 對應原 tab | 職責 |
|------|------------|------|
| `/comment-center` 或 `/comment-center/inbox` | inbox | 留言收件匣、戰情摘要、例外監控、灰區抽查 |
| `/comment-center/rules` | rules + mapping | 自動規則、模板與商品對應 |
| `/comment-center/routing` | page-settings + risk-rules | 粉專與 LINE 導向、留言風險與導流規則 |
| `/comment-center/simulate` | simulate | 內測模擬、種子、測試 mapping |

**Route 實作方式（二選一，建議 A）**：  
- **A**：wouter 支援巢狀，例如 `<Route path="/comment-center"><Route path="/inbox" /><Route path="/rules" />...</Route>`，或同一層 `/comment-center/inbox`、`/comment-center/rules`…，由 CommentCenterLayout 包子 route。  
- **B**：仍單一 route `/comment-center`，用 **query** 如 `?view=inbox|rules|routing|simulate` 取代 hash，以便深連結且不破壞現有 hash 邏輯過渡期可並存。

---

## 三、舊 Route → 新 Route / Redirect 對照表

| 舊路徑 / 舊行為 | 新路徑 / 處理方式 |
|-----------------|-------------------|
| `/` | 不變，仍為 Chat |
| `/comment-center` | 不變或 302 → `/comment-center/inbox`；若保留單頁則預設 tab = inbox |
| `/comment-center#inbox` | 對應 `/comment-center` 或 `/comment-center/inbox` |
| `/comment-center#rules` | 對應 `/comment-center/rules` |
| `/comment-center#mapping` | 對應 `/comment-center/rules`（同頁另一區或同一 tab） |
| `/comment-center#page-settings` | **Redirect** → `/comment-center/routing` 或 `/brands`（見 2.1 決策） |
| `/comment-center#risk-rules` | 對應 `/comment-center/routing` |
| `/comment-center#simulate` | 對應 `/comment-center/simulate` |
| `/settings` | 不變；進入後僅見「系統設定」區塊（品牌/渠道已移出） |
| 從 settings 點「品牌/渠道」 | 導向 **`/brands`**（新頁） |
| `/team` | 不變；未來同頁或二級可加排班/派案區塊 |
| `/knowledge`, `/analytics`, `/performance` | 不變 |

**Redirect 實作要點**：  
- **Sidebar**：「粉專與 LINE 設定」連結改為 `/comment-center/routing` 或 `/brands`，不再用 `#page-settings`。  
- **Client 端**：若偵測到 `hash=page-settings` 或 `hash=risk-rules`，可 `replaceState` 到新 path，避免舊書籤斷掉。  
- **Server 端**：必要時可對 `/comment-center` 帶 `?view=page-settings` 做 302 到 `/comment-center/routing`（可選）。

---

## 四、Sidebar Before / After 結構

### 4.1 Before（現狀）

```
- 目前登入（頭像、角色、負載）
- [客服] 我的工作（我的/待回/緊急/追蹤/逾時/結案）
- [客服] 我的快捷（我的案件/待我回覆/緊急案件/待追蹤/待分配）
- [主管] 今日戰情（今日新進/待分配/緊急/逾時/結案/VIP）
- [主管] 團隊狀況（列表）
- [主管] 主管快捷（待分配/逾時未回/全部案件）
- 品牌工作區（下拉 + 渠道列表）
- 功能選單
    - 即時客服 → /
    - AI 自動處理監控台 → /comment-center
    - 粉專與 LINE 設定 → /comment-center#page-settings
    - 客服績效 → /performance
    - AI 與知識庫 → /knowledge
    - 數據戰情室 → /analytics
    - 團隊管理 → /team
    - 系統設定 → /settings
- 底部：渠道狀態
```

### 4.2 After（P0-A 目標）

- **導航與摘要分層**  
  - **區塊一「導航」**：僅放「功能選單」連結，選單項對應新 route，不再用 hash。  
  - **區塊二「摘要」**：保留「目前登入」「我的工作/今日戰情」「品牌工作區」「渠道狀態」，但可 **收合**（例如一顆「摘要」按鈕展開/收合），或維持現樣式先不縮，以「不破壞現有習慣」為優先。

- **功能選單項目調整**  

| 標題 | 連結（新） | 說明 |
|------|------------|------|
| 即時客服 | `/` | 不變 |
| 留言收件匣 | `/comment-center` 或 `/comment-center/inbox` | 原「AI 自動處理監控台」改為「留言收件匣」或保留副標「監控 AI 處理狀態」 |
| 留言規則與導向 | `/comment-center/rules` | 自動規則 + 模板對應 |
| 粉專與 LINE 導向 | `/comment-center/routing` | 原「粉專與 LINE 設定」；同一頁或與 risk-rules 同區 |
| 內測模擬 | `/comment-center/simulate` | 獨立項，低頻 |
| 渠道與品牌 | `/brands` | **新增**（P0-B 實作後顯示；P0-A 可先保留在 settings 連結或暫不顯示） |
| 客服績效 | `/performance` | 不變 |
| AI 與知識庫 | `/knowledge` | 不變 |
| 數據戰情室 | `/analytics` | 不變 |
| 團隊管理 | `/team` | 不變 |
| 系統設定 | `/settings` | 不變 |

- **P0-A 可先做的 sidebar 改動**  
  - 將「AI 自動處理監控台」與「粉專與 LINE 設定」改為上述新路徑（`/comment-center`、`/comment-center/routing`），並新增「留言規則與導向」「內測模擬」兩項，指向 `/comment-center/rules`、`/comment-center/simulate`。  
  - 「渠道與品牌」可等 P0-B 再出現，或 P0-A 就加一項指到 `/brands`（若 P0-A 已先做 `/brands` 占位頁則可連）。

---

## 五、Comment-center 拆頁方案（每頁職責、路由、元件拆分）

### 5.1 頁面與路由對應

| 新路徑 | 頁面職責 | 對應原 tab |
|--------|----------|------------|
| `/comment-center` 或 `/comment-center/inbox` | 留言收件匣：戰情摘要、狀態篩選、列表、詳情、回覆/隱藏/導 LINE、已完成區、抽查/灰區 | inbox |
| `/comment-center/rules` | 自動規則 + 模板與商品對應：規則類型、模板、標籤、規則 CRUD；貼文 mapping、商品、導向流程 | rules, mapping |
| `/comment-center/routing` | 粉專與 LINE 導向 + 留言風險與導流：page-settings 表、risk-rules 五桶與測試器 | page-settings, risk-rules |
| `/comment-center/simulate` | 內測模擬：模擬 webhook、種子、測試 mapping | simulate |

### 5.2 元件拆分（保守策略，先拆 route 與頁面邊界）

- **不要求 P0-A 立刻把 comment-center.tsx 拆成多個小檔**；可先：
  - **方案 1**：一個 **CommentCenterLayout** 包 wouter 子 route（`/comment-center`, `/comment-center/inbox`, `/comment-center/rules`, `/comment-center/routing`, `/comment-center/simulate`），每個子 route 對應一個 **Page 元件**（如 `CommentInboxPage`, `CommentRulesPage`, `CommentRoutingPage`, `CommentSimulatePage`），**內容先從現有 TabsContent 複製/搬過去**，邏輯仍可暫時集中在單一檔或按頁拆檔。
  - **方案 2**：維持單一 `CommentCenterPage`，依 **path 或 query** 決定要 render 哪一塊（inbox / rules / routing / simulate），等於用 route 取代 tab 切換，**內部 state 與 API 呼叫可先不重構**，以「能獨立開到各子頁、舊 hash 可導轉」為目標。

- **共用部分**  
  - 若有多頁共用（例如 brand 篩選、權限），可抽成 **CommentCenterLayout** 的 context 或 props。  
  - 原 `activeMainTab` 改為由 **route 決定**（path 或 query），不再依 hash 同步。

### 5.3 舊 hash 相容

- 進入 `/comment-center` 時若帶 `#page-settings`、`#risk-rules`、`#rules`、`#mapping`、`#simulate`，**client 端**做一次 redirect（`replaceState`）到對應新 path，例如：
  - `#page-settings` → `/comment-center/routing`
  - `#risk-rules` → `/comment-center/routing`
  - `#rules` → `/comment-center/rules`
  - `#mapping` → `/comment-center/rules`
  - `#simulate` → `/comment-center/simulate`
  - `#inbox` 或不帶 hash → 維持 `/comment-center` 或 `/comment-center/inbox`

---

## 六、Settings 移出項目清單（P0-B）

| 項目 | 目前位置 | 移出後歸屬 | API / 資料 |
|------|----------|------------|------------|
| 品牌工作區管理（品牌 CRUD、選取） | settings 區塊 | **`/brands`** 頁 | 現有 `/api/brands` 不變 |
| 渠道管理（渠道 CRUD、測試、連結 Facebook） | settings 區塊（BrandChannelManager） | **`/brands`** 頁（同頁或「渠道」子區） | 現有 `/api/brands/:id/channels`, `/api/channels`, `/api/integrations/meta/*` 不變 |
| 粉專與 LINE 導向設定（page-settings 表） | comment-center#page-settings | 已於 P0-A 歸 **`/comment-center/routing`** 或可選放在 `/brands` 子區 | 現有 `/api/meta-page-settings` 不變 |
| 客服排班（ScheduleForm） | settings 區塊 | **保留在 settings** 或 **`/team`**（P0-B 決策：若 team 要「團隊營運」則移 team） | `/api/settings/schedule` |
| 派案規則（AssignmentRulesForm） | settings 區塊 | **`/team`**（與成員同模組） | `/api/settings/assignment-rules` 等，不變 |

**保留在 settings 的項目**：  
系統名稱 / Logo、安全測試模式、API 金鑰與連線測試、LINE 迎賓與快捷按鈕、轉人工關鍵字、標籤快捷、一頁商店/SHOPLINE 全域設定；排班若不移則也保留。

---

## 七、Team 整合項目清單（P0-B）

| 項目 | 目前位置 | 整合後 |
|------|----------|--------|
| 成員管理（列表、新增/編輯/刪除、頭像、角色） | `/team` | 保留在 `/team`，仍為主要內容 |
| 客服排班（時段設定） | settings | 移入 `/team` 成為一區塊或同頁 tab「排班」 |
| 派案規則（SLA、自動分配開關、逾時重分配等） | settings | 移入 `/team` 成為一區塊或同頁 tab「派案規則」 |
| 在線狀態、最大負載、可分配條件 | 若已有 API/欄位 | 在 `/team` 成員卡片或列表中顯示；若無則 P0 僅預留區塊，不強求新 API |

**實作方式**：  
- `/team` 頁面可維持單頁，上方或左側用 **Tabs 或錨點** 區分「成員」「排班」「派案規則」。  
- 從 settings 移除排班與派案表單，改為在 settings 放 **「前往團隊排班與派案」** 連結導向 `/team`（或錨點 `#schedule` / `#assignment`）。

---

## 八、routes.ts 拆分順序與原因（P0-C）

### 8.1 建議拆分順序

| 順序 | Router 模組 | 涵蓋 API | 先拆原因 |
|------|-------------|----------|----------|
| 1 | **auth.routes** | `/api/auth/*` | 獨立、無依賴、改動風險低 |
| 2 | **health.routes**（或 debug） | `/api/health/status`, `/api/debug/status` | 獨立、體積小 |
| 3 | **settings.routes** | `/api/settings`, `/api/settings/*` | 與 P0-B 設定切分一致，邊界清楚 |
| 4 | **brands.routes** | `/api/brands`, `/api/brands/:id`, test-superlanding, test-shopline | 與 P0-B 品牌/渠道頁對應 |
| 5 | **channels.routes** | `/api/channels`, `/api/brands/:id/channels`, `/api/channels/:id/test`, delete 邏輯 | 與 brands 同屬「渠道與品牌」 |
| 6 | **integrations.routes** | `/api/integrations/meta/*` | 已幾乎獨立，抽成 router 即可 |
| 7 | **comments.routes**（或 meta-comments.routes） | 所有 `/api/meta-comments*`, `/api/meta-comment-*`, `/api/meta-pages*`, `/api/meta-post-mappings*`, `/api/meta-page-settings*`, `/api/meta-product-keywords*` | 體積最大，拆出後 routes.ts 負擔明顯下降 |
| 8 | **chat.routes**（或 contacts.routes） | `/api/contacts`, `/api/contacts/:id/*`, messages, 轉派等 | 與前端 chat 對應 |
| 9 | **knowledge.routes** | `/api/knowledge-files`, `/api/marketing-rules`, `/api/image-assets` | 邊界清楚 |
| 10 | **analytics.routes** | `/api/analytics`, `/api/analytics/health` | 獨立 |
| 11 | **team.routes** | `/api/team`, `/api/team/:id`, agent-status, manager-stats 等 | 與 P0-B team 整合對應 |
| 12 | **notifications** | `/api/notifications/*` | 獨立 |
| 13 | **webhook** | `/api/webhook/line`, `/api/webhook/facebook` | 保留單獨檔或併入對應領域 |

**共同**：  
- `parseIdParam`、`authMiddleware`、`superAdminOnly`、`managerOrAbove`、`metaIntegrationAllowed` 抽成 **共用 middleware**（如 `server/middleware/auth.ts`）。  
- 錯誤處理與 404 行為在 **主 routes 或 app** 統一，各 router 只做 `router.get/post/...`，不重複寫 try/catch 結構。

### 8.2 相容性

- **URL 路徑不變**：所有現有 `/api/xxx` 路徑維持，僅改為 `app.use(router)` 掛載。  
- **Request/Response shape 不變**：不改變 API 回傳格式與欄位。  
- **權限**：原 middleware 邏輯搬進共用檔，各 router 照樣套用，權限不破。

---

## 九、Chat 工作台：Layout 拆分與元件邊界（方案先行，實作時機另定）

### 9.1 目標

- **三欄**：左（案件/聯絡人列表）、中（對話主區）、右（上下文/操作面板）。  
- **高頻保留主區**：選案、看訊息、回覆、標記、轉派。  
- **低頻下沉**：訂單查詢、商品查詢、進階搜尋、標籤維護 → 抽屜、彈窗或右側「進階」區。

### 9.2 建議元件邊界（不強制 P0-A 就改）

| 區塊 | 建議元件 | 職責 |
|------|----------|------|
| 左欄 | `ChatContactList`（或沿用現有結構） | viewMode 篩選、列表、選取 contact、未讀/逾時/平台標示 |
| 中欄 | `ChatConversation` | 訊息列表、輸入框、送訊、AI 建議 |
| 右欄 | `ChatDetailPanel` | 案件摘要、狀態/標籤、訂單資訊、備註、轉派入口 |
| 低頻 | `ChatOrderLookup`, `ChatProductLookup`, 標籤編輯等 | 以 Dialog/抽屜從右欄或工具列開啟，不佔主區 |

### 9.3 約束

- P0 **不要求**立刻重寫 chat 內部；可先產出此方案，**經確認後**再在 P0-A 尾或 P0-B 做 layout 與元件抽離，**互動與 state 可分多輪收斂**。

---

## 十、驗收 Checklist（每輪可執行）

### P0-A（Sidebar + Comment-center 拆頁）

- [ ] Sidebar「功能選單」連結改為新 path（無 hash）；「粉專與 LINE 設定」點擊進入 `/comment-center/routing`（或 `/brands` 若已上）。
- [ ] 直接造訪 `/comment-center`、`/comment-center/inbox`、`/comment-center/rules`、`/comment-center/routing`、`/comment-center/simulate` 皆可進入對應內容，且權限與現有一致。
- [ ] 造訪 `/comment-center#page-settings`、`#risk-rules`、`#rules`、`#simulate` 會自動導到對應新 path（replaceState 或 redirect）。
- [ ] 留言收件匣、規則、導向、內測模擬四類功能行為與改版前一致（列表、篩選、回覆、規則 CRUD、模擬等）。
- [ ] 未登入 / cs_agent / marketing_manager / super_admin 權限與現有一致；無 403/404 異常。

### P0-B（Settings / Brands / Team）

- [ ] `/settings` 不再顯示品牌工作區管理、渠道管理；改為顯示「前往渠道與品牌」連結至 `/brands`。
- [ ] `/brands` 可正常使用：品牌列表、選取、渠道 CRUD、連結 Facebook、健康檢查（與原 settings 內行為一致）。
- [ ] `/team` 可看到成員列表；排班、派案規則區塊已出現在 `/team`（自 settings 移入）。
- [ ] Settings 仍保留：系統名稱/Logo、API 金鑰、迎賓、轉人工、標籤快捷、一頁商店/SHOPLINE 等；排班/派案表單已自 settings 移除。
- [ ] 權限：`/brands` 僅 super_admin / marketing_manager；`/team` 僅 super_admin；與現有一致。

### P0-C（Routes 拆分 + API 驗證 + 文件）

- [ ] 至少 auth、health、settings、brands、channels、integrations 已拆成獨立 router，且 `app.use` 掛載後既有 API path 不變。
- [ ] 所有 `:id` 類參數經驗證（parseInt 後非 NaN、存在性檢查）；更新 0 筆時不回 `success: true`。
- [ ] HEALTH-CHECK-REPORT.md、.env.example、README（若補寫）與現況一致（Redis、SESSION_SECRET、routes 行數、必填變數、Meta/ENCRYPTION_KEY 等）。
- [ ] 現有前端呼叫之 API 路徑與回傳格式均未變；登入、設定、品牌、渠道、留言中心、團隊等流程正常。

### Chat（若在 P0 內實作 layout）

- [ ] 左/中/右三欄結構存在；右欄可收合或固定（依方案）。
- [ ] 高頻操作（選案、回覆、標記、轉派）仍在主區可完成；低頻工具以抽屜/彈窗開啟，不破壞主流程。

---

## 十一、回滾方案

### 11.1 前端

- **Git**：每階段（P0-A / P0-B / P0-C）完成驗收後打 tag（如 `p0-a-done`），必要時 `git revert` 或 `git checkout <tag>` 回滾。  
- **Route**：保留舊 path 與 hash 相容邏輯至少一版；回滾時還原 App.tsx、app-sidebar 的 route 與連結即可。  
- **Comment-center**：若拆成多頁，回滾時可暫時改回單頁 + tab（原 `activeMainTab` + hash），再還原 route 設定。

### 11.2 後端

- **routes**：拆分後以 `app.use("/api", authRouter)` 等形式掛載；回滾時改回單一 `routes.ts`，或還原該次 commit。  
- **Middleware**：抽成共用檔後，回滾時將 middleware 複製回 routes.ts 或還原檔案即可。  
- **API 行為**：未改 request/response shape，前端無需配合回滾；若有補驗證導致嚴格行為，可暫時放寬驗證再釋出修正。

### 11.3 文件

- 文件更新放在同次 commit 或獨立 commit，回滾時一併還原即可。

---

## 十二、P0 實施順序與依賴（摘要）

1. **P0-A**  
   - Sidebar：導航項改為新 path；必要時摘要區可收合。  
   - Comment-center：新增 route（或 path/query）對應 inbox / rules / routing / simulate；舊 hash 導轉；內容可先從原 TabsContent 搬過去，不大改內部邏輯。  
   - Chat：僅交付 layout/元件邊界方案（可選），或延後實作。

2. **P0-B**  
   - 新增 `/brands` 頁，內容為原 settings 的 BrandChannelManager；自 settings 移除該區塊，加「前往渠道與品牌」連結。  
   - Team：自 settings 移入排班、派案規則至 `/team`；settings 移除該兩區塊。

3. **P0-C**  
   - routes.ts 按 8.1 順序拆成 auth、health、settings、brands、channels、integrations、comments、chat、knowledge、analytics、team、notifications、webhook 等 router；共用 middleware 抽出。  
   - API：`:id` 與 body/query 驗證、更新 0 筆語義修正。  
   - 文件：HEALTH-CHECK、.env.example、README 同步。

---

## 十二之一、P0-A 執行細節（開工前回報）

### 會改的檔案

| 檔案 | 改動內容 |
|------|----------|
| `client/src/App.tsx` | 新增 `/comment-center` 子 path 路由；`/comment-center` 無 segment 時 redirect 至 `/comment-center/inbox`；同一 GuardedRoute 權限 |
| `client/src/components/app-sidebar.tsx` | 功能選單改為新 path（無 hash）；選單項命名與新頁一致（留言收件匣、留言規則與導向、粉專與 LINE 設定、內測模擬） |
| `client/src/pages/comment-center.tsx` | 依 path segment 決定顯示區塊（inbox / rules / channel-binding / simulate）；舊 hash 進站時 client 端 redirect 至新 path；頁內導航改為 Link 至新 path；可選 document.title 依頁設定 |
| `docs/P0-IMPLEMENTATION-PLAN.md` | 已補決策與本執行細節 |

### P0-A 新舊 Route 對照

| 舊路徑 / 舊行為 | 新路徑 / 處理方式 |
|-----------------|-------------------|
| `/comment-center` | 導向 **`/comment-center/inbox`**（redirect） |
| `/comment-center#inbox` | **`/comment-center/inbox`** |
| `/comment-center#rules` | **`/comment-center/rules`** |
| `/comment-center#mapping` | **`/comment-center/rules`**（同頁，規則＋模板對應＋風險導流） |
| `/comment-center#page-settings` | **`/comment-center/channel-binding`**（僅粉專-LINE 綁定；P0-B 再移 brands/channels） |
| `/comment-center#risk-rules` | **`/comment-center/rules`**（同頁，與規則／mapping 同頁） |
| `/comment-center#simulate` | **`/comment-center/simulate`** |

### Redirect 規則（client 端）

1. **進入 `/comment-center` 且無 segment**：`location.replace('/comment-center/inbox')`（或 wouter setLocation）。  
2. **進入 `/comment-center` 或 `/comment-center/*` 且帶舊 hash**：  
   - `#inbox` → `/comment-center/inbox`  
   - `#rules` 或 `#mapping` 或 `#risk-rules` → `/comment-center/rules`  
   - `#page-settings` → `/comment-center/channel-binding`  
   - `#simulate` → `/comment-center/simulate`  
   以 `replaceState` / setLocation 換成新 path 並清除 hash，避免雙重來源。  
3. **舊 path 保留**：仍註冊 `/comment-center`（觸發上述 redirect），不刪除；不新增 `/workspace/*`。

### P0-A 驗收步驟（本輪可執行）

- [ ] Sidebar「留言收件匣」「留言規則與導向」「粉專與 LINE 設定」「內測模擬」皆為獨立 path，無 hash。  
- [ ] 直接造訪 `/comment-center` → 自動導向 `/comment-center/inbox`。  
- [ ] 造訪 `/comment-center#page-settings`、`#risk-rules`、`#rules`、`#simulate` 會自動導到對應新 path（且 hash 清除）。  
- [ ] 造訪 `/comment-center/inbox`、`/comment-center/rules`、`/comment-center/channel-binding`、`/comment-center/simulate` 各顯示正確內容；權限與現有一致。  
- [ ] 留言收件匣、規則＋mapping＋風險導流、粉專-LINE 設定、內測模擬功能行為與改版前一致。  
- [ ] 頁面標題（或 document.title）與導航命名一致。  
- [ ] 未登入／cs_agent／marketing_manager／super_admin 權限與現有一致；無 403/404 異常。

---

## 十二之二、P0-A 完成回報（實作後）

### 1. 完成狀態

- **已完成**：P0-A 範圍內之 sidebar 導航重構、comment-center 拆頁與新 route 落地、舊 route／hash 的 redirect／alias 相容、頁面標題與導航命名一致化；未做 chat 大幅重構、settings／team／brands 深度搬家、routes.ts 拆分、API shape 調整、大量 UI polish。

### 2. 本輪修改摘要

- **App.tsx**：新增 ROUTE_ACCESS 子路徑；新增 `CommentCenterRedirect`（/comment-center 無 segment 或帶舊 hash 時導向新 path）；新增 GuardedRoute `/comment-center/inbox`、`/comment-center/rules`、`/comment-center/channel-binding`、`/comment-center/simulate`，以及 path="/comment-center" 之 redirect 元件。  
- **app-sidebar.tsx**：`allMenuItems` 改為獨立 path（留言收件匣→/comment-center/inbox，留言規則與導向→/comment-center/rules，粉專與 LINE 設定→/comment-center/channel-binding，內測模擬→/comment-center/simulate）；新增圖示 ClipboardList、FlaskConical。  
- **comment-center.tsx**：以 `useCommentCenterPage()` 從 path 解析 currentPage；rules 頁採子 tab（rules／mapping／risk-rules）；頁內導航改為 Link 至上述四 path；清除進站 hash、設定 document.title；保留原 TabsContent 內容，僅改驅動來源為 path。

### 3. 風險與未完成項

- **風險**：舊書籤若為 `/comment-center` 不帶 hash，會導向 inbox，行為與原「預設 tab」一致；若為 `/comment-center#xxx` 會導向對應新 path，hash 清除後無法再以 # 深連結，改以 path 深連結。  
- **未完成項**：P0-B（settings／brands／team）、P0-C（routes.ts 拆分、API 驗證、文件）；chat layout 未動；E2E 未跑。

### 4. 驗收方式

- 依「十二之一、P0-A 驗收步驟」逐項操作：sidebar 點各項、直接造訪 `/comment-center`、造訪帶舊 hash 的 URL、造訪四條新 path、確認收件匣／規則／粉專設定／模擬功能與權限、確認 document.title、確認各角色無 403/404。

### 5. 自我檢查

- [x] 舊功能保留；舊入口有 redirect 或 path 對應。  
- [x] Sidebar 不再出現「獨立模組其實只是同頁 hash tab」的假模組。  
- [x] Comment-center 拆頁後每頁一個主任務（inbox／rules 含三子區／channel-binding／simulate）。  
- [x] 先做低風險結構整理，未趁機大改互動。  
- [x] 粉專／LINE 基礎綁定在 channel-binding 頁；留言規則流程在 rules 頁；規則頁不維護粉專-LINE 基礎綁定。

---

## 十三、本輪交付狀態（僅交付計畫，未實作）

### 1. 完成狀態

- **已完成**：撰寫並產出「P0 Implementation Plan」文件（`docs/P0-IMPLEMENTATION-PLAN.md`），內容涵蓋 P0-A / P0-B / P0-C 分階段、新 sitemap / route map、舊→新 route 與 redirect 對照、sidebar before/after、comment-center 拆頁方案、settings 移出與 team 整合清單、routes.ts 拆分順序與原因、驗收 checklist、回滾方案，以及 Chat layout 拆分與元件邊界方案（方案先行）。
- **未完成**：尚未進行任何程式修改；待您確認本計畫後，再依 P0-A → P0-B → P0-C 順序實作。

### 2. 本輪修改摘要

- **新增文件**：`docs/P0-IMPLEMENTATION-PLAN.md`。
- **內容要點**：  
  - P0 拆成 P0-A（sidebar + comment-center 拆頁）、P0-B（settings / brands-channels / team 職責切分）、P0-C（routes.ts 模組拆分 + API 驗證 + 文件同步）。  
  - 不強制 `/workspace/*`，以舊路由相容與 redirect/alias 為主。  
  - 新 route 僅新增必要獨立頁（如 `/comment-center/rules`、`/comment-center/routing`、`/comment-center/simulate`、`/brands`）；舊路徑與 hash 均有對照與導轉方式。  
  - Sidebar、comment-center 拆頁、settings 移出、team 整合、routes 拆分順序、驗收與回滾皆已寫入，Chat 為 layout/元件邊界方案先行、實作時機另定。

### 3. 風險與未完成項

- **風險**：計畫中部分選項（如「粉專與 LINE 導向」究竟放在 `/comment-center/routing` 或 `/brands`）需您拍板；routes 拆分時若共用 middleware 抽得不完整，可能出現重複或漏權限。  
- **未完成項**：實際 code 改動、單元/整合測試、E2E 路徑測試均未執行；Chat 僅方案，尚未實作 layout 拆分。

### 4. 驗收方式

- **本輪（計畫交付）**：審閱 `docs/P0-IMPLEMENTATION-PLAN.md`，確認分階段、route 對照、sidebar、comment-center 拆頁、settings/team、routes 順序、驗收 checklist 與回滾方案是否符合預期；若有需調整處請直接指出，補齊後再進入 P0-A 實作。  
- **後續輪次**：每輪（P0-A / P0-B / P0-C）完成後，依文件內「驗收 Checklist」執行可操作驗收步驟。

### 5. 自我檢查

- [x] P0 已拆成 P0-A / P0-B / P0-C，未一次動全部模組。  
- [x] 新 sitemap / route map、舊→新 route 與 redirect 對照表已寫入。  
- [x] Sidebar before/after、comment-center 拆頁（職責、路由、元件拆分）、settings 移出與 team 整合清單、routes.ts 拆分順序與原因已寫入。  
- [x] 驗收 checklist 與回滾方案已寫入。  
- [x] `/workspace/*` 未在 P0 第一刀強制全面替換；以保留舊路由相容與 redirect 為主。  
- [x] P0 順序為低風險高價值：P0-A → P0-B → P0-C；Chat 為方案先行、確認後再實作。  
- [x] 計畫內已強調：舊功能不掉、舊路徑可相容或可導轉、權限不破、API response shape 不亂改、每輪附可操作驗收。

---

**以上為 P0 實作藍圖與風險收斂；待您確認本計畫後，再開始撰寫程式。**
