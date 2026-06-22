#!/usr/bin/env bash
#
# test_dify.sh — 驗證 Dify Chat App 是否能正確「評分」與「討論」。
#
# 直接打 Dify 的 /chat-messages 端點（與考試 App 後端 /api/dify 代理同樣的 body 形狀），
# 確認發佈後的 Chatflow 行為正確：評分模式回單行 JSON、討論模式回自然語言。
#
# 需要的環境變數：
#   DIFY_API_KEY   (必填) Dify 應用程式 API 金鑰，格式 app-xxxx
#                  取得：Dify → 你的 Chat App → 「API 存取」→ API Key。
#   DIFY_BASE_URL  (選填) 預設 https://api.dify.ai/v1
#
# 用法：
#   export DIFY_API_KEY=app-xxxxxxxx
#   bash exam_app/scripts/test_dify.sh
#
set -euo pipefail

# ---------- 前置檢查 ----------
if ! command -v jq >/dev/null 2>&1; then
  echo "錯誤：找不到 jq，請先安裝（macOS: brew install jq / Debian: apt-get install jq）" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "錯誤：找不到 curl，請先安裝。" >&2
  exit 1
fi
if [ -z "${DIFY_API_KEY:-}" ]; then
  echo "錯誤：未設定 DIFY_API_KEY（Dify 應用程式 API 金鑰，格式 app-xxxx）。" >&2
  echo "      取得方式：Dify → 你的 Chat App → 『API 存取』→ API Key，再 export 後重跑。" >&2
  exit 1
fi

BASE_URL="${DIFY_BASE_URL:-https://api.dify.ai/v1}"
BASE_URL="${BASE_URL%/}"
AUTH="Authorization: Bearer ${DIFY_API_KEY}"
ENDPOINT="${BASE_URL}/chat-messages"

# 共用送信函式：$1=query 字串、$2=user id；以 blocking 模式取回完整 answer
# 把 query 帶進 jq 安全組 JSON（與後端代理一致：inputs:{}、response_mode:"blocking"）
ask() {
  local q="$1" uid="$2"
  curl -sS -X POST "${ENDPOINT}" \
    -H "${AUTH}" \
    -H "Content-Type: application/json" \
    --data "$(jq -n --arg q "${q}" --arg u "${uid}" \
      '{inputs:{}, query:$q, response_mode:"blocking", user:$u}')"
}

# 從 Dify 回應抓 answer；若回應是錯誤物件則印出並中止
extract_answer() {
  local resp="$1"
  local err
  err="$(echo "${resp}" | jq -r '.code // empty')"
  if [ -n "${err}" ]; then
    echo "Dify 回傳錯誤：${resp}" >&2
    return 1
  fi
  echo "${resp}" | jq -r '.answer // empty'
}

echo "=========================================="
echo "Dify Chat App 驗證"
echo "  端點：${ENDPOINT}"
echo "=========================================="

# ---------- 測試 1：評分任務（應回單行 JSON） ----------
echo
echo "[測試 1] 評分任務（預期：單行 JSON，含 score / feedback）"
GRADE_QUERY='（評分任務）請只回一行 JSON。
【題目】請說明 TTQS PDDRO 五大構面分別代表什麼。
【參考答案】PDDRO＝計畫 Plan、設計 Design、執行 Do、查核 Review、成果 Outcome（注意兩個 D：Design 與 Do）。
【評分要點】
1. 正確列出五個構面英文/中文（每對 1 分，共 5 分）。
2. 指出有「兩個 D」＝Design 與 Do（5 分）。
本題滿分 10 分。
【學員作答】PDDRO 是 Plan 計畫、Design 設計、Do 執行、Review 查核、Outcome 成果，其中有兩個 D 分別是設計和執行。'

resp1="$(ask "${GRADE_QUERY}" "test-grade-$$")"
ans1="$(extract_answer "${resp1}")"
echo "----- 回傳 answer -----"
echo "${ans1}"
echo "-----------------------"

# 驗證：是否為單行 JSON，且含 score / feedback
if [ -z "${ans1}" ]; then
  echo "[警告] answer 為空，無法判定。請檢查 Chatflow 是否正常輸出。" >&2
else
  line_count="$(printf '%s' "${ans1}" | grep -c '' || true)"
  if echo "${ans1}" | jq -e 'has("score") and has("feedback")' >/dev/null 2>&1; then
    if [ "${line_count}" -le 1 ]; then
      echo "[通過] 評分回傳為單行 JSON，且含 score 與 feedback。"
    else
      echo "[注意] JSON 含 score/feedback，但跨多行（${line_count} 行）。考試 App 正則大多仍可解析，建議調整 prompt 使其輸出單行以降低風險。"
    fi
  else
    echo "[失敗] 評分回傳不是含 score/feedback 的 JSON。請檢查 LLM SYSTEM 是否貼了 dify_system_prompt.md，以及『（評分任務）』是否觸發模式一。" >&2
  fi
fi

# ---------- 測試 2：討論題（應回自然語言說明） ----------
echo
echo "[測試 2] 討論題（預期：繁體中文自然語言說明）"
DISCUSS_QUERY='我想多了解 TTQS 的等級門檻。金牌、銀牌、銅牌、通過、未通過的分數界線各是多少？外訓版有什麼不同？請依官方教材說明。'

resp2="$(ask "${DISCUSS_QUERY}" "test-discuss-$$")"
ans2="$(extract_answer "${resp2}")"
echo "----- 回傳 answer -----"
echo "${ans2}"
echo "-----------------------"
if [ -z "${ans2}" ]; then
  echo "[警告] 討論題 answer 為空，請檢查 Chatflow。" >&2
else
  echo "[完成] 討論題已取得回應（請人工確認內容是否引用知識庫且正確）。"
fi

echo
echo "=========================================="
echo "驗證結束。"
echo "=========================================="
