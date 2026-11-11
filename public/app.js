'use strict';
/* CAReM front-end. It only DISPLAYS state and sends user actions; all balances, limits,
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
    if (!url) return;
    const sameOrigin = url.startsWith(location.origin + '/');
    if (!/^https:\/\//i.test(url) && !sameOrigin) return;
    if (sameOrigin && url.includes('/ad.html')) url += '&l=' + lang;
    if (tg && /^https:\/\/t\.me\//i.test(url) && tg.openTelegramLink) tg.openTelegramLink(url);
    else if (tg && tg.openLink) tg.openLink(url);
    else window.open(url, '_blank', 'noopener');
  }

  // ───────── state ─────────
  function applyState(s) {
    S = s; offset = s.now - Date.now();
    syncCards();
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
    $('capRewardText').textContent = tr('capRewardHint', { n: fmt(S.config.captchaReward) });
    renderLeagueTimer();
    renderWheelState();
    renderWithdrawals();
    tick();
    $('authSection').classList.toggle('show', !!S.captchaRequired && !!pendingClaim);
  }

  // ───────── task cards ─────────
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  function syncCards() {
    for (const k of Object.keys(cards)) if (!S.tasks[k]) { cards[k].wrap.remove(); delete cards[k]; delete ui[k]; } // task removed / disabled by the admin
    for (const key of Object.keys(S.tasks)) {
      if (cards[key]) continue;
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
      cards[key] = { wrap, limit, name, play, claim, guide, msg, type: t.type, n: Number(key.replace(/\D/g, '')) };
    }
  }
  function setMsg(key, cls, text) { ui[key] = ui[key] || {}; ui[key].cls = cls; ui[key].msg = text; }

  function refreshCard(key) {
    const c = cards[key]; if (!c || !S) return;
    const t = S.tasks[key]; const u = ui[key] || {}; const now = srvNow();
    c.name.textContent = tr(c.type === 'ad' ? 'adName' : 'subName', { n: c.n });
    c.guide.textContent = tr(c.type === 'ad' ? (t.click ? 'guideAdClick' : 'guideAd') : 'guideSub');
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
      ui[key] = { cooldownUntil: Date.now() + S.config.waitSec * 1000 + 300 }; setMsg(key, r.halved ? 'warn' : 'ok', tr(r.halved ? 'claimedHalf' : 'claimed', { n: fmt(r.reward) })); haptic('success');
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
      if (r.reward > 0) toast(tr('capReward', { n: fmt(r.reward) }));
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
  // Galaxy Orb wheel. Three canvases: back ring (static) · slices+labels+stars (rotates) · rim/shading/hub (static).
  const WHEEL_PAL = [['#312e81', '#6366f1'], ['#581c87', '#c084fc'], ['#831843', '#f472b6'], ['#1e3a8a', '#38bdf8'], ['#4c1d95', '#8b5cf6'], ['#9d174d', '#fb7185'], ['#92400e', '#fbbf24'], ['#134e4a', '#2dd4bf']];
  function wStar(ctx, cx, cy, R, r, fill) {
    ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? r : R; ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }
  function drawWheel() {
    const TAU = Math.PI * 2; const slices = S.config.wheel; const n = slices.length; const arc = TAU / n;
    // 1) rotating disc
    const canvas = $('wheelCanvas'); const ctx = canvas.getContext('2d'); const c = canvas.width / 2; const R = c - 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.translate(c, c); ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.clip();
    slices.forEach((v, i) => {
      const a = i * arc - Math.PI / 2; const pal = WHEEL_PAL[i % WHEEL_PAL.length];
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R); g.addColorStop(0, pal[0]); g.addColorStop(1, pal[1]);
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, a, a + arc); ctx.closePath(); ctx.fill();
    });
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; // fixed star-dust pattern
    for (let i = 0; i < 110; i++) { const a = rnd() * TAU, d = Math.sqrt(rnd()) * R; ctx.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.6})`; ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, rnd() * 1.8 + 0.4, 0, TAU); ctx.fill(); }
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2;
    for (let i = 0; i < n; i++) { const a = i * arc - Math.PI / 2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R); ctx.stroke(); }
    ctx.restore();
    const fs = R * 0.15;
    slices.forEach((v, i) => {
      const a = i * arc + arc / 2 - Math.PI / 2;
      ctx.save(); ctx.translate(c + Math.cos(a) * R * 0.66, c + Math.sin(a) * R * 0.66); ctx.rotate(a + Math.PI / 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.shadowColor = 'rgba(0,0,40,.9)'; ctx.shadowBlur = 8; ctx.fillStyle = '#fff';
      if (v > 0) { ctx.font = `800 ${fs}px sans-serif`; ctx.fillText(fmt(v), 0, -fs * 0.18); ctx.shadowBlur = 0; wStar(ctx, 0, fs * 0.95, fs * 0.42, fs * 0.18, '#fde047'); }
      else { ctx.shadowBlur = 0; ctx.font = `${fs * 1.2}px sans-serif`; ctx.fillText('💨', 0, 0); }
      ctx.restore();
    });
    // 2) static layers (ring behind / rim + sphere shading + hub + ring in front)
    const bk = $('wheelBack'); const bc = bk.getContext('2d'); const fx = $('wheelFx'); const fc = fx.getContext('2d');
    const m = bk.width / 2; const WR = R; const RR = WR * 1.17;
    bc.clearRect(0, 0, bk.width, bk.height); fc.clearRect(0, 0, fx.width, fx.height);
    bc.save(); bc.translate(m, m); bc.scale(1, 0.28); bc.strokeStyle = 'rgba(253,224,71,.35)'; bc.lineWidth = 20; bc.beginPath(); bc.arc(0, 0, RR, Math.PI, TAU); bc.stroke(); bc.restore();
    fc.save(); fc.translate(m, m);
    const sp = fc.createRadialGradient(-WR * 0.35, -WR * 0.4, WR * 0.1, 0, 0, WR);
    sp.addColorStop(0, 'rgba(255,255,255,.38)'); sp.addColorStop(0.35, 'rgba(255,255,255,0)'); sp.addColorStop(0.75, 'rgba(0,0,10,.1)'); sp.addColorStop(1, 'rgba(0,0,15,.6)');
    fc.fillStyle = sp; fc.beginPath(); fc.arc(0, 0, WR, 0, TAU); fc.fill();
    fc.save(); fc.strokeStyle = 'rgba(216,180,254,.95)'; fc.lineWidth = 7; fc.shadowColor = '#c084fc'; fc.shadowBlur = 28; fc.beginPath(); fc.arc(0, 0, WR - 1, 0, TAU); fc.stroke(); fc.restore();
    fc.save(); fc.scale(1, 0.28); fc.strokeStyle = 'rgba(253,224,71,.85)'; fc.lineWidth = 20; fc.shadowColor = '#fde047'; fc.shadowBlur = 24; fc.beginPath(); fc.arc(0, 0, RR, 0, Math.PI); fc.stroke(); fc.restore();
    const hg = fc.createRadialGradient(-WR * 0.04, -WR * 0.05, 3, 0, 0, WR * 0.18); hg.addColorStop(0, '#ffffff'); hg.addColorStop(0.4, '#c4b5fd'); hg.addColorStop(1, '#4c1d95');
    fc.shadowColor = '#a855f7'; fc.shadowBlur = 30; fc.fillStyle = hg; fc.beginPath(); fc.arc(0, 0, WR * 0.17, 0, TAU); fc.fill(); fc.shadowBlur = 0;
    wStar(fc, 0, 0, WR * 0.1, WR * 0.042, '#fde047');
    fc.restore();
  }
  const spinClaim = { sessionId: '', readyAt: 0, busy: false };
  function renderWheelState() {
    const sp = S.spin; const b = $('spinBtn'); const cb = $('spinClaimBtn');
    $('wheelDesc').textContent = tr('wheelDesc', { n: fmt(sp.need), a: fmt(sp.progress), b: fmt(sp.need) });
    $('wheelBar').style.width = Math.min(100, (sp.progress / sp.need) * 100) + '%';
    if (spinning) return;
    const pend = sp.pending;
    b.disabled = !sp.ready || !!pend;
    b.textContent = sp.ready ? tr('spin') : tr('spinLocked', { n: fmt(sp.need - sp.progress) });
    cb.classList.toggle('hidden', !pend);
    if (!pend) { spinClaim.sessionId = ''; return; }
    const left = Math.ceil((spinClaim.readyAt - Date.now()) / 1000);
    if (!spinClaim.sessionId) { cb.textContent = tr('spinClaimAd', { n: fmt(pend.prize) }); cb.disabled = false; }
    else if (left > 0) { cb.textContent = tr('wait', { s: left }); cb.disabled = true; }
    else { cb.textContent = tr('spinClaimGo', { n: fmt(pend.prize) }); cb.disabled = spinClaim.busy; }
  }
  async function spinWheel() {
    if (spinning || !S.spin.ready || S.spin.pending) return;
    spinning = true; const b = $('spinBtn'); const res = $('wheelResult'); b.disabled = true; res.className = 'warn wheel-result'; res.textContent = tr('spinning');
    try {
      const r = await api('/api/spin', {}); // no ad before the spin: the only ad comes after it
      // cumulative rotation: every spin keeps rotating forward and lands on the server's slice
      const n = S.config.wheel.length; const deg = 360 / n;
      const jitter = (Math.random() - 0.5) * deg * 0.6;
      const target = 360 - (r.index * deg + deg / 2) + jitter;
      wheelRot = wheelRot - (wheelRot % 360) + 360 * 6 + target;
      $('wheelCanvas').style.transform = `rotate(${wheelRot}deg)`;
      await new Promise((rs) => setTimeout(rs, 4200));
      spinning = false; spinClaim.sessionId = ''; applyState(r.state);
      if (r.prize > 0) { res.className = 'ok wheel-result'; res.textContent = tr('wonPending', { n: fmt(r.prize) }); haptic('success'); }
      else { res.className = 'err wheel-result'; res.textContent = tr('lost'); }
    } catch (e) { spinning = false; res.className = 'err wheel-result'; res.textContent = errText(e); refreshState(); }
  }
  // the prize is paid only after a second ad
  async function claimSpinPrize() {
    if (!S.spin.pending || spinClaim.busy) return;
    const res = $('wheelResult');
    if (!spinClaim.sessionId) {
      try {
        const st = await api('/api/spin/claim/start', {});
        spinClaim.sessionId = st.sessionId; spinClaim.readyAt = Date.now() + st.waitSec * 1000 + 400;
        res.className = 'warn wheel-result'; res.textContent = tr('spinAd'); openUrl(st.url);
      } catch (e) { res.className = 'err wheel-result'; res.textContent = errText(e); }
      return renderWheelState();
    }
    if (Date.now() < spinClaim.readyAt) return;
    spinClaim.busy = true; renderWheelState();
    try {
      const r = await api('/api/spin/claim', { sessionId: spinClaim.sessionId });
      spinClaim.sessionId = ''; spinClaim.busy = false; applyState(r.state);
      res.className = 'ok wheel-result'; res.textContent = tr('won', { n: fmt(r.prize) }); haptic('success');
    } catch (e) {
      spinClaim.busy = false;
      if (e.code === 'TOO_EARLY') spinClaim.readyAt = Date.now() + (e.data.retryMs || 1000) + 300;
      else spinClaim.sessionId = '';
      res.className = 'err wheel-result'; res.textContent = errText(e); renderWheelState();
    }
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
  let leagueRefetched = false;
  function renderLeagueTimer() {
    if (!S) return;
    const ms = Math.max(0, S.league.endsAt - srvNow());
    const mins = Math.floor(ms / 60000);
    $('cdD').textContent = String(Math.floor(mins / 1440));
    $('cdH').textContent = String(Math.floor((mins % 1440) / 60));
    $('cdM').textContent = String(mins % 60);
    if (ms === 0 && !leagueRefetched) { leagueRefetched = true; setTimeout(() => { refreshState().then(() => { leagueRefetched = false; }); loadLeague(); }, 5000); }
  }
  function tick() {
    if (!S) return;
    refreshDaily();
    renderLeagueTimer();
    if (S.spin.pending) renderWheelState();
    Object.keys(cards).forEach(refreshCard);
  }
  let toastTimer = 0;
  function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500); haptic('success'); }
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
    $('spinClaimBtn').addEventListener('click', claimSpinPrize);
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
      document.body.classList.remove('loading'); const ls = $('loadingScreen'); ls.style.opacity = '0'; setTimeout(() => { ls.style.display = 'none'; }, 500);
      setInterval(tick, 1000);
      setInterval(() => { if (!document.hidden && !spinning) refreshState(); }, 60000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshState(); });
    } catch (e) { notice(errText(e)); }
  }
  document.addEventListener('DOMContentLoaded', init);
})();
