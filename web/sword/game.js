// Sword Duel — a first-person sword fight controlled by the Mocon phone app (or a mouse).
import * as THREE from 'three';
import { Mocon } from '../mocon.js?v=20261114-2350';

// ---------------------------------------------------------------- Tuning

const OPPONENTS = [
  { name: 'Rook the Squire', hp: 60, armor: 0x7d8a96, eyes: 0x6fd3ff,
    windup: [0.95, 1.25], guardTime: [1.4, 2.4], damage: 12, combo: 1, feint: 0, adapt: 0.25 },
  { name: 'Vessa the Duelist', hp: 90, armor: 0x8a5a3c, eyes: 0xffc35a,
    windup: [0.65, 0.9], guardTime: [0.9, 1.7], damage: 16, combo: 2, feint: 0.18, adapt: 0.45 },
  { name: 'The Iron Warden', hp: 130, armor: 0x3d4148, eyes: 0xff4a3a,
    windup: [0.48, 0.72], guardTime: [0.6, 1.3], damage: 21, combo: 3, feint: 0.32, adapt: 0.65 },
  { name: 'Sable the Mirror', hp: 150, armor: 0x2b2f4a, eyes: 0xb48cff,
    windup: [0.45, 0.65], guardTime: [0.5, 1.1], damage: 22, combo: 3, feint: 0.4, adapt: 0.8 },
  { name: 'The Ashen King', hp: 180, armor: 0x5a4a2a, eyes: 0xff8a2a,
    windup: [0.42, 0.62], guardTime: [0.4, 1.0], damage: 25, combo: 4, feint: 0.45, adapt: 0.9 },
];

// Squire is the original, forgiving game. Knight and Legend add two opponents and smarter AI:
//  read     chance they switch sides when you point at the attack side too early
//  punish   a 3rd hit in quick succession gets deflected and countered; blocked slashes leave you off balance
const DIFFICULTIES = {
  squire: { label: 'Squire', opponents: 3, hp: 1, damage: 1, windup: 1, combo: 0, feint: 0,
            read: 0, punish: false, parryAngle: 0.28, stagger: 1.5, heal: 40 },
  knight: { label: 'Knight', opponents: 5, hp: 1.3, damage: 1.35, windup: 0.78, combo: 1, feint: 0.15,
            read: 0.55, punish: true, parryAngle: 0.38, stagger: 1.1, heal: 25 },
  legend: { label: 'Legend', opponents: 5, hp: 1.6, damage: 1.7, windup: 0.62, combo: 2, feint: 0.3,
            read: 0.85, punish: true, parryAngle: 0.45, stagger: 0.85, heal: 10 },
};
let D = DIFFICULTIES.knight;
const MIN_WINDUP = 0.3; // seconds; below this nobody can react

const ZONES = ['left', 'right', 'high'];
const FOE_Z = -3.0; // opponent's distance from the player
// Parry: your blade must point into the zone the strike comes from (aim angles, radians).
// Harder difficulties demand a more committed angle.
const inZone = (aim, zone) =>
  zone === 'left' ? aim.yaw < -D.parryAngle : zone === 'right' ? aim.yaw > D.parryAngle : aim.pitch > D.parryAngle + 0.14;
// Which slash direction each guard stops.
const GUARD_BLOCKS = { left: 'L2R', right: 'R2L', high: 'down' };

const SLASH = {
  phone: { start: 5.0, end: 2.0, minAmp: 0.45 },
  mouse: { start: 3.2, end: 1.2, minAmp: 0.35 },
};
const FURY_TIME = 4;

// ---------------------------------------------------------------- DOM

const $ = (id) => document.getElementById(id);
const ui = {
  playerFill: $('playerFill'), enemyFill: $('enemyFill'), enemyName: $('enemyName'),
  furyWrap: $('furyWrap'), furyFill: $('furyFill'), aim: $('aim'), flash: $('flash'),
  banner: $('banner'), hint: $('hint'), phoneBadge: $('phoneBadge'),
  zones: { left: $('zone-left'), right: $('zone-right'), high: $('zone-high') },
};
const show = (id, on) => $(id).classList.toggle('show', on);

let bannerTimer = 0;
function banner(text, seconds = 1.2) {
  ui.banner.textContent = text;
  ui.banner.classList.add('show');
  bannerTimer = seconds;
}

// ---------------------------------------------------------------- Sound (synthesized, no assets)

const sfx = {
  ctx: null, master: null, noiseBuf: null,
  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  env(node, t, peak, attack, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    g.connect(this.master);
    return g;
  },
  noise(t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.start(t, Math.random() * 0.5, dur);
    return s;
  },
  swoosh(strength = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const n = this.noise(t, 0.3);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(2200, t + 0.2);
    n.connect(f);
    this.env(f, t, 0.35 * Math.min(1.5, strength), 0.03, 0.2);
  },
  clang() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [587, 1203, 1789, 2651, 3517].forEach((hz, i) => {
      const o = this.ctx.createOscillator();
      o.type = i ? 'sine' : 'triangle';
      o.frequency.value = hz * (0.98 + Math.random() * 0.04);
      o.start(t);
      o.stop(t + 1);
      this.env(o, t, 0.22 / (i + 1), 0.002, 0.5 + 0.25 / (i + 1));
    });
    const n = this.noise(t, 0.05);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    n.connect(hp);
    this.env(hp, t, 0.4, 0.001, 0.04);
  },
  hit() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    o.start(t);
    o.stop(t + 0.3);
    this.env(o, t, 0.7, 0.005, 0.2);
    const n = this.noise(t, 0.1);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    n.connect(lp);
    this.env(lp, t, 0.5, 0.002, 0.09);
  },
  hurt() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.35);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    o.connect(lp);
    o.start(t);
    o.stop(t + 0.45);
    this.env(lp, t, 0.6, 0.01, 0.35);
    this.hit();
  },
  fury() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [hz, delay] of [[220, 0], [330, 0.08], [440, 0.16], [660, 0.24]]) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = hz;
      o.start(t + delay);
      o.stop(t + delay + 0.4);
      this.env(o, t + delay, 0.08, 0.01, 0.35);
    }
  },
};

// ---------------------------------------------------------------- Scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);
scene.fog = new THREE.Fog(0x0b0d12, 6, 16);

const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 50);
camera.position.set(0, 1.6, 0);
camera.lookAt(0, 1.3, -3.5);
const cameraBase = camera.position.clone();
scene.add(camera);

scene.add(new THREE.HemisphereLight(0x8090b0, 0x201812, 1.3));
// Soft fill from the player's side so the opponent's front is readable.
const fill = new THREE.PointLight(0xffd2a0, 6, 6, 1.5);
fill.position.set(0.4, 2.0, 0.3);
scene.add(fill);
const moon = new THREE.DirectionalLight(0x9fb4ff, 0.8);
moon.position.set(-3, 6, 2);
moon.castShadow = true;
moon.shadow.mapSize.set(1024, 1024);
scene.add(moon);

const torches = [];
for (const x of [-2.6, 2.6]) {
  const light = new THREE.PointLight(0xff9a3c, 14, 9, 1.6);
  light.position.set(x, 2.3, -3.6);
  scene.add(light);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.2), new THREE.MeshStandardMaterial({ color: 0x2b2118 }));
  pole.position.set(x, 1.1, -3.6);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 10), new THREE.MeshBasicMaterial({ color: 0xffb455 }));
  flame.position.set(x, 2.28, -3.6);
  scene.add(pole, flame);
  torches.push({ light, flame, seed: Math.random() * 10 });
}

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(10, 64),
  new THREE.MeshStandardMaterial({ color: 0x2a2520, roughness: 0.95 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const ring = new THREE.Mesh(
  new THREE.RingGeometry(3.6, 3.75, 64),
  new THREE.MeshBasicMaterial({ color: 0x5a4630, side: THREE.DoubleSide }),
);
ring.rotation.x = -Math.PI / 2;
ring.position.set(0, 0.005, -2.4);
scene.add(ring);
const stone = new THREE.MeshStandardMaterial({ color: 0x3a3631, roughness: 0.9 });
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * Math.PI * 2;
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.42, 4.5, 10), stone);
  pillar.position.set(Math.sin(a) * 8, 2.25, -2.4 + Math.cos(a) * 8);
  pillar.castShadow = true;
  scene.add(pillar);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.fov = camera.aspect < 1 ? 75 : 60;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- Player sword (child of camera)

const swordRig = new THREE.Group();
swordRig.position.set(0.3, -0.4, -0.95);
camera.add(swordRig);
const steel = new THREE.MeshStandardMaterial({ color: 0xd8dee6, metalness: 0.9, roughness: 0.22, emissive: 0x000000 });
{
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.012, 1.0), steel);
  blade.position.z = -0.62;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.12, 4), steel);
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = -1.18;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.025, 0.03), new THREE.MeshStandardMaterial({ color: 0xb08a3e, metalness: 0.8, roughness: 0.35 }));
  guard.position.z = -0.1;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.16), new THREE.MeshStandardMaterial({ color: 0x3a2618 }));
  grip.rotation.x = Math.PI / 2;
  grip.position.z = 0.02;
  swordRig.add(blade, tip, guard, grip);
}
const TIP_LOCAL = new THREE.Vector3(0, 0, -1.22);
const BASE_LOCAL = new THREE.Vector3(0, 0, -0.14);

// Slash trail: a ribbon between recent blade base and tip positions.
const TRAIL_N = 16;
const trailPos = new Float32Array(TRAIL_N * 2 * 3);
const trailCol = new Float32Array(TRAIL_N * 2 * 3);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
{
  const idx = [];
  for (let i = 0; i < TRAIL_N - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  trailGeo.setIndex(idx);
}
const trail = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({
  vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
}));
trail.frustumCulled = false;
scene.add(trail);
const trailHist = [];
let trailStrength = 0;

// Sparks
const SPARK_N = 400;
const sparkPos = new Float32Array(SPARK_N * 3);
const sparkCol = new Float32Array(SPARK_N * 3);
const sparkVel = new Float32Array(SPARK_N * 3);
const sparkLife = new Float32Array(SPARK_N);
const sparkBase = new Float32Array(SPARK_N * 3);
const sparkGeo = new THREE.BufferGeometry();
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
const sparkTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
})();
const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
  size: 0.05, map: sparkTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
}));
sparks.frustumCulled = false;
scene.add(sparks);
let sparkNext = 0;
function burst(pos, count, color, speed = 3) {
  const c = new THREE.Color(color);
  for (let n = 0; n < count; n++) {
    const i = sparkNext++ % SPARK_N;
    sparkPos.set([pos.x, pos.y, pos.z], i * 3);
    const v = new THREE.Vector3().randomDirection().multiplyScalar(speed * (0.3 + Math.random()));
    sparkVel.set([v.x, v.y + 1.2, v.z], i * 3);
    sparkBase.set([c.r, c.g, c.b], i * 3);
    sparkLife[i] = 0.35 + Math.random() * 0.4;
  }
}
function updateSparks(dt) {
  for (let i = 0; i < SPARK_N; i++) {
    if (sparkLife[i] <= 0) { sparkCol[i * 3] = sparkCol[i * 3 + 1] = sparkCol[i * 3 + 2] = 0; continue; }
    sparkLife[i] -= dt;
    sparkVel[i * 3 + 1] -= 9.8 * dt;
    for (let k = 0; k < 3; k++) {
      sparkPos[i * 3 + k] += sparkVel[i * 3 + k] * dt;
      sparkCol[i * 3 + k] = sparkBase[i * 3 + k] * Math.min(1, sparkLife[i] * 3);
    }
  }
  sparkGeo.attributes.position.needsUpdate = true;
  sparkGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- Opponent model

const V = (x, y, z) => new THREE.Vector3(x, y, z);
// Root-local poses: where the hilt is and which way the blade points. +z faces the player.
const POSES = {
  idle:         { hilt: V(0.28, 1.05, 0.45), dir: V(0.05, 0.45, 1),   twist: 0,     lean: 0 },
  guard_left:   { hilt: V(-0.3, 1.15, 0.42), dir: V(0.15, 1, 0.25),   twist: -0.1,  lean: 0 },
  guard_right:  { hilt: V(0.3, 1.15, 0.42),  dir: V(-0.15, 1, 0.25),  twist: 0.1,   lean: 0 },
  guard_high:   { hilt: V(-0.48, 1.66, 0.38), dir: V(1, 0.12, 0.08),  twist: 0,     lean: -0.05 },
  windup_left:  { hilt: V(-0.7, 1.55, -0.02), dir: V(-0.6, 0.75, -0.3), twist: -0.4, lean: -0.05 },
  windup_right: { hilt: V(0.7, 1.55, -0.02),  dir: V(0.6, 0.75, -0.3),  twist: 0.4,  lean: -0.05 },
  windup_high:  { hilt: V(0.08, 1.98, -0.05), dir: V(0, 0.5, -0.85),    twist: 0,    lean: -0.18 },
  strike_left:  { hilt: V(0.35, 1.25, 0.8),  dir: V(0.9, 0.05, 0.45),  twist: 0.35,  lean: 0.22 },
  strike_right: { hilt: V(-0.35, 1.25, 0.8), dir: V(-0.9, 0.05, 0.45), twist: -0.35, lean: 0.22 },
  strike_high:  { hilt: V(0.05, 1.05, 0.85), dir: V(0, -0.35, 1),      twist: 0,     lean: 0.3 },
  stagger:      { hilt: V(0.6, 0.85, 0.0),   dir: V(0.7, -0.5, -0.25), twist: 0.5,   lean: -0.32 },
  dead:         { hilt: V(0.6, 0.6, 0.2),    dir: V(1, -0.2, 0),       twist: 0,     lean: 0 },
};
for (const p of Object.values(POSES)) p.dir.normalize();
const UP = V(0, 1, 0);

function buildFighter(spec) {
  const root = new THREE.Group();
  const armor = new THREE.MeshStandardMaterial({ color: spec.armor, metalness: 0.65, roughness: 0.4 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x2a1f1a, roughness: 0.9 });
  const cast = (m) => { m.castShadow = true; return m; };

  for (const x of [-0.13, 0.13]) {
    const leg = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.92), cloth));
    leg.position.set(x, 0.46, 0);
    const boot = cast(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.26), armor));
    boot.position.set(x, 0.06, 0.04);
    root.add(leg, boot);
  }
  const torso = new THREE.Group();
  torso.position.y = 0.95;
  root.add(torso);
  const chest = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.42, 6, 14), armor));
  chest.position.y = 0.38;
  chest.scale.z = 0.8;
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.08, 16), cloth);
  belt.position.y = 0.08;
  const head = cast(new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 16), armor));
  head.position.y = 0.92;
  const crest = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.3), new THREE.MeshStandardMaterial({ color: 0x7a1f1a }));
  crest.position.set(0, 1.08, -0.02);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: 0x050505 }));
  visor.position.set(0, 0.93, 0.14);
  const eyeMat = new THREE.MeshBasicMaterial({ color: spec.eyes });
  for (const x of [-0.05, 0.05]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.015, 0.01), eyeMat);
    eye.position.set(x, 0.93, 0.17);
    torso.add(eye);
  }
  for (const x of [-0.3, 0.3]) {
    const pauldron = cast(new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), armor));
    pauldron.position.set(x, 0.62, 0);
    pauldron.scale.y = 0.75;
    torso.add(pauldron);
  }
  const offArm = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.6), armor));
  offArm.position.set(-0.33, 0.3, 0.05);
  offArm.rotation.z = -0.15;
  torso.add(chest, belt, head, crest, visor, offArm);

  const swordArm = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 1, 10), armor));
  root.add(swordArm);

  const sword = new THREE.Group();
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xc4ccd6, metalness: 0.9, roughness: 0.25, emissive: 0xff2a1a, emissiveIntensity: 0 });
  const blade = cast(new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.0, 0.012), bladeMat));
  blade.position.y = 0.6;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.035, 0.04), new THREE.MeshStandardMaterial({ color: 0x6b5330, metalness: 0.7 }));
  guard.position.y = 0.09;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.024, 0.18), cloth);
  sword.add(blade, guard, grip);
  root.add(sword);

  return {
    root, torso, sword, swordArm, bladeMat,
    shoulder: V(0.27, 0.6, 0.05), // torso-local
    hilt: POSES.idle.hilt.clone(), dir: POSES.idle.dir.clone(),
    twist: 0, lean: 0, flinch: 0, fall: 0,
  };
}

// ---------------------------------------------------------------- Game state

const pad = new Mocon();
const game = {
  input: null, // 'phone' | 'mouse'
  mode: 'menu', // menu | calibrate | intro | fight | between | paused | over | victory
  resumeMode: null,
  round: 0,
  playerHp: 100,
  fury: 0,
  furyActive: 0,
  hurtFlash: 0,
  shake: 0,
  hintTimer: 0,
  offBalanceUntil: 0,
  toldAboutReads: false,
};
let foe = null; // { spec, model, hp, state, t, dur, zone, guard, comboLeft, feinted, ... }

function setHint(text, seconds = 0) {
  ui.hint.textContent = text;
  game.hintTimer = seconds;
}

function spawnFoe(index) {
  if (foe) {
    scene.remove(foe.model.root);
    foe.model.root.traverse((o) => { o.geometry?.dispose(); });
  }
  const base = OPPONENTS[index];
  const spec = {
    ...base,
    hp: Math.round(base.hp * D.hp),
    damage: Math.round(base.damage * D.damage),
    windup: base.windup.map((s) => Math.max(MIN_WINDUP, s * D.windup)),
    guardTime: base.guardTime.map((s) => s * D.windup),
    combo: base.combo + D.combo,
    feint: Math.min(0.75, base.feint + D.feint),
  };
  const model = buildFighter(spec);
  model.root.position.set(0, 0, -7);
  scene.add(model.root);
  foe = { spec, model, hp: spec.hp, state: 'intro', t: 0, dur: 1.6, zone: 'left', guard: 'left', comboLeft: 0, feinted: false, readChecked: false, lastZone: null, adaptTo: null, adaptIn: 0, hitTimes: [] };
  ui.enemyName.textContent = spec.name;
  game.mode = 'intro';
  banner(`Round ${index + 1}`, 1.6);
  setHint(index === 0 ? 'Swing where their sword isn\'t. When a side glows red, point your sword there to parry.' : spec.name + ' approaches.', 6);
}

const rand = ([a, b]) => a + Math.random() * (b - a);
const pick = (arr, not) => {
  const options = arr.filter((z) => z !== not);
  return options[Math.floor(Math.random() * options.length)];
};

function setFoeState(state, dur = 0) {
  foe.state = state;
  foe.t = 0;
  foe.dur = dur;
}

function beginAttack(isCombo) {
  foe.zone = pick(ZONES, foe.lastZone);
  foe.lastZone = foe.zone;
  foe.feinted = !(Math.random() < foe.spec.feint);
  foe.readChecked = false;
  setFoeState('windup', rand(foe.spec.windup) * (isCombo ? 0.75 : 1));
}

function updateFoe(dt) {
  const f = foe;
  f.t += dt;
  switch (f.state) {
    case 'intro':
      f.model.root.position.z = THREE.MathUtils.lerp(-7, FOE_Z, Math.min(1, f.t / f.dur));
      if (f.t >= f.dur) {
        game.mode = 'fight';
        setFoeState('guard', rand(f.spec.guardTime));
      }
      break;
    case 'guard':
      if (f.adaptTo && (f.adaptIn -= dt) <= 0) { f.guard = f.adaptTo; f.adaptTo = null; }
      if (f.t >= f.dur) {
        f.comboLeft = Math.floor(Math.random() * f.spec.combo);
        beginAttack(false);
      } else if (Math.random() < dt * 0.6) {
        f.guard = pick(ZONES, f.guard);
      }
      break;
    case 'windup':
      if (!f.feinted && f.t > f.dur * 0.55) {
        f.feinted = true;
        f.zone = pick(ZONES, f.zone);
        f.lastZone = f.zone;
        f.dur += f.dur * 0.4;
      }
      // Reading you: if you're already pointing at the attack side, they go elsewhere.
      if (!f.readChecked && f.t > f.dur * 0.35) {
        f.readChecked = true;
        if (inZone(aim, f.zone) && Math.random() < D.read) {
          f.zone = pick(ZONES, f.zone);
          f.lastZone = f.zone;
          f.dur += f.dur * 0.3;
          if (!game.toldAboutReads) {
            game.toldAboutReads = true;
            setHint('They read your guard. Don\'t commit to a side until the last moment.', 5);
          }
        }
      }
      if (f.t >= f.dur) resolveStrike();
      break;
    case 'strike':
      if (f.t >= f.dur) {
        if (f.comboLeft-- > 0) beginAttack(true);
        else setFoeState('recover', 0.75);
      }
      break;
    case 'recover':
    case 'stagger':
      if (f.t >= f.dur) {
        f.guard = pick(ZONES);
        setFoeState('guard', rand(f.spec.guardTime));
      }
      break;
    case 'dead':
      if (f.t > 2.2 && game.mode === 'fight') nextRound();
      break;
  }
}

function resolveStrike() {
  const zone = foe.zone;
  setFoeState('strike', 0.22);
  if (inZone(aim, zone)) {
    // Parry
    setFoeState('stagger', D.stagger);
    foe.comboLeft = 0;
    sfx.clang();
    burst(zoneWorldPoint(zone), 60, 0xffd27a, 3.5);
    buzz(70, 255);
    addFury(34);
    banner('Parry!', 0.7);
  } else {
    game.playerHp = Math.max(0, game.playerHp - foe.spec.damage);
    game.hurtFlash = 1;
    game.shake = 0.5;
    sfx.hurt();
    buzz(280, 255);
    if (game.playerHp <= 0) lose();
  }
}

function zoneWorldPoint(zone) {
  const local = zone === 'left' ? V(-0.35, 0.05, -0.9) : zone === 'right' ? V(0.35, 0.05, -0.9) : V(0, 0.35, -0.9);
  return camera.localToWorld(local);
}

function onSlash(dir, speed) {
  if (game.mode !== 'fight' || !foe || foe.state === 'dead' || foe.state === 'intro') return;
  const now = performance.now();
  if (now < game.offBalanceUntil) return; // still recovering from a blocked slash
  const fury = game.furyActive > 0;
  // Spamming: a 3rd quick hit outside a stagger gets deflected into a fast counter.
  foe.hitTimes = foe.hitTimes.filter((t) => now - t < 1500);
  if (D.punish && !fury && foe.state !== 'stagger' && foe.hitTimes.length >= 2) {
    foe.hitTimes = [];
    sfx.clang();
    burst(foe.model.sword.localToWorld(V(0, 0.6, 0)), 40, 0xbfd4ff, 3);
    buzz(60, 200);
    popup('Deflected', foe.model.sword.localToWorld(V(0, 0.9, 0)), 'block');
    game.offBalanceUntil = now + 450;
    foe.comboLeft = 0;
    beginAttack(true);
    foe.dur = Math.max(MIN_WINDUP, foe.dur * 0.8);
    return;
  }
  const blocked = !fury && foe.state === 'guard' && GUARD_BLOCKS[foe.guard] === dir;
  const m = foe.model;
  if (blocked) {
    sfx.clang();
    burst(m.sword.localToWorld(V(0, 0.6, 0)), 30, 0xbfd4ff, 2.5);
    buzz(40, 160);
    popup('Blocked', m.sword.localToWorld(V(0, 0.9, 0)), 'block');
    // A blocked attack invites a quick counter and, on harder levels, leaves you off balance.
    if (Math.random() < (D.punish ? 0.85 : 0.5)) foe.dur = Math.min(foe.dur, foe.t + 0.2);
    if (D.punish) game.offBalanceUntil = now + 500;
    return;
  }
  const staggered = foe.state === 'stagger';
  let dmg = 6 + Math.min(speed, 20) * 0.55;
  if (dir === 'up') dmg *= 0.7;
  if (staggered) dmg *= 2;
  if (fury) dmg *= 3;
  dmg = Math.round(dmg);
  if (!staggered) foe.hitTimes.push(now);
  foe.hp = Math.max(0, foe.hp - dmg);
  m.flinch = (dir === 'R2L' ? -1 : 1) * 0.35;
  sfx.hit();
  const chest = m.torso.localToWorld(V(0, 0.4, 0.2));
  burst(chest, fury ? 50 : 24, fury ? 0xffe28a : 0xff7a3a, 2.5);
  popup(String(dmg), chest, staggered || fury ? 'crit' : '');
  buzz(30, 200);
  addFury(5);
  if (foe.hp <= 0) {
    setFoeState('dead');
    banner(`${foe.spec.name} falls`, 2);
    sfx.clang();
    return;
  }
  // Clever opponents learn where you hit them.
  if (foe.state === 'guard' && Math.random() < foe.spec.adapt) {
    foe.adaptTo = dir === 'L2R' ? 'left' : dir === 'R2L' ? 'right' : dir === 'down' ? 'high' : foe.guard;
    foe.adaptIn = 0.25;
  }
}

function addFury(n) {
  if (game.furyActive > 0) return;
  game.fury = Math.min(100, game.fury + n);
}

function activateFury() {
  if (game.mode !== 'fight' || game.fury < 100 || game.furyActive > 0) return;
  game.fury = 0;
  game.furyActive = FURY_TIME;
  sfx.fury();
  buzz(150, 255);
  banner('Fury!', 0.8);
}

function nextRound() {
  if (game.round + 1 >= D.opponents) return win();
  game.mode = 'between';
  game.playerHp = Math.min(100, game.playerHp + D.heal);
  setHint(`You catch your breath. +${D.heal} health.`, 2.5);
  setTimeout(() => {
    if (game.mode !== 'between') return;
    game.round++;
    spawnFoe(game.round);
  }, 2600);
}

function lose() {
  game.mode = 'over';
  $('endTitle').textContent = 'You have fallen';
  $('endText').textContent = `${foe.spec.name} wins this time. Round ${game.round + 1} of ${D.opponents} on ${D.label}.`;
  setTimeout(() => show('end', true), 900);
}

function win() {
  game.mode = 'victory';
  $('endTitle').textContent = D === DIFFICULTIES.legend ? 'Legend of the arena' : 'Champion of the arena';
  $('endText').textContent = `All ${D.opponents} opponents defeated on ${D.label} with ${game.playerHp} health to spare.`
    + (D === DIFFICULTIES.legend ? '' : ' Try a harder difficulty.');
  show('end', true);
}

function startGame() {
  show('end', false);
  show('menu', false);
  game.round = 0;
  game.playerHp = 100;
  game.fury = 0;
  game.furyActive = 0;
  game.offBalanceUntil = 0;
  spawnFoe(0);
}

function pauseGame(reason) {
  if (!['fight', 'intro', 'between', 'calibrate'].includes(game.mode)) return;
  game.resumeMode = game.mode;
  game.mode = 'paused';
  const disconnected = reason === 'disconnect';
  $('pauseTitle').textContent = disconnected ? 'Phone disconnected' : 'Paused';
  $('pauseText').textContent = disconnected
    ? 'Make sure the Mocon app is open on your phone, then reconnect.'
    : 'Press Pause on your phone, Esc, or the button below to continue.';
  $('btnResume').style.display = disconnected ? 'none' : '';
  $('btnReconnect').style.display = disconnected ? '' : 'none';
  $('btnToMouse').style.display = disconnected ? '' : 'none';
  show('pause', true);
}

function resumeGame() {
  if (game.mode !== 'paused') return;
  game.mode = game.resumeMode;
  show('pause', false);
}

// ---------------------------------------------------------------- Aim and slash detection

// aim.yaw > 0 = pointing right, aim.pitch > 0 = pointing up. Raw (unsmoothed) values drive gameplay.
const aim = { yaw: 0, pitch: 0 };
const swordTarget = new THREE.Quaternion();
const FORWARD = V(0, 0, -1);
const tmpV = new THREE.Vector3();

function aimFromQuaternion(q, out) {
  tmpV.copy(FORWARD).applyQuaternion(q);
  out.yaw = Math.atan2(tmpV.x, -tmpV.z);
  out.pitch = Math.asin(THREE.MathUtils.clamp(tmpV.y, -1, 1));
  return out;
}

const slash = { active: false, startYaw: 0, startPitch: 0, startT: 0, peak: 0, speed: 0, cooldown: 0, prev: null };
function feedSlash(yaw, pitch, t) {
  const cfg = SLASH[game.input] ?? SLASH.mouse;
  const prev = slash.prev;
  slash.prev = { yaw, pitch, t };
  if (!prev) return;
  const dt = t - prev.t;
  if (dt <= 0.001 || dt > 0.2) return;
  const raw = Math.hypot(yaw - prev.yaw, pitch - prev.pitch) / dt;
  slash.speed = slash.speed * 0.4 + raw * 0.6;
  if (!slash.active && slash.speed > cfg.start && t > slash.cooldown) {
    slash.active = true;
    slash.startYaw = prev.yaw;
    slash.startPitch = prev.pitch;
    slash.startT = t;
    slash.peak = slash.speed;
    sfx.swoosh(slash.speed / 8);
  }
  if (!slash.active) return;
  slash.peak = Math.max(slash.peak, slash.speed);
  if (slash.speed < cfg.end || t - slash.startT > 0.45) {
    slash.active = false;
    slash.cooldown = t + 0.15;
    const dy = yaw - slash.startYaw;
    const dp = pitch - slash.startPitch;
    if (Math.hypot(dy, dp) < cfg.minAmp) return;
    const dir = Math.abs(dy) > Math.abs(dp) ? (dy > 0 ? 'L2R' : 'R2L') : dp < 0 ? 'down' : 'up';
    // Mouse speeds are lower than real swings; scale so damage is comparable.
    onSlash(dir, game.input === 'mouse' ? slash.peak * 2.2 : slash.peak);
  }
}

// Phone: sample on every motion packet using the phone's own clock, which is immune to Bluetooth bunching.
let phoneClock = null;
const phoneAim = { yaw: 0, pitch: 0 };
const phoneQ = new THREE.Quaternion();
pad.addEventListener('motion', (e) => {
  if (game.input !== 'phone') return;
  const { quaternion, timeMs } = e.detail;
  const q = Mocon.toThree(quaternion);
  phoneQ.set(q.x, q.y, q.z, q.w);
  aimFromQuaternion(phoneQ, phoneAim);
  if (phoneClock === null) phoneClock = { last: timeMs, t: 0 };
  phoneClock.t += ((timeMs - phoneClock.last) & 0xffff) / 1000;
  phoneClock.last = timeMs;
  if (game.mode === 'fight') feedSlash(phoneAim.yaw, phoneAim.pitch, phoneClock.t);
});

// Mouse: aim follows the pointer.
const mouse = { x: 0.5, y: 0.5 };
addEventListener('pointermove', (e) => {
  mouse.x = e.clientX / innerWidth;
  mouse.y = e.clientY / innerHeight;
});
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

function updateAim(dt, now) {
  if (game.input === 'phone') {
    aim.yaw = phoneAim.yaw;
    aim.pitch = phoneAim.pitch;
    swordTarget.copy(phoneQ);
  } else {
    aim.yaw = (mouse.x - 0.5) * 1.8;
    aim.pitch = (0.5 - mouse.y) * 1.4 + 0.05;
    euler.set(aim.pitch, -aim.yaw, -aim.yaw * 0.7);
    swordTarget.setFromEuler(euler);
    if (game.mode === 'fight') feedSlash(aim.yaw, aim.pitch, now / 1000);
  }
  swordRig.quaternion.slerp(swordTarget, 1 - Math.exp(-dt * (game.input === 'phone' ? 35 : 22)));
}

// ---------------------------------------------------------------- Phone wiring

function buzz(ms, amp) {
  if (game.input === 'phone' && pad.connected) pad.vibrate(ms, amp).catch(() => {});
}

pad.addEventListener('buttondown', (e) => {
  if (e.detail.index === 0) {
    if (game.mode === 'calibrate') {
      pad.recenter().catch(() => {});
      startGame();
    } else activateFury();
  }
  if (e.detail.index === 1) game.mode === 'paused' ? resumeGame() : pauseGame();
});
pad.addEventListener('recenter', () => {
  if (game.mode === 'calibrate') setHint('Centered. Press Fury on your phone to begin.');
});
pad.addEventListener('disconnect', () => {
  ui.phoneBadge.textContent = '';
  if (game.input === 'phone') pauseGame('disconnect');
});

async function setupPhoneLayout() {
  await pad.setLayout({ title: 'Sword Duel', buttons: ['Fury', 'Pause'] });
  await pad.setRate(60);
  ui.phoneBadge.textContent = `📱 ${pad.info?.model ?? 'Phone'}`;
}

$('btnPhone').onclick = async () => {
  sfx.ensure();
  $('menuStatus').textContent = 'Choose your phone in the browser\'s list…';
  try {
    await pad.connect();
    await setupPhoneLayout();
    game.input = 'phone';
    show('menu', false);
    game.mode = 'calibrate';
    banner('Ready your blade', 99);
    setHint('Hold your phone like a sword hilt: top pointing at the screen, display facing up. Then press Fury on your phone.');
  } catch (err) {
    $('menuStatus').textContent = err.name === 'NotFoundError' ? 'No phone chosen.' : err.message;
  }
};
$('btnMouse').onclick = () => {
  sfx.ensure();
  game.input = 'mouse';
  startGame();
};
$('btnAgain').onclick = () => {
  sfx.ensure();
  if (game.input === 'phone' && pad.connected) pad.recenter().catch(() => {});
  startGame();
};
$('btnResume').onclick = resumeGame;
$('btnReconnect').onclick = async () => {
  try {
    await pad.reconnect();
    await setupPhoneLayout();
    resumeGame();
  } catch (err) {
    $('pauseText').textContent = `Couldn't reconnect: ${err.message}`;
  }
};
$('btnToMouse').onclick = () => {
  game.input = 'mouse';
  resumeGame();
};
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); activateFury(); }
  if (e.code === 'Escape') game.mode === 'paused' ? resumeGame() : pauseGame();
  if (e.code === 'KeyR' && pad.connected) pad.recenter().catch(() => {});
});
function setDifficulty(key) {
  if (!DIFFICULTIES[key]) return;
  D = DIFFICULTIES[key];
  document.querySelectorAll('[data-difficulty]').forEach((b) => b.classList.toggle('on', b.dataset.difficulty === key));
  try { localStorage.setItem('swordDuel.difficulty', key); } catch {}
}
document.querySelectorAll('[data-difficulty]').forEach((b) => (b.onclick = () => setDifficulty(b.dataset.difficulty)));
try { setDifficulty(localStorage.getItem('swordDuel.difficulty') || 'knight'); } catch { setDifficulty('knight'); }

if (!Mocon.isSupported()) {
  $('btnPhone').disabled = true;
  $('menuStatus').textContent = 'This browser can\'t use Bluetooth. Use Chrome or Edge for phone control, or play with the mouse.';
}

// ---------------------------------------------------------------- Per-frame animation

const lerpK = (k, dt) => 1 - Math.exp(-k * dt);
const tmpA = new THREE.Vector3();

function animateFoe(dt, now) {
  if (!foe) return;
  const m = foe.model;
  const s = foe.state;
  let pose = POSES.idle;
  let speed = 9;
  if (s === 'guard') pose = POSES['guard_' + foe.guard];
  else if (s === 'windup') { pose = POSES['windup_' + foe.zone]; speed = foe.feinted && foe.t > foe.dur * 0.4 ? 14 : 7; }
  else if (s === 'strike') { pose = POSES['strike_' + foe.zone]; speed = 30; }
  else if (s === 'stagger') { pose = POSES.stagger; speed = 14; }
  else if (s === 'dead') pose = POSES.dead;

  const k = lerpK(speed, dt);
  m.hilt.lerp(pose.hilt, k);
  m.dir.lerp(pose.dir, k).normalize();
  m.twist += (pose.twist - m.twist) * k;
  m.lean += (pose.lean - m.lean) * k;
  m.flinch *= Math.exp(-dt * 8);
  m.torso.rotation.set(m.lean, m.twist, m.flinch);
  if (s !== 'dead' && s !== 'intro') m.root.position.x = Math.sin(now / 900) * 0.12;
  if (s === 'dead') {
    m.fall = Math.min(1, m.fall + dt * 1.6);
    m.root.rotation.x = -1.45 * m.fall * m.fall;
  }

  m.sword.position.copy(m.hilt);
  m.sword.quaternion.setFromUnitVectors(UP, m.dir);

  // Sword arm: cylinder from the (moving) shoulder to the hilt.
  m.root.updateMatrixWorld(true);
  const shoulder = m.root.worldToLocal(m.torso.localToWorld(tmpA.copy(m.shoulder)));
  const span = m.hilt.clone().sub(shoulder);
  m.swordArm.position.copy(shoulder).addScaledVector(span, 0.5);
  m.swordArm.scale.set(1, span.length(), 1);
  m.swordArm.quaternion.setFromUnitVectors(UP, span.normalize());

  const glow = s === 'windup' ? Math.min(1, foe.t / foe.dur) : s === 'strike' ? 1 : 0;
  m.bladeMat.emissiveIntensity = glow * 1.4;
}

function updateTrail(dt) {
  swordRig.updateMatrixWorld(true);
  trailHist.unshift([swordRig.localToWorld(BASE_LOCAL.clone()), swordRig.localToWorld(TIP_LOCAL.clone())]);
  if (trailHist.length > TRAIL_N) trailHist.pop();
  const target = slash.active || slash.speed > (game.input === 'phone' ? 4 : 2.5) ? 1 : 0;
  trailStrength += (target - trailStrength) * lerpK(target ? 25 : 6, dt);
  const fury = game.furyActive > 0;
  for (let i = 0; i < TRAIL_N; i++) {
    const [b, t] = trailHist[Math.min(i, trailHist.length - 1)];
    trailPos.set([b.x, b.y, b.z, t.x, t.y, t.z], i * 6);
    const a = trailStrength * (1 - i / TRAIL_N) * 0.6;
    const [r, g, bl] = fury ? [1, 0.8, 0.35] : [0.75, 0.85, 1];
    trailCol.set([r * a * 0.2, g * a * 0.2, bl * a * 0.2, r * a, g * a, bl * a], i * 6);
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.attributes.color.needsUpdate = true;
}

const projV = new THREE.Vector3();
function toScreen(world) {
  projV.copy(world).project(camera);
  return { x: (projV.x * 0.5 + 0.5) * innerWidth, y: (-projV.y * 0.5 + 0.5) * innerHeight };
}

function popup(text, world, cls) {
  const p = toScreen(world);
  const el = document.createElement('div');
  el.className = 'pop ' + (cls || '');
  el.textContent = text;
  el.style.left = p.x + 'px';
  el.style.top = p.y + 'px';
  $('hud').appendChild(el);
  setTimeout(() => el.remove(), 900);
}

function updateHud(dt) {
  ui.playerFill.style.width = game.playerHp + '%';
  ui.enemyFill.style.width = foe ? (100 * foe.hp) / foe.spec.hp + '%' : '0%';
  ui.furyFill.style.width = (game.furyActive > 0 ? (100 * game.furyActive) / FURY_TIME : game.fury) + '%';
  ui.furyWrap.classList.toggle('ready', game.fury >= 100 && game.furyActive <= 0);
  ui.furyWrap.classList.toggle('active', game.furyActive > 0);
  ui.furyWrap.querySelector('.label').textContent =
    game.furyActive > 0 ? 'Fury!' : game.fury >= 100 ? (game.input === 'phone' ? 'Fury ready: press Fury' : 'Fury ready: press Space') : 'Fury';

  for (const z of ZONES) {
    let o = 0;
    if (foe && game.mode === 'fight' && foe.zone === z) {
      if (foe.state === 'windup') o = 0.2 + 0.8 * Math.min(1, foe.t / foe.dur);
      else if (foe.state === 'strike') o = 1 - foe.t / foe.dur;
    }
    ui.zones[z].style.opacity = o;
  }

  // Aim marker: where the blade points, 3 m out.
  const aiming = ['fight', 'intro', 'calibrate'].includes(game.mode);
  ui.aim.style.display = aiming ? '' : 'none';
  if (aiming) {
    const p = toScreen(swordRig.localToWorld(V(0, 0, -3.2)));
    ui.aim.style.left = p.x + 'px';
    ui.aim.style.top = p.y + 'px';
    ui.aim.classList.toggle('inzone', ZONES.some((z) => inZone(aim, z)));
  }

  game.hurtFlash = Math.max(0, game.hurtFlash - dt * 2.2);
  ui.flash.style.opacity = game.hurtFlash;

  if (bannerTimer > 0 && (bannerTimer -= dt) <= 0) ui.banner.classList.remove('show');
  if (game.hintTimer > 0 && (game.hintTimer -= dt) <= 0) ui.hint.textContent = '';
}

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  updateAim(dt, now);
  if (foe && ['fight', 'intro'].includes(game.mode)) updateFoe(dt);
  if (game.mode === 'fight' && game.furyActive > 0) game.furyActive = Math.max(0, game.furyActive - dt);
  steel.emissive.setHex(game.furyActive > 0 ? 0x8a5a10 : 0x000000);
  if (game.mode !== 'paused') {
    animateFoe(dt, now);
    updateSparks(dt);
  }
  updateTrail(dt);
  updateHud(dt);

  for (const t of torches) {
    const f = 0.85 + 0.15 * Math.sin(now / 90 + t.seed) * Math.sin(now / 37 + t.seed * 2);
    t.light.intensity = 14 * f;
    t.flame.scale.setScalar(0.9 + 0.2 * f);
  }
  game.shake = Math.max(0, game.shake - dt * 1.8);
  camera.position.copy(cameraBase).add(V((Math.random() - 0.5) * game.shake * 0.08, (Math.random() - 0.5) * game.shake * 0.08, 0));

  renderer.render(scene, camera);
});

// Idle opponent behind the menu so the arena isn't empty.
spawnFoe(0);
game.mode = 'menu';
foe.model.root.position.z = FOE_Z;
setFoeState('guard', 999);
ui.banner.classList.remove('show');
setHint('');

// For automated checks only.
window.__swordDuel = { get D() { return D; }, setDifficulty, game, get foe() { return foe; }, aim, onSlash, activateFury };
