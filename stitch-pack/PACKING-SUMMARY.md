# Stitch Pack — 打包摘要

建立時間：2026-03-25（以本檔撰寫日為準）  
Repo 根：`Omni-Agent-Console/`  
打包根目錄：`stitch-pack/`（本次統計 **108** 個檔案，不含 zip 自身）

## 1. 實際打包了哪些內容

| 區域 | 路徑 | 內容 |
|------|------|------|
| 總覽 | `00_overview/` | `README.md`、`ROUTES.md`、`DESIGN.md`、`TARGET-PAGES.md`、`MUST-KEEP.md` |
| App Shell | `01_app_shell/` | `main.tsx`、`App.tsx`、`app-sidebar.tsx`、`login.tsx`、`not-found.tsx` + `README.md` |
| 共用 UI | `02_shared_ui/` | `components/ui/*.tsx`（完整 shadcn 元件集）、`hooks/use-toast.ts`、`use-mobile.tsx`、`lib/utils.ts`、`queryClient.ts`、`brand-context.tsx`、`chat-view-context.tsx` + `README.md` |
| 主題與樣式 | `03_theme_and_styles/` | `index.css`、`tailwind.config.ts`、`components.json` + `README.md` |
| 頁面 | `04_pages/judgment-home/` | `chat.tsx`、`PAGE.md`、`states/*.json`、`screenshots/README.md` |
| 頁面 | `04_pages/judgment-detail/` | `chat.tsx`（與 home 同檔副本）、`PAGE.md`、`states/*.json`、`screenshots/README.md` |
| 頁面 | `04_pages/support-workbench/` | `knowledge.tsx`、`PAGE.md`、`states/*.json`、`screenshots/README.md` |
| 頁面 | `04_pages/support-diagnostics/` | `performance.tsx`、`PAGE.md`、`states/*.json`、`screenshots/README.md` |
| View models | `05_view_models/` | `contact-schema-constants.ts`、`sample_*.masked.json`、`README.md` |
| 素材 | `06_reference_assets/` | `README.md`（logo 多為設定網址動態載入） |

## 2. 刻意排除的內容

- `node_modules/`、`dist/`、`build/`、`coverage/`、`.cache/`、`tmp/`、`logs/`、`uploads/`
- `.env*`、任何 API key、token、cookie、資料庫檔
- **後端** `server/`（本包僅 UI context）
- **未打包**之其他頁面原始碼：`comment-center.tsx`、`settings.tsx`、`brands-channels.tsx`、`team.tsx`、`analytics.tsx` 等（可在第二輪按需補）
- **未複製** `shared/schema.ts`（過大且偏後端型別庫；改以 `05_view_models` 示例＋說明代替）

## 3. 最適合先丟給 Stitch 的頁

1. **`04_pages/judgment-home` + `judgment-detail`** + `01_app_shell` + `02_shared_ui` + `03_theme_and_styles` — 主產品體驗最大面積。  
2. 補上 **`00_overview/TARGET-PAGES.md`** 與 **`MUST-KEEP.md`** 約束改版邊界。

次要輪：`support-workbench`、`support-diagnostics`。

## 4. 尚缺資料或截圖

| 項目 | 狀態 |
|------|------|
| 各頁 `screenshots/current-*.png` | **未附**；請依各頁 `screenshots/README.md` 在本機 dev 截取後補上 |
| `/analytics`、`/team`、`/settings`、`/comment-center/*` | **未含**頁面 tsx；若 Stitch 要改留言中心或設定，需第二輪打包 |
| 真實 API 回應 | 僅 `sample_*.masked.json` 示意 |

## 5. Zip 檔位置

已於 `Omni-Agent-Console` 目錄產生（與 `stitch-pack/` 同層）：

- **`stitch-pack.zip`**（約 **0.2 MB**，無截圖 PNG；補齊截圖後會變大）

若需自行重打包：

```powershell
Set-Location "<repo>/Omni-Agent-Console"
Compress-Archive -LiteralPath .\stitch-pack -DestinationPath .\stitch-pack.zip -Force
```

## 6. 還原路徑對照（給開發者）

副本檔案之 **真實路徑** 多為：

- `client/src/pages/chat.tsx` → `04_pages/judgment-*/chat.tsx`
- `client/src/pages/knowledge.tsx` → `support-workbench/knowledge.tsx`
- `client/src/pages/performance.tsx` → `support-diagnostics/performance.tsx`
- `client/src/App.tsx` → `01_app_shell/App.tsx`
- `client/src/components/ui/*` → `02_shared_ui/components/ui/*`
