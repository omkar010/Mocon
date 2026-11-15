// Boundary — a 3D cricket batting game for the Mocon phone controller (or mouse / keyboard).
// World units are metres. The batting crease is at z = 0, the bowler's stumps at z = -20.12,
// and +x is the off side (right of screen) for our right-handed batter.
import * as THREE from 'three';
import { Mocon } from '../mocon.js?v=20261114-2350';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('boundary.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('boundary.' + k, JSON.stringify(v)); } catch {} },
};

// ---------------------------------------------------------------- Tuning

const MODES = {
  chase: { label: 'Chase', sub: '2 overs · 3 wkts', balls: 12, wickets: 3, target: { club: 18, county: 24, intl: 30 } },
  super: { label: 'Super Over', sub: '6 balls · 2 wkts', balls: 6, wickets: 2, target: { club: 11, county: 14, intl: 18 } },
  nets: { label: 'Nets', sub: 'endless practice', balls: Infinity, wickets: Infinity, target: null },
};
const DIFFS = {
  // win = timing windows in seconds: [perfect, good, edge]. Outside the edge window is a miss.
  club:   { label: 'Club',          sub: 'gentle',           pace: [85, 100],  spin: [68, 76], seam: 0.5, turn: 1.4, short: 0.1,  win: [0.08, 0.15, 0.25] },
  county: { label: 'County',        sub: 'quick, some turn', pace: [105, 125], spin: [76, 86], seam: 0.9, turn: 2.0, short: 0.18, win: [0.065, 0.12, 0.2] },
  intl:   { label: 'International', sub: 'fast and tricky', pace: [125, 145], spin: [84, 94], seam: 1.3, turn: 2.6, short: 0.25, win: [0.05, 0.1, 0.17] },
};
const G = 9.8;
const BALL_R = 0.045;
const CONTACT_Z = -0.75; // where bat meets ball, just in front of the crease
const FIELD_CENTER = new THREE.Vector2(0, -10);
const BOUNDARY_R = 58;
const STUMP_Z = 0;
const BOWL_Z = -20.12;

// ---------------------------------------------------------------- Sound

const sfx = {
  ctx: null, master: null, noiseBuf: null,
  ensure() {
    if (!this.ctx) {
      const ctx = (this.ctx = new AudioContext());
      this.master = ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(ctx.destination);
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  noise(type, hz, q, vol, attack, dur) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = hz; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
    n.connect(f); f.connect(g); g.connect(this.master);
    n.start(t, Math.random(), attack + dur + 0.1);
  },
  tone(hz, to, dur, vol, type = 'sine') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  },
  crack(power) { this.noise('bandpass', 2200, 1.5, 0.6 * power + 0.2, 0.001, 0.07); this.tone(320, 140, 0.08, 0.3 * power); },
  edge() { this.noise('highpass', 3500, 1, 0.25, 0.001, 0.04); },
  bounce() { this.tone(140, 70, 0.07, 0.2); },
  stumps() { for (let i = 0; i < 3; i++) setTimeout(() => this.tone(900 + i * 300, 500, 0.08, 0.25, 'triangle'), i * 45); },
  crowd(size) { this.noise('bandpass', 900, 0.6, 0.15 + size * 0.2, 0.25, 1.4 + size); },
  groan() { this.noise('lowpass', 500, 0.5, 0.18, 0.15, 0.9); },
};

// ---------------------------------------------------------------- Scene
// A broadcast-style ground: sky, stands with crowd, floodlights, boards, sight screens, big screen.
// Everything is generated in code (canvas textures), so there are no image files to host.

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
// Rendering resolution steps down automatically if the frame rate drops (see adaptQuality), and the game
// remembers the step that worked last time, trying one better on each launch.
const QUALITY = [Math.min(devicePixelRatio, 2), Math.min(devicePixelRatio, 1.5), Math.min(devicePixelRatio, 1.25), 1];
const quality = { tier: Math.max(0, Number(localStorage.getItem('boundary.gfx') || 0) - 1), acc: 0, n: 0 };
renderer.setPixelRatio(QUALITY[quality.tier]);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const HORIZON = 0xd6e6f2;
scene.background = new THREE.Color(HORIZON);
scene.fog = new THREE.Fog(HORIZON, 160, 420);
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 900);
// Everything on the field (surface, players, ball). For a left-handed batter this group is mirrored, so the
// game logic always works in right-handed coordinates; the stadium (and its text) is never mirrored.
const world = new THREE.Group();
scene.add(world);

const rnd = (a, b) => a + Math.random() * (b - a);
const pickOf = (arr) => arr[Math.floor(Math.random() * arr.length)];
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}
function speckle(g, w, h, n, colors, size = 2) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = pickOf(colors);
    g.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
}

// Sky dome: deep blue overhead fading to a hazy horizon.
{
  const tex = canvasTex(8, 512, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#2f6fbf');
    grad.addColorStop(0.45, '#7fb6e6');
    grad.addColorStop(0.5, '#cfe2f1');
    grad.addColorStop(1, '#d6e6f2');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 16), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false }));
  scene.add(sky);
}

scene.add(new THREE.HemisphereLight(0xd8ecff, 0x40602c, 0.75));
// Soft outdoor reflections (sky above, grass below) for every lit surface, baked once at load.
{
  const env = new THREE.Scene();
  const envTex = canvasTex(4, 64, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#5d8fcc'); grad.addColorStop(0.48, '#dbe9f5'); grad.addColorStop(0.52, '#5d7f45'); grad.addColorStop(1, '#2f4a22');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  });
  env.add(new THREE.Mesh(new THREE.SphereGeometry(10, 16, 8), new THREE.MeshBasicMaterial({ map: envTex, side: THREE.BackSide })));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.02).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}
const sun = new THREE.DirectionalLight(0xfff0d6, 2.8);
sun.position.set(-45, 75, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
Object.assign(sun.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38, near: 10, far: 200 });
sun.target.position.set(0, 0, -12);
scene.add(sun, sun.target);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---- Playing surface
{
  // Outfield: straight mowing stripes with fine speckle so it doesn't look flat.
  const grass = canvasTex(2048, 2048, (g, w, h) => {
    const bands = 26;
    for (let i = 0; i < bands; i++) {
      g.fillStyle = i % 2 ? '#3f8c34' : '#4b9a3c';
      g.fillRect((i * w) / bands, 0, w / bands + 1, h);
    }
    speckle(g, w, h, 60000, ['rgba(20,60,15,.18)', 'rgba(120,180,80,.14)', 'rgba(30,80,20,.12)'], 3);
    // Slightly darker near the rope.
    const v = g.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w * 0.52);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(10,30,5,.25)');
    g.fillStyle = v;
    g.fillRect(0, 0, w, h);
  });
  const field = new THREE.Mesh(new THREE.CircleGeometry(BOUNDARY_R + 12, 128), new THREE.MeshStandardMaterial({ map: grass, roughness: 1 }));
  field.rotation.x = -Math.PI / 2;
  field.position.set(FIELD_CENTER.x, 0, FIELD_CENTER.y);
  field.receiveShadow = true;
  world.add(field);

  // The "square": the lighter, closely-cut block around the pitch.
  const squareTex = canvasTex(128, 256, (g, w, h) => {
    const rg = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, h / 2);
    rg.addColorStop(0, 'rgba(120,190,90,.55)');
    rg.addColorStop(0.6, 'rgba(120,190,90,.35)');
    rg.addColorStop(1, 'rgba(120,190,90,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
  });
  const square = new THREE.Mesh(new THREE.PlaneGeometry(18, 34), new THREE.MeshStandardMaterial({ map: squareTex, roughness: 1, transparent: true, depthWrite: false }));
  square.rotation.x = -Math.PI / 2;
  square.position.set(0, 0.001, -10.06);
  square.receiveShadow = true;
  world.add(square);

  // Pitch: dry, cracked strip with worn bowlers' footmarks at each end.
  const pitchTex = canvasTex(256, 2048, (g, w, h) => {
    g.fillStyle = '#cdb88a';
    g.fillRect(0, 0, w, h);
    speckle(g, w, h, 9000, ['rgba(140,110,60,.35)', 'rgba(240,225,190,.35)', 'rgba(110,90,50,.25)'], 2);
    // Edges fade into grass.
    const e = g.createLinearGradient(0, 0, w, 0);
    e.addColorStop(0, 'rgba(110,150,70,.55)'); e.addColorStop(0.12, 'rgba(0,0,0,0)');
    e.addColorStop(0.88, 'rgba(0,0,0,0)'); e.addColorStop(1, 'rgba(110,150,70,.55)');
    g.fillStyle = e;
    g.fillRect(0, 0, w, h);
    // Footmarks near both creases.
    for (const y of [h * 0.13, h * 0.87]) {
      for (let i = 0; i < 26; i++) {
        g.fillStyle = `rgba(120,90,50,${rnd(0.15, 0.35)})`;
        g.beginPath();
        g.ellipse(w / 2 + rnd(-60, 60), y + rnd(-90, 90), rnd(8, 22), rnd(10, 30), rnd(0, 3), 0, Math.PI * 2);
        g.fill();
      }
    }
    // Hairline cracks.
    g.strokeStyle = 'rgba(90,70,40,.35)';
    g.lineWidth = 1;
    for (let i = 0; i < 40; i++) {
      let x = rnd(30, w - 30), y = rnd(0, h);
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += rnd(-12, 12); y += rnd(-18, 18); g.lineTo(x, y); }
      g.stroke();
    }
  });
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(3.05, 24), new THREE.MeshStandardMaterial({ map: pitchTex, roughness: 1 }));
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.set(0, 0.003, -10.06);
  pitch.receiveShadow = true;
  world.add(pitch);

  const white = new THREE.MeshBasicMaterial({ color: 0xf6f6f0 });
  const line = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), white);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.005, z);
    world.add(m);
  };
  for (const end of [0, BOWL_Z]) {
    const dir = end === 0 ? -1 : 1;
    line(3.66, 0.05, 0, end + dir * 1.22); // popping crease
    line(2.64, 0.05, 0, end); // bowling crease
    for (const x of [-1.32, 1.32]) line(0.05, 2.4, x, end + dir * 0.6); // return creases
  }

  // 30-yard (inner) circle: white discs around two semicircles joined by straight lines.
  const ringPts = [];
  const R30 = 27.4;
  for (let a = 0; a <= Math.PI; a += 0.11) ringPts.push([Math.cos(a) * R30, BOWL_Z - Math.sin(a) * R30]);
  for (let a = Math.PI; a <= Math.PI * 2; a += 0.11) ringPts.push([Math.cos(a) * R30, -Math.sin(a) * R30]);
  for (let z = BOWL_Z; z < 0; z += 3) { ringPts.push([R30, z]); ringPts.push([-R30, z]); }
  const discs = new THREE.InstancedMesh(new THREE.CircleGeometry(0.28, 12), white, ringPts.length);
  const m = new THREE.Matrix4();
  const rx = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  ringPts.forEach(([x, z], i) => discs.setMatrixAt(i, m.makeTranslation(x, 0.006, z).multiply(rx)));
  world.add(discs);

  // Boundary rope.
  const rope = new THREE.Mesh(new THREE.TorusGeometry(BOUNDARY_R, 0.16, 8, 200), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }));
  rope.rotation.x = -Math.PI / 2;
  rope.position.set(FIELD_CENTER.x, 0.12, FIELD_CENTER.y);
  world.add(rope);
}

// ---- Advertising boards (all sponsor names are made up)
const SPONSORS = [
  ['VOLTA COLA', '#d62828', '#fff'], ['SKYLINE AIR', '#1d4e89', '#fff'], ['MOCON', '#ffcc33', '#10331f'],
  ['NORTHSTAR BANK', '#0b3d2e', '#e9c46a'], ['ZENITH PHONES', '#111', '#5ce1e6'], ['RAPID FUEL', '#f77f00', '#111'],
  ['GREENLEAF TEA', '#2d6a4f', '#fff'], ['ORBIT TV', '#5a189a', '#fff'],
];
// All sponsors share one texture (one row each) and all boards are one mesh: a single draw call.
const drawBoards = (g, w, h) => {
  const rh = h / SPONSORS.length;
  SPONSORS.forEach(([name, bg, fg], i) => {
    const y = i * rh;
    g.fillStyle = bg; g.fillRect(0, y, w, rh);
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, y, w, rh / 2);
    g.fillStyle = fg;
    g.font = '800 40px "Barlow Condensed", Impact, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, w / 2, y + rh / 2 + 2);
  });
};
const boardAtlas = canvasTex(512, 64 * SPONSORS.length, drawBoards);
{
  const r = BOUNDARY_R + 3;
  const N = 56;
  const half = Math.PI / N * 0.98;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const row = i % SPONSORS.length;
    const v0 = 1 - (row + 1) / SPONSORS.length;
    const v1 = 1 - row / SPONSORS.length;
    const base = pos.length / 3;
    // Viewed from the field, left edge is at angle a + half.
    for (const [da, y, u] of [[half, 0.025, 0], [-half, 0.025, 1], [-half, 0.975, 1], [half, 0.975, 0]]) {
      pos.push(FIELD_CENTER.x + Math.sin(a + da) * r, y, FIELD_CENTER.y + Math.cos(a + da) * r);
      uv.push(u, y < 0.5 ? v0 : v1);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: boardAtlas, side: THREE.DoubleSide })));
}

// ---- Stands with crowd
const crowdTex = canvasTex(2048, 512, (g, w, h) => {
  g.fillStyle = '#2b2f36';
  g.fillRect(0, 0, w, h);
  const shirts = ['#0f7c78', '#0f7c78', '#1b2f5e', '#1b2f5e', '#ffcc33', '#e9ecef', '#d62828', '#f77f00', '#457b9d', '#6c757d', '#ffffff'];
  const skins = ['#8d5524', '#c68642', '#e0ac69', '#f1c27d', '#5c3a21'];
  for (let y = 6; y < h; y += 14) {
    // Seat rows.
    g.fillStyle = y % 28 ? '#3a404a' : '#343a43';
    g.fillRect(0, y + 6, w, 6);
    for (let x = 2; x < w; x += 9) {
      if (Math.random() < 0.12) continue; // empty seat
      const sx = x + rnd(-1.5, 1.5);
      g.fillStyle = pickOf(shirts);
      g.fillRect(sx, y + 4, 7, 8);
      g.fillStyle = pickOf(skins);
      g.beginPath(); g.arc(sx + 3.5, y + 2, 3, 0, Math.PI * 2); g.fill();
    }
  }
  // A few flags and banners in the crowd.
  for (let i = 0; i < 22; i++) {
    g.fillStyle = pickOf(['#0f7c78', '#ffcc33', '#1b2f5e', '#d62828']);
    g.fillRect(rnd(0, w), rnd(0, h - 30), rnd(18, 40), rnd(10, 18));
  }
  // Soften it slightly: the stands sit far behind the action, out of the camera's focus.
  const copy = document.createElement('canvas');
  copy.width = w; copy.height = h;
  copy.getContext('2d').drawImage(g.canvas, 0, 0);
  g.filter = 'blur(1.3px)';
  g.drawImage(copy, 0, 0);
  g.filter = 'none';
}, [10, 1]);
const crowdMaps = [];
let crowdCheer = 0;
{
  const stand = (r0, r1, y0, y1, repeatX) => {
    const t = crowdTex.clone();
    t.needsUpdate = true;
    t.repeat.set(repeatX, 1);
    crowdMaps.push(t);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, y1 - y0, 128, 1, true),
      new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 1 }));
    m.position.set(FIELD_CENTER.x, (y0 + y1) / 2, FIELD_CENTER.y);
    scene.add(m);
  };
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3d4450, side: THREE.DoubleSide, roughness: 0.9 });
  const ring = (r, y0, y1, mat = wallMat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, y1 - y0, 128, 1, true), mat);
    m.position.set(FIELD_CENTER.x, (y0 + y1) / 2, FIELD_CENTER.y);
    scene.add(m);
  };
  ring(BOUNDARY_R + 9, 0, 2.2);                         // front wall
  stand(BOUNDARY_R + 9, BOUNDARY_R + 30, 2.2, 15, 12);   // lower tier
  ring(BOUNDARY_R + 30, 15, 17.5);                       // balcony facade
  stand(BOUNDARY_R + 31, BOUNDARY_R + 46, 17.5, 28, 14); // upper tier
  // Roof canopies over the side stands (left open behind each end for the sight screens).
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xd9dde2, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.2 });
  for (const start of [0.35, Math.PI + 0.35]) {
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(BOUNDARY_R + 50, BOUNDARY_R + 26, 4, 64, 1, true, start, Math.PI - 0.7), roofMat);
    roof.position.set(FIELD_CENTER.x, 33, FIELD_CENTER.y);
    scene.add(roof);
  }
  // Outer shell so the sky doesn't show through gaps.
  ring(BOUNDARY_R + 47, 0, 30, new THREE.MeshStandardMaterial({ color: 0x2b313a, side: THREE.DoubleSide }));
}

// ---- Sight screens behind both ends (white, so the red ball stands out)
for (const z of [FIELD_CENTER.y - BOUNDARY_R - 6, FIELD_CENTER.y + BOUNDARY_R + 6]) {
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2b313a, roughness: 0.8 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(22.6, 8.6, 0.4), frameMat);
  back.position.set(0, 6.5, z);
  const screenFace = new THREE.Mesh(new THREE.BoxGeometry(22, 8, 0.5), new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.95 }));
  screenFace.position.set(0, 6.5, z);
  scene.add(back, screenFace);
  for (const x of [-9, -3, 3, 9]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.4, 0.3), frameMat);
    leg.position.set(x, 1.2, z);
    scene.add(leg);
  }
}

// ---- Floodlight towers
{
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 });
  const lampTex = canvasTex(256, 160, (g, w, h) => {
    g.fillStyle = '#20252b'; g.fillRect(0, 0, w, h);
    for (let y = 12; y < h; y += 24) for (let x = 12; x < w; x += 24) {
      const rg = g.createRadialGradient(x, y, 1, x, y, 10);
      rg.addColorStop(0, '#ffffff'); rg.addColorStop(1, 'rgba(255,240,200,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(x, y, 10, 0, Math.PI * 2); g.fill();
    }
  });
  for (const a of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
    const r = BOUNDARY_R + 58;
    const x = FIELD_CENTER.x + Math.sin(a) * r, z = FIELD_CENTER.y + Math.cos(a) * r;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.6, 62, 10), steel);
    pole.position.set(x, 31, z);
    const head = new THREE.Mesh(new THREE.BoxGeometry(12, 7, 0.8), [steel, steel, steel, steel, new THREE.MeshBasicMaterial({ map: lampTex }), steel]);
    head.position.set(x, 64, z);
    head.lookAt(FIELD_CENTER.x, 0, FIELD_CENTER.y);
    scene.add(pole, head);
  }
}

// ---- Big screen showing the score (redrawn after every ball)
const bigScreen = (() => {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 440;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const a = 2.35; // behind deep midwicket / long-on
  const r = BOUNDARY_R + 40;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(27, 12, 1), new THREE.MeshStandardMaterial({ color: 0x1a1d22 }));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(25, 10.7), new THREE.MeshBasicMaterial({ map: tex, fog: false }));
  const x = FIELD_CENTER.x + Math.sin(a) * r, z = FIELD_CENTER.y + Math.cos(a) * r;
  frame.position.set(x, 36, z);
  screen.position.set(x, 36, z);
  frame.lookAt(FIELD_CENTER.x, 36, FIELD_CENTER.y);
  screen.lookAt(FIELD_CENTER.x, 36, FIELD_CENTER.y);
  screen.translateZ(0.6);
  scene.add(frame, screen);
  return {
    draw(lines) {
      const g = c.getContext('2d');
      g.fillStyle = '#06120b'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#ffcc33'; g.fillRect(0, 0, c.width, 90);
      g.fillStyle = '#10331f';
      g.font = '800 64px "Barlow Condensed", Impact, sans-serif';
      g.textBaseline = 'middle';
      g.fillText('BOUNDARY', 32, 47);
      g.textAlign = 'right';
      g.fillText(lines.tag || '', c.width - 32, 47);
      g.textAlign = 'left';
      g.fillStyle = '#ffffff';
      g.font = '800 170px "Barlow Condensed", Impact, sans-serif';
      g.fillText(lines.score, 32, 200);
      g.font = '600 60px "Barlow Condensed", Impact, sans-serif';
      g.fillStyle = '#c4d3c8';
      g.fillText(lines.overs, 32, 330);
      g.fillStyle = '#ffcc33';
      g.fillText(lines.need || '', 32, 395);
      tex.needsUpdate = true;
    },
  };
})();

// ---- Stumps at both ends
function makeStumps(z) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0xf1e3c2, roughness: 0.5 });
  const stumps = [];
  for (const x of [-0.11, 0, 0.11]) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.71, 12), wood);
    s.position.set(x, 0.355, 0);
    s.castShadow = true;
    g.add(s);
    stumps.push(s);
  }
  const bails = [];
  for (const x of [-0.055, 0.055]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.02, 0.02), wood);
    b.position.set(x, 0.72, 0);
    g.add(b);
    bails.push(b);
  }
  g.position.z = z;
  world.add(g);
  return { g, stumps, bails, flying: null };
}
const batStumps = makeStumps(STUMP_Z);
makeStumps(BOWL_Z);

function resetStumps() {
  batStumps.stumps.forEach((s, i) => { s.position.set([-0.11, 0, 0.11][i], 0.355, 0); s.rotation.set(0, 0, 0); });
  batStumps.bails.forEach((b, i) => { b.position.set([-0.055, 0.055][i], 0.72, 0); b.rotation.set(0, 0, 0); });
  batStumps.flying = null;
}
function breakStumps(ballVel) {
  batStumps.flying = [...batStumps.stumps, ...batStumps.bails].map((o, i) => ({
    o, v: new THREE.Vector3((Math.random() - 0.5) * 2 + ballVel.x * 0.1, i >= 3 ? 3 + Math.random() * 2 : 0.5, 2 + Math.random() * 2),
    spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10), tilt: i < 3,
  }));
}

// ---- People
// Jointed figures: hip and shoulder pivots so they can run, bowl and crouch.
const SKIN = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0x5c3a21, 0xa8714a];
const people = []; // everyone whose legs animate from their movement
// People share materials by colour, so fifteen players don't mean a hundred-odd materials.
const personMats = new Map();
const std = (color, rough = 0.75) => {
  const key = `${color}/${rough}`;
  if (!personMats.has(key)) personMats.set(key, new THREE.MeshStandardMaterial({ color, roughness: rough }));
  return personMats.get(key);
};
const grilleMat = new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.8, roughness: 0.3 });
function person(kit, opts = {}) {
  const g = new THREE.Group();
  const kitMat = std(kit);
  const pantMat = std(opts.pants ?? kit);
  const trimMat = std(opts.trim ?? 0xffcc33, 0.6);
  const skinMat = std(opts.skin ?? pickOf(SKIN), 0.7);
  const shoeMat = std(0xf2f2f2, 0.6);
  const padMat = std(0xf7f7f2, 0.6);
  const gloveMat = std(opts.gloves ?? 0xf7f7f2, 0.6);
  const cast = (o) => { o.castShadow = true; return o; };

  const legs = [];
  const knees = [];
  const ankles = [];
  // Everything above the hips hangs off one joint, so the body can bend and turn; the head has its own.
  const upper = new THREE.Group();
  upper.position.y = 0.93;
  g.add(upper);
  const headG = new THREE.Group();
  headG.position.y = 1.6 - 0.93;
  upper.add(headG);
  const addUp = (o) => { o.position.y -= 0.93; upper.add(o); };
  const addHead = (o) => { o.position.y -= 1.6; headG.add(o); };
  for (const x of [-0.1, 0.1]) {
    const hip = new THREE.Group();
    hip.position.set(x, 0.93, 0);
    const thigh = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.078, 0.34, 4, 8), pantMat));
    thigh.position.y = -0.22;
    const knee = new THREE.Group();
    knee.position.y = -0.44;
    const shin = opts.pads ? new THREE.Mesh(new THREE.CapsuleGeometry(0.066, 0.34, 4, 8), padMat) : cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.066, 0.34, 4, 8), pantMat));
    shin.position.y = -0.18;
    const ankle = new THREE.Group();
    ankle.position.y = -0.45;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.25), shoeMat);
    foot.position.set(0, 0, 0.05);
    ankle.add(foot);
    knee.add(shin, ankle);
    hip.add(thigh, knee);
    if (opts.pads) {
      const pad = cast(new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.52, 0.09), padMat));
      pad.position.set(0, -0.11, 0.07);
      knee.add(pad);
    }
    g.add(hip);
    legs.push(hip);
    knees.push(knee);
    ankles.push(ankle);
  }
  const torso = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.4, 4, 12), kitMat));
  torso.position.y = 1.24;
  torso.scale.z = 0.75;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.172, 0.172, 0.05, 16), trimMat);
  band.position.y = 1.4;
  band.scale.z = 0.76;
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 16), trimMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 1.53;
  const head = cast(new THREE.Mesh(new THREE.SphereGeometry(0.115, 18, 14), skinMat));
  head.position.y = 1.67;
  [torso, band, collar].forEach(addUp);
  addHead(head);

  if (opts.helmet) {
    const hm = std(opts.helmet, 0.35);
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.135, 18, 12, 0, Math.PI * 2, 0, Math.PI / 1.75), hm);
    shell.position.y = 1.69;
    const peak = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.015, 0.09), hm);
    peak.position.set(0, 1.71, 0.13);
    [shell, peak].forEach(addHead);
    for (const y of [1.6, 1.64, 1.68]) {
      const bar = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.006, 4, 16, Math.PI * 0.75), grilleMat);
      bar.rotation.set(Math.PI / 2, 0, Math.PI * 0.125);
      bar.position.y = y;
      addHead(bar);
    }
  } else if (opts.cap !== false) {
    const cm = std(opts.cap ?? kit, 0.7);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.122, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), cm);
    cap.position.y = 1.69;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.012, 16, 1, false, -Math.PI / 2, Math.PI), cm);
    brim.position.set(0, 1.69, 0.08);
    [cap, brim].forEach(addHead);
  }
  if (opts.hat) {
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.012, 20), std(opts.hat));
    hat.position.y = 1.74;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.1, 16), std(opts.hat));
    crown.position.y = 1.8;
    [hat, crown].forEach(addHead);
  }

  const arms = [];
  for (const x of [-0.23, 0.23]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(x, 1.45, 0);
    const upperArm = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.24, 4, 8), kitMat));
    upperArm.position.y = -0.16;
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.24, 4, 8), opts.sleeves ? kitMat : skinMat);
    fore.position.y = -0.44;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(opts.gloves ? 0.06 : 0.045, 10, 8), opts.gloves ? gloveMat : skinMat);
    hand.position.y = -0.6;
    shoulder.add(upperArm, fore, hand);
    addUp(shoulder);
    arms.push(shoulder);
  }
  const p = { g, legs, knees, ankles, arms, torso, upper, headG, last: new THREE.Vector3(), phase: Math.random() * 6 };
  people.push(p);
  return p;
}

// Run cycle from how fast each person actually moved this frame.
function animatePeople(dt) {
  for (const p of people) {
    const pos = p.g.position;
    const speed = dt > 0 ? Math.hypot(pos.x - p.last.x, pos.z - p.last.z) / dt : 0;
    p.last.copy(pos);
    if (p.noAnim) continue;
    const k = Math.min(1, speed / 6);
    p.phase += dt * (4 + speed * 1.6);
    const s = Math.sin(p.phase) * 0.9 * k;
    p.legs[0].rotation.x = s;
    p.legs[1].rotation.x = -s;
    p.knees.forEach((kn, i) => { kn.rotation.x = Math.max(0, Math.sin(p.phase + i * Math.PI + 1.2)) * 1.1 * k; });
    if (!p.armsBusy) {
      p.arms[0].rotation.x = -s * 0.8;
      p.arms[1].rotation.x = s * 0.8;
    }
    // Fielders lean in, ready, while the ball is bowled.
    const lean = p.ready && k < 0.1 ? 1 : 0;
    p.upper.rotation.x = 0.3 * lean + 0.12 * k;
    p.knees.forEach((kn) => { if (k < 0.1) kn.rotation.x = 0.5 * lean; });
    p.legs.forEach((h) => { if (k < 0.1) h.rotation.x = -0.25 * lean; });
  }
}

// Teams: batting side in teal, fielding side in navy with gold trim.
const BAT_KIT = { kit: 0x0f7c78, trim: 0xffcc33 };
const FIELD_KIT = { kit: 0x1b2f5e, trim: 0xffcc33 };

// Batter, side-on, facing the off side (+x), standing to the leg side of the stumps. Built in more detail
// than the fielders since the camera sits right behind them: shaped shirt, elbows, helmet with grille,
// ribbed pads, gloves and spiked shoes. Same joints as everyone else (hips, knees, ankles, upper body,
// head, shoulders), plus elbows.
function makeBatter() {
  const g = new THREE.Group();
  const mat = (color, rough = 0.7, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const at = (o, x, y, z) => { o.position.set(x, y, z); return o; };
  const cast = (o) => { o.castShadow = true; return o; };
  const skin = mat(pickOf(SKIN), 0.65);
  const pants = mat(0x0b5c59, 0.85);
  const gloveM = mat(0xf7f7f2, 0.5);
  const helmetM = mat(0x0b3d3a, 0.3, 0.15);
  const steel = mat(0xc4cad2, 0.3, 0.85);
  const shoeM = mat(0xf4f4f4, 0.5);
  // Shirt and pads carry their detail in small textures instead of extra meshes.
  const shirt = new THREE.MeshStandardMaterial({ roughness: 0.8, map: canvasTex(64, 32, (c, w, h) => {
    c.fillStyle = '#0f7c78'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#ffcc33';
    for (const x of [0.25, 0.75]) c.fillRect(x * w - 2, 0, 4, h); // side panels
    c.fillRect(0, h - 4, w, 2);
  }) });
  const padM = new THREE.MeshStandardMaterial({ roughness: 0.55, map: canvasTex(32, 64, (c, w, h) => {
    c.fillStyle = '#f6f5ef'; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(0,0,0,.12)';
    for (const x of [10, 21]) c.fillRect(x, 0, 1.5, h); // the raised canes
    c.fillRect(0, 10, w, 2); // knee roll line
  }) });

  const legs = [];
  const knees = [];
  const ankles = [];
  for (const x of [-0.1, 0.1]) {
    const hip = at(new THREE.Group(), x, 0.93, 0);
    const thigh = cast(at(new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.3, 2, 8), pants), 0, -0.22, 0));
    const knee = at(new THREE.Group(), 0, -0.44, 0);
    // Pad covers the shin, from just above the knee down to the shoe.
    const pad = cast(at(new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.6, 0.11), padM), 0, -0.13, 0.04));
    const ankle = at(new THREE.Group(), 0, -0.45, 0);
    const shoe = at(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.26), shoeM), 0, -0.005, 0.05);
    ankle.add(shoe);
    knee.add(pad, ankle);
    hip.add(thigh, knee);
    g.add(hip);
    legs.push(hip);
    knees.push(knee);
    ankles.push(ankle);
  }
  const pelvis = at(new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 6), pants), 0, 0.95, 0);
  pelvis.scale.set(1.05, 0.7, 0.75);
  g.add(pelvis);

  const upper = at(new THREE.Group(), 0, 0.93, 0);
  g.add(upper);
  // Torso: waist narrower than the chest, flattened front to back.
  const prof = [[0.001, 0], [0.15, 0.02], [0.165, 0.2], [0.195, 0.45], [0.18, 0.57], [0.1, 0.63], [0.001, 0.65]].map(([r, y]) => new THREE.Vector2(r, y));
  const torso = cast(new THREE.Mesh(new THREE.LatheGeometry(prof, 14), shirt));
  torso.scale.z = 0.7;
  upper.add(torso);

  const headG = at(new THREE.Group(), 0, 0.67, 0);
  upper.add(headG);
  const head = at(new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), skin), 0, 0.06, 0.005);
  const shell = cast(at(new THREE.Mesh(new THREE.SphereGeometry(0.128, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.56), helmetM), 0, 0.085, -0.005));
  shell.scale.z = 1.1;
  const peak = at(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.012, 10, 1, false, -Math.PI / 2, Math.PI), helmetM), 0, 0.105, 0.03);
  peak.rotation.x = 0.12;
  // Grille: one curved bar is enough to read as a helmet at broadcast distance.
  const grille = at(new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.008, 4, 12, Math.PI * 0.9), steel), 0, 0.02, 0.005);
  grille.rotation.set(Math.PI / 2, 0, Math.PI * 0.05);
  headG.add(head, shell, peak, grille);

  // Arms: shoulder -> elbow -> glove, posed each frame to hold the bat (see poseArm).
  const arms = [];
  const elbows = [];
  for (const x of [-0.2, 0.2]) {
    const shoulder = at(new THREE.Group(), x, 0.53, 0);
    const upperArm = cast(at(new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.2, 2, 8), shirt), 0, -0.15, 0));
    const elbow = at(new THREE.Group(), 0, -0.3, 0);
    const fore = at(new THREE.Mesh(new THREE.CapsuleGeometry(0.044, 0.18, 2, 8), shirt), 0, -0.12, 0);
    const glove = at(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.075), gloveM), 0, -0.31, 0);
    elbow.add(fore, glove);
    shoulder.add(upperArm, elbow);
    upper.add(shoulder);
    arms.push(shoulder);
    elbows.push(elbow);
  }
  return { g, legs, knees, ankles, arms, elbows, upper, headG, torso, last: new THREE.Vector3(), phase: 0 };
}
const batter = makeBatter();
batter.g.position.set(-0.6, 0, -0.35);
batter.g.rotation.y = Math.PI / 2;
batter.armsBusy = true;
batter.noAnim = true;
world.add(batter.g);

// The bat hangs from the hands; its orientation follows the phone.
const batPivot = new THREE.Group();
batPivot.position.set(-0.22, 0.95, -0.45);
world.add(batPivot);
const bat = new THREE.Group();
{
  const willow = new THREE.MeshStandardMaterial({ color: 0xe8cf9c, roughness: 0.5 });
  // Blade: flat face toward -z (the hitting side) and a raised spine on the back.
  const sec = new THREE.Shape();
  sec.moveTo(-0.054, 0.02);
  sec.lineTo(0.054, 0.02);
  sec.lineTo(0.052, -0.012);
  sec.quadraticCurveTo(0, -0.05, -0.052, -0.012);
  sec.lineTo(-0.054, 0.02);
  const bladeGeo = new THREE.ExtrudeGeometry(sec, { depth: 0.56, bevelEnabled: false, curveSegments: 4 });
  bladeGeo.rotateX(-Math.PI / 2); // extrusion runs up the bat; the face ends up on -z
  bladeGeo.translate(0, -0.63, 0);
  const blade = new THREE.Mesh(bladeGeo, willow);
  blade.castShadow = true;
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0x0f7c78, roughness: 0.9 }));
  handle.position.y = 0.08;
  const sticker = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.22), new THREE.MeshBasicMaterial({ color: 0x10331f }));
  sticker.position.set(0, -0.2, -0.0205);
  sticker.rotation.y = Math.PI;
  bat.add(blade, handle, sticker);
}
batPivot.add(bat);
const BAT_TIP = new THREE.Vector3(0, -0.62, 0);

const bowler = person(FIELD_KIT.kit, { trim: FIELD_KIT.trim, cap: false });
bowler.armsBusy = true;
world.add(bowler.g);
const keeper = person(FIELD_KIT.kit, { trim: FIELD_KIT.trim, pads: true, helmet: 0x1b2f5e, gloves: 0xffcc33, sleeves: true });

// Umpires in white coats and wide hats.
for (const [x, z, ry] of [[0.9, BOWL_Z - 1.6, 0], [-24, 1, Math.PI / 2]]) {
  const u = person(0xf4f4f0, { pants: 0x22252a, trim: 0x22252a, cap: false, hat: 0xf4f4f0, sleeves: true });
  u.g.position.set(x, 0, z);
  u.g.rotation.y = ry;
  u.arms.forEach((a) => a.rotation.set(0, 0, 0));
  world.add(u.g);
}

// Fielders (bowler joins in after delivering). Positions for a right-handed batter.
const FIELD = [
  ['keeper', 0.2, 3.4], ['point', 17, -2], ['cover', 18, -15], ['mid-on', -8, -28], ['midwicket', -18, -15],
  ['deep midwicket', -38, -38], ['deep cover', 38, -38], ['fine leg', -26, 24], ['long-off', 18, -60], ['long-on', -18, -60],
];
const fielders = FIELD.map(([name, x, z]) => {
  const p = name === 'keeper' ? keeper : person(FIELD_KIT.kit, { trim: FIELD_KIT.trim, cap: 0x1b2f5e });
  p.g.position.set(x, 0, z);
  p.g.lookAt(0, 0, -2);
  p.last.copy(p.g.position);
  world.add(p.g);
  return { name, p, home: new THREE.Vector3(x, 0, z), dropped: false };
});
const bowlerFielder = { name: 'bowler', p: bowler, home: new THREE.Vector3(-1.2, 0, -14), dropped: false };

const ballTex = canvasTex(128, 64, (g, w, h) => {
  g.fillStyle = '#a3121a'; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(0, 0, w, h / 2);
  // The seam: a raised band of stitching around the middle.
  g.fillStyle = '#c9a77a'; g.fillRect(0, h / 2 - 2, w, 4);
  g.fillStyle = '#f4ead8';
  for (let x = 0; x < w; x += 4) { g.fillRect(x, h / 2 - 5, 2, 2); g.fillRect(x + 2, h / 2 + 3, 2, 2); }
});
const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 18, 14), new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.3 }));
ball.castShadow = true;
world.add(ball);

// ---- Batter body. The bat follows the phone; the body follows the bat, like a broadcast cricket game:
// a crouched side-on stance as the bowler runs in, a front-foot stride when the bat is picked up, shoulders
// that coil on the backlift and open on the follow-through, hands on the handle and eyes on the ball.
const BATTER_BASE = { x: -0.6, z: -0.35 };
const PIVOT_BASE = new THREE.Vector3(-0.22, 0.95, -0.45);
const bp = { crouch: 0, fw: 0, foot: 1, strideLatch: 0, rest: 0, side: 0, lift: 0, yaw: 0, lean: 0, hy: 1.2, hp: 0, t: 0 };
const STROKE_T = { build: 0.75, exec: 0.14, follow: 0.45 };
const _bv = new THREE.Vector3();
const _bd = new THREE.Vector3();
const ARM_DOWN = new THREE.Vector3(0, -1, 0);
const ARM_L1 = 0.3; // shoulder to elbow
const ARM_L2 = 0.31; // elbow to the middle of the glove
const ARM_POLE_FRONT = new THREE.Vector3(1, -0.35, -0.2);
const ARM_POLE_BACK = new THREE.Vector3(-0.35, -1, -0.15);
const _armDir = new THREE.Vector3();
const _armBend = new THREE.Vector3();
const _armUp = new THREE.Vector3();
const _armQ = new THREE.Quaternion();
function poseArm(i, along, pole) {
  const shoulder = batter.arms[i];
  const elbow = batter.elbows[i];
  bat.localToWorld(_bv.set(0, along, 0));
  batter.upper.worldToLocal(_bv).sub(shoulder.position); // shoulder -> hand, in the upper body's frame
  const d = THREE.MathUtils.clamp(_bv.length(), 0.08, ARM_L1 + ARM_L2 - 1e-3);
  _armDir.copy(_bv).normalize();
  // Bend toward the pole, perpendicular to the reach.
  _armBend.copy(pole).addScaledVector(_armDir, -pole.dot(_armDir)).normalize();
  const a = Math.acos(THREE.MathUtils.clamp((ARM_L1 * ARM_L1 + d * d - ARM_L2 * ARM_L2) / (2 * ARM_L1 * d), -1, 1));
  _armUp.copy(_armDir).multiplyScalar(Math.cos(a)).addScaledVector(_armBend, Math.sin(a)); // upper-arm direction
  shoulder.quaternion.setFromUnitVectors(ARM_DOWN, _armUp);
  // Forearm: from the elbow to the hand, expressed in the shoulder's own frame.
  _bv.setLength(d).addScaledVector(_armUp, -ARM_L1).normalize();
  _armQ.copy(shoulder.quaternion).invert();
  elbow.quaternion.setFromUnitVectors(ARM_DOWN, _bv.applyQuaternion(_armQ));
}
const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const legDrop = (hip, knee) => (0.44 * Math.cos(hip.rotation.x) + 0.45 * Math.cos(hip.rotation.x + knee.rotation.x)) * Math.cos(hip.rotation.z);
function animateBatter(dt) {
  if (dt <= 0) return;
  bp.t += dt;
  const d = _bd.set(0, -1, 0).applyQuaternion(bat.quaternion); // along the bat, handle to toe
  const swing = Math.atan2(-d.z, -d.y); // 0 grounded, negative on the backlift, positive on the follow-through
  const inPlay = S.screen === 'play';
  const set = S.screen === 'practice' || (inPlay && (S.phase === 'runup' || S.phase === 'delivery')) ? 1
    : inPlay && S.phase === 'hit' && S.phaseT < 1.2 ? 0.8 : inPlay ? 0.2 : 0.45;
  bp.crouch = ease(bp.crouch, set, 3.5, dt);

  // Footwork. In a match it follows the delivery on real stroke timing (median phase lengths from ~8,200
  // annotated strokes in the UJ-AQA CricketVision dataset): the build-up of trigger, backlift and step takes
  // about 0.75 s and is planted as the ~0.14 s downswing starts; the follow-through is held ~0.45 s.
  // Full balls bring the front foot forward; short ones (pitching more than ~6 m away) send the batter back
  // and across, standing taller. In practice there is no ball, so lifting the bat triggers a front-foot step.
  let fwT = null;
  let stepK = -1;
  if (inPlay && S.del?.arrival && (S.phase === 'runup' || S.phase === 'delivery')) {
    const t = S.phase === 'runup' ? S.phaseT - 1.7 : S.phaseT; // seconds since release (negative in the run-up)
    const plant = S.del.arrival - STROKE_T.exec;
    const start = Math.min(plant - 0.3, S.del.arrival - STROKE_T.build);
    if (t < start) bp.foot = S.del.bounceAt.z < -6.2 ? -1 : 1;
    stepK = THREE.MathUtils.clamp((t - start) / (plant - start), 0, 1);
    fwT = stepK * stepK * (3 - 2 * stepK);
  } else if (inPlay && (S.phase === 'hit' || S.phase === 'result')) {
    fwT = S.phaseT < STROKE_T.follow + 0.5 ? bp.fw : 0; // hold the shot, then relax
  } else if (inPlay) {
    fwT = 0;
  }
  if (fwT !== null && stepK >= 0) {
    bp.fw = fwT;
    bp.lift = ease(bp.lift, stepK > 0 && stepK < 1 ? Math.sin(Math.PI * stepK) : 0, 18, dt);
  } else {
    if (fwT === null) {
      bp.foot = 1;
      if (swing < -0.55 && bp.crouch > 0.6) bp.strideLatch = 1;
      bp.rest = Math.abs(swing) < 0.35 ? bp.rest + dt : 0;
      if (bp.rest > 0.9) bp.strideLatch = 0;
      fwT = bp.strideLatch;
    }
    const before = bp.fw;
    bp.fw = ease(bp.fw, fwT, fwT > bp.fw ? 6 : 2.5, dt);
    bp.lift = ease(bp.lift, fwT > 0.5 && (bp.fw - before) / dt > 0.35 ? 1 : 0, 16, dt);
  }
  // Which way the shot went: the front foot goes across for the off side and opens up for the leg side.
  if (swing > 0.5) bp.side = ease(bp.side, THREE.MathUtils.clamp(d.x * 1.8, -1, 1), 8, dt);
  else if (bp.fw < 0.05) bp.side = ease(bp.side, 0, 3, dt);

  const c = bp.crouch;
  const st = bp.foot > 0 ? bp.fw : 0; // front-foot stride
  const bk = bp.foot < 0 ? bp.fw : 0; // back and across
  const liftF = bp.foot > 0 ? bp.lift : 0;
  const liftB = bp.foot < 0 ? bp.lift : 0;
  const bend = (0.1 + 0.32 * c) * (1 - 0.45 * bk);
  const [backLeg, frontLeg] = batter.legs;
  const [backKnee, frontKnee] = batter.knees;
  const [backAnkle, frontAnkle] = batter.ankles;
  // On the back foot the weight is on the back leg; the front knee softens so both feet stay on the ground.
  backLeg.rotation.set(-bend * 0.8 - 0.1 * bk - 0.45 * liftB, 0, -0.08 - 0.14 * st - 0.22 * bk);
  backKnee.rotation.x = bend * 1.6 - 0.55 * st - 0.2 * bk + 0.85 * liftB; // the back leg straightens as the weight goes forward
  frontLeg.rotation.set(-(bend + 0.3 * st + 0.1 * bk + 0.45 * liftF) - 0.35 * Math.max(0, bp.side) * st + 0.2 * Math.max(0, -bp.side) * st, 0, 0.1 + 0.34 * st - 0.04 * bk);
  frontKnee.rotation.x = bend * 1.6 + 0.45 * st + 0.35 * bk + 0.85 * liftF;
  // Both feet planted: the body sits on the more bent leg, and the straighter leg reaches further out
  // (sideways from the hips) until its foot meets the ground too, like the trailing leg of a drive.
  // Blended out while a foot is in the air mid-step, so the step lands smoothly.
  const planted = 1 - THREE.MathUtils.clamp(Math.max(liftF, liftB) * 4, 0, 1);
  if (planted > 0) {
    const eB = legDrop(backLeg, backKnee);
    const eF = legDrop(frontLeg, frontKnee);
    const [hip, knee, target] = eB > eF ? [backLeg, backKnee, eF] : [frontLeg, frontKnee, eB];
    const flat = 0.44 * Math.cos(hip.rotation.x) + 0.45 * Math.cos(hip.rotation.x + knee.rotation.x);
    const z = Math.sign(hip.rotation.z || 1) * Math.acos(Math.min(1, target / flat));
    hip.rotation.z += (z - hip.rotation.z) * planted;
  }
  backAnkle.rotation.x = -(backLeg.rotation.x + backKnee.rotation.x);
  frontAnkle.rotation.x = -(frontLeg.rotation.x + frontKnee.rotation.x);
  // Stand on whichever foot is lower; a lifted foot leaves the ground.
  const drop = Math.max(legDrop(backLeg, backKnee), legDrop(frontLeg, frontKnee));
  batter.g.position.set(BATTER_BASE.x + 0.1 * bk, drop - 0.89, BATTER_BASE.z - 0.3 * st + 0.14 * bk);

  const follow = Math.max(0, swing);
  const back = Math.max(0, -swing);
  const leanT = 0.34 * c + 0.12 * st - 0.15 * bk - 0.3 * Math.max(0, swing - 1.3) + Math.sin(bp.t * 1.6) * 0.012 * (1 - bp.fw);
  // Back-foot leg-side shots (pull, hook) pivot hard on the back foot.
  const yawT = -0.3 * Math.min(back, 1.5) + 0.5 * Math.min(follow, 1.6) - 0.3 * bp.side * Math.min(follow, 1)
    + 0.4 * bk * Math.max(0, -bp.side) * Math.min(follow, 1);
  bp.lean = ease(bp.lean, leanT, 12, dt);
  bp.yaw = ease(bp.yaw, yawT, 12, dt);
  batter.upper.rotation.set(bp.lean, bp.yaw, -0.06 * c - 0.12 * st + 0.1 * bk, 'YXZ');

  // Hands ride up with the backlift and through with the follow-through, and travel with the feet.
  batPivot.position.set(
    PIVOT_BASE.x + d.x * 0.12 + 0.04 * c + 0.08 * bk,
    PIVOT_BASE.y + (1 + d.y) * 0.22 - 0.06 * c + 0.04 * bk,
    PIVOT_BASE.z + d.z * 0.16 - 0.26 * st + 0.12 * bk,
  );
  batter.g.updateMatrixWorld(true);
  batPivot.updateMatrixWorld(true);

  // Arms reach for the handle: top hand on the front arm (elbow up toward the bowler), bottom hand on the back
  // arm (elbow tucked down), solved as two-bone chains.
  poseArm(1, 0.17, ARM_POLE_FRONT);
  poseArm(0, 0.04, ARM_POLE_BACK);

  // Eyes on the ball once it is bowled, otherwise on the bowler.
  if (ball.visible) ball.getWorldPosition(_bv);
  else bowler.g.getWorldPosition(_bv).y += 1.6;
  batter.upper.worldToLocal(_bv).sub(batter.headG.position);
  const hy = THREE.MathUtils.clamp(Math.atan2(_bv.x, _bv.z), -0.9, 1.75);
  const hp = THREE.MathUtils.clamp(Math.atan2(-_bv.y, Math.hypot(_bv.x, _bv.z)), -0.5, 0.7);
  bp.hy = ease(bp.hy, hy, 14, dt);
  bp.hp = ease(bp.hp, hp, 14, dt);
  batter.headG.rotation.set(bp.hp, bp.hy, 0, 'YXZ');
}
const shadowDot = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }));
shadowDot.rotation.x = -Math.PI / 2;
world.add(shadowDot);
// Motion blur behind the ball: a soft streak that faces the camera and tapers off.
const TRAIL_N = 10;
const trailPts = [];
const trailArr = new Float32Array(TRAIL_N * 2 * 3);
const trailCol = new Float32Array(TRAIL_N * 2 * 4);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailArr, 3));
trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 4));
{
  const idx = [];
  for (let i = 0; i < TRAIL_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  trailGeo.setIndex(idx);
  for (let i = 0; i < TRAIL_N; i++) {
    const f = 1 - i / (TRAIL_N - 1);
    for (const j of [0, 1]) trailCol.set([1, 0.93 - 0.25 * f, 0.9 - 0.4 * f, 0.5 * f * f], (i * 2 + j) * 4);
  }
}
const trailLine = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
trailLine.frustumCulled = false;
world.add(trailLine);
const _camLocal = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _off = new THREE.Vector3();
const pitchMarker = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.16, 24), new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0 }));
pitchMarker.rotation.x = -Math.PI / 2;
world.add(pitchMarker);

// ---------------------------------------------------------------- Deliveries

const rand = (a, b) => a + Math.random() * (b - a);
function makeDelivery(diffKey, ballNo) {
  const d = DIFFS[diffKey];
  const spin = Math.floor(ballNo / 6) % 2 === 1; // alternate pace and spin overs
  const kmh = spin ? rand(...d.spin) : rand(...d.pace);
  const speed = kmh / 3.6;
  const r = Math.random();
  let length;
  if (!spin && r < d.short) length = rand(-10, -8); // bouncer
  else if (r < d.short + 0.12) length = rand(-1.6, -0.9); // yorker
  else if (r < 0.6) length = rand(-4.5, -2.5); // full
  else length = rand(-7, -4.5); // good length
  const lineX = THREE.MathUtils.clamp(0.05 + (Math.random() + Math.random() - 1) * 0.35, -0.45, 0.6);
  const release = new THREE.Vector3(spin ? -0.5 : -0.75, spin ? 1.95 : 2.15, BOWL_Z + 1.2);
  const bounceAt = new THREE.Vector3(lineX, BALL_R, length);
  const T = Math.hypot(bounceAt.x - release.x, bounceAt.z - release.z) / speed;
  const vel = new THREE.Vector3((bounceAt.x - release.x) / T, (BALL_R - release.y + 0.5 * G * T * T) / T, (bounceAt.z - release.z) / T);
  const deviation = spin ? (Math.random() < 0.5 ? -1 : 1) * rand(0.5, 1) * d.turn : (Math.random() - 0.5) * 2 * d.seam;

  // Simulate the whole flight once; the game then plays it back.
  const path = [];
  const p = release.clone();
  const v = vel.clone();
  const h = 1 / 240;
  let t = 0;
  let bounced = false;
  let arrival = null;
  let contactPos = null;
  let hitsStumps = false;
  while (t < 3 && p.z < 3) {
    path.push(p.clone());
    v.y -= G * h;
    const prevZ = p.z;
    p.addScaledVector(v, h);
    if (!bounced && p.y <= BALL_R) {
      bounced = true;
      p.y = BALL_R;
      v.y = -v.y * (spin ? 0.5 : 0.62);
      v.x = v.x * 0.9 + deviation;
      v.z *= 0.9;
    }
    t += h;
    if (arrival === null && prevZ < CONTACT_Z && p.z >= CONTACT_Z) { arrival = t; contactPos = p.clone(); }
    if (prevZ < STUMP_Z && p.z >= STUMP_Z) hitsStumps = Math.abs(p.x) < 0.13 + BALL_R && p.y < 0.72 + BALL_R && p.y > 0;
  }
  return { path, h, arrival, contactPos, hitsStumps, kmh, spin, bounceAt, velAtContact: v.clone() };
}

// ---------------------------------------------------------------- Match state

const pad = new Mocon();
const S = {
  mode: store.get('mode', 'chase'), diff: store.get('diff', 'county'), hand: store.get('hand', 'right'), grip: store.get('grip', 'tv'), mirror: store.get('mirror', false),
  screen: 'menu', // menu | calibrate (taking guard) | practice | play | paused | end
  phase: 'idle', phaseT: 0, // idle | runup | delivery | hit | result
  clock: 0,
  input: null,
  runs: 0, wickets: 0, balls: 0, fours: 0, sixes: 0, over: [],
  del: null, releaseAt: 0,
  hit: null, // { vel, pos, bounced, start, catcher... }
  shots: [], // where each scoring shot this innings ended up, for the field map
  shot: null, missed: false,
};

// Batters and bowlers are made-up names for the broadcast graphics.
const BATTERS = ['R. Mehra', 'T. Walsh', 'K. Dias', 'M. Osei', 'L. Grant', 'J. Cole', 'A. Bose'];
const BOWLERS = { pace: 'D. Rourke', spin: 'S. Iqbal' };
const oversOf = (b) => `${Math.floor(b / 6)}.${b % 6}`;
function newStats() {
  S.bat = [{ name: BATTERS[0], r: 0, b: 0, f4: 0, f6: 0, how: 'not out' }];
  S.bowl = { pace: { name: BOWLERS.pace, b: 0, r: 0, w: 0 }, spin: { name: BOWLERS.spin, b: 0, r: 0, w: 0 } };
  S.newBatter = false;
}
const curBat = () => S.bat[S.bat.length - 1];
// Pace and spin alternate by over (matches makeDelivery).
const curBowlKey = () => (S.del ? (S.del.spin ? 'spin' : 'pace') : Math.floor(S.balls / 6) % 2 === 1 ? 'spin' : 'pace');

function inningsLabel() {
  if (!S.bat) newStats();
  const m = MODES[S.mode];
  const bt = curBat();
  const key = curBowlKey();
  const bw = S.bowl[key];
  $('sbScore').textContent = `${S.runs}/${S.wickets}`;
  $('sbOvers').textContent = `${oversOf(S.balls)} ov`;
  $('sbBatName').textContent = `${bt.name} *`;
  $('sbBatFig').innerHTML = `${bt.r} <em>(${bt.b})</em>`;
  $('sbBowlName').textContent = `${bw.name} · ${key}`;
  $('sbBowlFig').innerHTML = `${bw.w}-${bw.r} <em>(${oversOf(bw.b)})</em>`;
  let screenNeed;
  if (m.target) {
    const t = m.target[S.diff];
    const n = t - S.runs;
    const left = m.balls - S.balls;
    $('sbInfo').innerHTML = n > 0
      ? `<div>Need <span>${n}</span> off <span>${left}</span></div><small>Target ${t} · Req. rate ${left ? ((n / left) * 6).toFixed(1) : '–'}</small>`
      : '<div><span>Target reached</span></div>';
    screenNeed = n > 0 ? `NEED ${n} OFF ${left}` : 'TARGET REACHED';
  } else {
    const rr = S.balls ? ((S.runs / S.balls) * 6).toFixed(2) : '0.00';
    $('sbInfo').innerHTML = `<div>Nets</div><small>Run rate ${rr} · ${S.fours}×4 · ${S.sixes}×6</small>`;
    screenNeed = `RUN RATE ${rr}`;
  }
  $('thisOver').innerHTML = S.over.slice(-6).map((o) =>
    `<b class="${o === 'W' ? 'out' : o === 4 ? 'four' : o === 6 ? 'six' : o === 'wd' ? 'wd' : ''}">${o === 0 ? '•' : o}</b>`).join('');
  $('mtMode').textContent = m.label.toUpperCase();
  $('mtLevel').textContent = DIFFS[S.diff].label.toUpperCase();
  bigScreen.draw({ tag: m.label.toUpperCase(), score: `${S.runs}/${S.wickets}`, overs: `${oversOf(S.balls)} OVERS · ${bt.name.toUpperCase()} ${bt.r} (${bt.b})`, need: screenNeed });
}

function startInnings() {
  sfx.ensure();
  Object.assign(S, { runs: 0, wickets: 0, balls: 0, fours: 0, sixes: 0, over: [], shots: [], screen: 'play' });
  newStats();
  inningsLabel();
  ['menu', 'end', 'pause'].forEach((id) => $(id).classList.remove('show'));
  nextBall(0.8);
  const m = MODES[S.mode];
  hint(m.target ? `Chase ${m.target[S.diff]} from ${m.balls} balls.` : 'Nets: no pressure. Work on your timing.', 4);
}

function nextBall(delay = 1.2) {
  if (S.newBatter) {
    S.bat.push({ name: BATTERS[S.bat.length % BATTERS.length], r: 0, b: 0, f4: 0, f6: 0, how: 'not out' });
    S.newBatter = false;
  }
  S.phase = 'idle';
  S.phaseT = -delay;
  S.hit = null;
  S.shot = null;
  S.refine = null;
  S.missed = false;
  swingBuf.length = 0; // each delivery's swing is measured on its own samples
  Object.assign(sw, { active: false, prev: null, speed: 0, peak: 0 });
  S.del = null;
  resetStumps();
  ball.visible = false;
  shadowDot.visible = false;
  pitchMarker.material.opacity = 0;
  for (const f of [...fielders, bowlerFielder]) { f.dropped = false; }
  bowler.g.position.set(-1.0, 0, -34);
  bowler.g.rotation.set(0, 0, 0);
  bowler.arms.forEach((a) => a.rotation.set(0, 0, 0));
  $('speed').innerHTML = '';
  if (S.bat) inningsLabel();
}

function endBall(outcome) {
  // outcome: { runs, out, text, sub }
  S.phase = 'result';
  S.phaseT = 0;
  if (!S.bat) newStats();
  const bw = S.bowl[curBowlKey()];
  const bt = curBat();
  if (outcome.wide) {
    bw.r += 1;
    S.runs += 1;
    S.over.push('wd');
    banner('Wide', '+1 run, and the ball is bowled again');
    inningsLabel();
    return;
  }
  S.balls++;
  bw.b++;
  bt.b++;
  if (S.hit && !S.hit.keeperCatch) S.shots.push({ x: S.hit.pos.x, z: S.hit.pos.z, runs: outcome.runs || 0, out: !!outcome.out });
  if (outcome.out) {
    S.wickets++;
    S.over.push('W');
    bw.w++;
    bt.how = (outcome.sub || 'out').replace(/^Caught at /, 'c ').replace(/^Caught behind$/, 'c keeper').replace(/^Through the gate$|^Swung and missed$/, 'bowled');
    S.newBatter = true;
  } else {
    bt.r += outcome.runs;
    bw.r += outcome.runs;
    if (outcome.runs === 4) bt.f4++;
    if (outcome.runs === 6) bt.f6++;
    S.runs += outcome.runs;
    S.over.push(outcome.runs);
    if (outcome.runs === 4) S.fours++;
    if (outcome.runs === 6) S.sixes++;
  }
  banner(outcome.text, outcome.sub);
  inningsLabel();
}

function checkEnd() {
  const m = MODES[S.mode];
  if (!m.target) return false;
  const target = m.target[S.diff];
  let result = null;
  if (S.runs >= target) result = 'won';
  else if (S.wickets >= m.wickets || S.balls >= m.balls) result = 'lost';
  if (!result) return false;
  S.screen = 'end';
  const key = `wins.${S.mode}.${S.diff}`;
  if (result === 'won') store.set(key, store.get(key, 0) + 1);
  $('endTitle').textContent = result === 'won' ? 'You won!' : 'Fell short';
  $('endText').textContent = result === 'won'
    ? `Chased ${target} with ${m.balls - S.balls} ball${m.balls - S.balls === 1 ? '' : 's'} and ${m.wickets - S.wickets} wicket${m.wickets - S.wickets === 1 ? '' : 's'} to spare.`
    : `${target - S.runs} short of ${target}${S.wickets >= m.wickets ? ', all out' : ''}.`;
  $('stRuns').textContent = S.runs;
  $('stBalls').textContent = S.balls;
  $('stFours').textContent = S.fours;
  $('stSixes').textContent = S.sixes;
  $('endBest').textContent = `Wins at ${MODES[S.mode].label}, ${DIFFS[S.diff].label}: ${store.get(key, 0)}`;
  $('resultBox').className = `result ${result}`;
  $('cardBat').innerHTML = S.bat.map((b) => `<tr><td>${b.name}<small>${b.how}</small></td><td><b>${b.r}</b></td><td>${b.b}</td><td>${b.f4}</td><td>${b.f6}</td><td>${b.b ? ((b.r / b.b) * 100).toFixed(0) : '–'}</td></tr>`).join('');
  $('cardBowl').innerHTML = Object.values(S.bowl).filter((x) => x.b || x.r).map((x) => `<tr><td>${x.name}</td><td>${oversOf(x.b)}</td><td>${x.r}</td><td><b>${x.w}</b></td><td>${x.b ? ((x.r / x.b) * 6).toFixed(1) : '–'}</td></tr>`).join('');
  if (result === 'won') sfx.crowd(1.2);
  setTimeout(() => $('end').classList.add('show'), 1200);
  return true;
}

// ---------------------------------------------------------------- Batting

// Swing detection on the bat's tip direction, for phone and mouse alike.
// A swing is the bat turning faster than 8 rad/s: gentle drives are ~9+ rad/s, while shuffling in a
// stance or leaving the ball stays under ~6 rad/s (checked against recorded swings).
const SWING = { phone: { start: 8, end: 3 }, mouse: { start: 4, end: 2 } };
const lefty = () => S.hand === 'left';
const sw = { prev: null, prevPrev: null, speed: 0, active: false, peak: 0, peakT: 0, peakVec: null, startT: 0 };
const tipNow = new THREE.Vector3();
function feedSwing(dir, t) {
  const cfg = SWING[S.input] || SWING.mouse;
  const prev = sw.prev;
  sw.prev = { dir: dir.clone(), t };
  if (!prev) return;
  const dt = t - prev.t;
  if (dt <= 0.001 || dt > 0.2) return;
  const raw = prev.dir.angleTo(dir) / dt;
  sw.speed = sw.speed * 0.3 + raw * 0.7;
  const vel = dir.clone().sub(prev.dir);
  // Any swing counts except the backlift (bat tip moving back and up, toward the camera).
  const backlift = vel.z > 0 && vel.y > 0 && Math.abs(vel.x) < vel.z;
  if (!sw.active && sw.speed > cfg.start && !backlift) {
    sw.active = true;
    sw.peak = 0;
    sw.startT = t;
    sw.lowY = Infinity;
  }
  if (!sw.active) return;
  if (sw.speed > sw.peak) {
    sw.peak = sw.speed;
    sw.peakT = t;
    sw.peakVec = vel.clone().normalize();
  }
  // Contact happens where the bat reaches the bottom of its arc (tip lowest), which in recorded
  // swings comes ~50-150 ms after the bat tip's fastest moment.
  if (dir.y < sw.lowY) {
    sw.lowY = dir.y;
    sw.lowT = t;
    sw.lowVec = vel.clone().normalize();
  }
  const pastBottom = sw.lowY < -0.5 && dir.y > sw.lowY + 0.08;
  if (pastBottom || sw.speed < cfg.end || t - sw.startT > 0.4) {
    sw.active = false;
    swingFlash = 1;
    const atBottom = sw.lowY < -0.5;
    playShot(atBottom ? sw.lowT : sw.peakT, atBottom ? sw.lowVec : sw.peakVec, sw.peak, null);
  }
}

function playShot(t, vec, angSpeed, keyLoft) {
  if (S.screen !== 'play' || S.phase !== 'delivery' || S.shot || S.hit) return;
  const del = S.del;
  const err = t - (S.releaseAt + del.arrival); // + = late
  const [PERFECT, GOOD, EDGE] = DIFFS[S.diff].win;
  const ms = `${Math.round(Math.abs(err) * 1000)} ms ${err < 0 ? 'early' : 'late'}`;
  if (err < -EDGE) {
    // Too early: tell the player, but don't use up their swing; they can still swing again.
    if (err > -0.6) timing(`Early by ${Math.round(-err * 1000)} ms, wait for it`, '#ff8a80', err);
    return;
  }
  if (S.input === 'phone') calibrate(err);
  if (err > EDGE) {
    S.missed = true;
    S.shot = { err, quality: 0 }; // the ball has gone past
    timing(`Too late (${ms})`, '#ff8a80', err);
    return;
  }
  const cp = del.contactPos;
  if (cp.x < -1.2 || cp.x > 1.4 || cp.y > 2.1) { S.missed = true; S.shot = { err, quality: 0 }; timing('Out of reach', '#ff8a80', err); return; }

  const quality = Math.abs(err) <= PERFECT ? 1 : Math.abs(err) <= GOOD ? 0.78 : 0.4;
  const incoming = del.velAtContact.length();
  S.shot = { err, quality };

  if (S.input === 'phone') {
    // Real batting: the ball leaves roughly along the bat face, pulled toward the swing path.
    // The phone held like a handle is the bat; its back is the face.
    const c = contactPhysics(t);
    let az = c ? (cal ? aimFromPractice(c.heading) : c.heading) : 0;
    // Lofted: face opened upward at contact, or a big swing. The follow-through confirms it (finishRefine).
    const lofted = c ? c.faceEl > LOFT.faceEl || angSpeed > LOFT.bigSwing : false;
    const power = THREE.MathUtils.clamp((angSpeed - 6) / 18, 0.35, 1);
    if (lefty() && !cal) az = -az; // without practice, mirror for left-handers (practice already says which side is leg)
    resolveShot({ cp, err, quality, power, lofted, incoming, ms }, az + err * 3);
    if (S.hit && !S.hit.keeperCatch && !S.hit.edge) S.refine = { peakT: t, peakSpeed: angSpeed };
    return;
  }
  // Mouse / keys: direction from the flick, loft from Shift or an upward flick.
  const power = THREE.MathUtils.clamp(((angSpeed * 1.2) - 4) / 14, 0.35, 1);
  const lofted = keyLoft ?? vec.y > 0.3;
  let az = Math.atan2(vec.x, -Math.min(vec.z, -0.15));
  if (lefty()) az = -az;
  resolveShot({ cp, err, quality, power, lofted, incoming, ms }, az + err * 6); // early -> leg side, late -> off side
}

// Loft rules (physical, not per player): face tilted up by more than 12 degrees at contact, or a swing
// faster than 18 rad/s, means a lofted shot; finishing with the bat above about horizontal confirms it.
const LOFT = { faceEl: 12, bigSwing: 18, finishY: 0.2 };

// Once the swing has finished, a clearly high or low follow-through confirms or corrects the loft.
function finishRefine() {
  const R = S.refine;
  S.refine = null;
  const H = S.hit;
  if (!R || !H || !swingBuf.length || H.bounced || S.clock - H.start > 0.45) return;
  const finishY = swingBuf[swingBuf.length - 1].tip.y;
  if (!H.lofted && finishY > LOFT.finishY + 0.1) setLoft(H, true);
  else if (H.lofted && finishY < LOFT.finishY - 0.1) setLoft(H, false);
}

// Switch a ball just struck between a lofted and a ground shot, keeping its speed and heading.
function setLoft(H, lofted) {
  const speed = H.vel.length();
  const flat = Math.hypot(H.vel.x, H.vel.z) || 1;
  const elev = lofted ? 0.52 : -0.04;
  const k = (speed * Math.cos(elev)) / flat;
  H.vel.x *= k;
  H.vel.z *= k;
  H.vel.y = speed * Math.sin(elev);
  H.lofted = lofted;
  H.landing = lofted ? predictLanding(H.pos, H.vel) : null;
}

function resolveShot(shot, az) {
  const { cp, err, quality, power, lofted, incoming, ms } = shot;
  az = THREE.MathUtils.clamp(az, -2.5, 2.5);

  if (quality < 0.5) {
    // Edge: fine, slow, and sometimes straight to the keeper.
    sfx.edge();
    buzz(30, 160);
    timing(`${err < 0 ? 'Inside edge' : 'Outside edge'} (${ms})`, '#ffcc80', err);
    if (Math.random() < 0.2) {
      S.hit = { pos: cp.clone(), vel: new THREE.Vector3(0.3, 0.5, 14), bounced: false, start: S.clock, keeperCatch: true };
      S.phase = 'hit';
      S.phaseT = 0;
      return;
    }
    az = (err < 0 ? -1 : 1) * rand(2.3, 2.8);
    launch(cp, az, rand(0.05, 0.2), rand(10, 18), false);
    S.hit.edge = true;
    return;
  }
  timing(quality === 1 ? `Perfect timing (${ms})` : `${err < 0 ? 'A little early' : 'A little late'} (${ms})`, quality === 1 ? '#b9f6ca' : '#fff59d', err);
  // A perfectly timed, full-power loft carries ~75-85 m (the rope is 57-68 m away); anything less can be caught.
  const speed = Math.min(37, 12 + 20 * power * quality + 0.12 * incoming);
  const elev = lofted ? rand(0.42, 0.62) : rand(-0.06, 0.03); // flat shots are hit into the ground
  launch(cp, az, elev, speed, lofted);
  sfx.crack(power * quality);
  buzz(Math.round(40 + 50 * power), 255);
}

function launch(pos, az, elev, speed, lofted) {
  const vel = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev)).multiplyScalar(speed);
  S.hit = { pos: pos.clone(), origin: pos.clone(), vel, bounced: false, start: S.clock, lofted, az, landing: lofted ? predictLanding(pos, vel) : null };
  S.phase = 'hit';
  S.phaseT = 0;
  if (!lofted) S.hit.pos.y = Math.max(S.hit.pos.y, 0.3);
}

// Where a lofted ball comes down to catching height, so fielders can run there.
function predictLanding(pos, vel) {
  const p = pos.clone();
  const v = vel.clone();
  const h = 1 / 120;
  for (let i = 0; i < 1200; i++) {
    v.y -= G * h;
    v.multiplyScalar(1 - 0.16 * h);
    p.addScaledVector(v, h);
    if (v.y < 0 && p.y < 1.2) break;
  }
  return new THREE.Vector3(p.x, 0, p.z);
}

// Too far from the batter to reach: called wide.
const isWide = (del) => del.contactPos.x > 1.3 || del.contactPos.x < -1.1;

const REGIONS = [
  [-2.5, -1.9, 'fine leg'], [-1.9, -1.2, 'square leg'], [-1.2, -0.45, 'midwicket'], [-0.45, 0.25, 'straight down the ground'],
  [0.25, 0.9, 'through the covers'], [0.9, 1.6, 'past point'], [1.6, 2.5, 'down to third man'],
];
const regionOf = (az) => (REGIONS.find(([a, b]) => az >= a && az < b) || REGIONS[3])[2];

// Turn a horizontal vector (x, z) by s radians in the game's azimuth sense (+ = toward the off side).
function turnXZ(v, s) {
  const f = -v.z;
  const x = v.x * Math.cos(s) + f * Math.sin(s);
  const nf = -v.x * Math.sin(s) + f * Math.cos(s);
  v.x = x;
  v.z = -nf;
}

function updateHit(dt) {
  const H = S.hit;
  if (H.azTarget !== undefined) {
    // Rotate the whole path about the point of contact, quickly but not instantly.
    const d = H.azTarget - H.az;
    const step = THREE.MathUtils.clamp(d, -5 * dt, 5 * dt);
    const rel = H.pos.clone().sub(H.origin);
    turnXZ(rel, step);
    H.pos.copy(H.origin).add(rel);
    turnXZ(H.vel, step);
    H.az += step;
    if (Math.abs(d - step) < 1e-3) {
      delete H.azTarget;
      if (H.lofted && !H.bounced) H.landing = predictLanding(H.pos, H.vel);
    }
  }
  const sub = 4;
  for (let i = 0; i < sub; i++) {
    const h = dt / sub;
    H.vel.y -= G * h;
    H.vel.multiplyScalar(1 - (H.bounced ? 0.05 : 0.16) * h);
    H.pos.addScaledVector(H.vel, h);
    if (H.pos.y <= BALL_R && H.vel.y < 0) {
      H.pos.y = BALL_R;
      if (Math.abs(H.vel.y) > 1.5) {
        // A real bounce: steep landings lose more pace than skidding drives.
        const keep = Math.abs(H.vel.y) > 14 ? 0.7 : 0.9;
        H.vel.x *= keep; H.vel.z *= keep;
        H.vel.y = -H.vel.y * 0.42;
        H.bounced = true;
        sfx.bounce();
      } else {
        H.vel.y = 0; // now rolling
      }
    }
    if (H.pos.y <= BALL_R + 0.001 && H.vel.y === 0) {
      // Rolling friction on the outfield.
      const sp = Math.hypot(H.vel.x, H.vel.z);
      const ns = Math.max(0, sp - 4.5 * h);
      if (sp > 0) { H.vel.x *= ns / sp; H.vel.z *= ns / sp; }
      H.bounced = true;
    }
  }
  ball.position.copy(H.pos);

  if (H.keeperCatch) {
    if (H.pos.z > 2.6) {
      H.done = true;
      sfx.groan();
      return endBall({ out: true, text: 'OUT!', sub: 'Caught behind' });
    }
    return;
  }

  const t = S.clock - H.start;
  const groundPos = new THREE.Vector2(H.pos.x, H.pos.z);
  if (groundPos.distanceTo(FIELD_CENTER) > BOUNDARY_R) {
    const six = !H.bounced;
    sfx.crowd(six ? 1 : 0.6);
    buzz(six ? 250 : 150, 255);
    return endBall({ runs: six ? 6 : 4, text: six ? 'SIX!' : 'FOUR!', sub: `${six ? 'Launched' : 'Raced away'} ${regionOf(H.az)}` });
  }

  // Fielders react after a moment, then the two best placed cut across to the ball's path
  // (or run to where a lofted ball will come down). Everyone else holds position.
  const all = [...fielders.filter((f) => f.name !== 'keeper'), bowlerFielder];
  const sp = Math.hypot(H.vel.x, H.vel.z);
  const dir = sp > 0.5 ? new THREE.Vector3(H.vel.x / sp, 0, H.vel.z / sp) : null;
  const ballG = new THREE.Vector3(H.pos.x, 0, H.pos.z);
  const targetFor = (g) => {
    if (!H.bounced && H.landing) return H.landing;
    if (!dir) return ballG;
    const along = g.position.clone().sub(ballG).dot(dir);
    return along > 0 ? ballG.clone().addScaledVector(dir, along) : ballG;
  };
  const cost = (f) => f.p.g.position.distanceTo(targetFor(f.p.g)) + (dir && f.p.g.position.clone().sub(ballG).dot(dir) < 0 ? 15 : 0);
  if (t > 0.35) {
    all.sort((a, b) => cost(a) - cost(b));
    all.forEach((f, i) => {
      const g = f.p.g;
      const target = i < 2 ? targetFor(g) : f.home;
      const d = target.clone().sub(g.position).setY(0);
      const run = i < 2 ? 6.5 : 2.5;
      if (d.length() > 0.2) {
        g.position.addScaledVector(d.normalize(), Math.min(run * dt, d.length()));
        g.rotation.y = Math.atan2(d.x, d.z);
        g.position.y = i < 2 ? Math.abs(Math.sin(S.clock * 14)) * 0.06 : 0;
      }
    });
  }
  // A hard-hit ball has to come close to be stopped.
  const stopR = sp > 22 ? 0.75 : sp > 12 ? 1.05 : 1.35;

  for (const f of all) {
    const fp = f.p.g.position;
    const dist = Math.hypot(fp.x - H.pos.x, fp.z - H.pos.z);
    if (!H.bounced && !f.dropped && H.pos.y < 2.6 && H.pos.y > 0.15 && dist < 1.5) {
      const hard = H.vel.length() > 26;
      if (Math.random() < (hard ? 0.35 : 0.5)) {
        H.done = true;
        H.pos.copy(fp).setY(1.2);
        ball.position.copy(H.pos);
        sfx.groan();
        buzz(300, 255);
        return endBall({ out: true, text: 'OUT!', sub: `Caught at ${f.name}` });
      }
      f.dropped = true;
      H.vel.multiplyScalar(0.25);
      H.vel.y = Math.abs(H.vel.y) * 0.3;
      banner('Dropped!', `${f.name} puts it down`, 1);
    }
    if (H.bounced && dist < stopR) {
      // Runs depend on how far from the bat it was stopped.
      const d = Math.hypot(H.pos.x, H.pos.z);
      const runs = d < 18 ? 0 : d < 32 ? 1 : d < 58 ? 2 : 3;
      return endBall({ runs, text: runs ? `${runs} run${runs > 1 ? 's' : ''}` : 'No run', sub: `Fielded at ${f.name}` });
    }
  }
  if (t > 14) endBall({ runs: 3, text: '3 runs', sub: 'Well run' });
}

// ---------------------------------------------------------------- Input

const phoneQ = new THREE.Quaternion();
let phoneClock = null;
let phoneAnchor = null;
// Bluetooth delay compensation. Starts at a typical 50 ms and adjusts toward the player's average
// timing error, so a phone/laptop pair that is consistently late or early gets corrected automatically.
let phoneLag = store.get('lag', 0.05);
function calibrate(err) {
  if (Math.abs(err) > 0.3) return;
  phoneLag = THREE.MathUtils.clamp(phoneLag + err * 0.25, 0, 0.25);
  store.set('lag', phoneLag);
}
const DOWN = new THREE.Vector3(0, -1, 0);
const BACK = new THREE.Vector3(0, 0, -1);
// Bat orientation relative to the guard pose: x = your right, y = up, -z = toward the screen and bowler.
// Players hold the phone either with its screen toward the TV (like a bat face toward the bowler) or toward
// themselves. Held toward the TV, the phone is turned 180 degrees about the vertical compared with facing
// you, so its own left/right and front/back are reversed; turning the measured rotation by the same 180
// degrees gives the bat's rotation in the player's frame. The side of the phone facing the bowler is the face.
const rawQ = new THREE.Quaternion();
// Which way the screen faces is worked out from the straight practice shot (see finishPracticeSwing).
// What the on-screen bat shows: the phone exactly, mirrored for a left-handed batter.
const visualQ = (q, out) => (lefty() ? out.set(q.x, -q.y, -q.z, q.w) : out.copy(q));

// Recent bat states (tip direction, orientation) with timestamps, for reading the moment of contact.
const swingBuf = [];
function pushSwingSample(tip, t, speed, q) {
  swingBuf.push({ tip: tip.clone(), t, speed, q: q.clone() });
  if (swingBuf.length > 90) swingBuf.shift();
}
function nearestIndex(buf, t) {
  let i = -1;
  buf.forEach((b, k) => { if (i < 0 || Math.abs(b.t - t) < Math.abs(buf[i].t - t)) i = k; });
  return i;
}
// The bat at the moment of contact: which way its face points (heading, and how far it is tilted up)
// and which way the bat is moving. Headings: 0 = straight at the bowler, + = to the right.
function contactPhysics(t, buf = swingBuf) {
  const i = nearestIndex(buf, t);
  if (i < 1 || i >= buf.length - 1) return null;
  const face = BACK.clone().applyQuaternion(buf[i].q);
  const a = buf[i - 1].tip;
  const b = buf[i + 1].tip;
  const faceHd = Math.atan2(face.x, -face.z);
  const pathHd = Math.atan2(b.x - a.x, -(b.z - a.z));
  return {
    faceHd, pathHd,
    faceEl: (Math.atan2(face.y, Math.hypot(face.x, face.z)) * 180) / Math.PI,
    heading: Math.atan2(Math.sin(faceHd) + Math.sin(pathHd), Math.cos(faceHd) + Math.cos(pathHd)), // face pulled halfway toward the path
  };
}

// ---- Practice shots: straight, leg side, off side, each time you take guard.
// Everyone holds and swings a phone a little differently, so the three practice shots define what this
// player's straight, leg-side and off-side shots look like; real shots are placed between them.
let cal = store.get('cal4', null); // { s, l, o }: contact headings (radians) of the three practice shots
const PRACTICE = ['straight', 'leg', 'off'];
const pr = { step: 0, got: [], buf: [], prev: null, speed: 0, active: false, peak: 0, segStart: 0, best: null, timer: 0, done: false };
function practiceText(kind) {
  const legSide = lefty() ? 'right' : 'left';
  const offSide = lefty() ? 'left' : 'right';
  return {
    straight: ['Practice 1 of 3: STRAIGHT', 'Swing to hit the ball straight back past the bowler'],
    leg: ['Practice 2 of 3: LEG SIDE', `Swing to hit the ball to the leg side, the ${legSide} of the screen`],
    off: ['Practice 3 of 3: OFF SIDE', `Swing to hit the ball to the off side, the ${offSide} of the screen`],
  }[kind];
}
function startPractice() {
  Object.assign(pr, { step: 0, got: [], done: false });
  S.screen = 'practice';
  promptPractice();
}
function promptPractice() {
  Object.assign(pr, { buf: [], prev: null, speed: 0, active: false, peak: 0, best: null });
  clearTimeout(pr.timer);
  const [title, sub] = practiceText(PRACTICE[pr.step]);
  banner(title, sub, 99);
  hint(cal ? 'Swing the way you would in a match. Press Start on your phone to skip and keep your last practice.'
    : 'Swing the way you would in a match. These three shots teach the game your straight, leg and off shots.');
}
function practiceFeed(tip, t, q) {
  const p = pr.prev;
  pr.prev = { tip: tip.clone(), t };
  if (!p || pr.done) return;
  const dt = t - p.t;
  if (dt <= 0.001 || dt > 0.2) return;
  pr.speed = pr.speed * 0.3 + (p.tip.angleTo(tip) / dt) * 0.7;
  pr.buf.push({ tip: tip.clone(), t, speed: pr.speed, q: q.clone() });
  if (pr.buf.length > 120) pr.buf.shift();
  if (!pr.active && pr.speed > 6) { pr.active = true; pr.peak = 0; pr.segStart = t; }
  if (!pr.active) return;
  pr.peak = Math.max(pr.peak, pr.speed);
  if (pr.speed < pr.peak * 0.25 || pr.speed < 1.5) {
    pr.active = false;
    // The shot is where the bat sweeps through the bottom of its arc at speed (a backlift starts from
    // the bottom at rest, so it is never picked).
    const fast = pr.buf.filter((b) => b.t >= pr.segStart - 0.15 && b.speed >= pr.peak * 0.5);
    const bottom = fast.reduce((m, b) => (!m || b.tip.y < m.tip.y ? b : m), null);
    if (bottom && bottom.tip.y < -0.5) {
      const c = contactPhysics(bottom.t, pr.buf);
      const score = bottom.speed * -bottom.tip.y;
      if (c && (!pr.best || score > pr.best.score)) pr.best = { heading: c.heading, faceHd: c.faceHd, pathHd: c.pathHd, score };
    }
    clearTimeout(pr.timer);
    if (pr.best) pr.timer = setTimeout(finishPracticeSwing, 700);
  }
}
function finishPracticeSwing() {
  if (S.screen !== 'practice' || !pr.best || pr.done) return;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  if (pr.step === 0 && Math.abs(pr.best.pathHd) > Math.PI / 2) {
    // A straight shot must swing toward the bowler. This one swung toward the player, so the phone is held
    // the other way round (screen toward the TV vs toward the player): switch the grip and turn the shot
    // around to match. Everything after this is read with the corrected grip.
    S.grip = S.grip === 'tv' ? 'you' : 'tv';
    store.set('grip', S.grip);
    // Turning the frame by half a turn reverses every direction, but the bat face also swaps to the
    // other side of the phone, so the face heading comes out unchanged; only the swing path turns around.
    const f = pr.best.faceHd;
    const p = wrap(pr.best.pathHd + Math.PI);
    pr.best.heading = Math.atan2(Math.sin(f) + Math.sin(p), Math.cos(f) + Math.cos(p));
  }
  pr.got[pr.step] = pr.best.heading;
  buzz(40, 180);
  if (pr.step < PRACTICE.length - 1) {
    pr.step++;
    banner('Got it', '', 0.6);
    return setTimeout(() => { if (S.screen === 'practice' && !pr.done) promptPractice(); }, 700);
  }
  let [hs, hl, ho] = pr.got;
  const dl = hl - hs;
  const dO = ho - hs;
  // Leg and off must sit on opposite sides of straight, and be clearly apart.
  if (dl * dO >= 0 || Math.abs(dl) < 0.1 || Math.abs(dO) < 0.1 || Math.abs(hl - ho) < 0.35) {
    pr.step = 1;
    banner('Those looked too similar', 'Make the leg-side and off-side shots clearly different', 1.8);
    return setTimeout(() => { if (S.screen === 'practice' && !pr.done) promptPractice(); }, 1900);
  }
  // The leg-side shot must come out on the leg side of the screen (left for a right-hander). If it came out
  // on the off side, this setup mirrors sideways motion: flip it so the bat on screen follows the swing.
  if ((hl < ho) === lefty()) {
    S.mirror = !S.mirror;
    store.set('mirror', S.mirror);
    [hs, hl, ho] = [-hs, -hl, -ho];
  }
  cal = { s: hs, l: hl, o: ho };
  store.set('cal4', cal);
  pr.done = true;
  banner('All set', 'Here comes the bowler', 1.2);
  setTimeout(() => { if (S.screen === 'practice') afterGuard(); }, 1300);
}
// Place a real shot relative to the practice shots: like the leg-side practice shot = 46 degrees to leg,
// like the off-side one = 46 degrees to off, straight in between. Works whichever way the phone is held.
function aimFromPractice(heading) {
  const d = heading - cal.s;
  const n = d * (cal.l - cal.s) > 0 ? -d / (cal.l - cal.s) : d / (cal.o - cal.s);
  return THREE.MathUtils.clamp(n, -2, 2) * 0.8;
}

pad.addEventListener('motion', (e) => {
  if (S.input !== 'phone') return;
  // Held upright like a bat handle, screen facing you: the blade hangs below the phone.
  const q = Mocon.toThree(e.detail.quaternion, 'upright');
  if (S.grip === 'tv') rawQ.set(-q.x, q.y, -q.z, q.w); // conjugate by a half turn about the vertical
  else rawQ.set(q.x, q.y, q.z, q.w);
  if (S.mirror) rawQ.set(rawQ.x, -rawQ.y, -rawQ.z, rawQ.w); // sideways motion comes out mirrored on this setup
  visualQ(rawQ, phoneQ);
  if (!phoneClock) phoneClock = { last: e.detail.timeMs, t: 0 };
  phoneClock.t += ((e.detail.timeMs - phoneClock.last) & 0xffff) / 1000;
  phoneClock.last = e.detail.timeMs;
  // Bluetooth delivers samples in bunches, so time them with the phone's own clock, mapped onto the
  // game clock (minus the measured delivery delay). Re-anchor after pauses.
  const est = clockNow() - phoneLag - phoneClock.t;
  if (phoneAnchor === null || Math.abs(est - phoneAnchor) > 0.25) phoneAnchor = est;
  else phoneAnchor += (est - phoneAnchor) * 0.05;
  if (S.screen === 'play') {
    const t = phoneClock.t + phoneAnchor;
    const tip = DOWN.clone().applyQuaternion(rawQ);
    pushSwingSample(tip, t, sw.speed, rawQ);
    feedSwing(tip, t);
    // Loft is confirmed once the swing has finished (speed down to a quarter of its peak).
    if (S.refine && (sw.speed < S.refine.peakSpeed * 0.25 || t - S.refine.peakT > 0.28)) finishRefine();
  } else if (S.screen === 'practice') {
    practiceFeed(DOWN.clone().applyQuaternion(rawQ), phoneClock.t, rawQ);
  }
});

const mouse = { x: 0.5, y: 0.6 };
addEventListener('pointermove', (e) => { mouse.x = e.clientX / innerWidth; mouse.y = e.clientY / innerHeight; });
const mouseEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const mouseQ = new THREE.Quaternion();
let keyShift = false;
addEventListener('keydown', (e) => {
  if (e.key === 'Shift') keyShift = true;
  if (e.code === 'Escape') return S.screen === 'paused' ? resume() : pause();
  const dirs = { ArrowLeft: [-1, 0, -0.4], ArrowRight: [1, 0, -0.4], ArrowDown: [0, 0, -1], ArrowUp: [0, 0, -1] };
  const v = dirs[e.code];
  if (!v || e.repeat) return;
  e.preventDefault();
  if (!S.input) S.input = 'mouse';
  keySwingT = 0.25;
  playShot(clockNow(), new THREE.Vector3(...v).normalize(), 14, keyShift || e.code === 'ArrowUp');
});
addEventListener('keyup', (e) => { if (e.key === 'Shift') keyShift = false; });
let keySwingT = 0;

let frameNow = performance.now();
const clockNow = () => S.clock + (performance.now() - frameNow) / 1000;

function buzz(ms, amp) {
  if (S.input === 'phone' && pad.connected) pad.vibrate(ms, amp).catch(() => {});
}

// ---------------------------------------------------------------- UI

// ---- Field map (top right): the ground from above, bowler at the top and the batter at the bottom, like the
// camera. Fielders move live; the current shot is traced from the bat, and earlier shots stay as a wagon wheel.
const mapCv = $('fieldMap');
const mapG = mapCv.getContext('2d');
let mapT = 0;
const MAP_COL = { 0: 'rgba(255,255,255,.45)', 1: '#ffffff', 2: '#ffffff', 3: '#ffffff', 4: '#3d8bff', 6: '#c77dff' };
function drawFieldMap(dt) {
  const show = S.screen === 'play';
  mapCv.style.display = $('fieldKey').style.display = show ? '' : 'none';
  if (!show || (mapT += dt) < 1 / 30) return;
  mapT = 0;
  const W = mapCv.width;
  const c = W / 2;
  const sc = (c - 6) / BOUNDARY_R;
  const side = lefty() ? -1 : 1; // match the mirrored field for a left-hander
  const X = (x) => c + x * side * sc;
  const Y = (z) => c + (z - FIELD_CENTER.y) * sc;
  const g = mapG;
  g.clearRect(0, 0, W, W);
  // Grass with mowing stripes, clipped to the boundary.
  g.save();
  g.beginPath(); g.arc(c, c, c - 2, 0, Math.PI * 2); g.clip();
  g.fillStyle = '#2f7a2b'; g.fillRect(0, 0, W, W);
  g.fillStyle = 'rgba(255,255,255,.05)';
  for (let x = 0; x < W; x += 24) g.fillRect(x, 0, 12, W);
  // Inner circle and pitch.
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1.5; g.setLineDash([5, 5]);
  g.beginPath();
  g.arc(X(0), Y(BOWL_Z), 27.4 * sc, Math.PI, 0);
  g.lineTo(X(27.4 * side), Y(0));
  g.arc(X(0), Y(0), 27.4 * sc, 0, Math.PI);
  g.closePath(); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#c9b48a';
  g.fillRect(c - 1.5 * sc, Y(BOWL_Z - 1), 3 * sc, (Math.abs(BOWL_Z) + 2) * sc);
  // Wagon wheel of earlier shots this innings.
  g.lineWidth = 2;
  for (const sh of S.shots) {
    if (sh.out) continue;
    g.strokeStyle = MAP_COL[sh.runs] || '#fff';
    g.globalAlpha = 0.55;
    g.beginPath(); g.moveTo(X(0), Y(STUMP_Z)); g.lineTo(X(sh.x), Y(sh.z)); g.stroke();
  }
  g.globalAlpha = 1;
  // The shot in play.
  if (S.hit && !S.hit.keeperCatch && ball.visible) {
    g.strokeStyle = '#ffcc33'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(X(0), Y(STUMP_Z)); g.lineTo(X(ball.position.x), Y(ball.position.z)); g.stroke();
  }
  g.restore();
  // Boundary rope.
  g.strokeStyle = '#ffffff'; g.lineWidth = 3;
  g.beginPath(); g.arc(c, c, c - 3, 0, Math.PI * 2); g.stroke();
  // Fielders, bowler and keeper.
  const dot = (x, z, fill, ring, r = 6) => {
    g.beginPath(); g.arc(X(x), Y(z), r, 0, Math.PI * 2);
    g.fillStyle = fill; g.fill();
    g.lineWidth = 2; g.strokeStyle = ring; g.stroke();
  };
  for (const f of fielders) dot(f.p.g.position.x, f.p.g.position.z, '#1b2f5e', '#ffcc33');
  dot(bowler.g.position.x, bowler.g.position.z, '#1b2f5e', '#ffcc33');
  dot(batter.g.position.x, batter.g.position.z, '#0f7c78', '#ffffff', 7);
  // The ball.
  if (ball.visible) {
    g.beginPath(); g.arc(X(ball.position.x), Y(ball.position.z), 5, 0, Math.PI * 2);
    g.fillStyle = '#ff3b3b'; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
  }
}

// Big broadcast-style graphic. Short calls animate in and out; long ones (prompts) stay until replaced.
let bannerT = 0;
function banner(text, sub = '', s = 1.8) {
  const ev = $('event');
  const t = String(text).toUpperCase();
  const kind = t.startsWith('FOUR') ? 'four' : t.startsWith('SIX') ? 'six' : t.startsWith('OUT') || t.startsWith('BOWLED') ? 'out'
    : t.startsWith('WIDE') ? 'wide' : 'info';
  if (kind === 'four' || kind === 'six') crowdCheer = kind === 'six' ? 4 : 3;
  $('evTag').textContent = text;
  $('evSub').textContent = sub;
  $('evSub').style.display = sub ? '' : 'none';
  ev.className = '';
  void ev.offsetWidth; // restart the animation
  ev.className = `${kind} ${s > 3 ? 'persist' : 'show'}`;
  bannerT = s;
}
function hideBanner() { $('event').className = ''; bannerT = 0; }
let swingFlash = 0;
let timingT = 0;
// Text plus a meter: early | good | PERFECT | good | late, with a marker where the swing landed.
function timing(text, color, err = null) {
  $('timing').textContent = text;
  $('timing').style.color = color;
  const [P, G, E] = DIFFS[S.diff].win;
  const span = 0.3; // the meter shows +-300 ms
  const w = (a, b) => `${((b - a) / (2 * span)) * 100}%`;
  $('tzE').style.cssText = `width:${w(-span, -G)};background:#b8323c`;
  $('tzG1').style.cssText = `width:${w(-G, -P)};background:#e0a52a`;
  $('tzP').style.cssText = `width:${w(-P, P)};background:#2fbf71`;
  $('tzG2').style.cssText = `width:${w(P, G)};background:#e0a52a`;
  $('tzL').style.cssText = `width:${w(G, span)};background:#b8323c`;
  $('tmark').style.display = err === null ? 'none' : '';
  if (err !== null) $('tmark').style.left = `${(THREE.MathUtils.clamp(err, -span, span) / (2 * span) + 0.5) * 100}%`;
  $('timingBox').classList.add('show');
  timingT = 1.6;
}
let hintT = 0;
function hint(text, s = 0) { $('hint').textContent = text; hintT = s; }

function renderMenu() {
  const seg = (el, items, cur, set) => {
    el.innerHTML = '';
    for (const [k, v] of Object.entries(items)) {
      const b = document.createElement('button');
      b.className = k === cur ? 'on' : '';
      b.innerHTML = `${v.label}<small>${v.sub}</small>`;
      b.onclick = () => { set(k); renderMenu(); };
      el.appendChild(b);
    }
  };
  seg($('modes'), MODES, S.mode, (k) => { S.mode = k; store.set('mode', k); });
  seg($('diffs'), DIFFS, S.diff, (k) => { S.diff = k; store.set('diff', k); });
  seg($('hands'), HANDS, S.hand, (k) => { S.hand = k; store.set('hand', k); applyHand(); });
  $('btnPhone').textContent = pad.connected ? 'Play with phone' : 'Connect phone';
}

$('btnPhone').onclick = async () => {
  sfx.ensure();
  try {
    if (!pad.connected) {
      $('menuStatus').textContent = 'Choose your phone in the browser\'s list…';
      await pad.connect();
      await pad.setLayout({ title: 'Boundary', buttons: ['Start · Pause'] });
      $('menuStatus').textContent = `Connected: ${pad.info?.model ?? 'phone'}`;
    }
    S.input = 'phone';
    takeGuard();
  } catch (err) {
    $('menuStatus').textContent = err.name === 'NotFoundError' ? 'No phone chosen.' : err.message;
  }
};
// After taking guard: carry on with a paused innings, or start a new one.
function afterGuard() {
  hideBanner();
  if (S.midInnings) { S.midInnings = false; S.screen = 'play'; hint(''); }
  else startInnings();
}
function takeGuard() {
  S.midInnings = S.screen === 'paused';
  S.screen = 'calibrate';
  ['menu', 'pause', 'end'].forEach((id) => $(id).classList.remove('show'));
  banner('Take guard', 'Face the screen and hold the phone upright like a bat handle', 99);
  hint('Then press Start on your phone. Three practice shots (straight, leg side, off side) come next.');
}
$('btnMouse').onclick = () => { S.input = 'mouse'; startInnings(); };
$('btnAgain').onclick = () => startInnings();
$('btnRecal').onclick = () => takeGuard();
$('btnMenu').onclick = toMenu;
$('btnQuit').onclick = toMenu;
$('btnResume').onclick = resume;
$('btnReconnect').onclick = async () => {
  try {
    await pad.reconnect();
    await pad.setLayout({ title: 'Boundary', buttons: ['Start · Pause'] });
    resume();
  } catch (err) { $('pauseText').textContent = `Couldn't reconnect: ${err.message}`; }
};

function toMenu() {
  S.screen = 'menu';
  ['end', 'pause'].forEach((id) => $(id).classList.remove('show'));
  $('menu').classList.add('show');
  hideBanner();
  hint('');
  renderMenu();
}
function pause(reason) {
  if (S.screen !== 'play') return;
  S.screen = 'paused';
  const lost = reason === 'disconnect';
  $('pauseTitle').textContent = lost ? 'Phone disconnected' : 'Paused';
  $('pauseText').textContent = lost ? 'Open the Mocon app on your phone, then reconnect.' : 'Press Pause on your phone, Esc, or Resume.';
  $('btnResume').style.display = lost ? 'none' : '';
  $('btnReconnect').style.display = lost ? '' : 'none';
  $('btnRecal').style.display = S.input === 'phone' && !lost ? '' : 'none';
  $('pause').classList.add('show');
}
function resume() {
  if (S.screen !== 'paused') return;
  $('pause').classList.remove('show');
  S.screen = 'play';
}

pad.addEventListener('buttondown', (e) => {
  if (e.detail.index !== 0) return;
  if (S.screen === 'calibrate') { pad.recenter().catch(() => {}); startPractice(); }
  else if (S.screen === 'practice' && cal) { pr.done = true; afterGuard(); }
  else if (S.screen === 'play') pause();
  else if (S.screen === 'paused') resume();
  else if (S.screen === 'end') $('btnAgain').click();
});
pad.addEventListener('disconnect', () => { renderMenu(); if (S.input === 'phone') pause('disconnect'); });
if (!Mocon.isSupported()) {
  $('btnPhone').disabled = true;
  $('menuStatus').textContent = 'This browser can\'t use Bluetooth. Use Chrome or Edge for phone play, or play with mouse / keys.';
}
// Batting hand: the field and the controls are mirrored for a left-hander.
const HANDS = { right: { label: 'Right-handed', sub: 'leg side on the left' }, left: { label: 'Left-handed', sub: 'leg side on the right' } };
function applyHand() { world.scale.x = lefty() ? -1 : 1; }
applyHand();
renderMenu();
inningsLabel();

// ---------------------------------------------------------------- Frame loop

const batCam = { pos: new THREE.Vector3(0.7, 1.75, 3.8), look: new THREE.Vector3(0, 0.9, -14) };
const camLook = batCam.look.clone();
camera.position.set(FIELD_CENTER.x, 30, FIELD_CENTER.y + 78); // start on the menu orbit
camLook.set(0, 0, -12);
camera.lookAt(camLook);
const batTarget = new THREE.Quaternion();

function adaptQuality(ms) {
  if (ms > 100 || document.hidden) return; // a stall or a background tab, not a slow machine
  quality.acc += ms;
  if (++quality.n < 120) return;
  const avg = quality.acc / quality.n;
  quality.acc = quality.n = 0;
  if (avg > 21 && quality.tier < QUALITY.length - 1) {
    quality.tier++;
    renderer.setPixelRatio(QUALITY[quality.tier]);
    resize();
    if (quality.tier === QUALITY.length - 1) {
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
  }
  localStorage.setItem('boundary.gfx', String(quality.tier));
}

function frame(now) {
  adaptQuality(now - frameNow);
  const dt = THREE.MathUtils.clamp((now - frameNow) / 1000, 0, 0.05);
  if (crowdCheer > 0) {
    crowdCheer = Math.max(0, crowdCheer - dt);
    const hop = Math.abs(Math.sin(now / 1000 * 11)) * 0.006 * Math.min(1, crowdCheer);
    for (const t of crowdMaps) t.offset.y = hop;
  }
  frameNow = now;
  const playing = S.screen === 'play';
  if (playing) S.clock += dt;
  if (document.body.dataset.screen !== S.screen) document.body.dataset.screen = S.screen;
  const ready = playing && (S.phase === 'runup' || S.phase === 'delivery');
  for (const f of fielders) f.p.ready = ready;

  // Bat orientation
  if (S.input === 'phone') {
    batTarget.copy(phoneQ);
  } else {
    // Mouse up lifts the bat back; down swings it through. Left/right angles the swing.
    let lift = (0.62 - mouse.y) * 3.2;
    if (keySwingT > 0) { keySwingT -= dt; lift = -1.2 + keySwingT * 8; }
    mouseEuler.set(-lift, 0, (mouse.x - 0.5) * 1.4);
    mouseQ.setFromEuler(mouseEuler);
    visualQ(mouseQ, batTarget);
    if (playing && keySwingT <= 0) feedSwing(DOWN.clone().applyQuaternion(mouseQ), clockNow());
  }
  bat.quaternion.slerp(batTarget, 1 - Math.exp(-dt * 40));

  if (playing) {
    S.phaseT += dt;
    if (S.phase === 'idle' && S.phaseT >= 0) {
      S.del = makeDelivery(S.diff, S.balls);
      S.phase = 'runup';
      S.phaseT = 0;
    } else if (S.phase === 'runup') {
      const k = Math.min(1, S.phaseT / 1.7);
      bowler.g.position.set(S.del.spin ? -0.7 : -1.0, Math.abs(Math.sin(S.phaseT * 12)) * 0.08 * (1 - k), THREE.MathUtils.lerp(-34, BOWL_Z - 1.2, k));
      bowler.g.rotation.y = 0;
      if (S.phaseT > 1.3) bowler.arms[1].rotation.x = -((S.phaseT - 1.3) / 0.4) * Math.PI * 1.6;
      if (S.phaseT >= 1.7) {
        S.phase = 'delivery';
        S.phaseT = 0;
        S.releaseAt = S.clock;
        ball.visible = shadowDot.visible = true;
        $('speed').innerHTML = `${Math.round(S.del.kmh)} <small>km/h · ${S.del.spin ? 'spin' : 'pace'}</small>`;
        if (S.diff === 'club') {
          pitchMarker.position.set(S.del.bounceAt.x, 0.006, S.del.bounceAt.z);
          pitchMarker.material.opacity = 0.9;
        }
      }
    } else if (S.phase === 'delivery') {
      const t = S.clock - S.releaseAt;
      const i = Math.max(0, Math.floor(t / S.del.h));
      if (i < S.del.path.length) {
        ball.position.copy(S.del.path[i]);
      } else {
        // The ball has gone past the bat without being hit.
        if (S.del.hitsStumps) {
          breakStumps(S.del.velAtContact);
          sfx.stumps();
          sfx.groan();
          buzz(300, 255);
          endBall({ out: true, text: 'BOWLED!', sub: S.missed ? 'Swung and missed' : 'Through the gate' });
        } else if (isWide(S.del)) {
          endBall({ wide: true });
        } else {
          endBall({ runs: 0, text: S.missed ? 'Beaten!' : 'Dot ball', sub: S.missed ? 'Past the outside edge' : 'Left alone' });
        }
        ball.visible = false;
      }
      bowler.g.position.z = Math.min(bowler.g.position.z + dt * 4, -15);
      bowler.arms[1].rotation.x -= dt * 6;
      pitchMarker.material.opacity *= Math.exp(-dt * 1.5);
    } else if (S.phase === 'hit') {
      updateHit(dt);
    } else if (S.phase === 'result') {
      if (S.hit && !S.hit.done) {
        // Let the ball keep rolling a little after the call.
        S.hit.vel.multiplyScalar(Math.exp(-dt * 2));
        S.hit.pos.addScaledVector(S.hit.vel, dt);
        S.hit.pos.y = Math.max(BALL_R, S.hit.pos.y);
        ball.position.copy(S.hit.pos);
      }
      if (S.phaseT > 2.2) {
        if (!checkEnd()) {
          for (const f of [...fielders, bowlerFielder]) f.p.g.position.copy(f.home);
          nextBall(0.6);
        }
      }
    }
  }

  // Flying stumps after a bowled.
  if (batStumps.flying) {
    for (const f of batStumps.flying) {
      if (f.tilt) { f.o.rotation.x = Math.min(1.2, f.o.rotation.x + dt * 6); continue; }
      f.v.y -= G * dt;
      f.o.position.addScaledVector(f.v, dt);
      f.o.rotation.x += f.spin.x * dt;
      f.o.rotation.y += f.spin.y * dt;
      if (f.o.position.y < 0.01) { f.o.position.y = 0.01; f.v.multiplyScalar(0.3); }
    }
  }

  // Keep the ball readable from the broadcast camera: a minimum on-screen size and a short trail.
  const camDist = camera.position.distanceTo(ball.getWorldPosition(new THREE.Vector3()));
  const grow = Math.max(1, camDist / 14);
  ball.scale.setScalar(grow);
  shadowDot.scale.setScalar(grow);
  shadowDot.position.set(ball.position.x, 0.008, ball.position.z);
  shadowDot.visible = ball.visible;
  const prevBall = trailPts[0];
  trailPts.unshift(prevBall && trailPts.length >= TRAIL_N ? trailPts.pop().copy(ball.position) : ball.position.clone());
  trailPts.length = Math.min(trailPts.length, TRAIL_N);
  // Spin the ball along its path.
  if (prevBall && ball.visible) {
    _seg.subVectors(ball.position, trailPts[1] || ball.position);
    const dist = _seg.length();
    if (dist > 1e-4) { _off.set(_seg.z, 0, -_seg.x).normalize(); ball.rotateOnWorldAxis(_off, dist / BALL_R * 0.6); }
  }
  const showTrail = ball.visible && (S.phase === 'hit' || S.phase === 'delivery') && trailPts.length > 2;
  trailLine.visible = showTrail;
  if (showTrail) {
    world.worldToLocal(_camLocal.copy(camera.position));
    const width = BALL_R * grow * 0.9;
    for (let i = 0; i < TRAIL_N; i++) {
      const p = trailPts[Math.min(i, trailPts.length - 1)];
      const q = trailPts[Math.min(i + 1, trailPts.length - 1)];
      _seg.subVectors(p, q);
      if (_seg.lengthSq() < 1e-8) _seg.set(0, 0, 1);
      _off.subVectors(_camLocal, p).cross(_seg).normalize().multiplyScalar(width * (1 - (i / TRAIL_N) * 0.7));
      trailArr.set([p.x + _off.x, p.y + _off.y, p.z + _off.z, p.x - _off.x, p.y - _off.y, p.z - _off.z], i * 6);
    }
    trailGeo.attributes.position.needsUpdate = true;
  }

  // Camera: behind the batter while facing; a high broadcast view once the ball is hit.
  const follow = S.hit && !S.hit.keeperCatch && (S.phase === 'hit' || S.phase === 'result');
  const k = 1 - Math.exp(-dt * (follow ? 2.5 : 4));
  const side = lefty() ? -1 : 1; // the field is drawn mirrored for a left-hander
  if (S.screen === 'menu' || S.screen === 'end') {
    // Slow broadcast orbit of the ground behind the menus.
    const a = (now / 1000) * 0.045;
    const kk = 1 - Math.exp(-dt * 1.5);
    camera.position.lerp(new THREE.Vector3(FIELD_CENTER.x + Math.sin(a) * 78, 30, FIELD_CENTER.y + Math.cos(a) * 78), kk);
    camLook.lerp(new THREE.Vector3(0, 0, -12), kk);
  } else if (follow) {
    const bp = S.hit.pos.clone();
    bp.x *= side;
    camera.position.lerp(new THREE.Vector3(bp.x * 0.35, 16 + Math.min(20, Math.hypot(bp.x, bp.z) * 0.25), 22 + bp.z * 0.25), k);
    camLook.lerp(bp, k);
  } else {
    camera.position.lerp(new THREE.Vector3(batCam.pos.x * side, batCam.pos.y, batCam.pos.z), k);
    camLook.lerp(batCam.look, k);
  }
  camera.lookAt(camLook);

  // Swing meter: how fast the bat is moving, with a line at the speed that counts as a swing.
  const cfgS = SWING[S.input] || SWING.mouse;
  $('meterFill').style.height = Math.min(100, (sw.speed / (cfgS.start * 2.5)) * 100) + '%';
  $('meter').classList.toggle('flash', swingFlash > 0);
  swingFlash = Math.max(0, swingFlash - dt * 3);
  $('meter').style.display = playing ? '' : 'none';
  if (bannerT > 0 && (bannerT -= dt) <= 0) hideBanner();
  if (timingT > 0 && (timingT -= dt) <= 0) $('timingBox').classList.remove('show');
  if (hintT > 0 && (hintT -= dt) <= 0) $('hint').textContent = '';

  animateBatter(dt);
  animatePeople(dt);
  drawFieldMap(dt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);
// Canvas text (big screen) needs the web font; redraw once it has loaded.
document.fonts?.ready.then(() => {
  inningsLabel();
  drawBoards(boardAtlas.image.getContext('2d'), boardAtlas.image.width, boardAtlas.image.height);
  boardAtlas.needsUpdate = true;
});
// The stadium never moves: work out its transforms once instead of every frame.
for (const o of scene.children) {
  if (o === world || o.isLight || o.isCamera) continue;
  o.updateMatrixWorld(true);
  o.traverse((c) => { c.matrixAutoUpdate = false; });
}

