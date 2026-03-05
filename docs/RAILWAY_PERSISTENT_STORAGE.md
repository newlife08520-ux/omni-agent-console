# Railway 持久化儲存：品牌與渠道不再消失

## 為什麼重開或重新部署後，渠道／品牌會不見？

本系統用 **SQLite** 存品牌、渠道、聯絡人、訊息等，檔案放在 **資料目錄**（production 預設為 `/data`）。

在 Railway 上，**沒有掛載 Volume 時**，容器內的 `/data` 是**暫時的**：

- 每次 **重新部署** 或 **服務重啟** 都會換成新的容器
- 新容器裡的 `/data` 是空的，程式會建出全新的資料庫
- 所以你之前新增的「私藏生活」、LINE 渠道等都會消失，畫面就變成「此品牌尚未建立渠道」

因此要讓資料**持久化**，必須在 Railway 上掛載 **Volume**，讓資料庫檔案寫在 Volume 裡，而不是容器內建磁碟。

---

## 解決步驟（Railway 掛載 Volume）

### 1. 在 Railway 專案裡為「這個服務」加一個 Volume

1. 打開 [Railway Dashboard](https://railway.app/dashboard)，進入你的專案
2. 點選 **部署這個應用的那個 Service**（例如 `Omni-Agent-Console`）
3. 切到 **Variables** 旁的分頁，找到 **Volumes**
4. 點 **+ New Volume** 或 **Add Volume**

### 2. 把 Volume 掛載到 `/data`

建立 Volume 時會要你填 **Mount Path**（掛載路徑）：

- 請填：**`/data`**
- 名稱可以自訂（例如 `app-data`）

儲存後，Railway 會用這個 Volume 當作容器裡的 `/data` 目錄，**重啟或重新部署時都會保留**。

### 3. 重新部署一次

- 加好 Volume 後，建議做一次 **Redeploy**（或推一次 code 觸發部署）
- 部署完成後，之後在「系統設定」裡新增的品牌、渠道都會寫進這個 Volume，不會再因為重開或部署而消失

### 4. 若你改用其他路徑（可選）

若你想把 Volume 掛在別的路徑（例如 `/app/data`），需要同時設定環境變數：

- **變數名稱**：`DATA_DIR`
- **值**：你掛載的路徑，例如 `/app/data`

本專案程式會讀 `DATA_DIR`，把資料庫與上傳檔案都放在該目錄下。

---

## 設定好之後

- **品牌**、**渠道**（LINE / Facebook）會持久保存，重新部署或重啟後仍會存在
- **LINE 串接**：在「系統設定」→ 選品牌 →「新增渠道」建立 LINE 渠道並填好 Token / Secret 後，Webhook URL 設成 Railway 提供的網址（例如 `https://你的服務.up.railway.app/api/webhook/line`），訊息就會正常進來
- 若仍沒收到 LINE 訊息，請再確認：  
  - LINE Developers 後台 Webhook URL 是否為上述網址  
  - 該渠道的 `access_token`、`channel_secret` 是否正確且已儲存  

---

## 總結

| 狀況 | 原因 | 解法 |
|------|------|------|
| 重整或過一陣子渠道就不見 | 沒掛 Volume，資料在容器內建磁碟，重啟/部署就清空 | 在 Railway 加 Volume，Mount Path 設為 `/data` |
| LINE 串好了但沒看到訊息 | 可能是渠道沒持久化（同上），或 Webhook / Token 未設對 | 先完成 Volume 設定，再檢查 Webhook URL 與 Token |

完成 Volume 掛載後，你現在在畫面上看到的「此品牌尚未建立渠道」就不會再因為重開或部署而出現（除非你刪除或從未建立過渠道）。
