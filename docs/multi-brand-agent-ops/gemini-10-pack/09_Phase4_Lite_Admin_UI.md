# 合併來源：`LITE_ADMIN_INFORMATION_ARCHITECTURE.md` + `UI_SCOPE_AND_NON_GOALS.md`（全文）

---

# 第一部分：`LITE_ADMIN_INFORMATION_ARCHITECTURE.md`

# Phase 4 — Lite Admin 資訊架構

---

## 1. 導覽結構（建議）

```
品牌中心
├── 品牌列表 / 啟用
├── 渠道狀態（連結至 brands-channels）
└── 目前 Live 版本摘要

Agent / 情境
├── 四情境分頁
├── 每情境：prompt 片段、工具 allow list、知識策略
└── （可選）預覽「有效 prompt 字數」

發布中心
├── 草稿編輯
├── 與 Live diff（簡要）
├── 發布 / 歷史 / 回滾

對話除錯
└── （連結 chat 側欄或內嵌說明）
```

---

## 2. 與現有頁面對應

| 新區塊 | 現有頁面 | 策略 |
|--------|-----------|------|
| 品牌列表 | `brands-channels.tsx` | **擴充**欄位：Live version、Agent Ops 開關 |
| 全域設定 | `settings.tsx` | 加警語：長 SOP 建議搬到 Scenario |
| 知識 | `knowledge.tsx` | 加 scenario tags（若 Phase 1 有欄位） |
| 發布 | 無 | **新頁**或 brands 下子路由 `/brands/:id/agent-ops` |

---

## 3. 資料流

- Admin **只碰** draft API；Runtime **只讀** published。  
- 儲存後提示「尚未發布不影響線上」。

---

## 4. 權限（最小）

- 編輯 draft：marketing_manager + super_admin（**待與你方角色對齊**）。  
- publish / rollback：super_admin。

---

## 5. 效能

- 編輯器不需即時呼叫 OpenAI；**預覽字數**可本地計算。

---

# 第二部分：`UI_SCOPE_AND_NON_GOALS.md`

# UI 範圍與非目標（Phase 4）

---

## 範圍（要做）

- 內部可讀、可管、可查的 **表單式** UI（Radix/shadcn 既有元件）。  
- 品牌級開關、情境分頁、工具多選、發布按鈕、歷史列表。  
- 對話頁 **除錯抽屜**（見 `DEBUG_VIEW_REQUIREMENTS.md`）。

---

## 非目標（不做）

- 拖拉畫布、節點連線、視覺化 workflow。  
- 多語系 Admin 完整 i18n（可先 zh-TW）。  
- 行動版完美適配（內部後台可用桌面優先）。  
- 即時協作編輯（cursors）。  
- 顧客端任何改動。

---

## 視覺

- 沿用現有 design token；**不**為本專案重做品牌視覺。

---

## 成功標準（UI）

- 營運可在 **5 分鐘內**找到：這品牌 Live 是哪一版、誰發布、四情境工具各是什麼。  
- 客服可在 **1 分鐘內**從對話開除錯：本則 scenario、tools、source。
