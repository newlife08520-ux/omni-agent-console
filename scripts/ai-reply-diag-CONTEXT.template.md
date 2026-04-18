# 診斷匯出背景（CONTEXT）

## 事故摘要

自 **4/13** 起，**兩個品牌**同時受影響：**AQUILA（天鷹座）**的 AI 回覆異常／失效；**私藏**品牌的 AI 為關閉狀態（非本次全系統不回之主因，但需一併知悉）。

## 已完成的修復（Phase 106.20 ~ 106.25.2 摘要）

- **106.20**：LINE channel access token 健康檢查（`/v2/bot/info`）、相關告警與啟動節流。
- **106.20.1**：LINE／發送 API 錯誤改為寫入告警與 log 後**不 throw**，避免 webhook／AI 管線整段中斷（LINE 仍應回 200）。
- **106.25**：BullMQ 在**固定 jobId** 下，若 **completed** 殘留導致 `Queue.add` **靜默 no-op**；改為跑完主動 **remove** 釋放 jobId，並讓非 2xx 拋錯使 job 進入 failed／retry（避免靜默吞掉）。
- **106.25.2**：於 `autoReplyWithAI` 入口與多處早退加上 **`[AI-DIAG]`** 結構化 log，用於對照 worker 端 **`[Worker] sent`** 與實際是否進入 AI 服務層。

## 當前症狀

- **全系統 AI 都不回**。
- **新訊息在前端找不到**。
- 前端有**黃色警告**（**Bot ID 不匹配** 類）。
- 後台可見**部分舊客人**有 **`AI:`** 開頭的歷史回覆，但**新客人**皆無回覆。

## 已排除的假設

- **jobId 碰撞**（Bug 1）已修。
- **loopback silent swallow**（Bug 2）已修。
- **Worker 有啟動**。
- **Redis 連得上**。
- **Job 會進 completed**（仍與「不回／前端看不到」並存，需再釐清鏈路）。

## 關鍵矛盾

日誌上 **`[Worker] sent`** 會印，但 **`[AI-DIAG] ENTER`** 不印。懷疑 **production bundle 未包含 Phase 106.25.2 的 diag log**（部署版本與原始碼不一致、或建置／快取導致舊 bundle），需交叉驗證部署產物與執行中程式版本。

## 最近 5 個 commit hash

__COMMIT_BLOCK__

## 本 ZIP 注意事項

- **未**包含：`.env`、`node_modules`、`dist`、任何 `*.db`、以及任何已知含 secret 的檔案。
- 若專案無 `server/webhook/`，可能改以 `server/controllers/line-webhook.controller.ts` 代表 LINE Webhook 入口（請以實際匯出檔案清單為準）。
- 若無 `gemini.service.ts`，匯出含 `server/services/ai-client.service.ts`（內含 `@google/generative-ai`／Gemini 呼叫）。
