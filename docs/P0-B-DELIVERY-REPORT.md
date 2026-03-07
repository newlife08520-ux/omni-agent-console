# P0-B 交付報告 — Settings / Brands-Channels / Team-Assignment 職責切分

## 1. 完成狀態

- **已完成**
  - A1：從 settings 移出品牌管理、渠道管理、粉專/LINE 綁定相關、派案規則、排班。
  - A2：建立「Brands / Channels」模組：新頁 `/settings/brands-channels`、BrandChannelManager 元件、品牌/渠道/連線測試/健康檢測。
  - A3：建立「Team / Assignment」模組：/team 擴充排班區塊（ScheduleForm）、派案規則區塊（AssignmentRulesForm）。
  - A4：settings 僅保留系統全域設定（外觀、迎賓、轉人工、標籤、API 金鑰、測試模式、一頁商店等），並加引導文案。
  - A5：路由與頁面職責清楚：/settings、/settings/brands-channels、/team 分離；sidebar 新增「品牌與渠道」。
  - Step 1 Review / Spec-check（見 P0-B-REVIEW-SPEC.md）、Step 2 Implementation Plan（見 P0-B-IMPLEMENTATION-PLAN-V2.md）、Step 3 實作、Step 4 自我驗收（build 通過）、本文件。

- **部分完成**
  - 無。

- **未完成**
  - 無。

- **刻意保留未做**
  - 未改 comment-center、chat、analytics、knowledge 結構；未改後端 API path/response；未做 UI 視覺大改；未開新 perf 支線。負載/技能標籤未在本輪實作，僅將人員與排班、派案規則整合於同一頁。

---

## 2. Review / Spec-check 摘要

- **現況問題**：settings 為萬用頁，同時塞入品牌、渠道、排班、派案、API 金鑰等；team 僅有成員，排班與派案在 settings，責任分散。
- **為什麼這樣拆**：系統級設定（金鑰、外觀、迎賓、轉人工）與營運級設定（品牌、渠道、排班、派案）分離；品牌/渠道與團隊/派案各自成模組，利於擴充與維護。
- **這輪邊界**：只動 settings、team、品牌/渠道/派案/排班相關前端與 route；不碰 chat/analytics/knowledge/comment-center 結構、不重構整個後端、不改 API 契約。

---

## 3. Implementation Plan 摘要

- **新 route / sitemap**
  - `/settings`：系統設定（精簡）。
  - `/settings/brands-channels`：品牌與渠道（新）。
  - `/team`：團隊管理（含成員、排班、派案規則）。

- **settings 移出清單**
  - BrandChannelManager（品牌工作區 + 渠道管理）→ `/settings/brands-channels`。
  - 人工客服服務時段（ScheduleForm）→ `/team`。
  - 客服分配規則（AssignmentRulesForm）→ `/team`。

- **brands/channels 頁面規劃**
  - 單頁「品牌與渠道」，標題與副標一致；僅 super_admin 可操作 BrandChannelManager，其餘顯示「僅管理員可管理」；沿用 useBrand、既有 brands/channels API。

- **team/assignment 頁面規劃**
  - /team 保留成員列表與 CRUD；新增「人工客服服務時段」「客服分配規則」兩區塊，使用 ScheduleForm、AssignmentRulesForm；sidebar 描述改為「成員、排班與派案規則」。

- **相容策略**
  - /settings 不 redirect，內容縮為系統設定，頁頂說明「品牌與渠道請至左側選單『品牌與渠道』；排班與派案請至『團隊管理』」。
  - /team 不 redirect，僅增加區塊。
  - 無舊 URL 破壞。

---

## 4. 本輪修改摘要

| 檔案 | 改動 |
|------|------|
| client/src/App.tsx | 新增 BrandsChannelsPage import、ROUTE_ACCESS["/settings/brands-channels"]、GuardedRoute /settings/brands-channels（置於 /settings 前）。 |
| client/src/components/app-sidebar.tsx | 新增選單「品牌與渠道」→ /settings/brands-channels，roles 同系統設定；團隊管理 desc 改為「成員、排班與派案規則」。 |
| client/src/pages/settings.tsx | 移除 StatusDot/StatusBadge/ScheduleForm/AssignmentRulesForm/BrandChannelManager 內聯定義及品牌/排班/派案區塊；改為 import StatusBadge、HealthStatus、HealthEntry 自 brand-channel-manager；副標加引導至品牌與渠道、團隊管理。 |
| client/src/pages/team.tsx | 已有 ScheduleForm、AssignmentRulesForm import 與「人工客服服務時段」「客服分配規則」兩區塊（本輪確認存在）。 |
| client/src/pages/brands-channels.tsx | **新建**。標題「品牌與渠道」，依 auth 判斷 isSuperAdmin，渲染 BrandChannelManager 或「僅管理員可管理」。 |
| client/src/components/brand-channel-manager.tsx | **新建**。自 settings 移出之 StatusDot、StatusBadge、BrandChannelManager（品牌/渠道 CRUD、連線測試、健康檢測、Dialog）。 |
| client/src/components/schedule-form.tsx | **已存在**（先前建立）。自 settings 抽出，供 team 使用。 |
| client/src/components/assignment-rules-form.tsx | **已存在**（先前建立）。自 settings 抽出，供 team 使用。 |

**未改動**：brand-context、comment-center、server routes、API 契約。（git status 中其他 modified 為既有變更，非本輪必要部分。）

---

## 5. 驗收結果

- **build / run**
  - `npm run build` 通過（client + server 建置成功）。server 有一既存 warning（getChannelByBotId），與 P0-B 無關。

- **已驗頁面與功能**
  - 結構與編譯：/settings、/settings/brands-channels、/team 之 route 與元件引用正確；settings 已無 BrandChannelManager/排班/派案區塊；team 含排班與派案區塊；brands-channels 頁與 BrandChannelManager 存在。
  - Lint：已檢查 settings、brands-channels、App、app-sidebar，無新增 linter 錯誤。

- **建議手動回歸**
  - localhost 啟動後：進入 /settings、/settings/brands-channels、/team；確認 brands-channels 僅 super_admin 可操作、排班與派案表單可儲存；舊 /settings 可進、無 404；無明顯 console/query 錯誤。

- **風險點**
  - 若曾直接將「設定頁最上面是品牌」當成使用習慣，需引導至「品牌與渠道」；已以 settings 頁頂文案處理。
  - ROUTE_ACCESS 與 sidebar 已同步，權限一致。

- **是否適合進 PR / merge**
  - 結構與 build 已就緒，建議在 localhost 完成上述手動回歸後再開 PR、合併。

---

## 6. 自我檢查

- **命名**：Brands/Channels、Team/Assignment、Settings 與文件一致；sidebar「品牌與渠道」「團隊管理」與頁面標題對齊。
- **文件**：P0-B-REVIEW-SPEC.md、P0-B-IMPLEMENTATION-PLAN-V2.md、本 P0-B-DELIVERY-REPORT.md 已齊。
- **範圍**：未改 chat、analytics、knowledge、comment-center 結構；未改後端 API；未做 UI 大改。
- **API / route**：未刪、未改既有 API path 與 response；僅新增 route /settings/brands-channels，舊 /settings、/team 仍有效。
- **UI / 資料流**：BrandChannelManager 仍用 useBrand、既有 queryKey；ScheduleForm/AssignmentRulesForm 之 API 與 queryKey 未變，僅引用位置改為 team。
- **不放心的點**：無。建議上線前再跑一次完整手動流程（含表單儲存與權限）。

---

## 7. 後續建議

- 本輪結束後下一步：在 localhost 完成手動回歸 → 僅將 P0-B 相關檔案納入 commit → 開 PR → 合併。
- 後續可考慮（非本輪）：負載/技能標籤、brands-channels 子路由（若需多頁）、或進一步收斂 settings 未使用之 icon import。
- 不要在本輪內直接開始下一階段開發。

---

## Git / branch

- **Branch**：`p0b-settings-brands-team-split`
- **建議納入 P0-B commit 的檔案**
  - client/src/App.tsx  
  - client/src/components/app-sidebar.tsx  
  - client/src/components/brand-channel-manager.tsx  
  - client/src/components/schedule-form.tsx  
  - client/src/components/assignment-rules-form.tsx  
  - client/src/pages/settings.tsx  
  - client/src/pages/team.tsx  
  - client/src/pages/brands-channels.tsx  
  - docs/P0-B-REVIEW-SPEC.md  
  - docs/P0-B-IMPLEMENTATION-PLAN-V2.md  
  - docs/P0-B-DELIVERY-REPORT.md（本文件）
- **最新 commit hash / push 狀態**：目前變更尚未 commit；自我驗收完成後請依上列清單 add/commit，再 push 並回報 hash 與 push 狀態。
