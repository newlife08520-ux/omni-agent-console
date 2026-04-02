# 最小 Scenario 配置（無新表）

## 載體
- 延用 `brands.phase1_agent_ops_json`，新增 **`scenario_overrides`** 物件，鍵為 `ORDER_LOOKUP` | `AFTER_SALES` | `PRODUCT_CONSULT` | `GENERAL`。

## 支援欄位（每情境）
| 鍵 | 用途 |
|----|------|
| `prompt_append` | 附加在該輪 prompt（「品牌情境覆寫」區塊） |
| `knowledge_mode` | `inherit` / `none` / `minimal` / `full` |
| `tool_allow_extra` | function name 陣列，於 whitelist 後追加 |
| `tool_deny_extra` | function name 陣列，從當前列表移除 |

## 與 `logistics_hint_override`
- 仍為全域流程物流一句；情境物流細節可寫入 `prompt_append` 或後續再拆。

## 範例
```json
{
  "enabled": true,
  "hybrid_router": true,
  "scenario_isolation": true,
  "tool_whitelist": true,
  "trace_v2": true,
  "scenario_overrides": {
    "ORDER_LOOKUP": { "knowledge_mode": "none" },
    "AFTER_SALES": { "prompt_append": "本品牌退貨需附照片。" }
  }
}
```
