# 部署資訊（Zeabur）

> 狀態：**尚未首次部署**。以下為部署步驟與待填欄位；首次部署後把實際 id / 網址回填到本檔。

## 建議設定

- 網址（建議）：**https://ttqs-exam.zeabur.app**（自動 HTTPS）
- 部署方式：**Dockerfile / Node service**（非 Static），零依賴 Node 後端
- 持久卷：`/data`（存成績 `results.jsonl`，跨重新部署保留）——用「含 volumes 的 Zeabur Template」建立

## 首次部署步驟

1. 推上 GitHub（repo：`Chiuchau-Inc/ttqs-exam`）。
2. Zeabur 建立 Project → Add Service → 選 GitHub repo，**Root Directory 設 `exam_app`**（Dockerfile 在此）。
   - 若要持久化成績，改用含 volume 的 Template，掛載點 `/data`。
3. 設定環境變數（見下）。
4. 綁定網域 → 自動 HTTPS。
5. 部署完成後，把下列 id 回填本檔：

   ```
   project id   : __________
   service id   : __________ (name: __________)
   environment  : __________
   正式網址      : https://__________.zeabur.app
   ```

## 重新部署（更新程式碼，回填 id 後可用）

```bash
cd exam_app
mv .env /tmp/.env.bak    # 避免上傳機密（.dockerignore 也已排除）
zeabur deploy --project-id <PROJECT_ID> \
  --service-id <SERVICE_ID> \
  --environment-id <ENV_ID> -i=false
mv /tmp/.env.bak .env
```

> 沿用同一個 service id 重新部署，`/data` 會保留。**不要刪除服務**（會連帶刪掉卷與成績資料）。

## 環境變數（在 Zeabur 設定，非檔案）

| 變數 | 說明 |
|------|------|
| `DIFY_API_KEY` | Dify App 的 API Key（app-xxxx）。**沒設則 AI 評分自動退回自評模式** |
| `DIFY_BASE_URL` | 預設 `https://api.dify.ai/v1`；自架 Dify 改你的網域 + `/v1` |
| `SESSION_SECRET` | session token 簽章密鑰；多實例務必同一把 |
| `TRUST_PROXY` | 置於 Zeabur 反向代理後設 `1` |
| `ALLOW_ORIGINS` | `https://ttqs-exam.zeabur.app`（對外公開建議設） |
| `RATE_PER_MIN` / `RATE_GLOBAL_PER_MIN` | 速率限制（預設 40 / 600） |
| `DATA_DIR` | `/data`（持久卷掛載點） |
| `ADMIN_TOKEN` | 老師稽核用，請設長亂碼、妥善保管 |

查看：`zeabur variable list --id <SERVICE_ID> --env-id <ENV_ID>`

## 老師操作

- **成績檢視老師模式**：開 `https://<網址>/board.html` → 點「🔑 老師模式」→ 輸入 `ADMIN_TOKEN` → 各列出現「作答」可看該生作答。
- **下載全部成績（含作答）**：
  `curl -H "X-Admin-Token: <ADMIN_TOKEN>" "https://<網址>/api/admin/results?format=ndjson" -o results.jsonl`
- **清空成績**（考試正式開始前重置）：
  `zeabur service exec --id <SERVICE_ID> --env-id <ENV_ID> -- sh -c "rm -f /data/results.jsonl"`

## 安全/維運提醒

- 重新部署不會丟成績資料；但**刪除服務會連卷一起刪**。
- `ADMIN_TOKEN` 與 `DIFY_API_KEY` 只在 Zeabur 環境變數，不在版控。
- 建議考試前先清空成績、考後用 admin 端點下載存底。

> 參考：同架構的 ISO 14067 模擬考已部署於 Zeabur 專屬伺服器 hobbit（見該專案 DEPLOY.md），TTQS 可沿用相同流程另開服務。
