# 路由與側欄

來源邏輯：`App.tsx`（`GuardedRoute` + `ROUTE_ACCESS`）+ `app-sidebar.tsx`（`allMenuItems`）。

## 登入後 Shell

- **左**：`AppSidebar`（寬約 260px，深色）
- **右**：頂欄 `AppHeader` + `main` 內 `<Switch>` 路由

## 側欄項目（順序；顯示依角色過濾）

| 名稱 | path | 角色 |
|------|------|------|
| 即時客服 | `/` | 全員 |
| 留言收件匣 | `/comment-center/inbox` | 全員 |
| 留言規則與導向 | `/comment-center/rules` | 全員 |
| 粉專與 LINE 設定 | `/comment-center/channel-binding` | 全員 |
| 內測模擬 | `/comment-center/simulate` | 全員 |
| 客服績效 | `/performance` | 全員 |
| AI 與知識庫 | `/knowledge` | 管理、主管 |
| 數據戰情室 | `/analytics` | 管理、主管 |
| 團隊管理 | `/team` | 管理、主管 |
| 品牌與渠道 | `/settings/brands-channels` | 管理、主管 |
| 系統設定 | `/settings` | 管理、主管 |

## 頂欄

- 品牌名稱／logo（設定載入）
- 角色：客服／主管
- 主管：緊急、待分配 摘要
- 通知（連 `/`）、設定（有權限）、登出

## 即時客服與側欄捷徑

- 側欄「我的快捷」與列表上方 **view tab** 共用 **`viewMode`**（`chat-view-context`），導向仍為 `/`。

## 本包對應的 Stitch 頁

| Stitch | path |
|--------|------|
| judgment-home（列表＋空右側或首屏） | `/` |
| support-workbench | `/knowledge` |
