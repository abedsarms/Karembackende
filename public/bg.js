'use strict';
/* Animated galaxy background: a slowly rotating spiral galaxy + Milky-Way nebula, twinkling dust,
   floating golden "stars" of many sizes and floating gift boxes. Everything is drawn with canvas
   (no external images), pauses when the tab is hidden and respects prefers-reduced-motion. */
(() => {
  const canvas = document.getElementById('galaxy');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TAU = Math.PI * 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  let W = 0, H = 0, dpr = 1, K = 1;
  let bgLayer = null, spiral = null, spiralR = 0, spiralPos = { x: 0, y: 0 };
  let dust = [], stars = [], gifts = [], shooting = null, nextShoot = 4;

  // ───────── sprites (drawn once, then blitted every frame) ─────────
  function starSprite(light, dark, edge) {
    const S = 96, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
    const cx = S / 2, cy = S / 2 + 2, R = S * 0.36, r = R * 0.5;
    const pts = [];
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rad = i % 2 ? r : R; pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); }
    // soft glow
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, S / 2);
    glow.addColorStop(0, 'rgba(255,214,90,.55)'); glow.addColorStop(0.45, 'rgba(255,170,40,.16)'); glow.addColorStop(1, 'rgba(255,170,40,0)');
    g.fillStyle = glow; g.fillRect(0, 0, S, S);
    // faceted body (alternating light / dark triangles like the Telegram Stars icon)
    g.lineJoin = 'round'; g.lineCap = 'round';
    for (let i = 0; i < 10; i++) {
      const a = pts[i], b = pts[(i + 1) % 10];
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.closePath();
      g.fillStyle = i % 2 ? dark : light; g.fill();
    }
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath();
    g.lineWidth = 3.2; g.strokeStyle = edge; g.stroke();
    // specular highlight
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1] + 3); g.lineTo(cx - R * 0.16, cy - R * 0.28); g.lineTo(cx + R * 0.16, cy - R * 0.28); g.closePath();
    g.fillStyle = 'rgba(255,255,255,.5)'; g.fill();
    return c;
  }
  function giftSprite(body, bodyDark, lid, ribbon, ribbonDark) {
    const S = 112, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
    const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    const bx = 22, bw = 68, by = 50, bh = 46;
    const glow = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
    glow.addColorStop(0, 'rgba(255,255,255,.14)'); glow.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = glow; g.fillRect(0, 0, S, S);
    // box
    let gr = g.createLinearGradient(bx, by, bx + bw, by + bh); gr.addColorStop(0, body); gr.addColorStop(1, bodyDark);
    rr(bx, by, bw, bh, 7); g.fillStyle = gr; g.fill();
    // lid
    gr = g.createLinearGradient(0, by - 14, 0, by + 4); gr.addColorStop(0, lid); gr.addColorStop(1, body);
    rr(bx - 4, by - 14, bw + 8, 18, 6); g.fillStyle = gr; g.fill();
    // ribbon
    gr = g.createLinearGradient(S / 2 - 7, 0, S / 2 + 7, 0); gr.addColorStop(0, ribbonDark); gr.addColorStop(0.5, ribbon); gr.addColorStop(1, ribbonDark);
    g.fillStyle = gr; g.fillRect(S / 2 - 7, by - 14, 14, bh + 14);
    // bow
    g.fillStyle = ribbon; g.strokeStyle = ribbonDark; g.lineWidth = 2.5;
    for (const dir of [-1, 1]) { g.save(); g.translate(S / 2, by - 14); g.rotate(dir * 0.5); g.beginPath(); g.ellipse(dir * 11, -7, 13, 8, 0, 0, TAU); g.fill(); g.stroke(); g.restore(); }
    g.beginPath(); g.arc(S / 2, by - 15, 6, 0, TAU); g.fillStyle = ribbonDark; g.fill();
    // shine
    g.fillStyle = 'rgba(255,255,255,.22)'; rr(bx + 5, by + 5, 9, bh - 14, 4); g.fill();
    return c;
  }
  let starSprites = [], giftSprites = [];
  function buildSprites() {
    starSprites = [starSprite('#ffe98a', '#ffb52e', '#ff9d00'), starSprite('#fff0a8', '#ffc247', '#ffab1a'), starSprite('#ffd86b', '#f59e0b', '#e58a00'), starSprite('#d9ecff', '#8fb8ff', '#6b9cff')];
    giftSprites = [giftSprite('#4cc2ff', '#2a7fe0', '#7ad6ff', '#fff2a8', '#ffc247'), giftSprite('#ff7ac6', '#d63b94', '#ff9bd6', '#fff2a8', '#ffc247'),
      giftSprite('#9b7bff', '#5b3fd6', '#b8a0ff', '#ffe27a', '#f5a623'), giftSprite('#ffc247', '#e08a00', '#ffd97a', '#ff5d8f', '#c9275f'), giftSprite('#46e0a8', '#1a9d70', '#7df0c6', '#ffffff', '#b8c4d6')];
  }

  // ───────── static layers ─────────
  function buildBackground() {
    bgLayer = document.createElement('canvas'); bgLayer.width = Math.ceil(W * dpr); bgLayer.height = Math.ceil(H * dpr);
    const g = bgLayer.getContext('2d'); g.scale(dpr, dpr);
    const base = g.createLinearGradient(0, 0, W * 0.3, H); base.addColorStop(0, '#04030d'); base.addColorStop(0.45, '#0d0824'); base.addColorStop(1, '#070518');
    g.fillStyle = base; g.fillRect(0, 0, W, H);
    // Milky-Way band: many soft coloured blobs along a diagonal
    g.globalCompositeOperation = 'lighter';
    const ang = -0.62, ca = Math.cos(ang), sa = Math.sin(ang), len = Math.hypot(W, H);
    const pal = ['110,70,255', '70,120,255', '210,70,200', '60,190,255', '255,150,60', '150,90,255'];
    for (let i = 0; i < 70; i++) {
      const u = rnd(-0.6, 0.6) * len, v = rnd(-1, 1) * (Math.min(W, H) * 0.28) * (1 - Math.abs(u) / len);
      const x = W * 0.45 + u * ca - v * sa, y = H * 0.5 + u * sa + v * ca, r = rnd(70, 230) * K;
      const col = pick(pal), a = rnd(0.06, 0.16) * (1 - Math.abs(u) / (len * 0.75));
      const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, `rgba(${col},${a})`); rg.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // dark dust lanes through the band
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 18; i++) {
      const u = rnd(-0.5, 0.5) * len, x = W * 0.45 + u * ca, y = H * 0.5 + u * sa, r = rnd(40, 120) * K;
      const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, 'rgba(4,3,13,.35)'); rg.addColorStop(1, 'rgba(4,3,13,0)');
      g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // thousands of fixed tiny stars (denser along the band)
    for (let i = 0; i < Math.round((W * H) / 700); i++) {
      const x = rnd(0, W), y = rnd(0, H);
      const d = Math.abs((x - W * 0.45) * sa - (y - H * 0.5) * ca) / (Math.min(W, H) * 0.4);
      if (Math.random() > 0.35 + 0.65 * Math.max(0, 1 - d)) continue;
      g.fillStyle = `rgba(${pick(['255,255,255', '200,220,255', '255,235,200'])},${rnd(0.15, 0.7)})`;
      g.fillRect(x, y, rnd(0.4, 1.2), rnd(0.4, 1.2));
    }
  }
  function buildSpiral() {
    spiralR = Math.min(W, H) * 0.5 + 40; spiralPos = { x: W * 0.78, y: H * 0.2 };
    const S = Math.ceil(spiralR * 2); spiral = document.createElement('canvas'); spiral.width = spiral.height = S; const g = spiral.getContext('2d');
    const c = S / 2; g.globalCompositeOperation = 'lighter';
    const core = g.createRadialGradient(c, c, 0, c, c, spiralR * 0.45);
    core.addColorStop(0, 'rgba(255,245,215,1)'); core.addColorStop(0.25, 'rgba(255,190,110,.5)'); core.addColorStop(1, 'rgba(255,150,80,0)');
    g.fillStyle = core; g.fillRect(0, 0, S, S);
    const haze = g.createRadialGradient(c, c, 0, c, c, spiralR); haze.addColorStop(0, 'rgba(130,110,255,.3)'); haze.addColorStop(1, 'rgba(80,100,255,0)');
    g.fillStyle = haze; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 4200; i++) {
      const t = Math.pow(Math.random(), 0.75), arm = (Math.random() < 0.5 ? 0 : Math.PI), th = t * 6 + arm + rnd(-0.28, 0.28) * (0.4 + t);
      const r = t * spiralR, x = c + Math.cos(th) * r, y = c + Math.sin(th) * r;
      const warm = 1 - t, R = 150 + warm * 105, G = 160 + warm * 60, B = 255 - warm * 120;
      g.fillStyle = `rgba(${R | 0},${G | 0},${B | 0},${rnd(0.2, 0.9) * (1 - t * 0.5)})`;
      const s = rnd(0.5, 1.9) * (1 - t * 0.3); g.fillRect(x, y, s, s);
    }
    // glowing star clusters on the arms
    for (let i = 0; i < 26; i++) {
      const t = rnd(0.25, 0.95), th = t * 6 + (Math.random() < 0.5 ? 0 : Math.PI), r = t * spiralR, x = c + Math.cos(th) * r, y = c + Math.sin(th) * r, rad = rnd(5, 14);
      const rg = g.createRadialGradient(x, y, 0, x, y, rad); rg.addColorStop(0, 'rgba(190,210,255,.35)'); rg.addColorStop(1, 'rgba(120,140,255,0)');
      g.fillStyle = rg; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  }

  // ───────── particles ─────────
  function makeParticles() {
    const area = W * H, density = Math.min(1.6, Math.max(0.7, area / (390 * 844)));
    dust = Array.from({ length: Math.round(area / 5200) }, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(0.4, 1.5), ph: rnd(0, TAU), sp: rnd(0.8, 3.2), c: pick(['255,255,255', '190,215,255', '255,230,190', '255,200,240']), glint: Math.random() < 0.06 }));
    stars = Array.from({ length: Math.round(20 * density) }, () => {
      const d = Math.pow(Math.random(), 1.6);              // depth 0 (far/small) … 1 (near/big)
      const size = (8 + d * 34) * K;
      return { x: rnd(0, W), y: rnd(0, H), size, d, vy: -(4 + d * 16) * K, amp: rnd(6, 26) * K, sw: rnd(0.2, 0.7), ph: rnd(0, TAU), rot: rnd(0, TAU), vr: rnd(-0.5, 0.5) * (1.2 - d * 0.6), tw: rnd(1, 2.6), spr: Math.random() < 0.12 ? 3 : (Math.random() * 3) | 0, alpha: 0.4 + d * 0.55 };
    });
    gifts = Array.from({ length: Math.round(7 * density) }, () => {
      const d = Math.pow(Math.random(), 1.2), size = (26 + d * 30) * K;
      return { x: rnd(0, W), y: rnd(0, H), size, d, vy: -(5 + d * 12) * K, amp: rnd(10, 30) * K, sw: rnd(0.15, 0.45), ph: rnd(0, TAU), rot: rnd(-0.4, 0.4), tilt: rnd(0.12, 0.35), tsp: rnd(0.4, 1), spr: (Math.random() * giftSprites.length) | 0, alpha: 0.55 + d * 0.4 };
    });
    // far → near so big ones draw on top
    stars.sort((a, b) => a.d - b.d); gifts.sort((a, b) => a.d - b.d);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight; K = Math.min(1.5, Math.max(0.8, Math.min(W, 520) / 400));
    canvas.width = Math.ceil(W * dpr); canvas.height = Math.ceil(H * dpr);
    buildBackground(); buildSpiral(); makeParticles(); draw(performance.now() / 1000);
  }

  // ───────── drawing ─────────
  function sparkle(x, y, r, a) {
    ctx.save(); ctx.translate(x, y); ctx.globalAlpha = a; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(0, -r); ctx.quadraticCurveTo(r * 0.12, -r * 0.12, r, 0); ctx.quadraticCurveTo(r * 0.12, r * 0.12, 0, r); ctx.quadraticCurveTo(-r * 0.12, r * 0.12, -r, 0); ctx.quadraticCurveTo(-r * 0.12, -r * 0.12, 0, -r); ctx.fill(); ctx.restore();
  }
  let last = 0;
  function draw(t) {
    const dt = Math.min(0.05, t - last || 0.016); last = t;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bgLayer, 0, 0, W, H);
    // rotating spiral galaxy
    ctx.save(); ctx.translate(spiralPos.x, spiralPos.y); ctx.rotate(-0.5); ctx.scale(1, 0.5); ctx.rotate(t * 0.025); ctx.globalAlpha = 1;
    ctx.drawImage(spiral, -spiralR, -spiralR); ctx.restore();
    // twinkling dust
    for (const s of dust) {
      const a = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph));
      ctx.globalAlpha = a; ctx.fillStyle = `rgb(${s.c})`; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
      if (s.glint && a > 0.85) sparkle(s.x, s.y, 5 + s.r * 3, (a - 0.85) * 5);
    }
    // shooting star
    nextShoot -= dt;
    if (!shooting && nextShoot <= 0 && !reduce) { shooting = { x: rnd(W * 0.2, W), y: rnd(0, H * 0.35), vx: -rnd(380, 560), vy: rnd(150, 260), life: 0 }; nextShoot = rnd(5, 11); }
    if (shooting) {
      const s = shooting; s.life += dt; s.x += s.vx * dt; s.y += s.vy * dt;
      const fade = Math.max(0, 1 - s.life / 0.9), len = 0.12;
      const g = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * len, s.y - s.vy * len); g.addColorStop(0, `rgba(255,255,255,${fade})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 1; ctx.strokeStyle = g; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * len, s.y - s.vy * len); ctx.stroke();
      if (s.life > 0.9) shooting = null;
    }
    // golden stars + gifts, far → near
    const all = stars.concat(gifts).sort((a, b) => a.d - b.d);
    for (const p of all) {
      if (!reduce) { p.y += p.vy * dt; if (p.y < -p.size * 2) { p.y = H + p.size * 2; p.x = rnd(0, W); } }
      const x = p.x + Math.sin(t * p.sw + p.ph) * p.amp, y = p.y + (p.tsp ? Math.cos(t * p.sw * 1.3 + p.ph) * 6 * K : 0);
      ctx.save(); ctx.translate(x, y);
      if (p.tw) { // star: spin, pulse, twinkle
        const pulse = 1 + 0.08 * Math.sin(t * p.tw + p.ph), tw = 0.75 + 0.25 * Math.sin(t * p.tw * 1.7 + p.ph);
        if (!reduce) p.rot += p.vr * dt;
        ctx.rotate(p.rot); ctx.globalAlpha = p.alpha * tw; const s = p.size * pulse * 1.9; ctx.drawImage(starSprites[p.spr], -s / 2, -s / 2, s, s);
        ctx.restore(); if (p.size > 20 * K && tw > 0.95) sparkle(x + p.size * 0.35, y - p.size * 0.35, p.size * 0.28, (tw - 0.95) * 18);
        continue;
      }
      // gift: gentle sway + bob
      ctx.rotate(p.rot + Math.sin(t * p.tsp + p.ph) * p.tilt); ctx.globalAlpha = p.alpha; const s = p.size * 1.9; ctx.drawImage(giftSprites[p.spr], -s / 2, -s / 2, s, s); ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ───────── loop ─────────
  let raf = 0, running = false;
  function frame(ms) { draw(ms / 1000); raf = requestAnimationFrame(frame); }
  function start() { if (running || reduce) return; running = true; last = performance.now() / 1000; raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  let rt = 0; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); });

  buildSprites(); resize(); start();
})();
