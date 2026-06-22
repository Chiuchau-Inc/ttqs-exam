# TTQS 考試 App × Dify 串接設定指南

本文件說明如何把 **TTQS 線上模擬考 App** 接上 **Dify Cloud**（`https://api.dify.ai/v1`），
讓 Dify 負責兩件事：**(1) 簡答/申論題 AI 評分**、**(2) 與學員討論題目**。
考試 App 自己負責出題、抽卷、單選計分，Dify 不碰那部分。

架構摘要：

```
瀏覽器(考試 App 前端)
   └─ POST /api/dify ──► 考試 App 後端(server.js，持有 DIFY_API_KEY)
                              └─ POST https://api.dify.ai/v1/chat-messages ──► Dify Chat App
                                                                                    └─ Knowledge Retrieval ─► 知識庫(TTQS教材)
```

> 重點：Dify 的 `app-` 金鑰**只放在後端環境變數 `DIFY_API_KEY`**，永不送到前端。
> 後端代理固定送 `inputs:{}, query, response_mode:"blocking", user`（可選 `conversation_id`），
> 帶 `Authorization: Bearer DIFY_API_KEY`，並做同源檢查、速率限制、session token 驗證。

---

## 前置需求

- 一個 Dify Cloud 帳號（<https://dify.ai>）。
- 本機已安裝 `curl` 與 `jq`（給自動化腳本用）。
  - macOS：`brew install jq`
  - Debian/Ubuntu：`apt-get install -y jq`

---

## (a) 建立知識庫(Knowledge) 並上傳 TTQS 教材

知識庫請灌入 **RAG 檢索優化版**教材（位於 `docs/materials/dify-kb/rag/`）。這些檔案已把所有 markdown 表格改寫成「每句自帶完整脈絡」的敘述/條列，embedding 切塊與向量檢索的準確度遠優於原始含表格版本。

### 要上傳的檔案（擇一）

**選項 1（最省事）：上傳單一合併檔**

- `docs/materials/dify-kb/TTQS-knowledge-base.md`（由下列 8 份 rag 檔合併，已無任何表格）

**選項 2（分檔，檢索定位較精準）：上傳 `docs/materials/dify-kb/rag/` 下 8 份**

- `01-企業機構版-評核指標.md`
- `02-訓練機構版-評核制度.md`
- `03-訓練品質管理-理論基礎.md`
- `官方-企業機構版評核表.md`
- `官方-訓練機構版評核表.md`
- `官方-辦訓能力檢核表.md`
- `官方-作業要點.md`
- `官方-TTQS-QA.md`

> 註 1：**請勿上傳 `docs/materials/` 與 `docs/materials/official/` 下的原始版**——那些保留 markdown 表格供人閱讀，但 pipe 表格被切塊後欄位會與表頭分家、語意脈絡流失，不利向量檢索。RAG 版才是給 Dify 用的。
> 註 2：`docs/materials/official/pdf/` 下的原始 PDF 是來源憑證，**不需上傳**。

### 兩種上傳方式（擇一）

**方式一：自動化腳本（建議）** — 見本文件 [自動化腳本](#自動化腳本) 小節，
一行指令建好知識庫並上傳全部 8 份 RAG 優化 md（腳本讀 `docs/materials/dify-kb/rag/`）。

**方式二：Dify 網頁手動**

1. Dify 左側 → **知識庫(Knowledge)** → **建立知識庫**。
2. 上傳上面「選項 1 的合併檔」或「選項 2 的 8 份 rag md」。
3. 分段設定：**Process Rule = Automatic（自動分段與清洗）**。
4. 索引方式：**High Quality（高品質，向量索引）**。
5. 命名例如「TTQS教材」，建立並等待文件由「索引中」變成「可用」。

### 檢索參數建議

- **Top K：5–8**（教材條目細、指標多，取 5–8 段較能覆蓋；太大反而稀釋相關度）。
- 索引技術：**High Quality**。
- Score 閾值：可先不開，視召回品質再調。

---

## (b) 建立 Chatflow / Chat App

目標：使用者訊息 → **Knowledge Retrieval** 檢索教材 → 結果接到 **LLM** 節點的 `{{#context#}}` → 輸出。

1. Dify → **工作室(Studio)** → **建立應用** → 選 **Chatflow**（或進階的 Workflow 型 Chat）。
2. 在畫布上，於「開始」之後加入 **Knowledge Retrieval（知識檢索）** 節點：
   - 查詢變數：使用者輸入 `sys.query`。
   - 綁定知識庫：選上一步建立的「TTQS教材」。
   - Top K 設 **5–8**，索引/檢索用 High Quality。
3. 加入 **LLM** 節點，接在 Knowledge Retrieval 之後：
   - **CONTEXT 欄**：選 Knowledge Retrieval 的輸出（result）作為上下文變數。
   - **SYSTEM 欄**：完整貼上 `exam_app/dify_system_prompt.md` 中三反引號 ` ``` ` 包住的整段提示詞
     （從「你是『TTQS 人才發展品質管理系統』課程的閱卷老師兼助教…」到最後一行）。
     該提示詞中已含 `{{#context#}}` 佔位；務必確認 Dify 把它對應到 Knowledge Retrieval 的結果變數，
     **否則檢索內容讀不到、context 警告不會消失**。
   - **開啟 Memory（記憶）**：討論模式要記得上下文。
     （評分模式由考試 App 每次用新的 conversation 呼叫，不受記憶影響。）
4. 最後接 **直接回覆 / 結束** 節點，輸出 LLM 的 `text`。
5. 模型選擇：討論可用較輕量模型；若評分嚴謹度或詳解品質不足，換較強模型。

> **為什麼評分要「只回單行 JSON」**：考試 App 的 `aiGrade()` 會用正則抓回應裡的 `{...}` 解析出
> `score` / `feedback`。模型若多回寒暄或 markdown，雖然正則大多仍能抓到，但多話會增加解析失敗風險，
> 所以 SYSTEM 提示詞已明確要求評分模式（訊息含「（評分任務）」）只輸出一行 JSON。

---

## (c) 取得 app- 金鑰並設定考試 App 後端環境變數

1. 在該 Chat App **發佈(Publish)**。
2. 左側 → **API 存取(API Access)** → 取得 **API Key**（格式 `app-xxxx`）。
3. 把金鑰與端點設進考試 App 後端的環境變數：

**本機（`.env`）** — 複製 `exam_app/.env.example` 為 `exam_app/.env`，填入：

```dotenv
DIFY_API_KEY=app-你的金鑰
DIFY_BASE_URL=https://api.dify.ai/v1
```

> `.env` 已被 gitignore，不入版控。其餘變數（PORT、SESSION_SECRET、ALLOW_ORIGINS 等）見 `.env.example`。

**Zeabur（正式部署）** — 在該服務的 **環境變數(Environment Variables)** 新增：

| 變數 | 值 |
|------|----|
| `DIFY_API_KEY` | `app-你的金鑰` |
| `DIFY_BASE_URL` | `https://api.dify.ai/v1` |

設定後重新部署。後端偵測到 `DIFY_API_KEY` 後 `/api/dify` 才會啟用 AI 評分；
未設則前端自動退回「自評模式」。

---

## (d) 驗證

設好 `app-` 金鑰後，用測試腳本直接打 Dify，確認評分/討論行為正確：

```bash
export DIFY_API_KEY=app-你的金鑰
# 若自架 Dify 再 export DIFY_BASE_URL=https://你的網域/v1
bash exam_app/scripts/test_dify.sh
```

腳本會送兩個請求並檢查：

1. **評分任務**（query 含「（評分任務）」）：應回**單行 JSON**，含 `score` 與 `feedback`。
   - 若回傳不是含 `score`/`feedback` 的 JSON → 檢查 LLM SYSTEM 是否貼了 `dify_system_prompt.md`。
   - 若 JSON 跨多行 → 考試 App 正則大多仍可解析，但建議微調 prompt 讓它輸出單行以降低解析失敗風險。
2. **討論題**：應回繁體中文自然語言說明（請人工確認是否引用知識庫且內容正確）。

最後，把後端跑起來、用瀏覽器走一次完整考試流程，確認 AI 評分與討論在前端正常顯示。

---

## 自動化腳本

兩支腳本都在 `exam_app/scripts/`，需要 `curl` + `jq`。

### `dify_upload_kb.sh` — 自動建知識庫並上傳教材

用 Dify **知識庫(Dataset) API** 建立知識庫並上傳 `docs/materials/dify-kb/rag/*.md`（RAG 優化版）。

> **注意金鑰不同**：這支用的是 **知識庫 API 金鑰（`dataset-xxxx`）**，與 Chat App 的 `app-` 金鑰不同。
> 取得：Dify → **知識庫(Knowledge)** → 右上 **API** → 建立金鑰。

```bash
export DIFY_DATASET_API_KEY=dataset-你的金鑰
# 可選：export DIFY_BASE_URL=https://api.dify.ai/v1（預設值）
# 可選：export DIFY_DATASET_NAME=TTQS教材（預設值）
bash exam_app/scripts/dify_upload_kb.sh
```

腳本行為：

- 先 `POST {base}/datasets` 建立知識庫（`indexing_technique=high_quality`），用 `jq` 取回 dataset id；
  名稱若已存在則自動沿用既有知識庫。
- 逐檔 `POST {base}/datasets/{id}/document/create-by-file`（multipart，`curl -F`），
  `process_rule mode=automatic`、`indexing_technique=high_quality`，逐步印出每個 document id。
- 結束印出 **dataset id**，請拿去 Chatflow 的 Knowledge Retrieval 節點綁定。

### `test_dify.sh` — 驗證評分與討論

見上面 [(d) 驗證](#d-驗證)。

---

## 常見問題

- **context 警告不消 / 答案不引用教材**：通常是 LLM 節點的 `{{#context#}}` 沒對應到 Knowledge Retrieval
  的輸出，或知識庫文件還在「索引中」。確認綁定與索引完成。
- **評分回傳不是 JSON**：確認 SYSTEM 貼的是 `dify_system_prompt.md` 的提示詞，且 App 送的 query 確實含「（評分任務）」。
- **`dataset-` 與 `app-` 金鑰搞混**：上傳教材用 `dataset-`（知識庫 API）；考試 App 後端與 `test_dify.sh` 用 `app-`（應用 API）。
- **自架 Dify**：把所有 `DIFY_BASE_URL` 改成你的網域 + `/v1`。
