'use strict';
/*
 * TTQS 線上測驗(quiz_app)— 零依賴後端。
 * 依 ttqs-exam-prototype 設計稿實作:匿名測驗 20 題(選擇 12 + 是非 8)、30 分鐘、70 分及格。
 *
 * 架構:題目由管理後台呼叫 Dify 出題 App 產生 → 存入題庫池(data/question_pool.json);
 * 考生開考時從池中抽題,正解與解析留在伺服器端,交卷才評分回傳(統計才有意義)。
 *
 * 環境變數:
 *  - DIFY_API_KEY(出題功能必填;未設則管理後台「從 Dify 產生題目」回 503)
 *  - DIFY_BASE_URL(預設 https://api.dify.ai/v1)
 *  - PORT(預設 8090)
 *  - DATA_DIR(預設 ./data;部署掛持久磁碟)
 *  - ADMIN_TOKEN(設了才開放 /api/admin/*;正式部署務必設)
 *  - RATE_PER_MIN / RATE_GLOBAL_PER_MIN(速率限制,預設 60 / 600)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8090', 10);
const DIFY_API_KEY = process.env.DIFY_API_KEY || '';
const DIFY_BASE_URL = (process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const RATE_PER_MIN = parseInt(process.env.RATE_PER_MIN || '60', 10);
const RATE_GLOBAL_PER_MIN = parseInt(process.env.RATE_GLOBAL_PER_MIN || '600', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const POOL_FILE = path.join(DATA_DIR, 'question_pool.json');
const RESULTS_FILE = path.join(DATA_DIR, 'results.jsonl');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 考卷規格(對齊設計稿:20 題、選擇 12 + 是非 8、每題 5 分、70 及格、30 分鐘)
const PAPER = { mcq: 12, tf: 8, points_each: 5, pass_score: 70, duration_min: 30 };
const EXAM_TTL_MS = (PAPER.duration_min + 10) * 60 * 1000; // 逾時寬限 10 分鐘
const MAX_BODY = 64 * 1024;
const MAX_NAME = 40;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('無法建立 DATA_DIR:', e.message); }

/* ---------- 題庫池 ---------- */
const SEED_FILE = path.join(__dirname, 'seed_question_pool.json');
let pool = [];
function loadPool() {
  try { pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); }
  catch (e) { pool = []; }
  if (!pool.length) {
    // 首次啟動(或空池):以入版控的 seed 題庫初始化,部署後即可直接開考
    try {
      pool = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      if (pool.length) { savePool(); console.log(`題庫池以 seed 初始化:${pool.length} 題`); }
    } catch (e) { pool = []; }
  }
}
function savePool() {
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 1), 'utf8');
}
loadPool();

const normalize = s => String(s || '').replace(/\s+/g, '').slice(0, 200);

function validQuestion(q) {
  if (!q || typeof q.question !== 'string' || !q.question.trim()) return false;
  const opts = q.options || {};
  const keys = ['a', 'b', 'c', 'd'].filter(k => typeof opts[k] === 'string' && opts[k].trim());
  if (q.subtype === 'tf') { if (keys.length !== 2 || !opts.a || !opts.b) return false; }
  else if (keys.length < 3) return false;
  if (!keys.includes(q.answer)) return false;
  if (typeof q.explanation !== 'string' || !q.explanation.trim()) return false;
  return true;
}

/* ---------- 結果 ---------- */
function appendResult(rec) {
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(rec) + '\n', 'utf8');
}
function readResults() {
  try {
    return fs.readFileSync(RESULTS_FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

/* ---------- 進行中的考卷(記憶體;重啟即失效,可接受) ---------- */
const exams = new Map(); // examId -> {name, questions:[poolItem], startedAt}
function gcExams(now) {
  for (const [id, ex] of exams) if (now - ex.startedAt > EXAM_TTL_MS) exams.delete(id);
}

/* ---------- 速率限制(滑動視窗) ---------- */
const hits = new Map();
let globalHits = [];
function allowRate(ip, now) {
  const win = now - 60000;
  globalHits = globalHits.filter(t => t > win);
  if (globalHits.length >= RATE_GLOBAL_PER_MIN) return false;
  const arr = (hits.get(ip) || []).filter(t => t > win);
  if (arr.length >= RATE_PER_MIN) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr); globalHits.push(now);
  return true;
}

/* ---------- Dify 出題 ---------- */
function parseDifyJson(answer) {
  const tries = [
    () => JSON.parse(answer),
    () => JSON.parse(answer.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')),
    () => { const m = answer.match(/\{[\s\S]*\}/); if (!m) throw new Error('no json'); return JSON.parse(m[0]); },
  ];
  for (const fn of tries) { try { return fn(); } catch (e) { /* next */ } }
  return null;
}

async function difyGenerate({ mcq = 0, tf = 0, topic = '', difficulty = '' }) {
  if (!DIFY_API_KEY) { const e = new Error('後端未設 DIFY_API_KEY'); e.status = 503; throw e; }
  const parts = [];
  if (mcq > 0) parts.push(`${mcq} 題單選`);
  if (tf > 0) parts.push(`${tf} 題是非`);
  let query = `出 ${parts.join(' + ')}`;
  if (topic) query += `,主題:${topic}`;
  if (difficulty) query += `,難度:${difficulty}`;
  const r = await fetch(DIFY_BASE_URL + '/chat-messages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${DIFY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: {}, query, response_mode: 'blocking', user: 'quiz-app-admin' }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const e = new Error(`Dify 回應 ${r.status}:${text.slice(0, 200)}`); e.status = 502; throw e;
  }
  const data = await r.json();
  const parsed = parseDifyJson(String(data.answer || ''));
  if (!parsed || !Array.isArray(parsed.mcq)) { const e = new Error('Dify 回應無法解析為題目 JSON'); e.status = 502; throw e; }
  return parsed.mcq;
}

/* ---------- helpers ---------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
const jsonErr = (res, code, msg) => json(res, code, { error: msg });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / 同源導航
  const host = req.headers.host;
  try { return new URL(origin).host === host; } catch (e) { return false; }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function isAdmin(req, url) {
  if (!ADMIN_TOKEN) return true; // 未設 token = 開發模式(README 有警告)
  const auth = req.headers.authorization || '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('token') || '');
  return t === ADMIN_TOKEN;
}

/* ---------- 統計 ---------- */
function overviewStats() {
  const results = readResults();
  const n = results.length;
  const passN = results.filter(r => r.pass).length;
  const avg = n ? results.reduce((s, r) => s + r.score, 0) / n : 0;
  const weekAgo = Date.now() - 7 * 86400000;
  const weekN = results.filter(r => r.ts > weekAgo).length;
  // 每題答對率
  const stat = new Map(); // qid -> {ok, total}
  for (const r of results) for (const it of (r.items || [])) {
    const s = stat.get(it.qid) || { ok: 0, total: 0 };
    s.total++; if (it.correct) s.ok++;
    stat.set(it.qid, s);
  }
  return { attempts: n, week_attempts: weekN, avg_score: Math.round(avg * 10) / 10, pass_n: passN, pass_rate: n ? Math.round(passN / n * 1000) / 10 : 0, qstat: Object.fromEntries(stat) };
}

/* ---------- 靜態檔 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2',
};
function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  if (p === '/admin') p = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR) || path.basename(file).startsWith('.')) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' https://unpkg.com; img-src 'self' data:; connect-src 'self'",
      'Cache-Control': p.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(buf);
  });
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const now = Date.now();
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      if (!allowRate(ip, now)) return jsonErr(res, 429, '請求過於頻繁,請稍候');
      if (req.method === 'POST' && !sameOrigin(req)) return jsonErr(res, 403, '來源不允許');

      /* 開始測驗:抽題(不含答案) */
      if (p === '/api/exam/start' && req.method === 'POST') {
        gcExams(now);
        const body = JSON.parse(await readBody(req, 4096) || '{}');
        const name = String(body.name || '').trim().slice(0, MAX_NAME) || '匿名考生';
        const mcqPool = pool.filter(q => q.subtype !== 'tf');
        const tfPool = pool.filter(q => q.subtype === 'tf');
        if (mcqPool.length < PAPER.mcq || tfPool.length < PAPER.tf) {
          return jsonErr(res, 503, `題庫不足(選擇 ${mcqPool.length}/${PAPER.mcq}、是非 ${tfPool.length}/${PAPER.tf}),請通知管理員補題`);
        }
        const picked = shuffle([...shuffle(mcqPool).slice(0, PAPER.mcq), ...shuffle(tfPool).slice(0, PAPER.tf)]);
        const examId = crypto.randomBytes(16).toString('hex');
        exams.set(examId, { name, questions: picked, startedAt: now });
        return json(res, 200, {
          exam_id: examId, name, duration_min: PAPER.duration_min,
          pass_score: PAPER.pass_score, points_each: PAPER.points_each,
          questions: picked.map((q, i) => ({
            no: i + 1, qid: q.id, type: q.subtype === 'tf' ? 'tf' : 'mcq',
            question: q.question, options: q.options,
          })),
        });
      }

      /* 交卷:伺服器端評分 */
      if (p === '/api/exam/submit' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, MAX_BODY) || '{}');
        const ex = exams.get(String(body.exam_id || ''));
        if (!ex) return jsonErr(res, 410, '考卷不存在或已過期,請重新開始測驗');
        exams.delete(body.exam_id);
        const answers = body.answers || {};
        const items = ex.questions.map((q, i) => {
          const ua = typeof answers[q.id] === 'string' ? answers[q.id] : null;
          const correct = ua === q.answer;
          return {
            no: i + 1, qid: q.id, type: q.subtype === 'tf' ? 'tf' : 'mcq',
            question: q.question, options: q.options,
            your_answer: ua, correct_answer: q.answer, correct,
            explanation: q.explanation, source: q.source || '',
          };
        });
        const okN = items.filter(it => it.correct).length;
        const score = okN * PAPER.points_each;
        const pass = score >= PAPER.pass_score;
        const elapsed = Math.min(Math.max(0, parseInt(body.elapsed_sec, 10) || 0), PAPER.duration_min * 60);
        appendResult({
          ts: Date.now(), name: ex.name, score, pass, elapsed_sec: elapsed,
          mcq_ok: items.filter(i => i.type === 'mcq' && i.correct).length,
          mcq_n: items.filter(i => i.type === 'mcq').length,
          tf_ok: items.filter(i => i.type === 'tf' && i.correct).length,
          tf_n: items.filter(i => i.type === 'tf').length,
          items: items.map(i => ({ qid: i.qid, correct: i.correct })),
        });
        return json(res, 200, {
          name: ex.name, score, total: (PAPER.mcq + PAPER.tf) * PAPER.points_each,
          pass, pass_score: PAPER.pass_score, ok_n: okN, n: items.length,
          mcq_ok: items.filter(i => i.type === 'mcq' && i.correct).length,
          mcq_n: PAPER.mcq, tf_ok: items.filter(i => i.type === 'tf' && i.correct).length,
          tf_n: PAPER.tf, elapsed_sec: elapsed, items,
        });
      }

      /* 前台狀態(題庫是否就緒) */
      if (p === '/api/status' && req.method === 'GET') {
        const mcqN = pool.filter(q => q.subtype !== 'tf').length;
        const tfN = pool.filter(q => q.subtype === 'tf').length;
        return json(res, 200, {
          ready: mcqN >= PAPER.mcq && tfN >= PAPER.tf,
          paper: PAPER, pool: { mcq: mcqN, tf: tfN },
        });
      }

      /* ----- 管理後台 API ----- */
      if (p.startsWith('/api/admin/')) {
        if (!isAdmin(req, url)) return jsonErr(res, 401, 'ADMIN_TOKEN 不正確');

        if (p === '/api/admin/overview' && req.method === 'GET') {
          const stats = overviewStats();
          return json(res, 200, {
            ...stats,
            pool_n: pool.length,
            pool_mcq: pool.filter(q => q.subtype !== 'tf').length,
            pool_tf: pool.filter(q => q.subtype === 'tf').length,
            questions: pool.map(q => ({
              id: q.id, question: q.question, type: q.subtype === 'tf' ? '是非題' : '選擇題',
              topic: q.topic || '', source: q.origin || 'Dify',
              ok_rate: stats.qstat[q.id] ? Math.round(stats.qstat[q.id].ok / stats.qstat[q.id].total * 1000) / 10 : null,
            })).reverse(),
            dify_enabled: !!DIFY_API_KEY,
          });
        }

        if (p === '/api/admin/generate' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 4096) || '{}');
          const nMcq = Math.min(Math.max(0, parseInt(body.mcq, 10) || 0), 10);
          const nTf = Math.min(Math.max(0, parseInt(body.tf, 10) || 0), 10);
          if (!nMcq && !nTf) return jsonErr(res, 400, '請指定要產生的題數');
          const topic = String(body.topic || '').slice(0, 100);
          const difficulty = ['易', '中', '難'].includes(body.difficulty) ? body.difficulty : '';
          const generated = await difyGenerate({ mcq: nMcq, tf: nTf, topic, difficulty });
          const seen = new Set(pool.map(q => normalize(q.question)));
          let added = 0, dropped = 0;
          for (const q of generated) {
            if (!validQuestion(q)) { dropped++; continue; }
            const key = normalize(q.question);
            if (seen.has(key)) { dropped++; continue; }
            seen.add(key);
            pool.push({
              id: 'q_' + crypto.randomBytes(6).toString('hex'),
              subtype: q.subtype === 'tf' ? 'tf' : undefined,
              question: q.question.trim(), options: q.options, answer: q.answer,
              explanation: q.explanation, source: q.source || '', topic: q.topic || '',
              difficulty: q.difficulty || '', origin: 'Dify', added_at: Date.now(),
            });
            added++;
          }
          savePool();
          return json(res, 200, { added, dropped, pool_n: pool.length });
        }

        if (p === '/api/admin/question' && req.method === 'DELETE') {
          const id = url.searchParams.get('id');
          const before = pool.length;
          pool = pool.filter(q => q.id !== id);
          if (pool.length !== before) savePool();
          return json(res, 200, { removed: before - pool.length, pool_n: pool.length });
        }

        if (p === '/api/admin/results.csv' && req.method === 'GET') {
          const rows = readResults();
          const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
          const csv = ['時間,暱稱,分數,及格,選擇題答對,是非題答對,作答秒數']
            .concat(rows.map(r => [new Date(r.ts).toISOString(), r.name, r.score, r.pass ? 'Y' : 'N', `${r.mcq_ok}/${r.mcq_n}`, `${r.tf_ok}/${r.tf_n}`, r.elapsed_sec].map(esc).join(',')))
            .join('\n');
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="ttqs-quiz-results.csv"',
          });
          return res.end('﻿' + csv);
        }
      }

      return jsonErr(res, 404, 'API not found');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(res, p);
  } catch (e) {
    const code = e.status || 500;
    if (code >= 500) console.error(req.method, p, e);
    jsonErr(res, code, e.status ? e.message : '伺服器錯誤');
  }
});

server.listen(PORT, () => {
  console.log(`TTQS quiz_app listening on :${PORT}`);
  console.log(`題庫池:${pool.length} 題(${POOL_FILE})`);
  if (!DIFY_API_KEY) console.warn('⚠ 未設 DIFY_API_KEY,管理後台無法產題');
  if (!ADMIN_TOKEN) console.warn('⚠ 未設 ADMIN_TOKEN,/api/admin/* 無驗證(僅限開發)');
});
