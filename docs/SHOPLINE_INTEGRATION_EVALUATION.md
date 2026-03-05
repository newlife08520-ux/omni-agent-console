# SHOPLINE 串接評估

依據 [SHOPLINE Open API 文件](https://open-api.docs.shoplineapp.com/) 與目前專案實作整理。

---

## 結論：**可以串接，且專案已具備基礎**

- 專案已實作 **SHOPLINE 訂單查詢**（依訂單編號、手機、Email、姓名），並與一頁商店並列為訂單來源。
- SHOPLINE 官方提供 **Open API**，以 **access_token**（Bearer）認證，與目前「商店域名 + API Token」的用法相容。
- 若店家已向 SHOPLINE 申請並開啟 **API Auth**，即可在後台產生 Token 並填進本系統「品牌管理 → SHOPLINE 商店域名 / API Token」，無需額外串接方式。

---

## 官方 API 重點（文件摘要）

### 1. 取得 access_token

- 路徑：**設定 > 管理員設定 (Staff Settings) > API Auth**  
- 須先向 SHOPLINE 申請 OpenAPI 權限，才會出現 API Auth。  
- 建立專用管理員 → 點選 API Auth → 選擇要開放的 API → 可選過期時間 → 按 Generate 取得 Token。  
- Token 可設定 **IP 白名單**（一組最多 20 個 IP）；部署到 Railway 等雲端時，若店家啟用白名單，需把**對外請求的 IP** 加入白名單（或向 SHOPLINE 確認雲端／動態 IP 是否支援）。  

參考：[How to get access_token](https://open-api.docs.shoplineapp.com/)

### 2. 訂單相關 API（與本專案需求直接相關）

| API | 用途 | 備註 |
|-----|------|------|
| **Get Orders** | 依時間、order_ids、分頁取得訂單 | 回傳為 `items` 陣列 |
| **Search Orders** | 依條件搜尋訂單 | 參數 `query` 可搜 order_number、customer_phone、customer_email、customer_name、product_name 等 |
| **Get Order** | 單筆訂單 | 若訂單已封存會回 410，需改走 Get Archived Orders |
| **Get Archived Orders** | 取得已封存訂單 | 用於較舊／已封存訂單 |

- 訂單封存：依狀態與時間會自動封存，查單時若遇 410 或「已封存」標示，需改用 Get Archived Orders。  
- 速率限制：**20 requests/second**，對客服查單情境足夠。

### 3. 請求格式（文件範例）

- 文件範例使用 **`https://open.shopline.io/v1/...`**，並以 **Bearer access_token** 認證。  
- 本專案目前使用 **`https://{商店域名}/api/v1/orders`**（商店域名由品牌設定），實務上需以店家實際提供的 API 網址為準（可能為 open.shopline.io 或各店網域）。

---

## 專案現況與對齊建議

### 已具備

- 品牌欄位：`shopline_store_domain`、`shopline_api_token`。  
- 訂單查詢：依訂單編號、手機、Email、姓名查 SHOPLINE，並與一頁商店結果合併。  
- 回傳格式：已相容 `data.orders`、`data.items`、`data.data`（官方 Get Orders 為 `items`）。  
- 後台：品牌管理可填寫商店域名與 API Token，並有「測試 SHOPLINE 連線」按鈕。

### 已對齊（2025 更新）

- **Base URL**：已改為官方 **`https://open.shopline.io`**（Token 識別商店），不再使用商店域名組 API 網址。  
- **連線測試**：只驗證 **API Token**，呼叫 `GET https://open.shopline.io/v1/orders?per_page=1`，並加上 **User-Agent**。  
- **訂單查詢**：依情境使用 **Get Orders**（無關鍵字）或 **Search Orders**（`/v1/orders/search`，參數 `query`）搜訂單編號／手機／Email／姓名。  
- **商店域名**：改為選填，僅供顯示；有 Token 即可連線與查單。

### 建議對齊與注意

1. **IP 白名單**  
   - 部署到 Railway 後，若店家啟用 Token 的 IP 白名單，需在 SHOPLINE 後台加入服務的**對外 IP**（或確認 SHOPLINE 是否支援動態 IP／雲端部署）。  
2. **已封存訂單**  
   - 若需支援查詢較久以前的訂單，可後續補上 **Get Archived Orders** 或對 410 的處理，避免查單顯示「查無」而實際為已封存。

---

## 串接檢查清單（給營運／店家）

- [ ] 已向 SHOPLINE 申請 OpenAPI 權限，管理員設定中可看到 **API Auth**。  
- [ ] 已建立專用管理員並在 API Auth 產生 **access_token**，並複製到本系統「品牌管理 → SHOPLINE API Token」。  
- [ ] 本系統「SHOPLINE 商店域名」可留空或填寫顯示用；**API Token 必填**，連線與查單皆以 Token 透過 `https://open.shopline.io` 呼叫。  
- [ ] 若 Token 有設 IP 白名單，已將本系統部署環境的對外 IP 加入。  
- [ ] 在後台使用「測試 SHOPLINE 連線」確認可成功取得訂單資料。

---

## 參考連結

- [SHOPLINE Open API 首頁](https://open-api.docs.shoplineapp.com/)  
- [How to get access_token](https://open-api.docs.shoplineapp.com/)  
- [Get Orders](https://open-api.docs.shoplineapp.com/reference/get-orders)  
- [Search Orders](https://open-api.docs.shoplineapp.com/reference/search-orders)  
- [Open API request example（含 rate limit、User-Agent）](https://open-api.docs.shoplineapp.com/docs/openapi-request-example)
