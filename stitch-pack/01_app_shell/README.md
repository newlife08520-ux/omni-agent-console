# App Shell

| 檔案 | 來源（repo） |
|------|----------------|
| `main.tsx` | `client/src/main.tsx` — React 入口、Provider 掛載 |
| `App.tsx` | `client/src/App.tsx` — 路由、`GuardedRoute`、`AppHeader`、登入／主 shell |
| `app-sidebar.tsx` | `client/src/components/app-sidebar.tsx` — 側欄導航、品牌選單、角色摘要 |
| `login.tsx` | `client/src/pages/login.tsx` |
| `not-found.tsx` | `client/src/pages/not-found.tsx` |

權限：`ROUTE_ACCESS` 於 `App.tsx`；側欄項目以 `roles` 過濾，與後端 session 角色一致（此包不含後端）。
