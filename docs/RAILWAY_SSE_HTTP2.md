# Railway 上 SSE 即時通道與 ERR_HTTP2_PROTOCOL_ERROR 說明

## 現象

在 Railway 部署後，瀏覽器 Console 可能出現：

- `Failed to load resource: net::ERR_HTTP2_PROTOCOL_ERROR /api/events`
- `[SSE] Connection error, retry #0` 反覆出現

導致即時訊息／案件更新依賴的 **SSE 通道** 無法穩定連線，左側列表與對話不會即時刷新。

## 原因簡述

- **Railway 邊緣代理** 對外可能使用 HTTP/2，與部分環境下 **Server-Sent Events (SSE)** 的長連線行為不相容，容易觸發協議層錯誤或提早關閉連線。
- 代理或 CDN 若對 response 做 **緩衝／壓縮**，也會影響 SSE 串流，造成中斷或 ERR_HTTP2_PROTOCOL_ERROR。

## 後端已採取的設定（`/api/events`）

1. **Response headers**
   - `Cache-Control: no-store, no-cache, must-revalidate, no-transform`  
     - `no-transform` 降低代理壓縮或改寫 body 的機率。
   - `Connection: keep-alive`
   - `X-Accel-Buffering: no`  
     - 若前端經 Nginx 等反向代理，可避免代理緩衝 SSE。
   - `Content-Type: text/event-stream`

2. **Keepalive**
   - 每 **15 秒** 送一次 `:ping\n\n`，減少連線被視為閒置而遭代理關閉。

3. **Flush**
   - 若有 `res.flush()`（例如未來加上 compression 且僅對非 SSE 壓縮），會在寫入後呼叫，確保資料即時送出。

4. **不壓縮 SSE**
   - 目前未對全站啟用 compression；若日後啟用，**必須排除 `GET /api/events`**，否則 SSE 易出錯（見 `server/index.ts` 註解）。

## 前端已採取的對策

- **SSE 斷線時**：自動改為每 **5 秒** 輪詢聯絡人列表與當前對話訊息（`refetchInterval` / `refetchIntervalInBackground`），即使 SSE 失敗，畫面仍會定期更新。
- **重連**：指數退避重試（約 2s → 4s → 8s → … 上限 30s）。
- **提示**：頂部黃色橫幅「即時連線已中斷…已改為每 5 秒定期更新列表與訊息」，並提供「重新整理頁面」按鈕。

## 若仍持續 ERR_HTTP2_PROTOCOL_ERROR

1. **確認行為**：在 SSE 斷線時，列表與對話應在約 5 秒內自動更新；若會更新，代表輪詢正常，僅即時性略降。
2. **重新整理**：手動重整頁面可重新建立 SSE，有時可暫時恢復。
3. **Railway 端**：目前無法在應用內強制關閉 HTTP/2；若問題持續，可向 Railway 確認邊緣代理對長連線／SSE 的設定或限制。
4. **替代方案**：若必須在該環境下完全避免 SSE，可考慮改為純輪詢（例如固定每 5 秒打 API），或未來改為 WebSocket（需後端與部署支援）。

## 相關檔案

- 後端 SSE 路由與 headers：`server/routes.ts`（搜尋 `/api/events`）
- 前端 SSE 連線與輪詢：`client/src/pages/chat.tsx`（搜尋 `EventSource`、`sseConnected`、`refetchInterval`）
- 排查新訊息不顯示：`docs/TROUBLESHOOT-NEW-MESSAGE-NOT-SHOWING.md`
