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
  duration_min: 90,
  total: 100,
  pass_score: 60,
};
const STRUCTURE = {
  mcq:   { count: 25, points_each: 2,  section: '第一題 單選題' },  // 25×2 = 50
  short: { count: 4,  points_each: 5,  section: '第二題 簡答題' },  // 4×5  = 20
  essay: { count: 1,  points: 30,      section: '第三題 申論題' },  // 1×30 = 30
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
  if (keys.length < 3) warns.push(`${id} 選項不足（${keys.length}）`);
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

function main() {
  console.log('讀取題目片段：');
  const acc = loadFragments();
  const pad = n => String(n).padStart(3, '0');

  const mcq = dedup(acc.mcq).map((q, i) => { validateMcq(q, i + 1); return { ...q, id: `mcq_${pad(i + 1)}` }; });
  const short = dedup(acc.short).map((q, i) => { const id = `short_${pad(i + 1)}`; validateFree(q, id); return { ...q, id, points: q.points || STRUCTURE.short.points_each }; });
  const essay = dedup(acc.essay).map((q, i) => { const id = `essay_${pad(i + 1)}`; validateFree(q, id); return { ...q, id, points: q.points || STRUCTURE.essay.points }; });

  // 確認題庫量足夠抽題
  for (const [k, n] of [['mcq', STRUCTURE.mcq.count], ['short', STRUCTURE.short.count], ['essay', STRUCTURE.essay.count]]) {
    const have = { mcq, short, essay }[k].length;
    if (have < n) warns.push(`題庫 ${k} 僅 ${have} 題，少於每卷需抽 ${n} 題`);
  }

  const bank = { meta: META, structure: STRUCTURE, mcq, short, essay };
  fs.writeFileSync(OUT, JSON.stringify(bank, null, 1) + '\n', 'utf8');

  console.log(`\n題庫已輸出 → ${path.relative(ROOT, OUT)}`);
  console.log(`  單選 ${mcq.length}、簡答 ${short.length}、申論 ${essay.length}（共 ${mcq.length + short.length + essay.length} 題）`);
  const paperTotal = STRUCTURE.mcq.count * STRUCTURE.mcq.points_each + STRUCTURE.short.count * STRUCTURE.short.points_each + STRUCTURE.essay.count * STRUCTURE.essay.points;
  console.log(`  每卷抽：單選 ${STRUCTURE.mcq.count}×${STRUCTURE.mcq.points_each} + 簡答 ${STRUCTURE.short.count}×${STRUCTURE.short.points_each} + 申論 ${STRUCTURE.essay.count}×${STRUCTURE.essay.points} = ${paperTotal} 分（meta.total=${META.total}）`);
  if (paperTotal !== META.total) console.log(`  ⚠ 每卷總分 ${paperTotal} ≠ meta.total ${META.total}，請調整 STRUCTURE 或 META`);
  if (warns.length) { console.log(`\n⚠ 警告 ${warns.length} 則：`); warns.slice(0, 40).forEach(w => console.log('  - ' + w)); }
  else console.log('\n✓ 驗證通過，無警告。');
}

main();
