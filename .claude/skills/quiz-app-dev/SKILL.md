---
name: quiz-app-dev
description: 開發/維運 quiz_app(TTQS 線上測驗服務)時使用——改考卷規格、前端畫面、後台功能、Dify 產題、養題庫、部署 Zeabur。凡是動到 quiz_app/ 目錄、ttqs-quiz.zeabur.app、題庫池、或「線上測驗」相關需求都先讀本 skill。
---

# quiz_app 接續開發指引

## 先讀這三份(依序)

1. `quiz_app/SPEC.md` — 完整規格:考卷規格、API 契約、資料 schema、畫面對應、部署現況
2. `quiz_app/README.md` — 啟動與操作
3. `docs/devlog/2026-07-08-quiz-app-dify-integration.md` — 為什麼這樣設計(池化、伺服器端評分、踩過的坑)

視覺以 `docs/design/ttqs-exam-prototype/`(Claude design 原型,6 畫面)為準;
設計 tokens 已抽在 `quiz_app/public/style.css` 的 `:root`。

## 架構一句話

Dify(掛 TTQS 教材知識庫的出題 App)→ 後台產題入池(`data/question_pool.json`)→
開考從池抽 20 題(12 選擇+8 是非)→ 伺服器端評分 → `data/results.jsonl` 統計。
**開考路徑零 AI 呼叫**;Dify 只在管理者按「產生題目」時被打。

## 關鍵檔案

| 檔案 | 內容 | 改動注意 |
|---|---|---|
| `quiz_app/server.js` | 全部後端(零依賴 node:http) | `PAPER` 常數=考卷規格;新增 API 記得掛速率限制與同源檢查之後 |
| `quiz_app/public/app.js` | 考生端 SPA(home/quiz/result/review) | 題目文字一律 `textContent`,禁 innerHTML 塞題目(XSS) |
| `quiz_app/public/admin.js` | 後台 | token 存 localStorage,送 Bearer |
| `quiz_app/seed_question_pool.json` | 100 題 seed(入版控) | 池養大後記得同步:`cp data/question_pool.json seed_question_pool.json` |
| `exam_app/dify_question_gen_prompt.md` | Dify 出題 App 的 system prompt | 改題型/schema 要同步改 server.js 的 `validQuestion()` |

## 本機開發

```bash
cd quiz_app && cp .env.example .env   # 填 DIFY_API_KEY
set -a && source .env && set +a && node server.js
# 前台 http://127.0.0.1:8891  後台 /admin
```

⚠ 本機 PORT 用 **8891**:8090 被這台機器的 Agent DVR 佔住(IPv4),node 會綁到 IPv6 同 port,
curl 通、瀏覽器卻連到別人——看到「不是自己的頁面」先 `lsof -iTCP:<port>`。

測試(無測試框架,用腳本實測):

```bash
# API 全流程:開考→交卷→評分正確性→重複交卷 410
# 參考 devlog 的驗證清單;UI 用 webwright/Playwright 打 6 畫面截圖
curl -s http://127.0.0.1:8891/api/status
```

## 養題庫

後台 UI 按鈕,或 API(每批上限 選擇10+是非10,主題錯開可降重複率):

```bash
curl -X POST http://127.0.0.1:8891/api/admin/generate \
  -H 'Content-Type: application/json' \
  -d '{"mcq":10,"tf":8,"topic":"作業要點:效期與複評"}'
```

Dify 回應偶包 ```json 圍欄,`parseDifyJson()` 已容錯;新題入池會驗證+去重。
養完同步 seed 並 commit(讓部署帶新題)。

## 部署(Zeabur / hobbit server)

現行 ids 與變數見 `quiz_app/SPEC.md` §9。重佈一行:

```bash
cd quiz_app && mv .env /tmp/ && zeabur deploy \
  --project-id 6a4dc363721fddff77e885a6 --service-id 6a4dc37b1a139de1d5cf1472 \
  --environment-id 6a4dc363104975fcb4675bed -i=false; mv /tmp/.env .
```

- 部署前**務必移開 .env**(雙保險,.dockerignore 已排除)
- 未掛持久卷:題庫由 seed 復原,**成績重佈即失**;要保成績去主控台掛 /data 卷
- `ADMIN_TOKEN` 在 Zeabur 變數(本機備份 `quiz_app/.admin_token.local`,gitignored)

## 常見任務 playbook

- **改考卷題數/配分/時間**:`server.js` `PAPER` + `index.html` 首頁文案(規格條是動態的,說明文字是寫死的)+ SPEC.md
- **加新題型**:先改 `exam_app/dify_question_gen_prompt.md`(schema)→ `server.js` `validQuestion()` + 抽題邏輯 → 前端 render + 解析 render → SPEC.md
- **加後台頁**(成績紀錄/題庫編輯):side-nav 在 `admin.html` 已留位;新 API 記得 `isAdmin()` 檢查
- **配額/濫用問題**:調 `RATE_PER_MIN`/`RATE_GLOBAL_PER_MIN` env,不要改碼

## 慣例

- 沿 repo 全域 CLAUDE.md:非小改動邊做邊寫 devlog(`docs/devlog/`)、風險改動前 git snapshot
- commit 訊息:`feat(quiz_app): ...` 繁中,說 why 不說 what
- 零依賴原則:不要為了小功能引入 npm 套件(安全審計面)
