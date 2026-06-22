/* 老師成績檢視頁（成績不公開；需 ADMIN_TOKEN）（每 15 秒更新）。
   老師模式：輸入 ADMIN_TOKEN 後可查看各學員作答（作答僅老師可見，學生看不到）。 */
'use strict';
const esc = s => String(s == null ? '' : s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const myName = localStorage.getItem('iso14067_name') || '';
let adminToken = sessionStorage.getItem('iso14067_admin') || '';
let adminByName = null;   // name -> [records]（含作答），老師模式才有

function fmtDur(sec) { sec = Math.max(0, Math.round(sec || 0)); const m = Math.floor(sec / 60); return m + '分' + String(sec % 60).padStart(2, '0') + '秒'; }
function fmtTime(ts) { try { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } catch { return ''; } }
const medal = r => r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : r;

async function loadAdmin() {
  if (!adminToken) { adminByName = null; return; }
  try {
    const r = await fetch('/api/admin/results', { headers: { 'X-Admin-Token': adminToken }, cache: 'no-store' });
    if (!r.ok) { adminToken = ''; sessionStorage.removeItem('iso14067_admin'); adminByName = null; alert('管理 token 錯誤'); return; }
    const j = await r.json();
    adminByName = {};
    for (const rec of (j.results || [])) (adminByName[rec.name] ||= []).push(rec);
  } catch { adminByName = null; }
}

function answersHtml(name, total) {
  const recs = (adminByName && adminByName[name]) || [];
  if (!recs.length) return '<span class="muted">（無作答記錄）</span>';
  // 取與排行榜顯示分數相符的最佳那筆（多筆同分取最新）
  const match = recs.filter(r => r.total === total).sort((a, b) => b.ts - a.ts)[0] || recs.sort((a, b) => b.ts - a.ts)[0];
  const ans = match.answers || {};
  const keys = Object.keys(ans);
  let rows = keys.length ? '' : '<span class="muted">（此筆無保存作答）</span>';
  for (const k of keys) rows += `<div style="padding:6px 0;border-bottom:1px solid var(--border)"><b class="muted" style="font-size:12px">${esc(k)}</b><div style="white-space:pre-wrap">${esc(ans[k])}</div></div>`;
  const others = recs.length > 1 ? `<div class="muted" style="font-size:12px;margin-top:6px">此學員共 ${recs.length} 次作答，顯示最佳一筆（${fmtTime(match.ts)}）</div>` : '';
  return rows + others;
}

async function load() {
  const meta = document.getElementById('lb-meta');
  const body = document.getElementById('lb-body');
  try {
    if (adminToken && !adminByName) await loadAdmin();
    // 成績與排名不公開：非老師模式不顯示任何人成績
    if (!adminToken) {
      meta.textContent = '此頁為老師檢視用，成績不公開。';
      body.innerHTML = '<div class="card center muted">學員成績僅老師可見。<br>請點右上「🔑 老師模式」並輸入管理 token。</div>';
      return;
    }
    const r = await fetch('/api/leaderboard', { headers: { 'X-Admin-Token': adminToken }, cache: 'no-store' });
    if (r.status === 401) { adminToken = ''; sessionStorage.removeItem('iso14067_admin'); meta.textContent = ''; body.innerHTML = '<div class="card"><span class="mark bad">管理 token 錯誤或過期</span></div>'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const board = j.board || [];
    const adminOn = !!(adminToken && adminByName);
    meta.innerHTML = `（老師檢視）共 ${j.count || board.length} 位學員　·　依總分排序　·　每 15 秒更新`
      + (adminOn ? '　·　<b>可看作答</b>' : '');
    if (!board.length) { body.innerHTML = '<div class="card center muted">還沒有人完成考試。</div>'; return; }
    let rows = '';
    for (const x of board) {
      const mine = myName && x.name === myName;
      const bd = x.breakdown || {};
      rows += `<tr data-name="${esc(x.name)}" data-total="${x.total}" style="${mine ? 'background:rgba(59,130,246,.10)' : ''}">
        <td style="font-size:18px;font-weight:700;width:54px;text-align:center">${medal(x.rank)}</td>
        <td><b>${esc(x.name)}</b>${mine ? ' <span class="q-tag">你</span>' : ''}${x.ai_graded ? '' : ' <span class="q-tag">未AI評</span>'}${adminOn ? ' <button class="btn ghost sm view-ans" style="padding:2px 8px;margin-left:6px">作答</button>' : ''}</td>
        <td style="font-size:20px;font-weight:800;text-align:right">${x.total}<span class="muted" style="font-size:13px">/100</span></td>
        <td class="muted" style="font-size:13px;text-align:right;white-space:nowrap">單${bd.mcq ?? 0}·簡${bd.short ?? 0}·申${bd.essay ?? 0}·算${bd.calc ?? 0}</td>
        <td class="muted" style="font-size:13px;text-align:right;white-space:nowrap">${fmtDur(x.duration_sec)}</td>
        <td class="muted" style="font-size:13px;text-align:right;white-space:nowrap">${x.attempts}次</td>
      </tr>`;
    }
    body.innerHTML = `<div class="card" style="padding:8px 12px"><table style="width:100%;border-collapse:collapse">
      <thead><tr class="muted" style="font-size:13px;text-align:left;border-bottom:1px solid var(--border)">
        <th style="padding:8px;text-align:center">名次</th><th style="padding:8px">姓名</th>
        <th style="padding:8px;text-align:right">總分</th><th style="padding:8px;text-align:right">分項</th>
        <th style="padding:8px;text-align:right">用時</th><th style="padding:8px;text-align:right">次數</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
    body.querySelectorAll('tbody tr').forEach(tr => tr.style.borderBottom = '1px solid var(--border)');
    // 老師模式：作答展開
    if (adminOn) body.querySelectorAll('.view-ans').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const tr = btn.closest('tr');
        if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('ans-row')) { tr.nextElementSibling.remove(); return; }
        const det = document.createElement('tr');
        det.className = 'ans-row';
        det.innerHTML = `<td colspan="6" style="padding:10px 14px;background:var(--panel2)"><b>${esc(tr.dataset.name)} 的作答</b>${answersHtml(tr.dataset.name, Number(tr.dataset.total))}</td>`;
        tr.after(det);
      };
    });
  } catch (e) {
    meta.textContent = '';
    body.innerHTML = `<div class="card"><span class="mark bad">載入失敗：${esc(e.message)}</span></div>`;
  }
}

function setupAdminBtn() {
  const btn = document.getElementById('admin-btn');
  if (!btn) return;
  const refresh = () => { btn.textContent = adminToken ? '🔓 老師模式（點擊登出）' : '🔑 老師模式'; };
  refresh();
  btn.onclick = async () => {
    if (adminToken) { adminToken = ''; adminByName = null; sessionStorage.removeItem('iso14067_admin'); refresh(); load(); return; }
    const t = prompt('輸入老師管理 token（ADMIN_TOKEN）');
    if (!t) return;
    adminToken = t.trim(); sessionStorage.setItem('iso14067_admin', adminToken); adminByName = null;
    await loadAdmin(); refresh(); load();
  };
}

setupAdminBtn();
load();
setInterval(load, 15000);
