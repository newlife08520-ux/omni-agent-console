# Soft Launch & Rollback Playbook（Phase 2.7）

## 環境變數開關（預設皆開）

| 變數 | 設為 `0` / `false` / `off` 時效果 |
|------|----------------------------------|
| `ENABLE_ORDER_FAST_PATH` | 關閉查單 fast path，一律進 plan + LLM |
| `ENABLE_ORDER_FINAL_NORMALIZER` | 關閉最後一哩 normalizer（語氣不再統一收斂） |
| `ENABLE_GENERIC_DETERMINISTIC_ORDER` | **不採用** tool deterministic 跳第二輪 LLM（僅認契約者亦無效） |
| `ENABLE_ORDER_ULTRA_LITE_PROMPT` | 查單改回 legacy slice 較肥 prompt |
| `ENABLE_ORDER_LATENCY_V2` | 減少 queue/normalizer 相關 log |

## 建議放量策略（文件層）

- **LINE 私訊**：可全開（與現況一致）。
- **Messenger**：建議保留 ultra-lite + deterministic；若投訴語氣可先關 `ENABLE_ORDER_FINAL_NORMALIZER` 觀察（不建議長關）。
- **FB 留言**：不宜開完整查單 fast path；維持短回 + 導私訊（既有產品策略）。

## 回退劇本

| 現象 | 建議動作 |
|------|----------|
| 錯答／誤用 deterministic | 先設 `ENABLE_GENERIC_DETERMINISTIC_ORDER=0`（強制第二輪 LLM 整理） |
| 延遲飆高 | 關 `ENABLE_ORDER_FAST_PATH` 或縮 worker 併發；查 log `queue_wait_ms` vs `final_reply_sent_ms` |
| 套話／語氣問題 | 確認 `ENABLE_ORDER_FINAL_NORMALIZER=1`；檢查品牌 ultra-lite meta |
| Prompt 異常變長 | 設 `ENABLE_ORDER_ULTRA_LITE_PROMPT=0` 暫時回退 legacy slice |

部署後務必重啟 API / worker 使 env 生效。
