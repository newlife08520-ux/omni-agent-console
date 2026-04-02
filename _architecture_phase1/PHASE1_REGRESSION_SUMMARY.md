# 迴歸摘要

- **預設（flags 關）**：不進入情境裁切與 tool 過濾；`phase1Route` 不算入 assemble（`enabled` false 時 early 不建立 route）。
- **注意**：`phase1Flags` 在 try 內會依品牌重算；`enabled` false 時 `isPhase1Active` 為 false，`scenarioIso` 為 false，與改動前 prompt 路徑一致。
- phase34 全通過 → 訂單相關護欄無迴歸訊號。
