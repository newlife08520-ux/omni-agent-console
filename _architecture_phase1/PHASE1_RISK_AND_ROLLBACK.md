# 風險與回滾

## 風險
| 風險 | 緩解 |
|------|------|
| LLM Router 延遲／費用 | 硬規則先吃大部分；模型用 `resolveOpenAIRouterModel` 可設小模型 |
| 情境誤判 | `legacy_fallback` 對齊既有 plan；可關閉 `hybrid_router` 僅用 plan 對照 |
| Tool 過濾過嚴 | 關閉 `tool_whitelist` 即恢復全量 tools |
| DB migration 失敗 | ALTER 僅加欄；舊 binary 需更新後重啟 |

## 回滾
見 bundle 內 `rollout_docs/ROLLBACK_PLAN.md`：優先 JSON `enabled: false`。
