'use strict';
/* TTQS 測驗管理後台 */
const $ = id => document.getElementById(id);
let DATA = null;

const tokenInput = $('adminToken');
tokenInput.value = localStorage.getItem('quiz_admin_token') || '';
tokenInput.addEventListener('change', () => {
  localStorage.setItem('quiz_admin_token', tokenInput.value);
  load();
});

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (tokenInput.value) h['Authorization'] = 'Bearer ' + tokenInput.value;
  return h;
}
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: headers(), ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

async function load() {
  try {
    DATA = await api('/api/admin/overview');
  } catch (e) {
    $('genStatus').textContent = '載入失敗:' + e.message;
    return;
  }
  $('stAttempts').textContent = DATA.attempts;
  $('stWeek').textContent = DATA.week_attempts ? `↗ 本週 +${DATA.week_attempts}` : '';
  $('stAvg').innerHTML = `${DATA.avg_score} <small>分</small>`;
  $('stPassRate').innerHTML = `${DATA.pass_rate} <small>%</small>`;
  $('stPassN').textContent = `${DATA.pass_n} / ${DATA.attempts} 人`;
  $('stPool').innerHTML = `${DATA.pool_n} <small>題</small>`;
  $('stPoolSplit').textContent = `選擇 ${DATA.pool_mcq} · 是非 ${DATA.pool_tf}`;
  if (!DATA.dify_enabled) $('genStatus').textContent = '⚠ 後端未設 DIFY_API_KEY,無法產題';
  renderRows();
}

function renderRows() {
  const kw = $('qSearch').value.trim();
  const rows = DATA.questions.filter(q => !kw || q.question.includes(kw) || (q.topic || '').includes(kw));
  const box = $('qRows');
  box.innerHTML = '';
  rows.slice(0, 100).forEach((q, i) => {
    const div = document.createElement('div');
    div.className = 'qb-row';
    const rate = q.ok_rate == null ? '—' : q.ok_rate + '%';
    const rateCls = q.ok_rate != null && q.ok_rate < 60 ? 'rate low' : 'rate';
    div.innerHTML = `<span class="qid"></span><span class="qtext" title=""></span><span>${q.type}</span><span class="qtopic" style="font-size:12px"></span><span class="${rateCls}">${rate}</span><button class="del" title="刪除此題">刪除</button>`;
    div.children[0].textContent = 'Q-' + String(rows.length - i).padStart(3, '0');
    div.children[1].textContent = q.question;
    div.children[1].title = q.question;
    div.children[3].textContent = q.topic || '—';
    div.querySelector('.del').addEventListener('click', async () => {
      if (!confirm('確定刪除這一題?\n\n' + q.question)) return;
      try { await api('/api/admin/question?id=' + encodeURIComponent(q.id), { method: 'DELETE' }); load(); }
      catch (e) { alert('刪除失敗:' + e.message); }
    });
    box.appendChild(div);
  });
  $('qCount').textContent = `${DATA.questions.length} 題中的 1–${Math.min(rows.length, 100)}${kw ? '(過濾中)' : ''}`;
}
$('qSearch').addEventListener('input', renderRows);

$('btnGen').addEventListener('click', async () => {
  const mcq = parseInt($('genMcq').value, 10) || 0;
  const tf = parseInt($('genTf').value, 10) || 0;
  if (!mcq && !tf) { alert('請指定要產生的題數'); return; }
  $('btnGen').disabled = true;
  $('genStatus').textContent = '呼叫 Dify 出題中(約 30–60 秒)…';
  try {
    const r = await api('/api/admin/generate', {
      method: 'POST',
      body: JSON.stringify({ mcq, tf, topic: $('genTopic').value.trim(), difficulty: $('genDiff').value }),
    });
    $('genStatus').textContent = `✓ 新增 ${r.added} 題${r.dropped ? `(略過重複/不合格 ${r.dropped} 題)` : ''},題庫共 ${r.pool_n} 題`;
    load();
  } catch (e) {
    $('genStatus').textContent = '✗ ' + e.message;
  } finally {
    $('btnGen').disabled = false;
  }
});

$('btnCsv').addEventListener('click', () => {
  const t = tokenInput.value ? '?token=' + encodeURIComponent(tokenInput.value) : '';
  window.open('/api/admin/results.csv' + t, '_blank');
});

load();
