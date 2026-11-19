// Mewka 3D: a procedural low-poly herring gull (Larus argentatus) rendered with three.js.
// Loaded ONLY through mewka3d-gate.ts (dynamic import, after the bird is visible and the browser is idle).
//
// - One shared WebGLRenderer (one WebGL context for the whole page). Every bird owns a small 2D canvas;
//   the shared renderer draws a bird into a corner of its own canvas and the pixels are copied over.
// - Animation = per-channel springs (interruptible, carry velocity) driven by key poses (anticipation,
//   hold, release), plus ambient life (breath, blinks, micro head turns) that sleeps when the page is idle.
// - rAF runs only while something moves; it stops when settled, off-screen, or in a hidden tab.
import {
  ACESFilmicToneMapping, BackSide, BufferGeometry, CanvasTexture, CircleGeometry, Color, DirectionalLight,
  Float32BufferAttribute, Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, OctahedronGeometry, PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace,
  Vector2, Vector3, WebGLRenderer,
  type Material, type Object3D,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { MewkaState } from './mewka';
import type { Outfit, Slot } from './outfit';
import { buildItem, cleanOutfit, disposeOutfit, SLOTS, type Anchor, type BodyRing, type Kit } from './mewka3d-outfit';

export interface Bird3D {
  setState(s: MewkaState): void;
  /** pointer target relative to the bird, -1..1 (x right, y down); on = pointer is near */
  look(x: number, y: number, on: boolean): void;
  /** screen direction to the pointing target in radians (0 = right, +PI/2 = up); null = default */
  point(rad: number | null): void;
  /** wear Gniazdo Mewki items (src/lib/game); unknown ids are ignored, null / {} = no accessories */
  setOutfit(outfit: Outfit | null): void;
  destroy(): void;
}

// ───────────────────────────── geometry ─────────────────────────────
type V2 = [number, number];
interface Ring { x: number; y: number; z?: number; pts: V2[] } // pts: offsets along (normal, Z)

/** Loft rings along a spine in the XY plane. Each ring is offset along the spine normal (dorsal = +)
 *  and Z. Indexed, so the same geometry gives flat facets (flatShading) and a smooth outline hull. */
function loft(rings: Ring[], capStart = true, capEnd = true): BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  const n = rings.length, m = rings[0].pts.length;
  for (let i = 0; i < n; i++) {
    const a = rings[Math.max(0, i - 1)], b = rings[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    // normal = perpendicular pointing "dorsal" (up for horizontal spines, backward for an upright neck)
    const nx = tx >= 0 ? -ty : ty, ny = tx >= 0 ? tx : -tx;
    const r = rings[i];
    for (const [u, w] of r.pts) pos.push(r.x + nx * u, r.y + ny * u, (r.z ?? 0) + w);
  }
  const quad = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d);
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      quad(i * m + j, i * m + j2, (i + 1) * m + j2, (i + 1) * m + j);
    }
  const cap = (ring: number, flip: boolean) => {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < m; j++) { cx += pos[(ring * m + j) * 3]; cy += pos[(ring * m + j) * 3 + 1]; cz += pos[(ring * m + j) * 3 + 2]; }
    const c = pos.length / 3; pos.push(cx / m, cy / m, cz / m);
    for (let j = 0; j < m; j++) {
      const a = ring * m + j, b = ring * m + (j + 1) % m;
      flip ? idx.push(c, b, a) : idx.push(c, a, b);
    }
  };
  if (capStart) cap(0, false);
  if (capEnd) cap(n - 1, true);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  // make faces point outward whatever the ring winding was (signed volume test)
  let vol = 0;
  for (let k = 0; k < idx.length; k += 3) {
    const [a, b, c] = [idx[k] * 3, idx[k + 1] * 3, idx[k + 2] * 3];
    vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
      - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
      + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) { for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; } g.setIndex(idx); }
  g.computeVertexNormals();
  return g;
}

/** ellipse-ish ring: m points, half-height h (dorsal), half-width w; belly fuller than back; optional twist */
const ell = (m: number, h: number, w: number, twist = 0, belly = 1, back = 1): V2[] =>
  Array.from({ length: m }, (_, j) => {
    const t = (j / m) * Math.PI * 2 + twist;
    const s = Math.sin(t);
    return [h * s * (s < 0 ? belly : back), w * Math.cos(t)] as V2;
  });
/** half ring (top or bottom half + flat chord), for the two mandibles */
const half = (m: number, h: number, w: number, top: boolean): V2[] =>
  Array.from({ length: m }, (_, j) => {
    const t = (j / (m - 1)) * Math.PI;
    return [(top ? 1 : -1) * h * Math.sin(t), w * Math.cos(t)] as V2;
  });
/** wing cross-section: leading edge on top, chord hanging down, a ridge outward (+Z) */
const blade = (c: number, t: number): V2[] => [[0, 0], [-c * 0.2, t], [-c * 0.62, t * 0.6], [-c, 0.003], [-c * 0.4, -t * 0.45]];

// ───────────────────────────── shared resources ─────────────────────────────
let R: ReturnType<typeof makeShared> | null = null;
let users = 0;

function makeShared(gl: WebGLRenderer) {
  const scene = new Scene();
  const pmrem = new PMREMGenerator(gl);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.4;

  const key = new DirectionalLight('#fff4e6', 2.1); key.position.set(-3, 5, 6);
  const rim = new DirectionalLight('#ffffff', 1.4); rim.position.set(2.5, 3.5, -5);
  const rim2 = new DirectionalLight('#ffffff', 0); rim2.position.set(-4, 1.5, -3);
  const hemi = new HemisphereLight('#e4ecf7', '#6f6248', 0.6);
  scene.add(key, rim, rim2, hemi, key.target, rim.target, rim2.target);

  // materials (shared by every bird)
  const phys = (c: string, rough: number, extra: Partial<MeshPhysicalMaterial> = {}) =>
    Object.assign(new MeshPhysicalMaterial({ color: c, roughness: rough, flatShading: false }), extra);
  const M = {
    white: phys('#f4f3ef', 0.58, { sheen: 0.6, sheenRoughness: 0.45, sheenColor: new Color('#ffffff') }),
    head: phys('#f6f5f1', 0.5, { sheen: 0.5, sheenRoughness: 0.4, sheenColor: new Color('#ffffff') }),
    mantle: phys('#aab3bd', 0.55, { flatShading: true, sheen: 0.35, sheenRoughness: 0.5, sheenColor: new Color('#e6edf5') }),
    covert: phys('#a4adb8', 0.52, { sheen: 0.3, sheenRoughness: 0.5, sheenColor: new Color('#e6edf5') }),
    orbital: new MeshStandardMaterial({ color: '#e0913a', roughness: 0.35 }),
    lidLine: new MeshStandardMaterial({ color: '#5d544c', roughness: 0.6 }),
    black: phys('#17181b', 0.42, { flatShading: true, sheen: 0.4, sheenRoughness: 0.4, sheenColor: new Color('#8a8f99') }),
    beak: phys('#e7b43c', 0.3, { flatShading: false, metalness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.25 }),
    gonys: phys('#c8332a', 0.45, { flatShading: false }),
    gold: phys('#cf9f3e', 0.34, { metalness: 0.65, clearcoat: 0.3 }),
    iris: new MeshStandardMaterial({ color: '#f2dc8c', roughness: 0.3 }),
    pupil: new MeshStandardMaterial({ color: '#0a0a0b', roughness: 0.15 }),
    ring: new MeshStandardMaterial({ color: '#1b1b1d', roughness: 0.4 }),
    glint: new MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
    dots: phys('#d9b25a', 0.28, { metalness: 0.7, clearcoat: 0.6 }),
    shadow: new MeshBasicMaterial({ color: '#000000', transparent: true, depthWrite: false, toneMapped: false }),
  };
  // fresnel rim (night: warm gold "Sun Hall" glow on the silhouette; day: a faint cool sheen)
  const rimU = { uRim: { value: new Color('#ffffff') }, uRimK: { value: 0.0 } };
  const addRim = (m: Material) => {
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, rimU);
      sh.fragmentShader = 'uniform vec3 uRim; uniform float uRimK;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n float fr = 1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);\n totalEmissiveRadiance += uRim * uRimK * pow(fr, 2.6);');
    };
  };
  [M.white, M.head, M.mantle, M.covert, M.black, M.beak, M.gold].forEach(addRim);
  // (addRim is also handed to the outfit kit for accessory materials)
  // outline = inverted hull pushed along smooth normals by a per-render pixel width.
  // Silhouette only: the hulls are drawn first without writing depth, so every part of the bird paints over
  // them and the line survives only around the whole bird (no seams between wing pieces, beak, head, legs).
  const outlineW = { value: 0.02 };
  const outline = new MeshBasicMaterial({ color: '#111111', side: BackSide, toneMapped: false, depthWrite: false });
  outline.onBeforeCompile = (s) => {
    s.uniforms.uOutline = outlineW;
    s.vertexShader = 'uniform float uOutline;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * uOutline;');
  };

  // soft contact shadow texture
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, '#fff'); gr.addColorStop(0.4, '#8c8c8c'); gr.addColorStop(1, '#000');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64); // alphaMap reads the green channel
  M.shadow.alphaMap = new CanvasTexture(c);
  M.shadow.color.set('#000');

  const G = buildGeometry();
  return { rimU, gl, scene, key, rim, rim2, hemi, M, outline, outlineW, G, env, dark: false, addRim };
}

// body rings [x, y, half-height, half-width, twist, belly, back]: tail-root → tucked belly → full, rounded breast →
// neck with a soft S-curve (bird units, feet at y = 0). belly > 1 pushes the ventral side out (breast, front of the
// neck). Shared with the outfit (cloth is lofted from the same rings, inflated).
const BODY: BodyRing[] = [
  [-1.02, 1.05, 0.045, 0.09, 0, 1, 1],
  [-0.84, 1.01, 0.13, 0.19, 1, 0.9, 1],
  [-0.6, 0.97, 0.225, 0.265, 0, 0.86, 0.96],
  [-0.32, 0.94, 0.31, 0.315, 1, 0.94, 0.93],
  [-0.02, 0.94, 0.37, 0.34, 0, 1.06, 0.9],
  [0.25, 0.99, 0.385, 0.33, 1, 1.17, 0.87],
  [0.46, 1.09, 0.34, 0.29, 0, 1.2, 0.84],
  [0.6, 1.23, 0.26, 0.235, 1, 1.12, 0.9],
  [0.655, 1.37, 0.2, 0.188, 0, 1.06, 1],
  [0.675, 1.5, 0.172, 0.164, 1, 1, 1],
  [0.725, 1.62, 0.155, 0.148, 0, 1, 1],
  [0.79, 1.72, 0.13, 0.128, 1, 1, 1],
];

function buildGeometry() {
  const B = 20; // segments around the body
  // body: tail-root → tucked belly → full, rounded breast → neck with a soft S-curve (bird units, feet at y = 0).
  // ell(..., belly, back): belly > 1 pushes the ventral side out (breast, front of the neck).
  const body = loft(BODY.map(([x, y, h, w, tw, belly, back]) => ({ x, y, pts: ell(B, h, w, tw ? Math.PI / B : 0, belly, back) })));
  // tail feather (pivot at the rump): flat, wide, square-ended; three of them fan out
  const tail = loft([
    { x: 0.04, y: 0, pts: ell(6, 0.05, 0.09) },
    { x: -0.2, y: 0.02, pts: ell(6, 0.032, 0.1) },
    { x: -0.42, y: 0.045, pts: ell(6, 0.016, 0.092) },
    { x: -0.5, y: 0.055, pts: ell(6, 0.007, 0.06) },
  ]);
  // contour feather (coverts / tertials): a flat leaf lying on the wing, tip toward -X
  const leaf = loft([
    { x: 0.0, y: 0, pts: ell(5, 0.02, 0.003) },
    { x: -0.06, y: 0, pts: ell(5, 0.05, 0.006) },
    { x: -0.18, y: -0.004, pts: ell(5, 0.058, 0.007) },
    { x: -0.27, y: -0.01, pts: ell(5, 0.042, 0.006) },
    { x: -0.31, y: -0.016, pts: ell(5, 0.012, 0.003) },
  ]);
  // head (pivot at the top of the neck); smooth shaded
  const H = 20;
  const head = loft([
    { x: -0.212, y: 0.17, pts: ell(H, 0.05, 0.042) },
    { x: -0.19, y: 0.17, pts: ell(H, 0.118, 0.098) },
    { x: -0.158, y: 0.171, pts: ell(H, 0.166, 0.139) },
    { x: -0.108, y: 0.175, pts: ell(H, 0.204, 0.169, 0, 1.03) },
    { x: -0.05, y: 0.179, pts: ell(H, 0.224, 0.185, 0, 1.05) },
    { x: 0.02, y: 0.177, pts: ell(H, 0.226, 0.186, 0, 1.06) },
    { x: 0.09, y: 0.17, pts: ell(H, 0.214, 0.18, 0, 1.08) },
    { x: 0.16, y: 0.15, pts: ell(H, 0.19, 0.16, 0, 1.09) },
    { x: 0.22, y: 0.127, pts: ell(H, 0.158, 0.136, 0, 1.1) },
    { x: 0.29, y: 0.094, pts: ell(H, 0.117, 0.106, 0, 1.04) },
    { x: 0.35, y: 0.074, pts: ell(H, 0.077, 0.072) },
    { x: 0.4, y: 0.066, pts: ell(H, 0.045, 0.04) },
  ]);
  // beak (pivot at the gape), herring-gull shape: deep, hooked tip, gonys angle on the lower mandible
  const upper = loft([
    { x: -0.05, y: 0.0, pts: half(7, 0.07, 0.06, true) },
    { x: 0.13, y: -0.004, pts: half(7, 0.057, 0.047, true) },
    { x: 0.26, y: -0.01, pts: half(7, 0.045, 0.033, true) },
    { x: 0.35, y: -0.022, pts: half(7, 0.04, 0.023, true) },
    { x: 0.41, y: -0.05, pts: half(7, 0.028, 0.013, true) },
    { x: 0.43, y: -0.085, pts: half(7, 0.006, 0.004, true) },
  ]);
  const lower = loft([
    { x: -0.05, y: 0.0, pts: half(7, 0.05, 0.056, false) },
    { x: 0.13, y: 0.0, pts: half(7, 0.044, 0.046, false) },
    { x: 0.26, y: -0.002, pts: half(7, 0.058, 0.032, false) },
    { x: 0.34, y: -0.006, pts: half(7, 0.03, 0.021, false) },
    { x: 0.385, y: -0.014, pts: half(7, 0.008, 0.008, false) },
  ]);
  // wing (folded frame: span along -X, chord hangs down -Y, outward +Z)
  const inner = loft([
    { x: 0.22, y: -0.08, pts: blade(0.06, 0.014) },
    { x: 0.1, y: -0.03, pts: blade(0.2, 0.024) },
    { x: -0.06, y: -0.005, pts: blade(0.36, 0.032) },
    { x: -0.24, y: 0, pts: blade(0.46, 0.037) },
    { x: -0.45, y: 0, pts: blade(0.5, 0.038) },
    { x: -0.8, y: 0, pts: blade(0.42, 0.034) },
    { x: -0.88, y: -0.03, pts: blade(0.3, 0.026) },
  ]);
  const mid = loft([
    { x: 0.12, y: -0.04, pts: blade(0.3, 0.018) },
    { x: 0.04, y: 0, pts: blade(0.44, 0.03) },
    { x: -0.55, y: 0, pts: blade(0.27, 0.032) },
    { x: -0.6, y: -0.02, pts: blade(0.2, 0.026) },
  ]);
  const handGrey = loft([
    { x: 0.1, y: -0.03, pts: blade(0.2, 0.028) },
    { x: 0.03, y: 0, pts: blade(0.285, 0.034) },
    { x: -0.22, y: -0.004, pts: blade(0.21, 0.03) },
  ]);
  const handBlack = loft([
    { x: -0.2, y: -0.003, pts: blade(0.218, 0.031) },
    { x: -0.48, y: -0.02, pts: blade(0.15, 0.026) },
    { x: -0.7, y: -0.065, pts: blade(0.03, 0.01) },
  ]);
  // white "mirror" spot near the black wing tip
  const mirror = loft([
    { x: 0, y: 0, pts: ell(6, 0.035, 0.012) },
    { x: -0.06, y: 0, pts: ell(6, 0.04, 0.014) },
    { x: -0.12, y: 0, pts: ell(6, 0.02, 0.01) },
  ]);
  // legs (gold): feathered thigh hidden in the belly, a visible ankle (intertarsal) joint, tarsus to the foot
  const leg = loft([
    { x: 0.05, y: 0.7, pts: ell(7, 0.05, 0.05) },
    { x: 0.045, y: 0.5, pts: ell(7, 0.04, 0.04) },
    { x: 0.038, y: 0.43, pts: ell(7, 0.046, 0.044) },
    { x: 0.02, y: 0.37, pts: ell(7, 0.037, 0.036) },
    { x: 0.004, y: 0.12, pts: ell(7, 0.033, 0.033) },
    { x: 0.0, y: 0.045, pts: ell(7, 0.04, 0.038) },
  ]);
  // webbed foot: a thin web plate + three toe ridges with a little claw droop
  const foot = loft([
    { x: -0.05, y: 0.022, pts: ell(6, 0.012, 0.03) },
    { x: 0.06, y: 0.012, pts: ell(6, 0.007, 0.07) },
    { x: 0.17, y: 0.008, pts: ell(6, 0.005, 0.1) },
    { x: 0.2, y: 0.008, pts: ell(6, 0.004, 0.075) },
  ]);
  const toe = loft([
    { x: 0, y: 0.03, pts: ell(5, 0.02, 0.019) },
    { x: 0.12, y: 0.016, pts: ell(5, 0.014, 0.013) },
    { x: 0.21, y: 0.008, pts: ell(5, 0.007, 0.007) },
  ]);
  const tip = loft([
    { x: 0, y: 0, pts: ell(6, 0.016, 0.006) },
    { x: -0.05, y: -0.004, pts: ell(6, 0.014, 0.006) },
    { x: -0.08, y: -0.01, pts: ell(6, 0.004, 0.003) },
  ]);
  const eye = new CircleGeometry(1, 24);
  const dot = new OctahedronGeometry(1, 0);
  const shadow = new CircleGeometry(1, 24);
  return { body, tail, leaf, head, upper, lower, inner, mid, handGrey, handBlack, mirror, tip, leg, foot, toe, eye, dot, shadow };
}

// ───────────────────────────── springs ─────────────────────────────
// name: [rest, omega (stiffness), zeta (damping ratio)]. Lower zeta = overshoot / follow-through.
const SPEC = {
  hop: [0, 16, 0.5], sq: [1, 24, 0.36], lean: [0, 7, 0.85], turn: [0, 8, 0.85],
  nYaw: [-0.2, 15, 0.62], nPitch: [0, 14, 0.64], nRoll: [0, 11, 0.62],
  jaw: [0, 50, 0.85], tail: [0, 9, 0.42], tailYaw: [0, 8, 0.5],
  nr: [0, 12, 0.62], ns: [0, 12, 0.7], ne: [0, 10, 0.55], nw: [0, 8.5, 0.48],
  fr: [0, 12, 0.62], fs: [0, 12, 0.7], fe: [0, 10, 0.55], fw: [0, 8.5, 0.48],
  dots: [0, 14, 0.55],
  lid: [0.08, 26, 0.8], // upper lid at rest covers the top of the iris: the calm, slightly regal gull look
} as const;
type Chan = keyof typeof SPEC;
type Pose = Partial<Record<Chan, number | null>>;

const RAD = Math.PI / 180;
// shared poses
// wing to the ear: arm up, forearm level over the back of the head, primaries upright behind the ear
const EAR: Pose = { nr: 65 * RAD, ns: 0.35, ne: 110 * RAD, nw: -95 * RAD, nYaw: -0.4, nRoll: 0.2, nPitch: 0.04, lid: 0.12 };
const POSES: Record<MewkaState, Pose> = {
  hidden: { nPitch: -0.62, nYaw: 0, sq: 0.96, lid: 0.45 },
  peek: { nPitch: 0.14, nRoll: -0.2, nYaw: -0.62, lid: 0.04 },
  idle: {},
  'listen-invite': {},
  listening: EAR,
  thinking: { nPitch: 0.42, nRoll: -0.25, nYaw: -0.25, lean: -0.05, tail: 0.1, dots: 1, lid: 0.38 },
  talking: { nYaw: -0.12, lid: 0.12 },
  pointing: { ns: 0.35, ne: 55 * RAD, nw: -10 * RAD, turn: 0.38, lid: 0.1 },
  unsure: { nr: 50 * RAD, ns: 0.7, ne: -30 * RAD, nw: -20 * RAD, fr: 45 * RAD, fs: 0.7, fe: -30 * RAD, fw: -20 * RAD, nRoll: -0.3, nYaw: -0.6, nPitch: 0.05, lid: 0.06 },
  happy: { nYaw: -0.5, lid: 0.08 },
  greet: { nYaw: -0.35, lid: 0.06 },
};
// a short gull call: head dips (anticipation), is thrown back with the beak wide open, two quick "kek"s
const call = (t0: number, yaw = -0.35): [number, Pose][] => [
  [t0, { nPitch: -0.16, jaw: 0.04 }],
  [t0 + 110, { nPitch: 0.62, nYaw: yaw, jaw: 0.58, lid: 0.02 }],
  [t0 + 230, { jaw: 0.16 }], [t0 + 300, { jaw: 0.5, nPitch: 0.55 }], [t0 + 400, { jaw: 0.05 }],
  [t0 + 470, { nPitch: null, nYaw: null, jaw: null, lid: null }],
];
// one-shot key poses: [ms, pose]. Keys accumulate; null hands a channel back to the state pose.
type Keys = [number, Pose][];
const merge = (...k: Keys[]): Keys => k.flat().sort((a, b) => a[0] - b[0]);
const GESTURES: Partial<Record<MewkaState, Keys>> = {
  peek: [[0, { sq: 0.9, nPitch: -0.1, lid: 0.3 }], [110, { sq: 1.06, hop: 0.06, lid: 0 }], [260, { sq: null, hop: null, nPitch: null }], [420, { lid: null }]],
  'listen-invite': [
    [0, { nr: -0.16, sq: 0.95, nRoll: -0.08 }],                                   // anticipation: dip
    [150, { ...EAR, sq: 1.02 }], [330, { sq: null }],                              // up to the ear
    [1500, { nr: -0.1, ne: 0.1, nw: 0.1, ns: 0.1, nRoll: 0, nYaw: -0.3 }],         // hold, then release
    [1800, { nr: null, ne: null, nw: null, ns: null, nRoll: null, nYaw: null, nPitch: null }],
  ],
  listening: [[0, { nr: -0.16, sq: 0.95 }], [150, { nr: null, sq: null }]],
  pointing: [[0, { nr: -0.22, sq: 0.95 }], [140, { nr: null, sq: null }]],
  unsure: [[0, { sq: 0.93, hop: 0 }], [120, { sq: 1.05, hop: 0.08, nr: 62 * RAD, fr: 56 * RAD }], [320, { sq: null, hop: null, nr: null, fr: null }]],
  thinking: [
    [0, { nPitch: -0.08, lid: 0.3, sq: 0.98 }],                                     // a small "hmm" dip first
    [160, { nPitch: null, lid: null, sq: null }],
    [700, { jaw: 0.12 }], [790, { jaw: 0 }], [900, { jaw: 0.12 }], [990, { jaw: null }],
  ],
  talking: [
    [0, { nPitch: -0.06, sq: 1.02 }],                                                 // inhale before speaking
    ...Array.from({ length: 13 }, (_, i): [number, Pose] =>
      i === 12 ? [1180, { jaw: null, nPitch: null, sq: null }] : [100 + i * 90, { jaw: i % 2 ? 0.03 : 0.36, nPitch: i % 2 ? 0.02 : 0.08, sq: i ? null : 1 }]),
  ],
  greet: merge([
    [0, { nr: -0.18, sq: 0.95 }],                                                   // anticipation
    [150, { nr: 112 * RAD, ns: 0.4, ne: 18 * RAD, nw: 10 * RAD, sq: null, nRoll: 0.12 }],
    [430, { nw: 48 * RAD, ne: 34 * RAD }], [650, { nw: -26 * RAD, ne: 8 * RAD }],     // wave 1
    [870, { nw: 48 * RAD, ne: 34 * RAD }], [1090, { nw: -10 * RAD, ne: 14 * RAD }],   // wave 2
    [1300, { nr: null, ns: null, ne: null, nw: null, nRoll: null }],
  ], call(120, -0.3)),
  happy: merge([
    [0, { sq: 0.86, hop: -0.02, nPitch: -0.08 }],                                      // crouch
    [120, { sq: 1.1, hop: 0.42, nr: 70 * RAD, fr: 64 * RAD, ns: 0.5, fs: 0.5, ne: -0.4, fe: -0.4, nPitch: 0.18, tail: 0.25 }],
    [260, { nr: 20 * RAD, fr: 16 * RAD, ne: 0.2, fe: 0.2 }],                               // flap
    [380, { nr: 60 * RAD, fr: 55 * RAD, ne: -0.3, fe: -0.3, hop: 0 }],
    [500, { sq: 0.9, nr: 12 * RAD, fr: 10 * RAD, tail: -0.12 }],                             // land
    [620, { sq: null, hop: null, nr: null, fr: null, ns: null, fs: null, ne: null, fe: null, nPitch: null, tail: null }],
  ], call(640, -0.45)),
};
// idle fidgets: small, bird-like life between state changes (only while awake and idle)
const FIDGETS: Keys[] = [
  [ // ruffle: puff up, wings shuffle, tail shake, settle
    [0, { sq: 1.035, ns: 0.12, fs: 0.12, nr: 0.08, fr: 0.08 }], [70, { tailYaw: 0.24 }],
    [130, { sq: 0.985, ns: 0, fs: 0, nr: -0.03, fr: -0.03, tailYaw: -0.2 }], [210, { tailYaw: 0.12 }],
    [290, { sq: null, ns: null, fs: null, nr: null, fr: null, tailYaw: null }],
  ],
  [ // wing stretch: near wing reaches back, then folds
    [0, { nr: -0.12, sq: 0.97 }], [140, { nr: 0.55, ne: -0.25, nw: -0.3, ns: 0.28, nPitch: 0.1, sq: null }],
    [720, { nr: null, ne: null, nw: null, ns: null, nPitch: null }],
  ],
  [ // curious tilt (eyes widen)
    [0, { nRoll: 0.38, nPitch: 0.12, nYaw: -0.45, lid: 0.04 }], [820, { nRoll: null, nPitch: null, nYaw: null, lid: null }],
  ],
  [ // preen: look down, swing the head back to the near wing, two nibbles, back, a quick head shake
    [0, { nPitch: -0.14, nYaw: -0.1, sq: 0.98 }],
    [170, { nYaw: -2.25, nPitch: -0.5, nRoll: 0.35, ns: 0.16, nr: 0.06, lid: 0.45, sq: null }],
    [430, { jaw: 0.2, nPitch: -0.6 }], [510, { jaw: 0 }], [590, { jaw: 0.18, nPitch: -0.5 }], [670, { jaw: 0 }],
    [820, { nYaw: -0.25, nPitch: 0.06, nRoll: 0, ns: null, nr: null, lid: null, jaw: null }],
    [980, { nRoll: 0.24 }], [1050, { nRoll: -0.2 }], [1120, { nRoll: 0.1 }],
    [1220, { nYaw: null, nPitch: null, nRoll: null }],
  ],
];
const LOOK_STATES = new Set<MewkaState>(['idle', 'peek', 'talking', 'greet', 'happy', 'unsure']);

// ───────────────────────────── scheduler ─────────────────────────────
const birds = new Set<Bird>();
// QA (?mwqa=1): a virtual clock stepped by Playwright → deterministic frame strips and pose tuning
const QA = /[?&]mwqa=1/.test(location.search);
let vnow = 1000;
const clock = () => (QA ? vnow : performance.now());
let qaPose: Pose | null = null;
if (QA) (window as any).__mw3d = {
  step(ms: number, fps = 60) { const n = Math.max(1, Math.round((ms / 1000) * fps)); for (let i = 0; i < n; i++) { vnow += 1000 / fps; frame(vnow); } },
  pose(p: Pose | null) { qaPose = p; birds.forEach((b) => b.wake()); },
  active() { lastActive = vnow; },
  /** play idle fidget i (0 ruffle, 1 wing stretch, 2 curious tilt, 3 preen) on every bird */
  fidget(i: number) { birds.forEach((b) => { b.keys = FIDGETS[i]; b.keysT = vnow; b.wake(); }); },
  /** wear an outfit on every bird, e.g. __mw3d.outfit({ head: 'top-hat' }) */
  outfit(o: Outfit | null) { birds.forEach((b) => b.setOutfit(o)); },
  /** triangles of the worn accessories of one bird, per slot (without hulls) */
  outfitTris() {
    const b = [...birds][0], out: Record<string, number> = {};
    b?.worn.forEach((w, slot) => { let n = 0; w.parts.forEach((p) => p.obj.traverse((o) => { const m = o as Mesh; if (m.isMesh && m.material !== R?.outline) n += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3; })); out[slot + ':' + w.id] = n; });
    return out;
  },
  /** dev tool: flat ID-colour renders of each rig group in the rest pose + projected pivots (to trace the SVG rig) */
  trace(px = 1536) { const b = [...birds].sort((x, y) => y.cssSize - x.cssSize)[0]; return b ? traceRig(b, px) : null; },
  /** triangles of one bird (without the outline hulls) */
  tris() {
    const b = [...birds][0]; let n = 0;
    b?.rig.traverse((o) => { const m = o as Mesh; if (m.isMesh && m.material !== R?.outline) n += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3; });
    return n;
  },
};
let raf = 0, last = 0, lastActive = clock();
const SLEEP = 15000; // ambient life sleeps after 15 s without user activity (WCAG 2.2.2, CPU)
function kick() { if (QA) return; if (!raf && !document.hidden) { last = clock(); raf = requestAnimationFrame(frame); } }
function frame(now: number) {
  raf = 0;
  if (QA) last = Math.min(last, now - 1000 / 60);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  let more = false;
  for (const b of birds) if (b.step(dt, now)) more = true;
  if (QA) { last = now; return; }
  if (more) raf = requestAnimationFrame(frame);
}
const wake = () => { const was = clock() - lastActive > SLEEP; lastActive = clock(); if (was) birds.forEach((b) => b.wake()); };
function onVis() { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else { birds.forEach((b) => b.wake()); } }

function themeSync() {
  if (!R) return;
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--c-paper').trim();
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--c-ink').trim() || '#111';
  const c = new Color(paper || '#fff');
  const dark = c.r + c.g + c.b < 1.2;
  R.dark = dark;
  // night: no gold line any more; a hairline a shade above the page (separates the bird from the dark) and a
  // soft warm Fresnel rim + back light do the "Sun Hall" glow
  R.outline.color.set(dark ? '#3b3427' : ink);
  R.rim.color.set(dark ? '#f0cf8a' : '#ffffff');
  R.rimU.uRim.value.set(dark ? '#d9ae5c' : '#dfe9f5');
  R.rimU.uRimK.value = dark ? 0.55 : 0.22;
  R.rim.intensity = dark ? 3.0 : 1.4;
  R.rim2.color.set('#e9b85a');
  R.rim2.intensity = dark ? 1.4 : 0;
  R.key.intensity = dark ? 1.8 : 2.1;
  R.M.shadow.opacity = dark ? 0.55 : 0.3;
  R.M.shadow.color.set(dark ? '#000000' : '#1a1c22');
  birds.forEach((b) => b.dirty());
}
let themeMO: MutationObserver | null = null;
const mqDark = matchMedia('(prefers-color-scheme: dark)');

let glFailed = false; // WebGL2 missing / blocklisted: decided once per page, every bird stays SVG
function acquire(): boolean {
  if (R) { users++; return true; }
  if (glFailed) return false;
  try {
    // three r186 is WebGL2-only. preserveDrawingBuffer: each bird copies its corner of the shared canvas into its own
    // 2D canvas right after rendering; keeping the buffer makes that copy safe whatever the compositor does
    // (Firefox / WebKit), at no real cost for these tiny views.
    const r = new WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power', preserveDrawingBuffer: true });
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = SRGBColorSpace;
    r.setClearColor(0x000000, 0);
    r.setPixelRatio(1);
    r.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); birds.forEach((b) => b.fail()); });
    R = makeShared(r);
  } catch (e) { R = null; glFailed = true; if (QA) console.info('[mewka3d] WebGL2 renderer failed', e); return false; }
  users = 1;
  themeMO = new MutationObserver(themeSync);
  themeMO.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  mqDark.addEventListener('change', themeSync);
  themeSync();
  for (const t of ['pointermove', 'pointerdown', 'keydown', 'scroll', 'touchstart']) addEventListener(t, wake, { passive: true, capture: true });
  document.addEventListener('visibilitychange', onVis);
  return true;
}
function release() {
  if (!R || --users > 0) return;
  for (const t of ['pointermove', 'pointerdown', 'keydown', 'scroll', 'touchstart']) removeEventListener(t, wake, { capture: true });
  document.removeEventListener('visibilitychange', onVis);
  themeMO?.disconnect(); mqDark.removeEventListener('change', themeSync);
  Object.values(R.G).forEach((g) => g.dispose());
  Object.values(R.M).forEach((m) => { (m as Material).dispose(); (m as MeshBasicMaterial).alphaMap?.dispose(); });
  R.outline.dispose(); R.env.dispose();
  disposeOutfit();
  R.gl.dispose(); R.gl.forceContextLoss();
  R = null;
}


// ───────────────────────────── one bird ─────────────────────────────
class Bird implements Bird3D {
  root: HTMLElement; cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  cam = new PerspectiveCamera(22, 1, 0.1, 100);
  rig = new Group();
  ch = {} as Record<Chan, { x: number; v: number; t: number }>;
  state: MewkaState; keys: Keys | null = null; keysT = 0;
  lookX = 0; lookY = 0; lookOn = false; pointRad: number | null = null;
  visible = true; needs = true; failed = false; shown = false;
  px = 0; lastDraw = 0; cssSize = 0; boxUnits = 3.15; isSmall = false;
  io: IntersectionObserver; ro: ResizeObserver;
  // nodes
  N!: Record<string, Object3D>; prims: Object3D[][] = []; eyes: Object3D[] = []; lids: BufferGeometry[] = []; lidC = -1; tailF: Object3D[] = []; dots: Mesh[] = []; shadow!: Mesh;
  // ambient
  amb = { yaw: 0, pitch: 0, roll: 0, lean: 0, next: 0, blinkAt: 0, blinkT: -1, double: false, t0: clock(), fidgetAt: clock() + 5000 };
  ambOff = { nYaw: 0, nPitch: 0, nRoll: 0, lean: 0, tail: 0 };
  // outfit: worn item per slot (parts live under their anchor) + running "put on" pops
  worn = new Map<Slot, { id: string; parts: { at: Anchor; obj: Object3D }[] }>();
  pops: { obj: Object3D; t0: number }[] = [];
  outfitWanted: Partial<Record<Slot, string>> = {};

  constructor(root: HTMLElement, state: MewkaState) {
    this.root = root; this.state = state;
    for (const k in SPEC) { const r = SPEC[k as Chan][0]; this.ch[k as Chan] = { x: r, v: 0, t: r }; }
    this.cv = document.createElement('canvas');
    this.cv.className = 'mw3d';
    this.cv.setAttribute('aria-hidden', 'true');
    this.ctx = this.cv.getContext('2d')!;
    root.appendChild(this.cv);
    this.build();
    this.io = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; if (this.visible) this.wake(); });
    this.io.observe(root);
    this.ro = new ResizeObserver(() => { this.measure(); this.dirty(); });
    this.ro.observe(root);
    this.measure();
    this.amb.next = clock() + 900; this.amb.blinkAt = clock() + 1600;
    birds.add(this);
    this.wake();
  }

  measure() {
    const s = this.root.clientWidth || 44;
    this.cssSize = s;
    this.isSmall = s < 60;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.px = Math.round(s * 1.5 * dpr);
    this.cv.width = this.cv.height = this.px;
    // camera: box (1x) holds the bird with the feet on the bottom edge; canvas is 1.5x box
    const fov = 22 * RAD, view = this.boxUnits * 1.5;
    const d = view / 2 / Math.tan(fov / 2);
    const cx = 0.02, cy = this.boxUnits / 2 - 0.06;
    this.cam.fov = 22; this.cam.aspect = 1;
    this.cam.position.set(cx, cy + d * 0.17, d);
    this.cam.lookAt(cx, cy, 0);
    this.cam.updateProjectionMatrix();
    // eye readability at small sizes: bigger, darker eye
    const k = this.isSmall ? 1.45 : 1;
    this.eyes.forEach((e) => e.scale.setScalar(k));
    this.N && (this.N.irisN.visible = this.N.irisF.visible = this.N.orbN.visible = this.N.orbF.visible = !this.isSmall);
    // the far eye peeks over the crown in 3/4 view; at small sizes it reads as a stray dot, so only the near eye
    if (this.eyes[1]) this.eyes[1].visible = !this.isSmall;
    this.lidC = -1;
  }

  build() {
    const { G, M, outline } = R!;
    const mesh = (g: BufferGeometry, m: Material, hull = true) => {
      const o = new Mesh(g, m);
      if (hull) { const h = new Mesh(g, outline); h.renderOrder = -2; o.add(h); }
      return o;
    };
    const grp = (x = 0, y = 0, z = 0) => { const g = new Group(); g.position.set(x, y, z); return g; };
    const rig = this.rig;
    rig.rotation.order = 'YXZ';
    // the body leans up at the front (alert gull stance), pivoting over the feet
    const hip = grp(0.05, 0.62); rig.add(hip); hip.rotation.z = 0.13;
    const body = grp(-0.05, -0.62); hip.add(body);
    // breathing scales the chest from a pivot high on the back: breast and belly swell, the back line stays put
    const chest = grp(-0.25, 1.3); body.add(chest);
    const bodyMesh = mesh(G.body, M.white); bodyMesh.position.set(0.25, -1.3, 0); chest.add(bodyMesh);
    // outfit anchor in body coordinates that breathes with the chest (neck + body accessories)
    const torso = grp(0.25, -1.3); chest.add(torso);
    // tail: three white feathers that fan out when it lifts
    const tail = grp(-0.92, 1.0, 0); body.add(tail);
    const tailF: Object3D[] = [];
    for (const [z, yaw, s] of [[0.055, 0.14, 0.94], [-0.055, -0.14, 0.94], [0, 0, 1]] as const) {
      const f = mesh(G.tail, M.white); f.position.set(0, z === 0 ? 0.012 : 0, z); f.rotation.y = yaw; f.scale.set(s, 1, 1);
      f.userData.yaw = yaw; tail.add(f); tailF.push(f);
    }
    // legs: tarsus with an ankle joint, webbed foot with three toes
    const legs = grp(); rig.add(legs);
    for (const z of [0.1, -0.1]) {
      const lx = z > 0 ? 0.13 : -0.1;
      const l = mesh(G.leg, M.gold); l.position.set(lx, 0, z); legs.add(l);
      const f = grp(lx, 0, z); f.rotation.y = z > 0 ? -0.2 : 0.25; legs.add(f);
      f.add(mesh(G.foot, M.gold));
      for (const a of [-0.42, 0, 0.42]) { const t = mesh(G.toe, M.gold); t.rotation.y = a; t.scale.set(a ? 1.15 : 1.3, 1, 1.15); f.add(t); }
      f.scale.set(1.2, 1, 1.25);
    }
    // neck + head
    const neck = grp(0.78, 1.55, 0); body.add(neck);
    neck.rotation.order = 'YZX';
    neck.scale.setScalar(1.15);
    const head = mesh(G.head, M.head); neck.add(head);
    const beak = grp(0.33, 0.075, 0); neck.add(beak);
    beak.add(mesh(G.upper, M.beak));
    const jaw = grp(0, -0.002, 0); beak.add(jaw);
    jaw.add(mesh(G.lower, M.beak));
    for (const z of [0.024, -0.024]) {
      const g = new Mesh(G.dot, M.gonys); g.scale.set(0.022, 0.017, 0.012); g.position.set(0.25, -0.04, z); jaw.add(g);
    }
    // eyes: dark edge, orange orbital ring, pale iris, pupil, two glints, and a real upper lid (per-bird geometry)
    const mkEye = (z: number) => {
      const e = grp(0.075, 0.255, z);
      e.lookAt(e.position.x + 0.35, e.position.y + 0.1, z * 6);
      const ring = new Mesh(G.eye, M.ring); ring.scale.setScalar(0.058);
      const orb = new Mesh(G.eye, M.orbital); orb.scale.setScalar(0.051); orb.position.z = 0.001;
      const iris = new Mesh(G.eye, M.iris); iris.scale.setScalar(0.043); iris.position.z = 0.002;
      const pupil = new Mesh(G.eye, M.pupil); pupil.scale.setScalar(0.026); pupil.position.set(0.004, 0, 0.004);
      const glint = new Mesh(G.eye, M.glint); glint.scale.setScalar(0.012); glint.position.set(-0.012, 0.012, 0.006);
      const glint2 = new Mesh(G.eye, M.glint); glint2.scale.setScalar(0.005); glint2.position.set(0.015, -0.013, 0.006);
      const lidG = new BufferGeometry();
      lidG.setAttribute('position', new Float32BufferAttribute(new Float32Array((LID_N + 1) * 4 * 3), 3));
      lidG.setAttribute('normal', new Float32BufferAttribute(new Float32Array((LID_N + 1) * 4 * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
      const idx: number[] = [];
      for (let i = 0; i < LID_N; i++) {
        const a = i * 4, b = a + 4; // per column: 0 top, 1 lid edge, 2 lid edge (line), 3 line bottom
        idx.push(a, a + 1, b + 1, a, b + 1, b);
      }
      const lineIdx: number[] = [];
      for (let i = 0; i < LID_N; i++) { const a = i * 4 + 2, b = a + 4; lineIdx.push(a, a + 1, b + 1, a, b + 1, b); }
      lidG.setIndex([...idx, ...lineIdx]);
      lidG.addGroup(0, idx.length, 0); lidG.addGroup(idx.length, lineIdx.length, 1);
      const lid = new Mesh(lidG, [M.head, M.lidLine]); lid.position.z = 0.008;
      e.add(ring, orb, iris, pupil, glint, glint2, lid);
      const holder = grp(); holder.add(e); neck.add(holder);
      this.eyes.push(holder); this.lids.push(lidG);
      return { e, iris, orb };
    };
    const eN = mkEye(0.176), eF = mkEye(-0.176);
    // wings
    const wing = (z: number) => {
      const near = z > 0, side = near ? 1 : -1;
      const sh = grp(0.44, 1.2, near ? z + 0.03 : z - 0.03); body.add(sh);
      sh.rotation.order = 'ZXY';
      const hug = grp(); sh.add(hug);
      hug.rotation.set(near ? -0.2 : 0.2, near ? 0.11 : -0.11, -0.12, 'YXZ');
      hug.add(mesh(G.inner, M.mantle));
      const el = grp(-0.78, 0, 0); hug.add(el);
      el.add(mesh(G.mid, M.mantle));
      const wr = grp(-0.55, 0, 0); el.add(wr);
      wr.add(mesh(G.handGrey, M.mantle));
      const prims: Object3D[] = [];
      for (let i = 0; i < 3; i++) {
        const f = grp(-0.02 * i, -0.03 * i, side * (0.004 - 0.009 * i)); wr.add(f);
        f.scale.set(1 - 0.07 * i, 1 - 0.1 * i, 1);
        f.add(mesh(G.handBlack, M.black));
        const t = new Mesh(G.tip, M.white); t.position.set(-0.6, -0.05, side * 0.012); f.add(t);
        prims.push(f);
      }
      const mir = new Mesh(G.mirror, M.white); mir.position.set(-0.5, -0.06, side * 0.03); wr.add(mir);
      if (near) {
        // layered feather edges on the visible (outer) side: a row of greater coverts across the arm, and
        // three tertials with white tips (the herring gull's white "tertial crescent") bridging arm and hand,
        // so the folded wing reads as one feathered shape instead of three panels
        for (let i = 0; i < 4; i++) {
          const c = new Mesh(G.leaf, M.covert);
          c.position.set(-0.02 - 0.15 * i, -0.15 - 0.03 * i, 0.03 + 0.003 * i);
          c.rotation.z = -0.32 + 0.04 * i; c.scale.set(0.95 + 0.08 * i, 1.05, 1);
          hug.add(c);
        }
        for (let i = 0; i < 3; i++) {
          const x = -0.6 - 0.1 * i, y = -0.04 - 0.05 * i, zz = 0.038 + 0.004 * i;
          const w = new Mesh(G.leaf, M.white); w.position.set(x - 0.05, y - 0.008, zz - 0.002); w.rotation.z = -0.12; w.scale.set(1.35, 1.1, 1);
          const t = new Mesh(G.leaf, M.covert); t.position.set(x, y, zz); t.rotation.z = -0.12; t.scale.set(1.3, 1.05, 1);
          hug.add(w, t);
        }
      }
      return { sh, el, wr, prims };
    };
    const wn = wing(0.27), wf = wing(-0.27);
    // thinking dots (gold facets)
    for (let i = 0; i < 3; i++) {
      const d = new Mesh(G.dot, M.dots); d.position.set(1.08 + i * 0.17, 2.14 + i * 0.2, 0.1); d.visible = false; rig.add(d); this.dots.push(d);
    }
    // contact shadow
    const sh = new Mesh(G.shadow, M.shadow); sh.rotation.x = -Math.PI / 2; sh.position.set(-0.16, 0.003, 0); sh.renderOrder = -1; rig.add(sh);
    this.shadow = sh;
    this.prims = [wn.prims, wf.prims];
    this.tailF = tailF;
    this.N = { torso, body, chest, bodyMesh, tail, legs, neck, jaw, nSh: wn.sh, nEl: wn.el, nWr: wn.wr, fSh: wf.sh, fEl: wf.el, fWr: wf.wr, irisN: eN.iris, irisF: eF.iris, orbN: eN.orb, orbF: eF.orb };
  }

  /** upper lid: the part of the eye disc above a downward-bulging edge; c = 0 open … 1 shut */
  setLid(c: number) {
    if (Math.abs(c - this.lidC) < 0.002) return;
    this.lidC = c;
    const r = 0.059, b = 0.4 * r, m = 0.16 * r, H = r + b - c * 2 * r;
    for (const g of this.lids) {
      const p = g.attributes.position as Float32BufferAttribute, a = p.array as Float32Array;
      for (let i = 0; i <= LID_N; i++) {
        const x = -r + (2 * r * i) / LID_N, top = Math.sqrt(Math.max(0, r * r - x * x));
        // LID_TILT lifts the lid toward the beak: a soft, friendly line instead of a frown
        const edge = Math.max(-top, Math.min(top, H - b * (1 - (x * x) / (r * r)) + LID_TILT * x * Math.min(1, c * 4)));
        const low = Math.max(-top, edge - m);
        const ys = [top, edge, Math.min(top, edge + 0.0006), low];
        for (let k = 0; k < 4; k++) { const o = (i * 4 + k) * 3; a[o] = x; a[o + 1] = ys[k]; a[o + 2] = k > 1 ? 0.0004 : 0; }
      }
      p.needsUpdate = true;
    }
  }

  // ── outfit ──
  kit(): Kit {
    const r = R!;
    return {
      loft, ell, body: BODY, M: r.M as unknown as Kit['M'], addRim: r.addRim,
      mesh: (g, m, hull = true) => {
        const o = new Mesh(g, m);
        if (hull) { const h = new Mesh(g, r.outline); h.renderOrder = -2; o.add(h); }
        return o;
      },
    };
  }
  setOutfit(outfit: Outfit | null) {
    if (this.failed || !R) return;
    const want = cleanOutfit(outfit);
    this.outfitWanted = want;
    const anchor: Record<Anchor, Object3D> = { head: this.N.neck, torso: this.N.torso, wrist: this.N.nWr };
    const instant = reducedMotion() || !this.shown; // the outfit a bird mounts with is simply there (no pop on page load)
    let k: Kit | null = null;
    for (const slot of SLOTS) {
      const id = want[slot], cur = this.worn.get(slot);
      if (cur?.id === id) continue;
      if (cur) { cur.parts.forEach((p) => p.obj.removeFromParent()); this.worn.delete(slot); this.pops = this.pops.filter((p) => !cur.parts.some((c) => c.obj === p.obj)); }
      if (!id) continue;
      let parts = null;
      try { parts = buildItem((k ??= this.kit()), id); } catch { parts = null; }
      if (!parts) continue;
      for (const p of parts) {
        p.obj.userData.s0 = p.obj.scale.x;
        anchor[p.at].add(p.obj);
        // "put on": 0.8 → 1, 220 ms ease-out (reduced motion: instant)
        if (!instant) { p.obj.scale.setScalar(p.obj.userData.s0 * 0.8); this.pops.push({ obj: p.obj, t0: clock() }); }
      }
      this.worn.set(slot, { id, parts });
    }
    this.dirty();
  }

  // ── state ──
  setState(s: MewkaState) {
    this.state = s;
    const g = GESTURES[s];
    this.keys = g ?? null; this.keysT = clock();
    this.wake();
  }
  look(x: number, y: number, on: boolean) { this.lookX = x; this.lookY = y; this.lookOn = on; this.wake(); }
  point(rad: number | null) { this.pointRad = rad; this.wake(); }

  targets(now: number): Pose {
    const s = this.state;
    const p: Pose = { ...POSES[s] };
    if (s === 'pointing') {
      const phi = this.pointRad ?? -40 * RAD;
      // arm 45° above the target line, forearm + primaries on it (elbow 55°, wrist -10°): compact reach
      let raise = 135 * RAD - phi;
      raise = ((raise % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (raise > 230 * RAD) raise -= 2 * Math.PI; // far below/behind: swing down, not over the head
      p.nr = raise;
      const right = Math.cos(phi) > -0.2;
      p.nYaw = right ? 0.05 : -1.3;
      p.nPitch = Math.max(-0.5, Math.min(0.45, phi * 0.55));
      p.nRoll = 0;
    }
    if (this.keys) {
      const t = now - this.keysT;
      let done = true;
      for (const [at, k] of this.keys) {
        if (at > t) { done = false; break; }
        for (const c in k) { const v = k[c as Chan]; if (v === null) delete p[c as Chan]; else p[c as Chan] = v; }
      }
      // null in a key releases the channel to the state pose: re-read it
      if (done) this.keys = null;
      for (const c in POSES[s]) if (!(c in p)) p[c as Chan] = POSES[s][c as Chan]!;
    }
    if (qaPose) Object.assign(p, qaPose);
    return p;
  }

  // ── simulation ──
  wake() { if (!this.failed) { this.needs = true; kick(); } }
  dirty() { this.needs = true; kick(); }
  fail() { this.failed = true; this.root.dataset.mw3d = 'off'; }


  step(dt: number, now: number): boolean {
    if (this.failed || !R) return false;
    if (!this.visible) return false;
    const awake = now - lastActive < SLEEP && this.state !== 'hidden';
    const p = this.targets(now);
    // ambient life: micro head turns, weight shift, blinks (only while the page is "in use")
    const A = this.amb, off = this.ambOff;
    const idleish = this.state === 'idle' || this.state === 'peek' || this.state === 'talking';
    if (awake && now > A.next) {
      const glance = Math.random() < 0.3, prev = A.yaw;
      A.yaw = glance ? -0.5 : (Math.random() - 0.5) * 0.5;
      // birds blink with big head saccades: the lid covers the turn
      if (Math.abs(A.yaw - prev) > 0.3 && A.blinkT < 0 && Math.random() < 0.6) A.blinkAt = now + 20;
      A.pitch = (Math.random() - 0.4) * 0.16; A.roll = (Math.random() - 0.5) * 0.14;
      A.lean = (Math.random() - 0.5) * 0.03;
      A.next = now + 1800 + Math.random() * 3200;
    }
    const lk = this.lookOn && LOOK_STATES.has(this.state);
    if (awake && !lk && !this.keys && (this.state === 'idle' || this.state === 'peek') && now > A.fidgetAt) {
      this.keys = FIDGETS[Math.floor(Math.random() * FIDGETS.length)]; this.keysT = now;
      A.fidgetAt = now + 6500 + Math.random() * 5500;
    }
    off.nYaw = idleish && awake && !lk ? A.yaw : 0;
    off.nPitch = idleish && awake && !lk ? A.pitch : 0;
    off.nRoll = idleish && awake && !lk ? A.roll : 0;
    off.lean = awake ? A.lean : 0;
    // targets
    let moving = false;
    for (const k in this.ch) {
      const name = k as Chan, c = this.ch[name];
      let t = p[name] ?? SPEC[name][0];
      if (name in off) t += (off as any)[name];
      if (lk && !(this.keys && this.keys.some(([, kp]) => name in kp))) {
        if (name === 'nYaw') t = this.lookX > 0 ? -0.75 + this.lookX * 0.85 : -0.75 + this.lookX * 0.7;
        if (name === 'nPitch') t = -this.lookY * 0.38;
      }
      // overlapping action: wrists/elbows/tail drag behind their parents
      if (name === 'nw') t -= this.ch.nr.v * 0.05;
      if (name === 'fw') t -= this.ch.fr.v * 0.05;
      if (name === 'ne') t -= this.ch.nr.v * 0.025;
      if (name === 'tail') t += -this.ch.hop.v * 0.12 + this.ch.lean.v * 0.4;
      if (name === 'sq') t += Math.min(0.06, Math.abs(this.ch.hop.v) * 0.025);
      if (name === 'tailYaw') t += -this.ch.turn.v * 0.18 - this.ch.nYaw.v * 0.012;
      c.t = t;
    }
    // integrate (semi-implicit Euler, fixed substeps)
    const n = Math.ceil(dt / (1 / 240));
    const h = dt / n;
    for (const k in this.ch) {
      const [, w, z] = SPEC[k as Chan], c = this.ch[k as Chan];
      for (let i = 0; i < n; i++) { c.v += (w * w * (c.t - c.x) - 2 * z * w * c.v) * h; c.x += c.v * h; }
      if (Math.abs(c.t - c.x) > 0.0008 || Math.abs(c.v) > 0.0008) moving = true;
      else { c.x = c.t; c.v = 0; }
    }
    // blink: close fast (70 ms), open a touch slower (110 ms); sometimes a double blink
    let blink = 0;
    if (awake && this.state !== 'hidden') {
      if (A.blinkT < 0 && now > A.blinkAt) { A.blinkT = now; A.double = Math.random() < 0.2; }
      if (A.blinkT >= 0) {
        const t = now - A.blinkT, cyc = A.double ? 2 : 1;
        const tt = t % 220, k = Math.floor(t / 220);
        if (k >= cyc) { A.blinkT = -1; A.blinkAt = now + 2400 + Math.random() * 3800; }
        else blink = tt < 70 ? easeIn(tt / 70) : tt < 180 ? 1 - easeOut((tt - 70) / 110) : 0;
        moving = true;
      }
    }
    // breathing (ambient, sine): only while awake
    const bt = (now - A.t0) / 1000;
    const breath = awake ? Math.sin(bt * Math.PI * 2 / 3.6) : 0;
    const thinking = this.state === 'thinking' && this.ch.dots.x > 0.02;
    if (awake) moving = true;
    if (thinking && now - this.keysT < 8000) moving = true;
    if (this.pops.length) moving = true;

    if (moving || this.needs) {
      // frame cap: ambient-only frames at ~30 fps
      const lively = this.keys || this.pops.length || Object.values(this.ch).some((c) => Math.abs(c.v) > 0.01) || this.lookOn;
      if (lively || this.needs || now - this.lastDraw > 32) {
        this.pose(breath, blink, now, awake ? Math.sin(bt * Math.PI * 2 / 5.3 + 1) * 0.012 : 0);
        this.draw();
        this.lastDraw = now;
      }
      this.needs = false;
    }
    return moving;
  }

  pose(breath: number, blink: number, now: number, sway = 0) {
    const C = (k: Chan) => this.ch[k].x, N = this.N;
    const sq = C('sq');
    this.rig.position.y = Math.max(-0.05, C('hop'));
    this.rig.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    this.rig.rotation.set(0, -0.5 + C('turn'), C('lean') + sway);
    // breathing lives in the chest (pivot high on the back): breast and belly swell, the back line stays
    N.chest.scale.set(1 + breath * 0.012, 1 + breath * 0.022, 1 + breath * 0.02);
    N.neck.position.y = 1.55 + breath * 0.004;
    // head stabilisation: like a real gull, the head holds its line while the body sways, leans and turns;
    // during a hop it lags a touch (follow-through) and catches up
    const bodyTilt = C('lean') + sway;
    N.neck.position.x = 0.78 - this.ch.hop.v * 0.004;
    N.neck.rotation.set(C('nRoll'), C('nYaw') - C('turn') * 0.35, C('nPitch') - bodyTilt * 0.85 + this.ch.hop.v * 0.012);
    N.jaw.rotation.z = -C('jaw');
    N.tail.rotation.set(0, C('tailYaw'), C('tail') + 0.08);
    // the tail fans as it lifts (hop, thinking lean-back) and closes when it settles
    const spread = 1 + Math.max(0, C('tail')) * 2.2 + Math.max(0, C('hop')) * 1.4;
    this.tailF.forEach((f) => { f.rotation.y = f.userData.yaw * spread; });
    N.nSh.rotation.set(-C('ns'), 0, -C('nr'));
    N.nEl.rotation.z = -C('ne');
    N.nWr.rotation.z = -C('nw');
    N.fSh.rotation.set(C('fs'), 0, -C('fr'));
    N.fEl.rotation.z = -C('fe');
    N.fWr.rotation.z = -C('fw');
    N.nSh.position.y = N.fSh.position.y = 1.2 + breath * 0.008;
    // primaries fan out as the wing lifts (folded: stacked)
    // and trail behind fast arm moves (secondary motion: the long outer feathers lag)
    const fan = [Math.max(0, C('nr')), Math.max(0, C('fr'))], drag = [this.ch.nr.v, this.ch.fr.v];
    this.prims.forEach((ps, w) => ps.forEach((f, i) => { f.rotation.z = -fan[w] * 0.16 * i + Math.max(-0.25, Math.min(0.25, drag[w] * 0.012 * (i + 1))); }));
    // lids: expression (state) + blink; the blink always closes fully and reopens to the expression
    // (below 60 px the eye is ~3 px: no expression lid there, it would only grey the eye out; blinks stay)
    const lid = this.isSmall ? 0 : Math.max(0, Math.min(1, C('lid')));
    this.setLid(lid + (1 - lid) * blink);
    // contact shadow follows the hop (smaller, lighter in the air)
    const air = Math.max(0, C('hop'));
    const s = 1 - air * 0.9;
    this.shadow.scale.set(1.3 * s, 0.5 * s, 1);
    this.shadow.position.y = 0.003 - this.rig.position.y; // stays on the ground
    // outfit pops (scale around each part's anchor)
    if (this.pops.length) {
      this.pops = this.pops.filter(({ obj, t0 }) => {
        const t = Math.min(1, (now - t0) / POP_MS), e = 1 - (1 - t) ** 3;
        obj.scale.setScalar(obj.userData.s0 * (0.8 + 0.2 * e));
        return t < 1;
      });
    }
    // thinking dots
    const d = C('dots');
    this.dots.forEach((m, i) => {
      const pulse = 0.5 + 0.5 * Math.sin((now / 1000) * 5.2 - i * 0.9);
      const sc = Math.max(0, d) * (0.06 + 0.02 * i) * (0.8 + 0.25 * pulse);
      m.visible = sc > 0.004; m.scale.setScalar(sc);
      m.rotation.set(now / 1600 + i, now / 1300, 0);
    });
  }

  draw() {
    const r = R!;
    if (!this.px) return;
    const gl = r.gl, px = this.px;
    const size = gl.getSize(V2D);
    if (size.x < px || size.y < px) gl.setSize(Math.max(size.x, px), Math.max(size.y, px), false);
    const H = Math.max(size.y, px);
    // outline width: ~1.15 css px (thinner relative to bigger birds), in world units
    const dpr = px / (this.cssSize * 1.5);
    const worldPerPx = (2 * this.cam.position.distanceTo(LOOK) * Math.tan((this.cam.fov * RAD) / 2)) / px;
    const cssW = this.isSmall ? 1.1 : this.cssSize > 90 ? 0.95 : 0.9;
    r.outlineW.value = cssW * dpr * worldPerPx;
    gl.setViewport(0, 0, px, px); gl.setScissor(0, 0, px, px); gl.setScissorTest(true);
    r.scene.add(this.rig);
    gl.render(r.scene, this.cam);
    r.scene.remove(this.rig);
    this.ctx.clearRect(0, 0, px, px);
    this.ctx.drawImage(gl.domElement, 0, H - px, px, px, 0, 0, px, px);
    if (!this.shown) { this.shown = true; requestAnimationFrame(() => (this.root.dataset.mw3d = 'on')); }
  }

  destroy() {
    birds.delete(this);
    this.io.disconnect(); this.ro.disconnect();
    this.cv.remove();
    delete this.root.dataset.mw3d;
    this.rig.clear();
    this.lids.forEach((g) => g.dispose());
    release();
  }
}
const V2D = new Vector2();

// ───────────────────────────── QA: trace the rig for the SVG fallback ─────────────────────────────
// Renders every rig group alone (depth-correct inside the group) with flat label colours at the rest pose and
// returns PNGs + pivots in SVG viewBox units (the canvas is 1.5x the box: viewBox -12..60). Used by a dev
// script to regenerate mewka-svg.ts so the fallback matches the 3D bird exactly. Never runs in production.
function traceRig(b: Bird, px: number) {
  const r = R!, { G, M } = r, N = b.N;
  // rest pose: every channel at rest, no breath / sway / blink
  for (const k in b.ch) { const c = b.ch[k as Chan]; c.x = c.t = SPEC[k as Chan][0]; c.v = 0; }
  b.pose(0, 0, 0, 0);
  const LABEL: [string, string][] = [];
  const col = (name: string) => {
    const i = LABEL.findIndex(([n]) => n === name); if (i >= 0) return LABEL[i][1];
    const h = (LABEL.length * 0.61803) % 1, c = new Color().setHSL(h, 1, LABEL.length % 2 ? 0.35 : 0.6);
    const hex = '#' + c.getHexString(); LABEL.push([name, hex]); return hex;
  };
  const mats = new Map<string, MeshBasicMaterial>();
  const basic = (name: string) => { let m = mats.get(name); if (!m) { m = new MeshBasicMaterial({ color: col(name), toneMapped: false }); mats.set(name, m); } return m; };
  const farEye = b.eyes[1];
  const label = (m: Mesh): string | null => {
    const g = m.geometry, mt = m.material as Material;
    if (mt === r.outline) return null;
    let far = false; for (let o: Object3D | null = m; o; o = o.parent) if (o === farEye) far = true;
    const pre = far ? 'f' : '';
    if (Array.isArray(m.material)) return null; // lids: the SVG animates its own
    if (g === G.body) return 'body'; if (g === G.head) return 'head'; if (g === G.tail) return 'tail';
    if (g === G.leg || g === G.foot || g === G.toe) return 'leg';
    if (g === G.upper) return 'beakU'; if (g === G.lower) return 'beakL'; if (mt === M.gonys) return 'gonys';
    if (mt === M.ring) return pre + 'ring'; if (mt === M.orbital) return pre + 'orb'; if (mt === M.iris) return pre + 'iris';
    if (mt === M.pupil) return pre + 'pupil'; if (mt === M.glint) return pre + 'glint';
    if (mt === M.mantle) return 'mantle'; if (mt === M.covert) return 'covert'; if (mt === M.black) return 'black';
    if (g === G.tip) return 'tip'; if (g === G.mirror) return 'mirror'; if (g === G.leaf) return 'tertial';
    if (mt === M.shadow) return 'shadow';
    return null;
  };
  const groups: Record<string, Object3D[]> = {
    shadow: [b.shadow], farWing: [N.fSh], tail: [N.tail], legs: [N.legs], body: [N.bodyMesh], nearWing: [N.nSh], head: [N.neck], lit: [b.rig],
  };
  const all: Mesh[] = []; b.rig.traverse((o) => { if ((o as Mesh).isMesh) all.push(o as Mesh); });
  const saved = all.map((m) => [m, m.material, m.visible] as const);
  const gl = r.gl, size = gl.getSize(V2D).clone();
  gl.setSize(Math.max(size.x, px), Math.max(size.y, px), false);
  const H = Math.max(size.y, px);
  const cv = document.createElement('canvas'); cv.width = cv.height = px; const cx = cv.getContext('2d')!;
  const out: Record<string, string> = {};
  const env = r.scene.environment;
  for (const [name, roots] of Object.entries(groups)) {
    r.scene.environment = name === 'lit' ? env : null;
    if (name === 'lit') { const dpr = 1, wpp = (2 * b.cam.position.distanceTo(LOOK) * Math.tan((b.cam.fov * RAD) / 2)) / px; r.outlineW.value = 0.95 * dpr * wpp * (px / (104 * 1.5)); }
    const inGroup = new Set<Mesh>(); roots.forEach((g) => g.traverse((o) => { if ((o as Mesh).isMesh) inGroup.add(o as Mesh); }));
    for (const m of all) {
      if (name === 'lit') { m.visible = !b.dots.includes(m); continue; }
      const l = inGroup.has(m) ? label(m) : null;
      m.visible = !!l;
      if (l) m.material = Array.isArray(m.material) ? [basic(l), basic(l + 'Line')] : basic(l);
    }
    gl.setViewport(0, 0, px, px); gl.setScissor(0, 0, px, px); gl.setScissorTest(true);
    r.scene.add(b.rig); gl.render(r.scene, b.cam); r.scene.remove(b.rig);
    cx.clearRect(0, 0, px, px); cx.drawImage(gl.domElement, 0, H - px, px, px, 0, 0, px, px);
    out[name] = cv.toDataURL('image/png');
    saved.forEach(([m, mt, v]) => { m.material = mt; m.visible = v; });
  }
  r.scene.environment = env;
  gl.setSize(size.x, size.y, false);
  mats.forEach((m) => m.dispose());
  // pivots → viewBox units
  b.rig.updateMatrixWorld(true);
  const vb = (o: Object3D, local = new Vector3()) => {
    const v = o.localToWorld(local.clone()).project(b.cam);
    return [+((v.x + 1) / 2 * 72 - 12).toFixed(2), +((1 - v.y) / 2 * 72 - 12).toFixed(2)];
  };
  const pivots = {
    neck: vb(N.neck), shoulderN: vb(N.nSh), shoulderF: vb(N.fSh), jaw: vb(N.jaw), eyeN: vb(b.eyes[0].children[0]), eyeF: vb(b.eyes[1].children[0]),
    feet: vb(b.rig, new Vector3(0.02, 0, 0)), tail: vb(N.tail), elbowN: vb(N.nEl), wristN: vb(N.nWr), chest: vb(N.chest),
    eyeTop: vb(b.eyes[0].children[0], new Vector3(0, 0.059, 0)), eyeR: vb(b.eyes[0].children[0], new Vector3(0.059, 0, 0)),
  };
  b.dirty();
  return { labels: Object.fromEntries(LABEL), images: out, pivots };
}
const LID_N = 12; // lid columns
const LID_TILT = 0.22;
const LOOK = new Vector3(0.02, 1.5, 0);
const easeIn = (t: number) => t * t;
const POP_MS = 220;
const reducedMotion = () =>
  document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

export function mount(root: HTMLElement, state: MewkaState): Bird3D | null {
  if (!acquire()) return null;
  try { return new Bird(root, state); } catch { release(); return null; }
}
