# 路由與側欄結構

來源：`client/src/App.tsx`（`GuardedRoute`、`ROUTE_ACCESS`）、`client/src/components/app-sidebar.tsx`（`allMenuItems`）。

## 側欄結構（依程式順序，實際顯示依 `userRole` 過濾）

| 順序 | 頁面名稱 | path | 用途 | 角色 |
|------|----------|------|------|------|
| 1 | 即時客服 | `/` | 對話列表、對話串、右側脈絡／訂單 | 全員 |
| 2 | 留言收件匣 | `/comment-center/inbox` | 例外監控、AI 處理狀態 | 全員 |
| 3 | 留言規則與導向 | `/comment-center/rules` | 規則、模板、風險與導流 | 全員 |
| 4 | 粉專與 LINE 設定 | `/comment-center/channel-binding` | 渠道綁定一覽 | 全員 |
| 5 | 內測模擬 | `/comment-center/simulate` | 模擬留言／webhook | 全員 |
| 6 | 客服績效 | `/performance` | 個人／團隊績效 | 全員 |
| 7 | AI 與知識庫 | `/knowledge` | AI 與知識管理 | 管理／主管 |
| 8 | 數據戰情室 | `/analytics` | 報表與數據 | 管理／主管 |
| 9 | 團隊管理 | `/team` | 成員、排班、派案 | 管理／主管 |
| 10 | 品牌與渠道 | `/settings/brands-channels` | 品牌、渠道設定 | 管理／主管 |
| 11 | 系統設定 | `/settings` | 全域設定 | 管理／主管 |

## 其他路由

| path | 說明 |
|------|------|
| `/comment-center` | 無 tab 時 redirect 至 `/comment-center/inbox`（或舊 hash 對應） |
| `/login` | 登入（無側欄） |

## 頂欄（AppHeader）

- 品牌名稱／logo、角色顯示（客服／主管）
- 主管：**緊急**、**待分配** 摘要
- **通知**（連到 `/`）、**設定**（有權限者）、**登出**

## 與相鄰頁關係

- **`/` ↔ 側欄「我的快捷」**：同頁切換 `viewMode`（我的案件、待我回覆、緊急…），不改路由。
- **留言中心**：`/comment-center/:tab` 同一頁型，多 tab。
- **設定**：`/settings` 與 `/settings/brands-channels` 分開，後者專注品牌渠道。

## Stitch 四個優先資料夾對應

- `judgment-home` + `judgment-detail` → 皆屬 **`/`** 的 `chat.tsx`（左列表 vs 中右對話＋脈絡）。
- `support-workbench` → **`/knowledge`**
- `support-diagnostics` → **`/performance`**
