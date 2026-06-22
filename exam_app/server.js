'use strict';
/*
 * TTQS 人才發展品質管理 線上模擬考 — 零依賴後端（靜態檔 + Dify 代理）。
 * 安全要點：
 *  - Dify API key 只存在後端環境變數 DIFY_API_KEY，永不送到前端。
 *  - /api/dify 代理：同源檢查、每 IP + 全域速率限制、請求體大小/欄位白名單。
 *  - 靜態檔僅從 public/ 沙箱提供，擋路徑穿越與 dotfiles。
 *  - 安全標頭：CSP、X-Content-Type-Options、X-Frame-Options、Referrer-Policy。
 * 環境變數：
 *  - DIFY_API_KEY（必填才會啟用 AI 評分；未填則前端自動退回自評模式）
 *  - DIFY_BASE_URL（預設 https://api.dify.ai/v1）
 *  - PORT（預設 8080；Zeabur 會自動注入）
 *  - RATE_PER_MIN（每 IP 每分鐘上限，預設 40）
 *  - RATE_GLOBAL_PER_MIN（全域每分鐘上限，保護 Dify 額度，預設 600）
 *  - ALLOW_ORIGINS（逗號分隔的允許來源；預設同源，留空=不強制）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DIFY_API_KEY = process.env.DIFY_API_KEY || '';
const DIFY_BASE_URL = (process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1').replace(/\/+$/, '');
const RATE_PER_MIN = parseInt(process.env.RATE_PER_MIN || '40', 10);
const RATE_GLOBAL_PER_MIN = parseInt(process.env.RATE_GLOBAL_PER_MIN || '600', 10);
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
// 是否信任反向代理的 X-Forwarded-For（自架直曝務必保持關閉，否則 per-IP 速率限制可被偽造繞過）
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// session token 簽章密鑰（未設則啟動時隨機產生；多實例需用同一把，請以 env 提供）
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 6 * 3600 * 1000;   // token 有效 6 小時（涵蓋 120 分鐘考試 + 評分討論）
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 16 * 1024;          // 一般請求體上限 16KB
const MAX_QUERY = 12000;             // query 字串上限
// 排行榜：結果持久化（DATA_DIR 在 Zeabur 掛持久磁碟，預設本機 ./data）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.jsonl');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';   // 設了才開放 /api/admin/results（老師稽核作答）
const MAX_RESULT_BODY = 64 * 1024;   // 交卷結果含作答，body 上限放大
const MAX_NAME = 40;
const MAX_LEADERBOARD = 500;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('無法建立 DATA_DIR:', e.message); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

/* ---------- 速率限制（記憶體滑動視窗） ---------- */
const hits = new Map();   // ip -> [timestamps]
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
// 定期清空避免記憶體膨脹
setInterval(() => { const win = Date.now() - 60000; for (const [ip, arr] of hits) { const f = arr.filter(t => t > win); if (f.length) hits.set(ip, f); else hits.delete(ip); } }, 120000).unref();

function clientIp(req) {
  // 預設用真實 socket 位址；僅在明確信任代理時，採 XFF 最右側（最接近本機、由可信代理寫入）的 hop
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ---------- session token（HMAC，防腳本直接濫用 /api/dify 燒額度） ---------- */
function issueToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('base64url');
  return exp + '.' + sig;
}
function verifyToken(tok) {
  if (!tok || typeof tok !== 'string') return false;
  const i = tok.indexOf('.');
  if (i < 0) return false;
  const exp = tok.slice(0, i), sig = tok.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', SESSION_SECRET).update(exp).digest('base64url');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)); } catch { return false; }
}

function secHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

function send(res, code, body, type) {
  secHeaders(res);
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

/* ---------- 靜態檔（沙箱於 public/） ---------- */
function serveStatic(req, res) {
  let p = decodeURIComponent((req.url.split('?')[0]) || '/');
  if (p === '/') p = '/index.html';
  // 正規化並確保仍在 PUBLIC_DIR 內（擋 ../ 穿越）
  const full = path.normalize(path.join(PUBLIC_DIR, p));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden');
  // 擋任何路徑段以 . 開頭（含隱藏目錄內檔案），而非僅 basename
  const rel = full.slice(PUBLIC_DIR.length + 1);
  if (rel.split(path.sep).some(seg => seg.startsWith('.'))) return send(res, 404, 'not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  });
}

/* ---------- /api/dify 代理 ---------- */
function originOk(req) {
  const o = req.headers.origin || req.headers.referer;
  if (!o) return false;                  // 寫入型端點一律要求 Origin/Referer，缺則拒（擋無標頭的腳本）
  let host;
  try { host = new URL(o).host; } catch { return false; }
  if (!ALLOW_ORIGINS.length) return host === req.headers.host;   // 預設：嚴格同源
  // 明確允許清單：比對完整 origin（精確比對，避免 startsWith 前綴詐騙）
  let origin;
  try { origin = new URL(o).origin; } catch { return false; }
  return ALLOW_ORIGINS.includes(origin);
}

function readBody(req, limit) {
  const cap = limit || MAX_BODY;
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > cap) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonErr(res, code, msg, extraHeaders) {
  secHeaders(res);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extraHeaders || {}));
  res.end(JSON.stringify({ error: msg }));
}

async function handleDify(req, res) {
  if (req.method !== 'POST') return jsonErr(res, 405, 'method not allowed');
  if (!DIFY_API_KEY) return jsonErr(res, 503, 'AI 未啟用（後端未設 DIFY_API_KEY）');
  if (!originOk(req)) return jsonErr(res, 403, 'origin not allowed');
  if (!verifyToken(req.headers['x-exam-token'])) return jsonErr(res, 401, 'invalid or expired session token');
  if (!allowRate(clientIp(req), Date.now())) return jsonErr(res, 429, '請求過於頻繁，請稍候再試', { 'Retry-After': '30' });

  let raw;
  try { raw = await readBody(req); } catch { return jsonErr(res, 413, 'body too large'); }
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return jsonErr(res, 400, 'invalid json'); }

  const query = typeof body.query === 'string' ? body.query : '';
  if (!query || query.length > MAX_QUERY) return jsonErr(res, 400, 'invalid query');

  // 每位學生用自己的 user id（前端隨機產生）做 conversation 命名空間隔離；只接受安全字元
  const uid = (typeof body.user === 'string' && /^[\w-]{1,64}$/.test(body.user)) ? body.user : 'exam-app';
  // 只轉發白名單欄位、不透傳任意 inputs，固定 blocking，避免被當任意 LLM 代理濫用
  const safe = { inputs: {}, query, response_mode: 'blocking', user: uid };
  if (typeof body.conversation_id === 'string' && /^[\w-]{1,80}$/.test(body.conversation_id)) safe.conversation_id = body.conversation_id;

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch(DIFY_BASE_URL + '/chat-messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + DIFY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(safe), signal: ctrl.signal,
    });
    clearTimeout(to);
    const text = await r.text();
    secHeaders(res);
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
  } catch (e) {
    send(res, 502, JSON.stringify({ error: 'upstream error', detail: String(e.message || e).slice(0, 120) }), 'application/json; charset=utf-8');
  }
}

/* ---------- 排行榜：結果記錄與查詢 ---------- */
// 串行化寫入，避免並發 append 交錯
let writeChain = Promise.resolve();
function appendResult(rec) {
  const line = JSON.stringify(rec) + '\n';
  writeChain = writeChain.then(() => fs.promises.appendFile(RESULTS_FILE, line, 'utf8'))
    .catch(e => console.error('寫入結果失敗:', e.message));
  return writeChain;
}

function sanitizeName(s) {
  if (typeof s !== 'string') return '';
  // 去控制字元與角括號（防注入），保留中英數字
  return s.replace(/[\x00-\x1f\x7f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}
function numIn(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
}
function ipHash(req) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(clientIp(req)).digest('hex').slice(0, 12);
}

async function handleResult(req, res) {
  if (req.method !== 'POST') return jsonErr(res, 405, 'method not allowed');
  if (!originOk(req)) return jsonErr(res, 403, 'origin not allowed');
  if (!verifyToken(req.headers['x-exam-token'])) return jsonErr(res, 401, 'invalid or expired session token');
  if (!allowRate(clientIp(req), Date.now())) return jsonErr(res, 429, '請求過於頻繁，請稍候再試', { 'Retry-After': '30' });

  let raw;
  try { raw = await readBody(req, MAX_RESULT_BODY); } catch { return jsonErr(res, 413, 'body too large'); }
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return jsonErr(res, 400, 'invalid json'); }

  const name = sanitizeName(body.name);
  if (!name) return jsonErr(res, 400, '缺少姓名');
  const total = numIn(body.total, 0, 100);
  if (total === null) return jsonErr(res, 400, 'invalid total');

  const bdRaw = (body.breakdown && typeof body.breakdown === 'object') ? body.breakdown : {};
  const breakdown = {};
  for (const k of ['mcq', 'short', 'essay']) breakdown[k] = numIn(bdRaw[k], 0, 100) ?? 0;
  // 作答原樣保存供老師稽核（已受 body 上限約束），但對字串長度再設保險上限
  let answers = {};
  if (body.answers && typeof body.answers === 'object') {
    for (const [k, v] of Object.entries(body.answers)) {
      if (Object.keys(answers).length >= 60) break;
      answers[String(k).slice(0, 40)] = String(v == null ? '' : v).slice(0, 4000);
    }
  }
  const rec = {
    id: crypto.randomBytes(8).toString('hex'),
    ts: Date.now(),
    name, uid: (typeof body.uid === 'string' ? body.uid : '').slice(0, 64),
    total, breakdown,
    duration_sec: numIn(body.duration_sec, 0, 100000) ?? 0,
    ai_graded: !!body.ai_graded,
    iph: ipHash(req),
    answers,
  };
  await appendResult(rec);
  leaderboardCache = null;   // 失效快取
  secHeaders(res);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: true, id: rec.id }));
}

let leaderboardCache = null, leaderboardAt = 0;
function loadResults() {
  let txt = '';
  try { txt = fs.readFileSync(RESULTS_FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}
function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const u = new URL(req.url, 'http://x');
  const tok = req.headers['x-admin-token'] || u.searchParams.get('token') || '';
  try { return tok.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN_TOKEN)); } catch { return false; }
}

function handleLeaderboard(req, res) {
  if (req.method !== 'GET') return jsonErr(res, 405, 'method not allowed');
  // 排名不公開：僅老師（ADMIN_TOKEN）可看，避免學生因排名壓力不敢作答
  if (!isAdmin(req)) return jsonErr(res, 401, 'unauthorized');
  const now = Date.now();
  if (!leaderboardCache || now - leaderboardAt > 5000) {
    const recs = loadResults();
    // 依姓名彙整取最佳成績（同名取最高分、最短用時）
    const best = new Map();
    for (const r of recs) {
      const cur = best.get(r.name);
      if (!cur || r.total > cur.total || (r.total === cur.total && r.duration_sec < cur.duration_sec)) {
        best.set(r.name, { name: r.name, total: r.total, breakdown: r.breakdown, duration_sec: r.duration_sec, ai_graded: r.ai_graded, last_ts: r.ts, attempts: (cur ? cur.attempts : 0) + 1 });
      } else {
        cur.attempts += 1; cur.last_ts = Math.max(cur.last_ts, r.ts);
      }
    }
    const list = [...best.values()].sort((a, b) => b.total - a.total || a.duration_sec - b.duration_sec)
      .slice(0, MAX_LEADERBOARD).map((x, i) => ({ rank: i + 1, ...x }));
    leaderboardCache = JSON.stringify({ ok: true, count: best.size, board: list });
    leaderboardAt = now;
  }
  secHeaders(res);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(leaderboardCache);
}

function handleAdminResults(req, res) {
  // 老師稽核：含作答全文，須 ADMIN_TOKEN。未設定則視為關閉（404）。
  if (!ADMIN_TOKEN) return send(res, 404, 'not found');
  const u = new URL(req.url, 'http://x');
  const tok = req.headers['x-admin-token'] || u.searchParams.get('token') || '';
  const ok = (() => { try { return tok.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN_TOKEN)); } catch { return false; } })();
  if (!ok) return jsonErr(res, 401, 'unauthorized');
  const recs = loadResults();
  secHeaders(res);
  if (u.searchParams.get('format') === 'ndjson') {
    let txt = '';
    try { txt = fs.readFileSync(RESULTS_FILE, 'utf8'); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="results.jsonl"' });
    return res.end(txt);
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: true, results: recs }));
}

/* ---------- 路由 ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/health') {
    // 一律發短期 session token（/api/dify 與 /api/result 寫入端點都要回帶，擋無 token 腳本）
    secHeaders(res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, ai: !!DIFY_API_KEY, token: issueToken() }));
  }
  if (url === '/api/dify') return handleDify(req, res);
  if (url === '/api/result') return handleResult(req, res);
  if (url === '/api/leaderboard') return handleLeaderboard(req, res);
  if (url === '/api/admin/results') return handleAdminResults(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  return serveStatic(req, res);
});

// 連線/逾時硬化：擋慢速連線（slowloris 類）與 FD 耗盡
server.requestTimeout = 30000;        // 單一請求最長 30s
server.headersTimeout = 10000;        // 收完 header 最長 10s
server.keepAliveTimeout = 5000;
server.maxConnections = 512;          // 同時連線上限
server.on('connection', s => s.setTimeout(35000, () => s.destroy()));
process.on('unhandledRejection', e => console.error('unhandledRejection', e && e.message));

server.listen(PORT, () => {
  console.log(`exam app on :${PORT}  AI評分=${DIFY_API_KEY ? '啟用' : '未啟用(自評模式)'}  rate=${RATE_PER_MIN}/ip/min,${RATE_GLOBAL_PER_MIN}/global/min  trustProxy=${TRUST_PROXY}`);
});
