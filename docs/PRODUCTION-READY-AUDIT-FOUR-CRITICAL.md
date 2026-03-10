# 商業級高可用性 — 四大死穴總體檢報告

針對每日 700～1000 則多通路客服訊息的正式環境，完成以下四項關鍵體檢與修復。

---

## 1. SQLite 併發鎖死防護 ✅ 已補齊

### 體檢結果

| 項目 | 狀態 | 說明 |
|------|------|------|
| `PRAGMA journal_mode = WAL` | ✅ 已有 | `server/db.ts` 第 10 行，開機即設定 |
| `PRAGMA busy_timeout` | ⚠️ **原本缺失** | 未設定時，併發寫入易出現 "database is locked" 直接失敗 |

### 修復內容

**檔案：`server/db.ts`**

在既有 `journal_mode = WAL`、`foreign_keys = ON` 之後新增：

```ts
/** 併發時若 DB 被鎖定，最多等待 5 秒再重試，避免 "database is locked" 直接當機（商業級必備） */
db.pragma("busy_timeout = 5000");
```

效果：背景 AI 寫入與前端客服讀取同時發生時，SQLite 會等待最多 5 秒取得鎖定，而非立即拋錯導致請求失敗或當機。

---

## 2. 單執行緒 CPU 阻塞（Event Loop） ✅ 已具備

### 體檢結果

**檔案：`server/superlanding.ts`**

一頁商店／銷售頁同步（近 4000 筆、133 頁 API）已全面加入 Event Loop 讓出：

| 迴圈位置 | 讓出方式 | 行號參考 |
|----------|----------|----------|
| `fetchPages` 每處理完一頁 | `await yieldEventLoop(300)` | 約 298 |
| `lookupOrdersByPageAndPhone` 日期區間內層 while | `await yieldEventLoop(300)` | 約 391 |
| `lookupOrdersByPageAndPhone` 一般分頁 while | `await yieldEventLoop(300)` | 約 424 |
| `lookupOrdersByPhone` 每批 Promise.all 後 | `await yieldEventLoop(300)` | 約 539 |

輔助函式：

```ts
function yieldEventLoop(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

無需再修改，已可避免單一巨大迴圈霸佔 CPU 導致 TTFB 飆高或假死數十秒。

---

## 3. 背景 AI 任務崩潰防護 ✅ 已加強

### 體檢結果

**位置：`GET /api/contacts/:id` 內之 `setImmediate`（約 2411 行）**

- 背景任務已包在 `try { ... } catch (_) {}` 內，**不會**因 `suggestAiFromMessages` 或 `updateContactAiSuggestions` 拋錯而導致 Unhandled Promise Rejection 或行程退出。
- `suggestAiFromMessages` 為純同步、僅讀 DB 與正則，**不呼叫 OpenAI**，因此無額外網路超時或第三方崩潰風險。

### 修復內容（可觀性）

將 `catch (_) {}` 改為記錄錯誤，方便正式環境排查：

```ts
} catch (e: any) {
  console.error("[contacts/:id] background AI suggestion error:", e?.message ?? e);
}
```

不影響穩定性，僅提升可觀性。

---

## 4. 記憶體洩漏（SSE 連線清理） ✅ 已防禦

### 體檢結果

**檔案：`server/routes.ts`，SSE 註冊與廣播**

| 項目 | 狀態 | 說明 |
|------|------|------|
| 連線加入 | `sseClients.add(res)` | 僅在 `/api/events` 建立連線時加入 |
| 關閉時移除 | `req.on("close", removeClient)` | 已有，前端關閉分頁／導向會觸發 |
| 寫入失敗時移除 | `broadcastSSE` 內 `catch { sseClients.delete(client) }` | 已有，寫入失敗即從 Set 移除 |
| 回應物件錯誤 | **原無** | 若只觸發 `res.on("error")` 而未觸發 `close`，可能殘留 |

### 修復內容

將 `req.on("close", ...)` 抽成共用 `removeClient`，並為 `res` 註冊 `error` 時同樣呼叫，避免極少數情況下只觸發 error 不觸發 close 而殘留連線：

```ts
const removeClient = () => {
  clearInterval(keepAlive);
  sseClients.delete(res);
  console.log("[SSE] Client disconnected, remaining:", sseClients.size);
};
req.on("close", removeClient);
res.on("error", () => { removeClient(); });
```

可避免長時間運行下累積死連線吃光 RAM。

---

## 總結

| 死穴 | 體檢結果 | 動作 |
|------|----------|------|
| 1. SQLite 併發鎖死 | WAL 已有，busy_timeout 缺失 | 已加 `busy_timeout = 5000` |
| 2. Event Loop 阻塞 | 已具備 yield | 無需修改 |
| 3. 背景 AI 崩潰 | 已有 try-catch | 已加錯誤 log |
| 4. SSE 記憶體洩漏 | close 已清理，error 未處理 | 已加 `res.on("error", removeClient)` |

以上四項修復均已套用，可支援正式環境每日 700～1000 則訊息之商業級高可用性需求。
