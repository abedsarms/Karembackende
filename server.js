'use strict';
/**
 * CAReM backend — zero dependencies (Node >= 22.13: node:http, node:sqlite, fetch).
 * All money logic, limits, timers, referral and wheel results live HERE (server time),
 * never in the browser.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const backup = require('./backup');

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
  adminIps: (env.ADMIN_IPS || '').split(',').map((x) => x.trim()).filter(Boolean), // optional allow-list for the admin API
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
  captchaReward: 20, // paid for a correct captcha that was actually required
  spinWaitSec: num(env.SPIN_WAIT_SEC, 5),
  perTaskLimit: num(env.TASK_LIMIT, 10), // ads per window
  windowMs: 8 * H,
  dailyMs: 24 * H,
  dailyReward: 100, // all amounts are integers in milli-stars (1 ⭐ = 1000)
  minWithdraw: 25000,
  spinEarn: 15000,
  refBonus: 200,
  refAdsNeeded: 5,
  refPct: 10,
  captchaEvery: num(env.CAPTCHA_EVERY, 5),
  sessionMaxAgeMs: 30 * 60 * 1000,
  leaguePrizes: [25000, 12500, 7500],
  subRecheckSec: num(env.SUB_RECHECK_SEC, 1800), // how often a finished subscribe task is re-verified
  maxPendingWithdrawals: 2,
};
// Wheel slices: { t: 'stars' | 'coins' | 'none', a: amount (milli-stars for stars, whole coins for coins), w: weight }.
// First-run defaults live here; after that the live wheel is stored in the DB and managed from the admin panel (🎡 tab).
const WHEEL_DEFAULT = [
  { t: 'none', a: 0, w: 10 }, { t: 'stars', a: 500, w: 10 }, { t: 'coins', a: 5, w: 10 }, { t: 'stars', a: 1500, w: 10 }, { t: 'stars', a: 250, w: 10 },
  { t: 'none', a: 0, w: 10 }, { t: 'stars', a: 5000, w: 7 }, { t: 'stars', a: 250, w: 10 }, { t: 'none', a: 0, w: 10 }, { t: 'coins', a: 20, w: 5 },
];
const WHEEL = JSON.parse(JSON.stringify((() => { // optional first-run override: WHEEL="0,500,1500,..." (milli-stars per slice, 0 = nothing)
  const w = (env.WHEEL || '').split(',').filter((x) => x.trim() !== '').map(Number);
  return w.length >= 4 && w.length <= 16 && w.every((x) => Number.isSafeInteger(x) && x >= 0) ? w.map((a) => ({ t: a > 0 ? 'stars' : 'none', a, w: 1 })) : WHEEL_DEFAULT;
})())); // mutable, loaded from DB below
function sanitizeWheel(list) {
  if (!Array.isArray(list) || list.length < 4 || list.length > 16) fail(400, 'BAD_AMOUNT');
  const out = list.map((x) => {
    if (!x || !['stars', 'coins', 'none'].includes(x.t)) fail(400, 'BAD_AMOUNT');
    const a = x.t === 'none' ? 0 : x.a;
    if (!Number.isSafeInteger(a) || a < 0 || (x.t !== 'none' && a < 1) || a > (x.t === 'coins' ? 100000 : 1e8)) fail(400, 'BAD_AMOUNT');
    if (!Number.isSafeInteger(x.w) || x.w < 0 || x.w > 1000) fail(400, 'BAD_AMOUNT');
    return { t: x.t, a, w: x.w };
  });
  if (!out.some((x) => x.w > 0)) fail(400, 'BAD_AMOUNT');
  return out;
}
function rollWheel() {
  const total = WHEEL.reduce((a, x) => a + x.w, 0); let r = crypto.randomInt(total);
  for (let i = 0; i < WHEEL.length; i++) { if (r < WHEEL[i].w) return i; r -= WHEEL[i].w; }
  return WHEEL.length - 1;
}

const httpsOrEmpty = (u) => (u && /^https:\/\//i.test(u) ? u : '');
// First-run defaults (from .env). After the first start the live configuration is stored in the database
// and is managed from the admin panel (📢 tab) — editing .env afterwards does not change existing tasks.
const TASK_DEFAULTS = {
  ad1: { type: 'ad', reward: 70, click: true, url: httpsOrEmpty(env.AD1_URL), postback: env.AD1_POSTBACK === '1' },
  ad2: { type: 'ad', reward: 1, rewardType: 'coins', url: httpsOrEmpty(env.AD2_URL), postback: env.AD2_POSTBACK === '1' }, // Ad #2 pays 1 in-game coin (🪙) instead of ⭐
  ad3: { type: 'ad', reward: 30, url: httpsOrEmpty(env.AD3_URL), postback: env.AD3_POSTBACK === '1' },
  sub1: { type: 'sub', reward: 75, url: httpsOrEmpty(env.SUB1_URL), channel: env.SUB1_CHANNEL || '' },
  sub2: { type: 'sub', reward: 8, rewardType: 'coins', url: httpsOrEmpty(env.SUB2_URL), channel: env.SUB2_CHANNEL || '' },
};
const TASKS = {}; // key -> { type, reward, url, channel, click, postback, enabled }  (mutable, loaded from DB)
// the wheel has exactly ONE ad: shown after the spin, before the prize is paid
const SETTINGS = { spinAdUrl: httpsOrEmpty(env.SPIN_CLAIM_AD_URL) || httpsOrEmpty(env.SPIN_AD_URL), payUrlStars: '{profile}', payUrlGift: '{profile}' }; // overridden by DB
const EARN_KINDS = ['ad', 'sub', 'daily', 'ref_bonus', 'ref_commission', 'captcha'];
const COMMISSION_KINDS = ['ad', 'sub', 'daily'];

// ───────────────────────── database ─────────────────────────
fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
const db = new DatabaseSync(cfg.dbPath);
// Telegram backup (keeps data alive on hosts with a wiped disk, e.g. Render free). Restore itself runs in start.js.
const restoredInfo = globalThis.__KAREM_RESTORED || { status: 'disabled' };
const backupSvc = backup.createService({
  db, dbPath: cfg.dbPath, token: cfg.botToken, chat: env.BACKUP_CHAT_ID || '', passphrase: env.BACKUP_PASSPHRASE || '', api: cfg.tgApi,
  minGapSec: num(env.BACKUP_MIN_GAP_SEC, 60), everySec: num(env.BACKUP_EVERY_SEC, 300),
  restored: restoredInfo, initialMessageId: restoredInfo.messageId, log: (...a) => console.log(new Date().toISOString(), ...a),
});
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
CREATE TABLE IF NOT EXISTS tasks(key TEXT PRIMARY KEY, type TEXT NOT NULL, reward INTEGER NOT NULL, url TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '',
  click INTEGER NOT NULL DEFAULT 0, postback INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS league_awards(week TEXT NOT NULL, rank INTEGER NOT NULL, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(week, rank));
CREATE TABLE IF NOT EXISTS devices(device_hash TEXT NOT NULL, user_id INTEGER NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY(device_hash, user_id));
CREATE TABLE IF NOT EXISTS spin_log(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, idx INTEGER NOT NULL, t TEXT NOT NULL, a INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coin_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, ref TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS coin_ledger_user ON coin_ledger(user_id);
CREATE TABLE IF NOT EXISTS lottery_events(id INTEGER PRIMARY KEY AUTOINCREMENT, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  seed TEXT NOT NULL, seed_hash TEXT NOT NULL, result TEXT, drawn_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lottery_pieces(event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, tier TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(event_id, user_id, tier));
CREATE TABLE IF NOT EXISTS lottery_boxes(id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, tier TEXT NOT NULL, cost INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS lottery_boxes_user ON lottery_boxes(user_id, created_at);
CREATE TABLE IF NOT EXISTS lottery_results(event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, tier TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(event_id, user_id, tier, kind));
`);

function addColumn(table, col, def) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ } }
addColumn('devices', 'fp_hash', "TEXT NOT NULL DEFAULT ''");
addColumn('devices', 'ip', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'debt', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'coins', 'INTEGER NOT NULL DEFAULT 0 CHECK(coins>=0)');
addColumn('tasks', 'reward_type', "TEXT NOT NULL DEFAULT 'stars'");
addColumn('task_limits', 'paid', 'INTEGER NOT NULL DEFAULT 0');
addColumn('task_limits', 'paid_coins', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sessions', 'ptype', "TEXT NOT NULL DEFAULT 'stars'");
addColumn('withdrawals', 'gift_id', "TEXT NOT NULL DEFAULT ''");
addColumn('withdrawals', 'gift_name', "TEXT NOT NULL DEFAULT ''");
addColumn('lottery_boxes', 'opened', 'INTEGER NOT NULL DEFAULT 1');
addColumn('task_limits', 'last_check', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sessions', 'clicked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sessions', 'prize', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sessions', 'idx', 'INTEGER NOT NULL DEFAULT 0');
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

// ───────────────────────── task / settings storage (managed from the admin panel) ─────────────────────────
function loadTasks() {
  if (!q('SELECT COUNT(*) c FROM tasks').get().c) {
    let i = 0;
    for (const [key, d] of Object.entries(TASK_DEFAULTS)) {
      q('INSERT INTO tasks(key,type,reward,url,channel,click,postback,enabled,sort,updated_at,reward_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(key, d.type, d.reward, d.url || '', d.channel || '', d.click ? 1 : 0, d.postback ? 1 : 0, 1, i++, now(), d.rewardType || 'stars');
    }
  }
  for (const k of Object.keys(TASKS)) delete TASKS[k];
  for (const r of q('SELECT * FROM tasks ORDER BY type, sort, key').all()) {
    TASKS[r.key] = { type: r.type, reward: r.reward, rewardType: r.reward_type === 'coins' ? 'coins' : 'stars', url: r.url, channel: r.channel, click: !!r.click, postback: !!r.postback, enabled: !!r.enabled };
  }
  const st = Object.fromEntries(q('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  if (st.spinAdUrl !== undefined) SETTINGS.spinAdUrl = st.spinAdUrl;
  if (st.payUrlStars) SETTINGS.payUrlStars = st.payUrlStars;
  if (st.payUrlGift) SETTINGS.payUrlGift = st.payUrlGift;
  if (st.perTaskLimit !== undefined && Number.isSafeInteger(+st.perTaskLimit) && +st.perTaskLimit > 0) RULES.perTaskLimit = +st.perTaskLimit;
  if (st.spinEarn !== undefined && Number.isSafeInteger(+st.spinEarn) && +st.spinEarn >= 1) RULES.spinEarn = +st.spinEarn;
  if (st.wheel) { try { const w = sanitizeWheel(JSON.parse(st.wheel)); WHEEL.length = 0; WHEEL.push(...w); } catch { /* keep defaults */ } }
}
const saveSetting = (k, v) => q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
loadTasks();
// one-time: on an existing database Ad #2 starts paying 1 coin instead of ⭐ (changeable any time in the admin panel)
if (!q("SELECT 1 x FROM settings WHERE key='coinAdMigrated'").get()) {
  if (TASKS.ad2 && TASKS.ad2.type === 'ad' && TASKS.ad2.rewardType !== 'coins') {
    q("UPDATE tasks SET reward_type='coins', reward=1, updated_at=? WHERE key='ad2'").run(now());
    loadTasks();
  }
  saveSetting('coinAdMigrated', '1');
}
// one-time: the second subscribe task pays 8 🪙 (≈ the old 0.075 ⭐) — changeable any time in the admin panel
if (!q("SELECT 1 x FROM settings WHERE key='coinSubMigrated'").get()) {
  if (TASKS.sub2 && TASKS.sub2.type === 'sub' && TASKS.sub2.rewardType !== 'coins') {
    q("UPDATE tasks SET reward_type='coins', reward=8, updated_at=? WHERE key='sub2'").run(now());
    loadTasks();
  }
  saveSetting('coinSubMigrated', '1');
}

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
const taskAvailable = (t) => t.enabled && (t.type === 'ad' ? !!t.url || cfg.devMode : (!!t.channel && !!cfg.botToken) || cfg.devMode);
function baseUrl(req) {
  try { if (cfg.webappUrl) return new URL(cfg.webappUrl).origin; } catch { /* fall through */ }
  const proto = cfg.trustProxy ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() : 'http';
  return `${proto}://${req.headers.host}`;
}
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
    if (!def.enabled) continue; // disabled tasks are hidden from users
    const lim = limitRow(uid, key, t);
    tasks[key] = {
      type: def.type, reward: def.reward, rewardType: def.rewardType || 'stars', click: !!def.click, available: taskAvailable(def),
      count: lim.count, max: def.type === 'ad' ? RULES.perTaskLimit : 1,
      resetAt: def.type === 'ad' ? lim.reset_at : 0, done: !!lim.done,
    };
  }
  const refs = q('SELECT COUNT(*) c, COALESCE(SUM(ref_rewarded),0) a FROM users WHERE referrer_id=?').get(uid);
  const { rank, score } = weeklyRank(uid, t);
  const wd = q('SELECT id,amount,type,status,created_at,gift_name FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 5').all(uid);
  return {
    now: t,
    user: { id: u.id, name: u.first_name || u.username || String(u.id) },
    balance: u.balance,
    coins: u.coins,
    lottery: lotteryState(uid),
    spin: { progress: Math.min(u.earned_total - u.spin_mark, RULES.spinEarn), need: RULES.spinEarn, ready: u.earned_total - u.spin_mark >= RULES.spinEarn,
      pending: (() => { const p = pendingPrize(uid); return p ? { prize: p.prize, coins: p.ptype === 'coins' } : null; })() },
    daily: { nextAt: u.daily_next_at, reward: RULES.dailyReward },
    tasks,
    refs: {
      count: refs.c, active: refs.a,
      link: cfg.botUsername ? `https://t.me/${cfg.botUsername}?startapp=ref_${u.id}` : '',
    },
    league: { rank, score, endsAt: weekStart(t) + 7 * 24 * H },
    withdrawals: wd,
    captchaRequired: u.claims_since_captcha >= RULES.captchaEvery,
    config: {
      waitSec: RULES.waitSec, minWithdraw: RULES.minWithdraw, wheel: WHEEL.map((x) => ({ t: x.t, a: x.a })),
      captchaReward: RULES.captchaReward, spinWaitSec: RULES.spinWaitSec, refAdsNeeded: RULES.refAdsNeeded, refBonus: RULES.refBonus, refPct: RULES.refPct,
      prizes: RULES.leaguePrizes, dev: cfg.devMode,
    },
  };
}


const H_ = {}; // route handlers

// ───────────────────────── lottery: coins → boxes → ticket pieces → draw ─────────────────────────
const TIERS = ['gold', 'silver', 'bronze'];
const LOTTERY_DEFAULT = {
  enabled: true, boxCost: 10, chances: { gold: 10, silver: 30, bronze: 60 }, perTicket: 9, maxTickets: 5, boxesPerDay: 50, eventDays: 10,
  coinValue: 10,   // value of 1 🪙 in milli-stars (10 = 0.01 ⭐)
  prizePct: 15,    // a tier's single prize is also capped at this % of the coin value spent in the event
  prizes: { gold: 30000, silver: 15000, bronze: 5000 }, // the one prize per tier (milli-stars) = upper cap
  consolation: { gold: 1200, silver: 400, bronze: 200 }, // milli-stars for every complete ticket that did not win
  convert: { bronzeToSilver: 3, silverToGold: 4 },       // pieces needed for one piece of the next tier
};
const LOTTERY = JSON.parse(JSON.stringify(LOTTERY_DEFAULT));
function sanitizeLottery(j) {
  const int = (v, lo, hi) => { if (!Number.isSafeInteger(v) || v < lo || v > hi) fail(400, 'BAD_AMOUNT'); return v; };
  const obj = (v) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'BAD_AMOUNT'); return v; };
  const out = { enabled: !!j.enabled, boxCost: int(j.boxCost, 1, 100000), perTicket: int(j.perTicket, 1, 100), maxTickets: int(j.maxTickets, 1, 100),
    boxesPerDay: int(j.boxesPerDay, 1, 10000), eventDays: int(j.eventDays, 1, 60), coinValue: int(j.coinValue, 1, 100000), prizePct: int(j.prizePct, 0, 100),
    chances: {}, prizes: {}, consolation: {}, convert: {} };
  obj(j.chances); obj(j.prizes); obj(j.consolation); obj(j.convert);
  for (const t of TIERS) { out.chances[t] = int(j.chances[t], 0, 100); out.prizes[t] = int(j.prizes[t], 0, 1e8); out.consolation[t] = int(j.consolation[t], 0, 1e7); }
  out.convert.bronzeToSilver = int(j.convert.bronzeToSilver, 2, 100); out.convert.silverToGold = int(j.convert.silverToGold, 2, 100);
  if (!TIERS.some((t) => out.chances[t] > 0)) fail(400, 'BAD_AMOUNT');
  return out;
}
(function loadLottery() {
  const r = q("SELECT value FROM settings WHERE key='lottery'").get();
  if (!r) return;
  try { Object.assign(LOTTERY, sanitizeLottery(JSON.parse(r.value))); } catch { /* old/invalid format → keep defaults */ }
})();

const activeEvent = () => q("SELECT * FROM lottery_events WHERE status='active' ORDER BY id DESC LIMIT 1").get();
function newEvent(startAt) {
  const seed = crypto.randomBytes(32).toString('hex'); // committed (hash) at the start, revealed after the draw → anyone can verify
  const id = q('INSERT INTO lottery_events(start_at,end_at,seed,seed_hash) VALUES(?,?,?,?)').run(startAt, startAt + LOTTERY.eventDays * 24 * H, seed, sha(seed)).lastInsertRowid;
  return q('SELECT * FROM lottery_events WHERE id=?').get(id);
}
const ensureEvent = () => activeEvent() || newEvent(now());
const piecesOf = (eventId, uid) => {
  const o = { gold: 0, silver: 0, bronze: 0 };
  for (const r of q('SELECT tier, count FROM lottery_pieces WHERE event_id=? AND user_id=?').all(eventId, uid)) o[r.tier] = r.count;
  return o;
};
const coinsSpent = (eventId) => q('SELECT COALESCE(SUM(cost),0) s FROM lottery_boxes WHERE event_id=?').get(eventId).s;
/** the single prize of a tier: its cap, but never more than prizePct % of the coin value spent in the event */
const tierPrize = (L, spent, tier) => Math.min(L.prizes[tier], Math.floor((spent * L.coinValue * L.prizePct) / 100));
const pendingBox = (eventId, uid) => q('SELECT * FROM lottery_boxes WHERE event_id=? AND user_id=? AND opened=0 ORDER BY id DESC LIMIT 1').get(eventId, uid);
function lotteryState(uid) {
  const ev = ensureEvent(); const t = now();
  const last = q("SELECT * FROM lottery_events WHERE status='drawn' ORDER BY id DESC LIMIT 1").get();
  let lastOut = null;
  if (last) {
    let res = {}; try { res = JSON.parse(last.result || '{}'); } catch { /* ignore */ }
    const per = (res.config && res.config.perTicket) || LOTTERY.perTicket;
    const mine = q('SELECT tier, kind, amount FROM lottery_results WHERE event_id=? AND user_id=?').all(last.id, uid);
    lastOut = {
      id: last.id, drawnAt: last.drawn_at, seed: last.seed, seedHash: last.seed_hash, mine,
      prizes: Object.fromEntries(TIERS.map((k) => [k, ((res.tiers && res.tiers[k] && res.tiers[k].prize) || 0)])),
      joined: !!q('SELECT 1 x FROM lottery_pieces WHERE event_id=? AND user_id=? AND count>=?').get(last.id, uid, per),
    };
  }
  const spent = coinsSpent(ev.id);
  return {
    enabled: LOTTERY.enabled, event: { id: ev.id, startAt: ev.start_at, endAt: ev.end_at, seedHash: ev.seed_hash, ended: t >= ev.end_at },
    boxCost: LOTTERY.boxCost, chances: LOTTERY.chances, perTicket: LOTTERY.perTicket, maxTickets: LOTTERY.maxTickets,
    prizes: Object.fromEntries(TIERS.map((k) => [k, tierPrize(LOTTERY, spent, k)])), prizeCaps: LOTTERY.prizes, consolation: LOTTERY.consolation, convert: LOTTERY.convert,
    pieces: piecesOf(ev.id, uid), pendingBox: !!pendingBox(ev.id, uid),
    boxesLeft: Math.max(0, LOTTERY.boxesPerDay - q('SELECT COUNT(*) c FROM lottery_boxes WHERE user_id=? AND created_at>?').get(uid, t - 24 * H).c),
    last: lastOut,
  };
}
/** step 1: pay boxCost coins → the (blurred) boxes unlock. The piece is decided now (server RNG) but shown when the user picks a box. */
H_.lotteryUnlock = (c) => {
  const notes = drawDue(); notes.forEach(([id, text]) => notify(id, text)); // make sure an ended event is closed first
  return tx(() => {
    if (!LOTTERY.enabled) fail(403, 'DISABLED');
    const u = getUser(c.user.id); const t = now();
    if (u.flagged) fail(403, 'FLAGGED');
    const ev = ensureEvent(); if (t >= ev.end_at) fail(409, 'EVENT_ENDED');
    if (pendingBox(ev.id, u.id)) fail(409, 'PENDING_BOX');
    if (u.coins < LOTTERY.boxCost) fail(402, 'NO_COINS');
    if (q('SELECT COUNT(*) c FROM lottery_boxes WHERE user_id=? AND created_at>?').get(u.id, t - 24 * H).c >= LOTTERY.boxesPerDay) fail(429, 'DAILY_LIMIT');
    const have = piecesOf(ev.id, u.id); const cap = LOTTERY.maxTickets * LOTTERY.perTicket;
    const open = TIERS.filter((k) => have[k] < cap && LOTTERY.chances[k] > 0); // a tier at its ticket cap is skipped
    if (!open.length) fail(409, 'ALL_CAPPED');
    const total = open.reduce((a, k) => a + LOTTERY.chances[k], 0);
    let r = crypto.randomInt(total); let tier = open[open.length - 1];
    for (const k of open) { if (r < LOTTERY.chances[k]) { tier = k; break; } r -= LOTTERY.chances[k]; }
    q('UPDATE users SET coins=coins-? WHERE id=?').run(LOTTERY.boxCost, u.id);
    q('INSERT INTO coin_ledger(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)').run(u.id, 'box', -LOTTERY.boxCost, String(ev.id), t);
    q('INSERT INTO lottery_boxes(event_id,user_id,tier,cost,created_at,opened) VALUES(?,?,?,?,?,0)').run(ev.id, u.id, tier, LOTTERY.boxCost, t);
    return { state: buildState(u.id) };
  });
};
/** step 2: the user picks one of the 3 identical boxes → the piece is revealed and added */
H_.lotteryOpen = (c) => tx(() => {
  const u = getUser(c.user.id); const ev = activeEvent();
  const b = ev && pendingBox(ev.id, u.id); if (!b) fail(404, 'NO_BOX');
  q('UPDATE lottery_boxes SET opened=1 WHERE id=?').run(b.id);
  q('INSERT INTO lottery_pieces(event_id,user_id,tier,count) VALUES(?,?,?,1) ON CONFLICT(event_id,user_id,tier) DO UPDATE SET count=count+1').run(ev.id, u.id, b.tier);
  return { tier: b.tier, pieces: piecesOf(ev.id, u.id)[b.tier], state: buildState(u.id) };
});
/** one-way piece conversion: n bronze → 1 silver, m silver → 1 gold (not above the per-tier cap) */
H_.lotteryConvert = (c) => tx(() => {
  if (!LOTTERY.enabled) fail(403, 'DISABLED');
  const from = String(c.body.from || ''); const map = { bronze: ['silver', LOTTERY.convert.bronzeToSilver], silver: ['gold', LOTTERY.convert.silverToGold] };
  if (!map[from]) fail(400, 'BAD_TIER');
  const [to, need] = map[from]; const u = getUser(c.user.id);
  if (u.flagged) fail(403, 'FLAGGED');
  const ev = ensureEvent(); if (now() >= ev.end_at) fail(409, 'EVENT_ENDED');
  const have = piecesOf(ev.id, u.id);
  if (have[from] < need) fail(409, 'NOT_ENOUGH');
  if (have[to] >= LOTTERY.maxTickets * LOTTERY.perTicket) fail(409, 'ALL_CAPPED');
  q('UPDATE lottery_pieces SET count=count-? WHERE event_id=? AND user_id=? AND tier=?').run(need, ev.id, u.id, from);
  q('INSERT INTO lottery_pieces(event_id,user_id,tier,count) VALUES(?,?,?,1) ON CONFLICT(event_id,user_id,tier) DO UPDATE SET count=count+1').run(ev.id, u.id, to);
  return { from, to, used: need, state: buildState(u.id) };
});

/** deterministic, verifiable randomness: HMAC-SHA256(seed, counter) → [0,1) */
function seededRand(seed) { let n = 0; return () => crypto.createHmac('sha256', seed).update(String(n++)).digest().readUIntBE(0, 6) / 2 ** 48; }
function drawEvent(ev) {
  // boxes that were paid but never opened are opened automatically so nobody loses a piece
  for (const b of q('SELECT * FROM lottery_boxes WHERE event_id=? AND opened=0').all(ev.id)) {
    q('UPDATE lottery_boxes SET opened=1 WHERE id=?').run(b.id);
    q('INSERT INTO lottery_pieces(event_id,user_id,tier,count) VALUES(?,?,?,1) ON CONFLICT(event_id,user_id,tier) DO UPDATE SET count=count+1').run(ev.id, b.user_id, b.tier);
  }
  const L = JSON.parse(JSON.stringify(LOTTERY)); const rand = seededRand(ev.seed); const cap = L.maxTickets * L.perTicket;
  const spent = coinsSpent(ev.id);
  const result = { config: L, spent, tiers: {}, consolation: { users: 0, tickets: 0, paid: 0 } };
  const notes = []; const winnerOf = {}; const cons = new Map(); // user -> { total, parts: {tier: amount} }
  const holdersByTier = {};
  for (const tier of TIERS) {
    const rows = q(`SELECT p.user_id id, p.count c FROM lottery_pieces p JOIN users u ON u.id=p.user_id
      WHERE p.event_id=? AND p.tier=? AND p.count>=? AND u.banned=0 AND u.flagged=0 ORDER BY p.user_id`).all(ev.id, tier, L.perTicket);
    holdersByTier[tier] = rows;
    const cand = rows.map((r) => ({ id: r.id, w: Math.min(r.c, cap) / L.perTicket })); // every piece above a full ticket adds 1/perTicket ticket
    const prize = tierPrize(L, spent, tier); const info = { candidates: rows.length, prize: 0, winner: null, weight: 0 };
    if (cand.length && prize > 0) {
      const total = cand.reduce((a, x) => a + x.w, 0); let r = rand() * total; let i = 0;
      for (; i < cand.length - 1; i++) { if (r < cand[i].w) break; r -= cand[i].w; }
      const w = cand[i]; winnerOf[tier] = w.id; Object.assign(info, { prize, winner: w.id, weight: +w.w.toFixed(4) });
      credit(w.id, 'lottery_prize', prize, `${ev.id}:${tier}`);
      q('INSERT INTO lottery_results(event_id,user_id,tier,kind,amount) VALUES(?,?,?,?,?)').run(ev.id, w.id, tier, 'win', prize);
      notes.push([w.id, `🎉 Lottery #${ev.id}: you won ${prize / 1000} ⭐ (${tier})! / برنده‌ی قرعه‌کشی شدید: ${prize / 1000} ⭐`]);
    }
    result.tiers[tier] = info;
  }
  // every complete ticket that did not win pays its tier's consolation (the winning ticket is excluded; incomplete tickets get nothing)
  for (const tier of TIERS) {
    for (const r of holdersByTier[tier]) {
      const n = Math.floor(Math.min(r.c, cap) / L.perTicket) - (winnerOf[tier] === r.id ? 1 : 0);
      const amount = n * L.consolation[tier]; if (n <= 0 || amount <= 0) continue;
      const e = cons.get(r.id) || { total: 0, parts: {}, tickets: 0 };
      e.total += amount; e.parts[tier] = amount; e.tickets += n; cons.set(r.id, e);
    }
  }
  for (const [id, e] of cons) {
    credit(id, 'lottery_consolation', e.total, String(ev.id));
    for (const [tier, amount] of Object.entries(e.parts)) q('INSERT INTO lottery_results(event_id,user_id,tier,kind,amount) VALUES(?,?,?,?,?)').run(ev.id, id, tier, 'consolation', amount);
    result.consolation.users++; result.consolation.tickets += e.tickets; result.consolation.paid += e.total;
    notes.push([id, `🎁 Lottery #${ev.id}: ${e.tickets} ticket(s) did not win — consolation ${e.total / 1000} ⭐. / جایزه‌ی تسلیت بلیط‌های برنده‌نشده: ${e.total / 1000} ⭐`]);
  }
  q("UPDATE lottery_events SET status='drawn', result=?, drawn_at=? WHERE id=?").run(JSON.stringify(result), now(), ev.id);
  return notes;
}
/** closes + draws an ended event and opens the next one. force=true ends the running event right now (admin). → notifications to send */
function drawDue(force) {
  const ev = activeEvent();
  if (!ev) { tx(() => { if (!activeEvent()) newEvent(now()); }); return []; }
  if (!force && now() < ev.end_at) return [];
  return tx(() => {
    const cur = activeEvent(); if (!cur || cur.id !== ev.id) return [];
    if (force) q('UPDATE lottery_events SET end_at=? WHERE id=?').run(Math.min(cur.end_at, now()), cur.id);
    const notes = drawEvent(cur); newEvent(now()); log('lottery drawn', cur.id, 'notifications', notes.length);
    return notes;
  });
}
const runLottery = () => { try { drawDue().forEach(([id, text]) => notify(id, text)); } catch (e) { log('lottery error', e.message); } };

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
    // click-tracked ads open OUR interstitial page; its button goes through /r/:sid (records the click) and then redirects to the ad
    const url = def.click ? `${baseUrl(c.req)}/ad.html?sid=${sid}` : fillUrl(def.url, sid, c.user.id);
    return { sessionId: sid, url, waitSec: RULES.waitSec, state: buildState(c.user.id) };
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
    if (def.type === 'sub') q('UPDATE task_limits SET paid=?, paid_coins=?, last_check=? WHERE user_id=? AND task=?').run(def.reward, def.rewardType === 'coins' ? 1 : 0, t, user.id, key);

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
    const halved = !!def.click && !s2.clicked; // must click at least once for the full reward
    const reward = halved ? Math.floor(def.reward / 2) : def.reward;
    if (def.rewardType === 'coins') { // in-game coins (ad or subscribe): no ⭐, no league/spin progress, no referral commission
      q('UPDATE users SET coins=coins+? WHERE id=?').run(reward, user.id);
      q('INSERT INTO coin_ledger(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)').run(user.id, def.type === 'sub' ? 'sub' : 'ad', reward, key, t);
      return { reward, halved, coins: true, state: buildState(user.id) };
    }
    earn(activated, def.type === 'ad' ? 'ad' : 'sub', reward, key);
    return { reward, halved, state: buildState(user.id) };
  });
};

H_.postback = (c) => {
  if (!cfg.postbackSecret || !safeEq(c.query.get('secret') || '', cfg.postbackSecret)) fail(403, 'FORBIDDEN');
  const sid = String(c.query.get('sid') || '');
  const r = c.query.get('event') === 'click'
    ? q('UPDATE sessions SET clicked=1 WHERE id=? AND used=0').run(sid)
    : q('UPDATE sessions SET confirmed=1 WHERE id=? AND used=0').run(sid);
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
    return tx(() => {
      const required = getUser(u.id).claims_since_captcha >= RULES.captchaEvery; // no farming: only a REQUIRED captcha pays
      q('UPDATE users SET claims_since_captcha=0, captcha_hash=NULL, captcha_tries=0 WHERE id=?').run(u.id);
      if (required) credit(u.id, 'captcha', RULES.captchaReward);
      return { ok: true, reward: required ? RULES.captchaReward : 0, state: buildState(u.id) };
    });
  }
  if (u.captcha_tries + 1 >= 3) q('UPDATE users SET captcha_hash=NULL, captcha_tries=0 WHERE id=?').run(u.id);
  else q('UPDATE users SET captcha_tries=captcha_tries+1 WHERE id=?').run(u.id);
  return fail(400, 'CAPTCHA_WRONG');
};

const pendingPrize = (uid) => q("SELECT * FROM sessions WHERE user_id=? AND task='spin_claim' AND used=0 ORDER BY started_at DESC LIMIT 1").get(uid);

// Step 1: the spin (no ad before it). The prize is decided here on the server but is NOT paid yet.
H_.spin = (c) => tx(() => {
  const t = now(); const u = getUser(c.user.id);
  if (pendingPrize(u.id)) fail(409, 'PENDING_PRIZE');
  if (u.earned_total - u.spin_mark < RULES.spinEarn) fail(409, 'NOT_READY');
  const index = rollWheel(); // server-side RNG
  const slice = WHEEL[index]; const prize = slice.t === 'none' ? 0 : slice.a; const coins = slice.t === 'coins';
  q('UPDATE users SET spin_mark=earned_total WHERE id=?').run(u.id);
  if (prize > 0) {
    const sid = crypto.randomBytes(16).toString('hex');
    q("INSERT INTO sessions(id,user_id,task,started_at,prize,idx,ptype) VALUES(?,?,'spin_claim',?,?,?,?)").run(sid, u.id, t, prize, index, coins ? 'coins' : 'stars');
  }
  q('INSERT INTO spin_log(user_id,idx,t,a,at) VALUES(?,?,?,?,?)').run(u.id, index, slice.t, prize, t);
  return { index, prize, coins, state: buildState(u.id) };
});
// Step 2a: the ONE wheel ad — user opens it (timer starts now) (timer starts now)
H_.spinClaimStart = (c) => tx(() => {
  const p = pendingPrize(c.user.id); if (!p) fail(404, 'NOT_FOUND');
  q('UPDATE sessions SET confirmed=1, started_at=? WHERE id=?').run(now(), p.id);
  return { sessionId: p.id, url: fillUrl(SETTINGS.spinAdUrl, p.id, c.user.id), waitSec: RULES.spinWaitSec };
});
// Step 2b: after the ad wait → the prize is credited
H_.spinClaim = (c) => tx(() => {
  const t = now();
  const s = q('SELECT * FROM sessions WHERE id=?').get(String(c.body.sessionId || ''));
  if (!s || s.user_id !== c.user.id || s.used || s.task !== 'spin_claim' || !s.confirmed) fail(400, 'BAD_SESSION');
  if (t - s.started_at < RULES.spinWaitSec * 1000) fail(429, 'TOO_EARLY', { retryMs: RULES.spinWaitSec * 1000 - (t - s.started_at) });
  if (t - s.started_at > RULES.sessionMaxAgeMs) { q('UPDATE sessions SET confirmed=0 WHERE id=?').run(s.id); fail(410, 'EXPIRED'); }
  q('UPDATE sessions SET used=1 WHERE id=?').run(s.id);
  if (s.ptype === 'coins') { // coin slice: no ⭐, no league progress
    q('UPDATE users SET coins=coins+? WHERE id=?').run(s.prize, c.user.id);
    q('INSERT INTO coin_ledger(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)').run(c.user.id, 'wheel', s.prize, String(s.idx), t);
    return { prize: s.prize, coins: true, state: buildState(c.user.id) };
  }
  credit(c.user.id, 'spin', s.prize, String(s.idx));
  return { prize: s.prize, state: buildState(c.user.id) };
});

// Telegram gifts the user may choose from. Live list from the Bot API (getAvailableGifts), cached 1 h; built-in list as a fallback.
const GIFT_FALLBACK = [['heart', '💝', 15], ['bear', '🧸', 15], ['gift', '🎁', 25], ['rose', '🌹', 25], ['cake', '🎂', 50], ['bouquet', '💐', 50], ['rocket', '🚀', 50], ['champagne', '🍾', 50], ['trophy', '🏆', 100], ['ring', '💍', 100], ['diamond', '💎', 100]]
  .map(([id, emoji, stars]) => ({ id, emoji, stars }));
let giftCache = { at: 0, list: GIFT_FALLBACK };
async function giftCatalog() {
  if (now() - giftCache.at < H && giftCache.at) return giftCache.list;
  let list = GIFT_FALLBACK;
  if (cfg.botToken) {
    try {
      const r = await tg('getAvailableGifts', {});
      const l = ((r && r.gifts) || []).filter((g) => g && g.id && Number.isSafeInteger(g.star_count) && g.star_count > 0 && !g.remaining_count && !g.total_count)
        .map((g) => ({ id: String(g.id), emoji: (g.sticker && g.sticker.emoji) || '🎁', stars: g.star_count })); // limited-edition gifts (sold out / rare) are left out
      if (l.length) list = l.sort((x, y) => x.stars - y.stars);
    } catch (e) { log('getAvailableGifts failed', e.message); }
  }
  giftCache = { at: now(), list }; return list;
}
H_.gifts = async () => ({ gifts: await giftCatalog(), minWithdraw: RULES.minWithdraw });
H_.withdraw = async (c) => {
  const type = c.body.type; let amount = c.body.amount_m; let gift = null;
  if (type === 'gift') {
    gift = (await giftCatalog()).find((g) => g.id === String(c.body.gift_id || '')); if (!gift) fail(400, 'BAD_GIFT');
    amount = gift.stars * 1000; // a gift has a fixed price
  }
  return tx(() => {
    const u = getUser(c.user.id);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !['gift', 'balance'].includes(type)) fail(400, 'BAD_AMOUNT');
    if (amount < RULES.minWithdraw) fail(400, 'MIN_WITHDRAW');
    if (u.flagged) fail(403, 'BANNED');
    if (amount > u.balance) fail(400, 'INSUFFICIENT');
    const pend = q("SELECT COUNT(*) c FROM withdrawals WHERE user_id=? AND status='pending'").get(u.id).c;
    if (pend >= RULES.maxPendingWithdrawals) fail(429, 'TOO_MANY_PENDING');
    q('UPDATE users SET balance=balance-? WHERE id=?').run(amount, u.id); // CHECK(balance>=0) is the last line of defence
    const t = now(); const gname = gift ? `${gift.emoji} ${gift.stars}⭐` : '';
    const r = q('INSERT INTO withdrawals(user_id,amount,type,created_at,updated_at,gift_id,gift_name) VALUES(?,?,?,?,?,?,?)').run(u.id, amount, type, t, t, gift ? gift.id : '', gname);
    q('INSERT INTO ledger(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)').run(u.id, 'withdraw', -amount, String(r.lastInsertRowid), t);
    const wid = Number(r.lastInsertRowid); const uname = u.username || '';
    queueMicrotask(() => cfg.adminIds.forEach((a) => notifyAdminWithdrawal(a, { id: wid, user_id: u.id, username: uname, amount, type, gift_name: gname })));
    return { id: wid, state: buildState(u.id) };
  });
};
/** where the admin is sent to pay: the user's profile by default (settings templates: {uid} {username} {profile}) */
function payUrl(w) {
  const profile = w.username ? `https://t.me/${w.username}` : `tg://user?id=${w.user_id}`;
  const tpl = w.type === 'gift' ? SETTINGS.payUrlGift : SETTINGS.payUrlStars;
  return String(tpl || '{profile}').replaceAll('{profile}', profile).replaceAll('{uid}', String(w.user_id)).replaceAll('{username}', w.username || '');
}
async function notifyAdminWithdrawal(adminId, w) {
  if (!cfg.botToken) return;
  const what = w.type === 'gift' ? `🎁 gift ${w.gift_name}` : `⭐ Stars`;
  const text = `💸 New withdrawal #${w.id}: ${w.amount / 1000} ⭐ — ${what} — user ${w.user_id}${w.username ? ' @' + w.username : ''}\nاز پنل مدیریت «ارسال پاداش» را بزنید، پاداش را بفرستید و سپس «تایید» کنید.`;
  try { await tg('sendMessage', { chat_id: adminId, text, reply_markup: { inline_keyboard: [[{ text: '💸 ارسال پاداش / Send reward', url: payUrl(w) }]] } }); }
  catch { notify(adminId, text); } // e.g. the link type is refused in a button → plain message
}

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
function logAdmin(action, target, detail) { q('INSERT INTO admin_log(at,action,target,detail) VALUES(?,?,?,?)').run(now(), action, target || null, detail || null); }
H_.adminWithdrawals = (c) => {
  const st = c.query.get('status') || 'pending';
  const where = st === 'all' ? '' : 'WHERE w.status=?';
  const sql = `SELECT w.*, u.username, u.first_name, u.balance, u.flagged, u.banned FROM withdrawals w JOIN users u ON u.id=w.user_id ${where} ORDER BY w.id ${st === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`;
  const items = (st === 'all' ? q(sql).all() : q(sql).all(st)).map((w) => ({ ...w, pay_url: payUrl(w) }));
  return { items };
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
  logAdmin('withdrawal_' + w.status, String(w.id), `user ${w.user_id}, ${w.amount / 1000} ⭐`);
  notify(w.user_id, w.status === 'approved' ? `✅ Your withdrawal #${w.id} (${w.amount / 1000} ⭐) was approved.` : `❌ Your withdrawal #${w.id} was rejected and ${w.amount / 1000} ⭐ returned to your balance.`);
  return { ok: true, status: w.status };
};
H_.adminBan = (c) => {
  const id = +c.params.id; const banned = c.body.banned ? 1 : 0;
  const r = q('UPDATE users SET banned=? WHERE id=?').run(banned, id);
  if (!r.changes) fail(404, 'NOT_FOUND');
  logAdmin(banned ? 'ban' : 'unban', String(id));
  return { ok: true, banned };
};
H_.adminStats = () => {
  const t = now(); const day = 24 * H; const d0 = new Date(t); const midnight = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate());
  const since = midnight - 13 * day;
  const series = {};
  const put = (rows, key) => rows.forEach((r) => { (series[r.d] = series[r.d] || {})[key] = r.v; });
  put(q("SELECT strftime('%Y-%m-%d', created_at/1000,'unixepoch') d, COUNT(*) v FROM users WHERE created_at>=? GROUP BY d").all(since), 'newUsers');
  put(q(`SELECT strftime('%Y-%m-%d', created_at/1000,'unixepoch') d, COUNT(DISTINCT user_id) v FROM ledger WHERE created_at>=? AND kind IN (${EARN_IN}) GROUP BY d`).all(since), 'activeUsers');
  put(q(`SELECT strftime('%Y-%m-%d', created_at/1000,'unixepoch') d, SUM(amount) v FROM ledger WHERE created_at>=? AND kind IN (${EARN_IN}) AND amount>0 GROUP BY d`).all(since), 'earned');
  put(q("SELECT strftime('%Y-%m-%d', created_at/1000,'unixepoch') d, SUM(amount) v FROM withdrawals WHERE created_at>=? GROUP BY d").all(since), 'withdrawn');
  const days = [];
  for (let i = 13; i >= 0; i--) { const k = new Date(midnight - i * day).toISOString().slice(0, 10); days.push({ day: k, newUsers: 0, activeUsers: 0, earned: 0, withdrawn: 0, ...(series[k] || {}) }); }
  return {
    users: q('SELECT COUNT(*) c FROM users').get().c,
    totalBalance: q('SELECT COALESCE(SUM(balance),0) s FROM users').get().s,
    totalDebt: q('SELECT COALESCE(SUM(debt),0) s FROM users').get().s,
    pendingWithdrawals: q("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM withdrawals WHERE status='pending'").get(),
    approvedWithdrawals: q("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM withdrawals WHERE status='approved'").get(),
    new24h: q('SELECT COUNT(*) c FROM users WHERE created_at>?').get(t - day).c,
    active24h: q('SELECT COUNT(*) c FROM users WHERE last_seen>?').get(t - day).c,
    backup: backupSvc.status(),
    online15m: q('SELECT COUNT(*) c FROM users WHERE last_seen>?').get(t - 15 * 60000).c,
    banned: q('SELECT COUNT(*) c FROM users WHERE banned=1').get().c,
    flagged: q('SELECT COUNT(*) c FROM users WHERE flagged=1').get().c,
    referred: q('SELECT COUNT(*) c FROM users WHERE referrer_id IS NOT NULL').get().c,
    byKind7d: q('SELECT kind, COUNT(*) n, SUM(amount) total FROM ledger WHERE created_at>? GROUP BY kind ORDER BY total DESC').all(t - 7 * day),
    days, serverTime: t,
  };
};
const userCols = 'id, username, first_name, balance, debt, earned_total, banned, flagged, referrer_id, ref_ads, ref_rewarded, ip, created_at, last_seen';
H_.adminUsers = (c) => {
  const qs = (c.query.get('q') || '').trim().slice(0, 64); const sort = c.query.get('sort') || 'recent';
  const page = Math.max(0, Math.min(10000, +c.query.get('page') || 0)); const per = 25;
  const where = []; const args = [];
  if (qs) {
    if (/^\d{1,15}$/.test(qs)) { where.push('id=?'); args.push(+qs); }
    else {
      const like = '%' + qs.replace(/[\\%_]/g, '\\$&') + '%';
      where.push("(username LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR ip=?)"); args.push(like, like, qs);
    }
  }
  if (c.query.get('banned') === '1') where.push('banned=1');
  if (c.query.get('flagged') === '1') where.push('flagged=1');
  const order = { recent: 'created_at DESC', balance: 'balance DESC', earned: 'earned_total DESC', seen: 'last_seen DESC' }[sort] || 'created_at DESC';
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = q(`SELECT COUNT(*) c FROM users ${w}`).get(...args).c;
  const items = q(`SELECT ${userCols}, (SELECT COUNT(*) FROM users r WHERE r.referrer_id=users.id) refs FROM users ${w} ORDER BY ${order} LIMIT ${per} OFFSET ${page * per}`).all(...args);
  return { items, total, page, per };
};
H_.adminUser = (c) => {
  const id = +c.params.id; const user = q(`SELECT ${userCols}, coins, device_hash, spin_mark, claims_since_captcha, daily_next_at FROM users WHERE id=?`).get(id);
  if (!user) fail(404, 'NOT_FOUND');
  const devices = q('SELECT substr(device_hash,1,10) device, substr(fp_hash,1,10) fp, ip, first_seen FROM devices WHERE user_id=?').all(id);
  const sameDevice = q(`SELECT DISTINCT u.id, u.first_name, u.username, u.banned FROM users u JOIN devices d ON d.user_id=u.id
    WHERE u.id!=? AND d.device_hash IN (SELECT device_hash FROM devices WHERE user_id=? AND device_hash!='')`).all(id, id);
  const sameIp = user.ip ? q('SELECT id, first_name, username, banned FROM users WHERE ip=? AND id!=? LIMIT 20').all(user.ip, id) : [];
  return {
    user: { ...user, device_hash: undefined },
    referrer: user.referrer_id ? q('SELECT id, first_name, username FROM users WHERE id=?').get(user.referrer_id) || null : null,
    referrals: q('SELECT id, first_name, username, ref_ads, ref_rewarded, created_at FROM users WHERE referrer_id=? ORDER BY created_at DESC LIMIT 100').all(id),
    ledger: q('SELECT id, kind, amount, ref, created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 150').all(id),
    totals: q('SELECT kind, COUNT(*) n, SUM(amount) total FROM ledger WHERE user_id=? GROUP BY kind').all(id),
    withdrawals: q('SELECT id, amount, type, status, note, created_at FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 50').all(id),
    tasks: q('SELECT task, count, reset_at, done, last_claim_at FROM task_limits WHERE user_id=?').all(id),
    devices, sameDevice, sameIp,
  };
};
H_.adminActivity = (c) => {
  const kind = (c.query.get('kind') || '').replace(/[^a-z_]/g, '');
  const rows = q(`SELECT l.id, l.user_id, u.first_name, u.username, l.kind, l.amount, l.ref, l.created_at FROM ledger l JOIN users u ON u.id=l.user_id ${kind ? 'WHERE l.kind=?' : ''} ORDER BY l.id DESC LIMIT 150`);
  return { items: kind ? rows.all(kind) : rows.all() };
};
// ───────────────────────── admin: ads & channel tasks ─────────────────────────
const isHttps = (u) => typeof u === 'string' && u.length <= 500 && /^https:\/\/[^\s]+$/i.test(u);
const CHANNEL_RE = /^(@[A-Za-z][A-Za-z0-9_]{3,31}|-100\d{5,15})$/;
const persistTask = (key) => {
  const d = TASKS[key];
  q(`INSERT INTO tasks(key,type,reward,url,channel,click,postback,enabled,sort,updated_at,reward_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET reward=excluded.reward,reward_type=excluded.reward_type,url=excluded.url,channel=excluded.channel,click=excluded.click,postback=excluded.postback,enabled=excluded.enabled,updated_at=excluded.updated_at`)
    .run(key, d.type, d.reward, d.url, d.channel, d.click ? 1 : 0, d.postback ? 1 : 0, d.enabled ? 1 : 0, Number(key.replace(/\D/g, '')) || 0, now(), d.rewardType === 'coins' ? 'coins' : 'stars');
};
H_.adminTasks = (c) => {
  const t = now();
  const claims = Object.fromEntries(q("SELECT ref, COUNT(*) n, COALESCE(SUM(amount),0) paid, COALESCE(SUM(CASE WHEN created_at>? THEN 1 ELSE 0 END),0) n24 FROM ledger WHERE kind IN ('ad','sub') GROUP BY ref").all(t - 24 * H).map((r) => [r.ref, r]));
  const sess = Object.fromEntries(q('SELECT task, COUNT(*) n, COALESCE(SUM(clicked),0) c FROM sessions WHERE used=1 GROUP BY task').all().map((r) => [r.task, r]));
  const subs = Object.fromEntries(q('SELECT task, COUNT(*) n FROM task_limits WHERE done=1 GROUP BY task').all().map((r) => [r.task, r.n]));
  const coinClaims = Object.fromEntries(q("SELECT ref, COUNT(*) n, COALESCE(SUM(amount),0) paid, COALESCE(SUM(CASE WHEN created_at>? THEN 1 ELSE 0 END),0) n24 FROM coin_ledger WHERE kind IN ('ad','sub') GROUP BY ref").all(t - 24 * H).map((r) => [r.ref, r]));
  Object.assign(claims, coinClaims); // coin ads are tracked in coin_ledger (key names never collide with star ads)
  const items = Object.entries(TASKS).map(([key, d]) => ({
    key, ...d, claims: (claims[key] || {}).n || 0, claims24: (claims[key] || {}).n24 || 0, paid: (claims[key] || {}).paid || 0,
    sessions24: (sess[key] || {}).n || 0, clicks24: (sess[key] || {}).c || 0, subscribed: subs[key] || 0,
  }));
  return {
    items, settings: { spinAdUrl: SETTINGS.spinAdUrl, perTaskLimit: RULES.perTaskLimit, payUrlStars: SETTINGS.payUrlStars, payUrlGift: SETTINGS.payUrlGift }, botConfigured: !!cfg.botToken,
    postbackTemplate: cfg.postbackSecret ? `${baseUrl(c.req)}/api/postback?secret=${cfg.postbackSecret}&sid={sid}` : '',
  };
};
function readTaskFields(b, cur) {
  const out = { ...cur };
  if (b.reward_type !== undefined) {
    if (!['stars', 'coins'].includes(b.reward_type) || false) fail(400, 'BAD_AMOUNT');
    if (b.reward_type !== (cur.rewardType || 'stars') && b.reward_m === undefined) fail(400, 'BAD_AMOUNT'); // units change → a new amount is required
    out.rewardType = b.reward_type;
  }
  if (b.reward_m !== undefined) {
    const coins = out.rewardType === 'coins'; // coins are whole numbers (1 = 1 🪙), stars are milli-stars
    if (!Number.isSafeInteger(b.reward_m) || b.reward_m < 1 || b.reward_m > (coins ? 10000 : 1e7)) fail(400, 'BAD_AMOUNT'); out.reward = b.reward_m;
  }
  if (b.url !== undefined) { const u = String(b.url).trim(); if (u && !isHttps(u)) fail(400, 'BAD_URL'); out.url = u; }
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  if (out.type === 'ad') {
    if (b.click !== undefined) out.click = !!b.click;
    if (b.postback !== undefined) out.postback = !!b.postback;
    if (out.postback && !cfg.postbackSecret) fail(400, 'NO_POSTBACK_SECRET');
  } else { out.click = false; out.postback = false; }
  if (out.type === 'ad' && out.enabled && !out.url) fail(400, 'BAD_URL');
  return out;
}
H_.adminTaskCreate = (c) => tx(() => {
  const type = c.body.type; if (!['ad', 'sub'].includes(type)) fail(400, 'BAD_TASK');
  let channel = '';
  if (type === 'sub') {
    channel = String(c.body.channel || '').trim(); if (!CHANNEL_RE.test(channel)) fail(400, 'BAD_CHANNEL');
    if (Object.values(TASKS).some((d) => d.type === 'sub' && d.channel.toLowerCase() === channel.toLowerCase())) fail(409, 'DUPLICATE');
    if (!isHttps(String(c.body.url || '').trim())) fail(400, 'BAD_URL');
  }
  const base = { type, reward: 0, rewardType: 'stars', url: '', channel, click: false, postback: false, enabled: true };
  if (c.body.reward_m === undefined) fail(400, 'BAD_AMOUNT');
  const d = readTaskFields(c.body, base);
  const used = [...Object.keys(TASKS), ...q('SELECT DISTINCT task FROM task_limits WHERE task LIKE ?').all(type + '%').map((r) => r.task)];
  const key = type + (Math.max(0, ...used.filter((k) => k.startsWith(type)).map((k) => +k.slice(type.length) || 0)) + 1); // never reuse an old key (its history stays separate)
  TASKS[key] = d; persistTask(key);
  logAdmin('task_create', key, `${type} ${d.rewardType === 'coins' ? d.reward + ' coins' : d.reward / 1000 + ' ⭐'} ${d.channel || d.url}`.slice(0, 200));
  return { ok: true, key };
});
H_.adminTaskUpdate = (c) => tx(() => {
  const key = c.params.key; const cur = TASKS[key]; if (!cur) fail(404, 'NOT_FOUND');
  if (cur.channel && c.body.channel !== undefined && String(c.body.channel).trim() !== cur.channel) fail(400, 'CHANNEL_LOCKED'); // changing it would make the re-check punish everyone who joined the old channel
  const d = readTaskFields(c.body, cur); TASKS[key] = d; persistTask(key);
  logAdmin('task_update', key, JSON.stringify({ reward: d.rewardType === 'coins' ? d.reward + ' coins' : d.reward / 1000, url: d.url, enabled: d.enabled, click: d.click, postback: d.postback }).slice(0, 200));
  return { ok: true };
});
H_.adminTaskDelete = (c) => tx(() => {
  const key = c.params.key; if (!TASKS[key]) fail(404, 'NOT_FOUND');
  delete TASKS[key]; q('DELETE FROM tasks WHERE key=?').run(key); q('DELETE FROM sessions WHERE task=? AND used=0').run(key);
  logAdmin('task_delete', key); return { ok: true };
});
H_.adminSettings = (c) => {
  if (c.body.spinAdUrl !== undefined) { const u = String(c.body.spinAdUrl).trim(); if (u && !isHttps(u)) fail(400, 'BAD_URL'); SETTINGS.spinAdUrl = u; saveSetting('spinAdUrl', u); }
  for (const k of ['payUrlStars', 'payUrlGift']) {
    if (c.body[k] === undefined) continue; const u = String(c.body[k]).trim() || '{profile}';
    if (!/^(https:\/\/t\.me\/|tg:\/\/)/i.test(u.replace('{profile}', 'https://t.me/x'))) fail(400, 'BAD_URL'); SETTINGS[k] = u; saveSetting(k, u);
  }
  if (c.body.perTaskLimit !== undefined) { const n = c.body.perTaskLimit; if (!Number.isSafeInteger(n) || n < 1 || n > 1000) fail(400, 'BAD_AMOUNT'); RULES.perTaskLimit = n; saveSetting('perTaskLimit', n); }
  logAdmin('settings', null, JSON.stringify({ spinAdUrl: SETTINGS.spinAdUrl, perTaskLimit: RULES.perTaskLimit }).slice(0, 200));
  return { ok: true };
};
let botId = 0;
H_.adminCheckChannel = async (c) => {
  const channel = String(c.body.channel || '').trim(); if (!CHANNEL_RE.test(channel)) fail(400, 'BAD_CHANNEL');
  if (!cfg.botToken) fail(503, 'NOT_CONFIGURED');
  try {
    if (!botId) { const me = await tg('getMe'); if (me.ok) botId = me.result.id; }
    const chat = await tg('getChat', { chat_id: channel });
    if (!chat.ok) return { ok: false, error: chat.description || 'chat not found' };
    const me = await tg('getChatMember', { chat_id: channel, user_id: botId });
    const status = me.ok ? me.result.status : 'unknown';
    const cnt = await tg('getChatMemberCount', { chat_id: channel });
    return { ok: true, title: chat.result.title || '', type: chat.result.type, botStatus: status, botIsAdmin: ['administrator', 'creator'].includes(status), members: cnt.ok ? cnt.result : null };
  } catch { fail(502, 'TG_ERROR'); }
};
H_.adminBackup = () => backupSvc.status();
H_.adminBackupRun = async () => { const r = await backupSvc.run(true); logAdmin('backup_run', '', r.ok ? 'ok' : r.error); return { ...r, status: backupSvc.status() }; };
H_.adminBackupVerify = async () => { const r = await backupSvc.verify(); logAdmin('backup_verify', '', r.ok ? 'ok' : r.error); return r; };
H_.adminBackupDownload = (c) => {
  const buf = backupSvc.exportDb(); logAdmin('backup_download', '', `${buf.length} bytes`);
  c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="karem-${new Date().toISOString().slice(0, 10)}.db"`, 'Cache-Control': 'no-store', ...SEC_HEADERS });
  c.res.end(buf);
  return RAW;
};
H_.adminLottery = () => {
  const ev = ensureEvent();
  const per = q('SELECT tier, COUNT(*) users, COALESCE(SUM(count),0) pieces, COALESCE(SUM(CASE WHEN count>=? THEN 1 ELSE 0 END),0) holders FROM lottery_pieces WHERE event_id=? GROUP BY tier').all(LOTTERY.perTicket, ev.id);
  const boxes = q('SELECT COUNT(*) n, COUNT(DISTINCT user_id) users, COALESCE(SUM(cost),0) coins FROM lottery_boxes WHERE event_id=?').get(ev.id);
  const history = q("SELECT id, start_at, end_at, drawn_at, seed, seed_hash, result FROM lottery_events WHERE status='drawn' ORDER BY id DESC LIMIT 10").all().map((e) => {
    let r = {}; try { r = JSON.parse(e.result || '{}'); } catch { /* ignore */ }
    return { id: e.id, start_at: e.start_at, end_at: e.end_at, drawn_at: e.drawn_at, seed: e.seed, seed_hash: e.seed_hash,
      spent: r.spent || 0, tiers: Object.fromEntries(TIERS.map((k) => [k, { candidates: 0, prize: 0, winner: null, ...((r.tiers || {})[k] || {}) }])), consolation: r.consolation || null };
  });
  return {
    config: LOTTERY, defaults: LOTTERY_DEFAULT,
    event: { id: ev.id, start_at: ev.start_at, end_at: ev.end_at, seed_hash: ev.seed_hash, boxes, prizesNow: Object.fromEntries(TIERS.map((k) => [k, tierPrize(LOTTERY, boxes.coins, k)])), tiers: Object.fromEntries(TIERS.map((k) => [k, per.find((r) => r.tier === k) || { users: 0, pieces: 0, holders: 0 }])) },
    history, coinsInCirculation: q('SELECT COALESCE(SUM(coins),0) s FROM users').get().s,
  };
};
H_.adminLotteryConfig = (c) => {
  const b = c.body; const m = (k) => ({ ...LOTTERY[k], ...((b[k] && typeof b[k] === 'object') ? b[k] : {}) });
  const v = sanitizeLottery({ ...LOTTERY, ...b, chances: m('chances'), prizes: m('prizes'), consolation: m('consolation'), convert: m('convert') });
  Object.assign(LOTTERY, v); saveSetting('lottery', JSON.stringify(LOTTERY));
  logAdmin('lottery_config', null, JSON.stringify(LOTTERY).slice(0, 200));
  return { ok: true, config: LOTTERY };
};
H_.adminLotteryDraw = (c) => {
  if (c.body.confirm !== true) fail(400, 'BAD_AMOUNT');
  const ev = ensureEvent(); const notes = drawDue(true); notes.forEach(([id, text]) => notify(id, text));
  logAdmin('lottery_draw_now', String(ev.id), `${notes.length} notifications`);
  return { ok: true, drawn: ev.id, notifications: notes.length };
};
// ───────────────────────── admin: wheel of fortune ─────────────────────────
H_.adminWheel = () => {
  const total = WHEEL.reduce((a, x) => a + x.w, 0) || 1;
  const ev = (t) => WHEEL.reduce((a, x) => a + (x.t === t ? x.a * x.w : 0), 0) / total;
  const log7 = q('SELECT idx, t, COUNT(*) n, COALESCE(SUM(a),0) s FROM spin_log WHERE at>? GROUP BY idx, t').all(now() - 7 * 24 * H);
  return {
    slices: WHEEL, spinEarn: RULES.spinEarn, spinAdUrl: SETTINGS.spinAdUrl, coinValue: LOTTERY.coinValue,
    ev: { stars: ev('stars'), coins: ev('coins'), starsEquiv: ev('stars') + ev('coins') * LOTTERY.coinValue, noneChance: WHEEL.filter((x) => x.t === 'none').reduce((a, x) => a + x.w, 0) / total },
    spins7d: log7.reduce((a, r) => a + r.n, 0), paid7d: { stars: log7.filter((r) => r.t === 'stars').reduce((a, r) => a + r.s, 0), coins: log7.filter((r) => r.t === 'coins').reduce((a, r) => a + r.s, 0) },
    pendingPrizes: q("SELECT COUNT(*) c FROM sessions WHERE task='spin_claim' AND used=0").get().c,
  };
};
H_.adminWheelSave = (c) => tx(() => {
  const w = sanitizeWheel(c.body.slices); WHEEL.length = 0; WHEEL.push(...w); saveSetting('wheel', JSON.stringify(w));
  if (c.body.spinEarn !== undefined) { const n = c.body.spinEarn; if (!Number.isSafeInteger(n) || n < 1000 || n > 1e8) fail(400, 'BAD_AMOUNT'); RULES.spinEarn = n; saveSetting('spinEarn', n); }
  logAdmin('wheel_config', null, JSON.stringify({ slices: w.length, spinEarn: RULES.spinEarn }).slice(0, 200));
  return { ok: true };
});
H_.adminLog = () => ({ items: q('SELECT * FROM admin_log ORDER BY id DESC LIMIT 100').all() });
const adminUserId = (c) => { const id = +c.params.id; if (!getUser(id)) fail(404, 'NOT_FOUND'); return id; };
H_.adminFlag = (c) => { const id = adminUserId(c); const f = c.body.flagged ? 1 : 0; q('UPDATE users SET flagged=? WHERE id=?').run(f, id); logAdmin(f ? 'flag' : 'unflag', String(id)); return { ok: true, flagged: f }; };
H_.adminResetDevices = (c) => { const id = adminUserId(c); const r = q('DELETE FROM devices WHERE user_id=?').run(id); logAdmin('reset_devices', String(id), `${r.changes} rows`); return { ok: true, removed: Number(r.changes) }; };
H_.adminAdjust = (c) => tx(() => {
  const id = adminUserId(c); const amt = c.body.amount_m; const reason = String(c.body.reason || '').trim().slice(0, 200);
  if (!Number.isSafeInteger(amt) || amt === 0 || Math.abs(amt) > 1e9) fail(400, 'BAD_AMOUNT');
  if (!reason) fail(400, 'REASON_REQUIRED');
  const u = getUser(id);
  if (amt > 0) credit(id, 'admin_adjust', amt, reason);
  else {
    if (-amt > u.balance) fail(400, 'INSUFFICIENT');
    q('UPDATE users SET balance=balance-? WHERE id=?').run(-amt, id);
    q('INSERT INTO ledger(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)').run(id, 'admin_adjust', amt, reason, now());
  }
  logAdmin('adjust', String(id), `${amt / 1000} ⭐ — ${reason}`);
  return { ok: true, balance: getUser(id).balance };
});
H_.adminMessage = async (c) => {
  const id = adminUserId(c); const text = String(c.body.text || '').trim().slice(0, 500);
  if (!text) fail(400, 'BAD_AMOUNT');
  if (!cfg.botToken) fail(503, 'NOT_CONFIGURED');
  const r = await tg('sendMessage', { chat_id: id, text }).catch(() => null);
  logAdmin('message', String(id), text.slice(0, 80));
  return { ok: !!(r && r.ok) };
};

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
  'X-Robots-Tag': 'noindex',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'none'",
};

const RAW = Symbol('raw'); // handler already wrote the response itself
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
  ['POST', /^\/api\/lottery\/unlock$/, H_.lotteryUnlock, 'user'],
  ['POST', /^\/api\/lottery\/open$/, H_.lotteryOpen, 'user'],
  ['POST', /^\/api\/lottery\/convert$/, H_.lotteryConvert, 'user'],
  ['POST', /^\/api\/daily$/, H_.daily, 'user'],
  ['GET', /^\/api\/captcha$/, H_.captchaGet, 'user'],
  ['POST', /^\/api\/captcha\/verify$/, H_.captchaVerify, 'user'],
  ['POST', /^\/api\/spin$/, H_.spin, 'user'],
  ['POST', /^\/api\/spin\/claim\/start$/, H_.spinClaimStart, 'user'],
  ['POST', /^\/api\/spin\/claim$/, H_.spinClaim, 'user'],
  ['GET', /^\/api\/gifts$/, H_.gifts, 'user'],
  ['POST', /^\/api\/withdraw$/, H_.withdraw, 'user'],
  ['GET', /^\/api\/league$/, H_.league, 'user'],
  ['GET', /^\/api\/postback$/, H_.postback, 'none'],
  ['GET', /^\/api\/admin\/stats$/, H_.adminStats, 'admin'],
  ['GET', /^\/api\/admin\/users$/, H_.adminUsers, 'admin'],
  ['GET', /^\/api\/admin\/users\/(?<id>\d+)$/, H_.adminUser, 'admin'],
  ['POST', /^\/api\/admin\/users\/(?<id>\d+)\/flag$/, H_.adminFlag, 'admin'],
  ['POST', /^\/api\/admin\/users\/(?<id>\d+)\/reset-devices$/, H_.adminResetDevices, 'admin'],
  ['POST', /^\/api\/admin\/users\/(?<id>\d+)\/adjust$/, H_.adminAdjust, 'admin'],
  ['POST', /^\/api\/admin\/users\/(?<id>\d+)\/message$/, H_.adminMessage, 'admin'],
  ['GET', /^\/api\/admin\/tasks$/, H_.adminTasks, 'admin'],
  ['POST', /^\/api\/admin\/tasks$/, H_.adminTaskCreate, 'admin'],
  ['POST', /^\/api\/admin\/tasks\/(?<key>[a-z]+\d+)$/, H_.adminTaskUpdate, 'admin'],
  ['POST', /^\/api\/admin\/tasks\/(?<key>[a-z]+\d+)\/delete$/, H_.adminTaskDelete, 'admin'],
  ['POST', /^\/api\/admin\/settings$/, H_.adminSettings, 'admin'],
  ['POST', /^\/api\/admin\/check-channel$/, H_.adminCheckChannel, 'admin'],
  ['GET', /^\/api\/admin\/activity$/, H_.adminActivity, 'admin'],
  ['GET', /^\/api\/admin\/log$/, H_.adminLog, 'admin'],
  ['GET', /^\/api\/admin\/wheel$/, H_.adminWheel, 'admin'],
  ['POST', /^\/api\/admin\/wheel$/, H_.adminWheelSave, 'admin'],
  ['GET', /^\/api\/admin\/lottery$/, H_.adminLottery, 'admin'],
  ['POST', /^\/api\/admin\/lottery\/config$/, H_.adminLotteryConfig, 'admin'],
  ['POST', /^\/api\/admin\/lottery\/draw-now$/, H_.adminLotteryDraw, 'admin'],
  ['GET', /^\/api\/admin\/backup$/, H_.adminBackup, 'admin'],
  ['POST', /^\/api\/admin\/backup\/run$/, H_.adminBackupRun, 'admin'],
  ['POST', /^\/api\/admin\/backup\/verify$/, H_.adminBackupVerify, 'admin'],
  ['GET', /^\/api\/admin\/backup\/download$/, H_.adminBackupDownload, 'admin'],
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
    if (cfg.adminIps.length && !cfg.adminIps.includes(ip)) fail(403, 'FORBIDDEN');
    if (!cfg.adminToken || !safeEq(String(req.headers['x-admin-token'] || ''), cfg.adminToken)) {
      if (limited(`admfail:${ip}`, 10, 10 * 60000)) fail(429, 'RATE_LIMIT'); // max 10 wrong tokens / 10 min / IP
      fail(401, 'UNAUTHORIZED');
    }
  } else if (auth === 'user') {
    const dev = String(req.headers['x-device'] || '').slice(0, 100);
    const fp = String(req.headers['x-fp'] || '').slice(0, 200);
    ctx.user = authenticate(req, { ip, deviceHash: dev ? sha(dev) : '', fpHash: fp ? sha('fp:' + fp) : '' });
    if (method === 'POST' && limited(`u:${ctx.user.id}`, num(env.USER_RATE_PER_MIN, 40), 60000)) fail(429, 'RATE_LIMIT');
  }
  const out = await handler(ctx);
  if (method === 'POST') backupSvc.request(); // any write → schedule a (debounced) backup
  return out;
}

function redirectClick(req, res, url) {
  const ip = clientIp(req);
  const sid = url.pathname.slice(3);
  const s = /^[0-9a-f]{32}$/.test(sid) && !limited(`r:${ip}`, 60, 60000) ? q('SELECT * FROM sessions WHERE id=?').get(sid) : null;
  const def = s && TASKS[s.task];
  if (!s || !def || !def.click || !def.url) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
  // a click only counts if it happens a moment after Play (and before the session is consumed)
  if (!s.used && now() - s.started_at >= 1500) q('UPDATE sessions SET clicked=1 WHERE id=?').run(sid);
  res.writeHead(302, { Location: fillUrl(def.url, sid, s.user_id), 'Cache-Control': 'no-store', ...SEC_HEADERS });
  return res.end();
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(url.pathname);
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
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
    if (url.pathname.startsWith('/api/')) { const out = await handleApi(req, res, url); return out === RAW ? undefined : send(res, 200, out); }
    if (url.pathname.startsWith('/r/') && req.method === 'GET') return redirectClick(req, res, url);
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
  if (m.forward_origin && m.forward_origin.chat && m.forward_origin.chat.type === 'channel') { // helper to find BACKUP_CHAT_ID
    await tg('sendMessage', { chat_id: m.chat.id, text: `Channel ID / آیدی کانال:\n${m.forward_origin.chat.id}` }); return;
  }
  if (!m.text.startsWith('/start')) return;
  const payload = (m.text.split(/\s+/)[1] || '');
  const rm = /^ref_(\d{1,15})$/.exec(payload);
  if (rm && +rm[1] !== m.from.id && !getUser(m.from.id)) {
    q('INSERT OR REPLACE INTO pending_refs(user_id,referrer_id,created_at) VALUES(?,?,?)').run(m.from.id, +rm[1], now());
  }
  const fa = (m.from.language_code || '').startsWith('fa');
  const body = { chat_id: m.chat.id, text: fa ? '⭐ به CAReM خوش آمدید! با دکمه زیر برنامه را باز کنید.' : '⭐ Welcome to CAReM! Tap the button below to open the app.' };
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
      if (def.type !== 'sub' || !def.channel || !def.enabled) continue;
      const rows = q('SELECT user_id, paid, paid_coins FROM task_limits WHERE task=? AND done=1 AND last_check<=? ORDER BY last_check ASC LIMIT 100').all(key, now() - RULES.subRecheckSec * 1000);
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
            if (r.paid_coins) { // coin reward: take back whatever coins are still there (coins can't go negative)
              const take = Math.min(getUser(r.user_id).coins, amount);
              if (take > 0) { q('UPDATE users SET coins=coins-? WHERE id=?').run(take, r.user_id); q('INSERT INTO coin_ledger(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)').run(r.user_id, 'sub_penalty', -take, key, now()); }
            } else penalize(r.user_id, amount, key);
            return true;
          });
          if (done) { log('sub penalty', r.user_id, key, amount); notify(r.user_id, r.paid_coins ? `⚠️ You left the channel, so ${amount} 🪙 was deducted. / کانال را ترک کردید و ${amount} 🪙 کسر شد.` : `⚠️ You left the channel, so ${amount / 1000} ⭐ was deducted. / کانال را ترک کردید و ${amount / 1000} ⭐ کسر شد.`); }
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
    q("DELETE FROM sessions WHERE started_at<? AND task!='spin_claim'").run(now() - 24 * H);
    q("DELETE FROM sessions WHERE started_at<? AND task='spin_claim'").run(now() - 7 * 24 * H);
    q('DELETE FROM pending_refs WHERE created_at<?').run(now() - 7 * 24 * H);
    awardLastWeek();
  } catch (e) { log('maintenance error', e.message); }
}

server.listen(cfg.port, async () => {
  log(`CAReM listening on :${cfg.port} (devMode=${cfg.devMode})`);
  maintenance();
  backupSvc.start();
  runLottery(); setInterval(runLottery, 60000).unref(); // closes + draws an ended lottery event
  setInterval(maintenance, H).unref();
  setInterval(recheckSubs, Math.max(1, Math.min(300, RULES.subRecheckSec)) * 1000).unref();
  if (cfg.botToken) {
    try {
      if (!cfg.botUsername) { const me = await tg('getMe'); if (me.ok) cfg.botUsername = me.result.username; }
    } catch (e) { log('getMe failed:', e.message); }
    if (cfg.botPolling) pollBot();
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true; stopping = true;
  const hard = setTimeout(() => process.exit(0), 15000); hard.unref();
  server.close(); // stop accepting new connections
  try { await backupSvc.flush(10000); } catch (e) { log('final backup failed', e.message); } // last snapshot before the disk disappears
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => log('unhandledRejection', e));
