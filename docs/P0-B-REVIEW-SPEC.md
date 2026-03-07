# P0-B Review / Spec-check

## 1. settings 現有區塊（由上而下）

| 區塊 | data-testid / 元件 | API / 資料 | 歸類建議 |
|------|---------------------|------------|----------|
| 品牌工作區管理 | section-brand-management | /api/brands, useBrand | **移出 → Brands/Channels** |
| 渠道管理（所選品牌下） | section-channel-management | /api/brands/:id/channels, 連線測試 | **移出 → Brands/Channels** |
| 安全測試模式 | — | formValues.test_mode, PUT /api/settings | **保留 Settings** |
| 品牌外觀設定 | — | system_name, logo_url, PUT /api/settings | **保留 Settings**（系統級） |
| LINE 迎賓與快捷按鈕 | section-welcome-settings | welcome_message, quick_buttons | **保留 Settings** |
| 智能轉人工觸發 | section-human-transfer | human_transfer_keywords | **保留 Settings** |
| 快速選取常駐標籤 | section-tag-shortcuts | /api/settings/tag-shortcuts | **保留 Settings** |
| 人工客服服務時段 | section-schedule | ScheduleForm, /api/settings/schedule | **移出 → Team/Assignment** |
| 客服分配規則 | section-assignment-rules | AssignmentRulesForm, /api/settings/assignment-rules | **移出 → Team/Assignment** |
| API 金鑰（OpenAI 等） | — | formValues, PUT /api/settings, test-connection | **保留 Settings** |
| 一頁商店預設 | section-superlanding | superlanding_merchant_no, access_key | **保留 Settings** |

## 2. 系統級 vs 營運級

- **系統級（留 settings）**：系統名稱/Logo、測試模式、API 金鑰與連線測試、迎賓/轉人工/標籤、一頁商店預設。不常改、或屬安全/整合層。
- **營運級（移出）**：品牌 CRUD、渠道 CRUD、排班、派案規則。日常營運配置，與「人」與「品牌/渠道」綁在一起。

## 3. 應歸 Brands/Channels 的內容

- 品牌清單、新增/編輯/刪除品牌、品牌欄位（含商店/SHOPLINE、system_prompt、return_form_url 等）。
- 所選品牌下渠道清單、新增/編輯/刪除渠道、連線測試、同步 LINE 頭貼、全部檢測。
- 相關 API：GET/POST/PUT/DELETE /api/brands、GET/POST /api/brands/:id/channels、PUT /api/channels/:id、POST /api/channels/:id/test、POST /api/brands/:id/test-superlanding|test-shopline、GET /api/health/status、POST /api/admin/refresh-profiles。
- **粉專/LINE 綁定**：comment-center 的 channel-binding 已是「粉專導向哪個 LINE」的檢視與設定，與渠道 CRUD 不同；本輪僅把「品牌+渠道 CRUD」移出 settings，不更動 comment-center。

## 4. 應歸 Team/Assignment 的內容

- 成員列表、新增/編輯/刪除、頭像、角色（現有 /team）。
- **排班**：客服時段（ScheduleForm）— /api/settings/schedule。
- **派案規則**：SLA、自動分配、逾時重分配（AssignmentRulesForm）— /api/settings/assignment-rules。
- 本輪不新增「負載/技能標籤」後端，僅把「人員」與「排班、派案規則」放在同一頁（/team），產品心智上整合為 Team / Assignment。

## 5. team 現況與缺口

- **現有**：/team 有成員 CRUD、角色、頭像、在線/負載顯示；API /api/team、/api/team/available-agents。
- **缺口**：排班、派案規則仍在 settings，使用者需兩邊跑。本輪把 ScheduleForm、AssignmentRulesForm 搬到 team 頁，不新增 API。

## 6. 現有 route / sidebar / 頁面標題

- **Route**：/settings → SettingsPage，/team → TeamPage。無 /settings/brands-channels。
- **Sidebar**：系統設定 → /settings，團隊管理 → /team。無「品牌與渠道」獨立項。
- **頁面標題**：settings 為「系統設定」，team 為「團隊管理」。本輪新增「品牌與渠道」頁標題，team 可改為「團隊與派案」或維持「團隊管理」並在副標註明含排班與派案。

## 7. 可重用元件

- **ScheduleForm**、**AssignmentRulesForm**：目前僅在 settings.tsx 內，可抽出為獨立元件供 team 使用。
- **BrandChannelManager**：大區塊（含 dialog、表單、health），可整塊移至 brands-channels 頁或抽出為單一元件置於該頁；StatusDot、StatusBadge 為其依賴，一併移或共用。

## 8. 後端 endpoint

- 已有：/api/settings、/api/settings/schedule、/api/settings/assignment-rules、/api/settings/tag-shortcuts、/api/brands、/api/brands/:id/channels、/api/channels、/api/team、/api/health/status、/api/admin/refresh-profiles。**本輪不新增、不刪、不改 response shape**，僅前端路由與頁面責任調整。

## 9. 搬家時易壞點

- **query key**：brands、channels 的 invalidate 在 settings 內多處，搬至 brands-channels 後需保留相同 queryKey，避免 cache 錯亂。
- **useBrand()**：BrandChannelManager 依賴 selectedBrandId、brands、setSelectedBrandId；新頁仍須在 BrandProvider 下，或同層消費 useBrand。
- **表單 state**：品牌/渠道 dialog 的開關、editingBrand/editingChannel、healthStatus 等，整塊搬移時一併帶走，避免漏 state。
- **權限**：BrandChannelManager 目前 if (!isSuperAdmin) return null；新頁僅 super_admin / marketing_manager 可進，與現有 settings 權限一致即可。

## 10. 風險點

- 舊書籤 /settings 仍有效，但不再含品牌/渠道/排班/派案，需在文件或 UI 提示「品牌與渠道」與「團隊與派案」新位置。
- 若有人直接記住「設定頁最上面是品牌」，會發現變成系統設定；可於 settings 頁頂加一句「品牌與渠道請至左側選單 → 品牌與渠道」。
- 不破壞 chat、analytics、knowledge、comment-center；不更動後端 API 契約。
