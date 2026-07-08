# quiz_app:把 ttqs-exam-prototype 設計稿整合成 Dify 出題服務

## 11:05 — 架構決策:題庫池,不即時出題

**決策**:考生按「開始測驗」時從伺服器端題庫池抽 20 題(12 選擇 + 8 是非),
Dify 只在管理後台按「從 Dify 產生題目」時被呼叫,產生的題目落入 `data/question_pool.json`。

**Why**:LLM 產 20 題要 30-60 秒,考生等不起;而且每卷都打 Dify 燒額度、題目重複率高。
設計稿的管理後台本來就有「從 Dify 產生題目」按鈕與題庫表(來源欄標 Dify/人工),語意就是池化。

**替代方案**:考卷即時生成(pass,慢+貴)、預先排程批次生成(過度設計,手動觸發夠用)。

## 11:06 — 評分放伺服器端,答案不下發

**決策**:`/api/exam/start` 只回題目與選項,正解與解析留在伺服器;交卷後 `/api/exam/submit`
評分並回完整解析。與 exam_app(題庫含答案直接放前端)不同。

**Why**:這個 app 是全公司匿名測驗,管理後台要看及格率/每題答對率,答案下發前端等於開卷,
統計就沒意義。exam_app 是自我練習用,情境不同。

## 11:07 — 沿用 exam_app 的零依賴伺服器慣例

零依賴 node:http、key 只在後端 env、同源檢查 + 每 IP/全域速率限制、CSP 標頭、
data/ 持久化 jsonl、Dockerfile non-root + VOLUME /data。降低第二套服務的維運心智成本。

## 11:40 — Dify 回應解析的容錯

Dify 出題 App 依 prompt 應回純 JSON,但實測偶爾會包 ```json 圍欄。解析順序:
直接 JSON.parse → 剝圍欄再 parse → 抓第一個 {...} 區塊。三段都失敗才回錯誤給後台。
進池前逐題驗證(question/options/answer 齊全、tf 題固定兩選項)+ 以題幹正規化去重。

## 11:55 — 踩雷:port 8090 與 Agent DVR 衝突

本機 Agent DVR 佔用 IPv4 *:8090,node 綁到 IPv6 *:8090 —— curl(IPv4)打到我們的服務、
Firefox(IPv6 優先)打到 Agent DVR,除錯半天才發現是雙棧分家。
**結論**:本機 .env 改用 PORT=8891;部署環境由平台注入 PORT 不受影響。
教訓:煙霧測試看到「不是自己的頁面」先查 `lsof -iTCP:<port>`,IPv4/IPv6 可以同 port 各住一個程序。

## 12:00 — 驗證完成

- API:20 題(12 選擇+8 是非)、start 不外洩答案、伺服器端評分正確(已知 14 正解 → 80 分)、重複交卷 410。
- Dify 實打:兩批產 30 題全數入池,無重複無淘汰。
- UI:6 畫面 Playwright 全流程過,無 JS error,桌機+手機截圖對齊設計稿。
