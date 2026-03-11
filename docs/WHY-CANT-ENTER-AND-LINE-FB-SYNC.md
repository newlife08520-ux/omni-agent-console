# 為什麼之前進不去 ＋ 現在 LINE／粉專不會自動連動

## 一、為什麼「一直更新後反而進不去」？

### 原因（已修復）

之前做了 **Code Splitting**，把 React、react-dom 拆到獨立的 `vendor-react` chunk。  
結果 **同一份網頁裡出現兩份 React**（主 bundle 與其他套件各帶一份），執行時就會報錯：

- **錯誤**：`Cannot set properties of undefined (setting 'Children')`
- **畫面**：白屏，完全打不開

所以不是「更新太多」本身有問題，而是**那次把 React 拆出去的設定**導致多實例，才進不去。

### 目前的修正

- 在 **vite.config.ts** 做了兩件事：
  1. **resolve.dedupe**：強制全站只用同一份 `react`、`react-dom`。
  2. **不再把 React 拆成獨立 chunk**：只把 @tanstack/react-query、wouter 拆出去，React 留在主 bundle／vendor，全站只有一份 React。

這樣就不會再出現多實例白屏，所以現在可以正常進去。  
**結論：之前進不去是前端打包（多份 React）造成的，和 LINE／粉專後端無關。**

---

## 二、現在「不會自動連動 LINE 跟粉專」是同一件事嗎？

**不是。** 這是另一個層面的問題：

- **進不進得去**：前端有沒有正確載入（React 單一實例）→ 已解決。
- **會不會自動連動**：LINE／FB 的**新訊息**有沒有送進你們後端、畫面上有沒有**即時更新** → 由 Webhook ＋ SSE 決定。

所以：  
「之前進不去」和「現在 LINE／粉專不會自動連動」**沒有直接因果**；  
進不去是前端的問題，連動是 Webhook／即時推播的設定與連線問題。

---

## 三、Console 裡的 404（sprofile.line-scdn.net）有關係嗎？

- 那是 **LINE 大頭貼圖片** 的網址（CDN）。
- 404 只代表**頭像載不到**（網址過期或權限等），**不會**導致：
  - 進不去網站
  - LINE 訊息收不到
  - 粉專不會連動

所以可以當成「頭像顯示不完整」，不影響「自動連動」的排查。

---

## 四、「自動連動」要滿足什麼？

要讓 LINE／粉專的**新訊息自動出現在中控台**，需要兩邊都通：

### 1. 後端要收得到（Webhook）

- **LINE**：LINE Developers → 該 Channel → Webhook URL =  
  `https://richbear-omnicare-hub.up.railway.app/api/webhook/line`  
  → 按 **Verify** 要成功（不能 timeout）。
- **FB 粉專**：Meta 開發者後台 → 該 App → Webhook 訂閱的 URL =  
  `https://richbear-omnicare-hub.up.railway.app/api/webhook/facebook`  
  → 驗證要通過。

若 Webhook 沒設對或沒驗證成功，LINE/FB 就不會把新訊息推給你們，自然不會「自動連動」。

### 2. 前端要即時更新（SSE）

- 後端收到 Webhook 後會透過 **SSE** 推 `new_message`、`contacts_updated` 給瀏覽器。
- 若 SSE 斷線，畫面上就不會自動出現新訊息（要重整或等輪詢才會看到）。
- 畫面上若有黃色橫幅「即時更新已中斷」，按 **重新整理頁面** 會重連 SSE。

所以：  
**不會自動連動** = 要嘛 Webhook 沒通（後端收不到），要嘛 SSE 沒通（前端沒收到推播）。

---

## 五、建議你這樣查「自動連動」

| 步驟 | 做什麼 |
|------|--------|
| 1 | 用手機對 LINE 官方帳號傳一則訊息，看中控台有沒有**馬上**出現（不重整）。 |
| 2 | 若沒有 → 看 Railway **Deploy Log** 有沒有 `[LINE WEBHOOK START]`、`new_message`；沒有代表 Webhook 沒打到你們，回去檢查 LINE 後台 Webhook URL 與 Verify。 |
| 3 | 若有打到後端但畫面沒更新 → 看瀏覽器有沒有黃色「即時更新已中斷」；有就重整，並確認 F12 Console 沒有 SSE/EventSource 錯誤。 |
| 4 | 粉專同理：Meta 後台 Webhook 設對、訂閱 `messages` 等，後端 log 有收到再查 SSE。 |

---

## 六、總結

- **之前進不去**：是前端 **React 多實例** 造成白屏，和 LINE／粉專無關；改 vite 打包後已可正常進入。
- **現在不會自動連動**：是 **Webhook 是否設對、有無驗證成功**，以及 **SSE 是否連著**；和「之前進不去」無關，要分開查 Webhook ＋ SSE。
- **sprofile.line-scdn.net 404**：只影響頭像顯示，不影響進站、也不影響 LINE／粉專連動。

若要，我可以再幫你寫一段「只查 LINE 自動連動」的逐步檢查表（後台要點哪裡、Log 要看哪幾行）。
