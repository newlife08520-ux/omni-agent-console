# Production 前端與部署一致 — 檢查與修正

## 問題現象

- **localhost:8080/team** 可看到「品牌負責」區塊與客服卡摘要  
- **production /team** 看不到  
→ 代表 production 前端仍是舊版，需確保部署時**完整 build 並更新靜態檔**。

---

## 1. 完成狀態（本輪）

- 已新增 **nixpacks.toml**：強制 Railway 每次部署執行 `npm run build`（client + server），避免只更新 server。
- 已於 **script/build.ts** 在 build 結束後寫入 **dist/public/version.json**（buildTime + commit），供驗證部署版本。
- 已新增 **GET /api/version**：回傳 `{ buildTime, commit }`，用於確認 production 實際跑的是哪一次 build、哪一個 commit。
- 本文件為部署檢查清單與驗收方式。

**未改任何功能程式碼**，僅部署與可觀測性。

---

## 2. 問題定位（對照檢查項）

| 檢查項 | 說明 |
|--------|------|
| **1. production 實際部署的 commit hash** | 部署完成後用 **GET https://你的網域/api/version** 查看 `commit`；若為 `null` 表示 build 時未提供 `RAILWAY_GIT_COMMIT_SHA` 等 env，或未跑完整 build。 |
| **2. deploy 流程是否真的有重新 build client** | 本專案 **npm run build** 會先清空 dist、再跑 Vite（client → dist/public）、再跑 esbuild（server → dist/index.cjs）、最後寫入 version.json。已用 **nixpacks.toml** 明定 `[phases.build] cmds = ["npm run build"]`，Railway 每次 deploy 都會執行，client 會一併建出。 |
| **3. Railway 是否只更新 server、未更新 client** | 若**沒有** nixpacks.toml，Railway 可能依預設只跑 install + start，而沒跑 build，導致沒有新的 dist/public。已加上 **nixpacks.toml** 後，build 階段一定會跑，dist/public 會與 dist/index.cjs 同一次產出。 |
| **4. production 的 dist/public 是否包含品牌負責 UI** | 部署完成後可檢查：同一 build 的 **index.html** 與 **assets/index-xxxxx.js** 是否包含 `section-brand-assignments` 或「品牌負責」等字串；或直接以 **/team 是否出現品牌負責區塊** 驗收。 |
| **5. 舊 build artifact / cache / 錯 branch / 錯 commit** | Railway 若使用快取，可能沿用舊 dist。**nixpacks.toml 強制跑 npm run build**，而 **script/build.ts 第一行會 rm("dist")**，所以每次 build 都會從頭產出 dist。請確認部署觸發的是正確 branch、正確 commit。 |
| **6. 重新部署整個前端 build 到 production** | 推送含 **nixpacks.toml** 與 **script/build.ts 寫 version.json** 的 commit 後，在 Railway 觸發 **Redeploy**（或推新 commit 觸發部署），確保部署流程有執行 **npm run build**。 |
| **7. 部署後 /team 驗收** | 見下方「驗收方式」。 |

---

## 3. 實際修改／處理了什麼（部署面）

| 檔案 | 變更 |
|------|------|
| **nixpacks.toml**（新增） | `[phases.install] cmds = ["npm ci"]`；`[phases.build] cmds = ["npm run build"]`；`[start] cmd = "npm run start"`。確保每次 deploy 都跑完整 build。 |
| **script/build.ts** | build 結束後寫入 **dist/public/version.json**，內容為 `{ buildTime: ISO 字串, commit: RAILWAY_GIT_COMMIT_SHA 等前 12 字元 }`，方便對應部署版本。 |
| **server/routes.ts** | 新增 **GET /api/version**（無需登入），讀取 dist/public/version.json 回傳 `{ buildTime, commit }`。 |
| **docs/DEPLOY-FRONTEND-SYNC.md** | 本文件：問題對照、修改說明、驗收方式、最終 commit 紀錄。 |

---

## 4. 驗收方式

1. **部署完成後查版本**  
   - 開啟：`https://你的 production 網域/api/version`  
   - 應回傳 `{ "buildTime": "202x-xx-xxT...", "commit": "xxxxxxxxxxxx" }`（commit 可能為空字串若 Railway 未注入）。  
   - 將此 **commit** 與你預期部署的 **git commit hash 前 12 碼** 對照，確認一致。

2. **/team 頁面**  
   - 登入後進入 **/team**。  
   - 應看到「品牌負責」區塊（在「客服分配規則」下方）。  
   - 客服成員卡上應有一行「品牌負責：無」或「品牌負責：主責／備援…」。

3. **若仍看不到**  
   - 再確認 **GET /api/version** 的 `commit` 是否為你剛部署的 commit。  
   - 在瀏覽器 DevTools → Network 看 **index.html** 與主要 **assets/*.js** 的檔名與回應；比對與 localhost build 產出的檔名是否一致（hash 應不同但結構相同）。  
   - 確認 Railway 的 Deploy 日誌中有執行 **npm run build** 且無錯誤。

---

## 5. 最終部署的 commit hash

部署完成後，請將 **GET /api/version** 回傳的 `commit`（或實際部署的 git commit hash）紀錄於此，方便日後對照：

- **本次部署 commit：** `________________`（請填寫）
- **部署時間：** 依 `buildTime` 或 Railway 部署紀錄填寫。

---

## 6. /api/version 回傳前端 404 的根因（部署版本落後）

**現象：** production 打 `/api/version` 得到前端 404 頁，不是 JSON。

**根因：** GET /api/version 的程式碼在 **server/routes.ts** 中，但該修改**從未 commit**。因此：

- 新增 **GET /api/version** 的變更只存在於**工作目錄**（未納入任何 commit）。
- Production 目前部署的 commit（例如 Railway 顯示的 **46d23c77**）是**不含**此 route 的舊版。
- 請求 `/api/version` 時後端沒有對應路由，會 fallback 到 SPA 的 index.html，前端路由顯示 404 頁。

**正確的 commit hash：** 目前**尚無**包含 `/api/version` 的 commit。需先將下列檔案 **commit 並 push** 到 production 綁定的 branch，才會產生「包含 /api/version 的 commit」：

- `server/routes.ts`（含 GET /api/version）
- `nixpacks.toml`
- `script/build.ts`（寫入 version.json）
- 可選：`docs/DEPLOY-FRONTEND-SYNC.md`、`docs/PRODUCTION-FRONTEND-VERSION-CHECK.md`

**處理步驟：**

1. 將上述檔案 **commit**（例如：`git add server/routes.ts nixpacks.toml script/build.ts docs/DEPLOY-FRONTEND-SYNC.md`，再 `git commit -m "chore: add /api/version, nixpacks build, version.json for deploy verification"`）。
2. **Push** 到 production 綁定的 branch（例如 `main`）。
3. 在 Railway 觸發部署（或由 push 自動觸發）。
4. 部署完成後驗收：`/api/version` 回傳 JSON；`/team` 看到品牌負責區塊。
5. 將該次部署的 **commit hash** 填到上方「本次部署 commit」。

---

## 簡短檢查清單（部署前後）

- [ ] 已將含 **nixpacks.toml**、**build 寫 version.json**、**GET /api/version** 的 commit 推送到要部署的 branch。
- [ ] Railway 已觸發部署（Redeploy 或 push 觸發）。
- [ ] 部署日誌中有執行 **npm run build** 且成功。
- [ ] **GET /api/version** 回傳的 commit 與預期一致。
- [ ] **/team** 可看到「品牌負責」區塊與客服卡品牌摘要。
