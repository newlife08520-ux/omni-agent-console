# 系統切換效能盤點報告：體感慢、卡頓

**目標**：找出側邊欄切頁、chat 工作台切 view、comment-center 子頁、/team／/settings／/brands-channels 切換、同頁 tab 等情境下「切換不順、速度感變慢」的原因。  
**本輪僅盤點與定位，不改 code、不新增功能、不擴大重構。**

---

## 1. 完成狀態

- 已完成指定範圍的程式檢視與推論。
- 未進行實機量測（Network / React DevTools），結論以程式結構與資料流為主。
- 若需實作優化，請先確認本報告的「預計修改檔案」再動手。

---

## 2. 盤點範圍

| 類別 | 實際檢視內容 |
|------|----------------|
| **前端頁面與路由** | `App.tsx`、`chat.tsx`、`comment-center.tsx`、`team.tsx`、`settings.tsx`、`brands-channels.tsx`、`app-sidebar.tsx` |
| **資料流 / query** | React Query：`queryClient.ts` 預設（staleTime: Infinity）、各頁 useQuery/useQueries、queryKey、invalidateQueries 使用點、重複抓取、切頁是否打太多 API |
| **Render / state** | 路由是否導致整頁重 mount、大元件重 render、derived state/list 負擔、query 回來是否整頁閃動 |
| **Loading 體感** | 是否整頁白、skeleton 使用、純文字「載入中」、先清空再載入、有無保留快取延續 |

---

## 3. 最慢的頁面／切換點（前 5 名）

| 排名 | 情境 | 說明 |
|------|------|------|
| **1** | **Comment-center 子頁切換**（收件匣 ↔ 規則與導向 ↔ 粉專與 LINE 設定 ↔ 內測模擬） | 每次切換都是**整顆 CommentCenterPage 卸載再掛載**，同一顆樹上有 **20+ 支 useQuery**，多數無 `enabled` 依子頁，幾乎全部會跑或從 cache 讀；首次或 cache 失效時請求數多，體感最卡。 |
| **2** | **Chat 工作台切 view**（我的案件 / 待我回覆 / 緊急案件 / 待追蹤 / 全部案件） | 左側聯絡人 list 的 queryKey 含 `viewMode`，切 view 必 **refetch**，且 **staleTime: 0** 不用 cache；每次切換左側都會出現「載入中...」，列表先被載入狀態取代，體感明顯卡一下。 |
| **3** | **側邊欄切頁**（即時客服 → 留言收件匣 → 團隊管理 → 設定 等） | **wouter Switch 只渲染一個 Route**，切頁 = 當前頁整棵樹 unmount + 新頁 mount；main 區會有一瞬空白或直接進入新頁的 loading，無過渡、無 keep-alive。 |
| **4** | **/team、/settings、/brands-channels 之間切換** | 每次都是**整頁 unmount/mount**。Team 有 **N+1**（`/api/team` + 每位成員的 brand-assignments）；Settings 有 settings + auth + tag-shortcuts；Brands-channels 有 context brands + channels + 每品牌的 assigned-agents；體感為「整塊重掛」+ 多請求。 |
| **5** | **Comment-center 同頁內 rules 子 tab**（規則／模板對應／風險導流） | 子 tab 用 state 切換，**不 remount**；但進入「規則與導向」時若是由「收件匣」等子路徑點進來，會先經過一次 **CommentCenterPage 整顆 remount**（見第 1 點），所以進到 rules 本身也會帶入那次成本；同頁內 tab 切換則相對輕。 |

---

## 4. 每個慢點的根因

- **Comment-center 子頁（#1）**
  - **路由結構**：`/comment-center/inbox`、`/comment-center/rules` 等是**多條獨立 Route**，每條都 `component={CommentCenterPage}`，路徑變更時 React 會 **unmount 舊實例、mount 新實例**。
  - **Query 過多且多數未依子頁關閉**：comments、templates、metaPages、mappings、rules、pageSettingsList、commentSummary、health、riskRulesList、assignableAgents、selectedComment（當 selectedId 有值）等 **20+ 支**；僅少數有 `enabled`（如 batch-pages 的 brands、spot-check／gray-spot-check／completed 依區塊開關）。切到 rules 時 inbox 的 comments 仍會跑，切到 inbox 時 rules/templates 等也會跑（或讀 cache），**重複／過量請求**。
  - **無按子頁的 enabled**：未依 `currentPage` 做「只在該子頁才 fetch」，導致每次 mount 都觸發大量 query。

- **Chat 切 view（#2）**
  - **queryKey 含 viewMode**：`["/api/contacts", selectedBrandId, viewMode]`，切 view 就視為新 query，**必 refetch**。
  - **staleTime: 0**：contacts 此 query 覆寫為 `staleTime: 0`，不利用 cache，每次都是「清空／載入中 → 新資料」。
  - **Loading 取代列表**：`contactsLoading` 時整塊左側只顯示「載入中...」，**沒有保留上一筆 list 做 stale-while-revalidate**，體感像整塊閃一下。

- **側邊欄切頁（#3）**
  - **Route 與 Switch 行為**：`<Switch>` 下多個 `<Route path="..." component={Page} />`，只會渲染一個；切 path = 舊 Page 整棵 unmount、新 Page mount。
  - **無過渡、無 keep-alive**：main 區沒有「保留上一頁骨架」或 route-level skeleton，也沒有 React 的 keep-alive 類機制，**畫面會先清空再出現新頁**，若新頁本身又有很多 query，就會再疊一層 loading。

- **/team、/settings、/brands-channels（#4）**
  - **Team**：`/api/team` + `useQueries` 對**每位成員**打 `/api/team/:id/brand-assignments` → **N+1**；成員多時請求數與 TTFB 累加。
  - **Settings / Brands-channels**：同樣是「整頁 mount → 該頁所有 query 一起跑」；brands-channels 的 BrandChannelManager 還有「每品牌 assigned-agents」的 useQueries，品牌多時也多請求。
  - **共通**：都是**整頁重掛**，沒有共用 layout 或保留上一頁內容的過渡。

- **Comment-center rules 子 tab（#5）**
  - 同頁內 tab 僅 state 切換，**不 remount**，成本低。
  - 但「進入 rules 子頁」若來自側邊欄或從 inbox 點過去，會先觸發 **CommentCenterPage 整顆 remount**（因為路徑從 `/comment-center/inbox` 變為 `/comment-center/rules`），所以體感慢主要來自 #1，不是同頁 tab 本身。

---

## 5. 哪些是「真的慢」、哪些是「感覺慢」

| 類型 | 情境 | 說明 |
|------|------|------|
| **真的慢（API／請求）** | Comment-center 子頁切換、Team 頁、Brands-channels 頁 | 子頁或頁面 mount 時**一次觸發大量或 N+1 請求**；Comment-center 20+ 支、Team 的 N+1、BrandChannelManager 每品牌一檔。 |
| **真的慢（render）** | Comment-center 整顆 remount、Chat 左側大列表 | **CommentCenterPage** 體積大、state 多、子樹重，整顆 remount 成本高；Chat 左側聯絡人 list 長時，每次重 render 的節點數也多。 |
| **感覺慢（loading 體感）** | Chat 切 view、側邊欄切頁、Comment-center 載入中 | **Chat**：切 view 時左側整塊變成「載入中...」，沒有保留上一筆 list；**側邊欄切頁**：main 先空或直接進新頁 loading，無 skeleton／過渡；**Comment-center**：多處僅「載入中...」文字 + Loader，無 skeleton、無與上一狀態延續。 |
| **感覺慢（先清空再載入）** | 所有 route 切換、Comment-center 子頁 | **切 path = 整頁卸載**，沒有「先顯示舊內容再漸換」或 keep-alive，體感像畫面被清空再重畫。 |

---

## 6. 最小優化建議（P1 / P2 / P3）

### P1（必修，對體感與請求數影響最大）

| 項目 | 作法 | 預期效果 |
|------|------|----------|
| **Comment-center 子頁不 remount** | 改為**單一路由**（例如 `/comment-center/:tab?`），只渲染**一顆** CommentCenterPage，子頁由 path 的 segment 決定（現有 `useCommentCenterPage()` 已可依 path 算出 currentPage）。切子頁改為 `Link`/`setLocation` 只改 path，**不換 Route**，同一顆樹不 unmount。 | 切收件匣↔規則↔設定 時不再整顆 remount，不再一次觸發 20+ query；可再搭配下方 enabled 減少無用請求。 |
| **Comment-center 依子頁 enabled** | 在改為單一路由後，為各 useQuery 加上 `enabled`：例如 comments／commentSummary 僅在 `currentPage === "inbox"` 時 enabled；templates、rules、mappings、pageSettingsList 僅在 rules／channel-binding 等相關子頁 enabled；health 可僅在 inbox 或規則頁 enabled。 | 切到某子頁時只打該子頁需要的 API，其餘不發請求。 |
| **Chat 切 view 保留上一筆 list** | 聯絡人 list 的 useQuery 設 **staleTime**（例如 30_000～60_000 ms），並使用 **placeholderData: keepPreviousData**（或 React Query v5 的同等行為）讓切 view 時**先顯示上一筆 list**，背景 refetch，完成後再更新。 | 切「我的案件／待我回覆」時左側不再整塊變成「載入中...」，體感連續。 |
| **Chat contacts 的 staleTime** | 目前該 query 覆寫為 `staleTime: 0`，建議改為例如 15_000～30_000（或至少 5_000），減少無謂 refetch。 | 同一 view 短時間內重複進入不會一直打 /api/contacts。 |

### P2（可排後）

| 項目 | 作法 | 預期效果 |
|------|------|----------|
| **Team N+1 收斂** | 後端提供單一 API（例如 `GET /api/team?include=brand_assignments`）或前端改為一次取回所有成員的 assignments，避免 N 次 `/api/team/:id/brand-assignments`。 | 進入團隊頁時請求數從 N+1 降為 1～2，TTFB 與體感更穩。 |
| **側邊欄切頁的 main 區過渡** | 在 `<main>` 內對 route 切換加一層**最小 loading**：例如在 Switch 外包一層，當 path 變更時短暫顯示 skeleton 或保留上一頁的骨架，等新頁首屏 render 再切換；或使用簡單的 transition 狀態（如 100～200ms 延遲）避免「整塊突然消失」。 | 減少「整塊白／突然清空」的體感。 |
| **invalidate 範圍收斂** | Chat 的 `invalidateContactsAndStats` 使用 `exact: false`，會讓所有 `/api/contacts`、`/api/manager-stats` 被 invalidate，側邊欄與 header 的 stats 也會 refetch。可改為只 invalidate 當前 view 的 queryKey（例如含 selectedBrandId、viewMode 的 key），或拆成「聯絡人列表」與「戰情數字」兩類 key，只 invalidate 需要的。 | 減少因單一操作導致全站多處 refetch 的連鎖反應。 |

### P3（純 polish）

| 項目 | 作法 | 預期效果 |
|------|------|----------|
| **Comment-center 用 skeleton 取代純文字** | 左側列表、右側詳情、規則／模板區塊的「載入中...」改為**區塊型 skeleton**（例如與列表卡片同高的灰色條塊），避免大片空白或單一 spinner。 | 載入過程視覺連續，體感較不中斷。 |
| **Chat 左側列表 skeleton** | 聯絡人 list 在 `contactsLoading` 時改為 5～10 個 list-item skeleton，而非整塊「載入中...」。 | 與 P1 的 keepPreviousData 搭配，首次進入或真正 refetch 時體感更好。 |
| **Prefetch 相鄰路由** | 側邊欄 hover 或 focus 到「留言收件匣／團隊管理」等時，對該頁的**關鍵 query**（如 comment-center 的 commentSummary、team 的 /api/team）做 **prefetchQuery**，不顯示結果，只先填 cache。 | 點進去時有較高機率直接用 cache，首屏更快。 |

---

## 7. 建議優先順序

1. **P1：Comment-center 單一路由 + 不 remount**（解決體感最重的子頁切換與 20+ query 同時觸發）。
2. **P1：Comment-center 依 currentPage 的 enabled**（在單一路由基礎上，進一步減少無用 API）。
3. **P1：Chat 切 view 的 keepPreviousData + staleTime**（解決工作台切 view 的「卡一下」）。
4. **P2：Team N+1 收斂**（若團隊成員多，可明顯減少請求與 TTFB）。
5. **P2：側邊欄切頁 main 區過渡**（減少整塊白／清空體感）。
6. **P2：invalidate 範圍收斂**（降低連鎖 refetch）。
7. **P3：skeleton 與 prefetch**（視時間做 polish）。

---

## 8. 本輪若先做一刀，最值得先改哪一刀？為什麼？

**建議先做：Comment-center 改為單一路由（/comment-center/:tab?），子頁不 remount。**

**理由：**

1. **體感改善最大**：留言中心子頁切換是「整顆大樹 remount + 20+ query」同時發生，改為單一路由後，切子頁只改 path、同一顆 CommentCenterPage 不卸載，立刻消除 remount 與重複觸發全部 query 的成本。
2. **改動範圍可控**：僅動路由定義（App.tsx）與 comment-center 內導航（改為 `Link`/`setLocation` 到 `/comment-center/inbox` 等），不需改後端；必要時可再逐步為各 query 加上 `enabled`。
3. **不影響其他頁**：不動 chat、team、settings 的既有邏輯，風險集中在前端路由與單一頁面。
4. **為後續 enabled 打基礎**：同一顆樹不 remount 後，`currentPage` 只會隨 path 變，方便之後依子頁開關 query，進一步減少請求數。

**若實作，預計會動到的檔案：**

- `client/src/App.tsx`：Comment-center 相關 Route 改為單一 path（例如 `/comment-center/:tab?`），其餘 path 可 redirect 到預設 tab。
- `client/src/pages/comment-center.tsx`：子頁導航改為使用 path（Link 或 setLocation），不再依賴多條獨立 Route；`useCommentCenterPage()` 已依 path 解析 currentPage，可沿用。
- `client/src/components/app-sidebar.tsx`：若目前連到 `/comment-center/inbox`、`/comment-center/rules` 等，改為維持相同 href，僅確保點選後是「改 path」而非換 Route 實例（在 App 改為單一路由後即達成）。

本輪僅做盤點與 spec；若你要先做這一刀，再依上述檔案清單做具體修改即可。
