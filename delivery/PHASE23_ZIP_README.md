# Phase 2.3 交付 ZIP

## 檔案位置

- **檔名**：`Omni-Agent-Console-PHASE23-LATEST.zip`
- **路徑**：與 `Omni-Agent-Console` 專案資料夾**同層**  
  例：`d:\Omni-Agent-Console(自動客服系統)\Omni-Agent-Console-PHASE23-LATEST.zip`

## 內容與排除

- **包含**：完整原始碼（`server/`、`client/`、`shared/`、`docs/`、`script/` 等）
- **排除**：`node_modules`、`.git`、`dist`、`uploads`、`data/`、`data_coldstart/`、主檔 `*.db`、`.env`、`.local`、`.replit`

## 解壓後步驟

```bash
npm install
cp .env.example .env   # 依實際填寫
npm run verify:phase23
```

## 驗收報告

- **`docs/PHASE2_3_ACCEPTANCE_REPORT.md`**
- **`docs/PHASE2_3_FINAL_GAP_FIX_REPORT.md`**（Shopline 商品過濾、圖片查單、本地多筆 deterministic、驗證腳本）

## 選跑（需憑證）

```bash
npm run sync:orders
npm run derive:aliases
npm run stats:order-index
```
