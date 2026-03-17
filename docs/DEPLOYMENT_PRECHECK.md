# 部署前檢查（DEPLOYMENT_PRECHECK）

正式部署時請依此流程，避免環境與產物不一致。

## 重要原則

- **不可把本機 `node_modules` 打包進部署檔**：Windows / Linux 不可共用，且 esbuild 等含原生 binary，平台不符會導致執行失敗。
- **目標環境必須自己安裝依賴**：在部署目標（如 Railway、自建機）上執行 `npm ci`。
- **build 前建議清空**：避免殘留舊產物。

## 建議流程

1. **清空（可選）**
   ```bash
   npm run clean
   # 或手動：rm -rf node_modules dist
   ```

2. **安裝依賴**
   ```bash
   npm ci
   ```

3. **型別檢查**
   ```bash
   npm run check
   ```

4. **建置**
   ```bash
   npm run build
   ```
   產物應包含：
   - `dist/index.cjs`（主站）
   - `dist/workers/ai-reply.worker.cjs`（AI 回覆 Worker）
   - `dist/public/`（前端靜態）

5. **啟動主站**
   ```bash
   npm run start
   ```

6. **啟動 Worker（獨立進程）**
   ```bash
   npm run start:worker
   ```
   Worker 需與主站共用 `REDIS_URL`、`INTERNAL_API_SECRET`，並設定 `INTERNAL_API_URL` 指向主站。詳見 `.env.example`。

## Railway 注意

- 若 Worker 為獨立 Service：Build 指令與主站相同（例如 `npm ci && npm run build`），Start 指令為 `npm run start:worker`。
- 環境變數 `INTERNAL_API_SECRET`、`INTERNAL_API_URL` 務必在 Worker 的 Service 內設定，且與主站一致。
