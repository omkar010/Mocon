// Tiltway — a tilt-the-board marble maze for the Mocon phone controller (or mouse / keyboard).
import * as THREE from 'three';
import { Mocon } from '../mocon.js?v=20261114-2350';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('tiltway.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tiltway.' + k, JSON.stringify(v)); } catch {} },
};

// ---------------------------------------------------------------- Levels
// #  wall    .  floor    (space)  open air: roll off and you fall
// S  start   G  goal     O  hole    *  gem (optional, needed for 3 stars)
// par = seconds for the time star.
const LEVELS = [
  { name: 'Warm Up', par: 14, map: [
    '#########',
    '#S......#',
    '#######.#',
    '#.......#',
    '#.#######',
    '#..*...G#',
    '#########',
  ] },
  { name: 'Pitfalls', par: 16, map: [
    '###########',
    '#S........#',
    '#..O...O..#',
    '#....O....#',
    '#.O.....O.#',
    '#....O..*.#',
    '#.O..*..O.#',
    '#...O...O.#',
    '#*.......G#',
    '###########',
  ] },
  { name: 'Switchback', par: 24, map: [
    '#############',
    '#S..........#',
    '#.......*...#',
    '##########..#',
    '#.O.........#',
    '#...........#',
    '#..##########',
    '#.....O.....#',
    '#..*......O.#',
    '##########..#',
    '#G..O.......#',
    '#...........#',
    '#############',
  ] },
  { name: 'Skyway', par: 18, map: [
    '#######      ',
    '#S....#      ',
    '#.....#      ',
    '###.###      ',
    '  ...        ',
    '  . .....    ',
    '  ...   .    ',
    '    *   .    ',
    '        .    ',
    '   #####.### ',
    '   #.......# ',
    '   #..*...G# ',
    '   ######### ',
  ] },
  { name: 'Gauntlet', par: 22, map: [
    '###############',
    '#S.O.......O..#',
    '#...O..O.....O#',
    '#O.....O..O...#',
    '#..O.O....O.O.#',
    '#.....O.O..*..#',
    '#O.O.....O..O.#',
    '#....O.O...O..#',
    '#.O*......O...#',
    '#...O.O.O....G#',
    '###############',
  ] },
  { name: 'Labyrinth', par: 40, map: [
    '###############',
    '#S..#.........#',
    '#.#.#.###.#.#.#',
    '#.#...#...#.#.#',
    '#.#####.###.#.#',
    '#.....#.#...#.#',
    '###.#.#.#.###.#',
    '#...#...#..O..#',
    '#.#######.###.#',
    '#.#*..........#',
    '#.#.###.###.#.#',
    '#...#O....#..G#',
    '###############',
  ] },
];

// ---------------------------------------------------------------- Physics tuning

const BALL_R = 0.27;
const G = 9.8 * (5 / 7); // a rolling solid ball accelerates at 5/7 g
const TILT_GAIN = 0.9;
const MAX_TILT = 0.5; // sin of ~30°
const DAMPING = 0.35;
const MAX_SPEED = 6;
const RESTITUTION = 0.35;
const HOLE_FALL = 0.3;
const HOLE_PULL = 0.55;

// ---------------------------------------------------------------- Sound

const sfx = {
  ctx: null, master: null, roll: null, rollGain: null,
  ensure() {
    if (!this.ctx) {
      const ctx = (this.ctx = new AudioContext());
      this.master = ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(ctx.destination);
      // Continuous rolling rumble whose volume follows the ball's speed.
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) { last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = last * 6; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 500;
      this.rollGain = ctx.createGain();
      this.rollGain.gain.value = 0;
      src.connect(lp);
      lp.connect(this.rollGain);
      this.rollGain.connect(this.master);
      src.start();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(type, f0, f1, dur, vol, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  },
  bump(strength) { this.tone('triangle', 220 + strength * 60, 120, 0.08, Math.min(0.5, 0.08 + strength * 0.12)); },
  fall() { this.tone('sine', 520, 70, 0.7, 0.35); },
  gem() { this.tone('sine', 1320, 1320, 0.15, 0.2); this.tone('sine', 1760, 1760, 0.25, 0.2, 0.07); },
  goal() { [523, 659, 784, 1047].forEach((f, i) => this.tone('triangle', f, f, 0.3, 0.25, i * 0.09)); },
  setRoll(speed, onFloor) {
    if (!this.rollGain) return;
    this.rollGain.gain.setTargetAtTime(onFloor ? Math.min(0.5, speed * 0.09) : 0, this.ctx.currentTime, 0.05);
  },
};

// ---------------------------------------------------------------- Scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x12312f);
scene.fog = new THREE.Fog(0x12312f, 14, 30);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
scene.add(new THREE.HemisphereLight(0xfff1dc, 0x1d4a44, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 40 });
scene.add(sun, sun.target);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const board = new THREE.Group();
scene.add(board);
const mats = {
  floor: new THREE.MeshStandardMaterial({ color: 0xe9d8b4, roughness: 0.85 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xc8643b, roughness: 0.7 }),
  hole: new THREE.MeshBasicMaterial({ color: 0x0c1110 }),
  rim: new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.6 }),
  goal: new THREE.MeshBasicMaterial({ color: 0x8cd17d }),
  gem: new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0xb07a10, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.2, flatShading: true }),
  ball: new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.75, roughness: 0.22 }),
};
// A simple gradient environment so the metal ball has something to reflect.
{
  const pm = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x5d8f88);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  lamp.position.set(3, 6, 2);
  env.add(lamp);
  scene.environment = pm.fromScene(env, 0.04).texture;
}

const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 32, 24), mats.ball);
ball.castShadow = true;
// A stripe so rolling is visible.
const stripe = new THREE.Mesh(new THREE.TorusGeometry(BALL_R * 0.98, 0.025, 8, 32), new THREE.MeshStandardMaterial({ color: 0xf4a259 }));
ball.add(stripe);

let level = null; // parsed level

function parse(def) {
  const H = def.map.length;
  const W = Math.max(...def.map.map((r) => r.length));
  const cells = def.map.map((r) => r.padEnd(W, ' ').split(''));
  const pos = (c, r) => new THREE.Vector2(c - (W - 1) / 2, r - (H - 1) / 2);
  const out = { def, W, H, cells, pos, holes: [], gems: [], start: null, goal: null };
  cells.forEach((row, r) => row.forEach((ch, c) => {
    if (ch === 'S') out.start = pos(c, r);
    if (ch === 'G') out.goal = pos(c, r);
    if (ch === 'O') out.holes.push(pos(c, r));
    if (ch === '*') out.gems.push({ p: pos(c, r), got: false, mesh: null });
  }));
  return out;
}

const cellAt = (x, z) => {
  const c = Math.round(x + (level.W - 1) / 2);
  const r = Math.round(z + (level.H - 1) / 2);
  return level.cells[r]?.[c] ?? ' ';
};

function buildBoard() {
  board.clear();
  const floors = [];
  const walls = [];
  level.cells.forEach((row, r) => row.forEach((ch, c) => {
    if (ch === ' ') return;
    const p = level.pos(c, r);
    if (ch === '#') walls.push(p);
    if (ch !== 'O') floors.push(p);
  }));
  const m = new THREE.Matrix4();
  const floorMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.3, 1), mats.floor, floors.length);
  floors.forEach((p, i) => floorMesh.setMatrixAt(i, m.makeTranslation(p.x, -0.15, p.y)));
  floorMesh.receiveShadow = true;
  const wallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.55, 1), mats.wall, walls.length);
  walls.forEach((p, i) => wallMesh.setMatrixAt(i, m.makeTranslation(p.x, 0.275, p.y)));
  wallMesh.castShadow = wallMesh.receiveShadow = true;
  board.add(floorMesh, wallMesh);

  for (const h of level.holes) {
    // A floor tile with a dark disc and a rim on top reads as a hole from the camera's angle.
    const tile = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 1), mats.floor);
    tile.position.set(h.x, -0.15, h.y);
    tile.receiveShadow = true;
    const pit = new THREE.Mesh(new THREE.CircleGeometry(0.36, 32), mats.hole);
    pit.rotation.x = -Math.PI / 2;
    pit.position.set(h.x, 0.003, h.y);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.42, 32), mats.rim);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(h.x, 0.002, h.y);
    board.add(tile, pit, ring);
  }
  const g = level.goal;
  const goalRing = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.4, 32), mats.goal);
  goalRing.rotation.x = -Math.PI / 2;
  goalRing.position.set(g.x, 0.004, g.y);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 2.5, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x8cd17d, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
  beam.position.set(g.x, 1.25, g.y);
  board.add(goalRing, beam);
  level.beam = beam;
  for (const gem of level.gems) {
    gem.mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.17), mats.gem);
    gem.mesh.position.set(gem.p.x, 0.35, gem.p.y);
    gem.mesh.castShadow = true;
    board.add(gem.mesh);
  }
  board.add(ball);
}

// ---------------------------------------------------------------- Game state

const pad = new Mocon();
const S = {
  mode: 'menu', // menu | calibrate | ready | play | falling | done | paused
  input: null,
  idx: 0,
  p: new THREE.Vector2(), v: new THREE.Vector2(), y: BALL_R,
  time: 0, falls: 0, gemsGot: 0,
  readyT: 0, fallT: 0, lastBump: 0,
  tilt: new THREE.Vector2(), // board-plane gravity direction, -1..1 each axis
};
const progress = store.get('progress', {}); // { [levelIdx]: { best, stars } }

function loadLevel(i) {
  S.idx = i;
  level = parse(LEVELS[i]);
  buildBoard();
  resetBall();
  S.time = 0;
  S.falls = 0;
  S.gemsGot = 0;
  S.mode = 'ready';
  S.readyT = 1.0;
  ['menu', 'done', 'pause'].forEach((id) => $(id).classList.remove('show'));
  banner(LEVELS[i].name);
  camTarget.set(level.start.x, 0, level.start.y);
  camera.position.set(level.start.x, 9, level.start.y + 7);
  if (i === 0) hint(S.input === 'phone'
    ? 'Tilt your phone to roll. If the board feels crooked, hold the phone flat and press Recenter.'
    : 'Move the pointer where you want the ball to roll, or use the arrow keys.', 6);
}

function resetBall() {
  S.p.copy(level.start);
  S.v.set(0, 0);
  S.y = BALL_R;
  ball.position.set(S.p.x, S.y, S.p.y);
  ball.scale.setScalar(1);
  ball.visible = true;
}

function fall() {
  S.mode = 'falling';
  S.fallT = 0;
  S.falls++;
  sfx.fall();
  sfx.setRoll(0, false);
  buzz(220, 255);
}

function complete() {
  S.mode = 'done';
  sfx.goal();
  sfx.setRoll(0, false);
  buzz(80, 255);
  setTimeout(() => buzz(160, 255), 160);
  const def = LEVELS[S.idx];
  const allGems = S.gemsGot === level.gems.length;
  const underPar = S.time <= def.par;
  const stars = 1 + (allGems ? 1 : 0) + (underPar ? 1 : 0);
  const prev = progress[S.idx] || {};
  const best = prev.best == null ? S.time : Math.min(prev.best, S.time);
  progress[S.idx] = { best, stars: Math.max(prev.stars || 0, stars) };
  store.set('progress', progress);
  $('doneTitle').textContent = S.idx === LEVELS.length - 1 ? 'Every level cleared!' : 'Level complete';
  $('doneStars').innerHTML = [0, 1, 2].map((i) => `<span class="${i < stars ? '' : 'off'}">★</span>`).join('');
  $('doneText').textContent = `${S.time.toFixed(2)} s · gems ${S.gemsGot}/${level.gems.length} · ${S.falls} fall${S.falls === 1 ? '' : 's'}`;
  const tips = [];
  if (!underPar) tips.push(`finish under ${def.par} s`);
  if (!allGems) tips.push('collect every gem');
  $('doneBest').textContent = (prev.best == null || S.time < prev.best ? 'New best time! ' : `Best ${prev.best.toFixed(2)} s. `)
    + (tips.length ? `For more stars: ${tips.join(' and ')}.` : '');
  $('btnNext').style.display = S.idx < LEVELS.length - 1 ? '' : 'none';
  setTimeout(() => { if (S.mode === 'done') $('done').classList.add('show'); }, 700);
}

// ---------------------------------------------------------------- Physics

function step(h) {
  // Gravity along the tilted board.
  S.v.x += S.tilt.x * G * TILT_GAIN * h;
  S.v.y += S.tilt.y * G * TILT_GAIN * h;
  // Holes pull the ball in when it gets close.
  for (const hole of level.holes) {
    const dx = hole.x - S.p.x, dz = hole.y - S.p.y;
    const d = Math.hypot(dx, dz);
    if (d < HOLE_PULL && d > 0.0001) {
      const pull = 4 * (1 - d / HOLE_PULL);
      S.v.x += (dx / d) * pull * h;
      S.v.y += (dz / d) * pull * h;
    }
    if (d < HOLE_FALL) return fall();
  }
  S.v.multiplyScalar(1 - DAMPING * h);
  if (S.v.length() > MAX_SPEED) S.v.setLength(MAX_SPEED);
  S.p.addScaledVector(S.v, h);

  // Walls: circle vs. the boxes of nearby wall cells.
  const c0 = Math.round(S.p.x + (level.W - 1) / 2);
  const r0 = Math.round(S.p.y + (level.H - 1) / 2);
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      if (level.cells[r]?.[c] !== '#') continue;
      const w = level.pos(c, r);
      const cx = THREE.MathUtils.clamp(S.p.x, w.x - 0.5, w.x + 0.5);
      const cz = THREE.MathUtils.clamp(S.p.y, w.y - 0.5, w.y + 0.5);
      let nx = S.p.x - cx, nz = S.p.y - cz;
      const d = Math.hypot(nx, nz);
      if (d >= BALL_R) continue;
      if (d < 1e-5) { nx = 0; nz = -1; } else { nx /= d; nz /= d; }
      S.p.x += nx * (BALL_R - d);
      S.p.y += nz * (BALL_R - d);
      const vn = S.v.x * nx + S.v.y * nz;
      if (vn < 0) {
        S.v.x -= (1 + RESTITUTION) * vn * nx;
        S.v.y -= (1 + RESTITUTION) * vn * nz;
        bump(-vn);
      }
    }
  }

  // Off the edge?
  if (cellAt(S.p.x, S.p.y) === ' ') return fall();

  for (const gem of level.gems) {
    if (!gem.got && gem.p.distanceTo(S.p) < 0.4) {
      gem.got = true;
      S.gemsGot++;
      board.remove(gem.mesh);
      sfx.gem();
      buzz(30, 180);
    }
  }
  if (level.goal.distanceTo(S.p) < 0.32) complete();
}

function bump(speed) {
  const now = performance.now();
  if (speed < 0.6 || now - S.lastBump < 70) return;
  S.lastBump = now;
  sfx.bump(speed);
  buzz(Math.round(12 + speed * 8), Math.min(255, Math.round(60 + speed * 45)));
}

// ---------------------------------------------------------------- Input

const phoneQ = new THREE.Quaternion();
const normal = new THREE.Vector3();
let phoneSeen = false;
pad.addEventListener('motion', (e) => {
  const q = Mocon.toThree(e.detail.quaternion);
  phoneQ.set(q.x, q.y, q.z, q.w);
  phoneSeen = true;
});

const mouse = { x: 0.5, y: 0.5, moved: false };
addEventListener('pointermove', (e) => { mouse.x = e.clientX / innerWidth; mouse.y = e.clientY / innerHeight; mouse.moved = true; });
const keys = new Set();
const KEYMAP = { ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd', ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r' };
addEventListener('keydown', (e) => {
  if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); }
  if (e.code === 'Escape') S.mode === 'paused' ? resume() : pause();
  if (e.code === 'KeyR' && ['play', 'ready', 'falling'].includes(S.mode)) loadLevel(S.idx);
});
addEventListener('keyup', (e) => keys.delete(KEYMAP[e.code]));

const keyTilt = new THREE.Vector2();
function readTilt(dt) {
  const t = new THREE.Vector2();
  if (S.input === 'phone' && phoneSeen) {
    // The phone's screen normal is the board's "up". Its horizontal lean is the slope.
    normal.set(0, 1, 0).applyQuaternion(phoneQ);
    t.set(normal.x, normal.z);
  } else if (keys.size) {
    const target = new THREE.Vector2((keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0), (keys.has('d') ? 1 : 0) - (keys.has('u') ? 1 : 0)).multiplyScalar(0.32);
    keyTilt.lerp(target, 1 - Math.exp(-dt * 10));
    t.copy(keyTilt);
  } else {
    keyTilt.multiplyScalar(Math.exp(-dt * 10));
    // Mouse: the ball rolls toward the pointer, harder the further it is from the ball on screen.
    const bp = ball.getWorldPosition(new THREE.Vector3()).project(camera);
    const dx = mouse.x * 2 - 1 - bp.x;
    const dy = -(mouse.y * 2 - 1) - bp.y;
    t.set(dx, -dy).multiplyScalar(0.7);
    if (!mouse.moved) t.set(0, 0);
  }
  if (t.length() > MAX_TILT) t.setLength(MAX_TILT);
  return t;
}

function buzz(ms, amp) {
  if (S.input === 'phone' && pad.connected) pad.vibrate(ms, amp).catch(() => {});
}

// ---------------------------------------------------------------- UI

let bannerT = 0;
let hintT = 0;
function banner(text, s = 1.4) { $('banner').textContent = text; $('banner').classList.add('show'); bannerT = s; }
function hint(text, s = 0) { $('hint').textContent = text; hintT = s; }

function unlocked(i) { return i === 0 || progress[i - 1] != null; }
function renderMenu() {
  const el = $('levels');
  el.innerHTML = '';
  LEVELS.forEach((L, i) => {
    const b = document.createElement('button');
    const p = progress[i];
    b.className = 'lvl' + (i === S.idx ? ' on' : '');
    b.disabled = !unlocked(i);
    b.innerHTML = `<b>${i + 1}. ${L.name}</b><span class="stars">${p ? '★'.repeat(p.stars) + '☆'.repeat(3 - p.stars) : '☆☆☆'}</span><small>${p ? (p.best != null ? p.best.toFixed(2) + ' s' : 'cleared') : unlocked(i) ? 'par ' + L.par + ' s' : 'locked'}</small>`;
    b.onclick = () => { S.idx = i; renderMenu(); };
    el.appendChild(b);
  });
  $('btnPhone').textContent = pad.connected ? 'Play with phone' : 'Connect phone';
}

function showMenu() {
  S.mode = 'menu';
  sfx.setRoll(0, false);
  ['done', 'pause'].forEach((id) => $(id).classList.remove('show'));
  $('menu').classList.add('show');
  hint('');
  renderMenu();
}

$('btnPhone').onclick = async () => {
  sfx.ensure();
  try {
    if (!pad.connected) {
      $('menuStatus').textContent = 'Choose your phone in the browser\'s list…';
      await pad.connect();
      await pad.setLayout({ title: 'Tiltway', buttons: ['Restart', 'Pause'] });
      $('menuStatus').textContent = `Connected: ${pad.info?.model ?? 'phone'}`;
    }
    S.input = 'phone';
    S.mode = 'calibrate';
    $('menu').classList.remove('show');
    level || (level = parse(LEVELS[S.idx]), buildBoard(), resetBall());
    banner('Hold it flat', 99);
    hint('Hold your phone flat, screen up, top pointing at this screen. Then press Restart on your phone to begin.');
  } catch (err) {
    $('menuStatus').textContent = err.name === 'NotFoundError' ? 'No phone chosen.' : err.message;
  }
};
$('btnMouse').onclick = () => { sfx.ensure(); S.input = 'mouse'; loadLevel(S.idx); };
$('btnNext').onclick = () => { if (S.input === 'phone') pad.recenter().catch(() => {}); loadLevel(Math.min(S.idx + 1, LEVELS.length - 1)); };
$('btnRetry').onclick = () => loadLevel(S.idx);
$('btnLevels').onclick = showMenu;
$('btnLevels2').onclick = showMenu;
$('btnResume').onclick = resume;
$('btnReconnect').onclick = async () => {
  try {
    await pad.reconnect();
    await pad.setLayout({ title: 'Tiltway', buttons: ['Restart', 'Pause'] });
    resume();
  } catch (err) { $('pauseText').textContent = `Couldn't reconnect: ${err.message}`; }
};

let resumeMode = 'play';
function pause(reason) {
  if (!['play', 'ready', 'falling'].includes(S.mode)) return;
  resumeMode = S.mode;
  S.mode = 'paused';
  sfx.setRoll(0, false);
  const lost = reason === 'disconnect';
  $('pauseTitle').textContent = lost ? 'Phone disconnected' : 'Paused';
  $('pauseText').textContent = lost ? 'Open the Mocon app on your phone, then reconnect.' : 'Press Pause on your phone, Esc, or Resume.';
  $('btnResume').style.display = lost ? 'none' : '';
  $('btnReconnect').style.display = lost ? '' : 'none';
  $('pause').classList.add('show');
}
function resume() {
  if (S.mode !== 'paused') return;
  $('pause').classList.remove('show');
  S.mode = resumeMode;
}

pad.addEventListener('buttondown', (e) => {
  if (e.detail.index === 0) {
    if (S.mode === 'calibrate') { pad.recenter().catch(() => {}); loadLevel(S.idx); }
    else if (S.mode === 'done') $('btnNext').style.display !== 'none' ? $('btnNext').click() : loadLevel(S.idx);
    else if (['play', 'ready', 'falling'].includes(S.mode)) loadLevel(S.idx);
  }
  if (e.detail.index === 1) S.mode === 'paused' ? resume() : pause();
});
pad.addEventListener('disconnect', () => { renderMenu(); if (S.input === 'phone') pause('disconnect'); });
if (!Mocon.isSupported()) {
  $('btnPhone').disabled = true;
  $('menuStatus').textContent = 'This browser can\'t use Bluetooth. Use Chrome or Edge for phone play, or play with mouse / keys.';
}

// ---------------------------------------------------------------- Frame loop

const camTarget = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const tiltNormal = new THREE.Vector3();
const spinAxis = new THREE.Vector3();
const spinQ = new THREE.Quaternion();
let last = performance.now();

renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!level) { renderer.render(scene, camera); return; }

  const active = ['play', 'ready', 'calibrate'].includes(S.mode);
  const tilt = active ? readTilt(dt) : new THREE.Vector2();
  S.tilt.lerp(tilt, 1 - Math.exp(-dt * 20));

  // Board leans visually a bit less than the real slope, so the view stays readable.
  tiltNormal.set(S.tilt.x * 0.55, 1, S.tilt.y * 0.55).normalize();
  board.quaternion.setFromUnitVectors(up, tiltNormal);

  if (S.mode === 'ready') {
    S.readyT -= dt;
    if (S.readyT <= 0) S.mode = 'play';
  } else if (S.mode === 'play') {
    S.time += dt;
    const sub = 6;
    for (let i = 0; i < sub && S.mode === 'play'; i++) step(dt / sub);
    const speed = S.v.length();
    sfx.setRoll(speed, true);
    // Roll the ball mesh.
    if (speed > 0.001) {
      spinAxis.set(S.v.y, 0, -S.v.x).normalize();
      spinQ.setFromAxisAngle(spinAxis, (speed * dt) / BALL_R);
      ball.quaternion.premultiply(spinQ);
    }
    ball.position.set(S.p.x, S.y, S.p.y);
  } else if (S.mode === 'falling') {
    S.fallT += dt;
    S.y -= (1 + S.fallT * 9) * dt;
    S.p.addScaledVector(S.v, dt * 0.5);
    ball.position.set(S.p.x, S.y, S.p.y);
    if (S.fallT > 0.8) {
      resetBall();
      S.mode = 'ready';
      S.readyT = 0.5;
    }
  } else if (S.mode === 'done') {
    ball.position.lerp(new THREE.Vector3(level.goal.x, BALL_R * 0.4, level.goal.y), 1 - Math.exp(-dt * 6));
  }

  for (const gem of level.gems) if (gem.mesh) gem.mesh.rotation.y += dt * 2;
  if (level.beam) level.beam.material.opacity = 0.14 + 0.08 * Math.sin(now / 300);

  // Camera follows the ball from above and behind.
  const wp = ball.getWorldPosition(new THREE.Vector3());
  camTarget.lerp(wp, 1 - Math.exp(-dt * 3));
  const zoom = camera.aspect < 1 ? 1.45 : 1.15; // portrait screens need to see further
  const desired = new THREE.Vector3(camTarget.x, camTarget.y + 9 * zoom, camTarget.z + 6.5 * zoom);
  camera.position.lerp(desired, 1 - Math.exp(-dt * 3));
  camera.lookAt(camTarget);
  sun.position.set(camTarget.x + 4, 12, camTarget.z + 3);
  sun.target.position.copy(camTarget);

  // HUD
  const L = LEVELS[S.idx];
  $('level').innerHTML = `${S.idx + 1}. ${L.name}<small>par ${L.par} s</small>`;
  $('stats').innerHTML = `${S.time.toFixed(1)} s<small>gems ${S.gemsGot}/${level.gems.length}${S.falls ? ` · falls ${S.falls}` : ''}</small>`;
  const dot = $('tilt').firstElementChild;
  dot.style.left = 50 + (S.tilt.x / MAX_TILT) * 40 + '%';
  dot.style.top = 50 + (S.tilt.y / MAX_TILT) * 40 + '%';
  if (bannerT > 0 && (bannerT -= dt) <= 0) $('banner').classList.remove('show');
  if (hintT > 0 && (hintT -= dt) <= 0) $('hint').textContent = '';

  renderer.render(scene, camera);
});

// Show level 1 behind the menu.
level = parse(LEVELS[0]);
buildBoard();
resetBall();
camTarget.set(0, 0, 0);
camera.position.set(0, 10, 7);
renderMenu();

// For automated checks only.
window.__tiltway = { S, LEVELS, parse, loadLevel, step, get level() { return level; }, renderer, scene, camera };
