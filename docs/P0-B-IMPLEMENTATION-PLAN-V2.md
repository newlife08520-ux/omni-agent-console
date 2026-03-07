# P0-B Implementation Plan（實作藍圖）

## 1. 新 sitemap / route map

| Route | 頁面 | 職責 | 權限 |
|-------|------|------|------|
| /settings | SettingsPage（精簡） | 系統名稱/Logo、測試模式、迎賓、轉人工、標籤、API 金鑰、一頁商店預設 | super_admin, marketing_manager |
| /settings/brands-channels | BrandsChannelsPage（新） | 品牌 CRUD、渠道 CRUD、連線測試、健康檢測、同步頭貼 | super_admin, marketing_manager |
| /team | TeamPage（擴充） | 成員、角色、頭像、**排班（ScheduleForm）**、**派案規則（AssignmentRulesForm）** | super_admin |

## 2. settings 移出清單

- 整塊 **BrandChannelManager**（品牌工作區管理 + 渠道管理）→ 移至 /settings/brands-channels。
- **section-schedule** + ScheduleForm → 移至 /team。
- **section-assignment-rules** + AssignmentRulesForm → 移至 /team。

## 3. brands/channels 模組頁面規劃

- **單一頁**：/settings/brands-channels，標題「品牌與渠道」。
- **內容**：與現有 BrandChannelManager 一致（品牌列表與 CRUD、所選品牌下渠道列表與 CRUD、連線測試、商店/SHOPLINE 測試、同步 LINE 頭貼、全部檢測）。
- **資料**：沿用 useBrand()、/api/brands、/api/brands/:id/channels、既有 channels 相關 API；不新增 API。
- **元件**：自 settings 移出 BrandChannelManager 及其依賴（StatusDot、StatusBadge）至新頁或共用元件；本輪採「新頁內含完整 UI」以減少抽換風險。

## 4. team/assignment 模組頁面規劃

- **單一頁**：/team，標題維持「團隊管理」或改為「團隊與派案」；副標註明含成員、排班、派案規則。
- **內容**：現有成員列表與 CRUD、角色、頭像；**新增**兩區塊：「人工客服服務時段」（ScheduleForm）、「客服分配規則」（AssignmentRulesForm）。
- **資料**：/api/team 不變；ScheduleForm 用 /api/settings/schedule，AssignmentRulesForm 用 /api/settings/assignment-rules；不新增 API。
- **元件**：ScheduleForm、AssignmentRulesForm 自 settings 抽出為獨立元件，於 team 頁 import 使用。

## 5. 舊頁面到新頁面對照

| 舊位置 | 新位置 |
|--------|--------|
| settings 最上「品牌工作區管理」+「渠道管理」 | /settings/brands-channels 整頁 |
| settings「人工客服服務時段」 | /team 區塊「人工客服服務時段」 |
| settings「客服分配規則」 | /team 區塊「客服分配規則」 |
| settings 其餘 | /settings 保留 |

## 6. 相容 / redirect / alias

- **/settings**：不 redirect，仍為同一 route；內容改為僅系統設定，舊書籤有效但內容變少。必要時在 settings 頁頂加一句「品牌與渠道請至左側選單 → 品牌與渠道」。
- **/team**：不 redirect，同一 route；內容增加排班與派案，無破壞。
- 不新增 /brands-channels 別名（僅 /settings/brands-channels），以維持「設定底下子區」語意。

## 7. 會改到的檔案清單

| 檔案 | 改動 |
|------|------|
| client/src/pages/settings.tsx | 移除 BrandChannelManager、移除 schedule 區塊、移除 assignment 區塊；保留其餘；必要時加一句引導至品牌與渠道。 |
| client/src/pages/team.tsx | 新增排班區塊（ScheduleForm）、派案規則區塊（AssignmentRulesForm）；副標或標題可微調。 |
| client/src/pages/brands-channels.tsx | **新建**。內含原 BrandChannelManager 之 UI 與邏輯（或抽成元件後僅組裝）；需 useBrand、既有 brands/channels API。 |
| client/src/components/schedule-form.tsx | **新建**。自 settings 抽出 ScheduleForm。 |
| client/src/components/assignment-rules-form.tsx | **新建**。自 settings 抽出 AssignmentRulesForm。 |
| client/src/App.tsx | 新增 route /settings/brands-channels → BrandsChannelsPage；ROUTE_ACCESS 新增該 path，權限同 settings。 |
| client/src/components/app-sidebar.tsx | 新增選單項「品牌與渠道」→ /settings/brands-channels。 |

## 8. 風險點

- BrandChannelManager 體積大，搬移時需帶齊 state、dialog、query、invalidate，避免漏掉導致白屏或儲存失敗。
- ScheduleForm / AssignmentRulesForm 抽出後，settings 不再引用；team 引用時需確認 queryKey 與 API 路徑不變。
- Sidebar 與 ROUTE_ACCESS 需同步，否則 403 或選單不一致。

## 9. 驗收清單

- [ ] /settings 僅顯示系統設定（無品牌、渠道、排班、派案）。
- [ ] /settings/brands-channels 顯示品牌與渠道完整功能，可新增/編輯/刪除、連線測試、健康檢測。
- [ ] /team 顯示成員列表 + 排班區塊 + 派案規則區塊，排班與派案可儲存。
- [ ] Sidebar 有「品牌與渠道」並指向 /settings/brands-channels。
- [ ] 權限：brands-channels 同 settings；team 仍僅 super_admin。
- [ ] 舊 /settings 可進、不 404；無明顯 console/query 錯誤；build 通過。
