---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包
檔案用途: Admin 與 Debug API 清單（core.routes.ts）；完整碼見 08-admin-core.routes.md
---

# 08 — Admin 端點索引

## 完整原始碼

請開啟同目錄 **08-admin-core.routes.md**（`server/routes/core.routes.ts` 全文）。

## core.routes 內常見 admin 路由（摘要）

- POST `/api/admin/sync-products`（auth）
- GET `/api/admin/products/:brandId`、GET `.../search`（auth）
- POST `/api/admin/products/:brandId/bulk`（super_admin）
- POST `/api/admin/refresh-profiles`（super_admin）
- GET/PUT `/api/admin/brands/:brandId/form-urls`（auth）
- GET `/api/admin/prompt-status`、POST `/api/admin/force-sync-prompt`（auth）
- GET `/api/admin/contact-state/:id`（superAdminOrDebugToken）
- GET `/api/admin/conversation-export`（superAdminOrDebugToken；query: brand_id, date, format）
- GET `/api/admin/lookup-contacts-by-names`（superAdminOrDebugToken）
- GET `/api/admin/brand-readiness`（superAdminOrDebugToken）
- POST `/api/admin/clone-brand-config`（superAdminOrDebugToken；dry_run 預設 true）
- POST `/api/admin/reset-contact/:id`（superAdminOrDebugToken）
- POST `/api/admin/sync-orders`（super_admin）
- POST `/api/admin/trigger-deep-sync`、POST `/api/admin/trigger-idle-close-now`（superAdminOrDebugToken）
- GET `/api/admin/business-hours-status`（superAdminOrDebugToken）
- POST `/api/admin/sync-prompts`（session super_admin）

## 其他檔案

`settings-brands.routes.ts`、`contacts-orders.routes.ts`、`meta-comments.routes.ts` 等可能還有 `/api/admin` 路由，請全域搜尋字串 `/api/admin`。

## Debug

同檔含 `/api/debug/status`、`/api/debug/runtime` 等，見 08-admin-core.routes.md 內文。
