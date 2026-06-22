# TTQS 考試 App — Zeabur 部署 Runbook

> 目的：照著本檔一步步把 `exam_app` 部署到 Zeabur。
> 兩個方案：**方案 A（建議，保留成績）**用網頁/Template 含持久卷；**方案 B（CLI 快速）**無持久卷、重啟即丟成績。
> 機密一律放 Zeabur 環境變數，**不要寫進版控、不要刪服務**（刪服務會連卷一起刪掉成績）。

相關檔案：
- Dockerfile：`exam_app/Dockerfile`（非 root `node` 使用者、`EXPOSE 8080`、`CMD node server.js`、`VOLUME /data`）
- `.dockerignore`：已排除 `.env`、`node_modules`、`data`、`.git`、`*.md`
- 既有部署備忘：`exam_app/DEPLOY.md`
- **Root Directory 一律設 `exam_app`**（Dockerfile 在此目錄）

---

## 0. 前置：登入 Zeabur CLI

先確認是否已登入：

```bash
zeabur auth status
```

- 若顯示 `Logged in as ...` → 已登入，直接往下。
- 若未登入 → **請在對話框輸入**（互動式登入，需開瀏覽器，請手動執行）：

  ```
  ! zeabur auth login
  ```

> 提醒：CLI 目前版本可能比最新版舊，功能不影響部署；要升級可至 https://github.com/zeabur/cli/releases 。

---

## 方案 A（建議）— 網頁/Template 建立服務，掛 `/data` 持久卷（保留成績）

成績存在 `/data/results.jsonl`。**只有掛了持久卷，重新部署/重啟才不會丟成績。**

### A-1. 建立服務

1. 把程式碼推上 GitHub（repo：`Chiuchau-Inc/ttqs-exam`）。
2. 進 Zeabur 主控台 → 建立 / 選擇 Project → **Add Service**。
3. 來源選 **GitHub repo**（`Chiuchau-Inc/ttqs-exam`）。
4. **Root Directory 設 `exam_app`**、部署方式選 **Dockerfile**（不是 Static）。

### A-2. 掛載持久卷（關鍵）

- 在該 service 的 **Volumes** 設定新增一顆磁碟，**掛載路徑（Mount Path）設 `/data`**。
- 若以 **Template** 建立，請選含 volumes 的 Template，volume 掛載點同樣為 `/data`。
- 確認環境變數 `DATA_DIR=/data`（見下表），讓 app 把成績寫進這顆卷。

### A-3. 設定環境變數

在 service 的 **Variables/Environment** 逐項設定：

| 變數 | 值 / 說明 |
|------|-----------|
| `DIFY_API_KEY` | Dify App 的 API Key（`app-xxxx`）。**未設則 AI 評分自動退回前端自評模式** |
| `DIFY_BASE_URL` | `https://api.dify.ai/v1`；自架 Dify 改成你的網域 + `/v1` |
| `SESSION_SECRET` | session 簽章密鑰。本機產生一把：`openssl rand -hex 32`，把輸出貼上。多實例務必同一把 |
| `TRUST_PROXY` | `1`（置於 Zeabur 反向代理後，正確取得真實來源 IP） |
| `ALLOW_ORIGINS` | `https://ttqs-exam.zeabur.app`（對外公開務必設，限制跨來源） |
| `DATA_DIR` | `/data`（對應 A-2 的持久卷掛載點） |
| `ADMIN_TOKEN` | 老師稽核用。設長亂碼（例：`openssl rand -hex 24`），妥善保管 |
| `RATE_PER_MIN` | 每 IP 每分鐘上限（預設 40，可不設） |
| `RATE_GLOBAL_PER_MIN` | 全域每分鐘上限，保護 Dify 額度（預設 600，可不設） |

> 產生密鑰範例：
> ```bash
> openssl rand -hex 32   # SESSION_SECRET
> openssl rand -hex 24   # ADMIN_TOKEN
> ```

### A-4. 綁定網域

- 在 service 的 **Domains/Networking** 綁定網域（建議 `ttqs-exam.zeabur.app`），Zeabur 會**自動配發 HTTPS 憑證**。
- 記得 `ALLOW_ORIGINS` 要與最終網域一致。

### A-5. 部署

- 觸發部署（push 或主控台按 Redeploy）。完成後跳到本檔「部署後驗證」。

---

## 方案 B（CLI 快速）— `zeabur deploy`，**無持久卷 → 成績重啟即失**

> 適合快速試跑/Demo。**正式考試請用方案 A**，否則服務重啟或重新部署會清掉 `/data/results.jsonl`。

### B-1. 首次互動建立服務

```bash
cd /Users/cyril/Documents/git/chiuchau-git/ttqs-exam/exam_app

# 先把 .env 移開，避免機密被上傳（.dockerignore 已排除，但雙保險）
mv .env /tmp/.env.bak 2>/dev/null || true

# 互動模式：依提示選 / 建立 project、service、environment
zeabur deploy
```

- 互動過程會問要部署到哪個 project / service / environment（沒有就現場建立）。
- 部署完成後，記下 **project id / service id / environment id**（可用以下查詢）：

```bash
zeabur project list
zeabur service list --project-id <PROJECT_ID>
```

把這三個 id 回填到 `exam_app/DEPLOY.md` 的待填欄位（與本檔檔尾「待回填」區塊）。

### B-2. 設定環境變數（同方案 A 的表）

```bash
# 範例（逐一設定；變數清單見方案 A-3 的表）
zeabur variable set DIFY_API_KEY=app-xxxx \
  --id <SERVICE_ID> --env-id <ENV_ID>
# SESSION_SECRET 用 openssl rand -hex 32 產生後填入
# 注意：方案 B 不掛 /data 卷，DATA_DIR 設了也只是寫到容器內暫存層，重啟即失
```

### B-3. 之後重新部署（id 回填後，非互動）

```bash
cd /Users/cyril/Documents/git/chiuchau-git/ttqs-exam/exam_app
mv .env /tmp/.env.bak 2>/dev/null || true   # 先把機密移開
zeabur deploy \
  --project-id <PROJECT_ID> \
  --service-id <SERVICE_ID> \
  --environment-id <ENV_ID> \
  -i=false
mv /tmp/.env.bak .env 2>/dev/null || true   # 還原本機 .env
```

> 沿用同一個 service id 重新部署，方案 A 的 `/data` 卷會保留；方案 B 無卷不適用。

---

## 部署後驗證

1. **健康檢查**（把網址換成實際綁定的）：

   ```bash
   curl -s https://ttqs-exam.zeabur.app/api/health
   ```

   預期回傳（200）：

   ```json
   { "ok": true, "ai": true, "token": "<一串簽章 token>" }
   ```

   - `ok: true` → 服務正常。
   - `ai: true` → 已正確讀到 `DIFY_API_KEY`（AI 評分啟用）；`ai: false` → 未設金鑰，前端會退回自評模式。
   - `token` → 一段 HMAC 簽章字串（防表單濫用用），有值即代表 `SESSION_SECRET` 生效。

2. **HTTPS**：用瀏覽器開網域，確認憑證有效（Zeabur 綁網域後自動 HTTPS）。

3. **持久卷（僅方案 A）**：作答一次 → 主控台手動 Redeploy → 再看成績是否還在，確認卷有生效。

---

## 老師操作

1. **成績檢視（老師模式）**
   - 開 `https://ttqs-exam.zeabur.app/board.html` → 點「🔑 老師模式」→ 輸入 `ADMIN_TOKEN`。
   - 各列會出現「作答」，可檢視該名學生的作答全文。
   - （排名預設不對學生公開，避免壓力影響作答；僅老師可看。）

2. **下載全部成績（含作答）**

   ```bash
   curl -H "X-Admin-Token: <ADMIN_TOKEN>" \
     "https://ttqs-exam.zeabur.app/api/admin/results?format=ndjson" \
     -o results.jsonl
   ```

3. **清空成績**（考試正式開始前重置；方案 A 才有持久卷）

   ```bash
   zeabur service exec --id <SERVICE_ID> --env-id <ENV_ID> \
     -- sh -c "rm -f /data/results.jsonl"
   ```

> 建議節奏：考前先清空成績 → 開考 → 考後立刻用 admin 端點下載存底。

---

## 安全 / 維運提醒

- **金鑰只放 Zeabur 環境變數**：`DIFY_API_KEY`、`ADMIN_TOKEN`、`SESSION_SECRET` 一律不進版控、不寫死在程式。
- **勿刪服務**：刪 service 會連同 `/data` 持久卷一起刪除 → 成績永久消失。要停用就停，不要刪。
- 重新部署（沿用同 service）不會丟成績；只有「刪服務 / 刪卷 / 方案 B 無卷」會丟。
- `ALLOW_ORIGINS` 要與正式網域一致，避免被跨站濫用。
- 用 CLI 部署前務必先 `mv .env /tmp/.env.bak`，部署後再還原。

---

## 待回填（首次部署後補上實際值）

```
方案            : A / B  （請圈選；正式建議 A）
project id      : __________
service id      : __________   (name: __________)
environment id  : __________
正式網址        : https://__________.zeabur.app
持久卷掛載      : /data  （方案 A 應為已掛載；方案 B 無）
```

> 回填後請同步更新 `exam_app/DEPLOY.md` 內對應欄位。
