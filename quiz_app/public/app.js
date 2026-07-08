'use strict';
/* TTQS 線上測驗 前端 — 首頁 → 作答 → 成績 → 解析 */

const $ = id => document.getElementById(id);
const views = ['home', 'quiz', 'result', 'review'];
function show(v) { views.forEach(x => $('view-' + x).classList.toggle('hidden', x !== v)); window.scrollTo(0, 0); }

let EXAM = null;        // {exam_id, questions, duration_min, ...}
let ANSWERS = {};       // qid -> 'a'|'b'|'c'|'d'
let RESULT = null;      // submit 回應
let timerId = null, deadline = 0, startedAt = 0;

async function api(path, opts) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/* ---------- 首頁 ---------- */
async function initHome() {
  try {
    const s = await api('/api/status');
    $('specCount').innerHTML = `${s.paper.mcq + s.paper.tf} <small>題</small>`;
    $('specTime').innerHTML = `${s.paper.duration_min} <small>分鐘</small>`;
    $('specPass').innerHTML = `${s.paper.pass_score} <small>分</small>`;
    if (!s.ready) {
      $('poolNotice').textContent = `題庫準備中(選擇 ${s.pool.mcq} / 是非 ${s.pool.tf}),請稍後再試或通知管理員。`;
      $('poolNotice').classList.remove('hidden');
      $('btnStart').disabled = true;
    } else {
      $('poolNotice').classList.add('hidden');
      $('btnStart').disabled = false;
    }
  } catch (e) { /* 靜態預設值仍可顯示 */ }
}

$('btnStart').addEventListener('click', async () => {
  $('btnStart').disabled = true;
  $('btnStart').textContent = '出卷中…';
  try {
    EXAM = await api('/api/exam/start', { method: 'POST', body: JSON.stringify({ name: $('nickname').value.trim() }) });
    ANSWERS = {};
    startQuiz();
  } catch (e) {
    alert('無法開始測驗:' + e.message);
  } finally {
    $('btnStart').disabled = false;
    $('btnStart').innerHTML = '開始測驗 <span aria-hidden="true">›</span>';
  }
});

/* ---------- 作答頁 ---------- */
function startQuiz() {
  $('quizName').textContent = EXAM.name;
  $('totalN').textContent = EXAM.questions.length;
  renderQuestions();
  renderMap();
  updateProgress();
  startedAt = Date.now();
  deadline = startedAt + EXAM.duration_min * 60 * 1000;
  clearInterval(timerId);
  timerId = setInterval(tick, 500);
  tick();
  show('quiz');
}

function tick() {
  const left = Math.max(0, deadline - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
  const el = $('timerVal');
  el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  el.classList.toggle('low', left < 5 * 60 * 1000);
  if (left <= 0) { clearInterval(timerId); submit(true); }
}

function renderQuestions() {
  const col = $('qCol');
  col.innerHTML = '';
  EXAM.questions.forEach(q => {
    const card = document.createElement('div');
    card.className = 'card q-card';
    card.id = 'q-' + q.no;
    const head = `<div class="q-head"><span class="q-no">Q${String(q.no).padStart(2, '0')}</span><span class="q-type">${q.type === 'tf' ? '是非題' : '選擇題'}</span><span class="q-text"></span></div>`;
    card.innerHTML = head;
    card.querySelector('.q-text').textContent = q.question;
    if (q.type === 'tf') {
      const box = document.createElement('div');
      box.className = 'opts-tf';
      [['a', '◯', q.options.a || '正確'], ['b', '✕', q.options.b || '錯誤']].forEach(([key, sym, label]) => {
        const b = document.createElement('button');
        b.className = 'opt-tf';
        b.dataset.q = q.qid; b.dataset.k = key;
        b.innerHTML = `<span class="sym">${sym}</span><span></span>`;
        b.querySelector('span:last-child').textContent = label;
        b.addEventListener('click', () => pick(q, key));
        box.appendChild(b);
      });
      card.appendChild(box);
    } else {
      const box = document.createElement('div');
      box.className = 'opts';
      for (const key of ['a', 'b', 'c', 'd']) {
        if (q.options[key] == null) continue;
        const b = document.createElement('button');
        b.className = 'opt';
        b.dataset.q = q.qid; b.dataset.k = key;
        b.innerHTML = `<span class="radio"></span><span class="key">${key.toUpperCase()}</span><span></span>`;
        b.querySelector('span:last-child').textContent = q.options[key];
        b.addEventListener('click', () => pick(q, key));
        box.appendChild(b);
      }
      card.appendChild(box);
    }
    col.appendChild(card);
  });
}

function pick(q, key) {
  ANSWERS[q.qid] = key;
  document.querySelectorAll(`[data-q="${q.qid}"]`).forEach(el =>
    el.classList.toggle('sel', el.dataset.k === key));
  renderMap();
  updateProgress();
}

function renderMap() {
  const map = $('qMap');
  map.innerHTML = '';
  EXAM.questions.forEach(q => {
    const b = document.createElement('button');
    b.textContent = q.no;
    b.className = ANSWERS[q.qid] ? 'done' : '';
    b.title = `第 ${q.no} 題`;
    b.addEventListener('click', () => $('q-' + q.no).scrollIntoView({ behavior: 'smooth', block: 'center' }));
    map.appendChild(b);
  });
}

function updateProgress() {
  const done = Object.keys(ANSWERS).length, total = EXAM.questions.length;
  $('answeredN').textContent = done;
  $('progressBar').style.width = (done / total * 100) + '%';
  const left = total - done;
  const hint = left > 0 ? `尚有 ${left} 題未作答` : '已完成全部題目';
  $('submitHint').textContent = hint;
  $('submitHintM').textContent = left > 0 ? `尚有 ${left} 題\n未作答` : '已完成';
}

async function submit(auto) {
  const left = EXAM.questions.length - Object.keys(ANSWERS).length;
  if (!auto && left > 0 && !confirm(`尚有 ${left} 題未作答,確定要交卷嗎?`)) return;
  clearInterval(timerId);
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  try {
    RESULT = await api('/api/exam/submit', {
      method: 'POST',
      body: JSON.stringify({ exam_id: EXAM.exam_id, answers: ANSWERS, elapsed_sec: elapsed }),
    });
    renderResult();
    show('result');
  } catch (e) {
    alert('交卷失敗:' + e.message);
    if (!auto) timerId = setInterval(tick, 500);
  }
}
$('btnSubmit').addEventListener('click', () => submit(false));
$('btnSubmitM').addEventListener('click', () => submit(false));

/* ---------- 成績頁 ---------- */
function fmtTime(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
function renderResult() {
  const r = RESULT;
  const d = new Date();
  $('resultTime').textContent = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('resultWho').textContent = `測驗結果 · ${r.name}`;
  $('scoreN').textContent = r.score;
  $('passStd').textContent = r.pass_score;
  const pill = $('passPill');
  pill.className = 'pill ' + (r.pass ? 'pill-ok' : 'pill-bad');
  pill.textContent = r.pass ? '✓ 及格' : '✕ 未及格';
  $('okN').innerHTML = `${r.ok_n} <small>/ ${r.n}</small>`;
  $('mcqN').innerHTML = `${r.mcq_ok} <small>/ ${r.mcq_n}</small>`;
  $('tfN').innerHTML = `${r.tf_ok} <small>/ ${r.tf_n}</small>`;
  $('elapsedV').textContent = fmtTime(r.elapsed_sec);
  const map = $('rMap');
  map.innerHTML = '';
  r.items.forEach(it => {
    const cell = document.createElement('div');
    cell.className = it.correct ? 'ok' : 'bad';
    cell.innerHTML = `<span>${it.no}</span><span>${it.correct ? '✓' : '✕'}</span>`;
    map.appendChild(cell);
  });
}
$('btnReview').addEventListener('click', () => { renderReview('all'); show('review'); });
$('btnBackResult').addEventListener('click', () => show('result'));
function retry() { EXAM = null; RESULT = null; ANSWERS = {}; initHome(); show('home'); }
$('btnRetry').addEventListener('click', retry);
$('btnRetry2').addEventListener('click', retry);

/* ---------- 解析頁 ---------- */
let reviewFilter = 'all';
function renderReview(filter) {
  reviewFilter = filter;
  const r = RESULT;
  $('reviewScore').textContent = `${r.score} / ${r.total} · ${r.pass ? '及格' : '未及格'}`;
  const wrongN = r.items.filter(i => !i.correct).length;
  $('chipAll').textContent = `全部 ${r.items.length}`;
  $('chipWrong').textContent = `答錯 ${wrongN}`;
  $('chipAll').classList.toggle('active', filter === 'all');
  $('chipWrong').classList.toggle('active', filter === 'wrong');
  const list = $('reviewList');
  list.innerHTML = '';
  r.items.filter(it => filter === 'all' || !it.correct).forEach(it => {
    const card = document.createElement('div');
    card.className = 'card q-card';
    const pill = it.correct
      ? '<span class="pill pill-ok">✓ 答對</span>'
      : '<span class="pill pill-bad">✕ 答錯</span>';
    card.innerHTML = `<div class="q-head"><span class="q-no">Q${String(it.no).padStart(2, '0')}</span><span class="q-type">${it.type === 'tf' ? '是非題' : '選擇題'}</span><span class="q-text"></span>${pill}</div><div class="ans-list"></div>`;
    card.querySelector('.q-text').textContent = it.question;
    const box = card.querySelector('.ans-list');
    const label = k => it.type === 'tf' ? (k === 'a' ? '◯' : '✕') : k.toUpperCase();
    const optText = k => it.options[k] || '';
    if (it.correct) {
      box.appendChild(ansRow('right', label(it.correct_answer), optText(it.correct_answer), '你的答案 · 正確答案'));
    } else {
      if (it.your_answer) box.appendChild(ansRow('wrong', label(it.your_answer), optText(it.your_answer), '你的答案'));
      else box.appendChild(ansRow('wrong', '—', '未作答', '你的答案'));
      box.appendChild(ansRow('right', label(it.correct_answer), optText(it.correct_answer), '正確答案'));
    }
    const ex = document.createElement('div');
    ex.className = 'explain';
    ex.innerHTML = `<span class="k">解析</span><span class="t"></span>`;
    ex.querySelector('.t').textContent = it.explanation;
    if (it.source) {
      const src = document.createElement('span');
      src.className = 'src';
      src.textContent = `出處:${it.source}`;
      ex.querySelector('.t').appendChild(src);
    }
    card.appendChild(ex);
    list.appendChild(card);
  });
}
function ansRow(cls, key, text, tag) {
  const div = document.createElement('div');
  div.className = 'ans-row ' + cls;
  div.innerHTML = `<span class="key">${cls === 'right' ? '✓' : '✕'}</span><span class="key"></span><span class="txt"></span><span class="tag"></span>`;
  div.children[1].textContent = key;
  div.children[2].textContent = text;
  div.children[3].textContent = tag;
  return div;
}
$('chipAll').addEventListener('click', () => renderReview('all'));
$('chipWrong').addEventListener('click', () => renderReview('wrong'));
$('btnPrint').addEventListener('click', () => window.print());

/* 離開警告(作答中) */
window.addEventListener('beforeunload', e => {
  if (!$('view-quiz').classList.contains('hidden') && EXAM) { e.preventDefault(); e.returnValue = ''; }
});

initHome();
