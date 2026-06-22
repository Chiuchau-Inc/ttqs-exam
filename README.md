# TTQS 人才發展品質管理｜教材收集 × 線上題庫 × 線上考試系統

勞動部勞動力發展署 **TTQS（人才發展品質管理系統 / Talent Quality-management System）** 的
教材與試題收集，並做成一套**線上題庫 + Dify AI 出題/評分的線上考試系統**。

## 這個 repo 有什麼

```
ttqs-exam/
├─ docs/materials/            # 📚 教材收集（題庫的知識來源，皆附官方出處）
│  ├─ 00-來源與索引.md
│  ├─ 01-企業機構版-評核指標.md     # PDDRO 5 構面、企業版 19 指標逐條、計分/等級
│  ├─ 02-訓練機構版-評核制度.md     # 訓練機構版 19 指標、與企業版差異、評核/效期/複評
│  ├─ 03-訓練品質管理-理論基礎.md   # ADDIE / TNA / Kirkpatrick / Phillips ROI / 職能 / PDCA↔PDDRO
│  └─ official/               # 官方 PDF 原件 + 經 VLM 逐頁轉錄的 md（評核表、作業要點、Q&A）
│     └─ pdf/                 # 官方 PDF 原檔
└─ exam_app/                  # 🖥️ 線上考試 App（零依賴 Node 後端 + 純前端 + Dify 代理）
   ├─ server.js               # 後端：靜態檔沙箱 + /api/dify 代理 + 成績記錄 + 老師稽核
   ├─ public/                 # 前端 + question_bank.json 題庫
   ├─ scripts/                # 題庫組裝（assemble_question_bank.js）+ 出題片段 fragments/
   ├─ dify_system_prompt.md   # Dify Chatflow 的評分/討論 system prompt
   ├─ Dockerfile / DEPLOY.md  # Zeabur 部署
   └─ README.md               # App 詳細說明
```

## 系統怎麼運作

1. **題庫**：依 `docs/materials/` 教材生成 `exam_app/public/question_bank.json`
   （目前 **66 單選 + 12 簡答 + 6 申論**；每卷隨機抽 25 單選 + 4 簡答 + 1 申論 = 100 分）。
2. **考試**：學員進網頁 →（90 分鐘計時）作答 → 交卷。
   - 單選題：前端**本地即時計分**（公平、不耗 token）。
   - 簡答/申論：經後端 `/api/dify` 代理呼叫 **Dify** 依 rubric 做 AI 語意評分；可追問「為什麼沒得分」做討論。
   - 沒設 Dify 金鑰也能跑：自動退回「參考答案自評」模式。
3. **出題/評分用 Dify**：把 `docs/materials/` 教材灌進 Dify 知識庫，LLM 節點套用 `exam_app/dify_system_prompt.md`。

## 安全重點（沿用 ISO 14067 模擬考架構）

- Dify API key **只在後端環境變數**，前端永遠拿不到。
- 代理層：同源檢查、HMAC session token、速率限制、欄位白名單、CSP/HSTS、靜態檔沙箱、非 root 容器。
- 刻意採**零依賴 Node**（非框架），縮小攻擊面。

## 快速開始

```bash
cd exam_app
cp .env.example .env          # 填 DIFY_API_KEY（可先留空，用自評模式）
set -a && . ./.env && set +a
node server.js                # http://localhost:8080
```

更新題庫：在 `exam_app/scripts/fragments/` 增修出題片段，再 `node exam_app/scripts/assemble_question_bank.js`。

## 教材蒐集方法

- 以勞動部勞動力發展署官方文件為主（評核表、作業要點、Q&A），事實均附出處；查不到者標「待查證」。
- 官方 PDF 由 **Claude subagent 以 VLM 逐頁解析轉成 markdown**（見 `docs/materials/official/`），平行派工進行。
- 概念與理論基礎輔以權威來源（iCAP、學術文獻）。

> 部署：見 `exam_app/DEPLOY.md`（Zeabur，Dockerfile/Node service，建議網址 `ttqs-exam.zeabur.app`）。
