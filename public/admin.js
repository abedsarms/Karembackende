'use strict';
/* CAReM admin panel. All data comes from /api/admin/* (X-Admin-Token). Untrusted strings (user names…)
   are ONLY ever inserted with textContent, never as HTML. */
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = 'karem_admin_token';
  let token = '';
  try { token = sessionStorage.getItem(KEY) || ''; } catch { /* ignore */ }

  // ───────── helpers ─────────
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
  const stars = (m) => (m / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const when = (ms) => (ms ? new Date(ms).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'short', timeStyle: 'short' }) : '—');
  const ago = (ms) => { if (!ms) return '—'; const s = Math.max(0, (Date.now() - ms) / 1000); if (s < 90) return 'همین الان'; if (s < 5400) return Math.round(s / 60) + ' دقیقه پیش'; if (s < 129600) return Math.round(s / 3600) + ' ساعت پیش'; return Math.round(s / 86400) + ' روز پیش'; };
  const KIND = { ad: 'تبلیغ', sub: 'عضویت کانال', daily: 'پاداش روزانه', ref_bonus: 'بونوس رفرال', ref_commission: 'کمیسیون رفرال', captcha: 'کپچا', spin: 'گردونه', league_prize: 'جایزه لیگ', withdraw: 'برداشت', refund: 'بازگشت برداشت', sub_penalty: 'جریمه ترک کانال', debt_repay: 'پرداخت بدهی', admin_adjust: 'اصلاح دستی', lottery_prize: 'جایزه قرعه‌کشی', lottery_consolation: 'جایزه تسلیت قرعه‌کشی' };
  const ERR = { UNAUTHORIZED: 'توکن نادرست است.', FORBIDDEN: 'IP شما مجاز نیست.', RATE_LIMIT: 'تلاش بیش از حد؛ چند دقیقه بعد دوباره امتحان کنید.', NOT_FOUND: 'پیدا نشد.', ALREADY_DONE: 'قبلاً تعیین تکلیف شده.', BAD_AMOUNT: 'مقدار نامعتبر است.', INSUFFICIENT: 'موجودی کاربر کافی نیست.', REASON_REQUIRED: 'دلیل لازم است.', NOT_CONFIGURED: 'بات تنظیم نشده.', BAD_URL: 'لینک باید معتبر باشد و با https:// شروع شود.', BAD_CHANNEL: 'کانال باید به شکل @username یا آیدی عددی (‎-100…‎) باشد.', DUPLICATE: 'این کانال قبلاً ثبت شده است.', CHANNEL_LOCKED: 'کانال بعد از ثبت قابل تغییر نیست؛ یک تسک جدید بسازید و این یکی را غیرفعال کنید.', NO_POSTBACK_SECRET: 'برای تایید با پست‌بک ابتدا ADS_POSTBACK_SECRET را در .env تنظیم کنید.', BAD_TASK: 'نوع تسک نامعتبر است.', TG_ERROR: 'ارتباط با تلگرام ناموفق بود.', DISABLED: 'این بخش غیرفعال است.' };
  const userLabel = (u) => (u.first_name || u.username || String(u.id)) + (u.username ? ' @' + u.username : '');

  let toastT = 0;
  function toast(text, cls) { const t = $('toast'); t.textContent = text; t.className = 'toast show ' + (cls || ''); clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, 3200); }

  async function api(path, body) {
    let res;
    try { res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token }, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw new Error('خطای شبکه'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { if (!$('app').classList.contains('hidden')) logout(); }
    if (!res.ok) { const e = new Error(ERR[data.error] || data.error || 'خطا'); e.code = data.error; throw e; }
    return data;
  }
  const guard = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, 'bad'); return null; } };

  function table(headers, rows, onRow) {
    const wrap = el('div', 'tbl-wrap');
    if (!rows.length) { wrap.append(el('div', 'empty', 'موردی یافت نشد.')); return wrap; }
    const t = el('table'); const hr = el('tr'); headers.forEach((h) => hr.append(el('th', '', h))); const th = el('thead'); th.append(hr); t.append(th);
    const tb = el('tbody');
    rows.forEach((r, i) => {
      const tr = el('tr', onRow ? 'click' : ''); if (onRow) tr.addEventListener('click', () => onRow(i));
      r.forEach((c) => { const td = el('td'); if (c instanceof Node) td.append(c); else td.textContent = c === null || c === undefined ? '—' : String(c); tr.append(td); });
      tb.append(tr);
    });
    t.append(tb); wrap.append(t); return wrap;
  }
  const tag = (text, cls) => el('span', 'tag ' + (cls || ''), text);
  const num = (text, cls) => el('span', 'num ' + (cls || ''), text);
  const signed = (m) => num((m > 0 ? '+' : '') + stars(m), m > 0 ? 'pos' : m < 0 ? 'neg' : '');
  const btn = (text, cls, fn) => { const b = el('button', 'btn small ' + (cls || ''), text); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }); return b; };

  // ───────── auth ─────────
  function logout() { token = ''; try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } $('app').classList.add('hidden'); $('login').classList.remove('hidden'); $('tokenInput').value = ''; $('drawer').classList.add('hidden'); }
  async function enter() {
    try { await api('/api/admin/stats'); } catch (e) { $('loginErr').textContent = e.message; token = ''; return false; }
    try { sessionStorage.setItem(KEY, token); } catch { /* ignore */ }
    $('login').classList.add('hidden'); $('app').classList.remove('hidden'); $('loginErr').textContent = ''; loadTab(current); return true;
  }
  $('loginForm').addEventListener('submit', (e) => { e.preventDefault(); token = $('tokenInput').value.trim(); if (token) enter(); });
  $('logoutBtn').addEventListener('click', logout);
  $('refreshBtn').addEventListener('click', () => loadTab(current));

  // ───────── tabs ─────────
  let current = 'dash';
  function loadTab(name) {
    current = name;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    ({ dash: loadDash, users: () => loadUsers(0), wd: loadWd, ads: loadAds, wheel: loadWheel, lot: loadLot, act: loadAct, log: loadLog })[name]();
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) loadTab(b.dataset.tab); });

  // ───────── dashboard ─────────
  function barChart(title, days, key, fmt) {
    const box = el('div', 'card chart'); box.append(el('h3', '', title));
    const NS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 280 130'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', title);
    const max = Math.max(1, ...days.map((d) => d[key])); const bw = 280 / days.length;
    days.forEach((d, i) => {
      const h = Math.round((d[key] / max) * 95); const r = document.createElementNS(NS, 'rect');
      r.setAttribute('class', 'bar'); r.setAttribute('x', i * bw + 3); r.setAttribute('y', 105 - h); r.setAttribute('width', bw - 6); r.setAttribute('height', Math.max(h, d[key] ? 2 : 0)); r.setAttribute('rx', 3);
      const tt = document.createElementNS(NS, 'title'); tt.textContent = `${d.day}: ${fmt(d[key])}`; r.append(tt); svg.append(r);
      if (i === 0 || i === 4 || i === 8 || i === days.length - 1) { const t = document.createElementNS(NS, 'text'); t.setAttribute('x', i * bw + bw / 2); t.setAttribute('y', 122); t.setAttribute('text-anchor', 'middle'); t.textContent = d.day.slice(5); svg.append(t); }
    });
    const mx = document.createElementNS(NS, 'text'); mx.setAttribute('x', 2); mx.setAttribute('y', 9); mx.textContent = 'max ' + fmt(max); svg.append(mx);
    box.append(svg); return box;
  }
  function stat(label, value, sub, alert) { const c = el('div', 'card' + (alert ? ' alert' : '')); c.append(el('div', 'l', label), el('div', 'v num', value)); if (sub) c.append(el('div', 's', sub)); return c; }
  async function loadDash() {
    const s = await guard(() => api('/api/admin/stats')); if (!s) return;
    const cards = $('statCards'); cards.replaceChildren(
      stat('کل کاربران', s.users.toLocaleString('en-US'), `جدید ۲۴ساعت: ${s.new24h} · رفرال‌شده: ${s.referred}`),
      stat('فعال ۲۴ ساعت اخیر', String(s.active24h), `آنلاین (۱۵ دقیقه): ${s.online15m}`),
      stat('مجموع موجودی کاربران ⭐', stars(s.totalBalance), 'تعهد شما به کاربران'),
      stat('برداشت در انتظار', String(s.pendingWithdrawals.c), stars(s.pendingWithdrawals.s) + ' ⭐', s.pendingWithdrawals.c > 0),
      stat('برداشت تایید‌شده', String(s.approvedWithdrawals.c), stars(s.approvedWithdrawals.s) + ' ⭐'),
      stat('حساب‌های مشکوک', String(s.flagged), `بن‌شده: ${s.banned}`, s.flagged > 0),
      stat('بدهی (جریمه‌های معوق)', stars(s.totalDebt), '⭐'));
    const badge = $('wdBadge'); badge.textContent = s.pendingWithdrawals.c; badge.classList.toggle('hidden', !s.pendingWithdrawals.c);
    const ch = $('charts'); ch.replaceChildren(
      barChart('کاربران جدید (۱۴ روز)', s.days, 'newUsers', String), barChart('کاربران فعال روزانه', s.days, 'activeUsers', String),
      barChart('⭐ پرداخت‌شده به کاربران', s.days, 'earned', stars), barChart('⭐ درخواست‌های برداشت', s.days, 'withdrawn', stars));
    renderBackup(s.backup);
    $('kindTable').replaceChildren(table(['نوع', 'تعداد', 'مجموع ⭐'], s.byKind7d.map((r) => [KIND[r.kind] || r.kind, num(String(r.n)), signed(r.total)])));
  }

  // ───────── backup card ─────────
  function renderBackup(b) {
    const box = $('backupBox'); box.replaceChildren();
    if (!b || !b.enabled) {
      box.append(el('div', 'l', '⚠️ بکاپ خودکار فعال نیست؛ با هر ری‌استارت رایگان Render همه‌ی داده‌ها پاک می‌شود.'), el('div', 's', 'متغیر BACKUP_CHAT_ID را طبق راهنما تنظیم کنید.'));
      return;
    }
    const bad = !!b.lastError || !b.lastOkAt;
    const kv = el('div', 'kv'); const add = (k, v) => { const x = el('div'); x.append(el('b', '', k)); x.append(el('span', '', v)); kv.append(x); };
    add('وضعیت', bad ? (b.lastOkAt ? '❌ آخرین تلاش ناموفق' : '⏳ هنوز بکاپی گرفته نشده') : '✅ سالم');
    add('آخرین بکاپ موفق', ago(b.lastOkAt)); add('تعداد بکاپ‌ها از آخرین روشن شدن', String(b.uploads));
    add('حجم', b.lastBytes ? (b.lastBytes / 1024).toFixed(1) + ' KB' : '—'); add('رمزگذاری', b.encrypted ? 'بله 🔒' : 'خیر (BACKUP_PASSPHRASE پیشنهاد می‌شود)');
    add('بازیابی هنگام شروع', ({ restored: 'از بکاپ بازیابی شد ✅', none: 'بکاپی نبود (دیتابیس نو)', present: 'دیتابیس موجود بود', disabled: '—' })[b.restored && b.restored.status] || '—');
    box.append(kv);
    if (b.lastError) box.append(el('p', 'err', b.lastError));
    const row = el('div', 'row');
    row.append(
      btn('📤 همین الان بکاپ بگیر', 'primary', async () => { const r = await guard(() => api('/api/admin/backup/run', {})); if (r) { toast(r.ok ? 'بکاپ گرفته شد ✅' : (r.error || 'ناموفق'), r.ok ? '' : 'bad'); loadDash(); } }),
      btn('🔍 تست سلامت بکاپ در تلگرام', '', async () => { const r = await guard(() => api('/api/admin/backup/verify', {})); if (r) toast(r.ok ? `بکاپ قابل بازیابی است ✅ (${r.users ?? '?'} کاربر، ${ago(r.madeAt)})` : (r.error || 'ناموفق'), r.ok ? '' : 'bad'); }),
      btn('⬇️ دانلود فایل دیتابیس', '', async () => {
        try {
          const res = await fetch('/api/admin/backup/download', { headers: { 'X-Admin-Token': token } });
          if (!res.ok) throw new Error('خطا');
          const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = 'karem.db'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (e) { toast(e.message, 'bad'); }
      }));
    box.append(row);
  }

  // ───────── users ─────────
  let page = 0;
  async function loadUsers(p) {
    page = Math.max(0, p);
    const qs = new URLSearchParams({ q: $('uq').value.trim(), sort: $('usort').value, page: String(page) });
    if ($('ufl').checked) qs.set('flagged', '1'); if ($('ubn').checked) qs.set('banned', '1');
    const r = await guard(() => api('/api/admin/users?' + qs)); if (!r) return;
    const rows = r.items.map((u) => {
      const st = el('span'); if (u.banned) st.append(tag('بن', 'red')); if (u.flagged) st.append(tag('مشکوک', 'gold')); if (u.debt) st.append(tag('بدهکار', 'red'));
      return [num(String(u.id)), userLabel(u), num(stars(u.balance)), num(stars(u.earned_total)), num(String(u.refs)), ago(u.last_seen), when(u.created_at), st];
    });
    $('userTable').replaceChildren(table(['آیدی', 'کاربر', 'موجودی ⭐', 'کل درآمد ⭐', 'زیرمجموعه', 'آخرین بازدید', 'عضویت', 'وضعیت'], rows, (i) => openUser(r.items[i].id)));
    const pg = $('userPager'); const pages = Math.max(1, Math.ceil(r.total / r.per));
    pg.replaceChildren(btn('قبلی', '', async () => loadUsers(page - 1)), el('span', '', `صفحه ${page + 1} از ${pages} — ${r.total} کاربر`), btn('بعدی', '', async () => loadUsers(page + 1)));
    pg.firstChild.disabled = page === 0; pg.lastChild.disabled = page + 1 >= pages;
  }
  $('userFilters').addEventListener('submit', (e) => { e.preventDefault(); loadUsers(0); });

  // ───────── user drawer ─────────
  const drawer = $('drawer');
  $('drawerClose').addEventListener('click', () => drawer.classList.add('hidden'));
  drawer.addEventListener('click', (e) => { if (e.target === drawer) drawer.classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') drawer.classList.add('hidden'); });

  async function openUser(id) {
    const d = await guard(() => api('/api/admin/users/' + id)); if (!d) return;
    const u = d.user; $('drawerTitle').textContent = userLabel(u);
    const body = $('drawerBody'); body.replaceChildren();
    const kv = el('div', 'kv'); const add = (k, v) => { const x = el('div'); x.append(el('b', '', k)); const s = el('span'); if (v instanceof Node) s.append(v); else s.textContent = String(v); x.append(s); kv.append(x); };
    add('آیدی تلگرام', num(String(u.id))); add('موجودی ⭐', num(stars(u.balance), 'gold')); add('کل درآمد ⭐', num(stars(u.earned_total))); add('بدهی ⭐', num(stars(u.debt)));
    add('عضویت', when(u.created_at)); add('آخرین بازدید', ago(u.last_seen)); add('IP', num(u.ip || '—'));
    add('دعوت‌کننده', d.referrer ? userLabel(d.referrer) + ' (' + d.referrer.id + ')' : '—'); add('تبلیغ دیده‌شده (رفرال)', num(String(u.ref_ads))); add('وضعیت', (u.banned ? 'بن‌شده ' : '') + (u.flagged ? 'مشکوک ' : '') || 'عادی');
    body.append(kv);

    const actions = el('div', 'actions');
    actions.append(
      btn(u.banned ? 'رفع بن' : '⛔ بن کاربر', u.banned ? 'good' : 'bad', async () => { if (!u.banned && !confirm('این کاربر بن شود؟')) return; if (await guard(() => api(`/api/admin/users/${id}/ban`, { banned: !u.banned }))) { toast('انجام شد', 'good'); openUser(id); } }),
      btn(u.flagged ? 'برداشتن علامت مشکوک' : '🚩 علامت مشکوک', 'warn', async () => { if (await guard(() => api(`/api/admin/users/${id}/flag`, { flagged: !u.flagged }))) { toast('انجام شد', 'good'); openUser(id); } }),
      btn('♻️ ریست قفل دستگاه', '', async () => { if (!confirm('اطلاعات دستگاه این کاربر پاک شود؟ (برای رفع قفل اشتباهی)')) return; const r = await guard(() => api(`/api/admin/users/${id}/reset-devices`, {})); if (r) { toast(`${r.removed} رکورد پاک شد`, 'good'); openUser(id); } }));
    body.append(actions);

    // manual balance adjustment
    body.append(el('h2', '', 'اصلاح دستی موجودی'));
    const f1 = el('form', 'form-row'); const amt = el('input'); amt.type = 'number'; amt.step = '0.001'; amt.placeholder = 'مقدار ⭐ (منفی = کسر)'; amt.required = true; amt.dir = 'ltr';
    const why = el('input'); why.placeholder = 'دلیل (الزامی)'; why.required = true; why.maxLength = 200;
    const go = el('button', 'btn small primary', 'ثبت'); go.type = 'submit'; f1.append(amt, why, go);
    f1.addEventListener('submit', async (e) => { e.preventDefault(); const m = Math.round(parseFloat(amt.value) * 1000); if (!Number.isFinite(m) || m === 0) return toast('مقدار نامعتبر', 'bad'); if (!confirm(`${stars(m)} ⭐ برای این کاربر ثبت شود؟`)) return; if (await guard(() => api(`/api/admin/users/${id}/adjust`, { amount_m: m, reason: why.value }))) { toast('ثبت شد', 'good'); openUser(id); } });
    body.append(f1);

    // message via bot
    body.append(el('h2', '', 'ارسال پیام از طریق بات'));
    const f2 = el('form', 'form-row'); const msg = el('input'); msg.placeholder = 'متن پیام…'; msg.maxLength = 500; msg.required = true; const sb = el('button', 'btn small', 'ارسال'); sb.type = 'submit'; f2.append(msg, sb);
    f2.addEventListener('submit', async (e) => { e.preventDefault(); const r = await guard(() => api(`/api/admin/users/${id}/message`, { text: msg.value })); if (r) { toast(r.ok ? 'ارسال شد' : 'ارسال نشد (کاربر بات را بلاک کرده؟)', r.ok ? 'good' : 'bad'); if (r.ok) msg.value = ''; } });
    body.append(f2);

    const open = (rowsUsers) => (i) => openUser(rowsUsers[i].id);
    if (d.sameDevice.length || d.sameIp.length) {
      body.append(el('h2', '', '⚠️ حساب‌های مرتبط (هم‌دستگاه / هم‌IP)'));
      const rel = [...d.sameDevice.map((x) => ({ ...x, why: 'هم‌دستگاه' })), ...d.sameIp.filter((x) => !d.sameDevice.some((y) => y.id === x.id)).map((x) => ({ ...x, why: 'هم‌IP' }))];
      body.append(table(['آیدی', 'کاربر', 'ارتباط', 'بن'], rel.map((x) => [num(String(x.id)), userLabel(x), tag(x.why, 'gold'), x.banned ? tag('بن', 'red') : '—']), open(rel)));
    }
    body.append(el('h2', '', 'برداشت‌ها'));
    body.append(table(['#', 'مقدار ⭐', 'نوع', 'وضعیت', 'تاریخ'], d.withdrawals.map((w) => [num(String(w.id)), num(stars(w.amount)), w.type === 'gift' ? 'گیفت' : 'بالانس', w.status, when(w.created_at)])));
    body.append(el('h2', '', 'جمع تراکنش‌ها به تفکیک نوع'));
    body.append(table(['نوع', 'تعداد', 'مجموع ⭐'], d.totals.map((t) => [KIND[t.kind] || t.kind, num(String(t.n)), signed(t.total)])));
    body.append(el('h2', '', 'زیرمجموعه‌ها (' + d.referrals.length + ')'));
    body.append(table(['آیدی', 'کاربر', 'تبلیغ', 'فعال؟', 'عضویت'], d.referrals.map((r) => [num(String(r.id)), userLabel(r), num(String(r.ref_ads)), r.ref_rewarded ? tag('فعال', 'green') : '—', when(r.created_at)]), open(d.referrals)));
    body.append(el('h2', '', 'وضعیت تسک‌ها'));
    body.append(table(['تسک', 'تعداد', 'انجام شده', 'ریست', 'آخرین دریافت'], d.tasks.map((t) => [t.task, num(String(t.count)), t.done ? 'بله' : '—', t.reset_at ? when(t.reset_at) : '—', when(t.last_claim_at)])));
    body.append(el('h2', '', 'دستگاه‌ها'));
    body.append(table(['شناسه دستگاه', 'اثرانگشت', 'IP', 'اولین دیده‌شدن'], d.devices.map((x) => [num(x.device || '—'), num(x.fp || '—'), num(x.ip || '—'), when(x.first_seen)])));
    body.append(el('h2', '', 'آخرین تراکنش‌ها'));
    const lw = table(['زمان', 'نوع', 'مقدار ⭐', 'توضیح'], d.ledger.map((l) => [when(l.created_at), KIND[l.kind] || l.kind, signed(l.amount), l.ref || '—'])); lw.classList.add('mini'); body.append(lw);
    drawer.classList.remove('hidden');
  }

  // ───────── withdrawals ─────────
  async function loadWd() {
    const st = $('wdStatus').value; const r = await guard(() => api('/api/admin/withdrawals?status=' + st)); if (!r) return;
    const rows = r.items.map((w) => {
      const acts = el('span');
      if (w.status === 'pending') {
        acts.append(
          btn('✅ تایید', 'good', async () => { if (!confirm(`برداشت #${w.id} (${stars(w.amount)} ⭐) تایید شود؟\nبه یاد داشته باشید پرداخت واقعی را خودتان انجام دهید.`)) return; if (await guard(() => api('/api/admin/withdrawals/' + w.id, { action: 'approve' }))) { toast('تایید شد', 'good'); loadWd(); } }),
          btn('❌ رد', 'bad', async () => { const note = prompt('دلیل رد (اختیاری):', ''); if (note === null) return; if (await guard(() => api('/api/admin/withdrawals/' + w.id, { action: 'reject', note }))) { toast('رد شد و موجودی برگشت', 'good'); loadWd(); } }));
      } else acts.textContent = w.note || '—';
      const flags = el('span'); if (w.flagged) flags.append(tag('مشکوک', 'gold')); if (w.banned) flags.append(tag('بن', 'red'));
      const who = btn(userLabel(w), '', async () => openUser(w.user_id));
      return [num(String(w.id)), who, flags, num(stars(w.amount), 'gold'), w.type === 'gift' ? 'گیفت' : 'بالانس', num(stars(w.balance)), { pending: 'در انتظار', approved: 'تایید شده', rejected: 'رد شده' }[w.status], when(w.created_at), acts];
    });
    $('wdTable').replaceChildren(table(['#', 'کاربر', 'هشدار', 'مقدار ⭐', 'نوع', 'موجودی فعلی', 'وضعیت', 'تاریخ', 'اقدام'], rows));
    if (st === 'pending') { const b = $('wdBadge'); b.textContent = r.items.length; b.classList.toggle('hidden', !r.items.length); }
  }
  $('wdStatus').addEventListener('change', loadWd);

  // ───────── ads & channels ─────────
  let adsData = null;
  const rewardTxt = (t) => (t.rewardType === 'coins' ? t.reward + ' 🪙' : stars(t.reward) + ' ⭐');
  const shortUrl = (u) => { const c = el('span', 'url-cell num', u || '—'); c.title = u || ''; return c; };
  async function loadAds() {
    const r = await guard(() => api('/api/admin/tasks')); if (!r) return; adsData = r;
    const state = (t) => (t.enabled ? tag('فعال', 'green') : tag('غیرفعال', 'red'));
    const ads = r.items.filter((t) => t.type === 'ad'); const subs = r.items.filter((t) => t.type === 'sub');
    $('adsTable').replaceChildren(table(['#', 'وضعیت', 'پاداش', 'لینک تبلیغ', 'شرط', 'دریافت (۲۴س / کل)', 'کلیک ۲۴س', 'پرداختی'],
      ads.map((t) => [num(t.key), state(t), num(rewardTxt(t), 'gold'), shortUrl(t.url), [t.click ? 'کلیک اجباری' : '', t.postback ? 'پست‌بک' : ''].filter(Boolean).join(' + ') || '—',
        num(`${t.claims24} / ${t.claims}`), t.click ? num(`${t.clicks24} از ${t.sessions24}`) : '—', num(t.rewardType === 'coins' ? t.paid + ' 🪙' : stars(t.paid))]), (i) => openTask(ads[i])));
    $('subsTable').replaceChildren(table(['#', 'وضعیت', 'پاداش', 'کانال', 'لینک عضویت', 'عضو فعلی (از ثبت‌شده‌ها)', 'پرداختی'],
      subs.map((t) => [num(t.key), state(t), num(rewardTxt(t), 'gold'), num(t.channel), shortUrl(t.url), num(String(t.subscribed)), num(t.rewardType === 'coins' ? t.paid + ' 🪙' : stars(t.paid))]), (i) => openTask(subs[i])));
    $('setLimit').value = r.settings.perTaskLimit; $('setSpinAd').value = r.settings.spinAdUrl || '';
    $('adsHint').textContent = 'برای ویرایش، روی هر ردیف کلیک کنید. تغییرات تا حدود یک دقیقه بعد در مینی‌اپ کاربران اعمال می‌شود. تسک غیرفعال برای کاربران مخفی می‌شود.';
  }
  $('addAd').addEventListener('click', () => openTask(null, 'ad'));
  $('addSub').addEventListener('click', () => openTask(null, 'sub'));
  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await guard(() => api('/api/admin/settings', { perTaskLimit: parseInt($('setLimit').value, 10), spinAdUrl: $('setSpinAd').value.trim() }))) { toast('ذخیره شد', 'good'); loadAds(); }
  });

  function openTask(t, type) {
    const isNew = !t; type = t ? t.type : type; const isSub = type === 'sub';
    $('drawerTitle').textContent = isNew ? (isSub ? 'افزودن کانال عضویت' : 'افزودن تبلیغ') : (isSub ? 'کانال ' + t.channel : 'تبلیغ ' + t.key);
    const body = $('drawerBody'); body.replaceChildren();
    const form = el('form', 'task-form');
    const field = (label, input) => { const l = el('label'); l.append(el('span', '', label), input); form.append(l); return input; };
    const check = (label, checked) => { const l = el('label', 'chk'); const i = el('input'); i.type = 'checkbox'; i.checked = checked; l.append(i, el('span', '', label)); form.append(l); return i; };
    const rtype = el('select'); [['stars', '⭐ استارز (قابل برداشت)'], ['coins', '🪙 سکه‌ی درون‌بازی (برای جعبه‌های شانس)']].forEach(([v, n]) => { const o = el('option', '', n); o.value = v; rtype.append(o); });
    rtype.value = t && t.rewardType === 'coins' ? 'coins' : 'stars'; field('نوع پاداش (کادر تسک‌های سکه‌ای در مینی‌اپ رنگ متفاوت دارد)', rtype);
    const reward = el('input'); reward.type = 'number'; reward.required = true; reward.dir = 'ltr';
    const unit = () => { const c = rtype.value === 'coins'; reward.step = c ? '1' : '0.001'; reward.min = c ? '1' : '0.001'; };
    reward.value = t ? (t.rewardType === 'coins' ? t.reward : t.reward / 1000) : ''; unit();
    const rLabel = field('پاداش هر بار انجام (مقدار به واحد انتخاب‌شده)', reward);
    rtype.addEventListener('change', () => { unit(); reward.value = ''; });
    const url = el('input'); url.type = 'url'; url.dir = 'ltr'; url.placeholder = isSub ? 'https://t.me/your_channel' : 'https://…'; url.value = t ? t.url : ''; url.required = isSub || isNew;
    field(isSub ? 'لینک عضویت (https://t.me/…)' : 'لینک تبلیغ (از شبکه‌ی تبلیغاتی). می‌توانید {sid} و {uid} را در لینک بگذارید', url);
    let channel = null; let res = null;
    if (isSub) {
      channel = el('input'); channel.dir = 'ltr'; channel.placeholder = '@your_channel'; channel.value = t ? t.channel : ''; channel.required = true; channel.readOnly = !isNew;
      field(isNew ? 'کانال (@username یا آیدی عددی -100…)' : 'کانال (بعد از ثبت قابل تغییر نیست)', channel);
      res = el('div', 'checkres'); const cb = el('button', 'btn small', '🔍 بررسی کانال و دسترسی بات'); cb.type = 'button';
      cb.addEventListener('click', async () => {
        res.className = 'checkres'; res.textContent = '…';
        const r = await guard(() => api('/api/admin/check-channel', { channel: channel.value.trim() })); if (!r) { res.textContent = ''; return; }
        if (!r.ok) { res.className = 'checkres bad'; res.textContent = '❌ ' + r.error; return; }
        res.className = 'checkres ' + (r.botIsAdmin ? 'good' : 'bad');
        res.textContent = r.botIsAdmin ? `✅ «${r.title}» — بات ادمین است — اعضا: ${r.members ?? '؟'}` : `⚠️ «${r.title}» پیدا شد ولی بات ادمین نیست (وضعیت: ${r.botStatus}). بات را ادمین کانال کنید وگرنه بررسی عضویت کار نمی‌کند.`;
      });
      form.append(cb, res);
    }
    const click = !isSub ? check('کلیک اجباری (بدون کلیک فقط نصف پاداش)', t ? t.click : false) : null;
    const postback = !isSub ? check('تایید با پست‌بک شبکه‌ی تبلیغاتی (بدون تایید شبکه پاداش داده نمی‌شود)', t ? t.postback : false) : null;
    const enabled = check('فعال (برای کاربران نمایش داده شود)', t ? t.enabled : true);
    if (!isSub) { const h = el('div', 'hintbox'); h.append('لینک پست‌بک برای شبکه‌ی تبلیغاتی: '); const c = el('code', '', adsData && adsData.postbackTemplate ? adsData.postbackTemplate : 'ابتدا ADS_POSTBACK_SECRET را در .env تنظیم کنید'); h.append(c, el('br'), 'رویداد کلیک: همان لینک با ', el('code', '', '&event=click')); form.append(h); }
    const save = el('button', 'btn primary', isNew ? 'افزودن' : 'ذخیره'); save.type = 'submit'; form.append(save);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); const coins = rtype.value === 'coins'; const m = coins ? Math.round(parseFloat(reward.value)) : Math.round(parseFloat(reward.value) * 1000);
      const b = { reward_type: rtype.value, reward_m: m, url: url.value.trim(), enabled: enabled.checked };
      if (!isSub) { b.click = click.checked; b.postback = postback.checked; }
      if (isNew) { b.type = type; if (isSub) b.channel = channel.value.trim(); }
      if (await guard(() => api(isNew ? '/api/admin/tasks' : '/api/admin/tasks/' + t.key, b))) { toast('ذخیره شد', 'good'); drawer.classList.add('hidden'); loadAds(); }
    });
    body.append(form);
    if (!isNew) {
      const kv = el('div', 'kv'); [['دریافت‌ها (کل)', t.claims], ['دریافت‌ها (۲۴ساعت)', t.claims24], ['پرداختی', t.rewardType === 'coins' ? t.paid + ' 🪙' : stars(t.paid)], [isSub ? 'عضو فعلی' : 'کلیک ۲۴س', isSub ? t.subscribed : `${t.clicks24} از ${t.sessions24}`]].forEach(([k, v]) => { const d = el('div'); d.append(el('b', '', k), num(String(v))); kv.append(d); });
      body.append(kv);
      body.append(btn('🗑 حذف این تسک', 'bad', async () => { if (!confirm('این تسک برای همیشه حذف شود؟ (تاریخچه‌ی تراکنش‌ها می‌ماند). اگر فقط می‌خواهید مخفی شود، «فعال» را بردارید.')) return; if (await guard(() => api(`/api/admin/tasks/${t.key}/delete`, {}))) { toast('حذف شد', 'good'); drawer.classList.add('hidden'); loadAds(); } }));
    }
    drawer.classList.remove('hidden');
  }


  // ───────── wheel of fortune ─────────
  let wheelRows = [];
  const WTYPES = [['stars', '⭐ استارز'], ['coins', '🪙 سکه'], ['none', '💨 پوچ']];
  function renderWheelRows() {
    const total = wheelRows.reduce((a, r) => a + (r.w || 0), 0) || 1; const box = $('wheelRows'); box.replaceChildren();
    wheelRows.forEach((r, i) => {
      const row = el('div', 'wrow'); row.append(el('b', 'num', String(i + 1)));
      const sel = el('select'); WTYPES.forEach(([v, n]) => { const o = el('option', '', n); o.value = v; sel.append(o); }); sel.value = r.t;
      const amt = el('input'); amt.type = 'number'; amt.dir = 'ltr'; amt.min = '0'; amt.step = r.t === 'coins' ? '1' : '0.001'; amt.placeholder = r.t === 'coins' ? 'تعداد سکه' : 'مقدار ⭐';
      amt.value = r.t === 'none' ? '' : (r.t === 'coins' ? r.a : r.a / 1000); amt.disabled = r.t === 'none';
      const w = el('input'); w.type = 'number'; w.min = '0'; w.step = '1'; w.dir = 'ltr'; w.value = r.w; w.title = 'وزن';
      const pct = el('span', 'num muted', (r.w / total * 100).toFixed(1) + '٪');
      sel.addEventListener('change', () => { r.t = sel.value; if (r.t === 'none') r.a = 0; else if (!r.a) r.a = r.t === 'coins' ? 5 : 250; renderWheelRows(); });
      amt.addEventListener('input', () => { const v = parseFloat(amt.value); r.a = Number.isFinite(v) ? (r.t === 'coins' ? Math.round(v) : Math.round(v * 1000)) : 0; });
      w.addEventListener('input', () => { r.w = Math.max(0, parseInt(w.value, 10) || 0); const tt = wheelRows.reduce((a, x) => a + x.w, 0) || 1; box.querySelectorAll('.pct').forEach((p, k) => { p.textContent = (wheelRows[k].w / tt * 100).toFixed(1) + '٪'; }); });
      pct.classList.add('pct');
      const del = btn('🗑', 'bad', async () => { if (wheelRows.length <= 4) return toast('حداقل ۴ خانه لازم است', 'bad'); wheelRows.splice(i, 1); renderWheelRows(); });
      row.append(sel, amt, el('span', 'muted', 'وزن'), w, pct, del); box.append(row);
    });
  }
  async function loadWheel() {
    const r = await guard(() => api('/api/admin/wheel')); if (!r) return;
    wheelRows = r.slices.map((x) => ({ ...x })); renderWheelRows(); $('wheelEarn').value = r.spinEarn / 1000;
    const c = $('wheelSummary'); c.replaceChildren(
      stat('میانگین پرداخت هر چرخش', stars(r.ev.starsEquiv) + ' ⭐', `${stars(r.ev.stars)} ⭐ + ${r.ev.coins.toFixed(2)} 🪙 (ارزش هر سکه ${stars(r.coinValue)} ⭐)`),
      stat('شانس پوچ', (r.ev.noneChance * 100).toFixed(1) + '٪'), stat('چرخش‌ها (۷ روز)', String(r.spins7d)),
      stat('پرداختی گردونه (۷ روز)', stars(r.paid7d.stars) + ' ⭐', r.paid7d.coins + ' 🪙'), stat('جایزه‌ی منتظر دریافت', String(r.pendingPrizes)));
    $('wheelHint').textContent = 'بعد از هر چرخش، جایزه فقط پس از دیدن تبلیغ گردونه پرداخت می‌شود. لینک تبلیغ گردونه در تب «تبلیغات و کانال‌ها» تنظیم می‌شود.';
  }
  $('wheelAdd').addEventListener('click', () => { if (wheelRows.length >= 16) return toast('حداکثر ۱۶ خانه', 'bad'); wheelRows.push({ t: 'stars', a: 250, w: 10 }); renderWheelRows(); });
  $('wheelSave').addEventListener('click', async () => {
    if (await guard(() => api('/api/admin/wheel', { slices: wheelRows, spinEarn: Math.round(parseFloat($('wheelEarn').value) * 1000) }))) { toast('گردونه ذخیره شد', 'good'); loadWheel(); }
  });

  // ───────── lucky boxes / lottery ─────────
  const TN = { gold: 'طلایی', silver: 'نقره‌ای', bronze: 'برنزی' };
  async function loadLot() {
    const r = await guard(() => api('/api/admin/lottery')); if (!r) return; const c = r.config; const ev = r.event;
    $('lotSummary').replaceChildren(
      stat('رویداد فعلی', '#' + ev.id, 'پایان: ' + when(ev.end_at)),
      stat('جعبه‌های بازشده', String(ev.boxes.n), `${ev.boxes.users} کاربر · ${ev.boxes.coins} 🪙 خرج‌شده`),
      stat('سکه‌ی در گردش', String(r.coinsInCirculation) + ' 🪙'),
      ...['gold', 'silver', 'bronze'].map((t) => stat(`بلیط ${TN[t]}`, String(ev.tiers[t].holders) + ' دارنده', `${ev.tiers[t].pieces} تکه · جایزه‌ی فعلی ${stars(ev.prizesNow[t])} ⭐`)));
    const f = $('lotForm'); f.replaceChildren();
    const num_ = (label, get, set, step) => { const l = el('label'); const i = el('input'); i.type = 'number'; i.step = step || '1'; i.dir = 'ltr'; i.value = get(); i.addEventListener('input', () => set(parseFloat(i.value))); l.append(el('span', '', label), i); f.append(l); };
    const cfg = JSON.parse(JSON.stringify(c)); const star = (obj, k) => [() => obj[k] / 1000, (v) => { obj[k] = Math.round(v * 1000); }];
    const en = el('label', 'chk'); const eb = el('input'); eb.type = 'checkbox'; eb.checked = cfg.enabled; eb.addEventListener('change', () => { cfg.enabled = eb.checked; }); en.append(eb, el('span', '', 'بخش جعبه‌های شانس فعال باشد')); f.append(en);
    num_('هزینه‌ی باز کردن یک جعبه (🪙)', () => cfg.boxCost, (v) => { cfg.boxCost = v; });
    num_('ارزش هر سکه (به هزارم ⭐؛ ۱۰ = ۰٫۰۱ ⭐)', () => cfg.coinValue, (v) => { cfg.coinValue = v; });
    num_('تعداد تکه برای یک بلیط', () => cfg.perTicket, (v) => { cfg.perTicket = v; });
    num_('سقف بلیط برای هر نوع', () => cfg.maxTickets, (v) => { cfg.maxTickets = v; });
    num_('سقف جعبه در شبانه‌روز برای هر کاربر', () => cfg.boxesPerDay, (v) => { cfg.boxesPerDay = v; });
    num_('طول هر رویداد (روز)', () => cfg.eventDays, (v) => { cfg.eventDays = v; });
    num_('سقف جایزه نسبت به سکه‌ی خرج‌شده (٪) — برای ایمنی در رویدادهای کم‌شرکت‌کننده', () => cfg.prizePct, (v) => { cfg.prizePct = v; });
    for (const t of ['gold', 'silver', 'bronze']) num_(`شانس تکه‌ی ${TN[t]} (وزن)`, () => cfg.chances[t], (v) => { cfg.chances[t] = v; });
    for (const t of ['gold', 'silver', 'bronze']) num_(`جایزه‌ی ${TN[t]} — فقط یک برنده (⭐، سقف)`, ...star(cfg.prizes, t), '0.01');
    for (const t of ['gold', 'silver', 'bronze']) num_(`جایزه‌ی تسلیت هر بلیط ${TN[t]} برنده‌نشده (⭐)`, ...star(cfg.consolation, t), '0.01');
    num_('تبدیل: چند تکه‌ی برنزی ← یک تکه‌ی نقره‌ای', () => cfg.convert.bronzeToSilver, (v) => { cfg.convert.bronzeToSilver = v; });
    num_('تبدیل: چند تکه‌ی نقره‌ای ← یک تکه‌ی طلایی', () => cfg.convert.silverToGold, (v) => { cfg.convert.silverToGold = v; });
    const save = el('button', 'btn primary', '💾 ذخیره‌ی تنظیمات'); save.type = 'submit'; f.append(save);
    f.onsubmit = async (e) => { e.preventDefault(); if (await guard(() => api('/api/admin/lottery/config', cfg))) { toast('ذخیره شد (از رویداد بعدی برای طول دوره؛ بقیه فوری)', 'good'); loadLot(); } };
    f.append(el('p', 'muted', 'قانون جایزه: جایزه‌ی هر نوع = کمینه‌ی «سقف جایزه» و «درصد تعیین‌شده از ارزش سکه‌های خرج‌شده در همان رویداد». تنظیمات قرعه‌کشی‌ای که تمام می‌شود همان لحظه ثبت می‌گردد.'));
    $('lotHistory').replaceChildren(table(['#', 'پایان', 'سکه‌ی خرج‌شده', 'طلایی', 'نقره‌ای', 'برنزی', 'تسلیت پرداختی ⭐', 'seed'], r.history.map((h) => [num(String(h.id)), when(h.drawn_at), num(String(h.spent) + ' 🪙'),
      ...['gold', 'silver', 'bronze'].map((t) => { const x = h.tiers[t]; return x.winner ? num(`کاربر ${x.winner} · ${stars(x.prize)} ⭐ (از ${x.candidates})`) : `— (از ${x.candidates})`; }),
      num(h.consolation ? stars(h.consolation.paid) : '—'), num(h.seed.slice(0, 10) + '…')])));
  }
  $('lotDraw').addEventListener('click', async () => {
    if (!confirm('رویداد فعلی همین حالا بسته می‌شود، قرعه‌کشی انجام و جایزه‌ها پرداخت می‌شود و رویداد جدید شروع می‌شود. ادامه می‌دهید؟')) return;
    const r = await guard(() => api('/api/admin/lottery/draw-now', { confirm: true })); if (r) { toast(`قرعه‌کشی انجام شد (${r.notifications} پیام)`, 'good'); loadLot(); }
  });

  // ───────── activity & log ─────────
  Object.entries(KIND).forEach(([k, v]) => { const o = el('option', '', v); o.value = k; $('actKind').append(o); });
  async function loadAct() {
    const r = await guard(() => api('/api/admin/activity?kind=' + encodeURIComponent($('actKind').value))); if (!r) return;
    $('actTable').replaceChildren(table(['زمان', 'کاربر', 'نوع', 'مقدار ⭐', 'توضیح'], r.items.map((a) => [when(a.created_at), btn(userLabel({ id: a.user_id, first_name: a.first_name, username: a.username }), '', async () => openUser(a.user_id)), KIND[a.kind] || a.kind, signed(a.amount), a.ref || '—'])));
  }
  $('actKind').addEventListener('change', loadAct);
  async function loadLog() {
    const r = await guard(() => api('/api/admin/log')); if (!r) return;
    $('logTable').replaceChildren(table(['زمان', 'عملیات', 'هدف', 'جزئیات'], r.items.map((l) => [when(l.at), l.action, num(l.target || '—'), l.detail || '—'])));
  }

  // ───────── start ─────────
  if (token) enter();
  setInterval(() => { if (!document.hidden && !$('app').classList.contains('hidden') && current === 'dash') loadDash(); }, 60000);
})();
