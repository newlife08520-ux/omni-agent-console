# 留言主狀態定義（main_status）

本文件明確定義各狀態的使用邏輯，避免日後混用或誤用。

---

## hidden_completed

**僅用於：** 命中 direct_hide、成功隱藏、不需回覆、不需導 LINE、不需待人工。

- 情境：純負評 / 純亂入 / 純影響觀感 → 隱藏後直接結案。
- 不要用於：有導 LINE、有待人工、有回覆的案子。

---

## completed

**主要用於：**

- 正常詢問 AI 已成功公開回覆。
- 導購留言已成功處理完。
- route_only 且流程已走完。
- 不需要人工追蹤的已完成案件。
- 灰區經「標記已檢視」後也可歸為 completed（**暫時策略**：目前簡化為直接改為 completed；若未來需區分「已檢視但保留」與「已檢視並結案」，可再拆成 gray_reviewed / gray_completed 等狀態）。

---

## to_human

**代表：** 真正需要人工接手。

- 不要把「有導 LINE」就一律當 to_human，否則人工量會暴增。
- 例如：純售後關鍵字可先安撫 + 隱藏 + 導售後 LINE，若規則判定不一定要人工，可不進 to_human。

---

## gray_area

**代表：** 模糊、幽默、諷刺、曖昧語氣，需觀察或抽查。

- 不應長期堆積：應透過「灰區抽查」或「標記已檢視」消化。
- 灰區不直接佔主例外最前面，可另有入口（抽查 / 已檢視）。
- **暫時策略**：目前「標記已檢視」會直接將 main_status 改為 completed，屬簡化實作；若未來需區分「已檢視但保留」與「已檢視並結案」，可再新增 gray_reviewed / gray_completed 等狀態，見 GRAY_AREA_STRATEGY.md。

---

## 其他狀態簡述

| 狀態 | 用途 |
|------|------|
| unhandled | 未處理 |
| pending_send | 待送出 |
| auto_replied | 已自動回覆 |
| human_replied | 已人工回覆 |
| hidden | 已隱藏（流程中） |
| routed_line | 已導 LINE |
| failed | 執行失敗 |
| partial_success | 部分成功 |
