// Cadence — a rhythm slashing game for the Mocon phone controller (or mouse / keyboard).
// All music is synthesized in the browser, so there are no audio files or licenses involved.
import * as THREE from 'three';
import { Mocon } from '../mocon.js?v=20261114-2350';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('cadence.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cadence.' + k, JSON.stringify(v)); } catch {} },
};

// ---------------------------------------------------------------- Songs and charts

const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10] };
// Patterns are one bar of 16th notes. prog = chord roots as scale degrees, one per bar.
const SONGS = [
  { id: 'drift', title: 'Neon Drift', bpm: 104, root: 45, scale: 'minor', prog: [0, 5, 2, 6], seed: 11, lead: 0.45,
    kick: 'x.......x.......', snare: '....x.......x...', hat: '..x...x...x...x.', bass: 'x..x....x..x..x.' },
  { id: 'engine', title: 'Pulse Engine', bpm: 124, root: 43, scale: 'dorian', prog: [0, 3, 4, 3], seed: 23, lead: 0.55,
    kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', bass: 'x.xx..x.x.xx..x.' },
  { id: 'storm', title: 'Glass Storm', bpm: 140, root: 47, scale: 'minor', prog: [0, 6, 5, 4], seed: 37, lead: 0.65,
    kick: 'x..x..x...x..x..', snare: '....x..x....x...', hat: 'xxxxxxxxxxxxxxxx', bass: 'x.x.x.xxx.x.x.xx' },
];
const ARRANGEMENT = [
  ['intro', 4, { kick: 1, hat: 1 }],
  ['verse', 8, { kick: 1, snare: 1, hat: 1, bass: 1, pad: 1 }],
  ['chorus', 8, { kick: 1, snare: 1, hat: 1, bass: 1, pad: 1, lead: 1 }],
  ['break', 4, { hat: 1, pad: 1, lead: 1 }],
  ['drop', 8, { kick: 1, snare: 1, hat: 1, bass: 1, pad: 1, lead: 1 }],
  ['outro', 2, { pad: 1 }],
];
const DIFFS = {
  easy:   { label: 'Easy',   travel: 2.0, minGap: 0.62, mines: 0,    any: 0.25, offbeats: false, missCost: 8 },
  normal: { label: 'Normal', travel: 1.6, minGap: 0.38, mines: 0.05, any: 0.12, offbeats: false, missCost: 12 },
  hard:   { label: 'Hard',   travel: 1.3, minGap: 0.27, mines: 0.08, any: 0.05, offbeats: true,  missCost: 14 },
};
const PERFECT = 0.075;
const GOOD = 0.15;
const MINE_WINDOW = 0.1;
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const DIRS = ['up', 'down', 'left', 'right'];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSong(song, diffKey) {
  const diff = DIFFS[diffKey];
  const step = 60 / song.bpm / 4;
  const scale = SCALES[song.scale];
  const noteOf = (deg) => song.root + scale[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);
  const r = rng(song.seed);
  const motif = Array.from({ length: 16 }, (_, i) =>
    (i % 2 === 0 || r() < 0.3) && r() < song.lead + 0.2 ? Math.floor(r() * 7) : null);

  const audio = [];
  const weight = new Map();
  const mark = (s, w) => weight.set(s, (weight.get(s) || 0) + w);
  let s = 0;
  for (const [, bars, L] of ARRANGEMENT) {
    for (let b = 0; b < bars; b++) {
      const deg = song.prog[(s / 16) % song.prog.length];
      const chord = [0, 2, 4].map((k) => noteOf(deg + k));
      if (L.pad) audio.push({ step: s, type: 'pad', notes: chord.map((n) => n + 12), dur: 16 });
      for (let i = 0; i < 16; i++) {
        const g = s + i;
        if (L.kick && song.kick[i] === 'x') { audio.push({ step: g, type: 'kick' }); mark(g, 3); }
        if (L.snare && song.snare[i] === 'x') { audio.push({ step: g, type: 'snare' }); mark(g, 3); }
        if (L.hat && song.hat[i] === 'x') { audio.push({ step: g, type: 'hat', open: i % 8 === 6 }); if (i % 2 === 0) mark(g, 1); }
        if (L.bass && song.bass[i] === 'x') audio.push({ step: g, type: 'bass', note: chord[0] - 12, dur: 2 });
        if (L.lead && motif[i] !== null) {
          const lift = b % 4 === 3 && i >= 8 ? 1 : 0;
          audio.push({ step: g, type: 'lead', note: noteOf(deg + motif[i] + lift) + 12, dur: 2 });
          mark(g, 2);
        }
      }
      s += 16;
    }
  }
  const totalSteps = s;

  // Chart: pick strong moments, keep a minimum gap, and make directions flow (down is usually followed by up).
  const cr = rng(song.seed * 31 + diffKey.length * 7);
  const notes = [];
  let lastT = -9;
  let lastDir = 'up';
  for (const [st, w] of [...weight.entries()].sort((a, b) => a[0] - b[0])) {
    if (st < 32 || st >= totalSteps - 32) continue;
    const t = st * step;
    if (diffKey === 'easy' && st % 4 !== 0) continue; // easy: on the beat only
    if (!diff.offbeats && st % 4 !== 0 && w < 3) continue;
    if (t - lastT < diff.minGap) continue;
    const x = cr() < 0.5 ? -0.42 : 0.42;
    const y = cr() < 0.5 ? 1.22 : 1.62;
    if (notes.length > 6 && cr() < diff.mines) {
      notes.push({ t, mine: true, x, y });
      lastT = t;
      continue;
    }
    let dir;
    if (cr() < diff.any) dir = 'any';
    else if (cr() < 0.62) dir = OPPOSITE[lastDir];
    else dir = DIRS[Math.floor(cr() * 4)];
    if (dir !== 'any') lastDir = dir;
    notes.push({ t, dir, x, y });
    lastT = t;
  }
  const duration = totalSteps * step + 1.5;
  return { step, audio, notes, duration, beat: step * 4 };
}

// ---------------------------------------------------------------- Synth

const synth = {
  ctx: null, master: null, noiseBuf: null, delay: null,
  ensure() {
    if (!this.ctx) {
      const ctx = (this.ctx = new AudioContext());
      const comp = ctx.createDynamicsCompressor();
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(comp);
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.delay = ctx.createDelay(1);
      const fb = ctx.createGain();
      fb.gain.value = 0.3;
      this.delay.connect(fb);
      fb.connect(this.delay);
      this.delay.connect(this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  get now() { return this.ctx ? this.ctx.currentTime : 0; },
  env(node, t, peak, attack, hold, release, dest = this.master) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    node.connect(g);
    g.connect(dest);
    return g;
  },
  osc(type, hz, t, end) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, t);
    o.start(t);
    o.stop(end);
    return o;
  },
  noise(t, dur) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.start(t, Math.random() * 0.5, dur);
    return n;
  },
  filter(type, hz, input) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    input.connect(f);
    return f;
  },
  play(ev, t, step) {
    const hz = (m) => 440 * 2 ** ((m - 69) / 12);
    switch (ev.type) {
      case 'kick': {
        const o = this.osc('sine', 160, t, t + 0.4);
        o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
        this.env(o, t, 0.9, 0.003, 0.02, 0.3);
        break;
      }
      case 'snare': {
        this.env(this.filter('highpass', 1200, this.noise(t, 0.25)), t, 0.4, 0.002, 0.01, 0.16);
        this.env(this.osc('triangle', 190, t, t + 0.15), t, 0.25, 0.002, 0.01, 0.08);
        break;
      }
      case 'hat':
        this.env(this.filter('highpass', 8000, this.noise(t, 0.3)), t, ev.open ? 0.1 : 0.12, 0.001, 0, ev.open ? 0.18 : 0.035);
        break;
      case 'bass': {
        const o = this.osc('sawtooth', hz(ev.note), t, t + ev.dur * step + 0.2);
        const f = this.filter('lowpass', 900, o);
        f.frequency.setValueAtTime(900, t);
        f.frequency.exponentialRampToValueAtTime(260, t + ev.dur * step);
        this.env(f, t, 0.28, 0.005, ev.dur * step * 0.6, 0.12);
        break;
      }
      case 'pad': {
        const len = ev.dur * step;
        for (const n of ev.notes) {
          for (const detune of [-7, 7]) {
            const o = this.osc('sawtooth', hz(n), t, t + len + 0.5);
            o.detune.value = detune;
            this.env(this.filter('lowpass', 1400, o), t, 0.025, 0.25, len - 0.4, 0.5);
          }
        }
        break;
      }
      case 'lead': {
        const o = this.osc('square', hz(ev.note), t, t + 0.4);
        const f = this.filter('lowpass', 2800, o);
        this.env(f, t, 0.06, 0.005, 0.05, 0.22);
        this.env(f, t, 0.025, 0.005, 0.05, 0.22, this.delay);
        break;
      }
    }
  },
  click(hz = 1800, vol = 0.12) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.env(this.osc('triangle', hz, t, t + 0.12), t, vol, 0.002, 0, 0.09);
  },
  thud() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.osc('sawtooth', 90, t, t + 0.3);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    this.env(this.filter('lowpass', 400, o), t, 0.4, 0.005, 0, 0.25);
  },
};

// ---------------------------------------------------------------- Scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07060d);
scene.fog = new THREE.Fog(0x07060d, 10, 34);
const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 60);
camera.position.set(0, 1.6, 0);
camera.lookAt(0, 1.4, -10);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0x8899ff, 0x220022, 1.2));
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(1, 3, 2);
scene.add(key);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.fov = camera.aspect < 1 ? 85 : 65;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const grid = new THREE.GridHelper(80, 80, 0xff3fb4, 0x3a1450);
grid.material.transparent = true;
grid.material.opacity = 0.6;
scene.add(grid);
for (const x of [-2.4, 2.4]) {
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 80), new THREE.MeshBasicMaterial({ color: 0x33e4ff }));
  rail.position.set(x, 0.02, -30);
  scene.add(rail);
}
const ARCH_GAP = 6;
const arches = [];
const archMat = new THREE.MeshBasicMaterial({ color: 0x33e4ff, transparent: true, opacity: 0.5 });
for (let i = 0; i < 7; i++) {
  const arch = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.025, 6, 64, Math.PI), archMat);
  arch.position.set(0, 0, -i * ARCH_GAP);
  scene.add(arch);
  arches.push(arch);
}

// Arrow faces drawn on canvases.
const COLORS = { left: 0x33e4ff, right: 0x33e4ff, up: 0xff3fb4, down: 0xff3fb4, any: 0xffd166 };
function faceTexture(dir) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const col = '#' + COLORS[dir].toString(16).padStart(6, '0');
  g.fillStyle = '#0b0c22';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = col;
  g.lineWidth = 8;
  g.strokeRect(6, 6, 116, 116);
  g.fillStyle = col;
  g.shadowColor = col;
  g.shadowBlur = 16;
  g.translate(64, 64);
  if (dir === 'any') {
    g.beginPath();
    g.arc(0, 0, 18, 0, Math.PI * 2);
    g.fill();
  } else {
    g.rotate({ up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[dir]);
    g.beginPath();
    g.moveTo(0, -38);
    g.lineTo(34, 8);
    g.lineTo(12, 8);
    g.lineTo(12, 34);
    g.lineTo(-12, 34);
    g.lineTo(-12, 8);
    g.lineTo(-34, 8);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const BOX = 0.42;
const boxGeo = new THREE.BoxGeometry(BOX, BOX, BOX);
const sideMats = {};
const faceMats = {};
for (const d of [...DIRS, 'any']) {
  sideMats[d] = new THREE.MeshStandardMaterial({ color: 0x15163a, emissive: COLORS[d], emissiveIntensity: 0.45, roughness: 0.4 });
  faceMats[d] = new THREE.MeshBasicMaterial({ map: faceTexture(d) });
}
const mineGeo = new THREE.IcosahedronGeometry(0.2, 0);
const mineMat = new THREE.MeshStandardMaterial({ color: 0x40050c, emissive: 0xff2244, emissiveIntensity: 0.9, flatShading: true });
const spikeGeo = new THREE.ConeGeometry(0.05, 0.16, 6);

function makeTarget(note) {
  if (note.mine) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(mineGeo, mineMat));
    for (const v of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const s = new THREE.Mesh(spikeGeo, mineMat);
      const dir = new THREE.Vector3(...v);
      s.position.copy(dir).multiplyScalar(0.22);
      s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      g.add(s);
    }
    return g;
  }
  const side = sideMats[note.dir];
  return new THREE.Mesh(boxGeo, [side, side, side, side, faceMats[note.dir], side]);
}

// Blade, attached to the camera.
const bladeRig = new THREE.Group();
bladeRig.position.set(0.25, -0.38, -0.7);
camera.add(bladeRig);
const bladeMat = new THREE.MeshBasicMaterial({ color: 0xbff6ff });
{
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.1, 8), bladeMat);
  core.rotation.x = Math.PI / 2;
  core.position.z = -0.65;
  const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 12),
    new THREE.MeshBasicMaterial({ color: 0x33e4ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.rotation.x = Math.PI / 2;
  glow.position.z = -0.65;
  const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.2, 10), new THREE.MeshStandardMaterial({ color: 0x2a2d40, metalness: 0.8, roughness: 0.3 }));
  hilt.rotation.x = Math.PI / 2;
  hilt.position.z = 0.0;
  bladeRig.add(core, glow, hilt);
}
const TIP = new THREE.Vector3(0, 0, -1.2);
const BASE = new THREE.Vector3(0, 0, -0.15);

const TRAIL_N = 14;
const trailPos = new Float32Array(TRAIL_N * 6);
const trailCol = new Float32Array(TRAIL_N * 6);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
trailGeo.setIndex(Array.from({ length: TRAIL_N - 1 }, (_, i) => [i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2]).flat());
const trail = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
trail.frustumCulled = false;
scene.add(trail);
const trailHist = [];
let trailStrength = 0;

// Sparks
const SPARK_N = 500;
const sp = { pos: new Float32Array(SPARK_N * 3), col: new Float32Array(SPARK_N * 3), vel: new Float32Array(SPARK_N * 3), base: new Float32Array(SPARK_N * 3), life: new Float32Array(SPARK_N), next: 0 };
const sparkGeo = new THREE.BufferGeometry();
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sp.pos, 3));
sparkGeo.setAttribute('color', new THREE.BufferAttribute(sp.col, 3));
const sparkTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, '#fff');
  grad.addColorStop(0.4, 'rgba(255,255,255,.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
})();
const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ size: 0.06, map: sparkTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
sparks.frustumCulled = false;
scene.add(sparks);
function burst(p, n, color, speed = 3) {
  const c = new THREE.Color(color);
  for (let k = 0; k < n; k++) {
    const i = sp.next++ % SPARK_N;
    const v = new THREE.Vector3().randomDirection().multiplyScalar(speed * (0.3 + Math.random()));
    sp.pos.set([p.x, p.y, p.z], i * 3);
    sp.vel.set([v.x, v.y, v.z + 1.5], i * 3);
    sp.base.set([c.r, c.g, c.b], i * 3);
    sp.life[i] = 0.3 + Math.random() * 0.4;
  }
}
function updateSparks(dt) {
  for (let i = 0; i < SPARK_N; i++) {
    if (sp.life[i] <= 0) { sp.col[i * 3] = sp.col[i * 3 + 1] = sp.col[i * 3 + 2] = 0; continue; }
    sp.life[i] -= dt;
    sp.vel[i * 3 + 1] -= 6 * dt;
    for (let k = 0; k < 3; k++) {
      sp.pos[i * 3 + k] += sp.vel[i * 3 + k] * dt;
      sp.col[i * 3 + k] = sp.base[i * 3 + k] * Math.min(1, sp.life[i] * 3);
    }
  }
  sparkGeo.attributes.position.needsUpdate = true;
  sparkGeo.attributes.color.needsUpdate = true;
}

// Cut halves
const debris = [];
const halfH = new THREE.BoxGeometry(BOX, BOX / 2, BOX);
const halfV = new THREE.BoxGeometry(BOX / 2, BOX, BOX);
function slice(note, dir) {
  const horizontalCut = dir === 'left' || dir === 'right';
  const along = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1], any: [0, -1] }[dir];
  const mat = sideMats[note.dir];
  for (const sgn of [-1, 1]) {
    const m = new THREE.Mesh(horizontalCut ? halfH : halfV, mat);
    m.position.copy(note.mesh.position);
    if (horizontalCut) m.position.y += sgn * BOX / 4;
    else m.position.x += sgn * BOX / 4;
    scene.add(m);
    debris.push({
      mesh: m, life: 0.7,
      vel: new THREE.Vector3((horizontalCut ? 0 : sgn * 1.6) + along[0] * 2, (horizontalCut ? sgn * 1.6 : 0) + along[1] * 2, 1.5),
      spin: new THREE.Vector3(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3),
    });
  }
}
function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.life -= dt;
    d.vel.y -= 5 * dt;
    d.mesh.position.addScaledVector(d.vel, dt);
    d.mesh.rotation.x += d.spin.x * dt;
    d.mesh.rotation.y += d.spin.y * dt;
    d.mesh.scale.setScalar(Math.max(0.01, d.life / 0.7));
    if (d.life <= 0) { scene.remove(d.mesh); debris.splice(i, 1); }
  }
}

// ---------------------------------------------------------------- Game state

const pad = new Mocon();
const S = {
  mode: 'menu', // menu | calibrate | play | paused | results
  input: null, // phone | mouse
  songIdx: store.get('song', 0),
  diff: store.get('diff', 'normal'),
  offsetMs: store.get('offset', 0),
  chart: null, songStart: 0, nextAudio: 0, nextSpawn: 0,
  score: 0, combo: 0, maxCombo: 0, health: 100,
  perfect: 0, good: 0, miss: 0, errors: [],
  autoplay: false,
};
const HIT_Z = -1.25;
const SPAWN_DIST = 22;

function outputLatency() {
  const c = synth.ctx;
  return c ? (c.outputLatency || c.baseLatency || 0) : 0;
}
// Song time the player is hearing right now.
const songTime = () => synth.now - S.songStart - outputLatency();
// Input arrives later than the motion happened; compensate, plus the user's own offset.
const inputDelay = () => (S.input === 'phone' ? 0.06 : 0.02) + S.offsetMs / 1000;

function startSong() {
  synth.ensure();
  clearNotes();
  const song = SONGS[S.songIdx];
  S.chart = buildSong(song, S.diff);
  S.chart.notes.forEach((n) => { n.judged = false; n.mesh = null; });
  S.songStart = synth.now + 0.4;
  S.nextAudio = 0;
  S.nextSpawn = 0;
  Object.assign(S, { score: 0, combo: 0, maxCombo: 0, health: 100, perfect: 0, good: 0, miss: 0, errors: [] });
  S.mode = 'play';
  ['menu', 'results', 'pause'].forEach((id) => $(id).classList.remove('show'));
  hint(`${song.title} · ${DIFFS[S.diff].label}`, 4);
}

function clearNotes() {
  if (!S.chart) return;
  for (const n of S.chart.notes) if (n.mesh) { scene.remove(n.mesh); n.mesh = null; }
}

function scheduleAudio() {
  const ch = S.chart;
  const horizon = synth.now + 0.2;
  while (S.nextAudio < ch.audio.length) {
    const ev = ch.audio[S.nextAudio];
    const t = S.songStart + ev.step * ch.step;
    if (t > horizon) break;
    if (t >= synth.now - 0.05) synth.play(ev, t, ch.step);
    S.nextAudio++;
  }
}

function judge(dir, atTime) {
  if (S.mode !== 'play') return;
  const t = atTime - inputDelay();
  let best = null;
  let mineHit = null;
  for (const n of S.chart.notes) {
    if (n.judged) continue;
    const err = t - n.t;
    if (err < -GOOD) break;
    if (n.mine) { if (Math.abs(err) <= MINE_WINDOW) mineHit = n; continue; }
    if (Math.abs(err) > GOOD) continue;
    const fits = n.dir === 'any' || n.dir === dir;
    // Prefer the nearest note that matches; otherwise the nearest one.
    if (!best || (fits && !best.fits) || (fits === best.fits && Math.abs(err) < Math.abs(best.err))) best = { n, err, fits };
  }
  if (best) {
    const { n, err, fits } = best;
    n.judged = true;
    if (!fits) return register(n, 'wrong');
    S.errors.push(err);
    register(n, Math.abs(err) <= PERFECT ? 'perfect' : 'good', dir);
  } else if (mineHit) {
    mineHit.judged = true;
    register(mineHit, 'mine');
  }
}

function register(n, result, dir) {
  const pos = n.mesh ? n.mesh.position.clone() : new THREE.Vector3(n.x, n.y, HIT_Z);
  const d = DIFFS[S.diff];
  if (result === 'perfect' || result === 'good') {
    const perfect = result === 'perfect';
    S.combo++;
    S.maxCombo = Math.max(S.maxCombo, S.combo);
    S[result]++;
    S.score += (perfect ? 100 : 60) * multiplier();
    S.health = Math.min(100, S.health + (perfect ? 2 : 1));
    if (n.mesh) slice(n, dir);
    burst(pos, perfect ? 30 : 18, COLORS[n.dir], 3);
    synth.click(perfect ? 2200 : 1600);
    buzz(25, perfect ? 255 : 140);
  } else {
    S.combo = 0;
    if (result !== 'mine') S.miss++;
    S.health -= result === 'mine' ? 18 : d.missCost;
    flash = 1;
    synth.thud();
    buzz(result === 'mine' ? 200 : 90, 255);
    if (result === 'mine') burst(pos, 40, 0xff2244, 4);
  }
  if (n.mesh && result !== 'miss') { scene.remove(n.mesh); n.mesh = null; }
  popup({ perfect: 'PERFECT', good: 'GOOD', miss: 'MISS', wrong: 'WRONG WAY', mine: 'MINE!' }[result], pos, result);
  if (S.health <= 0) finish(false);
}

const multiplier = () => Math.min(4, 1 + Math.floor(S.combo / 10));

function finish(cleared) {
  if (S.mode !== 'play') return;
  S.mode = 'results';
  S.health = Math.max(0, S.health);
  if (!cleared) {
    // Fade out whatever is scheduled.
    synth.master.gain.setTargetAtTime(0, synth.now, 0.1);
    setTimeout(() => { synth.master.gain.cancelScheduledValues(synth.now); synth.master.gain.value = 0.8; }, 900);
  }
  const notes = S.chart.notes.filter((n) => !n.mine).length;
  const acc = notes ? (S.perfect + 0.6 * S.good) / notes : 0;
  const grade = !cleared ? 'F' : acc >= 0.95 ? 'S' : acc >= 0.88 ? 'A' : acc >= 0.75 ? 'B' : acc >= 0.6 ? 'C' : 'D';
  const song = SONGS[S.songIdx];
  const bestKey = `best.${song.id}.${S.diff}`;
  const prevBest = store.get(bestKey, 0);
  if (cleared && S.score > prevBest) store.set(bestKey, S.score);
  $('resTitle').textContent = cleared ? 'Cleared' : 'Energy depleted';
  $('grade').textContent = grade;
  $('resSong').textContent = `${song.title} · ${DIFFS[S.diff].label}`;
  $('resScore').textContent = S.score.toLocaleString();
  $('resAcc').textContent = Math.round(acc * 100) + '%';
  $('resCombo').textContent = S.maxCombo;
  $('resPerfect').textContent = S.perfect;
  $('resGood').textContent = S.good;
  $('resMiss').textContent = S.miss;
  $('resBest').textContent = cleared && S.score > prevBest ? 'New best!' : prevBest ? `Best: ${prevBest.toLocaleString()}` : '';
  // Timing advice from the average error of successful hits.
  const n = S.errors.length;
  const mean = n ? S.errors.reduce((a, b) => a + b, 0) / n : 0;
  if (n >= 8 && Math.abs(mean) > 0.02) {
    const suggest = Math.round((S.offsetMs + mean * 1000) / 10) * 10;
    $('resTiming').textContent = `You hit ${Math.round(Math.abs(mean) * 1000)} ms ${mean > 0 ? 'late' : 'early'} on average. Try a timing offset of ${suggest} ms.`;
    S.suggestedOffset = suggest;
  } else {
    $('resTiming').textContent = n >= 8 ? 'Your timing is centered. Nice.' : '';
    S.suggestedOffset = null;
  }
  setTimeout(() => $('results').classList.add('show'), cleared ? 600 : 900);
}

// ---------------------------------------------------------------- Input: slash detection

const SLASH_CFG = { phone: { start: 4.5, end: 2.2, minAmp: 0.3 }, mouse: { start: 3.0, end: 1.4, minAmp: 0.22 } };
const det = { prev: null, speed: 0, active: false, sy: 0, sp: 0, st: 0, locked: false, fired: [0, 0] };
// Fires as soon as the swing has travelled far enough, so judging isn't delayed until the swing ends.
function feed(yaw, pitch, t, onFire) {
  const cfg = SLASH_CFG[S.input] || SLASH_CFG.mouse;
  const p = det.prev;
  det.prev = { yaw, pitch, t };
  if (!p) return;
  const dt = t - p.t;
  if (dt <= 0.001 || dt > 0.2) return;
  const vy = (yaw - p.yaw) / dt;
  const vp = (pitch - p.pitch) / dt;
  const raw = Math.hypot(vy, vp);
  det.speed = det.speed * 0.35 + raw * 0.65;
  // A reversal (down then straight back up) starts a new slash without waiting to slow down.
  if (det.locked && (det.speed < cfg.end || (raw > cfg.start && vy * det.fired[0] + vp * det.fired[1] < 0))) det.locked = false;
  if (!det.active && !det.locked && det.speed > cfg.start) {
    det.active = true;
    det.sy = p.yaw; det.sp = p.pitch; det.st = t;
  }
  if (!det.active) return;
  const dy = yaw - det.sy;
  const dp = pitch - det.sp;
  if (Math.hypot(dy, dp) >= cfg.minAmp) {
    det.active = false;
    det.locked = true;
    det.fired = [dy, dp];
    onFire(Math.abs(dy) > Math.abs(dp) ? (dy > 0 ? 'right' : 'left') : dp > 0 ? 'up' : 'down');
  } else if (t - det.st > 0.35 || det.speed < cfg.end) {
    det.active = false;
  }
}

const aim = { yaw: 0, pitch: 0 };
const bladeTarget = new THREE.Quaternion();
const phoneQ = new THREE.Quaternion();
const FORWARD = new THREE.Vector3(0, 0, -1);
const tmp = new THREE.Vector3();
function aimOf(q) {
  tmp.copy(FORWARD).applyQuaternion(q);
  return { yaw: Math.atan2(tmp.x, -tmp.z), pitch: Math.asin(THREE.MathUtils.clamp(tmp.y, -1, 1)) };
}
let phoneClock = null;
pad.addEventListener('motion', (e) => {
  if (S.input !== 'phone') return;
  const q = Mocon.toThree(e.detail.quaternion);
  phoneQ.set(q.x, q.y, q.z, q.w);
  const a = aimOf(phoneQ);
  aim.yaw = a.yaw;
  aim.pitch = a.pitch;
  if (!phoneClock) phoneClock = { last: e.detail.timeMs, t: 0 };
  phoneClock.t += ((e.detail.timeMs - phoneClock.last) & 0xffff) / 1000;
  phoneClock.last = e.detail.timeMs;
  if (S.mode === 'play') feed(a.yaw, a.pitch, phoneClock.t, (dir) => judge(dir, synth.now - S.songStart - outputLatency()));
});

const mouse = { x: 0.5, y: 0.5 };
addEventListener('pointermove', (e) => { mouse.x = e.clientX / innerWidth; mouse.y = e.clientY / innerHeight; });
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Space: 'any' };
let keySwing = null; // brief blade animation for keyboard play
addEventListener('keydown', (e) => {
  if (e.code === 'Escape') return S.mode === 'paused' ? resume() : pause();
  const dir = KEYS[e.code];
  if (!dir || e.repeat) return;
  e.preventDefault();
  if (S.mode !== 'play') return;
  if (!S.input) S.input = 'mouse';
  keySwing = { dir, t: 0 };
  judge(dir === 'any' ? 'any' : dir, songTime() + inputDelay() - 0.0); // keys have no motion delay
});

function buzz(ms, amp) {
  if (S.input === 'phone' && pad.connected) pad.vibrate(ms, amp).catch(() => {});
}

// ---------------------------------------------------------------- UI

let flash = 0;
let hintTimer = 0;
function hint(text, s = 0) { $('hint').textContent = text; hintTimer = s; }
const projV = new THREE.Vector3();
function popup(text, world, cls) {
  projV.copy(world).project(camera);
  const el = document.createElement('div');
  el.className = 'pop ' + cls;
  el.textContent = text;
  el.style.left = (projV.x * 0.5 + 0.5) * innerWidth + 'px';
  el.style.top = (-projV.y * 0.5 + 0.5) * innerHeight + 'px';
  $('hud').appendChild(el);
  setTimeout(() => el.remove(), 600);
}

function renderMenu() {
  const songs = $('songs');
  songs.innerHTML = '';
  SONGS.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'song' + (i === S.songIdx ? ' on' : '');
    const best = store.get(`best.${s.id}.${S.diff}`, 0);
    b.innerHTML = `<span><b>${s.title}</b><br><small>${s.bpm} BPM</small></span><small>${best ? 'Best ' + best.toLocaleString() : ''}</small>`;
    b.onclick = () => { S.songIdx = i; store.set('song', i); renderMenu(); };
    songs.appendChild(b);
  });
  const diffs = $('diffs');
  diffs.innerHTML = '';
  for (const [k, d] of Object.entries(DIFFS)) {
    const b = document.createElement('button');
    b.textContent = d.label;
    b.className = k === S.diff ? 'on' : '';
    b.onclick = () => { S.diff = k; store.set('diff', k); renderMenu(); };
    diffs.appendChild(b);
  }
  $('offsetVal').textContent = `${S.offsetMs} ms`;
  $('btnPhone').textContent = pad.connected ? 'Play with phone' : 'Connect phone';
}
function setOffset(v) { S.offsetMs = Math.max(-300, Math.min(300, v)); store.set('offset', S.offsetMs); renderMenu(); }
$('offMinus').onclick = () => setOffset(S.offsetMs - 10);
$('offPlus').onclick = () => setOffset(S.offsetMs + 10);

$('btnPhone').onclick = async () => {
  synth.ensure();
  try {
    if (!pad.connected) {
      $('menuStatus').textContent = 'Choose your phone in the browser\'s list…';
      await pad.connect();
      await pad.setLayout({ title: 'Cadence', buttons: ['Start · Pause'] });
      $('menuStatus').textContent = `Connected: ${pad.info?.model ?? 'phone'}`;
    }
    S.input = 'phone';
    S.mode = 'calibrate';
    $('menu').classList.remove('show');
    hint('Hold your phone like a sword, pointing at the screen, and press Start on your phone.');
  } catch (err) {
    $('menuStatus').textContent = err.name === 'NotFoundError' ? 'No phone chosen.' : err.message;
  }
};
$('btnMouse').onclick = () => { S.input = 'mouse'; startSong(); };
$('btnRetry').onclick = () => {
  if (S.input === 'phone' && pad.connected) pad.recenter().catch(() => {});
  startSong();
};
$('btnMenu').onclick = toMenu;
$('btnQuit').onclick = () => { synth.ctx?.resume(); clearNotes(); toMenu(); };
$('btnResume').onclick = resume;
$('btnReconnect').onclick = async () => {
  try {
    await pad.reconnect();
    await pad.setLayout({ title: 'Cadence', buttons: ['Start · Pause'] });
    resume();
  } catch (err) { $('pauseText').textContent = `Couldn't reconnect: ${err.message}`; }
};

function toMenu() {
  if (S.suggestedOffset != null && $('results').classList.contains('show')) setOffset(S.suggestedOffset);
  S.suggestedOffset = null;
  S.mode = 'menu';
  ['results', 'pause'].forEach((id) => $(id).classList.remove('show'));
  $('menu').classList.add('show');
  hint('');
  renderMenu();
}

function pause(reason) {
  if (S.mode !== 'play') return;
  S.mode = 'paused';
  synth.ctx?.suspend();
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
  synth.ctx?.resume();
  S.mode = 'play';
}

pad.addEventListener('buttondown', (e) => {
  if (e.detail.index !== 0) return;
  if (S.mode === 'calibrate') { pad.recenter().catch(() => {}); startSong(); }
  else if (S.mode === 'play') pause();
  else if (S.mode === 'paused') resume();
  else if (S.mode === 'results') $('btnRetry').click();
});
pad.addEventListener('disconnect', () => {
  renderMenu();
  if (S.input === 'phone') pause('disconnect');
});
if (!Mocon.isSupported()) {
  $('btnPhone').disabled = true;
  $('menuStatus').textContent = 'This browser can\'t use Bluetooth. Use Chrome or Edge for phone play, or play with mouse / keys.';
}
renderMenu();

// ---------------------------------------------------------------- Frame loop

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const playing = S.mode === 'play';
  const t = S.chart && (playing || S.mode === 'paused' || S.mode === 'results') ? songTime() : 0;

  // Blade aim
  if (S.input === 'phone') {
    bladeTarget.copy(phoneQ);
  } else {
    aim.yaw = (mouse.x - 0.5) * 1.8;
    aim.pitch = (0.5 - mouse.y) * 1.4 + 0.05;
    if (keySwing) {
      keySwing.t += dt;
      const k = Math.sin(Math.min(1, keySwing.t / 0.15) * Math.PI);
      const v = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0], any: [0, -1] }[keySwing.dir];
      aim.yaw += v[0] * 0.6 * (k - 0.5);
      aim.pitch += v[1] * 0.6 * (k - 0.5);
      if (keySwing.t > 0.15) keySwing = null;
    }
    euler.set(aim.pitch, -aim.yaw, -aim.yaw * 0.6);
    bladeTarget.setFromEuler(euler);
    if (playing && !keySwing) feed(aim.yaw, aim.pitch, now / 1000, (dir) => judge(dir, songTime()));
  }
  bladeRig.quaternion.slerp(bladeTarget, 1 - Math.exp(-dt * 35));

  if (playing) {
    scheduleAudio();
    const ch = S.chart;
    const travel = DIFFS[S.diff].travel;
    const speed = SPAWN_DIST / travel;
    // Spawn
    while (S.nextSpawn < ch.notes.length && ch.notes[S.nextSpawn].t - t < travel + 0.2) {
      const n = ch.notes[S.nextSpawn++];
      n.mesh = makeTarget(n);
      scene.add(n.mesh);
    }
    // Move, autoplay, miss
    for (let i = Math.max(0, S.nextSpawn - 40); i < S.nextSpawn; i++) {
      const n = ch.notes[i];
      if (!n.mesh) continue;
      n.mesh.position.set(n.x, n.y, HIT_Z - (n.t - t) * speed);
      if (n.mine) { n.mesh.rotation.x += dt * 2; n.mesh.rotation.y += dt * 3; }
      if (S.autoplay && !n.judged && !n.mine && t >= n.t) judge(n.dir === 'any' ? 'down' : n.dir, synth.now - S.songStart - outputLatency() + inputDelay());
      if (!n.judged && t - n.t > GOOD) {
        n.judged = true;
        if (!n.mine) register(n, 'miss');
      }
      if (n.mesh && n.mesh.position.z > 1) { scene.remove(n.mesh); n.mesh = null; }
    }
    if (t > ch.duration && S.mode === 'play') finish(true);
  }

  // Environment pulses with the beat.
  const beat = S.chart ? S.chart.beat : 0.5;
  const pulse = playing && t > 0 ? Math.exp(-((t / beat) % 1) * 5) : 0.15;
  const travel = DIFFS[S.diff].travel;
  const flow = playing ? (t * SPAWN_DIST) / travel : now / 400;
  grid.position.z = flow % 1;
  for (let i = 0; i < arches.length; i++) {
    arches[i].position.z = -((i * ARCH_GAP - flow) % (ARCH_GAP * arches.length) + ARCH_GAP * arches.length) % (ARCH_GAP * arches.length) + 1;
  }
  archMat.opacity = 0.25 + 0.6 * pulse;
  grid.material.opacity = 0.35 + 0.4 * pulse;

  // Trail
  bladeRig.updateMatrixWorld(true);
  trailHist.unshift([bladeRig.localToWorld(BASE.clone()), bladeRig.localToWorld(TIP.clone())]);
  if (trailHist.length > TRAIL_N) trailHist.pop();
  const swinging = det.speed > (S.input === 'phone' ? 3.5 : 2) || keySwing;
  trailStrength += ((swinging ? 1 : 0) - trailStrength) * (1 - Math.exp(-dt * (swinging ? 25 : 6)));
  for (let i = 0; i < TRAIL_N; i++) {
    const [b, tp] = trailHist[Math.min(i, trailHist.length - 1)];
    trailPos.set([b.x, b.y, b.z, tp.x, tp.y, tp.z], i * 6);
    const a = trailStrength * (1 - i / TRAIL_N) * 0.7;
    trailCol.set([0.2 * a * 0.2, 0.9 * a * 0.2, a * 0.2, 0.2 * a, 0.9 * a, a], i * 6);
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.attributes.color.needsUpdate = true;

  updateSparks(dt);
  updateDebris(dt);

  // HUD
  $('score').textContent = S.score.toLocaleString();
  $('mult').textContent = multiplier() > 1 ? `×${multiplier()}` : '';
  $('health').style.width = Math.max(0, S.health) + '%';
  $('combo').innerHTML = S.combo >= 5 && playing ? `${S.combo}<small>COMBO</small>` : '';
  $('progress').firstElementChild.style.width = S.chart && playing ? Math.min(100, (100 * t) / S.chart.duration) + '%' : '0';
  flash = Math.max(0, flash - dt * 3);
  $('flash').style.opacity = flash;
  if (hintTimer > 0 && (hintTimer -= dt) <= 0) $('hint').textContent = '';

  renderer.render(scene, camera);
});

// For automated checks only.
window.__cadence = { S, SONGS, DIFFS, buildSong, judge, songTime, startSong, synth, renderer, scene, camera, inputDelay, feed, det };
