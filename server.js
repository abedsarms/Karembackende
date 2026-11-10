'use strict';
/**
 * KAReM backend — zero dependencies (Node >= 22.13: node:http, node:sqlite, fetch).
 * All money logic, limits, timers, referral and wheel results live HERE (server time),
 * never in the browser.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ───────────────────────── config ─────────────────────────
function loadDotEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();
const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(+v) ? +v : d);

const cfg = {
  port: num(env.PORT, 3000),
  botToken: env.BOT_TOKEN || '',
  botUsername: (env.BOT_USERNAME || '').replace(/^@/, ''),
  webappUrl: env.WEBAPP_URL || '',
  devMode: env.DEV_MODE === '1',
  testMode: env.NODE_ENV === 'test',
  adminToken: env.ADMIN_TOKEN || '',
  adminIds: (env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  dbPath: env.DB_PATH || path.join(__dirname, 'data', 'karem.db'),
  tgApi: env.TG_API_BASE || 'https://api.telegram.org',
  trustProxy: env.TRUST_PROXY === '1',
  botPolling: env.BOT_POLLING !== '0',
  maxAccountsPerDevice: num(env.MAX_ACCOUNTS_PER_DEVICE, 1),
  maxAccountsPerIp: num(env.MAX_ACCOUNTS_PER_IP, 5),
  initDataMaxAgeSec: num(env.INITDATA_MAX_AGE_SEC, 86400),
  postbackSecret: env.ADS_POSTBACK_SECRET || '',
  fpIpRule: env.FP_IP_RULE !== '0', // same hardware fingerprint + same IP counts as the same device
};

if (!cfg.devMode && !cfg.botToken) {
  console.error('FATAL: BOT_TOKEN is required (or set DEV_MODE=1 for local testing only).');
  process.exit(1);
}

const H = 3600 * 1000;
const RULES = {
  waitSec: num(env.WAIT_SEC, 10), // minimum time between "Play" and "Claim"
  spinWaitSec: num(env.SPIN_WAIT_SEC, 5),
  perTaskLimit: num(env.TASK_LIMIT, 15), // ads per window
  windowMs: 8 * H,
  dailyMs: 24 * H,
  dailyReward: 100, // all amounts are integers in milli-stars (1 ⭐ = 1000)
  minWithdraw: 25000,
  spinEarn: 15000,
  refBonus: 100,
  refAdsNeeded: 5,
  refPct: 10,
  captchaEvery: num(env.CAPTCHA_EVERY, 5),
  sessionMaxAgeMs: 30 * 60 * 1000,
  leaguePrizes: [25000, 12500, 7500],
  subRecheckSec: num(env.SUB_RECHECK_SEC, 1800), // how often a finished subscribe task is re-verified
  maxPendingWithdrawals: 2,
};
const WHEEL = [0, 500, 0, 1500, 250, 0, 1000, 250]; // prize per slice (milli-stars), 0 = nothing

const httpsOrEmpty = (u) => (u && /^https:\/\//i.test(u) ? u : '');
const TASKS = {
  ad1: { type: 'ad', reward: 60, url: httpsOrEmpty(env.AD1_URL), postback: env.AD1_POSTBACK === '1' },
  ad2: { type: 'ad', reward: 50, url: httpsOrEmpty(env.AD2_URL), postback: env.AD2_POSTBACK === '1' },
  ad3: { type: 'ad', reward: 40, url: httpsOrEmpty(env.AD3_URL), postback: env.AD3_POSTBACK === '1' },
  sub1: { type: 'sub', reward: 75, url: httpsOrEmpty(env.SUB1_URL), channel: env.SUB1_CHANNEL || '' },
  sub2: { type: 'sub', reward: 75, url: httpsOrEmpty(env.SUB2_URL), channel: env.SUB2_CHANNEL || '' },
};
const SPIN_AD_URL = httpsOrEmpty(env.SPIN_AD_URL);
const EARN_KINDS = ['ad', 'sub', 'daily', 'ref_bonus', 'ref_commission'];
const COMMISSION_KINDS = ['ad', 'sub', 'daily'];

// ───────────────────────── database ─────────────────────────
fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
const db = new DatabaseSync(cfg.dbPath);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, lang TEXT,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),
  earned_total INTEGER NOT NULL DEFAULT 0, spin_mark INTEGER NOT NULL DEFAULT 0,
  referrer_id INTEGER, ref_ads INTEGER NOT NULL DEFAULT 0, ref_rewarded INTEGER NOT NULL DEFAULT 0,
  claims_since_captcha INTEGER NOT NULL DEFAULT 0,
  captcha_hash TEXT, captcha_exp INTEGER NOT NULL DEFAULT 0, captcha_tries INTEGER NOT NULL DEFAULT 0,
  daily_next_at INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
  device_hash TEXT, ip TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS users_ref ON users(referrer_id);
CREATE INDEX IF NOT EXISTS users_ip ON users(ip, created_at);
CREATE TABLE IF NOT EXISTS pending_refs(user_id INTEGER PRIMARY KEY, referrer_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS task_limits(
  user_id INTEGER NOT NULL, task TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL DEFAULT 0, last_claim_at INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, task));
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, task TEXT NOT NULL, started_at INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, task);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
  amount INTEGER NOT NULL, ref TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id);
CREATE INDEX IF NOT EXISTS ledger_week ON ledger(created_at, kind);
CREATE TABLE IF NOT EXISTS withdrawals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount INTEGER NOT NULL,
  type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS wd_user ON withdrawals(user_id);
CREATE TABLE IF NOT EXISTS league_awards(week TEXT NOT NULL, rank INTEGER NOT NULL, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(week, rank));
CREATE TABLE IF NOT EXISTS devices(device_hash TEXT NOT NULL, user_id INTEGER NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY(device_hash, user_id));
`);

function addColumn(table, col, def) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ } }
addColumn('devices', 'fp_hash', "TEXT NOT NULL DEFAULT ''");
addColumn('devices', 'ip', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'debt', 'INTEGER NOT NULL DEFAULT 0');
addColumn('task_limits', 'paid', 'INTEGER NOT NULL DEFAULT 0');
addColumn('task_limits', 'last_check', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS devices_fp ON devices(fp_hash, ip)');

const _q = new Map();
const q = (sql) => { let s = _q.get(sql); if (!s) { s = db.prepare(sql); _q.set(sql, s); } return s; };
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}

// ───────────────────────── helpers ─────────────────────────
class ApiError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra || {}; }
}
const fail = (status, code, extra) => { throw new ApiError(status, code, extra); };
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const ri = (a, b) => a + crypto.randomInt(b - a + 1);

// ───────────────────────── Telegram ─────────────────────────
function verifyInitData(initData) {
  if (!cfg.botToken || typeof initData !== 'string' || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const dcs = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(cfg.botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (!safeEq(calc, hash)) return null;
  const authDate = +params.get('auth_date');
  if (!authDate || Date.now() / 1000 - authDate > cfg.initDataMaxAgeSec) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !Number.isSafeInteger(user.id) || user.is_bot) return null;
    return { user, startParam: params.get('start_param') || '' };
  } catch { return null; }
}

async function tg(method, body) {
  const res = await fetch(`${cfg.tgApi}/bot${cfg.botToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(40000),
  });
  return res.json();
}
async function notify(userId, text) {
  if (!cfg.botToken) return;
  try { await tg('sendMessage', { chat_id: userId, text }); } catch (e) { log('notify failed', userId, e.message); }
}
async function isMember(channel, userId) {
  if (!channel) { if (cfg.devMode) return true; fail(503, 'NOT_CONFIGURED'); }
  let r;
  try { r = await tg('getChatMember', { chat_id: channel, user_id: userId }); }
  catch { fail(502, 'TG_ERROR'); }
  if (!r.ok) { log('getChatMember error', r.description); fail(502, 'TG_ERROR'); }
  const s = r.result.status;
  return ['creator', 'administrator', 'member'].includes(s) || (s === 'restricted' && r.result.is_member === true);
}

// ───────────────────────── users / auth ─────────────────────────
const getUser = (id) => q('SELECT * FROM users WHERE id=?').get(id);

function ensureUser(tgu, startParam, ctx) {
  const t = now();
  let u = getUser(tgu.id);
  if (u && u.banned) fail(403, 'BANNED');

  // one device ↔ limited number of accounts. A device is recognised by
  //  (a) a random id that the client stores in 4 places (localStorage, cookie, IndexedDB, Telegram Device/SecureStorage), or
  //  (b) its hardware fingerprint + IP — so clearing the browser storage alone does NOT free the device.
  if (ctx.deviceHash || ctx.fpHash) {
    const useFp = cfg.fpIpRule && ctx.fpHash && ctx.ip ? 1 : 0;
    const others = q(`SELECT COUNT(DISTINCT user_id) c FROM devices WHERE user_id != ?
      AND ((? != '' AND device_hash = ?) OR (? = 1 AND fp_hash = ? AND ip = ?))`)
      .get(tgu.id, ctx.deviceHash || '', ctx.deviceHash || '', useFp, ctx.fpHash || '', ctx.ip || '').c;
    if (others >= cfg.maxAccountsPerDevice) fail(403, 'DEVICE_LIMIT');
  }

  if (!u) {
    let rid = null;
    const m = /^ref_(\d{1,15})$/.exec(startParam || '');
    if (m) rid = +m[1];
    else { const p = q('SELECT referrer_id FROM pending_refs WHERE user_id=?').get(tgu.id); if (p) rid = p.referrer_id; }
    const ipCount = ctx.ip ? q('SELECT COUNT(*) c FROM users WHERE ip=? AND created_at>?').get(ctx.ip, t - 24 * H).c : 0;
    const flagged = ipCount >= cfg.maxAccountsPerIp ? 1 : 0;
    let referrer = null;
    if (rid && rid !== tgu.id && !flagged) {
      const r = getUser(rid);
      if (r && !r.banned && !(ctx.deviceHash && r.device_hash === ctx.deviceHash)) referrer = rid;
    }
    q('INSERT INTO users(id,username,first_name,lang,referrer_id,flagged,device_hash,ip,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(tgu.id, tgu.username || null, (tgu.first_name || '').slice(0, 64), tgu.language_code || null, referrer, flagged, ctx.deviceHash || null, ctx.ip || null, t, t);
    q('DELETE FROM pending_refs WHERE user_id=?').run(tgu.id);
    u = getUser(tgu.id);
  } else if (t - u.last_seen > 60000 || u.username !== (tgu.username || null)) {
    q('UPDATE users SET username=?, first_name=?, last_seen=? WHERE id=?').run(tgu.username || null, (tgu.first_name || '').slice(0, 64), t, u.id);
  }
  if (ctx.deviceHash || ctx.fpHash) {
    q(`INSERT INTO devices(device_hash,user_id,first_seen,fp_hash,ip) VALUES(?,?,?,?,?)
       ON CONFLICT(device_hash,user_id) DO UPDATE SET fp_hash=excluded.fp_hash, ip=excluded.ip`)
      .run(ctx.deviceHash || '', u.id, t, ctx.fpHash || '', ctx.ip || '');
  }
  return u;
}

function authenticate(req, ctx) {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('tma ')) {
    const v = verifyInitData(h.slice(4));
    if (!v) fail(401, 'UNAUTHORIZED');
    return ensureUser(v.user, v.startParam, ctx);
  }
  if (cfg.devMode && h.startsWith('dev ')) {
    const id = +h.slice(4);
    if (!Number.isSafeInteger(id) || id <= 0) fail(401, 'UNAUTHORIZED');
    return ensureUser({ id, first_name: 'Dev' + id }, '', ctx);
  }
  return fail(401, 'UNAUTHORIZED');
}

// ───────────────────────── money ─────────────────────────
function credit(uid, kind, amount, ref) {
  if (!Number.isInteger(amount) || amount <= 0) return;
  const earned = EARN_KINDS.includes(kind) ? amount : 0;
  const debt = q('SELECT debt FROM users WHERE id=?').get(uid).debt;
  const repay = Math.min(debt, amount); // an earlier subscribe-penalty that the balance could not cover is repaid first
  q('UPDATE users SET balance=balance+?, earned_total=earned_total+?, debt=debt-? WHERE id=?').run(amount - repay, earned, repay, uid);
  q('INSERT INTO ledger(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)').run(uid, kind, amount, ref || null, now());
  if (repay > 0) q('INSERT INTO ledger(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)').run(uid, 'debt_repay', -repay, ref || null, now());
}
/** take a reward back (user left the channel). Whatever the balance can't cover becomes debt. */
function penalize(uid, amount, ref) {
  const u = getUser(uid); const take = Math.min(u.balance, amount);
  q('UPDATE users SET balance=balance-?, debt=debt+?, earned_total=MAX(spin_mark, earned_total-?) WHERE id=?').run(take, amount - take, amount, uid);
  q('INSERT INTO ledger(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)').run(uid, 'sub_penalty', -amount, ref || null, now());
}
/** credit an earning + pay the referrer's % commission (only for activated referrals) */
function earn(user, kind, amount, ref) {
  credit(user.id, kind, amount, ref);
  if (COMMISSION_KINDS.includes(kind) && user.referrer_id && user.ref_rewarded) {
    const c = Math.floor((amount * RULES.refPct) / 100);
    if (c > 0) credit(user.referrer_id, 'ref_commission', c, String(user.id));
  }
}

// ───────────────────────── limits & sessions ─────────────────────────
function limitRow(uid, key, t) {
  const r = q('SELECT count,reset_at,last_claim_at,done FROM task_limits WHERE user_id=? AND task=?').get(uid, key)
    || { count: 0, reset_at: 0, last_claim_at: 0, done: 0 };
  if (r.reset_at > 0 && t >= r.reset_at) return { count: 0, reset_at: 0, last_claim_at: r.last_claim_at, done: r.done };
  return { ...r };
}
function saveLimit(uid, key, r) {
  q(`INSERT INTO task_limits(user_id,task,count,reset_at,last_claim_at,done) VALUES(?,?,?,?,?,?)
     ON CONFLICT(user_id,task) DO UPDATE SET count=excluded.count,reset_at=excluded.reset_at,last_claim_at=excluded.last_claim_at,done=excluded.done`)
    .run(uid, key, r.count, r.reset_at, r.last_claim_at, r.done);
}
const taskAvailable = (t) => (t.type === 'ad' ? !!t.url || cfg.devMode : (!!t.channel && !!cfg.botToken) || cfg.devMode);
const fillUrl = (url, sid, uid) => (url || '').replaceAll('{sid}', sid).replaceAll('{uid}', String(uid));

function checkTaskOpen(uid, key, def, t) {
  if (!taskAvailable(def)) fail(503, 'NOT_CONFIGURED');
  const lim = limitRow(uid, key, t);
  if (def.type === 'sub' && lim.done) fail(409, 'ALREADY_DONE');
  if (def.type === 'ad' && lim.count >= RULES.perTaskLimit) fail(429, 'LIMIT', { resetAt: lim.reset_at });
  return lim;
}

// ───────────────────────── state snapshot ─────────────────────────
const weekStart = (ts) => { const d = new Date(ts); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); };
const EARN_IN = [...EARN_KINDS, 'sub_penalty'].map((k) => `'${k}'`).join(','); // league score also loses penalties

function weeklyScore(uid, t) {
  const ws = weekStart(t);
  return q(`SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE user_id=? AND created_at>=? AND kind IN (${EARN_IN})`).get(uid, ws).s;
}
function weeklyRank(uid, t) {
  const s = weeklyScore(uid, t);
  if (s <= 0) return { rank: null, score: 0 };
  const ws = weekStart(t);
  const above = q(`SELECT COUNT(*) c FROM (SELECT user_id, SUM(amount) s FROM ledger l WHERE created_at>=? AND kind IN (${EARN_IN})
                   AND NOT EXISTS(SELECT 1 FROM users u WHERE u.id=l.user_id AND u.banned=1) GROUP BY user_id HAVING s>?)`).get(ws, s).c;
  return { rank: above + 1, score: s };
}
const mask = (name) => { const n = Array.from(String(name || 'User')); return n.slice(0, 2).join('') + '•••'; };

function buildState(uid) {
  const u = getUser(uid); const t = now();
  const tasks = {};
  for (const [key, def] of Object.entries(TASKS)) {
    const lim = limitRow(uid, key, t);
    tasks[key] = {
      type: def.type, reward: def.reward, available: taskAvailable(def),
      count: lim.count, max: def.type === 'ad' ? RULES.perTaskLimit : 1,
      resetAt: def.type === 'ad' ? lim.reset_at : 0, done: !!lim.done,
    };
  }
  const refs = q('SELECT COUNT(*) c, COALESCE(SUM(ref_rewarded),0) a FROM users WHERE referrer_id=?').get(uid);
  const { rank, score } = weeklyRank(uid, t);
  const wd = q('SELECT id,amount,type,status,created_at FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 5').all(uid);
  return {
    now: t,
    user: { id: u.id, name: u.first_name || u.username || String(u.id) },
    balance: u.balance,
    spin: { progress: Math.min(u.earned_total - u.spin_mark, RULES.spinEarn), need: RULES.spinEarn, ready: u.earned_total - u.spin_mark >= RULES.spinEarn },
    daily: { nextAt: u.daily_next_at, reward: RULES.dailyReward },
    tasks,
    refs: {
      count: refs.c, active: refs.a,
      link: cfg.botUsername ? `https://t.me/${cfg.botUsername}?startapp=ref_${u.id}` : '',
    },
    league: { rank, score },
    withdrawals: wd,
    captchaRequired: u.claims_since_captcha >= RULES.captchaEvery,
    config: {
      waitSec: RULES.waitSec, minWithdraw: RULES.minWithdraw, wheel: WHEEL,
      refAdsNeeded: RULES.refAdsNeeded, refBonus: RULES.refBonus, refPct: RULES.refPct,
      prizes: RULES.leaguePrizes, dev: cfg.devMode,
    },
  };
}

// ───────────────────────── captcha ─────────────────────────
function makeCaptcha() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  const W = 170, Hh = 56;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}"><rect width="100%" height="100%" fill="#1e1b4b"/>`;
  for (let i = 0; i < 7; i++) s += `<line x1="${ri(0, W)}" y1="${ri(0, Hh)}" x2="${ri(0, W)}" y2="${ri(0, Hh)}" stroke="rgba(${ri(120, 255)},${ri(120, 255)},${ri(120, 255)},0.55)" stroke-width="${ri(1, 2)}"/>`;
  [...code].forEach((c, i) => {
    s += `<text x="${18 + i * 30}" y="${38 + ri(-5, 5)}" font-size="${ri(26, 32)}" font-family="monospace" font-weight="bold" fill="${i % 2 ? '#fde047' : '#34d399'}" transform="rotate(${ri(-25, 25)} ${18 + i * 30} 30)">${c}</text>`;
  });
  return { code, svg: s + '</svg>' };
}

// ───────────────────────── route handlers ─────────────────────────
const H_ = {};

H_.auth = (c) => ({ state: buildState(c.user.id) });
H_.state = H_.auth;

H_.taskStart = (c) => {
  const key = String(c.body.task || '');
  const def = TASKS[key]; if (!def) fail(400, 'BAD_TASK');
  const t = now();
  return tx(() => {
    const lim = checkTaskOpen(c.user.id, key, def, t);
    if (t - lim.last_claim_at < RULES.waitSec * 1000) fail(429, 'TOO_EARLY', { retryMs: RULES.waitSec * 1000 - (t - lim.last_claim_at) });
    q('DELETE FROM sessions WHERE user_id=? AND task=? AND used=0').run(c.user.id, key);
    const sid = crypto.randomBytes(16).toString('hex');
    q('INSERT INTO sessions(id,user_id,task,started_at) VALUES(?,?,?,?)').run(sid, c.user.id, key, t);
    return { sessionId: sid, url: fillUrl(def.url, sid, c.user.id), waitSec: RULES.waitSec, state: buildState(c.user.id) };
  });
};

function checkClaimable(user, s, def, key, t) {
  if (user.claims_since_captcha >= RULES.captchaEvery) fail(428, 'CAPTCHA_REQUIRED');
  const age = t - s.started_at;
  if (age < RULES.waitSec * 1000) fail(429, 'TOO_EARLY', { retryMs: RULES.waitSec * 1000 - age });
  if (age > RULES.sessionMaxAgeMs) fail(410, 'EXPIRED');
  if (def.postback && !s.confirmed) fail(409, 'NOT_CONFIRMED');
  return checkTaskOpen(user.id, key, def, t);
}

H_.taskClaim = async (c) => {
  const sid = String(c.body.sessionId || '');
  const s = q('SELECT * FROM sessions WHERE id=?').get(sid);
  if (!s || s.user_id !== c.user.id || s.used || !TASKS[s.task]) fail(400, 'BAD_SESSION');
  const key = s.task; const def = TASKS[key];
  checkClaimable(getUser(c.user.id), s, def, key, now()); // cheap pre-check before calling Telegram
  if (def.type === 'sub' && !(await isMember(def.channel, c.user.id))) fail(400, 'NOT_MEMBER');
  return tx(() => {
    const t = now();
    const user = getUser(c.user.id);
    const s2 = q('SELECT * FROM sessions WHERE id=?').get(sid);
    if (!s2 || s2.used) fail(400, 'BAD_SESSION');
    const lim = checkClaimable(user, s2, def, key, t); // re-validate inside the transaction (race-safe)
    q('UPDATE sessions SET used=1 WHERE id=? AND used=0').run(sid);
    lim.last_claim_at = t;
    if (def.type === 'ad') {
      lim.count += 1;
      if (lim.count >= RULES.perTaskLimit) lim.reset_at = t + RULES.windowMs;
    } else lim.done = 1;
    saveLimit(user.id, key, lim);
    if (def.type === 'sub') q('UPDATE task_limits SET paid=?, last_check=? WHERE user_id=? AND task=?').run(def.reward, t, user.id, key);

    let activated = user;
    if (def.type === 'ad') {
      const adsNow = user.ref_ads + 1;
      q('UPDATE users SET ref_ads=? WHERE id=?').run(adsNow, user.id);
      if (user.referrer_id && !user.ref_rewarded && adsNow >= RULES.refAdsNeeded) {
        q('UPDATE users SET ref_rewarded=1 WHERE id=?').run(user.id);
        credit(user.referrer_id, 'ref_bonus', RULES.refBonus, String(user.id));
        activated = { ...user, ref_rewarded: 1 };
      }
    }
    q('UPDATE users SET claims_since_captcha=claims_since_captcha+1 WHERE id=?').run(user.id);
    earn(activated, def.type === 'ad' ? 'ad' : 'sub', def.reward, key);
    return { reward: def.reward, state: buildState(user.id) };
  });
};

H_.postback = (c) => {
  if (!cfg.postbackSecret || !safeEq(c.query.get('secret') || '', cfg.postbackSecret)) fail(403, 'FORBIDDEN');
  const sid = String(c.query.get('sid') || '');
  const r = q('UPDATE sessions SET confirmed=1 WHERE id=? AND used=0').run(sid);
  return { ok: true, updated: r.changes };
};

H_.daily = (c) => tx(() => {
  const t = now(); const u = getUser(c.user.id);
  if (t < u.daily_next_at) fail(429, 'TOO_EARLY', { retryMs: u.daily_next_at - t });
  q('UPDATE users SET daily_next_at=? WHERE id=?').run(t + RULES.dailyMs, u.id);
  earn(u, 'daily', RULES.dailyReward);
  return { reward: RULES.dailyReward, state: buildState(u.id) };
});

H_.captchaGet = (c) => {
  const { code, svg } = makeCaptcha();
  q('UPDATE users SET captcha_hash=?, captcha_exp=?, captcha_tries=0 WHERE id=?').run(sha(`${code}:${c.user.id}`), now() + 5 * 60000, c.user.id);
  return cfg.testMode ? { svg, code } : { svg };
};
H_.captchaVerify = (c) => {
  const u = getUser(c.user.id);
  const ans = String(c.body.answer || '').trim().toUpperCase().slice(0, 8);
  if (!u.captcha_hash || now() > u.captcha_exp) fail(400, 'CAPTCHA_WRONG');
  if (safeEq(sha(`${ans}:${u.id}`), u.captcha_hash)) {
    q('UPDATE users SET claims_since_captcha=0, captcha_hash=NULL, captcha_tries=0 WHERE id=?').run(u.id);
    return { ok: true, state: buildState(u.id) };
  }
  if (u.captcha_tries + 1 >= 3) q('UPDATE users SET captcha_hash=NULL, captcha_tries=0 WHERE id=?').run(u.id);
  else q('UPDATE users SET captcha_tries=captcha_tries+1 WHERE id=?').run(u.id);
  return fail(400, 'CAPTCHA_WRONG');
};

H_.spinStart = (c) => tx(() => {
  const u = getUser(c.user.id);
  if (u.earned_total - u.spin_mark < RULES.spinEarn) fail(409, 'NOT_READY');
  q("DELETE FROM sessions WHERE user_id=? AND task='spin' AND used=0").run(u.id);
  const sid = crypto.randomBytes(16).toString('hex');
  q("INSERT INTO sessions(id,user_id,task,started_at) VALUES(?,?,'spin',?)").run(sid, u.id, now());
  return { sessionId: sid, url: fillUrl(SPIN_AD_URL, sid, u.id), waitSec: RULES.spinWaitSec };
});
H_.spin = (c) => tx(() => {
  const t = now(); const u = getUser(c.user.id);
  const s = q('SELECT * FROM sessions WHERE id=?').get(String(c.body.sessionId || ''));
  if (!s || s.user_id !== u.id || s.used || s.task !== 'spin') fail(400, 'BAD_SESSION');
  if (t - s.started_at < RULES.spinWaitSec * 1000) fail(429, 'TOO_EARLY', { retryMs: RULES.spinWaitSec * 1000 - (t - s.started_at) });
  if (t - s.started_at > RULES.sessionMaxAgeMs) fail(410, 'EXPIRED');
  if (u.earned_total - u.spin_mark < RULES.spinEarn) fail(409, 'NOT_READY');
  q('UPDATE sessions SET used=1 WHERE id=?').run(s.id);
  const index = crypto.randomInt(WHEEL.length); // server-side RNG
  const prize = WHEEL[index];
  q('UPDATE users SET spin_mark=earned_total WHERE id=?').run(u.id);
  if (prize > 0) credit(u.id, 'spin', prize, String(index));
  return { index, prize, state: buildState(u.id) };
});

H_.withdraw = (c) => tx(() => {
  const u = getUser(c.user.id);
  const amount = c.body.amount_m;
  const type = c.body.type;
  if (!Number.isSafeInteger(amount) || amount <= 0 || !['gift', 'balance'].includes(type)) fail(400, 'BAD_AMOUNT');
  if (amount < RULES.minWithdraw) fail(400, 'MIN_WITHDRAW');
  if (u.flagged) fail(403, 'BANNED');
  if (amount > u.balance) fail(400, 'INSUFFICIENT');
  const pend = q("SELECT COUNT(*) c FROM withdrawals WHERE user_id=? AND status='pending'").get(u.id).c;
  if (pend >= RULES.maxPendingWithdrawals) fail(429, 'TOO_MANY_PENDING');
  q('UPDATE users SET balance=balance-? WHERE id=?').run(amount, u.id); // CHECK(balance>=0) is the last line of defence
  const t = now();
  const r = q('INSERT INTO withdrawals(user_id,amount,type,created_at,updated_at) VALUES(?,?,?,?,?)').run(u.id, amount, type, t, t);
  q('INSERT INTO ledger(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)').run(u.id, 'withdraw', -amount, String(r.lastInsertRowid), t);
  queueMicrotask(() => cfg.adminIds.forEach((a) => notify(a, `💸 New withdrawal #${r.lastInsertRowid}: ${amount / 1000} ⭐ (${type}) from user ${u.id}`)));
  return { id: Number(r.lastInsertRowid), state: buildState(u.id) };
});

H_.league = (c) => {
  const t = now(); const ws = weekStart(t);
  const rows = q(`SELECT l.user_id id, SUM(l.amount) s, u.first_name name FROM ledger l JOIN users u ON u.id=l.user_id
                  WHERE l.created_at>=? AND l.kind IN (${EARN_IN}) AND u.banned=0 GROUP BY l.user_id ORDER BY s DESC, MIN(l.id) ASC LIMIT 10`).all(ws);
  const me = weeklyRank(c.user.id, t);
  return {
    weekEndsAt: ws + 7 * 24 * H,
    top: rows.map((r, i) => ({ rank: i + 1, name: r.id === c.user.id ? r.name : mask(r.name), score: r.s, me: r.id === c.user.id })),
    me, prizes: RULES.leaguePrizes,
  };
};

// ───────────────────────── admin ─────────────────────────
H_.adminWithdrawals = (c) => {
  const st = c.query.get('status') || 'pending';
  return { items: q('SELECT w.*, u.username, u.first_name FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status=? ORDER BY w.id ASC LIMIT 200').all(st) };
};
H_.adminWithdrawalAction = (c) => {
  const id = +c.params.id; const action = c.body.action;
  if (!['approve', 'reject'].includes(action)) fail(400, 'BAD_ACTION');
  const w = tx(() => {
    const row = q('SELECT * FROM withdrawals WHERE id=?').get(id);
    if (!row) fail(404, 'NOT_FOUND');
    if (row.status !== 'pending') fail(409, 'ALREADY_DONE');
    const status = action === 'approve' ? 'approved' : 'rejected';
    q('UPDATE withdrawals SET status=?, note=?, updated_at=? WHERE id=?').run(status, String(c.body.note || '').slice(0, 200), now(), id);
    if (status === 'rejected') credit(row.user_id, 'refund', row.amount, String(id)); // refund (not counted as earning)
    return { ...row, status };
  });
  notify(w.user_id, w.status === 'approved' ? `✅ Your withdrawal #${w.id} (${w.amount / 1000} ⭐) was approved.` : `❌ Your withdrawal #${w.id} was rejected and ${w.amount / 1000} ⭐ returned to your balance.`);
  return { ok: true, status: w.status };
};
H_.adminBan = (c) => {
  const id = +c.params.id; const banned = c.body.banned ? 1 : 0;
  const r = q('UPDATE users SET banned=? WHERE id=?').run(banned, id);
  if (!r.changes) fail(404, 'NOT_FOUND');
  return { ok: true, banned };
};
H_.adminStats = () => ({
  users: q('SELECT COUNT(*) c FROM users').get().c,
  totalBalance: q('SELECT COALESCE(SUM(balance),0) s FROM users').get().s,
  pendingWithdrawals: q("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM withdrawals WHERE status='pending'").get(),
});

// ───────────────────────── weekly league prizes ─────────────────────────
function awardLastWeek() {
  const t = now(); const thisWeek = weekStart(t); const prev = thisWeek - 7 * 24 * H;
  const key = new Date(prev).toISOString().slice(0, 10);
  if (q('SELECT 1 x FROM league_awards WHERE week=?').get(key)) return;
  const winners = q(`SELECT l.user_id id, SUM(l.amount) s FROM ledger l JOIN users u ON u.id=l.user_id
    WHERE l.created_at>=? AND l.created_at<? AND l.kind IN (${EARN_IN}) AND u.banned=0 AND u.flagged=0
    GROUP BY l.user_id ORDER BY s DESC, MIN(l.id) ASC LIMIT ${RULES.leaguePrizes.length}`).all(prev, thisWeek);
  tx(() => {
    winners.forEach((w, i) => {
      q('INSERT INTO league_awards(week,rank,user_id,amount) VALUES(?,?,?,?)').run(key, i + 1, w.id, RULES.leaguePrizes[i]);
      credit(w.id, 'league_prize', RULES.leaguePrizes[i], key);
    });
    if (!winners.length) q('INSERT INTO league_awards(week,rank,user_id,amount) VALUES(?,?,?,?)').run(key, 0, 0, 0); // marker: week processed
  });
  winners.forEach((w, i) => notify(w.id, `🏆 Weekly league: you placed #${i + 1} and won ${RULES.leaguePrizes[i] / 1000} ⭐!`));
  log('league awarded for week', key, winners.length);
}

// ───────────────────────── rate limiting ─────────────────────────
const buckets = new Map();
function limited(key, max, perMs) {
  const t = now(); let b = buckets.get(key);
  if (!b || t - b.start > perMs) { b = { start: t, n: 0 }; buckets.set(key, b); }
  return ++b.n > max;
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.start > 120000) buckets.delete(k); }, 60000).unref();

// ───────────────────────── HTTP server ─────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'none'",
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (d) => { n += d.length; if (n > 8192) { reject(new ApiError(413, 'TOO_LARGE')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); }
      catch { reject(new ApiError(400, 'BAD_JSON')); }
    });
    req.on('error', reject);
  });
}
function clientIp(req) {
  if (cfg.trustProxy) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
  return req.socket.remoteAddress || '';
}

// route table: [method, regex, handler, auth]   auth: 'user' | 'admin' | 'none'
const ROUTES = [
  ['POST', /^\/api\/auth$/, H_.auth, 'user'],
  ['GET', /^\/api\/state$/, H_.state, 'user'],
  ['POST', /^\/api\/task\/start$/, H_.taskStart, 'user'],
  ['POST', /^\/api\/task\/claim$/, H_.taskClaim, 'user'],
  ['POST', /^\/api\/daily$/, H_.daily, 'user'],
  ['GET', /^\/api\/captcha$/, H_.captchaGet, 'user'],
  ['POST', /^\/api\/captcha\/verify$/, H_.captchaVerify, 'user'],
  ['POST', /^\/api\/spin\/start$/, H_.spinStart, 'user'],
  ['POST', /^\/api\/spin$/, H_.spin, 'user'],
  ['POST', /^\/api\/withdraw$/, H_.withdraw, 'user'],
  ['GET', /^\/api\/league$/, H_.league, 'user'],
  ['GET', /^\/api\/postback$/, H_.postback, 'none'],
  ['GET', /^\/api\/admin\/stats$/, H_.adminStats, 'admin'],
  ['GET', /^\/api\/admin\/withdrawals$/, H_.adminWithdrawals, 'admin'],
  ['POST', /^\/api\/admin\/withdrawals\/(?<id>\d+)$/, H_.adminWithdrawalAction, 'admin'],
  ['POST', /^\/api\/admin\/users\/(?<id>\d+)\/ban$/, H_.adminBan, 'admin'],
];

async function handleApi(req, res, url) {
  const ip = clientIp(req);
  if (limited(`ip:${ip}`, 300, 60000)) fail(429, 'RATE_LIMIT');
  const route = ROUTES.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!route) fail(404, 'NOT_FOUND');
  const [method, re, handler, auth] = route;
  const ctx = { req, res, ip, query: url.searchParams, params: re.exec(url.pathname).groups || {}, body: method === 'POST' ? await readBody(req) : {} };

  if (auth === 'admin') {
    if (!cfg.adminToken || !safeEq(String(req.headers['x-admin-token'] || ''), cfg.adminToken)) fail(401, 'UNAUTHORIZED');
  } else if (auth === 'user') {
    const dev = String(req.headers['x-device'] || '').slice(0, 100);
    const fp = String(req.headers['x-fp'] || '').slice(0, 200);
    ctx.user = authenticate(req, { ip, deviceHash: dev ? sha(dev) : '', fpHash: fp ? sha('fp:' + fp) : '' });
    if (method === 'POST' && limited(`u:${ctx.user.id}`, num(env.USER_RATE_PER_MIN, 40), 60000)) fail(429, 'RATE_LIMIT');
  }
  return handler(ctx);
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(url.pathname);
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || path.basename(file).startsWith('.')) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return send(res, 200, await handleApi(req, res, url));
    return serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, { error: e.code, ...e.extra });
    log('ERROR', req.method, req.url, e);
    return send(res, 500, { error: 'UNKNOWN' });
  }
});
server.requestTimeout = 30000;

// ───────────────────────── Telegram bot (long polling) ─────────────────────────
async function onUpdate(up) {
  const m = up.message;
  if (!m || !m.text || !m.from || m.chat.type !== 'private') return;
  if (!m.text.startsWith('/start')) return;
  const payload = (m.text.split(/\s+/)[1] || '');
  const rm = /^ref_(\d{1,15})$/.exec(payload);
  if (rm && +rm[1] !== m.from.id && !getUser(m.from.id)) {
    q('INSERT OR REPLACE INTO pending_refs(user_id,referrer_id,created_at) VALUES(?,?,?)').run(m.from.id, +rm[1], now());
  }
  const fa = (m.from.language_code || '').startsWith('fa');
  const body = { chat_id: m.chat.id, text: fa ? '⭐ به KAReM خوش آمدید! با دکمه زیر برنامه را باز کنید.' : '⭐ Welcome to KAReM! Tap the button below to open the app.' };
  if (/^https:\/\//.test(cfg.webappUrl)) body.reply_markup = { inline_keyboard: [[{ text: fa ? '🚀 باز کردن برنامه' : '🚀 Open app', web_app: { url: cfg.webappUrl } }]] };
  await tg('sendMessage', body);
}
let stopping = false;
async function pollBot() {
  let offset = 0;
  while (!stopping) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      if (!r.ok) { log('getUpdates failed:', r.description); await sleep(5000); continue; }
      for (const up of r.result) { offset = up.update_id + 1; try { await onUpdate(up); } catch (e) { log('update error', e.message); } }
    } catch (e) { if (!stopping) { log('poll error', e.message); await sleep(5000); } }
  }
}

// ───────────────────────── subscribe re-check ─────────────────────────
let rechecking = false;
async function recheckSubs() {
  if (rechecking || !cfg.botToken) return;
  rechecking = true;
  try {
    for (const [key, def] of Object.entries(TASKS)) {
      if (def.type !== 'sub' || !def.channel) continue;
      const rows = q('SELECT user_id, paid FROM task_limits WHERE task=? AND done=1 AND last_check<=? ORDER BY last_check ASC LIMIT 100').all(key, now() - RULES.subRecheckSec * 1000);
      for (const r of rows) {
        let member;
        try { member = await isMember(def.channel, r.user_id); }
        catch { await sleep(200); continue; } // Telegram/API error → never punish, retry next run
        if (member) { q('UPDATE task_limits SET last_check=? WHERE user_id=? AND task=?').run(now(), r.user_id, key); }
        else {
          const amount = r.paid || def.reward;
          const done = tx(() => {
            const cur = q('SELECT done FROM task_limits WHERE user_id=? AND task=?').get(r.user_id, key);
            if (!cur || !cur.done) return false;
            q('UPDATE task_limits SET done=0, last_check=? WHERE user_id=? AND task=?').run(now(), r.user_id, key);
            penalize(r.user_id, amount, key);
            return true;
          });
          if (done) { log('sub penalty', r.user_id, key, amount); notify(r.user_id, `⚠️ You left the channel, so ${amount / 1000} ⭐ was deducted. / کانال را ترک کردید و ${amount / 1000} ⭐ کسر شد.`); }
        }
        await sleep(60); // stay far below Telegram's rate limits
      }
    }
  } catch (e) { log('recheck error', e.message); }
  finally { rechecking = false; }
}

// ───────────────────────── start ─────────────────────────
function maintenance() {
  try {
    q('DELETE FROM sessions WHERE started_at<?').run(now() - 24 * H);
    q('DELETE FROM pending_refs WHERE created_at<?').run(now() - 7 * 24 * H);
    awardLastWeek();
  } catch (e) { log('maintenance error', e.message); }
}

server.listen(cfg.port, async () => {
  log(`KAReM listening on :${cfg.port} (devMode=${cfg.devMode})`);
  maintenance();
  setInterval(maintenance, H).unref();
  setInterval(recheckSubs, Math.max(1, Math.min(300, RULES.subRecheckSec)) * 1000).unref();
  if (cfg.botToken) {
    try {
      if (!cfg.botUsername) { const me = await tg('getMe'); if (me.ok) cfg.botUsername = me.result.username; }
    } catch (e) { log('getMe failed:', e.message); }
    if (cfg.botPolling) pollBot();
  }
});

function shutdown() { stopping = true; server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => log('unhandledRejection', e));
