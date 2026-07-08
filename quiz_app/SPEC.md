# quiz_app 規格書(SPEC)

> 給接手的人/agent:本檔是 quiz_app 的完整規格。搭配 `README.md`(操作)、
> `../docs/devlog/2026-07-08-quiz-app-dify-integration.md`(決策脈絡)、
> `../docs/design/ttqs-exam-prototype/`(視覺設計稿原型)一起看。

## 1. 產品定位

個人名義提供的 **TTQS 匿名線上測驗**(給同學/一般考生)。考生免註冊、20 題 60 分鐘、交卷立即看成績與解析;
管理者在後台用 Dify 產題、看統計、匯出成績。

與同 repo `exam_app`(60 分鐘模擬考,20 題選擇+是非,Dify 逐題討論)是**兩個獨立服務**,分工:

| | quiz_app(本服務) | exam_app |
|--|--|--|
| 對象 | 同學/一般考生匿名快測 | 認真備考的學員 |
| 題型 | 選擇 + 是非 | 選擇 + 是非(簡答/申論已停用) |
| Dify 角色 | **考前**出題(入題庫池) | **考後**逐題討論 |
| 評分位置 | 伺服器端 | 前端本地 |
| 答案是否下發 | 交卷後才給 | 題庫含答案在前端 |

## 2. 考卷規格

定義於 `server.js` 的 `PAPER` 常數(改規格只動這裡 + 首頁文案):

- 每卷 **20 題 = 選擇 12 + 是非 8**,亂序;每題 5 分,滿分 100
- **70 分及格**(答對 14 題)
- 限時 **60 分鐘**,前端倒數,到時自動交卷;伺服器另有 70 分鐘 TTL 寬限
- 題目從題庫池隨機抽樣(選擇/是非分開抽再合併洗牌)

## 3. 題庫池

- 檔案:`data/question_pool.json`(執行期,gitignored);**seed:`seed_question_pool.json`**(入版控,
  目前 100 題 = 選擇 60 + 是非 40)。空池啟動時自動以 seed 初始化。
- 題目結構(選擇題):

```json
{
  "id": "q_xxxxxxxxxxxx",
  "question": "題幹",
  "options": {"a": "...", "b": "...", "c": "...", "d": "..."},
  "answer": "a",
  "explanation": "為何正解、其他選項錯在哪",
  "source": "企業機構版評核表:指標17a",
  "topic": "主題", "difficulty": "易|中|難",
  "origin": "Dify", "added_at": 1780000000000
}
```

- 是非題:同上,多 `"subtype": "tf"`,`options` 固定 `{"a":"正確","b":"錯誤"}`。
- 產題:後台呼叫 Dify 出題 App(prompt = `../exam_app/dify_question_gen_prompt.md`,
  該 App 掛 TTQS 官方教材知識庫做 RAG)。回應解析容錯:直接 parse → 剝 ```json 圍欄 → 抓第一個 {...}。
- 入池前逐題驗證(欄位齊全、tf 恰兩選項、answer 在選項內)+ 題幹正規化去重。

## 4. API 契約

Base:同源 `/api`。所有 POST 檢查同源 Origin;速率限制每 IP 60/min、全域 600/min。

### 前台

| Endpoint | 說明 |
|---|---|
| `GET /api/status` | `{ready, paper:{mcq,tf,points_each,pass_score,duration_min}, pool:{mcq,tf}}` |
| `POST /api/exam/start` `{name}` | 回考卷。**不含 answer/explanation**。`{exam_id, name, duration_min, pass_score, points_each, questions:[{no, qid, type:"mcq"\|"tf", question, options}]}`。池不足回 503 |
| `POST /api/exam/submit` `{exam_id, answers:{qid:"a".."d"}, elapsed_sec}` | 評分。`{name, score, total, pass, pass_score, ok_n, n, mcq_ok, mcq_n, tf_ok, tf_n, elapsed_sec, items:[{no, qid, type, question, options, your_answer, correct_answer, correct, explanation, source}]}`。考卷用過即銷毀,重複交卷回 410 |

### 後台(設 `ADMIN_TOKEN` 後需 `Authorization: Bearer <token>` 或 `?token=`)

| Endpoint | 說明 |
|---|---|
| `GET /api/admin/overview` | 統計 + 題庫清單:`{attempts, week_attempts, avg_score, pass_n, pass_rate, pool_n, pool_mcq, pool_tf, dify_enabled, questions:[{id, question, type, topic, source, ok_rate}]}` |
| `POST /api/admin/generate` `{mcq≤10, tf≤10, topic?, difficulty?}` | 呼叫 Dify 產題入池,回 `{added, dropped, pool_n}`。同步呼叫,約 10–60 秒 |
| `DELETE /api/admin/question?id=` | 刪題 |
| `GET /api/admin/results.csv` | UTF-8 BOM CSV(時間/暱稱/分數/及格/選擇對/是非對/秒數) |

### 進行中考卷的狀態

存記憶體 `Map`(examId → 題目+開始時間)。**重啟即失效**(交卷回 410,考生需重考);
已交卷成績在 `data/results.jsonl` 不受影響。多實例部署需改共用儲存(Redis/DB)——目前單實例。

## 5. 成績紀錄

`data/results.jsonl`,一行一筆:

```json
{"ts":1780000000000,"name":"考生 A-017","score":85,"pass":true,"elapsed_sec":1294,
 "mcq_ok":10,"mcq_n":12,"tf_ok":7,"tf_n":8,"items":[{"qid":"q_xx","correct":true}]}
```

`items` 只留 qid+correct(供每題答對率統計),不存作答內容(匿名原則)。

## 6. 前端畫面(對應設計稿 6 畫面)

單一 `index.html` 四個 view 切換(`#view-home/quiz/result/review`)+ 獨立 `admin.html`:

| 設計稿 | 實作 | 要點 |
|---|---|---|
| 01 首頁 | `#view-home` | 規格條(由 /api/status 動態)、測驗說明、暱稱+開始;池不足時停用按鈕 |
| 02 作答頁 | `#view-quiz` | sticky 黑頂欄(計時/已作答)、進度細線、右側 sticky 作答總覽格(點格跳題)、交卷確認 |
| 02M 手機 | `@media ≤860px` | 隱藏側欄,固定底部交卷列,選項 min-height 44px |
| 03 成績 | `#view-result` | 大分數、及格 pill、選擇/是非分項、各題對錯格 |
| 04 解析 | `#view-review` | 全部/答錯 chips、你的答案(紅)vs 正解(綠)、解析+出處、列印 |
| 05 後台 | `admin.html` | 統計卡、Dify 產題面板、題庫表(搜尋/答對率/刪題)、CSV |

設計 tokens 在 `style.css` `:root`(米白 #F5F4F0 / 墨 #1A1A1A / 綠 #4A7C59 / 對 #2E7D4F / 錯 #C8321F;
Noto Sans TC + Noto Sans Mono)。題目文字一律用 `textContent` 塞入(防 XSS),不要改成 innerHTML。

## 7. 安全設計

- Dify key 只在後端 env;前端與 git 都碰不到(`.env` gitignored、`.dockerignore` 排除)
- POST 同源檢查、每 IP + 全域速率限制、body 大小上限、靜態檔路徑沙箱、CSP/nosniff/DENY frame
- Docker non-root(node 使用者)、`VOLUME /data`
- 已知取捨:考生匿名故無 session;同一人可重複應試(統計以「人次」計)

## 8. 環境變數

見 `.env.example`。必填:`DIFY_API_KEY`(產題用);正式部署必設:`ADMIN_TOKEN`。
`PORT` 預設 8090,**本機開發用 8891**(8090 被使用者機器的 Agent DVR 佔用,IPv4/IPv6 雙棧陷阱,見 devlog)。

## 9. 部署(現況)

Zeabur dedicated server **hobbit**(Tokyo):

```
project : ttqs-quiz  (id 6a4dc363721fddff77e885a6)
service : ttqs-quiz  (id 6a4dc37b1a139de1d5cf1472)
env     : 6a4dc363104975fcb4675bed
URL     : https://ttqs-quiz.zeabur.app
變數    : DIFY_API_KEY / DIFY_BASE_URL / ADMIN_TOKEN(見本機 quiz_app/.admin_token.local)
持久卷  : 未掛(題庫由 seed 復原;results.jsonl 重佈即失 → 要保成績請在主控台掛 /data 卷)
```

重佈:`cd quiz_app && mv .env /tmp/ && zeabur deploy --project-id 6a4dc363721fddff77e885a6 --service-id 6a4dc37b1a139de1d5cf1472 --environment-id 6a4dc363104975fcb4675bed -i=false && mv /tmp/.env .`

## 10. Roadmap(未做,接手可選)

- [ ] 池低於門檻自動補題 / 排程產題
- [ ] 答對率異常題自動下架或標記人工複審
- [ ] 後台「題庫管理」獨立頁(編輯題目、人工出題入池)
- [ ] 成績紀錄頁(後台 side-nav 預留位)
- [ ] 進行中考卷改持久化(支援多實例)
- [ ] 掛 /data 持久卷保成績
