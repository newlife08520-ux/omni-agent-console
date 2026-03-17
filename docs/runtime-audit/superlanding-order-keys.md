# SuperLanding 訂單 API 欄位盤點（runtime audit）

來源：`orders.json?per_page=5&page=1` 最近 5 筆訂單，遮罩後盤點。

## 1. Top-level 與 nested keys（合併所有訂單）

```
access_key
address
birthday
convenient_store
coupon
coupon_code
created_date
created_ip
customer_age
customize_total_order_amount
delivery_orders_count
email
final_total_order_amount
gender
global_order_id
id
invoice
invoice_setting
is_outlying_islands
line_id
member
mobile
note
note_shipping
order_created_at
order_history_count
order_id
page_id
paid_at
payment_method
payment_transaction_id
prepaid
product_list
product_list[].code
product_list[].qty
receive_date
receive_time
recipient
shipped_at
shipping_method
status
system_note
system_note.message
system_note.type
tag
total_order_amount
total_order_amount_with_discount
tracking_codes
tracking_codes[].id
tracking_codes[].provider
tracking_codes[].url
updated_at
warehouse_items
zip_code_from_address
```

## 2. product_list 型態

本批訂單出現的型態：`array`

## 3. address 型態

本批訂單出現的型態：`string`

## 4. tracking_codes 內每個 item 的 key

`id`, `provider`, `url`

---
產出時間：2026-03-17T12:52:03.048Z