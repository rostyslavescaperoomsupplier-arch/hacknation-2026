// Mewka 3D outfit: the Gniazdo Mewki items (src/lib/game/catalog.ts) modelled procedurally in the gull's own
// language: lofted low-poly shapes, the bird's materials (gold = the legs' gold, black = the wing-tip black,
// white = the plumage), item.colors for everything else, and the same silhouette-only ink outline.
// Part of the lazy 3D chunk (imported by mewka3d.ts only). Geometry is built the first time an item is worn
// and cached for every bird on the page; materials are cached per colour.
//
// Anchors (each part is a small group placed at its anchor, so the "put on" pop scales around it):
//   head  = the neck group (head, beak, eyes): head + eyes slots, follow every head turn, pitch and call
//   torso = the breathing chest, in body coordinates: neck + body slots (body-hugging cloth uses the
//           body's own loft rings, inflated, so it sits on the plumage instead of guessing a surface)
//   wrist = the near wing's wrist joint: hand slot, so a baton follows greet / pointing / listening
import {
  BufferGeometry, CanvasTexture, Euler, CatmullRomCurve3, CircleGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute,
  Group, Matrix4, Mesh, MeshPhysicalMaterial, NearestFilter, Quaternion, RepeatWrapping, SRGBColorSpace,
  TorusGeometry, TubeGeometry, Vector3, type Material, type Object3D,
} from 'three';
import { itemById } from './outfit';
import type { Outfit, Slot } from './outfit';

export type Anchor = 'head' | 'torso' | 'wrist';
export interface Part { at: Anchor; obj: Object3D }
type V2 = [number, number];
interface Ring { x: number; y: number; z?: number; pts: V2[] }
/** body loft ring parameters: x, y, half-height (dorsal), half-width, twist?, belly, back */
export type BodyRing = [number, number, number, number, number, number, number];

export interface Kit {
  loft(rings: Ring[], capStart?: boolean, capEnd?: boolean): BufferGeometry;
  ell(m: number, h: number, w: number, twist?: number, belly?: number, back?: number): V2[];
  body: BodyRing[];
  M: { white: Material; black: Material; gold: Material; [k: string]: Material };
  /** mesh with (or without) the silhouette hull */
  mesh(g: BufferGeometry, m: Material, hull?: boolean): Mesh;
  addRim(m: Material): void;
}

export const SLOTS: Slot[] = ['head', 'eyes', 'neck', 'body', 'hand'];

// ───────────────────────────── caches (shared by all birds, freed with the renderer) ─────────────────────────────
const geoCache = new Map<string, BufferGeometry>();
const matCache = new Map<string, Material>();
const texCache: CanvasTexture[] = [];
const geo = (key: string, make: () => BufferGeometry) => {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
};
export function disposeOutfit() {
  geoCache.forEach((g) => g.dispose()); geoCache.clear();
  matCache.forEach((m) => m.dispose()); matCache.clear();
  texCache.forEach((t) => t.dispose()); texCache.length = 0;
}

const norm = (c: string) => c.trim().toLowerCase();
const GOLD = new Set(['#b39a5a']);
/** colour → material. Brand gold / black / white reuse the bird's own materials, so they read as one object. */
function mat(k: Kit, color: string, opt: { double?: boolean; rough?: number; metal?: number } = {}): Material {
  const c = norm(color);
  if (!opt.double && opt.rough === undefined) {
    if (GOLD.has(c)) return k.M.gold;
    if (c === '#111111') return k.M.black;
    if (c === '#ffffff') return k.M.white;
  }
  const key = `${c}|${opt.double ? 2 : 1}|${opt.rough ?? ''}|${opt.metal ?? ''}`;
  let m = matCache.get(key);
  if (!m) {
    const black = c === '#111111', gold = GOLD.has(c) || c === '#7a6328';
    const p = new MeshPhysicalMaterial({
      color: black ? '#17181b' : GOLD.has(c) ? '#cf9f3e' : c === '#7a6328' ? '#9a7430' : c,
      roughness: opt.rough ?? (gold ? 0.34 : black ? 0.42 : 0.62),
      metalness: opt.metal ?? (gold ? 0.65 : 0),
      sheen: gold ? 0 : 0.4, sheenRoughness: 0.5,
      side: opt.double ? DoubleSide : undefined,
    });
    if (gold) p.clearcoat = 0.3;
    k.addRim(p);
    m = p; matCache.set(key, m);
  }
  return m;
}
/** knitted stripes (navy on white) for the sailor jumper: crisp, a tiny repeating texture sampled along v */
function stripes(k: Kit, a: string, b: string): Material {
  const key = `stripes|${a}|${b}`;
  let m = matCache.get(key);
  if (!m) {
    const cv = document.createElement('canvas'); cv.width = 2; cv.height = 8;
    const x = cv.getContext('2d')!;
    x.fillStyle = a; x.fillRect(0, 0, 2, 8);
    x.fillStyle = b; x.fillRect(0, 0, 2, 3);
    const t = new CanvasTexture(cv);
    t.colorSpace = SRGBColorSpace; t.magFilter = NearestFilter; t.wrapS = t.wrapT = RepeatWrapping;
    texCache.push(t);
    const p = new MeshPhysicalMaterial({ map: t, roughness: 0.7, sheen: 0.5, sheenRoughness: 0.5, side: DoubleSide });
    k.addRim(p);
    m = p; matCache.set(key, m);
  }
  return m;
}

// ───────────────────────────── geometry helpers ─────────────────────────────
const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const Z = V(0, 0, 1), Y = V(0, 1, 0);
const qFrom = (from: Vector3, to: Vector3) => new Quaternion().setFromUnitVectors(from, to.clone().normalize());
/** quaternion whose local x/y/z map to the given (orthonormalised) world axes */
function qBasis(ex: Vector3, ey: Vector3): Quaternion {
  const x = ex.clone().normalize();
  const z = new Vector3().crossVectors(x, ey).normalize();
  const y = new Vector3().crossVectors(z, x);
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}
function grp(pos: Vector3, q?: Quaternion, s = 1): Group {
  const g = new Group(); g.position.copy(pos); if (q) g.quaternion.copy(q); g.scale.setScalar(s); return g;
}
function put(parent: Object3D, o: Object3D, pos?: Vector3, q?: Quaternion, s?: Vector3 | number) {
  if (pos) o.position.copy(pos);
  if (q) o.quaternion.copy(q);
  if (s !== undefined) typeof s === 'number' ? o.scale.setScalar(s) : o.scale.copy(s);
  parent.add(o);
  return o;
}
/** rounded-rectangle ring (superellipse), m points */
const rrect = (m: number, h: number, w: number, p = 4): V2[] =>
  Array.from({ length: m }, (_, j) => {
    const t = (j / m) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    return [h * Math.sign(s) * Math.abs(s) ** (2 / p), w * Math.sign(c) * Math.abs(c) ** (2 / p)] as V2;
  });
/** grid surface from rows of points (open sheet); v of the uv runs along rows, u across */
function sheet(rows: Vector3[][], vOf?: (r: number) => number): BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const n = rows.length, m = rows[0].length;
  rows.forEach((row, r) => row.forEach((p, c) => { pos.push(p.x, p.y, p.z); uv.push(c / (m - 1), vOf ? vOf(r) : r / (n - 1)); }));
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < m - 1; c++) {
    const a = r * m + c, b = a + 1, d = a + m, e = d + 1;
    idx.push(a, b, e, a, e, d);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const tube = (pts: Vector3[], r: number, seg = 10, rad = 5) => new TubeGeometry(new CatmullRomCurve3(pts), seg, r, rad, false);

// ── the body surface (same rings as the gull's body loft) ──
/** point on the body at fractional ring p and ring angle t (t = PI/2 dorsal, 3PI/2 belly, 0 near side +Z), inflated by d */
function bodyAt(k: Kit, p: number, t: number, d = 0): Vector3 {
  const B = k.body, n = B.length;
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(p))), i1 = Math.min(n - 1, i0 + 1), f = Math.max(0, Math.min(1, p - i0));
  const L = (j: number) => B[i0][j] + (B[i1][j] - B[i0][j]) * f;
  const tan = (i: number) => {
    const a = B[Math.max(0, i - 1)], b = B[Math.min(n - 1, i + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return [tx / l, ty / l];
  };
  const [ax, ay] = tan(i0), [bx, by] = tan(i1);
  let tx = ax + (bx - ax) * f, ty = ay + (by - ay) * f;
  const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
  const nx = tx >= 0 ? -ty : ty, ny = tx >= 0 ? tx : -tx;
  const s = Math.sin(t), c = Math.cos(t);
  const u = (L(2) * (s < 0 ? L(5) : L(6)) + d) * s, w = (L(3) + d) * c;
  return V(L(0) + nx * u, L(1) + ny * u, w);
}
/** outward surface normal at (p, t) (finite differences) */
function bodyN(k: Kit, p: number, t: number): Vector3 {
  const a = bodyAt(k, p, t), dt = bodyAt(k, p, t + 0.01).sub(a), dp = bodyAt(k, p + 0.01, t).sub(a);
  const n = new Vector3().crossVectors(dt, dp).normalize();
  const ctr = bodyAt(k, p, t, -10); // far inside along the same ray
  if (n.dot(a.clone().sub(ctr)) < 0) n.negate();
  return n;
}
/** spine tangent (towards the head) at ring p */
const bodyT = (k: Kit, p: number) => bodyAt(k, p + 0.05, 0, -10).sub(bodyAt(k, p - 0.05, 0, -10)).setZ(0).normalize();
/** cloth that follows the body: rows over ring params ps, columns over angles ts(row) */
function bodySheet(k: Kit, ps: number[], ts: (r: number) => number[], d: (r: number, c: number) => number) {
  return ps.map((p, r) => ts(r).map((t, c) => bodyAt(k, p, t, d(r, c))));
}
const lin = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

// ── head frame (neck group, before its 1.15 scale) ──
const EYE = V(0.075, 0.255, 0.176);
const eyeOut = (side: 1 | -1) => V(0.35, 0.1, 0.88 * side).normalize();

// ───────────────────────────── items ─────────────────────────────
type Build = (k: Kit, c: string[]) => Part[];

/** hats sit on the crown, tilted back a touch (and a hair towards the viewer: jaunty, not stiff) */
const crown = (y: number, tilt = 0.2, roll = 0.06, sc = 1) => grp(V(-0.03, y, 0), new Quaternion().setFromEuler(new Euler(roll, 0, tilt)), sc);

function bowtie(k: Kit, c: string[]): Part[] {
  const color = c[0] ?? '#111111';
  const lobe = geo('bow-lobe', () => k.loft([
    { x: 0.0, y: 0, pts: k.ell(8, 0.026, 0.022) },
    { x: 0.035, y: 0, pts: k.ell(8, 0.042, 0.026) },
    { x: 0.085, y: 0.004, pts: k.ell(8, 0.064, 0.028) },
    { x: 0.125, y: 0.006, pts: k.ell(8, 0.07, 0.026) },
    { x: 0.142, y: 0.006, pts: k.ell(8, 0.05, 0.016) },
  ]));
  const knot = geo('bow-knot', () => k.loft([
    { x: -0.028, y: 0, pts: k.ell(8, 0.03, 0.03) },
    { x: 0, y: 0, pts: k.ell(8, 0.036, 0.036) },
    { x: 0.028, y: 0, pts: k.ell(8, 0.03, 0.03) },
  ]));
  const p = 8.15, t = Math.PI * 1.5;
  const at = bodyAt(k, p, t, 0.03), n = bodyN(k, p, t), up = bodyT(k, p);
  const g = grp(at, qBasis(V(0, 0, -1), up), 1.75);
  const m = mat(k, color);
  put(g, k.mesh(lobe, m), V(0.014, 0, 0), undefined, V(1, 1, 1));
  put(g, k.mesh(lobe, m), V(-0.014, 0, 0), new Quaternion().setFromAxisAngle(Y, Math.PI));
  put(g, k.mesh(knot, m), V(0, 0, 0.01), new Quaternion().setFromAxisAngle(Z, Math.PI / 2));
  // lean the bow a little forward so it reads in the 3/4 view
  g.position.addScaledVector(n, 0.004);
  return [{ at: 'torso', obj: g }];
}

function scarf(k: Kit, c: string[]): Part[] {
  const [c0 = '#b39a5a', c1 = '#7a6328'] = c;
  const ring = geo('scarf-ring', () => {
    const puff = [0.03, 0.055, 0.06, 0.05, 0.028];
    const ps = [8.0, 8.25, 8.55, 8.85, 9.1];
    return k.loft(ps.map((p, i) => {
      const i0 = Math.floor(p), f = p - i0, L = (j: number) => k.body[i0][j] + (k.body[i0 + 1][j] - k.body[i0][j]) * f;
      return { x: L(0), y: L(1), pts: k.ell(14, L(2) * 1.04 + puff[i], L(3) + puff[i], 0, L(5)) };
    }), true, true);
  });
  // the two ends hang from a knot on the near side of the throat, down over the breast
  const end = (t0: number, len: number) => geo(`scarf-end-${t0}`, () => {
    const ps = lin(8.55, 8.55 - len, 6);
    return sheet(bodySheet(k, ps, (r) => [t0 - 0.2 + r * 0.02, t0 + 0.2 + r * 0.035], (r) => 0.05 - r * 0.004));
  });
  const fringe = (t0: number, len: number) => geo(`scarf-fr-${t0}`, () => {
    const p = 8.55 - len;
    return sheet(bodySheet(k, [p + 0.12, p], (r) => [t0 - 0.2 + (5 + r) * 0.02 - 0.02, t0 + 0.2 + (5 + r) * 0.035], () => 0.031));
  });
  const g = grp(V());
  const m0 = mat(k, c0), m0d = mat(k, c0, { double: true, rough: 0.4, metal: 0.55 }), m1 = mat(k, c1, { double: true });
  put(g, k.mesh(ring, m0));
  const tA = Math.PI * 1.5 + 0.55, tB = Math.PI * 1.5 + 0.2;
  put(g, k.mesh(end(tA, 1.55), m0d));
  put(g, k.mesh(end(tB, 1.25), m0d));
  put(g, k.mesh(fringe(tA, 1.55), m1));
  put(g, k.mesh(fringe(tB, 1.25), m1));
  const knot = geo('scarf-knot', () => k.loft([
    { x: -0.05, y: 0, pts: k.ell(8, 0.04, 0.05) }, { x: 0, y: 0, pts: k.ell(8, 0.06, 0.065) }, { x: 0.05, y: 0, pts: k.ell(8, 0.04, 0.05) },
  ]));
  const kp = bodyAt(k, 8.55, tA - 0.15, 0.07);
  put(g, k.mesh(knot, m0), kp, qBasis(bodyT(k, 8.5), bodyN(k, 8.55, tA)));
  return [{ at: 'torso', obj: g }];
}

function kerchief(k: Kit, c: string[]): Part[] {
  const [c0 = '#b3261e', c1 = '#ffffff'] = c;
  const cloth = geo('kerchief', () => {
    const ps = lin(9.05, 6.75, 8);
    return sheet(bodySheet(k, ps, (r) => {
      const a = 1.25 * (1 - r / (ps.length - 1)) + 0.02;
      return lin(Math.PI * 1.5 - a, Math.PI * 1.5 + a, 9);
    }, (r) => 0.018 + r * 0.002));
  });
  const g = grp(V());
  put(g, k.mesh(cloth, mat(k, c0, { double: true })));
  // polka dots + the knot on the near side
  const dot = geo('kerchief-dot', () => new CircleGeometry(1, 7));
  const dm = mat(k, c1);
  for (const [p, t] of [[8.5, 1.5 * Math.PI], [8.3, 1.5 * Math.PI + 0.62], [8.3, 1.5 * Math.PI - 0.62], [7.75, 1.5 * Math.PI + 0.28], [7.75, 1.5 * Math.PI - 0.28], [7.25, 1.5 * Math.PI]] as V2[]) {
    put(g, k.mesh(dot, dm, false), bodyAt(k, p, t, 0.024 + (8.5 - p) * 0.0025), qFrom(Z, bodyN(k, p, t)), 0.021);
  }
  const knot = geo('kerchief-knot', () => k.loft([
    { x: -0.04, y: 0, pts: k.ell(7, 0.032, 0.036) }, { x: 0, y: 0, pts: k.ell(7, 0.045, 0.048) }, { x: 0.04, y: 0, pts: k.ell(7, 0.03, 0.034) },
  ]));
  const km = mat(k, c0);
  const tk = Math.PI * 1.5 + 1.15;
  put(g, k.mesh(knot, km), bodyAt(k, 8.95, tk, 0.045), qBasis(bodyT(k, 8.9), bodyN(k, 8.95, tk)));
  const tail = geo('kerchief-tail', () => k.loft([
    { x: 0, y: 0, pts: k.ell(5, 0.03, 0.008) }, { x: -0.07, y: -0.01, pts: k.ell(5, 0.026, 0.007) }, { x: -0.12, y: -0.03, pts: k.ell(5, 0.006, 0.003) },
  ]));
  const kn = bodyAt(k, 8.95, tk, 0.045);
  put(g, k.mesh(tail, km), kn.clone().add(V(-0.02, -0.03, 0.01)), new Quaternion().setFromAxisAngle(Z, 0.9));
  put(g, k.mesh(tail, km), kn.clone().add(V(0.0, -0.03, 0.015)), new Quaternion().setFromAxisAngle(Z, 1.5));
  return [{ at: 'torso', obj: g }];
}

function sweater(k: Kit, c: string[]): Part[] {
  const [c0 = '#ffffff', c1 = '#1f3a5f'] = c;
  const ps = lin(2.7, 8.55, 26);
  const knit = geo('sweater', () => sheet(
    bodySheet(k, ps, () => lin(Math.PI - 0.32, 2 * Math.PI + 0.32, 17), () => 0.014),
    (r) => ps[r] * 2.25,
  ));
  const collar = geo('sweater-collar', () => {
    const rs = [8.45, 8.62, 8.8];
    return k.loft(rs.map((p, i) => {
      const i0 = Math.floor(p), f = p - i0, L = (j: number) => k.body[i0][j] + (k.body[i0 + 1][j] - k.body[i0][j]) * f;
      const d = [0.016, 0.036, 0.02][i];
      return { x: L(0), y: L(1), pts: k.ell(16, L(2) * L(5) + d, L(3) + d) };
    }));
  });
  const hem = geo('sweater-hem', () => sheet(bodySheet(k, [2.7, 3.0], () => lin(Math.PI - 0.32, 2 * Math.PI + 0.32, 17), () => 0.02)));
  const g = grp(V());
  put(g, k.mesh(knit, stripes(k, c0, c1)));
  put(g, k.mesh(collar, mat(k, c1)));
  put(g, k.mesh(hem, mat(k, c1, { double: true })));
  return [{ at: 'torso', obj: g }];
}

function tailcoat(k: Kit, c: string[]): Part[] {
  const [c0 = '#111111', c1 = '#ffffff'] = c;
  const cloth = geo('coat', () => {
    const ps = lin(1.9, 8.4, 22);
    // lapels: the front opening widens towards the breast (white shirt front stays visible)
    return sheet(bodySheet(k, ps, (r) => {
      const open = 0.15 + 0.95 * Math.min(1, Math.max(0, (ps[r] - 5.6) / 2.6));
      return lin(-0.75 + open, Math.PI + 0.75 - open, 19);
    }, () => 0.016));
  });
  const lapel = (side: 1 | -1) => geo(`coat-lapel-${side}`, () => {
    const ps = lin(6.3, 8.4, 6);
    return sheet(bodySheet(k, ps, (r) => {
      const open = 0.15 + 0.95 * Math.min(1, Math.max(0, (ps[r] - 5.6) / 2.6));
      const e = side > 0 ? -0.75 + open : Math.PI + 0.75 - open;
      const wdt = 0.05 + 0.2 * (r / (ps.length - 1));
      return side > 0 ? [e, e + wdt] : [e - wdt, e];
    }, () => 0.024));
  });
  // two long tails, split at the end (swallowtail), hanging behind the legs under the gull's own tail
  const tailG = geo('coat-tail', () => k.loft([
    { x: 0, y: 0, pts: k.ell(6, 0.075, 0.012) },
    { x: -0.16, y: -0.08, pts: k.ell(6, 0.07, 0.012) },
    { x: -0.32, y: -0.17, pts: k.ell(6, 0.055, 0.011) },
    { x: -0.44, y: -0.25, pts: k.ell(6, 0.032, 0.009) },
    { x: -0.49, y: -0.29, pts: k.ell(6, 0.008, 0.004) },
  ]));
  const g = grp(V());
  const black = mat(k, c0, { double: true });
  put(g, k.mesh(cloth, black));
  put(g, k.mesh(lapel(1), mat(k, c0, { double: true, rough: 0.22 })));
  put(g, k.mesh(lapel(-1), mat(k, c0, { double: true, rough: 0.22 })));
  const tm = mat(k, c0);
  for (const side of [1, -1] as const) {
    const at = bodyAt(k, 2.1, side > 0 ? -0.62 : Math.PI + 0.62, -0.01);
    put(g, k.mesh(tailG, tm), at, new Quaternion().setFromEuler(new Euler(0, side * -0.1, side > 0 ? -0.05 : -0.16)));
  }
  // shirt studs on the white front (c1) for a touch of formal wear
  const stud = geo('coat-stud', () => new CircleGeometry(1, 6));
  for (const p of [7.2, 7.75, 8.25]) put(g, k.mesh(stud, mat(k, c1 === '#ffffff' ? '#17181b' : c1), false), bodyAt(k, p, 1.5 * Math.PI, 0.006), qFrom(Z, bodyN(k, p, 1.5 * Math.PI)), 0.014);
  return [{ at: 'torso', obj: g }];
}

function backpack(k: Kit, c: string[]): Part[] {
  const [c0 = '#b39a5a', c1 = '#1f3a5f'] = c;
  const bag = geo('pack', () => k.loft([
    { x: 0, y: -0.01, pts: rrect(14, 0.085, 0.15) },
    { x: 0, y: 0.02, pts: rrect(14, 0.1, 0.17) },
    { x: 0, y: 0.2, pts: rrect(14, 0.1, 0.17) },
    { x: 0, y: 0.27, pts: rrect(14, 0.085, 0.15) },
    { x: 0, y: 0.29, pts: rrect(14, 0.05, 0.1) },
  ]));
  const flap = geo('pack-flap', () => k.loft([
    { x: 0, y: 0.13, pts: rrect(12, 0.112, 0.176).map(([u, w]) => [u + 0.004, w] as V2) },
    { x: 0, y: 0.272, pts: rrect(12, 0.098, 0.158) },
    { x: 0, y: 0.3, pts: rrect(12, 0.056, 0.105) },
  ]));
  const strap = (side: 1 | -1) => geo(`pack-strap-${side}`, () => {
    const a = side > 0 ? [Math.PI / 2 - 0.35, -Math.PI / 2 + 0.42] : [Math.PI / 2 + 0.35, 1.5 * Math.PI - 0.42];
    return sheet(bodySheet(k, [6.95, 7.35], () => lin(a[0], a[1], 12), () => 0.02));
  });
  const buckle = geo('pack-buckle', () => new CylinderGeometry(1, 1, 0.5, 8));
  const g = grp(V());
  // on the back, between the folded wings, leaning with the back line
  const at = bodyAt(k, 3.7, Math.PI / 2, -0.03);
  const pack = grp(at, new Quaternion().setFromAxisAngle(Z, 0.2), 1.4);
  put(pack, k.mesh(bag, mat(k, c0)));
  put(pack, k.mesh(flap, mat(k, c1)));
  put(pack, k.mesh(buckle, mat(k, c0 === '#b39a5a' ? '#7a6328' : c0)), V(-0.112, 0.14, 0), new Quaternion().setFromAxisAngle(Z, Math.PI / 2), V(0.022, 0.03, 0.022));
  g.add(pack);
  const sm = mat(k, c1, { double: true });
  put(g, k.mesh(strap(1), sm)); put(g, k.mesh(strap(-1), sm));
  return [{ at: 'torso', obj: g }];
}

function topHat(k: Kit, c: string[]): Part[] {
  const [c0 = '#111111', c1 = '#b39a5a'] = c;
  const M = 16;
  const body = geo('tophat', () => k.loft([
    { x: 0, y: 0.0, pts: k.ell(M, 0.112, 0.112) },
    { x: 0, y: 0.15, pts: k.ell(M, 0.114, 0.114) },
    { x: 0, y: 0.28, pts: k.ell(M, 0.128, 0.128) },
    { x: 0, y: 0.292, pts: k.ell(M, 0.122, 0.122) },
  ]));
  const brim = geo('tophat-brim', () => k.loft([
    { x: 0, y: -0.006, pts: k.ell(M, 0.11, 0.11) },
    { x: 0, y: 0.0, pts: k.ell(M, 0.2, 0.18) },
    { x: 0, y: 0.024, pts: k.ell(M, 0.206, 0.186) },
    { x: 0, y: 0.03, pts: k.ell(M, 0.11, 0.11) },
  ]));
  const band = geo('tophat-band', () => k.loft([
    { x: 0, y: 0.03, pts: k.ell(M, 0.117, 0.117) },
    { x: 0, y: 0.085, pts: k.ell(M, 0.118, 0.118) },
  ], false, false));
  const g = crown(0.345, 0.2, 0.06, 1.08);
  put(g, k.mesh(brim, mat(k, c0)));
  put(g, k.mesh(body, mat(k, c0)), V(0, 0.02, 0));
  put(g, k.mesh(band, mat(k, c1), false));
  return [{ at: 'head', obj: g }];
}

function sailorCap(k: Kit, c: string[]): Part[] {
  const [c0 = '#ffffff', c1 = '#1f3a5f', c2 = '#b39a5a'] = c;
  const band = geo('cap-band', () => k.loft([
    { x: 0, y: 0, pts: k.ell(16, 0.15, 0.145) },
    { x: 0, y: 0.075, pts: k.ell(16, 0.158, 0.152) },
  ]));
  const top = geo('cap-top', () => k.loft([
    { x: 0, y: 0.07, pts: k.ell(16, 0.15, 0.145) },
    { x: 0, y: 0.1, pts: k.ell(16, 0.215, 0.2) },
    { x: 0, y: 0.125, pts: k.ell(16, 0.21, 0.196) },
    { x: 0, y: 0.138, pts: k.ell(16, 0.12, 0.11) },
  ]));
  const ribbon = geo('cap-ribbon', () => k.loft([
    { x: 0, y: 0, pts: k.ell(4, 0.022, 0.004) },
    { x: -0.05, y: -0.1, pts: k.ell(4, 0.022, 0.004) },
    { x: -0.08, y: -0.2, pts: k.ell(4, 0.02, 0.004) },
    { x: -0.09, y: -0.24, pts: k.ell(4, 0.005, 0.002) },
  ]));
  const badge = geo('cap-badge', () => new CylinderGeometry(1, 1, 0.4, 6));
  const g = crown(0.29, 0.36, 0.1, 1.14);
  put(g, k.mesh(band, mat(k, c1)));
  put(g, k.mesh(top, mat(k, c0)));
  put(g, k.mesh(badge, mat(k, c2)), V(0.155, 0.04, 0), new Quaternion().setFromAxisAngle(Z, -Math.PI / 2), V(0.026, 0.03, 0.026));
  const rm = mat(k, c1);
  put(g, k.mesh(ribbon, rm), V(-0.15, 0.04, 0.03), new Quaternion().setFromAxisAngle(Y, 0.15));
  put(g, k.mesh(ribbon, rm), V(-0.15, 0.04, -0.03), new Quaternion().setFromAxisAngle(Y, -0.25), V(1, 0.85, 1));
  return [{ at: 'head', obj: g }];
}

function beret(k: Kit, c: string[]): Part[] {
  const [c0 = '#111111', c1 = '#b3261e'] = c;
  // soft felt: a full, slightly floppy crown that overhangs the band
  const dome = geo('beret', () => k.loft([
    { x: 0, y: -0.005, pts: k.ell(20, 0.165, 0.155) },
    { x: 0, y: 0.03, pts: k.ell(20, 0.25, 0.24) },
    { x: 0, y: 0.068, pts: k.ell(20, 0.272, 0.262) },
    { x: 0, y: 0.11, pts: k.ell(20, 0.23, 0.22) },
    { x: 0, y: 0.142, pts: k.ell(20, 0.13, 0.125) },
    { x: 0, y: 0.152, pts: k.ell(20, 0.04, 0.04) },
  ]));
  const band = geo('beret-band', () => k.loft([
    { x: 0, y: -0.005, pts: k.ell(18, 0.158, 0.148) },
    { x: 0, y: 0.022, pts: k.ell(18, 0.168, 0.158) },
  ], false, false));
  const stalk = geo('beret-stalk', () => new CylinderGeometry(0.6, 1, 1, 6));
  const g = crown(0.33, 0.16, 0.26);
  put(g, k.mesh(dome, mat(k, c0 === '#111111' ? '#1c1c1f' : c0, { rough: 0.92 })), V(-0.02, 0, 0));
  put(g, k.mesh(band, mat(k, c1), false), V(-0.02, 0, 0));
  put(g, k.mesh(stalk, mat(k, c1)), V(-0.02, 0.165, 0), undefined, V(0.014, 0.05, 0.014));
  return [{ at: 'head', obj: g }];
}

function laurel(k: Kit, c: string[]): Part[] {
  const [c0 = '#b39a5a', c1 = '#3f6b3a'] = c;
  const leaf = geo('laurel-leaf', () => k.loft([
    { x: 0, y: 0, pts: k.ell(4, 0.008, 0.004) },
    { x: 0.03, y: 0.002, pts: k.ell(4, 0.022, 0.005) },
    { x: 0.065, y: 0.003, pts: k.ell(4, 0.02, 0.005) },
    { x: 0.09, y: 0.0, pts: k.ell(4, 0.004, 0.002) },
  ]));
  const g = crown(0.25, 0.2, 0.04);
  const mA = mat(k, c0), mB = mat(k, c1);
  const rx = 0.205, rz = 0.18;
  // two branches tied at the back of the head, tips meeting over the brow
  for (const side of [1, -1] as const) {
    const N = 8;
    for (let i = 0; i < N; i++) {
      const a = Math.PI - (i / (N - 1)) * (Math.PI - 0.38); // back (PI) → front (0.38)
      const p = V(Math.cos(a) * rx, 0.012 * i, side * Math.sin(a) * rz);
      const tang = V(-Math.sin(a) * rx, 0.012, side * Math.cos(a) * rz).normalize().negate(); // towards the front
      for (const lr of [1, -1] as const) {
        const out = V(Math.cos(a), 0, side * Math.sin(a)).normalize();
        const dir = tang.clone().multiplyScalar(0.8).add(V(0, lr > 0 ? 0.55 : -0.25, 0)).addScaledVector(out, lr > 0 ? 0.15 : 0.35).normalize();
        const o = k.mesh(leaf, (i + (lr > 0 ? 0 : 1)) % 2 ? mB : mA);
        put(g, o, p.clone().addScaledVector(out, 0.014), qBasis(dir, out), 1.75 - 0.06 * Math.abs(i - 3.5));
      }
    }
  }
  // the knot at the back
  const tie = geo('laurel-tie', () => new CylinderGeometry(1, 1, 1, 6));
  put(g, k.mesh(tie, mA), V(-rx - 0.006, 0, 0), new Quaternion().setFromAxisAngle(Z, Math.PI / 2), V(0.02, 0.02, 0.02));
  return [{ at: 'head', obj: g }];
}

function headphones(k: Kit, c: string[]): Part[] {
  const [c0 = '#111111', c1 = '#b39a5a'] = c;
  const cup = geo('hp-cup', () => k.loft([
    { x: 0, y: 0.0, pts: k.ell(14, 0.07, 0.07) },
    { x: 0, y: 0.03, pts: k.ell(14, 0.088, 0.088) },
    { x: 0, y: 0.06, pts: k.ell(14, 0.084, 0.084) },
    { x: 0, y: 0.068, pts: k.ell(14, 0.05, 0.05) },
  ]));
  const cap = geo('hp-cap', () => new TorusGeometry(0.06, 0.012, 5, 16));
  const cx = -0.065, cy = 0.2, R = 0.25;
  const band = geo('hp-band', () => tube(lin(0.22, Math.PI - 0.22, 9).map((a) => V(cx, cy + R * Math.sin(a), R * Math.cos(a))), 0.015, 14, 5));
  const g = grp(V());
  const m0 = mat(k, c0), m1 = mat(k, c1);
  put(g, k.mesh(band, m1)); // thin gold band: reads as headphones, not as a helmet
  for (const side of [1, -1] as const) {
    const q = qFrom(Y, V(0, 0, side));
    put(g, k.mesh(cup, m0), V(cx, cy - 0.005, side * 0.168), q);
    put(g, k.mesh(cap, m1, false), V(cx, cy - 0.005, side * 0.236), qFrom(Z, V(0, 0, side)));
  }
  return [{ at: 'head', obj: g }];
}

function monocle(k: Kit, c: string[]): Part[] {
  const [c0 = '#b39a5a'] = c;
  const rim = geo('monocle-rim', () => new TorusGeometry(0.084, 0.014, 6, 20));
  const n = eyeOut(1);
  const ctr = EYE.clone().addScaledVector(n, 0.03);
  const chain = geo('monocle-chain', () => tube([
    ctr.clone().add(V(-0.03, -0.068, 0.0)), ctr.clone().add(V(-0.06, -0.13, -0.004)), V(-0.04, -0.12, 0.17), V(-0.09, -0.08, 0.175),
  ], 0.0045, 12, 4));
  const glint = geo('monocle-glint', () => new TorusGeometry(0.052, 0.006, 3, 8, 1.1));
  const g = grp(V());
  put(g, k.mesh(rim, mat(k, c0)), ctr, qFrom(Z, n));
  put(g, k.mesh(chain, mat(k, c0), false));
  put(g, k.mesh(glint, k.M.glint ?? k.M.white, false), ctr.clone().addScaledVector(n, 0.004), qFrom(Z, n).multiply(new Quaternion().setFromAxisAngle(Z, 1.9)));
  return [{ at: 'head', obj: g }];
}

function sunglasses(k: Kit, c: string[]): Part[] {
  const [c0 = '#111111', c1 = '#b39a5a'] = c;
  const lens = geo('sg-lens', () => new CylinderGeometry(0.074, 0.074, 0.012, 16));
  const rim = geo('sg-rim', () => new TorusGeometry(0.078, 0.016, 5, 18));
  const g = grp(V());
  const lm = mat(k, '#1d2128', { rough: 0.08, metal: 0.35 }), rm = mat(k, c1);
  const glint = geo('sg-glint', () => new TorusGeometry(0.05, 0.008, 3, 8, 1.1));
  const ends: Vector3[] = [];
  for (const side of [1, -1] as const) {
    const n = eyeOut(side), ctr = EYE.clone().setZ(EYE.z * side).addScaledVector(n, 0.036);
    put(g, k.mesh(lens, lm), ctr, qFrom(Y, n));
    put(g, k.mesh(rim, rm, false), ctr.clone().addScaledVector(n, 0.002), qFrom(Z, n));
    put(g, k.mesh(glint, k.M.glint ?? k.M.white, false), ctr.clone().addScaledVector(n, 0.008), qFrom(Z, n).multiply(new Quaternion().setFromAxisAngle(Z, 1.9)));
    ends.push(ctr);
    // temple arm back along the side of the head
    const arm = geo(`sg-arm-${side}`, () => tube([ctr.clone().add(V(-0.06, 0.02, -0.004 * side)), V(-0.05, 0.27, 0.19 * side), V(-0.15, 0.25, 0.165 * side)], 0.007, 6, 4));
    put(g, k.mesh(arm, rm, false));
  }
  // bridge over the base of the beak
  const bridge = geo('sg-bridge', () => tube([
    ends[0].clone().add(V(0.05, 0.03, -0.035)), V(0.24, 0.3, 0.0), ends[1].clone().add(V(0.05, 0.03, 0.035)),
  ], 0.009, 8, 4));
  put(g, k.mesh(bridge, rm, false));
  return [{ at: 'head', obj: g }];
}

/** hand items: held in the near wing's "hand" at the wrist. Wrist frame: primaries run along -X, the chord
 *  hangs down -Y, +Z is outward. `dir` is the stick's direction in that frame. */
const HOLD = V(-0.03, -0.01, 0.07);
const STICK = V(-0.28, 0.94, 0.22).normalize();

function baton(k: Kit, c: string[]): Part[] {
  const [c0 = '#ffffff', c1 = '#8a5a2b'] = c;
  const stick = geo('baton', () => k.loft([
    { x: 0, y: 0, pts: k.ell(6, 0.015, 0.015) },
    { x: 0.4, y: 0, pts: k.ell(6, 0.011, 0.011) },
    { x: 0.68, y: 0, pts: k.ell(6, 0.007, 0.007) },
  ]));
  const grip = geo('baton-grip', () => k.loft([
    { x: -0.07, y: 0, pts: k.ell(8, 0.016, 0.016) },
    { x: -0.05, y: 0, pts: k.ell(8, 0.026, 0.026) },
    { x: -0.01, y: 0, pts: k.ell(8, 0.02, 0.02) },
    { x: 0.02, y: 0, pts: k.ell(8, 0.013, 0.013) },
  ]));
  const g = grp(HOLD, qBasis(STICK, V(0, 0, 1)), 1.1);
  put(g, k.mesh(stick, mat(k, c0)));
  put(g, k.mesh(grip, mat(k, c1)));
  return [{ at: 'wrist', obj: g }];
}

function tuningFork(k: Kit, c: string[]): Part[] {
  const [c0 = '#3a3a3a'] = c;
  // brushed steel: graphite in the icon, lifted here so the fork reads as metal, not as a black stick
  const metal = mat(k, c0 === '#3a3a3a' ? '#a3a9b1' : c0, { rough: 0.3, metal: 0.75 });
  const stem = geo('fork-stem', () => k.loft([
    { x: -0.06, y: 0, pts: k.ell(6, 0.016, 0.016) },
    { x: -0.05, y: 0, pts: k.ell(6, 0.011, 0.011) },
    { x: 0.16, y: 0, pts: k.ell(6, 0.011, 0.011) },
  ]));
  // U-shaped fork: two tines joined by a half circle where the stem meets it
  const u = geo('fork-u', () => tube([
    V(0.4, 0.045, 0), V(0.2, 0.045, 0),
    ...lin(Math.PI / 2, 1.5 * Math.PI, 7).map((a) => V(0.2 + 0.045 * Math.cos(a), 0.045 * Math.sin(a), 0)),
    V(0.2, -0.045, 0), V(0.4, -0.045, 0),
  ], 0.0095, 24, 5));
  const g = grp(HOLD, qBasis(STICK, V(0, 0, 1)), 1.25);
  put(g, k.mesh(stem, metal));
  put(g, k.mesh(u, metal));
  return [{ at: 'wrist', obj: g }];
}

function operaGlasses(k: Kit, c: string[]): Part[] {
  const [c0 = '#b39a5a', c1 = '#111111'] = c;
  // lorgnette-style: a gold handle with the two little barrels on top, facing the viewer
  const handle = geo('og-handle', () => k.loft([
    { x: -0.05, y: 0, pts: k.ell(6, 0.014, 0.014) },
    { x: 0.18, y: 0, pts: k.ell(6, 0.01, 0.01) },
    { x: 0.22, y: 0, pts: k.ell(6, 0.014, 0.014) },
  ]));
  const barrel = geo('og-barrel', () => k.loft([
    { x: 0, y: 0, pts: k.ell(12, 0.042, 0.042) },
    { x: 0, y: 0.05, pts: k.ell(12, 0.038, 0.038) },
    { x: 0, y: 0.075, pts: k.ell(12, 0.05, 0.05) },
    { x: 0, y: 0.09, pts: k.ell(12, 0.05, 0.05) },
  ]));
  const ring = geo('og-ring', () => new TorusGeometry(0.043, 0.008, 4, 14));
  const g = grp(HOLD, qBasis(STICK, V(0, 0, 1)), 1.55);
  put(g, k.mesh(handle, mat(k, c0)));
  const head = grp(V(0.25, 0, 0));
  // barrels side by side, axes pointing out of the wing (towards the viewer)
  for (const s of [1, -1]) {
    put(head, k.mesh(barrel, mat(k, c1)), V(0.0, s * 0.052, -0.03), qFrom(Y, V(0, 0, 1)));
    put(head, k.mesh(ring, mat(k, c0), false), V(0.0, s * 0.052, 0.062), undefined);
  }
  g.add(head);
  return [{ at: 'wrist', obj: g }];
}

const BUILD: Record<string, Build> = {
  'bowtie-black': bowtie, 'bowtie-gold': bowtie, 'scarf-gold': scarf, 'kerchief-red': kerchief,
  'sailor-sweater': sweater, tailcoat, 'school-backpack': backpack,
  'top-hat': topHat, 'sailor-cap': sailorCap, 'jazz-beret': beret, laurel, headphones,
  monocle, 'round-sunglasses': sunglasses,
  baton, 'tuning-fork': tuningFork, 'opera-glasses': operaGlasses,
};

/** Build the parts for one catalog item, or null (unknown id / no model). */
export function buildItem(k: Kit, id: string): Part[] | null {
  const item = itemById(id);
  const b = BUILD[id];
  if (!item || !b) return null;
  return b(k, item.colors);
}

/** Normalise any outfit-ish input to { slot: id } for known, modelled items only. */
export function cleanOutfit(o: Outfit | null | undefined): Partial<Record<Slot, string>> {
  const out: Partial<Record<Slot, string>> = {};
  if (!o || typeof o !== 'object') return out;
  for (const s of SLOTS) {
    const id = o[s];
    if (typeof id === 'string' && BUILD[id] && itemById(id)?.slot === s) out[s] = id;
  }
  return out;
}
