/* Hero demo: a 3-joint planar arm that tracks the pointer with closed-form inverse kinematics.
   Near the floor the gripper points down so it can pick things up; reaching far, it points outward. The shoulder
   and elbow are then solved analytically (elbow up), and the joints move toward the solution with smoothing, as a
   joint-space controller would. Hold the mouse button (or tap near the gripper on touch screens) to grip and carry
   the block. World units are millimetres, y up, with the base at the origin. */
(() => {
  const canvas = document.getElementById('arm-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const zone = canvas.closest('[data-arm-zone]') || canvas;
  const statusEl = document.getElementById('arm-status');
  const out = {
    t1: document.getElementById('arm-t1'),
    t2: document.getElementById('arm-t2'),
    t3: document.getElementById('arm-t3'),
    ee: document.getElementById('arm-ee'),
  };
  const hint = document.getElementById('arm-hint');

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (hint) {
    hint.textContent = finePointer
      ? 'Move your cursor to steer the arm. Hold the mouse button to grip and carry the block.'
      : 'Drag on the panel to steer the arm. Tap near the gripper to grab or drop the block.';
  }

  const L = [150, 120, 70];
  const TIP = 12;          // gripper centre, beyond the last joint
  const REACH = L[0] + L[1] + L[2];
  const MIN_Y = 10;        // lowest point the gripper is asked to reach: the block's centre
  const C = {
    accent: '#00e5ff',
    accentDim: 'rgba(0,229,255,.28)',
    warm: '#ffb547',
    ink: '#0b1324',
    grid: 'rgba(120,160,255,.055)',
    gridMajor: 'rgba(120,160,255,.11)',
    text: 'rgba(163,176,204,.85)',
    faint: 'rgba(124,137,168,.8)',
  };

  // Joint angles in radians: the shoulder is absolute, the elbow and wrist relative to the previous link.
  const q = [1.3, -0.9, -1.2];
  const pts = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  let elbowSign = -1, reachable = true;
  const goal = { x: 190, y: 120 };      // where the pointer asks the arm to go
  const target = { x: 190, y: 120 };    // smoothed goal the solver chases
  const cube = { x: -150, y: 11, vy: 0, held: false, size: 22, home: -150 };
  const trail = [];
  let grip = 0;          // 0 open, 1 closed (animated)
  let gripWanted = false;
  let lastInput = -1e9;  // time of the last pointer or key input
  let w = 0, h = 0, dpr = 1, s = 1, ox = 0, oy = 0;
  let gridLayer = null;
  let running = false, visible = true, lastT = 0, lastReadout = 0;

  const toWorld = (px, py) => ({ x: (px - ox) / s, y: (oy - py) / s });
  const toScreen = (p) => [ox + p.x * s, oy - p.y * s];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    s = Math.min(w / (2 * (REACH + 12)), (h - 44) / (REACH + 30));
    ox = w / 2; oy = h - 34;
    buildGrid();
    draw();
  }

  function buildGrid() {
    gridLayer = document.createElement('canvas');
    gridLayer.width = canvas.width; gridLayer.height = canvas.height;
    const g = gridLayer.getContext('2d');
    g.scale(dpr, dpr);
    const step = 20 * s;
    for (let i = -Math.ceil(ox / step); ox + i * step <= w; i++) {
      const x = Math.round(ox + i * step) + .5;
      g.strokeStyle = i % 5 === 0 ? C.gridMajor : C.grid;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
    for (let j = 0; oy - j * step >= 0; j++) {
      const y = Math.round(oy - j * step) + .5;
      g.strokeStyle = j % 5 === 0 ? C.gridMajor : C.grid;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }
  }

  // ---------- Kinematics ----------
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const smoothstep = (e0, e1, x) => { const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };

  function fk() {
    let a = q[0];
    pts[1] = { x: L[0] * Math.cos(a), y: L[0] * Math.sin(a) };
    a += q[1];
    pts[2] = { x: pts[1].x + L[1] * Math.cos(a), y: pts[1].y + L[1] * Math.sin(a) };
    a += q[2];
    pts[3] = { x: pts[2].x + L[2] * Math.cos(a), y: pts[2].y + L[2] * Math.sin(a) };
  }

  /** Joint angles that put the gripper centre on t, and whether t is reachable. */
  function ik(t) {
    const d = Math.hypot(t.x, t.y), outward = Math.atan2(t.y, t.x), down = -Math.PI / 2;
    const phiPref = down + wrap(outward - down) * smoothstep(170, 310, d);
    for (const phi of [phiPref, outward]) {
      const wx = t.x - (L[2] + TIP) * Math.cos(phi), wy = t.y - (L[2] + TIP) * Math.sin(phi);
      const dw = Math.hypot(wx, wy);
      if (dw > L[0] + L[1] - .5 || dw < Math.abs(L[0] - L[1]) + .5) continue;
      const c = Math.max(-1, Math.min(1, (dw * dw - L[0] * L[0] - L[1] * L[1]) / (2 * L[0] * L[1])));
      const sols = [-1, 1].map((sg) => {
        const e = sg * Math.acos(c);
        const sh = Math.atan2(wy, wx) - Math.atan2(L[1] * Math.sin(e), L[0] + L[1] * Math.cos(e));
        return { sg, sh, e, ey: L[0] * Math.sin(sh) };
      });
      let pick = sols.find((o) => o.sg === elbowSign);
      const other = sols.find((o) => o.sg !== elbowSign);
      if (other.ey > pick.ey + 25 || pick.ey < 8) pick = other; // keep the elbow up, with hysteresis
      elbowSign = pick.sg;
      return { q: [pick.sh, pick.e, wrap(phi - pick.sh - pick.e)], ok: true };
    }
    return { q: [outward, 0, 0], ok: false }; // out of reach: point the whole arm at the target
  }

  const deg = (r) => (r * 180 / Math.PI);

  // ---------- Input ----------
  function setGoalFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    const p = toWorld(e.clientX - r.left, e.clientY - r.top);
    goal.x = Math.max(-REACH - 60, Math.min(REACH + 60, p.x));
    goal.y = Math.max(MIN_Y, Math.min(REACH + 60, p.y));
    lastInput = performance.now();
    wake();
  }
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && e.target !== canvas) return;
    setGoalFromEvent(e);
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      // A tap near the gripper toggles the grip; anywhere else steers the arm.
      const r = canvas.getBoundingClientRect();
      const tip = toScreen(tipPoint());
      if (Math.hypot(e.clientX - r.left - tip[0], e.clientY - r.top - tip[1]) < 44) {
        gripWanted = !gripWanted;
        tryGrip();
      } else {
        setGoalFromEvent(e);
      }
      lastInput = performance.now();
      wake();
      return;
    }
    canvas.setPointerCapture?.(e.pointerId);
    gripWanted = true;
    tryGrip();
    setGoalFromEvent(e);
  });
  const releaseGrip = (e) => {
    if (e && e.pointerType === 'touch') return;
    gripWanted = false;
    if (cube.held) { cube.held = false; cube.vy = 0; }
    wake();
  };
  canvas.addEventListener('pointerup', releaseGrip);
  canvas.addEventListener('pointercancel', releaseGrip);
  // Keyboard: arrows steer, Space or Enter toggles the grip.
  const nudge = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, 12], ArrowDown: [0, -12] };
  canvas.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); gripWanted = !gripWanted; tryGrip(); }
    else if (nudge[e.key]) {
      e.preventDefault();
      goal.x = Math.max(-REACH - 60, Math.min(REACH + 60, goal.x + nudge[e.key][0]));
      goal.y = Math.max(MIN_Y, Math.min(REACH + 60, goal.y + nudge[e.key][1]));
    } else return;
    lastInput = performance.now();
    wake();
  });

  function tipPoint() {
    const a = q[0] + q[1] + q[2];
    return { x: pts[3].x + Math.cos(a) * TIP, y: pts[3].y + Math.sin(a) * TIP };
  }
  function tryGrip() {
    if (!gripWanted) { if (cube.held) { cube.held = false; cube.vy = 0; } return; }
    if (!cube.held && dist(tipPoint(), cube) < 20) cube.held = true;
  }

  // ---------- Simulation ----------
  function step(dt, now) {
    const idle = now - lastInput > 3200 && !cube.held;
    if (idle && !reduced) {
      const t = now / 1000;
      goal.x = 175 * Math.sin(t * .55);
      goal.y = 165 + 95 * Math.sin(t * .9 + 1.1);
    }
    const k = 1 - Math.exp(-dt * (idle ? 3 : 12));
    target.x += (goal.x - target.x) * k;
    target.y += (goal.y - target.y) * k;
    const sol = ik(target);
    reachable = sol.ok;
    const kq = 1 - Math.exp(-dt * (idle ? 4 : 10));
    for (let i = 0; i < 3; i++) q[i] += wrap(sol.q[i] - q[i]) * kq;
    fk();

    grip += ((gripWanted || cube.held ? 1 : 0) - grip) * (1 - Math.exp(-dt * 14));
    if (gripWanted && !cube.held) tryGrip();

    if (cube.held) {
      const tp = tipPoint();
      cube.x = tp.x; cube.y = Math.max(cube.size / 2, tp.y);
    } else if (cube.y > cube.size / 2 || cube.vy !== 0) {
      cube.vy -= 1800 * dt;
      cube.y += cube.vy * dt;
      if (cube.y <= cube.size / 2) {
        cube.y = cube.size / 2;
        cube.vy = Math.abs(cube.vy) > 140 ? -cube.vy * .28 : 0;
      }
    }
    if (Math.abs(cube.x) > REACH + 20 && !cube.held && cube.vy === 0) { cube.x = cube.home; cube.y = 160; }

    trail.push(tipPoint());
    if (trail.length > 46) trail.shift();

    const state = cube.held ? 'grip' : idle ? 'idle' : reachable ? 'track' : 'reach';
    if (now - lastReadout > 90) { readout(state); lastReadout = now; }
    return idle;
  }

  function readout(state) {
    const tp = tipPoint();
    if (out.t1) out.t1.textContent = `${deg(wrap(q[0])).toFixed(1)}°`;
    if (out.t2) out.t2.textContent = `${deg(wrap(q[1])).toFixed(1)}°`;
    if (out.t3) out.t3.textContent = `${deg(wrap(q[2])).toFixed(1)}°`;
    if (out.ee) out.ee.textContent = `${Math.round(tp.x)}, ${Math.round(tp.y)}`;
    if (statusEl && statusEl.dataset.state !== state) {
      statusEl.dataset.state = state;
      statusEl.textContent = { track: 'Tracking', reach: 'Out of reach', idle: 'Demo', grip: 'Gripping' }[state];
    }
  }

  // ---------- Drawing ----------
  function draw(now = performance.now()) {
    if (!w) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (gridLayer) ctx.drawImage(gridLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // Workspace boundary
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = C.accentDim;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ox, oy, REACH * s, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = C.faint;
    ctx.font = '500 10px "Roboto Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`REACH ${REACH} MM`, ox, oy - REACH * s - 7);
    ctx.textAlign = 'left';

    // Ground and hatching
    ctx.strokeStyle = 'rgba(148,178,255,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, oy + .5); ctx.lineTo(w, oy + .5); ctx.stroke();
    ctx.strokeStyle = 'rgba(148,178,255,.12)';
    for (let x = (ox % 10) - 10; x < w; x += 10) { ctx.beginPath(); ctx.moveTo(x, oy + 1); ctx.lineTo(x - 7, oy + 9); ctx.stroke(); }

    // End-effector trail
    for (let i = 1; i < trail.length; i++) {
      const a = toScreen(trail[i - 1]), b = toScreen(trail[i]);
      ctx.strokeStyle = `rgba(0,229,255,${(i / trail.length) * .35})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }

    // Target reticle
    const tg = toScreen(goal);
    ctx.strokeStyle = reachable ? C.accent : C.warm;
    ctx.globalAlpha = .9;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(tg[0], tg[1], 9, 0, 2 * Math.PI); ctx.stroke();
    const spin = reduced ? 0 : now / 900;
    for (let i = 0; i < 4; i++) {
      const a = spin + i * Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(tg[0] + Math.cos(a) * 12, tg[1] + Math.sin(a) * 12);
      ctx.lineTo(tg[0] + Math.cos(a) * 17, tg[1] + Math.sin(a) * 17);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (!reachable) {
      const ee = toScreen(pts[3]);
      ctx.save(); ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,181,71,.55)';
      ctx.beginPath(); ctx.moveTo(ee[0], ee[1]); ctx.lineTo(tg[0], tg[1]); ctx.stroke(); ctx.restore();
    }

    // Block
    const cs = cube.size * s, cp = toScreen(cube);
    ctx.fillStyle = 'rgba(255,181,71,.16)';
    ctx.strokeStyle = C.warm;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.rect(cp[0] - cs / 2, cp[1] - cs / 2, cs, cs); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cp[0] - cs / 2, cp[1] - cs / 2); ctx.lineTo(cp[0] + cs / 2, cp[1] + cs / 2); ctx.globalAlpha = .35; ctx.stroke(); ctx.globalAlpha = 1;

    // Pedestal
    const b0 = toScreen({ x: -34, y: 0 }), b1 = toScreen({ x: 34, y: 0 }), b2 = toScreen({ x: 22, y: 22 }), b3 = toScreen({ x: -22, y: 22 });
    ctx.fillStyle = '#0f1a30';
    ctx.strokeStyle = 'rgba(148,178,255,.45)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(...b0); ctx.lineTo(...b1); ctx.lineTo(...b2); ctx.lineTo(...b3); ctx.closePath(); ctx.fill(); ctx.stroke();

    // Links: outlined capsules
    const widths = [17, 14, 10];
    for (let i = 0; i < 3; i++) {
      const a = toScreen(pts[i]), b = toScreen(pts[i + 1]);
      const lw = Math.max(5, widths[i] * s * 1.25);
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = lw - 3;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,229,255,.22)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }

    // Joint angle arcs
    const a1 = q[0], a2 = q[0] + q[1], a3 = q[0] + q[1] + q[2];
    const arcs = [[0, 0, a1, 'θ1'], [1, a1, a2, 'θ2'], [2, a2, a3, 'θ3']];
    ctx.font = 'italic 600 11px Inter, system-ui, sans-serif';
    for (const [j, from, to, name] of arcs) {
      const c = toScreen(pts[j]);
      const r = (j === 0 ? 34 : 26) * Math.max(.75, s * 1.1);
      const d = wrap(to - from);
      ctx.strokeStyle = 'rgba(255,181,71,.7)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(c[0], c[1], r, -from, -(from + d), d > 0); ctx.stroke();
      const mid = from + d / 2;
      ctx.fillStyle = 'rgba(255,181,71,.9)';
      ctx.fillText(name, c[0] + Math.cos(mid) * (r + 8) - 6, c[1] - Math.sin(mid) * (r + 8) + 4);
    }

    // Joints
    const jr = [10, 8.5, 7];
    for (let i = 0; i < 3; i++) {
      const c = toScreen(pts[i]);
      const r = Math.max(4.5, jr[i] * s * 1.25);
      ctx.fillStyle = C.ink; ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.accent;
      ctx.beginPath(); ctx.arc(c[0], c[1], 2, 0, 2 * Math.PI); ctx.fill();
    }

    // Gripper
    const dx = Math.cos(a3), dy = Math.sin(a3), nx = -dy, ny = dx;
    const e = pts[3];
    const open = 9 - grip * 5.5;
    const P = (u, v) => toScreen({ x: e.x + dx * u + nx * v, y: e.y + dy * u + ny * v });
    ctx.strokeStyle = C.accent; ctx.lineWidth = Math.max(2, 3 * s * 1.25);
    ctx.beginPath(); ctx.moveTo(...P(0, -10)); ctx.lineTo(...P(0, 10)); ctx.stroke();
    ctx.lineWidth = Math.max(1.6, 2.4 * s * 1.25);
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(...P(0, side * 10)); ctx.lineTo(...P(6, side * open)); ctx.lineTo(...P(17, side * open)); ctx.stroke();
    }
  }

  // ---------- Loop ----------
  function frame(now) {
    if (!running) return;
    const dt = Math.min(.05, (now - lastT) / 1000 || .016);
    lastT = now;
    const idle = step(dt, now);
    draw(now);
    const settled = Math.hypot(goal.x - target.x, goal.y - target.y) < .2 && Math.abs((gripWanted || cube.held ? 1 : 0) - grip) < .01 && cube.vy === 0;
    // With reduced motion there is no idle animation, so stop once everything has settled.
    if (!visible || document.hidden || (reduced && idle && settled)) { running = false; return; }
    requestAnimationFrame(frame);
  }
  function wake() {
    if (running || !visible || document.hidden) return;
    running = true;
    lastT = performance.now();
    requestAnimationFrame(frame);
  }

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) wake();
  }).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

  fk();
  resize();
  readout('idle');
  wake();
})();
