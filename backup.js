'use strict';
/**
 * Telegram-based backup / restore for the SQLite database (zero dependencies).
 *
 * Why: free hosts such as Render wipe the disk on every restart / redeploy.
 * What: the bot uploads a compressed (optionally AES-256-GCM encrypted) snapshot of the database to a
 *       PRIVATE Telegram channel and pins it. On startup, if there is no local database file, the pinned
 *       snapshot is downloaded and restored before the server opens the database.
 *
 * Safety rules:
 *  - If a backup exists but cannot be read (network / wrong passphrase / bad file) we REFUSE to start with an
 *    empty database, because the first new backup would overwrite the good one.
 *  - Snapshots are made with VACUUM INTO (consistent, WAL-safe) and verified (integrity_check) before restore.
 *  - We keep the last 2 backup messages in the channel, older ones are deleted.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

class BackupError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

const MAGIC = Buffer.from('KBK1');
const TG_FILE_LIMIT = 19 * 1024 * 1024; // Telegram bots can download files up to 20 MB
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ───────────── pack / unpack ─────────────
function pack(raw, passphrase) {
  const gz = zlib.gzipSync(raw, { level: 9 });
  if (!passphrase) return Buffer.concat([MAGIC, Buffer.from([0]), gz]);
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(gz), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from([1]), salt, iv, c.getAuthTag(), enc]);
}
// A plain (unencrypted) backup can always be read, even if a passphrase is configured later.
function unpack(buf, passphrase) {
  if (buf.length < 6 || !buf.subarray(0, 4).equals(MAGIC)) throw new BackupError('BAD_FORMAT', 'not a CAReM backup file');
  const mode = buf[4];
  try {
    if (mode === 0) return zlib.gunzipSync(buf.subarray(5));
    if (mode === 1) {
      if (!passphrase) throw new BackupError('PASSPHRASE_REQUIRED', 'this backup is encrypted but BACKUP_PASSPHRASE is not set');
      const salt = buf.subarray(5, 21); const iv = buf.subarray(21, 33); const tag = buf.subarray(33, 49); const data = buf.subarray(49);
      const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
      d.setAuthTag(tag);
      let gz;
      try { gz = Buffer.concat([d.update(data), d.final()]); }
      catch { throw new BackupError('WRONG_PASSPHRASE', 'BACKUP_PASSPHRASE does not match the one used to create the backup'); }
      return zlib.gunzipSync(gz);
    }
  } catch (e) { if (e instanceof BackupError) throw e; throw new BackupError('CORRUPT', e.message); }
  throw new BackupError('BAD_FORMAT', 'unknown backup version');
}

// ───────────── sqlite helpers ─────────────
function inspectDb(file) {
  let d;
  try {
    d = new DatabaseSync(file);
    const ic = d.prepare('PRAGMA integrity_check').get();
    const okRes = ic && Object.values(ic)[0] === 'ok';
    let users = null;
    try { users = d.prepare('SELECT COUNT(*) c FROM users').get().c; } catch { /* table may not exist */ }
    return { ok: okRes, users };
  } catch (e) { return { ok: false, users: null, error: e.message }; }
  finally { try { d && d.close(); } catch { /* ignore */ } }
}

// ───────────── telegram helpers ─────────────
function makeTg(o) {
  const base = `${o.api}/bot${o.token}`;
  const json = async (method, body, ms = 30000) => {
    let res;
    try { res = await fetch(`${base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(ms) }); }
    catch (e) { throw new BackupError('NETWORK', e.message); }
    try { return await res.json(); } catch { throw new BackupError('NETWORK', `bad response (${res.status})`); }
  };
  async function upload(buf, filename, caption) {
    const fd = new FormData();
    fd.append('chat_id', String(o.chat)); fd.append('caption', caption); fd.append('disable_notification', 'true');
    fd.append('document', new Blob([buf]), filename);
    let res;
    try { res = await fetch(`${base}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) }); }
    catch (e) { throw new BackupError('NETWORK', e.message); }
    try { return await res.json(); } catch { throw new BackupError('NETWORK', `bad response (${res.status})`); }
  }
  // → null when the channel has no pinned backup, otherwise { fileId, messageId, date, caption }
  async function latest() {
    const r = await json('getChat', { chat_id: o.chat });
    if (!r.ok) throw new BackupError('TG_ERROR', `${r.description || 'getChat failed'} — is BACKUP_CHAT_ID right and is the bot an admin of that channel?`);
    const pm = r.result && r.result.pinned_message;
    if (!pm || !pm.document) return null;
    return { fileId: pm.document.file_id, messageId: pm.message_id, date: (pm.date || 0) * 1000, caption: pm.caption || '' };
  }
  async function download(fileId) {
    const g = await json('getFile', { file_id: fileId });
    if (!g.ok) throw new BackupError('TG_ERROR', g.description || 'getFile failed');
    let res;
    try { res = await fetch(`${o.api}/file/bot${o.token}/${g.result.file_path}`, { signal: AbortSignal.timeout(120000) }); }
    catch (e) { throw new BackupError('NETWORK', e.message); }
    if (!res.ok) throw new BackupError('NETWORK', `download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  return { json, upload, latest, download };
}

async function retry(fn, tries, log) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!(e instanceof BackupError) || !['NETWORK', 'TG_ERROR'].includes(e.code)) throw e;
      if (log) log(`backup: attempt ${i}/${tries} failed (${e.message})`);
      if (i < tries) await sleep(Math.min(8000, 1500 * i));
    }
  }
  throw last;
}

/** Download + decrypt + verify the pinned backup into `outFile`. → null if there is none. */
async function fetchBackupTo(tgc, passphrase, outFile) {
  const l = await tgc.latest();
  if (!l) return null;
  const packed = await tgc.download(l.fileId);
  const raw = unpack(packed, passphrase);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, raw);
  const chk = inspectDb(outFile);
  if (!chk.ok) { fs.rmSync(outFile, { force: true }); throw new BackupError('CORRUPT', 'the downloaded backup failed the database integrity check'); }
  return { ...l, bytes: packed.length, users: chk.users };
}

/**
 * Called BEFORE the database is opened. If the local database file is missing (fresh / wiped disk)
 * the latest pinned backup is restored. Throws BackupError when a backup exists but can't be used.
 */
async function restoreIfNeeded(o) {
  const log = o.log || console.log;
  const enabled = !!(o.token && o.chat);
  if (!enabled) return { status: 'disabled' };
  if (fs.existsSync(o.dbPath) && fs.statSync(o.dbPath).size > 0) return { status: 'present' };
  const tgc = makeTg(o);
  const tmp = `${o.dbPath}.restoring`;
  const got = await retry(() => fetchBackupTo(tgc, o.passphrase, tmp), 4, log);
  if (!got) { log('backup: no backup found in the channel — starting with a new database'); return { status: 'none' }; }
  for (const s of ['-wal', '-shm']) fs.rmSync(o.dbPath + s, { force: true });
  fs.renameSync(tmp, o.dbPath);
  log(`backup: RESTORED database from Telegram (${got.users ?? '?'} users, backup made ${new Date(got.date).toISOString()})`);
  return { status: 'restored', users: got.users, at: got.date, messageId: got.messageId };
}

/** Running service: periodic + on-demand backups of an open DatabaseSync. */
function createService(o) {
  const log = o.log || console.log;
  const enabled = !!(o.token && o.chat);
  const tgc = enabled ? makeTg(o) : null;
  const dir = path.dirname(o.dbPath);
  const minGapMs = (o.minGapSec ?? 60) * 1000;
  const everyMs = (o.everySec ?? 300) * 1000;
  const st = {
    enabled, encrypted: !!o.passphrase, uploads: 0, lastOkAt: 0, lastAttemptAt: 0, lastError: '', lastBytes: 0, lastUsers: null,
    restored: o.restored || { status: enabled ? 'unknown' : 'disabled' },
  };
  let ids = o.initialMessageId ? [o.initialMessageId] : [];
  let lastHash = ''; let running = null; let timer = null; let interval = null; let stopped = false;

  function snapshot() {
    const tmp = path.join(dir, `.snap-${process.pid}-${Date.now()}.db`);
    o.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    try { return fs.readFileSync(tmp); } finally { fs.rmSync(tmp, { force: true }); }
  }

  async function runOnce(force) {
    st.lastAttemptAt = Date.now();
    try {
      const raw = snapshot();
      const hash = sha256(raw);
      if (!force && hash === lastHash) return { ok: true, skipped: true };
      const packed = pack(raw, o.passphrase);
      if (packed.length > TG_FILE_LIMIT) throw new BackupError('TOO_BIG', `backup is ${(packed.length / 1048576).toFixed(1)} MB, Telegram bots can restore at most 20 MB`);
      const caption = `CAReM backup\n${new Date().toISOString()}\nsha256:${hash.slice(0, 16)}\n${raw.length} bytes${o.passphrase ? ' · encrypted' : ''}`;
      const r = await tgc.upload(packed, `karem-${new Date().toISOString().replace(/[:.]/g, '-')}.kbk`, caption);
      if (!r.ok) throw new BackupError('TG_ERROR', `${r.description || 'sendDocument failed'} — the bot must be an admin of the channel with permission to post messages`);
      const msgId = r.result.message_id;
      ids.push(msgId);
      const pin = await tgc.json('pinChatMessage', { chat_id: o.chat, message_id: msgId, disable_notification: true });
      if (!pin.ok) throw new BackupError('PIN_FAILED', `${pin.description || 'pinChatMessage failed'} — give the bot the "Pin messages" permission`);
      lastHash = hash;
      st.uploads++; st.lastOkAt = Date.now(); st.lastError = ''; st.lastBytes = packed.length;
      try { st.lastUsers = inspectUsers(raw); } catch { /* ignore */ }
      while (ids.length > 2) { const old = ids.shift(); try { await tgc.json('deleteMessage', { chat_id: o.chat, message_id: old }); } catch { /* ignore */ } }
      return { ok: true, bytes: packed.length };
    } catch (e) {
      st.lastError = e instanceof BackupError ? e.message : `ERROR: ${e.message}`;
      log('backup failed:', st.lastError);
      return { ok: false, error: st.lastError };
    }
  }
  function inspectUsers(raw) {
    const f = path.join(dir, `.chk-${process.pid}-${Date.now()}.db`);
    fs.writeFileSync(f, raw);
    try { return inspectDb(f).users; } finally { fs.rmSync(f, { force: true }); }
  }

  /** Run a backup now (serialised: concurrent callers share the running one). */
  function run(force = false) {
    if (!enabled) return Promise.resolve({ ok: false, error: 'DISABLED' });
    if (running) return running;
    running = runOnce(force).finally(() => { running = null; });
    return running;
  }
  /** Ask for a backup soon (debounced; at most one per minGap). Cheap to call after every change. */
  function request() {
    if (!enabled || stopped || timer) return;
    const wait = Math.max(2000, st.lastAttemptAt + minGapMs - Date.now());
    timer = setTimeout(() => { timer = null; run(); }, wait);
    timer.unref();
  }
  function start() {
    if (!enabled) { log('backup: disabled (set BACKUP_CHAT_ID to protect your data on free hosting)'); return; }
    log(`backup: enabled → chat ${o.chat}${o.passphrase ? ' (encrypted)' : ' (NOT encrypted — set BACKUP_PASSPHRASE)'}`);
    setTimeout(() => run(true), 5000).unref(); // first backup right after boot proves the setup works
    interval = setInterval(() => run(), everyMs); interval.unref();
  }
  /** Final backup on shutdown (SIGTERM). Never takes longer than timeoutMs. */
  async function flush(timeoutMs = 10000) {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (interval) clearInterval(interval);
    if (!enabled) return;
    await Promise.race([(async () => { if (running) await running; await run(); })(), sleep(timeoutMs)]);
  }
  /** Download the pinned backup and verify it (proves restore would work). */
  async function verify() {
    if (!enabled) return { ok: false, error: 'DISABLED' };
    const tmp = path.join(dir, `.verify-${process.pid}-${Date.now()}.db`);
    try {
      const got = await fetchBackupTo(tgc, o.passphrase, tmp);
      if (!got) return { ok: false, error: 'NO_BACKUP' };
      return { ok: true, users: got.users, bytes: got.bytes, madeAt: got.date, ageSec: Math.round((Date.now() - got.date) / 1000), messageId: got.messageId };
    } catch (e) { return { ok: false, error: e instanceof BackupError ? e.message : e.message }; }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  const exportDb = () => snapshot();
  const status = () => ({ ...st, running: !!running, queued: !!timer });
  return { enabled, run, request, start, flush, verify, exportDb, status };
}

module.exports = { pack, unpack, restoreIfNeeded, createService, inspectDb, BackupError, makeTg };
