'use strict';
/* KAReM front-end. It only DISPLAYS state and sends user actions; all balances, limits,
   timers, rewards and wheel results are decided by the server. */
(() => {
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const qs = new URLSearchParams(location.search);
  const devId = qs.get('dev'); // only works when the server runs with DEV_MODE=1
  const $ = (id) => document.getElementById(id);
  const LANGS = ['en', 'fa', 'ar', 'ru'];

  if (tg) { try { tg.ready(); tg.expand(); } catch { /* ignore */ } }

  // ───────── device identity (anti multi-account) ─────────
  // The id is mirrored in 4 independent stores and restored from whichever survives, so clearing
  // one of them (e.g. site data) does not reset it. Plus a hardware fingerprint the server also checks.
  let deviceId = '', fingerprint = '';
  const withTimeout = (p, ms = 1500) => Promise.race([p, new Promise((r) => setTimeout(() => r(''), ms))]);
  const tgStores = () => {
    const out = [];
    try { if (tg && tg.isVersionAtLeast && tg.isVersionAtLeast('9.0')) { if (tg.DeviceStorage) out.push(tg.DeviceStorage); if (tg.SecureStorage) out.push(tg.SecureStorage); } } catch { /* ignore */ }
    return out;
  };
  const idbOpen = () => new Promise((res, rej) => { const r = indexedDB.open('karem', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idbGet = async () => { try { const d = await idbOpen(); return await new Promise((res) => { const q = d.transaction('kv').objectStore('kv').get('device'); q.onsuccess = () => res(q.result || ''); q.onerror = () => res(''); }); } catch { return ''; } };
  const idbSet = async (v) => { try { const d = await idbOpen(); d.transaction('kv', 'readwrite').objectStore('kv').put(v, 'device'); } catch { /* ignore */ } };
  const cookieGet = () => { const m = document.cookie.match(/(?:^|; )karem_device=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; };
  const cookieSet = (v) => { try { document.cookie = `karem_device=${encodeURIComponent(v)};max-age=63072000;path=/;SameSite=None;Secure`; } catch { /* ignore */ } };
  const tgGet = (st) => new Promise((res) => { try { st.getItem('karem_device', (e, v) => res(e ? '' : v || '')); } catch { res(''); } });

  async function loadDeviceId() {
    const found = [];
    try { found.push(localStorage.getItem('karem_device') || ''); } catch { /* ignore */ }
    found.push(cookieGet(), await withTimeout(idbGet()));
    for (const st of tgStores()) found.push(await withTimeout(tgGet(st)));
    let id = found.find((x) => x && /^[\w-]{8,100}$/.test(x)) || '';
    if (!id) id = crypto.randomUUID ? crypto.randomUUID() : (String(Math.random()).slice(2) + Date.now());
    try { localStorage.setItem('karem_device', id); } catch { /* ignore */ }
    cookieSet(id); idbSet(id);
    for (const st of tgStores()) { try { st.setItem('karem_device', id, () => {}); } catch { /* ignore */ } }
    return id;
  }
  async function computeFingerprint() {
    const parts = [navigator.platform, navigator.hardwareConcurrency, navigator.deviceMemory, navigator.maxTouchPoints, (navigator.languages || []).join(','),
      screen.width + 'x' + screen.height + 'x' + (window.devicePixelRatio || 1), screen.colorDepth, Intl.DateTimeFormat().resolvedOptions().timeZone];
    try {
      const c = document.createElement('canvas'); c.width = 200; c.height = 40; const x = c.getContext('2d');
      x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#f60'; x.fillRect(10, 5, 80, 20); x.fillStyle = '#069'; x.fillText('KAReM \u2605 fp 1.0', 4, 8);
      parts.push(c.toDataURL().slice(-120));
      const gl = document.createElement('canvas').getContext('webgl'); const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) parts.push(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    } catch { /* ignore */ }
    const str = parts.join('|');
    try { const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
    catch { return str.slice(0, 190); }
  }

  let S = null;                // last server state
  let offset = 0;              // serverNow - clientNow
  let lang = 'en';
  const ui = {};               // transient per-task UI: {sessionId, readyAt, msg, cls}
  const cards = {};            // task key -> element refs
  let pendingClaim = null;
  let wheelRot = 0, spinning = false, wheelDrawn = false;
  const srvNow = () => Date.now() + offset;

  // ───────── i18n ─────────
  const tr = (key, p) => {
    let s = (window.I18N[lang] && window.I18N[lang][key]) || window.I18N.en[key] || key;
    if (p) for (const k in p) s = s.split('{' + k + '}').join(String(p[k]));
    return s;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // floor (not round) to 2 decimals so the shown balance is always withdrawable
  const fmt = (m) => (Math.floor(m / 10) / 100).toFixed(2).replace(/\.?0+$/, '') || '0';
  const hms = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); const p = (n) => String(n).padStart(2, '0'); return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`; };

  function applyLang(l) {
    lang = LANGS.includes(l) ? l : 'en';
    try { localStorage.setItem('karem_lang', lang); } catch { /* ignore */ }
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' || lang === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = tr(e.dataset.i18n); });
    document.querySelectorAll('[data-i18n-aria]').forEach((e) => e.setAttribute('aria-label', tr(e.dataset.i18nAria)));
    $('langSelect').value = lang;
    renderAll();
  }
  function detectLang() {
    try { const s = localStorage.getItem('karem_lang'); if (LANGS.includes(s)) return s; } catch { /* ignore */ }
    const c = ((tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code) || navigator.language || 'en').slice(0, 2);
    return LANGS.includes(c) ? c : 'en';
  }

  // ───────── API ─────────
  function authHeader() {
    if (tg && tg.initData) return 'tma ' + tg.initData;
    if (devId) return 'dev ' + devId;
    return '';
  }
  async function api(path, body) {
    let res;
    try {
      res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader(), 'X-Device': deviceId, 'X-FP': fingerprint },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { const e = new Error('NETWORK'); e.code = 'NETWORK'; throw e; }
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) { const e = new Error(data.error || 'UNKNOWN'); e.code = data.error || 'UNKNOWN'; e.data = data; throw e; }
    return data;
  }
  const errText = (e) => tr('e_' + (e && e.code ? e.code : 'UNKNOWN'));
  const haptic = (t) => { try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(t); } catch { /* ignore */ } };

  function openUrl(url) {
    if (!url || !/^https:\/\//i.test(url)) return;
    if (tg && /^https:\/\/t\.me\//i.test(url) && tg.openTelegramLink) tg.openTelegramLink(url);
    else if (tg && tg.openLink) tg.openLink(url);
    else window.open(url, '_blank', 'noopener');
  }

  // ───────── state ─────────
  function applyState(s) {
    S = s; offset = s.now - Date.now();
    if (!Object.keys(cards).length) buildCards();
    if (!wheelDrawn) { drawWheel(); wheelDrawn = true; }
    renderAll();
  }
  function renderAll() {
    if (!S) return;
    $('userBalance').textContent = fmt(S.balance);
    $('walletBalance').textContent = fmt(S.balance) + ' ⭐';
    $('dailyRewardBadge').textContent = '⭐ ' + fmt(S.daily.reward);
    $('refDesc').innerHTML = rich(tr('refDesc', { n: S.config.refAdsNeeded, b: fmt(S.config.refBonus), p: S.config.refPct }));
    $('refCountText').innerHTML = rich(tr('refCount', { n: S.refs.count, a: S.refs.active }));
    $('refLinkInput').value = S.refs.link || tr('refNoLink');
    $('minWithdraw').innerHTML = rich(tr('minWithdraw', { n: fmt(S.config.minWithdraw) }));
    $('withdrawAmount').min = fmt(S.config.minWithdraw);
    $('userRank').textContent = S.league.rank ? '#' + S.league.rank : '—';
    $('userScore').textContent = fmt(S.league.score);
    renderWheelState();
    renderWithdrawals();
    tick();
    $('authSection').classList.toggle('show', !!S.captchaRequired && !!pendingClaim);
  }

  // ───────── task cards ─────────
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  function buildCards() {
    for (const key of Object.keys(S.tasks)) {
      const t = S.tasks[key];
      const wrap = el('div', 'task-wrap');
      const limit = el('div', 'task-limit-info'); limit.setAttribute('role', 'status');
      const card = el('div', 'card');
      const head = el('div', 'channel-info');
      const name = el('span', 'channel-name');
      const badge = el('span', 'reward-badge', '⭐ ' + fmt(t.reward));
      head.append(name, badge);
      const play = el('button', 'play-box'); play.type = 'button';
      const claim = el('button'); claim.type = 'button'; claim.classList.add('hidden');
      const guide = el('div', 'task-guide');
      const msg = el('div', 'channel-status-msg'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
      card.append(head, play, claim, guide, msg);
      wrap.append(limit, card);
      $(t.type === 'ad' ? 'home-sec-ads' : 'home-sec-sub').append(wrap);
      play.addEventListener('click', () => startTask(key));
      claim.addEventListener('click', () => claimTask(key));
      cards[key] = { limit, name, play, claim, guide, msg, type: t.type, n: Number(key.replace(/\D/g, '')) };
    }
  }
  function setMsg(key, cls, text) { ui[key] = ui[key] || {}; ui[key].cls = cls; ui[key].msg = text; }

  function refreshCard(key) {
    const c = cards[key]; if (!c || !S) return;
    const t = S.tasks[key]; const u = ui[key] || {}; const now = srvNow();
    c.name.textContent = tr(c.type === 'ad' ? 'adName' : 'subName', { n: c.n });
    c.guide.textContent = tr(c.type === 'ad' ? 'guideAd' : 'guideSub');
    const limited = c.type === 'ad' && t.resetAt > now;
    // limit label
    if (c.type === 'ad') {
      c.limit.textContent = limited ? tr('timeLeft', { t: hms(t.resetAt - now) }) : tr('remaining', { n: Math.max(0, t.max - t.count), m: t.max });
      c.limit.classList.remove('hidden');
    } else c.limit.classList.add('hidden');
    // play button
    const idle = tr(c.type === 'ad' ? 'play' : 'join');
    let label = idle, disabled = false;
    if (!t.available) { label = tr('soon'); disabled = true; }
    else if (t.done) { label = tr('completed'); disabled = true; }
    else if (limited) { label = idle; disabled = true; }
    else if (u.cooldownUntil > Date.now()) { label = tr('wait', { s: Math.ceil((u.cooldownUntil - Date.now()) / 1000) }); disabled = true; }
    else if (u.sessionId) { label = tr('opened'); disabled = true; }
    c.play.textContent = label; c.play.classList.toggle('disabled', disabled); c.play.disabled = disabled;
    // claim button
    if (u.sessionId && !t.done) {
      c.claim.classList.remove('hidden');
      const left = Math.ceil((u.readyAt - Date.now()) / 1000);
      if (left > 0) { c.claim.disabled = true; c.claim.textContent = tr('wait', { s: left }); }
      else {
        c.claim.disabled = !!u.busy; c.claim.textContent = tr(c.type === 'ad' ? 'claimAd' : 'claimSub');
        if (!u.readyShown) { u.readyShown = true; setMsg(key, 'ok', tr('ready')); }
      }
    } else c.claim.classList.add('hidden');
    c.msg.className = 'channel-status-msg' + (u.cls ? ' ' + u.cls : '');
    c.msg.textContent = u.msg || '';
  }

  async function startTask(key) {
    const u = ui[key] = { };
    try {
      const r = await api('/api/task/start', { task: key });
      applyState(r.state);
      Object.assign(u, { sessionId: r.sessionId, readyAt: Date.now() + r.waitSec * 1000 + 400 });
      setMsg(key, 'warn', tr('opened'));
      openUrl(r.url);
    } catch (e) { setMsg(key, 'err', errText(e)); if (e.code === 'LIMIT' && S) refreshState(); }
    refreshCard(key);
  }
  async function claimTask(key) {
    const u = ui[key]; if (!u || !u.sessionId || u.busy) return;
    u.busy = true; refreshCard(key);
    try {
      const r = await api('/api/task/claim', { sessionId: u.sessionId });
      ui[key] = { cooldownUntil: Date.now() + S.config.waitSec * 1000 + 300 }; setMsg(key, 'ok', tr('claimed', { n: fmt(r.reward) })); haptic('success');
      applyState(r.state);
    } catch (e) {
      u.busy = false;
      if (e.code === 'CAPTCHA_REQUIRED') { pendingClaim = key; setMsg(key, 'warn', tr('capDesc')); showCaptcha(); }
      else if (e.code === 'TOO_EARLY') { u.readyAt = Date.now() + (e.data.retryMs || 1000) + 300; u.readyShown = false; setMsg(key, 'err', errText(e)); }
      else { if (['BAD_SESSION', 'EXPIRED', 'NOT_CONFIGURED', 'ALREADY_DONE', 'LIMIT'].includes(e.code)) { ui[key] = {}; refreshState(); } setMsg(key, 'err', errText(e)); haptic('error'); }
    }
    refreshCard(key);
  }
  async function refreshState() { try { applyState((await api('/api/state')).state); } catch { /* ignore */ } }

  // ───────── captcha ─────────
  async function showCaptcha() {
    $('authSection').classList.add('show'); $('captchaMsg').textContent = ''; $('captchaInput').value = '';
    try { const r = await api('/api/captcha'); $('captchaImg').src = 'data:image/svg+xml;utf8,' + encodeURIComponent(r.svg); }
    catch (e) { $('captchaMsg').textContent = errText(e); }
    $('authSection').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function submitCaptcha() {
    const answer = $('captchaInput').value.trim(); if (!answer) return;
    try {
      const r = await api('/api/captcha/verify', { answer });
      $('authSection').classList.remove('show'); applyState(r.state);
      const k = pendingClaim; pendingClaim = null;
      if (k) claimTask(k);
    } catch (e) { $('captchaMsg').textContent = errText(e); if (e.code === 'CAPTCHA_WRONG') showCaptcha().then(() => { $('captchaMsg').textContent = errText(e); }); }
  }

  // ───────── daily ─────────
  async function claimDaily() {
    $('dailyBtn').disabled = true;
    try {
      const r = await api('/api/daily', {});
      applyState(r.state); $('dailyStatus').className = 'channel-status-msg ok'; $('dailyStatus').textContent = tr('dailyClaimed', { n: fmt(r.reward) }); haptic('success');
    } catch (e) { $('dailyStatus').className = 'channel-status-msg err'; $('dailyStatus').textContent = errText(e); if (S) refreshState(); }
  }
  function refreshDaily() {
    const b = $('dailyBtn'); const left = S.daily.nextAt - srvNow();
    if (left > 0) { b.disabled = true; b.textContent = tr('dailyIn', { t: hms(left) }); }
    else { b.disabled = false; b.textContent = tr('dailyBtn'); }
  }

  // ───────── wheel ─────────
  const WHEEL_COLORS = ['#ef4444', '#2563eb', '#334155', '#d97706', '#059669', '#db2777', '#7c3aed', '#0d9488'];
  function drawWheel() {
    const canvas = $('wheelCanvas'); const ctx = canvas.getContext('2d'); const slices = S.config.wheel;
    const arc = (2 * Math.PI) / slices.length; const c = canvas.width / 2; const r = c - 5;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    slices.forEach((v, i) => {
      const a = i * arc - Math.PI / 2;
      ctx.beginPath(); ctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length]; ctx.moveTo(c, c); ctx.arc(c, c, r, a, a + arc); ctx.lineTo(c, c); ctx.fill();
      ctx.save(); ctx.translate(c, c); ctx.rotate(a + arc / 2); ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif';
      ctx.fillText(v > 0 ? fmt(v) + '⭐' : '❌', r - 14, 4); ctx.restore();
    });
    ctx.beginPath(); ctx.arc(c, c, 22, 0, 2 * Math.PI); ctx.fillStyle = '#0f0c1b'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fde047'; ctx.stroke();
  }
  function renderWheelState() {
    const sp = S.spin; const b = $('spinBtn');
    $('wheelDesc').textContent = tr('wheelDesc', { n: fmt(sp.need), a: fmt(sp.progress), b: fmt(sp.need) });
    $('wheelBar').style.width = Math.min(100, (sp.progress / sp.need) * 100) + '%';
    if (spinning) return;
    b.disabled = !sp.ready;
    b.textContent = sp.ready ? tr('spin') : tr('spinLocked', { n: fmt(sp.need - sp.progress) });
  }
  async function spinWheel() {
    if (spinning || !S.spin.ready) return;
    spinning = true; const b = $('spinBtn'); const res = $('wheelResult'); b.disabled = true; res.className = 'warn wheel-result'; res.textContent = tr('spinAd');
    try {
      const st = await api('/api/spin/start', {});
      openUrl(st.url);
      await new Promise((r) => setTimeout(r, st.waitSec * 1000 + 400));
      res.textContent = tr('spinning');
      const r = await api('/api/spin', { sessionId: st.sessionId });
      // cumulative rotation (fix: every spin keeps rotating forward and lands on the server's slice)
      const n = S.config.wheel.length; const deg = 360 / n;
      const jitter = (Math.random() - 0.5) * deg * 0.6;
      const target = 360 - (r.index * deg + deg / 2) + jitter;
      wheelRot = wheelRot - (wheelRot % 360) + 360 * 6 + target;
      $('wheelCanvas').style.transform = `rotate(${wheelRot}deg)`;
      await new Promise((rs) => setTimeout(rs, 4200));
      spinning = false; applyState(r.state);
      if (r.prize > 0) { res.className = 'ok wheel-result'; res.textContent = tr('won', { n: fmt(r.prize) }); haptic('success'); }
      else { res.className = 'err wheel-result'; res.textContent = tr('lost'); }
    } catch (e) { spinning = false; res.className = 'err wheel-result'; res.textContent = errText(e); refreshState(); }
  }

  // ───────── referral / league / wallet ─────────
  async function copyRef() {
    if (!S.refs.link) { $('refStatus').textContent = tr('refNoLink'); return; }
    try { await navigator.clipboard.writeText(S.refs.link); }
    catch { const i = $('refLinkInput'); i.select(); document.execCommand && document.execCommand('copy'); }
    $('refStatus').textContent = tr('copied'); haptic('success');
  }
  async function loadLeague() {
    try {
      const r = await api('/api/league'); const box = $('leagueList'); box.replaceChildren();
      if (!r.top.length) { box.append(el('div', 'hint center', tr('leagueEmpty'))); return; }
      r.top.forEach((row) => {
        const d = el('div', 'leaderboard-item' + (row.rank <= 3 ? ' top-' + row.rank : '') + (row.me ? ' me' : ''));
        d.append(el('span', 'rank-badge', ['🥇', '🥈', '🥉'][row.rank - 1] || String(row.rank)), el('span', 'name', row.name + (row.me ? ' ' + tr('you') : '')));
        d.append(el('span', row.rank <= 3 ? 'prize' : 'score', row.rank <= 3 ? '🎁 ' + fmt(r.prizes[row.rank - 1]) + ' ⭐' : fmt(row.score) + ' ⭐'));
        box.append(d);
      });
      $('userRank').textContent = r.me.rank ? '#' + r.me.rank : '—'; $('userScore').textContent = fmt(r.me.score);
    } catch { /* ignore */ }
  }
  function renderWithdrawals() {
    const box = $('wdList'); box.replaceChildren();
    S.withdrawals.forEach((w) => {
      const row = el('div', 'wd-row'); row.append(el('span', '', fmt(w.amount) + ' ⭐ · ' + new Date(w.created_at).toLocaleDateString(lang)), el('span', 'st-' + w.status, tr('st_' + w.status)));
      box.append(row);
    });
  }
  async function requestWithdrawal() {
    const sm = $('statusMsg'); const v = parseFloat($('withdrawAmount').value);
    const amount_m = Math.round(v * 1000);
    if (!Number.isFinite(v) || amount_m < S.config.minWithdraw) { sm.className = 'err'; sm.textContent = tr('e_MIN_WITHDRAW'); return; }
    try {
      const r = await api('/api/withdraw', { amount_m, type: $('payoutType').value });
      applyState(r.state); sm.className = 'ok'; sm.textContent = tr('wdOk', { n: fmt(amount_m) }); $('withdrawAmount').value = ''; haptic('success');
    } catch (e) { sm.className = 'err'; sm.textContent = errText(e); }
  }

  // ───────── UI wiring ─────────
  function switchTab(name) {
    document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach((i) => { const on = i.dataset.tab === name; i.classList.toggle('active', on); if (on) i.setAttribute('aria-current', 'page'); else i.removeAttribute('aria-current'); });
    $('tab-' + name).classList.add('active'); $('statusMsg').textContent = '';
    if (name === 'league') loadLeague();
    if (tg && tg.BackButton) { name === 'home' ? tg.BackButton.hide() : tg.BackButton.show(); }
  }
  function toggleModal(open) {
    const m = $('settingsModal'); m.classList.toggle('open', open);
    if (open) $('langSelect').focus(); else $('settingsBtn').focus();
  }
  function tick() {
    if (!S) return;
    refreshDaily();
    Object.keys(cards).forEach(refreshCard);
  }
  function notice(text) { const n = $('noticeScreen'); n.textContent = text; n.classList.remove('hidden'); $('loadingScreen').style.display = 'none'; }

  function wire() {
    document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    document.querySelectorAll('.section-toggle-btn').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.home-sub-section').forEach((s) => s.classList.remove('active'));
      document.querySelectorAll('.section-toggle-btn').forEach((x) => x.classList.remove('active'));
      $('home-sec-' + b.dataset.sec).classList.add('active'); b.classList.add('active');
    }));
    $('settingsBtn').addEventListener('click', () => toggleModal(true));
    $('closeModal').addEventListener('click', () => toggleModal(false));
    $('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) toggleModal(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleModal(false); });
    $('langSelect').addEventListener('change', (e) => applyLang(e.target.value));
    $('dailyBtn').addEventListener('click', claimDaily);
    $('captchaBtn').addEventListener('click', submitCaptcha);
    $('captchaInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCaptcha(); });
    $('copyBtn').addEventListener('click', copyRef);
    $('spinBtn').addEventListener('click', spinWheel);
    $('withdrawBtn').addEventListener('click', requestWithdrawal);
    if (tg && tg.BackButton) tg.BackButton.onClick(() => switchTab('home'));
  }

  async function init() {
    wire(); applyLang(detectLang());
    if (!authHeader()) { notice(tr('openInTg')); return; }
    [deviceId, fingerprint] = await Promise.all([loadDeviceId(), computeFingerprint()]);
    try {
      const r = await api('/api/auth', {});
      applyState(r.state);
      const ls = $('loadingScreen'); ls.style.opacity = '0'; setTimeout(() => { ls.style.display = 'none'; }, 500);
      setInterval(tick, 1000);
      setInterval(() => { if (!document.hidden && !spinning) refreshState(); }, 60000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshState(); });
    } catch (e) { notice(errText(e)); }
  }
  document.addEventListener('DOMContentLoaded', init);
})();
