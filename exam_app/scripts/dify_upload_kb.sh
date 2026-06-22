#!/usr/bin/env bash
#
# dify_upload_kb.sh — 自動在 Dify 建立「知識庫(Dataset)」並上傳 TTQS 教材。
#
# 用途：把 docs/materials/*.md 與 docs/materials/official/*.md 全部灌進 Dify 知識庫，
#       供 Chatflow 的 Knowledge Retrieval 節點檢索（評分/討論時注入 {{#context#}}）。
#
# 需要的環境變數：
#   DIFY_DATASET_API_KEY  (必填) Dify「知識庫 API」金鑰，格式 dataset-xxxx
#                         取得：Dify → 知識庫(Knowledge) → 右上「API」→ 建立金鑰。
#                         注意：這把與應用程式的 app- 金鑰不同，請勿混用。
#   DIFY_BASE_URL         (選填) 預設 https://api.dify.ai/v1（自架 Dify 改成你的網域 + /v1）
#   DIFY_DATASET_NAME     (選填) 知識庫名稱，預設 "TTQS教材"
#
# 用法：
#   export DIFY_DATASET_API_KEY=dataset-xxxxxxxx
#   bash exam_app/scripts/dify_upload_kb.sh
#
# 完成後會印出 dataset id，請到 Chatflow 的 Knowledge Retrieval 節點綁定此知識庫。
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
if [ -z "${DIFY_DATASET_API_KEY:-}" ]; then
  echo "錯誤：未設定 DIFY_DATASET_API_KEY（Dify 知識庫 API 金鑰，格式 dataset-xxxx）。" >&2
  echo "      取得方式：Dify → 知識庫 → 右上『API』→ 建立金鑰，再 export 後重跑。" >&2
  exit 1
fi

BASE_URL="${DIFY_BASE_URL:-https://api.dify.ai/v1}"
BASE_URL="${BASE_URL%/}"   # 去掉結尾斜線
DATASET_NAME="${DIFY_DATASET_NAME:-TTQS教材}"
AUTH="Authorization: Bearer ${DIFY_DATASET_API_KEY}"

# 推算教材目錄：本腳本在 exam_app/scripts/，教材在 ../../docs/materials/
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MATERIALS_DIR="${REPO_ROOT}/docs/materials"

if [ ! -d "${MATERIALS_DIR}" ]; then
  echo "錯誤：找不到教材目錄 ${MATERIALS_DIR}" >&2
  exit 1
fi

# 收集所有要上傳的 md（頂層 + official/），用 nullglob 避免無檔時殘留萬用字元
shopt -s nullglob
FILES=( "${MATERIALS_DIR}"/*.md "${MATERIALS_DIR}"/official/*.md )
shopt -u nullglob
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "錯誤：${MATERIALS_DIR} 下找不到任何 .md 教材。" >&2
  exit 1
fi

echo "=========================================="
echo "Dify 知識庫上傳"
echo "  端點      : ${BASE_URL}"
echo "  知識庫名稱: ${DATASET_NAME}"
echo "  待上傳檔數: ${#FILES[@]}"
echo "=========================================="

# ---------- 1) 建立 dataset ----------
echo ">> 建立知識庫 ..."
create_resp="$(curl -sS -X POST "${BASE_URL}/datasets" \
  -H "${AUTH}" \
  -H "Content-Type: application/json" \
  --data "$(jq -n --arg name "${DATASET_NAME}" \
    '{name:$name, permission:"only_me", indexing_technique:"high_quality"}')")"

DATASET_ID="$(echo "${create_resp}" | jq -r '.id // empty')"

# 名稱已存在時 Dify 會回錯誤；嘗試從既有清單撈出同名知識庫沿用
if [ -z "${DATASET_ID}" ]; then
  echo "   建立未直接回傳 id（可能名稱已存在），改查既有知識庫 ..."
  echo "   原始回應：${create_resp}"
  list_resp="$(curl -sS -X GET "${BASE_URL}/datasets?limit=100" -H "${AUTH}")"
  DATASET_ID="$(echo "${list_resp}" | jq -r --arg name "${DATASET_NAME}" \
    '.data[]? | select(.name==$name) | .id' | head -n1)"
fi

if [ -z "${DATASET_ID}" ]; then
  echo "錯誤：無法建立或取得知識庫 id。請確認金鑰權限與名稱。" >&2
  exit 1
fi
echo "   知識庫 id = ${DATASET_ID}"

# 上傳時使用的 indexing / process 規則（自動分段、高品質索引）
PROCESS_RULE_JSON='{"indexing_technique":"high_quality","process_rule":{"mode":"automatic"}}'

# ---------- 2) 逐檔上傳（create-by-file，multipart） ----------
ok=0
fail=0
for f in "${FILES[@]}"; do
  fname="$(basename "${f}")"
  echo ">> 上傳：${fname}"
  # data 欄位放 JSON（indexing 規則）；file 欄位放實際檔案
  up_resp="$(curl -sS -X POST "${BASE_URL}/datasets/${DATASET_ID}/document/create-by-file" \
    -H "${AUTH}" \
    -F "data=${PROCESS_RULE_JSON};type=text/plain" \
    -F "file=@${f};type=text/markdown")"

  doc_id="$(echo "${up_resp}" | jq -r '.document.id // .id // empty')"
  if [ -n "${doc_id}" ]; then
    echo "   OK  document id = ${doc_id}"
    ok=$((ok + 1))
  else
    echo "   失敗，回應：${up_resp}" >&2
    fail=$((fail + 1))
  fi
done

echo "=========================================="
echo "完成：成功 ${ok} 檔，失敗 ${fail} 檔。"
echo "知識庫 id（綁定 Knowledge Retrieval 節點用）：${DATASET_ID}"
echo "提示：到 Dify 知識庫頁可看到文件『索引中→可用』；全部可用後再到 Chatflow 綁定。"
echo "=========================================="
if [ "${fail}" -gt 0 ]; then
  exit 1
fi
