# 商品＋手機（本地）真相

## Live 現況：`items_count = 0`、`aliases_count = 0` 代表什麼？

在 **`stats:order-index`** 的定義下：

- **`items_count`**：`order_items_normalized` 與 `orders_normalized` 關聯後的列數。  
- **`aliases_count`**：`product_aliases` 表列數。

兩者 **皆為 0** = **這顆 DB 沒有任何已展開的訂單明細索引、沒有任何商品別名表資料**。

## 能宣稱「商品＋手機本地精準查」嗎？

**在此快照下不能。**  
程式路徑也許存在，但 **沒有資料支撐**；對客／對內說法應降級為「需商品名＋手機或單號，且以 API／工具結果為準」之類，直到 `sync`／`derive:aliases` 等實際寫入表。

## 要怎麼變非 0？（操作面，非保證）

- 有訂單進索引後，視流程寫入 `order_items_normalized`。  
- 執行 **`npm run derive:aliases`**（或專案內實際灌入 `product_aliases` 的流程）。  

完成後再跑 **`npm run stats:order-index`** 看是否仍為 0。
