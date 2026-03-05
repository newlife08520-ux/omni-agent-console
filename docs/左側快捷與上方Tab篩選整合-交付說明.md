# 左側快捷與上方 Tab 篩選整合 - 交付說明

## 一、真正 bug 原因

1. **左側快捷用 `<Link href="/#view=unassigned">` 等**  
   在 SPA 下，wouter 的 `Link` 會做 client-side 導向。當目前已在路徑 `/` 時，點擊 `href="/#view=unassigned"` 可能只被當成「同頁」而不觸發完整的 hash 更新，或 hash 更新後 React 狀態未同步，導致 **viewMode 沒有真的被改成對應篩選**。

2. **viewMode 只存在 ChatPage 的 local state**  
   左側 Sidebar 與中間 Chat 是兄弟元件，Sidebar 無法直接改 ChatPage 的 `viewMode`，只能依賴「改 hash → ChatPage 監聽 hashchange」。若 hash 沒被正確寫入或事件未觸發，就會出現「點了沒反應」。

3. **兩套邏輯**  
   - 上方 tab：`onClick` 內直接 `setViewMode(vm)` 並手動 `window.location.hash = view=...`。  
   - 左側：依賴 `Link` 改 hash，再由 ChatPage 的 `useEffect` 從 hash 同步到 `viewMode`。  
   來源不一致，容易出現「tab 與左側不同步」或「左側點了無效」。

4. **filteredContacts 有正確用 viewMode**  
   篩選邏輯本身沒問題，問題在 **viewMode 沒有被左側快捷可靠地更新**。

---

## 二、改了哪些檔案

| 檔案 | 說明 |
|------|------|
| `client/src/lib/chat-view-context.tsx` | **新增**：共用 viewMode 的 Context + Provider，並負責與 hash 雙向同步 |
| `client/src/App.tsx` | 在 `BrandProvider` 內、Sidebar + main 外層包一層 `ChatViewProvider` |
| `client/src/components/app-sidebar.tsx` | 使用 `useChatView()`；左側快捷改為按鈕 + `setViewMode` + 必要時 `setLocation("/")`；依 viewMode 高亮；數字來自 API |
| `client/src/pages/chat.tsx` | 移除本機 viewMode state 與 hash 監聽；改用 `useChatView()`；tab 只呼叫 `setViewMode`；切換篩選後 selectedId 改為「選第一筆或清空」 |
| `docs/左側快捷與上方Tab篩選整合-交付說明.md` | 本說明 |

---

## 三、每個檔案改了什麼

### 1. `client/src/lib/chat-view-context.tsx`（新檔）

- 定義 `ViewMode` 型別與 `viewFromHash()`。
- `ChatViewProvider`：用 `useState` 存 viewMode，初始值從 `viewFromHash()` 讀。
- `setViewMode(v)` 時：更新 state，並用 `history.replaceState`（或 fallback `location.hash`）寫入 `#view=xxx`。
- `useEffect` 監聽 `hashchange`，將 hash 同步回 state。
- `useChatView()` 回傳 `{ viewMode, setViewMode }`。

### 2. `client/src/App.tsx`

- 新增 `ChatViewProvider` 的 import。
- 在 `BrandProvider` 內、`<div className="flex h-screen...">` 外再包一層 `<ChatViewProvider>`，讓 Sidebar 與 Chat 都能用到同一份 viewMode。

### 3. `client/src/components/app-sidebar.tsx`

- 新增 `useChatView`、`ViewMode` 的 import；使用 `useLocation` 的 `setLocation`。
- `handleViewShortcut(vm)`：`setViewMode(vm)` + `setLocation("/")`，確保點快捷會切到首頁並套用篩選。
- **員工版「我的快捷」**：由一組 `{ vm, label, Icon, color, count }` 陣列驅動，每個項目是 `<button onClick={() => handleViewShortcut(vm)}>`；active 用 `viewMode === vm` 高亮（`bg-stone-600 ring`）；數字用 `agentStats`（my_cases, pending_reply, urgent, tracking）。
- **主管版「主管快捷」**：同上，項目為待分配、緊急案件、逾時未回、全部案件；數字用 `managerStats`（unassigned, urgent, overdue）；全部案件不顯示數字。

### 4. `client/src/pages/chat.tsx`

- 移除本機 `ViewMode` 型別、`viewFromHash`、`useState(viewMode)`、監聽 `hashchange` 的 `useEffect`。
- 改為 `const { viewMode, setViewMode } = useChatView();`；tab 的 `onClick` 只呼叫 `setViewMode(vm)`（不再手動設 hash）。
- **selectedId 處理**：當目前 `selectedId` 不在本次 `filteredContacts` 的 id 列表時，改為「若有結果則選第一筆，否則清空」；依賴為 `[viewMode, filteredIdsKey]`。

---

## 四、左側快捷與上方 tab 如何共用同一套篩選狀態

- **單一來源**：`ChatViewProvider` 的 state `viewMode`。
- **左側快捷**：點擊 → `setViewMode(vm)` + `setLocation("/")` → 同一份 viewMode 更新 → ChatPage 的 `filteredContacts` 與 tab 都讀到同一個 viewMode。
- **上方 tab**：點擊 → `setViewMode(vm)` → 同上。
- **Hash**：僅在 Context 內處理；`setViewMode` 時寫入 hash，`hashchange` 時從 hash 讀回並更新 state。左側與 tab 都不再直接改 hash，避免兩套邏輯。

---

## 五、切換篩選後 selectedId 如何處理

- 用 `filteredContacts.map(c => c.id).join(",")` 做成 `filteredIdsKey`。
- `useEffect` 依賴 `[viewMode, filteredIdsKey]`：
  - 若目前 `selectedId` 在本次篩選結果的 id 集合內 → 不變。
  - 若不在（或 selectedId 為 null 但結果有資料）→ `setSelectedId(ids[0] ?? null)`，即「選第一筆或清空」。
- 避免切到某篩選後右側仍顯示已不在列表的舊案件或白屏。

---

## 六、如何驗收

1. **左側主管快捷（主管帳號）**  
   - 點「待分配」→ 中間列表僅顯示待分配案件；上方 tab「待分配」為選中；左側「待分配」高亮。  
   - 點「緊急案件」→ 僅顯示緊急案件；tab 與左側同步。  
   - 點「逾時未回」→ 僅顯示逾時未回；tab 與左側同步。  
   - 點「全部案件」→ 顯示全部；tab「全部」選中；左側「全部案件」高亮。

2. **左側員工快捷（客服帳號）**  
   - 點「我的案件」「待我回覆」「緊急案件」「待追蹤」「待分配」→ 列表與上方 tab 皆切到對應篩選，左側對應項高亮。

3. **上方 tab**  
   - 切換任一 tab → 左側對應快捷（若有）同步高亮；列表與篩選一致。

4. **selectedId**  
   - 先選一筆案件，再切到一個不包含該案的篩選（例如先選「待分配」裡一筆，再點「緊急案件」）→ 右側應改為顯示該篩選的第一筆或空狀態，不殘留舊案、不白屏。

5. **從其他頁面點左側快捷**  
   - 在「設定」等頁點左側「待分配」→ 應跳回首頁且列表為待分配。

6. **數字**  
   - 左側快捷上的數字應與 API（主管用 manager-stats、員工用 agent-stats）一致，且會隨 refetch 更新。

---

## 七、驗收成功標準

- 點左側「待分配」會真的切到待分配列表。  
- 點左側「緊急案件」會真的切到緊急案件列表。  
- 點左側「逾時未回」會真的切到逾時未回列表。  
- 點左側「全部案件」會回到全部。  
- 上方 tab 與左側快捷為同一套 viewMode，不會兩套分離或打架。  
- 切換篩選後不會沒反應、舊資料殘留或白屏；selectedId 會自動改為第一筆或清空。
