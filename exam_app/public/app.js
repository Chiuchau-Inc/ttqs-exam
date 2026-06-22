/* TTQS 人才發展品質管理 線上題庫模擬考 App — 純前端。單選本地計分；簡答/申論接 Dify API（選用）。 */
'use strict';

const CFG = window.EXAM_CONFIG || { enableAiGrading: false };
const LS_KEY = 'ttqs_exam_state_v1';
let BANK = null;     // question_bank.json
let PAPER = null;    // 本次抽出的考卷
let STATE = null;    // { answers, startedAt, durationMin, submitted }
let timerHandle = null;

const $ = sel => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
// 每個瀏覽器一個隨機 user id，用於 Dify conversation 命名空間隔離
function clientUid() {
  let u = localStorage.getItem('ttqs_uid');
  if (!u) { u = 'stu-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem('ttqs_uid', u); }
  return u;
}

/* ---------- 載入題庫 ---------- */
async function loadBank() {
  const res = await fetch('question_bank.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('讀取 question_bank.json 失敗（' + res.status + '）');
  return res.json();
}

/* ---------- 抽卷 ---------- */
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

function sampleBalanced(pool, n) {
  // 盡量跨 topic 均勻抽 n 題
  const byTopic = {};
  for (const q of pool) (byTopic[q.topic_id || q.topic || '_'] ||= []).push(q);
  const buckets = shuffle(Object.values(byTopic).map(shuffle));
  const out = [];
  let i = 0;
  while (out.length < n && buckets.some(b => b.length)) {
    const b = buckets[i % buckets.length];
    if (b.length) out.push(b.pop());
    i++;
  }
  return shuffle(out).slice(0, n);
}

function buildPaper(bank) {
  const s = bank.structure;
  const paper = { mcq: [], short: [], essay: [] };
  paper.mcq = sampleBalanced(bank.mcq || [], s.mcq.count);
  paper.short = shuffle(bank.short || []).slice(0, s.short.count);
  paper.essay = shuffle(bank.essay || []).slice(0, s.essay.count);
  return paper;
}

function paperFlat() { // 統一順序的題目清單
  const out = [];
  PAPER.mcq.forEach((q, i) => out.push({ ...q, _type: 'mcq', _idx: i, _key: 'mcq_' + i }));
  PAPER.short.forEach((q, i) => out.push({ ...q, _type: 'short', _idx: i, _key: 'short_' + i }));
  PAPER.essay.forEach((q, i) => out.push({ ...q, _type: 'essay', _idx: i, _key: 'essay_' + i }));
  return out;
}

/* ---------- 狀態存取（localStorage，可中途重整不丟） ---------- */
function persist() { localStorage.setItem(LS_KEY, JSON.stringify({ PAPER, STATE })); }
function restore() {
  try {
    const raw = localStorage.getItem(LS_KEY); if (!raw) return false;
    const d = JSON.parse(raw); if (!d.PAPER || !d.STATE) return false;
    PAPER = d.PAPER; STATE = d.STATE; return true;
  } catch { return false; }
}
function clearSaved() { localStorage.removeItem(LS_KEY); }

/* ---------- 畫面 ---------- */
function show(view) { ['start', 'exam', 'result'].forEach(v => $('#view-' + v).classList.toggle('hidden', v !== view)); window.scrollTo(0, 0); }

function renderStart() {
  const m = BANK.meta, s = BANK.structure;
  const avail = `題庫現有：單選 ${BANK.mcq.length}、簡答 ${BANK.short.length}、申論 ${BANK.essay.length}`;
  $('#view-start').innerHTML = `
    <div class="card center">
      <h1>${esc(m.title)}</h1>
      <p class="muted">${esc(m.subtitle || '')}</p>
      <div class="breakdown" style="margin:20px 0">
        <div class="bd-item"><div class="v">${m.duration_min}</div>分鐘</div>
        <div class="bd-item"><div class="v">${m.total}</div>滿分</div>
        <div class="bd-item"><div class="v">${m.pass_score}</div>及格</div>
      </div>
      <div class="card" style="text-align:left">
        <b>本次題目結構（每次隨機抽題）</b>
        <ul>
          <li>第一題 單選題：${s.mcq.count} 題 × ${s.mcq.points_each} 分 = ${s.mcq.count * s.mcq.points_each} 分</li>
          <li>第二題 簡答題：${s.short.count} 題 × ${s.short.points_each} 分 = ${s.short.count * s.short.points_each} 分</li>
          <li>第三題 申論題：${s.essay.count} 題（共 ${s.essay.points} 分）</li>
        </ul>
        <p class="muted" style="font-size:13px">${avail}</p>
      </div>
      ${CFG.aiEnabled ? '' : '<div class="warnbox">後端未設定 Dify（AI 評分未啟用）：簡答/申論題交卷後會顯示<b>參考答案供自評</b>，單選題仍自動計分。</div>'}
      <div class="card" style="text-align:left">
        <label for="stu-name"><b>請輸入姓名</b>（僅供老師批改紀錄，不會公開、無排名）</label>
        <input id="stu-name" maxlength="40" placeholder="你的姓名" autocomplete="off"
          style="width:100%;margin-top:8px;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:9px;padding:10px;font:inherit">
      </div>
      <p style="margin-top:16px"><button class="btn" id="btn-start">開始作答（${m.duration_min} 分鐘）</button></p>
      <p id="resume-row" class="hidden"><button class="btn ghost sm" id="btn-resume">繼續上次未完成的作答</button></p>
    </div>`;
  const nameInput = $('#stu-name');
  if (nameInput) nameInput.value = localStorage.getItem('ttqs_name') || '';
  $('#btn-start').onclick = startExam;
  if (localStorage.getItem(LS_KEY)) {
    $('#resume-row').classList.remove('hidden');
    $('#btn-resume').onclick = () => { if (restore() && !STATE.submitted) { enterExam(); } };
  }
}

function startExam() {
  const name = ($('#stu-name') ? $('#stu-name').value : '').trim();
  if (!name) { alert('請先輸入姓名'); if ($('#stu-name')) $('#stu-name').focus(); return; }
  localStorage.setItem('ttqs_name', name);
  PAPER = buildPaper(BANK);
  STATE = { answers: {}, startedAt: Date.now(), durationMin: BANK.meta.duration_min, submitted: false, name };
  persist();
  enterExam();
}

function enterExam() {
  show('exam');
  renderExam();
  startTimer();
}

function remainingMs() {
  const end = STATE.startedAt + STATE.durationMin * 60000;
  return end - Date.now();
}
function startTimer() {
  clearInterval(timerHandle);
  const tick = () => {
    const ms = remainingMs();
    const t = $('#timer');
    if (ms <= 0) { t.textContent = '00:00'; clearInterval(timerHandle); doSubmit(true); return; }
    const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    if (t) { t.textContent = mm + ':' + ss; t.classList.toggle('danger', ms < 5 * 60000); }
  };
  tick(); timerHandle = setInterval(tick, 1000);
}

function renderExam() {
  const flat = paperFlat();
  const root = $('#exam-body'); root.innerHTML = '';
  const sections = [
    ['mcq', `第一題　單選題（每題 ${BANK.structure.mcq.points_each} 分，單選）`],
    ['short', `第二題　簡答題（每題 ${BANK.structure.short.points_each} 分）`],
    ['essay', `第三題　申論題`],
  ];
  let globalNo = 0;
  for (const [type, title] of sections) {
    const qs = flat.filter(q => q._type === type);
    if (!qs.length) continue;
    root.appendChild(el('h2', null, esc(title)));
    for (const q of qs) {
      globalNo++;
      root.appendChild(renderQuestionInput(q, globalNo));
    }
  }
  const bar = el('div', 'row', '');
  const submit = el('button', 'btn', '交卷');
  submit.onclick = () => { if (confirm('確定交卷？交卷後無法修改。')) doSubmit(false); };
  bar.appendChild(submit);
  root.appendChild(bar);
}

function renderQuestionInput(q, no) {
  const card = el('div', 'q');
  const pts = q.points || (q._type === 'mcq' ? BANK.structure.mcq.points_each : '');
  card.appendChild(el('div', 'q-head', `<span class="q-no">第 ${no} 題</span><span class="q-tag">${esc(q.topic || q._type)}</span><span class="q-tag">${pts} 分</span>`));
  card.appendChild(el('div', 'q-stem', esc(q.question)));
  if (q._type === 'mcq') {
    const opts = el('div', 'opts');
    for (const k of ['a', 'b', 'c', 'd', 'e']) {
      if (q.options[k] == null) continue;
      const lab = el('label', 'opt');
      lab.innerHTML = `<input type="radio" name="${q._key}" value="${k}"><span class="k">${k}.</span><span>${esc(q.options[k])}</span>`;
      const input = lab.querySelector('input');
      if (STATE.answers[q._key] === k) { input.checked = true; lab.classList.add('sel'); }
      input.onchange = () => {
        STATE.answers[q._key] = k; persist();
        card.querySelectorAll('.opt').forEach(o => o.classList.remove('sel'));
        lab.classList.add('sel');
      };
      opts.appendChild(lab);
    }
    card.appendChild(opts);
  } else {
    const ta = el('textarea');
    ta.value = STATE.answers[q._key] || '';
    ta.placeholder = '請作答';
    ta.oninput = () => { STATE.answers[q._key] = ta.value; persist(); };
    card.appendChild(ta);
  }
  return card;
}

/* ---------- 交卷與計分 ---------- */
async function doSubmit(auto) {
  clearInterval(timerHandle);
  STATE.submitted = true; STATE.submittedAt = Date.now(); persist();
  show('result');
  $('#view-result').innerHTML = `<div class="card center"><span class="spin"></span> ${auto ? '時間到，' : ''}計分中…</div>`;

  const flat = paperFlat();
  const graded = [];
  // 單選：本地計分
  for (const q of flat.filter(q => q._type === 'mcq')) {
    const ua = STATE.answers[q._key] || null;
    const correct = ua && ua === q.answer;
    graded.push({ q, ua, got: correct ? BANK.structure.mcq.points_each : 0, max: BANK.structure.mcq.points_each, status: correct ? 'correct' : 'wrong' });
  }
  // 自由題：Dify 評分或自評
  const freeQs = flat.filter(q => q._type !== 'mcq');
  const useAi = CFG.enableAiGrading && CFG.aiEnabled;
  for (const q of freeQs) {
    const ua = STATE.answers[q._key] || '';
    const max = q.points || 5;
    if (useAi && ua.trim()) {
      try {
        // 依 rubric 配分加總評分（AI 自然以 rubric 為尺度），再等比放大到題目滿分，
        // 避免「rubric 加總<滿分」時完整作答只拿一半分。
        const rmax = rubricMax(q);
        const r = await aiGrade(q, ua, rmax);
        const scaled = rmax ? Math.round((r.score / rmax) * max * 10) / 10 : r.score;
        graded.push({ q, ua, got: scaled, max, status: scaled >= max * 0.8 ? 'correct' : scaled > 0 ? 'partial' : 'wrong', feedback: r.feedback });
      } catch (e) {
        graded.push({ q, ua, got: null, max, status: 'manual', feedback: 'AI 評分失敗：' + e.message });
      }
    } else {
      graded.push({ q, ua, got: null, max, status: 'manual' });
    }
  }
  renderResult(graded);
}

// rubric 各項配分加總（解析「N分」，同一項取最大值），作為 AI 評分尺度
function rubricMax(q) {
  const rub = Array.isArray(q.rubric) ? q.rubric : [q.rubric];
  let sum = 0;
  for (const r of rub) {
    const nums = String(r).match(/\d+(?:\.\d+)?(?=\s*分)/g);
    if (nums && nums.length) sum += Math.max(...nums.map(Number));
  }
  return sum || (q.points || 5);
}

function renderResult(graded) {
  const autoPts = graded.filter(g => g.got != null).reduce((s, g) => s + g.got, 0);
  const hasManual = graded.some(g => g.got == null);
  const total = BANK.meta.total, pass = BANK.meta.pass_score;
  const passNow = autoPts >= pass;
  const root = $('#view-result'); root.innerHTML = '';

  const hero = el('div', 'card score-hero');
  hero.innerHTML = `
    <div class="muted">${hasManual ? '自動計分（不含待自評題）' : '總分'}</div>
    <div class="score-num ${passNow ? 'pass' : 'fail'}">${autoPts}<span style="font-size:24px">/${total}</span></div>
    <div class="badge ${passNow ? 'pass' : 'fail'}">${passNow ? ('✅ 已達及格（' + pass + ' 分）') : ('及格線 ' + pass + ' 分')}</div>
    ${hasManual ? '<p class="muted" style="font-size:13px;margin-top:10px">部分簡答/申論題未由 AI 評分，請對照參考答案自評後加總</p>' : ''}`;
  root.appendChild(hero);

  // 分項
  const bd = el('div', 'breakdown');
  for (const [type, name] of [['mcq', '單選'], ['short', '簡答'], ['essay', '申論']]) {
    const gs = graded.filter(g => g.q._type === type); if (!gs.length) continue;
    const got = gs.every(g => g.got != null) ? gs.reduce((s, g) => s + g.got, 0) : '—';
    const mx = gs.reduce((s, g) => s + g.max, 0);
    bd.appendChild(el('div', 'bd-item', `<div class="v">${got}/${mx}</div>${name}`));
  }
  const bdCard = el('div', 'card'); bdCard.appendChild(bd); root.appendChild(bdCard);

  // 送成績與作答到後端（供老師批改紀錄，不公開、無排名）
  const lbStatus = el('div', 'card center', '<span class="spin"></span> 送出成績紀錄中…');
  root.appendChild(lbStatus);
  submitResult(graded, autoPts, hasManual).then(ok => {
    lbStatus.innerHTML = ok
      ? '✅ 成績已送出（僅供老師批改紀錄）'
      : '<span class="mark bad">成績送出失敗（可截圖此頁給老師）</span>';
  });

  // 逐題檢討
  root.appendChild(el('h2', null, '逐題檢討'));
  let no = 0;
  for (const g of graded) { no++; root.appendChild(renderReviewQ(g, no)); }

  const bar = el('div', 'row', '');
  const again = el('button', 'btn', '再考一次（重新抽題）');
  again.onclick = () => { clearSaved(); renderStart(); show('start'); };
  bar.appendChild(again);
  root.appendChild(bar);
}

async function submitResult(graded, autoPts, hasManual) {
  const sect = t => {
    const gs = graded.filter(g => g.q._type === t);
    return gs.length && gs.every(g => g.got != null) ? gs.reduce((s, g) => s + g.got, 0) : 0;
  };
  // 作答摘要供老師稽核（題幹截斷、作答截斷由後端再保險）
  const answers = {};
  let i = 0;
  for (const g of graded) {
    answers['q' + (++i) + '_' + g.q._type] = `[${g.got == null ? '待評' : g.got + '/' + g.max}] ${String(g.ua || '').slice(0, 300)}`;
  }
  const payload = {
    name: (STATE && STATE.name) || localStorage.getItem('ttqs_name') || '匿名',
    uid: clientUid(),
    total: autoPts,
    breakdown: { mcq: sect('mcq'), short: sect('short'), essay: sect('essay') },
    duration_sec: STATE && STATE.startedAt ? Math.round(((STATE.submittedAt || Date.now()) - STATE.startedAt) / 1000) : 0,
    ai_graded: !hasManual,
    answers,
  };
  try {
    const r = await fetch('/api/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Exam-Token': CFG.token || '' },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch { return false; }
}

function renderReviewQ(g, no) {
  const q = g.q;
  const card = el('div', 'q result-q ' + (g.status === 'manual' ? '' : g.status));
  const markTxt = g.got == null ? '<span class="mark">待自評</span>'
    : `<span class="mark ${g.status === 'correct' ? 'ok' : g.status === 'partial' ? 'partial' : 'bad'}">${g.got}/${g.max} 分</span>`;
  card.appendChild(el('div', 'q-head', `<span class="q-no">第 ${no} 題</span><span class="q-tag">${esc(q.topic || q._type)}</span>${markTxt}`));
  card.appendChild(el('div', 'q-stem', esc(q.question)));

  if (q._type === 'mcq') {
    const opts = el('div', 'opts');
    for (const k of ['a', 'b', 'c', 'd', 'e']) {
      if (q.options[k] == null) continue;
      const o = el('div', 'opt');
      if (k === q.answer) o.classList.add('ans');
      if (g.ua === k && k !== q.answer) o.classList.add('youwrong');
      o.innerHTML = `<span class="k">${k}.</span><span>${esc(q.options[k])}</span>${k === q.answer ? ' ✅' : (g.ua === k ? ' ❌你的答案' : '')}`;
      opts.appendChild(o);
    }
    card.appendChild(opts);
    const ex = el('div', 'explain');
    ex.innerHTML = `<b>詳解：</b>${esc(q.explanation || '')}<div class="src">出處：${esc(q.source || '')}</div>`;
    card.appendChild(ex);
  } else {
    card.appendChild(el('div', 'explain', `<b>你的作答：</b><div style="white-space:pre-wrap">${esc(g.ua || '（未作答）')}</div>`));
    if (g.feedback) card.appendChild(el('div', 'explain', `<b>AI 評分回饋：</b><div style="white-space:pre-wrap">${esc(g.feedback)}</div>`));
    const ref = el('div', 'reference');
    ref.innerHTML = `<b>參考答案：</b><div style="white-space:pre-wrap">${esc(q.reference_answer || '')}</div>`
      + (q.rubric ? `<div class="src" style="margin-top:8px"><b>評分要點：</b>${Array.isArray(q.rubric) ? q.rubric.map(esc).join('；') : esc(q.rubric)}</div>` : '')
      + `<div class="src">出處：${esc(q.source || '')}</div>`;
    card.appendChild(ref);
  }

  // 討論區
  card.appendChild(buildDiscuss(q, g));
  return card;
}

/* ---------- 討論（Dify chat） ---------- */
function buildDiscuss(q, g) {
  const box = el('div', 'discuss');
  const canChat = CFG.aiEnabled;
  const toggle = el('button', 'btn ghost sm', '💬 討論這題' + (canChat ? '' : '（需設定 Dify）'));
  const panel = el('div', 'hidden');
  const log = el('div', 'chat-log');
  const inputRow = el('div', 'chat-input');
  inputRow.innerHTML = `<input placeholder="問：為什麼我這題沒得分？這個觀念…"><button class="btn sm">送出</button>`;
  const input = inputRow.querySelector('input'), send = inputRow.querySelector('button');
  let convId = null;

  const ask = async (text) => {
    log.appendChild(el('div', 'msg user', esc(text)));
    const aim = el('div', 'msg ai', '<span class="spin"></span>'); log.appendChild(aim);
    log.scrollIntoView({ block: 'end' });
    try {
      const ctx = discussContext(q, g);
      const r = await difyChat(text, ctx, convId);
      convId = r.conversation_id || convId;
      aim.innerHTML = esc(r.answer || '（無回應）');
    } catch (e) { aim.innerHTML = '<span class="mark bad">討論失敗：' + esc(e.message) + '</span>'; }
  };
  send.onclick = () => { const v = input.value.trim(); if (v) { input.value = ''; ask(v); } };
  input.onkeydown = e => { if (e.key === 'Enter') send.onclick(); };

  toggle.onclick = () => {
    panel.classList.toggle('hidden');
    if (!canChat) { panel.innerHTML = '<div class="warnbox">未設定 Dify API。填好 config.js 後可在此追問為何沒得分、延伸觀念。</div>'; return; }
    if (!panel.dataset.init) { panel.dataset.init = '1'; panel.appendChild(log); panel.appendChild(inputRow); ask('請依教材說明這題的正確觀念，以及我的作答為何' + (g.status === 'correct' ? '正確、還能補充什麼' : '不完整或錯誤')); }
  };
  box.appendChild(toggle); box.appendChild(panel);
  return box;
}

function discussContext(q, g) {
  const lines = [`【題目】${q.question}`];
  if (q._type === 'mcq') {
    lines.push('【選項】' + ['a', 'b', 'c', 'd', 'e'].filter(k => q.options[k] != null).map(k => `${k}.${q.options[k]}`).join('  '));
    lines.push(`【正解】${q.answer}　【我的答案】${g.ua || '未作答'}`);
    lines.push(`【詳解】${q.explanation || ''}`);
  } else {
    lines.push(`【我的作答】${g.ua || '未作答'}`);
    lines.push(`【參考答案】${q.reference_answer || ''}`);
    if (q.rubric) lines.push('【評分要點】' + (Array.isArray(q.rubric) ? q.rubric.join('；') : q.rubric));
  }
  lines.push(`【出處】${q.source || ''}`);
  return lines.join('\n');
}

/* ---------- Dify（一律經同源後端代理 /api/dify，前端不持有金鑰） ---------- */
async function postDify(query, context, conversationId) {
  const body = {
    inputs: {}, query: `${context}\n\n【學員提問】${query}`,
    user: clientUid(),
    conversation_id: conversationId || undefined,
  };
  return fetch('/api/dify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Exam-Token': CFG.token || '' },
    body: JSON.stringify(body),
  });
}
async function difyChat(query, context, conversationId) {
  let res = await postDify(query, context, conversationId);
  if (res.status === 401) {            // token 過期 → 重新取得後重試一次
    await detectAi();
    res = await postDify(query, context, conversationId);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
  return res.json();
}

async function aiGrade(q, userAnswer, max) {
  const prompt =
    `你是 TTQS（人才發展品質管理系統）閱卷老師。依「評分要點」為學員作答評分，滿分 ${max} 分。\n` +
    `【題目】${q.question}\n【參考答案】${q.reference_answer}\n【評分要點】${Array.isArray(q.rubric) ? q.rubric.join('；') : q.rubric}\n【學員作答】${userAnswer}\n\n` +
    `請只回一行 JSON：{"score": 數字(0~${max}), "feedback":"中文評語，指出得分點與缺漏"}`;
  const r = await difyChat(prompt, '（評分任務）', null);
  const m = (r.answer || '').match(/\{[\s\S]*\}/);
  if (!m) return { score: 0, feedback: r.answer || '無法解析評分' };
  const j = JSON.parse(m[0]);
  return { score: Math.max(0, Math.min(max, Number(j.score) || 0)), feedback: j.feedback || '' };
}

/* ---------- 啟動 ---------- */
async function detectAi() {
  // 後端有設 DIFY_API_KEY 才回 {ai:true, token}；純靜態/未設定時 fetch 失敗 → 自評模式
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json();
    CFG.token = j.token || '';
    return !!j.ai;
  } catch { return false; }
}

(async function init() {
  try {
    CFG.aiEnabled = await detectAi();
    BANK = await loadBank();
    renderStart(); show('start');
  } catch (e) {
    $('#view-start').innerHTML = `<div class="card"><h1>載入失敗</h1><p class="warnbox">${esc(e.message)}</p><p class="muted">請確認 question_bank.json 與本頁在同一資料夾，且透過 http(s) 開啟（不是 file://）。本機可執行：<code>python3 -m http.server</code></p></div>`;
    show('start');
  }
})();
