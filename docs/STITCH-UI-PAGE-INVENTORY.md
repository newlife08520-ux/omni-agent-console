# Stitch UI — 全站頁面盤點（依前端 code 掃描）

**掃描來源**：`client/src/App.tsx`（`ROUTE_ACCESS`、`Switch`）、`client/src/components/app-sidebar.tsx`（`allMenuItems`）、`client/src/App.tsx`（`AppContent` 登入分流）、各 `pages/*.tsx` 主檔。  
**產品定位**：Omni-Agent Console — 全通路 AI 客服中控台（非程式內「審判官」命名；以下「審判／監控」語意對應 **留言監控台** 與 **即時案件判讀**）。

**角色對照（實際 `role` 字串）**  
| Code | 建議稱呼 |
|------|----------|
| `super_admin` | 超級管理員 |
| `marketing_manager` | 行銷經理／主管 |
| `cs_agent` | 客服人員 |

---

## 頁面清單

| 頁面名稱 | route path | 所屬系統 | 使用者角色 | 頁面用途一句話 | 高優先 | detail/drawer/modal/tab | 備註 |
|----------|------------|----------|------------|----------------|--------|-------------------------|------|
| 登入 | `/login`（無側欄；`AppContent` 內） | 自動客服 / 共用 | 未登入使用者 | 帳密登入進中控台 | 是 | 無 | 成功後導向 `/` |
| 權限不足 | （無獨立 path；`GuardedRoute` 內嵌） | 共用 | 已登入但無權限 | 告知無法存取該路由 | 否 | 無 | 盾牌圖示 + 文案 |
| App Shell — 側欄 | （全域，非路由） | 自動客服 | 依選單可見角色 | 導航、品牌切換、戰情摘要、渠道狀態 | 是 | 側欄內多區塊；品牌下拉為 overlay | `data-testid="sidebar"` |
| App Shell — 頂欄 | （全域，非路由） | 自動客服 | 全員；設定僅部分角色 | 標題、通知、設定、登出、主管摘要 | 是 | 無 | 連結至 `/`、`/settings` |
| 即時客服 | `/` | 自動客服 | 全員 | 聯絡人列表 + 對話 + 右側客戶／訂單 | 是 | 多 Dialog（指派／改派）；右欄 Tabs；查單 Tabs | `chat.tsx`，三欄主工作台 |
| 留言中心 redirect | `/comment-center` | 自動客服（Meta 留言） | 全員 | 導向 inbox 或舊 hash 對應 path | 否 | 無 | 無 UI，僅 `setLocation` |
| 留言收件匣 | `/comment-center/inbox` | 自動客服（監控／審判語意） | 全員 | 留言例外監控、戰情、左列表右詳情 | 是 | 同檔內多區塊；詳情區含編輯／送出等 | `comment-center.tsx` `currentPage===inbox` |
| 留言規則與導向 | `/comment-center/rules` | 同上 | 全員 | 自動規則、模板對應、風險規則 | 是 | **子 Tabs**：自動規則／模板與商品對應／風險與導流 | 與 inbox 同檔，靠 path 切 |
| 粉專與 LINE 設定（留言脈絡） | `/comment-center/channel-binding` | 同上 | 全員 | 粉專與 LINE 綁定相關（同檔渲染） | 中 | **待確認**：與「品牌與渠道」差異以實際區塊為準 | 同 `comment-center.tsx` |
| 內測模擬 | `/comment-center/simulate` | 同上 | 全員 | 模擬留言／webhook 測試 | 中 | **待確認**細節按鈕名 | 同檔 |
| 粉專批次串接 | `/comment-center/batch-pages` | 同上 | **僅 super_admin** | 批次匯入／管理粉專頁 | 低 | 列表與匯入流程 | `ROUTE_ACCESS` 與側欄條件顯示 |
| 系統設定 | `/settings` | 營運後台 | `super_admin`、`marketing_manager` | 全域／外觀／LINE 迎賓／API 等 | 是 | 多 Card 區塊；super 與非 super 內容不同 | `cs_agent` → 權限不足 |
| 品牌與渠道 | `/settings/brands-channels` | 營運後台 | 主管、管理員 | 品牌、LINE/FB 渠道、訂閱留言、健康檢測 | 是 | `BrandChannelManager` 內 Dialog 多個 | `marketing_manager` 為 readOnly |
| AI 與知識庫 | `/knowledge` | 自動客服 / 設定 | 主管、管理員 | Prompt、素材、行銷規則、沙盒 | 是 | Tabs：prompt／images／marketing／sandbox | 客服無權 |
| 團隊管理 | `/team` | 營運後台 | 主管、管理員 | 成員、排班、派案、品牌負責 | 是 | 多 Dialog（新增／編輯／品牌指派） | 客服無權 |
| 數據戰情室 | `/analytics` | 營運／診斷 | 主管、管理員 | 報表、熱詞、痛點、系統健康區塊 | 是 | 日期選擇、多圖表 Card | 客服無權；含 `section-system-health` |
| 客服績效 | `/performance` | 自動客服 / 診斷 | **全員** | 個人績效或主管戰情／圖表 | 是 | 主管：`Tabs` 戰情板／全部客服／主管報表 | 與 analytics 分工不同 |
| 404 | （`Route` 預設，`Switch` 最後） | 共用 | 全員 | 未知路徑 | 否 | 無 | `not-found.tsx` |

---

## 側欄未單獨成「路由」但影響 `/` 的項目

- **我的快捷／今日戰情／主管快捷**：呼叫 `setViewMode` + `setLocation("/")`，不改 path，只改即時客服列表篩選語意。

---

## 統計

- **具獨立路由或等同路由的畫面**：上表列舉 **17** 列（含 login、redirect、403 內嵌、not-found）。
- **高優先（建議 Stitch 首輪）**：登入、Shell、即時客服、留言收件匣、留言規則、系統設定、品牌與渠道、知識庫、數據戰情室、客服績效（依產品重視度可再縮）。

---

## 尚未完全確認（需對照長檔逐段）

1. `comment-center.tsx` 內 **channel-binding / simulate / batch-pages** 區塊的每一顆按鈕文案與順序（檔案 2500+ 行，本盤點以 path 與共用標頭為準）。
2. `chat.tsx` 右欄 **客戶資訊** 分頁內所有子按鈕（部分依 `isManager` 條件渲染）。
3. `settings.tsx` 後半段（API 金鑰、連線測試、標籤快捷等）是否還有額外折疊區 — 已見 `TagShortcutsManager` 等，細節以檔案為準。

---

*文件版本：依 repo 前端靜態掃描產出，無後端行為修改。*
