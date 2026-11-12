'use strict';
/* CAReM lottery artwork (canvas): tier-metal framed 3D tickets with the embossed logo, jigsaw reveal, mini ticket icons,
   embossed coin and the purple gift boxes. Pure drawing — no game logic. Exposes window.LotteryArt. */
(() => {
  const TAU = Math.PI * 2; const S0 = 2;
  const TI = {
    gold: { en: 'GOLD', base: '#e9b730', light: '#fff1a6', dark: '#9a5a0b', deep: '#6b3a05', c: '#fde047' },
    silver: { en: 'SILVER', base: '#b8c6da', light: '#ffffff', dark: '#6a7d9a', deep: '#3d4c66', c: '#cfe0f6' },
    bronze: { en: 'BRONZE', base: '#d9803c', light: '#ffd3a6', dark: '#88401a', deep: '#5a2a0e', c: '#f59a5b' },
  };
  const LOGO_FONT = '"Inter Display","Inter","Arial Black",sans-serif';
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => { const A = hex(a), B = hex(b); return 'rgb(' + A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',') + ')'; };
  const rgba = (h, a) => 'rgba(' + hex(h).join(',') + ',' + a + ')';
  function starPath(c, cx, cy, R) { c.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? R * 0.5 : R; c.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } c.closePath(); }
  // the logo star: faceted, embossed (dark offset down-right, light offset up-left), tone-on-tone with its surface
  function embStar(c, cx, cy, R, T, k) {
    const sh = () => starPath(c, cx, cy, R);
    c.save(); c.translate(k * 1.1, k * 1.1); sh(); c.fillStyle = rgba(T.deep, 0.6); c.fill(); c.restore();
    c.save(); c.translate(-k * 0.9, -k * 0.9); sh(); c.fillStyle = rgba(T.light, 0.85); c.fill(); c.restore();
    const pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? R * 0.5 : R; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    for (let i = 0; i < 10; i++) { const a = pts[i], b = pts[(i + 1) % 10]; c.beginPath(); c.moveTo(cx, cy); c.lineTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.closePath(); c.fillStyle = i % 2 ? mix(T.base, T.dark, 0.28) : mix(T.base, T.light, 0.32); c.fill(); }
    sh(); c.lineWidth = Math.max(1, R * 0.05); c.strokeStyle = mix(T.base, T.dark, 0.35); c.lineJoin = 'round'; c.stroke();
  }
  function embText(c, txt, x, y, font, T, k, align) {
    c.save(); c.font = font; c.textAlign = align || 'left'; c.textBaseline = 'middle';
    c.fillStyle = rgba(T.deep, 0.6); c.fillText(txt, x + k * 1.1, y + k * 1.1); c.fillStyle = rgba(T.light, 0.85); c.fillText(txt, x - k * 0.9, y - k * 0.9);
    const g = c.createLinearGradient(0, y - 18, 0, y + 18); g.addColorStop(0, mix(T.base, T.light, 0.25)); g.addColorStop(1, mix(T.base, T.dark, 0.2)); c.fillStyle = g; c.fillText(txt, x, y); c.restore();
  }
  function metal(c, x, y, w, h, T) { const g = c.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, T.light); g.addColorStop(0.28, T.base); g.addColorStop(0.55, mix(T.base, T.dark, 0.55)); g.addColorStop(0.78, T.base); g.addColorStop(1, mix(T.base, T.dark, 0.4)); return g; }
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function tpath(c, x, y, w, h, r, n) { c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r); c.lineTo(x + w, y + h / 2 - n); c.arc(x + w, y + h / 2, n, -Math.PI / 2, Math.PI / 2, true); c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x + w - r, y + h, r); c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r); c.lineTo(x, y + h / 2 + n); c.arc(x, y + h / 2, n, Math.PI / 2, -Math.PI / 2, true); c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r); c.closePath(); }
  // the CAReM logo lock-up (faceted star + wordmark with the little crown star on the R), embossed in palette Q
  function lockup(c, cx, cy, H, Q, k, opt) {
    opt = opt || {}; const fs = H * (opt.fs || 0.27), starR = H * (opt.sr || 0.3), gap = H * 0.05;
    c.save(); c.font = '900 ' + fs + 'px ' + LOGO_FONT; c.textBaseline = 'alphabetic'; const L = ['C', 'A', 'R', 'e', 'M'], wd = L.map((t) => c.measureText(t).width), sp = fs * 0.03; c.restore();
    let x = opt.left !== undefined ? opt.left : cx;
    embStar(c, x + starR, cy, starR, Q, k); x += starR * 2 + gap;
    const base = cy + fs * 0.36, xs = []; let px = x; L.forEach((t, i) => { xs.push(px); px += wd[i] + sp; });
    L.forEach((t, i) => {
      c.save(); c.font = '900 ' + fs + 'px ' + LOGO_FONT; c.textBaseline = 'alphabetic'; c.textAlign = 'left';
      c.fillStyle = rgba(Q.deep, 0.65); c.fillText(t, xs[i] + k * 1.1, base + k * 1.1); c.fillStyle = rgba(Q.light, 0.9); c.fillText(t, xs[i] - k * 0.9, base - k * 0.9);
      const g = c.createLinearGradient(0, base - fs * 0.75, 0, base); g.addColorStop(0, mix(Q.base, Q.light, 0.3)); g.addColorStop(1, mix(Q.base, Q.dark, 0.25)); c.fillStyle = g; c.fillText(t, xs[i], base); c.restore();
    });
    embStar(c, xs[2] + wd[2] * 0.62, base - fs * 0.98, fs * 0.2, Q, k * 0.6); // crown star like in the brand
  }
  function bow(c, x, y, s, T) {
    const g = c.createLinearGradient(0, y - s, 0, y + s * 0.6); g.addColorStop(0, T.light); g.addColorStop(0.55, T.base); g.addColorStop(1, mix(T.base, T.dark, 0.7));
    c.save(); c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = s * 0.25; c.shadowOffsetY = s * 0.12; c.fillStyle = g; c.strokeStyle = mix(T.base, T.deep, 0.6); c.lineWidth = Math.max(1.5, s * 0.06);
    for (const d of [-1, 1]) { c.beginPath(); c.moveTo(x, y); c.bezierCurveTo(x + d * s * 0.2, y - s * 1.05, x + d * s * 1.25, y - s * 0.95, x + d * s * 1.15, y - s * 0.15); c.bezierCurveTo(x + d * s * 1.05, y + s * 0.35, x + d * s * 0.35, y + s * 0.2, x, y); c.fill(); c.stroke(); }
    c.shadowColor = 'transparent'; c.fillStyle = g; c.beginPath(); c.arc(x, y - s * 0.02, s * 0.3, 0, TAU); c.fill(); c.stroke(); c.fillStyle = 'rgba(255,255,255,.5)'; c.beginPath(); c.arc(x - s * 0.08, y - s * 0.1, s * 0.08, 0, TAU); c.fill(); c.restore();
  }
  function ribbonV(c, x, y0, y1, w, T) {
    const g = c.createLinearGradient(x - w / 2, 0, x + w / 2, 0); g.addColorStop(0, mix(T.base, T.dark, 0.6)); g.addColorStop(0.3, T.light); g.addColorStop(0.55, T.base); g.addColorStop(1, mix(T.base, T.dark, 0.6));
    c.fillStyle = g; c.fillRect(x - w / 2, y0, w, y1 - y0); c.strokeStyle = rgba(T.deep, 0.5); c.lineWidth = 1.5; c.strokeRect(x - w / 2, y0, w, y1 - y0);
  }
  function dust(c, w, h, n, seed0) { let sd = seed0; const r = () => (sd = (sd * 16807) % 2147483647) / 2147483647; for (let i = 0; i < n; i++) { c.fillStyle = 'rgba(255,255,255,' + (0.2 + r() * 0.6) + ')'; c.beginPath(); c.arc(r() * w, r() * h, r() * 1.8 * S0 + 0.4, 0, TAU); c.fill(); } }

  // ── ticket face: tier-coloured metal frame + purple galaxy window + bow (design 2) ──
  function face(w, h, T) {
    const o = document.createElement('canvas'); o.width = w; o.height = h; const c = o.getContext('2d'), r = 26, n = 17;
    tpath(c, 0, 0, w, h, r, n); c.fillStyle = metal(c, 0, 0, w, h, T); c.fill(); c.save(); c.clip();
    const wx = 20, wy = 20, ww = w - 40, wh = h - 40; rr(c, wx, wy, ww, wh, 14); c.fillStyle = '#16093a'; c.fill(); c.save(); c.clip();
    const gs = [['#7c3aed', 0.30, 0.35, 0.5], ['#ec4899', 0.7, 0.7, 0.35], ['#22d3ee', 0.85, 0.25, 0.3], ['#6366f1', 0.15, 0.8, 0.35]];
    for (const [col, fx, fy, fr] of gs) { const gr = c.createRadialGradient(wx + ww * fx, wy + wh * fy, 2, wx + ww * fx, wy + wh * fy, ww * fr * 0.6); gr.addColorStop(0, col + 'cc'); gr.addColorStop(1, col + '00'); c.fillStyle = gr; c.fillRect(wx, wy, ww, wh); }
    dust(c, w, h, 70, 9);
    const gl = c.createRadialGradient(w * 0.2, h * 0.5, 2, w * 0.2, h * 0.5, h * 0.5); gl.addColorStop(0, 'rgba(253,224,71,.35)'); gl.addColorStop(1, 'rgba(253,224,71,0)'); c.fillStyle = gl; c.fillRect(wx, wy, ww, wh);
    lockup(c, 0, h * 0.5, h, T, 3.2, { left: w * 0.075, fs: 0.25, sr: 0.29 }); embText(c, 'LUCKY TICKET · ' + T.en, w * 0.075 + h * 0.64, h * 0.8, '800 ' + Math.round(h * 0.07) + 'px sans-serif', T, 1.1);
    c.restore(); c.strokeStyle = rgba(T.deep, 0.6); c.lineWidth = 4; rr(c, wx, wy, ww, wh, 14); c.stroke(); c.strokeStyle = rgba(T.light, 0.85); c.lineWidth = 1.4; rr(c, wx - 2, wy - 2, ww + 4, wh + 4, 16); c.stroke();
    c.restore(); bow(c, w * 0.5, h * 0.15, h * 0.1, T);
    c.save(); c.globalCompositeOperation = 'source-atop'; const sh = c.createLinearGradient(0, 0, w * 0.6, h); sh.addColorStop(0, 'rgba(255,255,255,.28)'); sh.addColorStop(0.35, 'rgba(255,255,255,.04)'); sh.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = sh; c.fillRect(0, 0, w, h); c.restore();
    return o;
  }
  const artCache = {};
  // 3D: extruded thickness + soft shadow (cached per tier/size — it is the expensive part)
  function art(W, H, tier) {
    const key = tier + W + 'x' + H; if (artCache[key]) return artCache[key];
    const T = TI[tier], ex = 9 * S0, F = face(W - ex, H - ex, T), o = document.createElement('canvas'); o.width = W; o.height = H; const c = o.getContext('2d');
    c.save(); c.globalAlpha = 0.5; c.filter = 'blur(6px) brightness(0)'; c.drawImage(F, ex * 0.6, ex * 1.1); c.restore();
    for (let d = ex; d >= 1; d--) { c.save(); c.filter = 'brightness(.5)'; c.drawImage(F, d, d); c.restore(); }
    c.drawImage(F, 0, 0); return (artCache[key] = o);
  }
  // ── jigsaw pieces (3×3) ──
  const sH = (r, c) => ((r + c) % 2 === 0 ? 1 : -1), sV = (r, c) => ((r + c) % 2 === 0 ? -1 : 1);
  function edge(c, x0, y0, x1, y1, b, k) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L, nx = uy, ny = -ux;
    if (!b) { c.lineTo(x1, y1); return; }
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, P = (a, v) => [mx + ux * a * k + nx * v * k * b, my + uy * a * k + ny * v * k * b];
    c.lineTo(...P(-0.12, 0)); c.bezierCurveTo(...P(-0.12, 0.08), ...P(-0.2, 0.08), ...P(-0.2, 0.17)); c.bezierCurveTo(...P(-0.2, 0.3), ...P(0.2, 0.3), ...P(0.2, 0.17));
    c.bezierCurveTo(...P(0.2, 0.08), ...P(0.12, 0.08), ...P(0.12, 0)); c.lineTo(x1, y1);
  }
  function piecePath(c, i, W, H) {
    const cols = 3, rows = 3, w = W / cols, h = H / rows, r = Math.floor(i / 3), cI = i % 3, x = cI * w, y = r * h, k = Math.min(w, h) * 1.05;
    const top = r > 0 ? -sH(r - 1, cI) : 0, right = cI < 2 ? sV(r, cI) : 0, bottom = r < 2 ? sH(r, cI) : 0, left = cI > 0 ? -sV(r, cI - 1) : 0;
    c.beginPath(); c.moveTo(x, y); edge(c, x, y, x + w, y, top, k); edge(c, x + w, y, x + w, y + h, right, k); edge(c, x + w, y + h, x, y + h, bottom, k); edge(c, x, y + h, x, y, left, k); c.closePath();
  }
  const ORDER = [4, 0, 2, 6, 8, 1, 3, 5, 7];
  /** the ticket picture of one tier with n of its 9 pieces revealed (frosted ghost for the rest). n>=9 = complete. */
  function ticketCanvas(tier, n, cw, ch, perTicket) {
    const S = 2, W = cw * S, H = ch * S, T = TI[tier]; n = Math.max(0, Math.min(9, n | 0));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
    const c = cv.getContext('2d'), A = art(W, H, tier);
    c.save(); c.globalAlpha = 0.3; c.filter = 'grayscale(.55) brightness(.9)'; c.drawImage(A, 0, 0); c.restore();
    const have = new Set(ORDER.slice(0, n));
    ORDER.forEach((i) => { if (!have.has(i)) return; c.save(); piecePath(c, i, W, H); c.clip(); c.drawImage(A, 0, 0); c.restore(); });
    for (let i = 0; i < 9; i++) { c.save(); piecePath(c, i, W, H); if (have.has(i)) { c.strokeStyle = n >= 9 ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.32)'; c.lineWidth = 1.4; } else { c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 1.6; c.setLineDash([7, 6]); } c.stroke(); c.restore(); }
    if (n > 0 && n < 9) { const i = ORDER[n - 1]; c.save(); piecePath(c, i, W, H); c.strokeStyle = T.c; c.lineWidth = 4; c.shadowColor = T.c; c.shadowBlur = 18; c.stroke(); c.restore(); }
    return cv;
  }
  // small purple ticket icon (filled = a completed ticket)
  function mini(tier, filled) {
    const T = TI[tier], S = 3, w = 30, h = 18, cv = document.createElement('canvas'); cv.width = w * S; cv.height = h * S; cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const c = cv.getContext('2d'), W = w * S, H = h * S; tpath(c, 0, 0, W, H, 10, 5 * S * 0.9);
    if (filled) {
      const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#a176f7'); g.addColorStop(1, '#34177d'); c.fillStyle = g; c.fill(); c.save(); c.clip(); ribbonV(c, W * 0.72, 0, H, W * 0.16, T); c.restore();
      embStar(c, W * 0.3, H / 2 + 1, H * 0.3, { base: '#7c4ddb', light: '#d3c0ff', dark: '#3b1d8a', deep: '#1c0a52' }, 1.1); c.strokeStyle = metal(c, 0, 0, W, H, T); c.lineWidth = 2.5; tpath(c, 1.5, 1.5, W - 3, H - 3, 9, 4); c.stroke();
    } else { c.fillStyle = 'rgba(255,255,255,.04)'; c.fill(); c.setLineDash([5, 4]); c.strokeStyle = 'rgba(255,255,255,.3)'; c.lineWidth = 2; c.stroke(); }
    return cv;
  }
  // coin with the embossed logo star
  function coin(size) {
    const S = 3, W = size * S, cv = document.createElement('canvas'); cv.width = cv.height = W; cv.style.width = cv.style.height = size + 'px'; cv.className = 'coin-ico';
    const c = cv.getContext('2d'), m = W / 2;
    let g = c.createLinearGradient(0, 0, W, W); g.addColorStop(0, '#fff6bf'); g.addColorStop(0.5, '#f2b92e'); g.addColorStop(1, '#8f520a'); c.fillStyle = g; c.beginPath(); c.arc(m, m, m - 1, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(90,50,5,.55)'; c.lineWidth = W * 0.02; c.beginPath(); c.arc(m, m, m * 0.86, 0, TAU); c.stroke();
    g = c.createRadialGradient(m * 0.8, m * 0.7, 2, m, m, m * 0.85); g.addColorStop(0, '#ffe27a'); g.addColorStop(1, '#d89a1c'); c.fillStyle = g; c.beginPath(); c.arc(m, m, m * 0.82, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = W * 0.014; c.beginPath(); c.arc(m, m, m * 0.82, Math.PI * 1.05, Math.PI * 1.65); c.stroke();
    embStar(c, m, m + W * 0.01, m * 0.58, { base: '#e8a823', light: '#fff2b0', dark: '#8f520a', deep: '#6b3a05' }, Math.max(1.2, W * 0.016));
    return cv;
  }
  // the purple gift box (SVG string, no inline style attributes: the CSP forbids them)
  function boxSVG(id) {
    return `<svg viewBox="0 0 100 112" aria-hidden="true"><defs><linearGradient id="gb${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#3b1d8a"/></linearGradient><linearGradient id="gl${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset="1" stop-color="#6d3fd0"/></linearGradient><linearGradient id="gr${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3a8"/><stop offset="1" stop-color="#d97706"/></linearGradient><filter id="gg${id}"><feGaussianBlur stdDeviation="5"/></filter></defs><ellipse cx="50" cy="104" rx="34" ry="5" fill="rgba(0,0,0,.55)"/><circle cx="50" cy="62" r="40" fill="rgba(168,85,247,.55)" filter="url(#gg${id})"/><rect x="12" y="50" width="76" height="52" rx="7" fill="url(#gb${id})"/><rect x="7" y="36" width="86" height="19" rx="6" fill="url(#gl${id})"/><rect x="43" y="36" width="14" height="66" fill="url(#gr${id})"/><path d="M50 36 C28 8 12 24 30 34 C38 38 46 37 50 36Z M50 36 C72 8 88 24 70 34 C62 38 54 37 50 36Z" fill="url(#gr${id})" stroke="#b45309" stroke-width="1.2"/><circle cx="50" cy="35" r="6" fill="#fde047" stroke="#b45309" stroke-width="1"/><path d="M16 54 L30 54 L20 98 L16 98Z" fill="rgba(255,255,255,.18)"/></svg>`;
  }
  // a tier gem used in the "which piece did you get" reveal
  function gem(tier, size) {
    const T = TI[tier], S = 3, W = size * S, cv = document.createElement('canvas'); cv.width = cv.height = W; cv.style.width = cv.style.height = size + 'px'; const c = cv.getContext('2d');
    c.save(); c.shadowColor = T.c; c.shadowBlur = W * 0.14; embStar(c, W / 2, W / 2, W * 0.42, T, Math.max(1.4, W * 0.02)); c.restore(); return cv;
  }
  window.LotteryArt = { ticketCanvas, mini, coin, boxSVG, gem, TI };
})();
