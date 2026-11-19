// Mewka 3D: the detailed seagull model (assets/seagull.glb, glTF 2.0, ~69k triangles, flying pose) rendered with three.js.
// Loaded ONLY through mewka3d-gate.ts (dynamic import, after the bird is visible and the browser is idle).
//
// - The GLB is fetched once; every bird gets a clone of its scene (geometry and materials are shared).
// - The model has no skeleton, only two animated wing pivots. At load time the head parts are re-parented onto a
//   neck pivot, the lower bill onto a jaw hinge and the tail feathers onto a tail pivot, so the states can move them.
// - One shared WebGLRenderer (one WebGL context per page). Each bird owns a small 2D canvas; the shared renderer
//   draws the bird into a corner of its own buffer and the pixels are copied over.
// - Animation = per-channel springs driven by key poses, plus a hovering glide with flap bursts. The glide sleeps
//   after 15 s without user input and the rAF loop stops once everything has settled.
import {
  ACESFilmicToneMapping, Group, HemisphereLight, DirectionalLight, Mesh, MeshStandardMaterial, OctahedronGeometry,
  PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, Vector2, WebGLRenderer,
  type Material, type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { MewkaState } from './mewka';
import type { Outfit } from './outfit';
import MODEL_URL from './assets/seagull.glb?url';

export interface Bird3D {
  setState(s: MewkaState): void;
  /** pointer target relative to the bird, -1..1 (x right, y down); on = pointer is near */
  look(x: number, y: number, on: boolean): void;
  /** screen direction to the pointing target in radians (0 = right, +PI/2 = up); null = default */
  point(rad: number | null): void;
  /** outfits were modelled for the old procedural gull; the GLB bird ignores them */
  setOutfit(outfit: Outfit | null): void;
  destroy(): void;
}

// ───────────────────────────── model ─────────────────────────────
// Child order of the "Seagull" root in the GLB (= glTF node index - 1 for the first 25 nodes).
const IDX = {
  head: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15], // head, bills, nostrils, red spots, eye rings, eyes, glints
  jaw: [4, 6, 8], // lower bill + red spots
  tail: [17, 18, 19, 20, 21, 22, 23],
  wingL: 24, wingR: 25,
};
const NECK: [number, number, number] = [0, 0.17, 0.27];
const HINGE: [number, number, number] = [0, 0.175, 0.47];
const TAIL: [number, number, number] = [0, -0.015, -0.24];

let modelP: Promise<Object3D> | null = null;
const loadModel = () => (modelP ??= new GLTFLoader().loadAsync(MODEL_URL).then((g) => {
  const root = g.scene.children[0] ?? g.scene;
  root.traverse((o) => {
    const m = (o as Mesh).material as MeshStandardMaterial | undefined;
    if (m && 'envMapIntensity' in m) m.envMapIntensity = 0.3;
  });
  return g.scene;
}));

interface Rig { root: Group; neck: Group; jaw: Group; tail: Group; wl: Object3D; wr: Object3D; dots: Mesh[] }

function rig(src: Object3D): Rig {
  const scene = src.clone(true);
  const bird = scene.children[0];
  const kids = [...bird.children];
  const root = new Group();
  root.add(scene);
  const pivot = (p: [number, number, number], parts: number[]) => {
    const g = new Group();
    g.position.set(...p);
    bird.add(g);
    bird.updateMatrixWorld(true);
    parts.forEach((i) => kids[i] && g.attach(kids[i]));
    return g;
  };
  const jaw = pivot(HINGE, IDX.jaw);
  const neck = pivot(NECK, IDX.head.filter((i) => !IDX.jaw.includes(i)));
  neck.attach(jaw);
  const tail = pivot(TAIL, IDX.tail);
  const wl = kids[IDX.wingL], wr = kids[IDX.wingR];
  wl.rotation.order = wr.rotation.order = 'YZX';
  // thinking dots: three small gold facets above the head
  const dotMat = new MeshStandardMaterial({ color: '#d9b25a', metalness: 0.7, roughness: 0.3 });
  const dotGeo = new OctahedronGeometry(0.035, 0);
  const dots = [0, 1, 2].map((i) => {
    const d = new Mesh(dotGeo, dotMat);
    d.position.set(-0.09 + i * 0.09, 0.47 + i * 0.03, 0.36);
    d.scale.setScalar(0);
    neck.add(d);
    return d;
  });
  return { root, neck, jaw, tail, wl, wr, dots };
}

// ───────────────────────────── shared renderer ─────────────────────────────
let R: { gl: WebGLRenderer; scene: Scene; env: { dispose(): void } } | null = null;
let users = 0;
let glFailed = false;

function acquire(): boolean {
  if (R) { users++; return true; }
  if (glFailed) return false;
  try {
    const gl = new WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power', preserveDrawingBuffer: true });
    gl.toneMapping = ACESFilmicToneMapping;
    gl.toneMappingExposure = 0.85;
    gl.outputColorSpace = SRGBColorSpace;
    gl.setClearColor(0x000000, 0);
    gl.setPixelRatio(1);
    gl.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); birds.forEach((b) => b.fail()); });
    const scene = new Scene();
    const pmrem = new PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = env;
    const key = new DirectionalLight('#fff4e6', 2.2); key.position.set(-3, 5, 6);
    const rim = new DirectionalLight('#ffffff', 1.2); rim.position.set(2.5, 3.5, -5);
    const hemi = new HemisphereLight('#e4ecf7', '#6f6248', 0.7);
    scene.add(key, rim, hemi, key.target, rim.target);
    R = { gl, scene, env };
  } catch (e) { R = null; glFailed = true; if (QA) console.info('[mewka3d] WebGL2 renderer failed', e); return false; }
  users = 1;
  for (const t of WAKE) addEventListener(t, wake, { passive: true, capture: true });
  document.addEventListener('visibilitychange', onVis);
  return true;
}
function release() {
  if (!R || --users > 0) return;
  for (const t of WAKE) removeEventListener(t, wake, { capture: true });
  document.removeEventListener('visibilitychange', onVis);
  R.env.dispose();
  R.gl.dispose(); R.gl.forceContextLoss();
  R = null;
}

// ───────────────────────────── motion ─────────────────────────────
// [rest, omega, zeta]
const SPEC = {
  y: [0, 10, 0.6], pitch: [0, 8, 0.7], roll: [0, 8, 0.6], yaw: [0, 7, 0.75], sq: [1, 18, 0.45],
  hYaw: [0, 14, 0.65], hPitch: [0, 14, 0.65], hRoll: [0, 12, 0.6], jaw: [0, 45, 0.8],
  le: [0.12, 12, 0.55], re: [0.12, 12, 0.55], ls: [0, 10, 0.6], rs: [0, 10, 0.6],
  fa: [0, 7, 0.9], tail: [0, 9, 0.5], dots: [0, 14, 0.55],
} as const;
type Chan = keyof typeof SPEC;
type Pose = Partial<Record<Chan, number>>;
type Keys = [number, Partial<Record<Chan, number | null>>][];

// le / re = wing raised (rad, + = up), ls / rs = wing swept forward (rad)
const EAR: Pose = { le: 1.25, ls: 0.5, hRoll: -0.35, hYaw: -0.25, roll: 0.08 };
const POSES: Record<MewkaState, Pose> = {
  hidden: { y: -0.2, sq: 0.85, le: -0.25, re: -0.25, hPitch: 0.5 },
  peek: { hRoll: -0.25, hYaw: 0.3 },
  idle: {},
  'listen-invite': {},
  listening: EAR,
  thinking: { hPitch: -0.45, hYaw: 0.25, hRoll: 0.2, dots: 1, pitch: -0.08 },
  talking: { hYaw: 0.2 },
  pointing: {},
  unsure: { le: 0.75, re: 0.75, ls: -0.2, rs: -0.2, hRoll: 0.3, hYaw: 0.35 },
  happy: { hYaw: 0.3 },
  greet: { hYaw: 0.3 },
};
const talk = (): Keys => {
  const k: Keys = [];
  for (let i = 0; i < 6; i++) k.push([i * 180, { jaw: 0.45, hPitch: -0.06 }], [i * 180 + 90, { jaw: 0.04, hPitch: 0.02 }]);
  k.push([1100, { jaw: null, hPitch: null }]);
  return k;
};
const GESTURES: Partial<Record<MewkaState, () => Keys>> = {
  peek: () => [[0, { sq: 0.92, y: -0.08 }], [120, { sq: 1.06, y: 0.06 }], [300, { sq: null, y: null }]],
  'listen-invite': () => [[0, { sq: 0.95 }], [140, { ...EAR, sq: null }], [1350, { le: null, ls: null, hRoll: null, hYaw: null, roll: null }]],
  listening: () => [[0, { sq: 0.95 }], [140, { sq: null }]],
  thinking: () => [[0, { hPitch: 0.1 }], [160, { hPitch: -0.2 }], [320, { hPitch: null }]],
  talking: talk,
  unsure: () => [[0, { sq: 0.94 }], [120, { sq: 1.05, y: 0.06 }], [320, { sq: null, y: null }]],
  happy: () => [[0, { sq: 0.9, y: -0.06 }], [130, { sq: 1.08, y: 0.22, fa: 0.6, jaw: 0.5, hPitch: -0.35 }], [760, { fa: null, y: null, sq: null, jaw: null, hPitch: null }]],
  greet: () => [[0, { re: 0.9, sq: 0.96 }], [190, { re: 1.25, jaw: 0.4, sq: null }], [370, { re: 0.85 }], [550, { re: 1.25 }], [730, { re: 0.85, jaw: null }], [1000, { re: null }]],
  pointing: () => [[0, { sq: 0.95 }], [140, { sq: null }]],
};
const LOOK_STATES = new Set<MewkaState>(['idle', 'peek', 'talking', 'greet', 'happy', 'unsure']);
const GLIDE_STATES = new Set<MewkaState>(['idle', 'peek', 'talking', 'thinking', 'pointing', 'listening']);

const QA = /[?&]mwqa=1/.test(location.search);
const birds = new Set<Bird>();
const WAKE = ['pointermove', 'pointerdown', 'keydown', 'scroll', 'touchstart'];
const SLEEP = 15000;
const clock = () => performance.now();
let raf = 0, last = 0, lastActive = clock();
function kick() { if (!raf && !document.hidden) { last = clock(); raf = requestAnimationFrame(frame); } }
function frame(now: number) {
  raf = 0;
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  let more = false;
  for (const b of birds) if (b.step(dt, now)) more = true;
  if (more) raf = requestAnimationFrame(frame);
}
function wake() { lastActive = clock(); birds.forEach((b) => b.wake()); }
function onVis() { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else birds.forEach((b) => b.wake()); }
const reducedMotion = () =>
  document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ───────────────────────────── one bird ─────────────────────────────
const BOX = 1.75; // world units that fill the CSS box (canvas is 1.5x the box, so flapping wings fit)
const CAM_DIR: [number, number, number] = [-0.5, 0.36, 0.79]; // 3/4 front view from above-left: bird faces lower right

class Bird implements Bird3D {
  root: HTMLElement; cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  cam = new PerspectiveCamera(22, 1, 0.1, 100);
  r: Rig | null = null;
  ch = {} as Record<Chan, { x: number; v: number; t: number }>;
  state: MewkaState; keys: Keys | null = null; keysT = 0;
  lookX = 0; lookY = 0; lookOn = false; pointRad: number | null = null;
  visible = true; failed = false; shown = false; dead = false; needs = true;
  px = 0; cssSize = 0;
  phase = 0; burstUntil = 0; nextBurst = clock() + 1500;
  io: IntersectionObserver; ro: ResizeObserver;

  constructor(root: HTMLElement, state: MewkaState) {
    this.root = root; this.state = state;
    for (const k in SPEC) { const rest = SPEC[k as Chan][0]; this.ch[k as Chan] = { x: rest, v: 0, t: rest }; }
    this.cv = document.createElement('canvas');
    this.cv.className = 'mw3d';
    this.cv.setAttribute('aria-hidden', 'true');
    this.ctx = this.cv.getContext('2d')!;
    root.appendChild(this.cv);
    this.io = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; if (this.visible) this.wake(); });
    this.io.observe(root);
    this.ro = new ResizeObserver(() => { this.measure(); this.wake(); });
    this.ro.observe(root);
    this.measure();
    this.applyState(state, true);
    birds.add(this);
    loadModel().then((m) => {
      if (this.dead) return;
      this.r = rig(m);
      this.wake();
    }, (e) => { if (QA) console.info('[mewka3d] model failed', e); this.fail(); });
  }

  measure() {
    const s = this.root.clientWidth || 44;
    this.cssSize = s;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.px = Math.round(s * 1.5 * dpr);
    this.cv.width = this.cv.height = this.px;
    const view = BOX * 1.5;
    const d = view / 2 / Math.tan((22 * Math.PI) / 360);
    this.cam.position.set(CAM_DIR[0] * d, CAM_DIR[1] * d + 0.06, CAM_DIR[2] * d);
    this.cam.lookAt(0, 0.06, 0);
    this.cam.updateProjectionMatrix();
    this.needs = true;
  }

  // ── API ──
  setState(s: MewkaState) {
    if (s === this.state && !GESTURES[s]) return;
    this.state = s;
    this.applyState(s, false);
    this.wake();
  }
  look(x: number, y: number, on: boolean) {
    this.lookX = clamp(x, -1, 1); this.lookY = clamp(y, -1, 1); this.lookOn = on;
    if (LOOK_STATES.has(this.state)) { this.retarget(); this.wake(); }
  }
  point(rad: number | null) {
    this.pointRad = rad;
    if (this.state === 'pointing') { this.retarget(); this.wake(); }
  }
  setOutfit() { /* not modelled for the GLB bird */ }
  fail() { this.failed = true; this.root.dataset.mw3d = 'off'; }
  destroy() {
    this.dead = true;
    birds.delete(this);
    this.io.disconnect(); this.ro.disconnect();
    this.cv.remove();
    delete this.root.dataset.mw3d;
    release();
  }

  // ── targets ──
  applyState(s: MewkaState, instant: boolean) {
    const g = GESTURES[s];
    this.keys = g && !reducedMotion() ? g() : null;
    this.keysT = clock();
    this.retarget();
    if (instant || reducedMotion()) for (const k in this.ch) { const c = this.ch[k as Chan]; c.x = c.t; c.v = 0; }
  }
  base(): Pose {
    const p: Pose = { ...POSES[this.state] };
    if (this.state === 'pointing') {
      const rad = this.pointRad ?? -0.6; // default: down-right
      if (Math.cos(rad) >= 0) { p.re = clamp(rad, -0.8, 1.3); p.rs = -0.25; p.yaw = 0.25; p.hYaw = 0.45; }
      else { p.le = clamp(wrap(Math.PI - rad), -0.8, 1.3); p.ls = 0.25; p.yaw = -0.25; p.hYaw = -0.45; }
      p.hPitch = clamp(-Math.sin(rad) * 0.35, -0.35, 0.35);
    } else if (LOOK_STATES.has(this.state) && this.lookOn) {
      p.hYaw = this.lookX * 0.75;
      p.hPitch = this.lookY * 0.4;
      // the body follows a little too (on top of the state's own pose), so the turn reads at any size
      p.yaw = (p.yaw ?? 0) + this.lookX * 0.28;
      p.pitch = (p.pitch ?? 0) + this.lookY * 0.1;
      p.roll = -this.lookX * 0.08;
    }
    return p;
  }
  retarget(now = clock()) {
    const p = this.base();
    if (this.keys) {
      const el = now - this.keysT;
      // later keys override earlier ones; null in a later key releases the channel back to the state pose
      const held: Pose = {};
      for (const [t, k] of this.keys) {
        if (t > el) break;
        for (const c in k) { const v = k[c as Chan]; if (v === null) delete held[c as Chan]; else held[c as Chan] = v; }
      }
      Object.assign(p, held);
      if (el > this.keys[this.keys.length - 1][0]) this.keys = null;
    }
    for (const k in SPEC) {
      const c = k as Chan;
      this.ch[c].t = p[c] ?? SPEC[c][0];
    }
  }

  wake() { this.needs = true; kick(); }

  // ── frame ──
  step(dt: number, now: number): boolean {
    if (this.failed || !this.visible || !R) return false;
    const alive = !reducedMotion() && now - lastActive < SLEEP;
    this.retarget(now);
    // flap bursts while gliding
    if (alive && GLIDE_STATES.has(this.state)) {
      if (now > this.nextBurst) { this.burstUntil = now + 900; this.nextBurst = now + 3200 + Math.random() * 3000; }
      if (now < this.burstUntil && this.ch.fa.t < 0.4) this.ch.fa.t = 0.4;
    }
    if (this.state === 'happy' && this.keys) this.ch.fa.t = Math.max(this.ch.fa.t, 0.6);
    let moving = false;
    for (const k in this.ch) {
      const [, w, z] = SPEC[k as Chan];
      const c = this.ch[k as Chan];
      const a = w * w * (c.t - c.x) - 2 * z * w * c.v;
      c.v += a * dt; c.x += c.v * dt;
      if (Math.abs(c.v) > 1e-3 || Math.abs(c.t - c.x) > 1e-3) moving = true; else { c.x = c.t; c.v = 0; }
    }
    if (this.ch.fa.x > 0.005) this.phase += dt * Math.PI * 2 * 3.2;
    const hover = alive ? Math.sin(now / 350) * 0.03 : 0;
    if (this.r && (moving || alive || this.needs || this.keys)) { this.pose(hover, now); this.draw(); this.needs = false; }
    return moving || alive || !!this.keys || !this.r;
  }

  pose(hover: number, now: number) {
    const r = this.r!, c = (k: Chan) => this.ch[k].x;
    const flap = c('fa') * Math.sin(this.phase);
    r.root.position.y = c('y') + hover;
    r.root.rotation.set(c('pitch'), c('yaw'), c('roll') + flap * 0.04, 'YXZ');
    const sq = c('sq');
    r.root.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    r.neck.rotation.set(c('hPitch'), c('hYaw'), c('hRoll'), 'YXZ');
    r.jaw.rotation.x = c('jaw');
    r.tail.rotation.x = c('tail') - flap * 0.08;
    // left wing lies along -X: +Z rotation lowers it, so "up" is negative; right wing the opposite
    r.wl.rotation.set(0, c('ls'), -(c('le') + flap));
    r.wr.rotation.set(0, -c('rs'), c('re') + flap);
    const d = c('dots');
    r.dots.forEach((m, i) => m.scale.setScalar(d * (0.8 + 0.35 * Math.sin(now / 160 - i * 1.1))));
  }

  draw() {
    const gl = R!.gl, px = this.px;
    if (!px) return;
    const size = gl.getSize(V2D);
    if (size.x < px || size.y < px) gl.setSize(Math.max(size.x, px), Math.max(size.y, px), false);
    const H = Math.max(size.y, px);
    gl.setViewport(0, 0, px, px); gl.setScissor(0, 0, px, px); gl.setScissorTest(true);
    R!.scene.add(this.r!.root);
    gl.render(R!.scene, this.cam);
    R!.scene.remove(this.r!.root);
    this.ctx.clearRect(0, 0, px, px);
    this.ctx.drawImage(gl.domElement, 0, H - px, px, px, 0, 0, px, px);
    if (!this.shown) { this.shown = true; requestAnimationFrame(() => (this.root.dataset.mw3d = 'on')); }
  }
}
const V2D = new Vector2();

export function mount(root: HTMLElement, state: MewkaState): Bird3D | null {
  if (!acquire()) return null;
  return new Bird(root, state);
}

/** QA helper: dispose cached materials when the page is torn down (tests) */
export function _disposeModel() {
  modelP?.then((s) => s.traverse((o) => { const m = (o as Mesh).material as Material | undefined; m?.dispose(); (o as Mesh).geometry?.dispose(); }));
  modelP = null;
}
