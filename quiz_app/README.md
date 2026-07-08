# quiz_app — TTQS 線上測驗

依 `ttqs-exam-prototype` 設計稿(Claude design 匯出,6 畫面)實作的匿名測驗服務,
題目由 **Dify 出題 App**(system prompt 見 `../exam_app/dify_question_gen_prompt.md`)產生。

## 架構

- **題庫池**:管理後台按「從 Dify 產生題目」→ 呼叫 Dify `chat-messages` → 解析嚴格 JSON →
  驗證/去重 → 存入 `data/question_pool.json`。考生開考時從池中抽題,**不即時打 Dify**(快、省額度)。
- **考卷**:20 題 = 選擇 12 + 是非 8,每題 5 分,70 分及格,限時 30 分鐘。
- **評分在伺服器端**:`/api/exam/start` 不下發答案,交卷後 `/api/exam/submit` 評分並回解析;
  成績寫入 `data/results.jsonl` 供後台統計(及格率、每題答對率)。
- 零依賴 Node(沿用 exam_app 慣例):key 只在後端 env、同源檢查、速率限制、CSP。

## 本機啟動

```bash
cp .env.example .env   # 填入 DIFY_API_KEY
set -a && source .env && set +a && node server.js
# 前台 http://localhost:8090 、後台 http://localhost:8090/admin
```

首次使用:先到 `/admin` 按「從 Dify 產生題目」補題(池內需 選擇≥12、是非≥8 前台才能開考)。

## API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET  | `/api/status` | 題庫是否就緒、考卷規格 |
| POST | `/api/exam/start` | `{name}` → 考卷(題目不含答案) |
| POST | `/api/exam/submit` | `{exam_id, answers, elapsed_sec}` → 成績 + 逐題解析 |
| GET  | `/api/admin/overview` | 統計 + 題庫清單(含每題答對率) |
| POST | `/api/admin/generate` | `{mcq, tf, topic?, difficulty?}` → 呼叫 Dify 產題入池 |
| DELETE | `/api/admin/question?id=` | 刪題 |
| GET  | `/api/admin/results.csv` | 匯出成績 |

`/api/admin/*` 在設定 `ADMIN_TOKEN` 後需帶 `Authorization: Bearer <token>`(後台頁右上輸入框)。
**未設 ADMIN_TOKEN 則不驗證,僅限本機開發。**

## 部署(Zeabur)

沿用 exam_app 模式:Dockerfile 部署、環境變數注入 `DIFY_API_KEY`/`ADMIN_TOKEN`、
持久卷掛 `/data`(題庫池與成績都在裡面,重佈不丟)。參考 `../docs/zeabur-deploy-runbook.md`。

## 進行中考卷的限制

開考中的考卷存在記憶體(Map),**伺服器重啟會使進行中的考卷失效**(考生會看到
「考卷不存在或已過期」),已交卷成績不受影響。單實例部署即可,多實例需改共用儲存。
