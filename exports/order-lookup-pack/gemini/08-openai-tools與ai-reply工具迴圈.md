# 08 — `openai-tools.ts` 與 `ai-reply.service.ts`（工具迴圈）

## `openai-tools.ts`

- 定義各 **Function schema**（名稱、description、parameters）。  
- 查單類工具的 **description** 通常要求：先對客人說一句再呼叫、或不可只呼叫不說話等（與轉人工 `transfer_to_human` 類似）。  
- 修改此檔會影響 **模型選工具** 的傾向，需與 `prompt-builder`／Persona 一併檢視（此包含 `PHASE97_MASTER_SLIM.txt`）。

## `ai-reply.service.ts`（體量大，重點閱讀方式）

建議搜尋以下關鍵字：

- **`lookup_order`**：工具結果解析、查無訂單 alert、`orderLookupFailed` 等。  
- **`deterministicCandidates`** / **`isValidOrderDeterministicPayload`**：從多個 tool result 挑 **最後一筆** deterministic 候選（Phase 26 行為）。  
- **`second_llm_skipped`** / **`orderLookupDeterministicReply`**：略過第二輪模型、直接對客。  
- **`needs_human`** / **`buildHandoffReply`**：轉人工後不再由 AI 回一般文字（與查單路徑交錯時要注意）。  
- **`enqueueDebouncedAiReply`**（在 routes／webhook）：實際觸發本 service 的入口之一。

## 與客人看到的訊息

管線末端通常會：

1. `storage.createMessage(..., "ai", text)`  
2. `pushLineMessage` / `sendFBMessage`  
3. `broadcastSSE` 更新後台

Deterministic 路徑下 **文字內容** 多來自 **`deterministic_customer_reply`**，與純 LLM 自由生成不同。

下一篇：**09** 索引、政策、feature flags、multi 選擇。
