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
