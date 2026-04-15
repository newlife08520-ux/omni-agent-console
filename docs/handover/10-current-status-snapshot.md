---
產出時間: 2026-04-14（Asia/Taipei）
Phase 版本: Phase 106 交接包
檔案用途: 2026-04-14 現況快照（請老闆貼 production 實測 JSON／log 後再打包）
---

# 10 — 現況快照（2026-04-14）

> 本檔為**模板**。自動化無法取得 Railway production 機密與即時 JSON，請老闆在部署環境執行下列 API 後，**把回應貼入下方區塊**再 `git commit` 或另存一版一併打包給第三方。

## 1. GET `/api/debug/runtime`（JSON）

```json
{
  "_instruction": "請貼上 production 完整 JSON"
}
```

## 2. GET `/api/admin/brand-readiness`（需 superAdminOrDebugToken）

```json
{
  "_instruction": "請貼上 brands 陣列（可截斷敏感 shopline token 內容）"
}
```

## 3. GET `/api/admin/lookup-contacts-by-names`（JSON）

```json
{
  "_instruction": "請貼上 matched / not_found（老闆常用名單 5 人即可）"
}
```

## 4. GET `/api/admin/business-hours-status`

```json
{
  "_instruction": "請貼上 businessHours 與 holidays stats"
}
```

## 5. 最近 24 小時 Log 摘要（請手動整理）

- **Worker**：是否有 `[Worker] processing` / `failed` / `internal/run-ai-reply` 錯誤。
- **Queue**：waiting/active/delayed/failed 峰值（若有監控）。
- **錯誤**：`gemini`、`401`、`OPENAI`、`Signature`、`enqueue` 關鍵字列 3～5 行代表句即可。

```
（貼上摘要）
```

## 6. 營運親述（老闆補充）

- **天鷹**：曾發生「掛點／完全不回」時段與是否已恢復；懷疑原因（token、key、Worker）。
- **私藏**：LINE 後台「自動回應」與本系統 AI 開關是否混淆；渠道 bot_id 是否唯一。

---

打包給 ChatGPT 時，建議連同 **01～09** 與本檔一併提供；若本檔仍為模板，請在信內註明「快照待補」。
