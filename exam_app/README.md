# TTQS 人才發展品質管理 線上模擬考 App

考試網站：進網頁 →（90 分鐘計時）作答 → 交卷看結果 → 逐題檢討與討論。
單選題本地即時計分；簡答/申論題經**後端代理**呼叫 Dify 做 AI 語意評分與「為何沒得分」討論。

> ⚠ **不是純靜態網站**：本 app 需要 Node 後端（`server.js`）才能 AI 評分與討論。
> 不可用「靜態部署」（Zeabur Static / Vercel 純前端 / 純 Nginx 發檔），否則 `/api/*` 會 404、
> AI 功能靜默退回自評模式。請用 Dockerfile / Node service 部署。

## 題型結構（每卷隨機抽題，總分 100）

| 區塊 | 每卷抽題 | 配分 | 計分方式 |
|------|----------|------|----------|
| 第一題 單選題 | 25 題 | ×2＝50 分 | 前端本地即時計分 |
| 第二題 簡答題 | 4 題 | ×5＝20 分 | Dify 依 rubric 評分（未設則自評） |
| 第三題 申論題 | 1 題 | 30 分 | Dify 依 rubric 評分（未設則自評） |

及格 60 分。題庫現有：單選 150、簡答 24、申論 12（見 `public/question_bank.json`）。

## 組成

| 檔案 | 說明 |
|------|------|
| `server.js` | 零依賴 Node 後端：靜態檔(沙箱 `public/`) + `/api/dify` 代理 + `/api/health` + 成績記錄/老師稽核 |
| `public/index.html` `app.js` `boot.js` `style.css` | 前端（抽卷/計時/計分/檢討/討論） |
| `public/board.html` `board.js` | 老師端成績檢視（需 `ADMIN_TOKEN`） |
| `public/question_bank.json` | 題庫（由 `scripts/assemble_question_bank.js` 組裝） |
| `public/config.js` | 前端設定（**不含任何機密**，只有 `enableAiGrading` 旗標） |
| `dify_system_prompt.md` | Dify Chatflow 的 LLM 節點 SYSTEM（評分＋討論雙模式） |
| `Dockerfile` `package.json` `.env.example` | 部署 |

## 安全架構（重點）

- **Dify API key 只在後端環境變數 `DIFY_API_KEY`**，前端永遠拿不到（前端只打同源 `/api/dify`）。
- 代理防護：要求同源 Origin、短期 HMAC session token、每 IP + 全域速率限制、請求體/query 上限、
  欄位白名單（固定 `blocking`、不透傳任意 inputs）、安全標頭（CSP/HSTS…）、靜態檔沙箱防穿越、非 root 容器。
- **單選題本地計分**（答案固定，公平一致、不耗 token）；**簡答/申論 AI 依 rubric 評分**。
- **多人**：作答狀態全在各自瀏覽器 localStorage，互不干擾、可重整續答；伺服器不存任何人進度，可大量併發。

## 本機試跑

```bash
cd exam_app
cp .env.example .env          # 填入 DIFY_API_KEY（檔案請 chmod 600）
set -a && . ./.env && set +a
node server.js                # 預設 :8080
# 瀏覽器開 http://localhost:8080
```
不設 `DIFY_API_KEY` 也能跑：簡答/申論交卷後顯示**參考答案供自評**，單選仍自動計分。

## 部署（Docker / Node service）

金鑰用平台 secret 注入，**不要**把 `.env` 明碼檔放進伺服器或映像。詳見 `DEPLOY.md`。

```bash
docker build -t ttqs-exam .
docker run -d -p 8080:8080 \
  -e DIFY_API_KEY=app-xxxx \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e TRUST_PROXY=1 \           # 置於可信反向代理(如 Zeabur/Nginx)後才設 1；直曝請設 0
  -e ALLOW_ORIGINS=https://ttqs-exam.zeabur.app \
  ttqs-exam
```

- **Zeabur**：以 **Dockerfile / Node service**（非 Static）部署；在環境變數設 `DIFY_API_KEY` 等；綁網域後自動 HTTPS。
- 置於反向代理後：`TRUST_PROXY=1` 且代理需以可信值覆寫 `X-Forwarded-For`（或用 `X-Real-IP`），per-IP 限制才正確。

### Dify 端

LLM 節點 SYSTEM 用 `dify_system_prompt.md`（評分+討論雙模式）、CONTEXT 接知識庫（灌入 `docs/materials/` 的 TTQS 教材）、開 Memory。

## 題庫怎麼來 / 怎麼更新

1. 出題片段放在 `scripts/fragments/*.json`（每檔可含 `mcq`/`short`/`essay` 任一子集）。
   目前的片段由多個 sub-agent 依 `docs/materials/` 教材生成（企業版 P/D、執行查核成果制度、理論基礎、簡答申論）。
2. 跑組裝：

   ```bash
   node scripts/assemble_question_bank.js
   ```

   會合併、編號、基本驗證（選項/答案/rubric/抽題量）後輸出 `public/question_bank.json`。
3. 要加題就在 `scripts/fragments/` 新增片段檔再重跑組裝；要改每卷題數/配分改 `assemble_question_bank.js` 的 `STRUCTURE`/`META`。

## 安全維運

- `DIFY_API_KEY` 若曾以明碼出現在開發機/截圖/備份，請在 Dify 後台 revoke 並換新。
- 多實例部署務必設同一把 `SESSION_SECRET`（否則 token 跨實例失效）。
- 對外公開建議設 `ALLOW_ORIGINS`，並可在 Dify 後台另設用量上限作為最終防線。
- 老師稽核：設 `ADMIN_TOKEN` 後可在 `board.html`「老師模式」看作答、或 `/api/admin/results` 下載成績。
