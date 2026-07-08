#!/usr/bin/env node
'use strict';
/*
 * 組裝 TTQS 題庫：讀 scripts/fragments/*.json 的題目片段，合併、編號、基本驗證後
 * 產出 public/question_bank.json。
 *
 * 片段格式（每檔可含任一子集）：
 *   { "mcq":[ {topic, topic_id, question, options{a..d}, answer, explanation, source, difficulty, verified} ],
 *     "short":[ {topic, topic_id, question, reference_answer, rubric[], source, points} ],
 *     "essay":[ {topic, topic_id, question, reference_answer, rubric[], source, points} ] }
 *
 * 用法： node scripts/assemble_question_bank.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FRAG_DIR = path.join(__dirname, 'fragments');
const OUT = path.join(ROOT, 'public', 'question_bank.json');

// ---- 考卷結構（每卷隨機抽題；總分需等於各區塊抽出題數×配分加總）----
const META = {
  title: 'TTQS 人才發展品質管理 線上模擬考',
  subtitle: '依勞動部勞動力發展署 TTQS 官方教材自動生成題庫，每次隨機抽題',
  duration_min: 60,
  total: 100,
  pass_score: 60,
};
// 每卷 20 題：單選 12 + 是非 8，每題 5 分（簡答/申論已停用，題目仍保留在題庫供日後使用）
const STRUCTURE = {
  mcq: { count: 12, points_each: 5, section: '第一題 單選題' },  // 12×5 = 60
  tf:  { count: 8,  points_each: 5, section: '第二題 是非題' },  //  8×5 = 40
};

function loadFragments() {
  if (!fs.existsSync(FRAG_DIR)) { console.error('找不到 fragments 目錄:', FRAG_DIR); process.exit(1); }
  const files = fs.readdirSync(FRAG_DIR).filter(f => f.endsWith('.json')).sort();
  const acc = { mcq: [], short: [], essay: [] };
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(FRAG_DIR, f), 'utf8')); }
    catch (e) { console.error(`  ✗ 解析失敗 ${f}: ${e.message}`); continue; }
    for (const k of ['mcq', 'short', 'essay']) if (Array.isArray(data[k])) acc[k].push(...data[k]);
    console.log(`  ✓ ${f}: mcq=${(data.mcq||[]).length} short=${(data.short||[]).length} essay=${(data.essay||[]).length}`);
  }
  return acc;
}

const warns = [];
function validateMcq(q, i) {
  const id = q.id || `mcq_${i}`;
  if (!q.question) warns.push(`${id} 缺 question`);
  const opts = q.options || {};
  const keys = ['a', 'b', 'c', 'd'].filter(k => opts[k] != null);
  const minOpts = q.subtype === 'tf' ? 2 : 3; // 是非題固定兩選項（a=正確、b=錯誤）
  if (keys.length < minOpts) warns.push(`${id} 選項不足（${keys.length}）`);
  if (!keys.includes(q.answer)) warns.push(`${id} answer「${q.answer}」不在選項內`);
  if (!q.explanation) warns.push(`${id} 缺 explanation`);
}
function validateFree(q, id) {
  if (!q.question) warns.push(`${id} 缺 question`);
  if (!q.reference_answer) warns.push(`${id} 缺 reference_answer`);
  if (!Array.isArray(q.rubric) || !q.rubric.length) warns.push(`${id} 缺 rubric`);
}

function dedup(arr) { // 同題幹去重
  const seen = new Set(); const out = [];
  for (const q of arr) { const k = (q.question || '').trim(); if (k && !seen.has(k)) { seen.add(k); out.push(q); } }
  return out;
}

// ---- 選項洗牌：修正正解過度集中在 a 的偏斜（原題庫 104/150 正解為 a，全猜 a 可及格）----
// 以題幹 hash 當種子 → 同一題每次組裝洗出同一順序（bank diff 穩定）。
// 同步重寫 answer 與詳解中的字母引用（選項a / (a) / 答案為a）。
function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleOptions(q) {
  if (q.subtype === 'tf') return q;                        // 是非題固定 a=正確 b=錯誤，不洗
  const keys = ['a', 'b', 'c', 'd', 'e'].filter(k => (q.options || {})[k] != null);
  if (keys.length < 3 || !keys.includes(q.answer)) return q;
  const rnd = mulberry32(hashSeed(q.question || ''));
  const order = keys.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const map = {}, options = {};                            // map: 舊字母 → 新字母
  order.forEach((oldK, idx) => { const newK = keys[idx]; options[newK] = q.options[oldK]; map[oldK] = newK; });
  // replace 單趟不回掃輸出，a→c / c→a 互換不會互踩。
  // 兩種引用形態：前綴式（選項a / (a) / 答案為a）與後綴式（、b 為… / c 是…）
  const re = /(選項\s*|\(|（|答案為\s*|正解為\s*|正解是\s*)([a-e])(?![a-z0-9])|(^|[、,，;；。:：\s])([a-e])(?=\s*[為是])/gim;
  const explanation = (q.explanation || '').replace(re, (m, pre1, l1, pre2, l2) =>
    pre1 != null ? pre1 + (map[l1.toLowerCase()] || l1)
                 : pre2 + (map[l2.toLowerCase()] || l2));
  return { ...q, options, answer: map[q.answer], explanation };
}

function main() {
  console.log('讀取題目片段：');
  const acc = loadFragments();
  const pad = n => String(n).padStart(3, '0');

  // 單選與是非同放 fragments 的 mcq 陣列，以 subtype:"tf" 區分，組裝時拆開
  const allChoice = dedup(acc.mcq);
  const mcq = allChoice.filter(q => q.subtype !== 'tf').map((q, i) => { const s = shuffleOptions(q); validateMcq(s, i + 1); return { ...s, id: `mcq_${pad(i + 1)}` }; });
  const tf = allChoice.filter(q => q.subtype === 'tf').map((q, i) => { validateMcq(q, i + 1); return { ...q, id: `tf_${pad(i + 1)}` }; });
  const short = dedup(acc.short).map((q, i) => { const id = `short_${pad(i + 1)}`; validateFree(q, id); return { ...q, id, points: q.points || 5 }; });
  const essay = dedup(acc.essay).map((q, i) => { const id = `essay_${pad(i + 1)}`; validateFree(q, id); return { ...q, id, points: q.points || 30 }; });

  // 確認題庫量足夠抽題
  for (const [k, n] of [['mcq', STRUCTURE.mcq.count], ['tf', STRUCTURE.tf.count]]) {
    const have = { mcq, tf }[k].length;
    if (have < n) warns.push(`題庫 ${k} 僅 ${have} 題，少於每卷需抽 ${n} 題`);
  }

  const bank = { meta: META, structure: STRUCTURE, mcq, tf, short, essay };
  fs.writeFileSync(OUT, JSON.stringify(bank, null, 1) + '\n', 'utf8');

  console.log(`\n題庫已輸出 → ${path.relative(ROOT, OUT)}`);
  console.log(`  單選 ${mcq.length}、是非 ${tf.length}、簡答 ${short.length}(停用)、申論 ${essay.length}(停用)`);
  const paperTotal = STRUCTURE.mcq.count * STRUCTURE.mcq.points_each + STRUCTURE.tf.count * STRUCTURE.tf.points_each;
  console.log(`  每卷抽：單選 ${STRUCTURE.mcq.count}×${STRUCTURE.mcq.points_each} + 是非 ${STRUCTURE.tf.count}×${STRUCTURE.tf.points_each} = ${paperTotal} 分（meta.total=${META.total}）`);
  if (paperTotal !== META.total) console.log(`  ⚠ 每卷總分 ${paperTotal} ≠ meta.total ${META.total}，請調整 STRUCTURE 或 META`);
  if (warns.length) { console.log(`\n⚠ 警告 ${warns.length} 則：`); warns.slice(0, 40).forEach(w => console.log('  - ' + w)); }
  else console.log('\n✓ 驗證通過，無警告。');
}

main();
