// Imperative three.js view behind ShipPanel: one renderer, lazily loaded GLB models, picking by room group,
// ghosted hull + glowing route for the evacuation mode. React only calls the public methods.
import {
  ACESFilmicToneMapping, AdditiveBlending, Box3, BoxGeometry, Color, ConeGeometry, CylinderGeometry, DirectionalLight,
  Group, HemisphereLight, InstancedMesh, LineCurve3, Material, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Object3D, PerspectiveCamera, PMREMGenerator, Quaternion, Raycaster, Scene, Sphere, SphereGeometry, SRGBColorSpace,
  TubeGeometry, CurvePath, Vector2, Vector3, WebGLRenderer, type BufferGeometry,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Box, Vec3 } from './routes';

export type ModelKey = 'full' | 'cabins' | 'engine';
export const MODEL_URL: Record<ModelKey, string> = {
  full: '/models/ship.glb',
  cabins: '/models/ship-cabins.glb',
  engine: '/models/ship-engine.glb',
};

export interface ViewCallbacks {
  onHover(group: string | null): void;
  onPick(group: string | null): void;
  /** 0..100, or -1 = unknown size (bytes in `loaded`), null = done */
  onProgress(pct: number | null, loaded?: number): void;
  onError(msg: string): void;
}

export interface RouteDraw {
  points: Vec3[];
  start: Vec3;
  musters: Vec3[];
  /** one per muster marker (port, starboard) */
  musterLabels: string[];
  startLabel: string;
  blockedBox: Box | null;
  blockedLabel: string;
  zoneGroups: string[];
}

interface Loaded { root: Group; groups: Map<string, Mesh[]>; boxes: Map<string, Box3>; box: Box3 }

type Kind = 'hl' | 'ghost' | 'ghost2' | 'zone' | 'crit' | 'warn';
export type AlertLevel = 'critical' | 'warning';
const GHOST_KEEP = new Set(['Lifeboats', 'Liferafts']);
const GHOST_STRONG = new Set(['Stairwell -29', 'Stairwell 22', 'Engineering stairs', 'Bridge stairs', 'Engine 1', 'Engine 2', 'Engine 3', 'Engine 4']);
const ROUTE_LIFT = 0.9;

function cssColor(name: string, fallback: string): Color {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return new Color(v || fallback);
  } catch { return new Color(fallback); }
}

export class ShipView {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(38, 1, 0.5, 3000);
  private controls: OrbitControls;
  private pmrem: PMREMGenerator;
  private loader = new GLTFLoader();
  private cache = new Map<ModelKey, Promise<Loaded>>();
  private active: Loaded | null = null;
  private activeKey: ModelKey | null = null;
  private wanted: ModelKey | null = null;
  private matCache = new Map<string, Material>();
  private ghost = false;
  private hover: string | null = null;
  private selected: string | null = null;
  private zoneGroups = new Set<string>();
  private alertGroups = new Map<string, AlertLevel>();
  private anchorLayer: HTMLElement | null = null;
  private anchorFilter: ((at: Vector3) => boolean) | null = null;
  private routeGroup = new Group();
  private arrows: InstancedMesh | null = null;
  private routePts: Vector3[] = [];
  private routeCum: number[] = [];
  private labels: { el: HTMLElement; pos: Vector3 }[] = [];
  private overlay: HTMLDivElement;
  private raf = 0;
  private running = false;
  private dirty = true;
  private visible = true;
  private last = 0;
  private offset = 0;
  private pendingPointer: { x: number; y: number } | null = null;
  private down: { x: number; y: number } | null = null;
  private ro: ResizeObserver;
  private io: IntersectionObserver;
  private raycaster = new Raycaster();
  private framedRoute = false;
  private disposed = false;

  readonly host: HTMLElement;
  private cb: ViewCallbacks;
  private reduced: boolean;

  constructor(host: HTMLElement, cb: ViewCallbacks, reducedMotion: boolean) {
    this.host = host;
    this.cb = cb;
    this.reduced = reducedMotion;
    const r = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.setClearColor(0x000000, 0);
    r.domElement.setAttribute('aria-hidden', 'true');
    r.domElement.style.display = 'block';
    r.domElement.style.touchAction = 'none';
    host.appendChild(r.domElement);
    this.renderer = r;

    this.overlay = document.createElement('div');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    host.appendChild(this.overlay);

    this.pmrem = new PMREMGenerator(r);
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new HemisphereLight(0xeaf3f8, 0x2a3a44, 0.9));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);
    this.scene.add(this.routeGroup);

    this.camera.position.set(180, 90, 120);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 600;
    this.controls.maxPolarAngle = Math.PI * 0.95;
    this.controls.addEventListener('change', () => { this.dirty = true; });

    const el = r.domElement;
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointerleave', this.onLeave);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.io = new IntersectionObserver((e) => { this.visible = e[0]?.isIntersecting ?? true; this.updateRunning(); });
    this.io.observe(host);
    document.addEventListener('visibilitychange', this.updateRunning);
    this.resize();
    this.updateRunning();
  }

  // ---------- models ----------
  private load(key: ModelKey): Promise<Loaded> {
    let p = this.cache.get(key);
    if (!p) {
      p = new Promise<Loaded>((resolve, reject) => {
        this.cb.onProgress(0);
        this.loader.load(MODEL_URL[key], (gltf) => {
          const root = gltf.scene;
          const groups = new Map<string, Mesh[]>();
          const boxes = new Map<string, Box3>();
          root.updateMatrixWorld(true);
          root.traverse((o) => {
            const mesh = o as Mesh;
            if (!mesh.isMesh) return;
            const g = (o.name || '').split(' / ')[0].replace(/_/g, ' ').trim() || 'Ship';
            mesh.userData.group = g;
            mesh.userData.orig = mesh.material;
            const list = groups.get(g) ?? [];
            list.push(mesh);
            groups.set(g, list);
            const b = boxes.get(g) ?? new Box3();
            b.expandByObject(mesh);
            boxes.set(g, b);
          });
          resolve({ root, groups, boxes, box: new Box3().setFromObject(root) });
        }, (ev) => {
          if (this.wanted !== key) return;
          if (ev.total) this.cb.onProgress(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
          else this.cb.onProgress(-1, ev.loaded);
        }, (err) => { this.cache.delete(key); reject(err); });
      });
      this.cache.set(key, p);
    }
    return p;
  }

  async setModel(key: ModelKey): Promise<void> {
    this.wanted = key;
    try {
      const m = await this.load(key);
      if (this.disposed || this.wanted !== key) return;
      if (this.active) this.scene.remove(this.active.root);
      const first = this.activeKey === null;
      this.active = m;
      this.activeKey = key;
      this.scene.add(m.root);
      this.hover = null;
      this.selected = null;
      this.applyMaterials();
      this.cb.onProgress(null);
      if (this.routePts.length && this.ghost) { if (!this.framedRoute) this.frameRoute(); }
      else if (first || !this.ghost) this.frameModel();
      this.dirty = true;
    } catch (e) {
      if (this.wanted === key) { this.cb.onProgress(null); this.cb.onError(String((e as Error)?.message ?? e)); }
    }
  }

  groupBox(name: string): Box3 | null { return this.active?.boxes.get(name) ?? null; }

  frameModel() {
    if (!this.active) return;
    const b = this.active.box;
    this.fit(b, new Vector3(1, 0.55, 0.85));
  }

  private fit(b: Box3, dir: Vector3) {
    const c = b.getCenter(new Vector3());
    const r = b.getBoundingSphere(new Sphere()).radius;
    const vf = (this.camera.fov * Math.PI) / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
    const dist = (r / Math.sin(Math.min(vf, hf) / 2)) * 0.92;
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(dir.normalize().multiplyScalar(dist));
    this.camera.near = Math.max(0.3, dist / 400);
    this.camera.far = dist * 10 + 500;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.dirty = true;
  }

  // ---------- materials ----------
  private variant(orig: Material, kind: Kind): Material {
    const key = `${orig.uuid}|${kind}`;
    let m = this.matCache.get(key);
    if (m) return m;
    m = orig.clone();
    const std = m as MeshStandardMaterial;
    if (kind === 'crit' || kind === 'warn') {
      if (std.emissive) { std.emissive = kind === 'crit' ? cssColor('--c-danger', '#c62828') : cssColor('--c-gold', '#e8590c'); std.emissiveIntensity = kind === 'crit' ? 0.6 : 0.4; }
      if (std.color) std.color = std.color.clone().lerp(kind === 'crit' ? cssColor('--c-danger', '#c62828') : cssColor('--c-gold', '#e8590c'), 0.35);
    } else if (kind === 'hl' || kind === 'zone') {
      if (std.emissive) { std.emissive = cssColor('--c-gold', '#e8590c'); std.emissiveIntensity = kind === 'hl' ? 0.55 : 0.45; }
      if (kind === 'zone' && this.ghost) { m.transparent = true; m.opacity = 0.55; m.depthWrite = false; }
    } else {
      m.transparent = true;
      m.opacity = kind === 'ghost2' ? 0.4 : 0.1;
      m.depthWrite = false;
    }
    this.matCache.set(key, m);
    return m;
  }

  private applyMaterials() {
    const a = this.active;
    if (!a) return;
    for (const [g, meshes] of a.groups) {
      let kind: Kind | null = null;
      if (this.ghost) {
        if (this.zoneGroups.has(g)) kind = 'zone';
        else if (GHOST_KEEP.has(g)) kind = null;
        else if (GHOST_STRONG.has(g)) kind = 'ghost2';
        else kind = 'ghost';
      } else if (g === this.hover || g === this.selected || this.zoneGroups.has(g)) kind = 'hl';
      else if (this.alertGroups.has(g)) kind = this.alertGroups.get(g) === 'critical' ? 'crit' : 'warn';
      for (const mesh of meshes) {
        const orig = mesh.userData.orig as Material | Material[];
        if (!kind) { mesh.material = orig; continue; }
        mesh.material = Array.isArray(orig) ? orig.map((o) => this.variant(o, kind)) : this.variant(orig, kind);
      }
    }
    this.dirty = true;
  }

  setGhost(on: boolean) {
    if (this.ghost === on) return;
    this.ghost = on;
    // zone tint depends on ghost: drop cached zone variants
    for (const k of [...this.matCache.keys()]) if (k.endsWith('|zone')) { this.matCache.get(k)?.dispose(); this.matCache.delete(k); }
    this.hover = null;
    this.applyMaterials();
  }

  setSelected(group: string | null) { this.selected = group; this.applyMaterials(); }

  /** model mode: highlight a set of groups (a zone) */
  setZoneGroups(groups: string[]) { this.zoneGroups = new Set(groups); this.applyMaterials(); }

  /** model mode: tint groups with crew safety alerts (hover / selection / zone highlight win) */
  setAlertGroups(m: Map<string, AlertLevel>) {
    const same = m.size === this.alertGroups.size && [...m].every(([k, v]) => this.alertGroups.get(k) === v);
    if (same) return;
    this.alertGroups = new Map(m);
    this.applyMaterials();
  }

  /** HTML elements inside `layer` with data-at="x,y,z" are kept on their projected 3D point (screen-space markers).
   *  data-anchor="bottom" puts the point under the element (badges), otherwise centred; data-nudge="1" elements avoid
   *  overlapping each other. `filter` hides points (e.g. outside the loaded cutaway model). */
  setAnchorLayer(layer: HTMLElement | null, filter: ((at: Vector3) => boolean) | null = null) {
    this.anchorLayer = layer;
    this.anchorFilter = filter;
    this.dirty = true;
  }
  /** call after the markers in the layer changed */
  refreshAnchors() { this.dirty = true; }

  frameBox(b: Box) {
    const box = new Box3(new Vector3(...b.min), new Vector3(...b.max)).expandByScalar(4);
    this.fit(box, new Vector3(1, 0.9, 0.5));
  }

  // ---------- picking ----------
  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || this.ghost) return;
    this.pendingPointer = { x: e.clientX, y: e.clientY };
    this.dirty = true;
  };
  private onDown = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY }; };
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || this.ghost || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
    const g = this.pick(e.clientX, e.clientY);
    this.selected = g;
    this.applyMaterials();
    this.cb.onPick(g);
  };
  private onLeave = () => {
    this.pendingPointer = null;
    if (this.hover !== null) { this.hover = null; this.applyMaterials(); this.cb.onHover(null); }
  };

  private pick(cx: number, cy: number): string | null {
    if (!this.active) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    const hit = this.raycaster.intersectObject(this.active.root, true).find((h) => (h.object as Mesh).isMesh && h.object.visible);
    return (hit?.object.userData.group as string | undefined) ?? null;
  }

  // ---------- route ----------
  clearRoute() {
    this.disposeTree(this.routeGroup);
    this.routeGroup.clear();
    this.arrows = null;
    this.routePts = [];
    this.routeCum = [];
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    this.zoneGroups = new Set();
    this.applyMaterials();
  }

  showRoute(r: RouteDraw) {
    this.clearRoute();
    this.zoneGroups = new Set(r.zoneGroups);
    const ok = cssColor('--c-ok', '#1d7a4c');
    const orange = cssColor('--c-gold', '#e8590c');
    const red = cssColor('--c-danger', '#c62828');
    const pts = r.points.map((p) => new Vector3(p[0], p[1] + ROUTE_LIFT, p[2]));
    this.routePts = pts;
    this.routeCum = [0];
    const path = new CurvePath<Vector3>();
    for (let i = 1; i < pts.length; i++) {
      path.add(new LineCurve3(pts[i - 1], pts[i]));
      this.routeCum.push(this.routeCum[i - 1] + pts[i - 1].distanceTo(pts[i]));
    }
    const total = this.routeCum[this.routeCum.length - 1] || 1;
    const segs = Math.max(64, Math.round(total * 2));
    const core = new Mesh(new TubeGeometry(path, segs, 0.32, 8, false), new MeshBasicMaterial({ color: ok, toneMapped: false }));
    core.renderOrder = 10;
    const glow = new Mesh(new TubeGeometry(path, segs, 0.9, 10, false),
      new MeshBasicMaterial({ color: ok, transparent: true, opacity: 0.28, depthWrite: false, blending: AdditiveBlending, toneMapped: false }));
    glow.renderOrder = 11;
    this.routeGroup.add(core, glow);

    // direction arrows
    const n = Math.max(2, Math.floor(total / 5));
    const cone = new ConeGeometry(0.75, 1.8, 12);
    cone.rotateX(Math.PI / 2); // point along +Z
    const arrows = new InstancedMesh(cone, new MeshBasicMaterial({ color: new Color(0xffffff).lerp(ok, 0.25), toneMapped: false, depthTest: false }), n);
    arrows.renderOrder = 12;
    arrows.frustumCulled = false;
    this.arrows = arrows;
    this.routeGroup.add(arrows);
    this.offset = 0;
    this.placeArrows();

    // start marker (orange)
    const start = new Vector3(r.start[0], r.start[1] + ROUTE_LIFT, r.start[2]);
    const ball = new Mesh(new SphereGeometry(1.3, 24, 16), new MeshBasicMaterial({ color: orange, toneMapped: false }));
    ball.position.copy(start);
    ball.renderOrder = 13;
    this.routeGroup.add(ball);
    this.label(r.startLabel, start, 'start');

    // muster markers (green discs + pole), both sides
    r.musters.forEach((m, i) => {
      const p = new Vector3(m[0], m[1], m[2]);
      const disc = new Mesh(new CylinderGeometry(3, 3, 0.25, 32), new MeshBasicMaterial({ color: ok, transparent: true, opacity: 0.75, toneMapped: false }));
      disc.position.copy(p).add(new Vector3(0, 0.15, 0));
      const pole = new Mesh(new CylinderGeometry(0.18, 0.18, 5, 8), new MeshBasicMaterial({ color: ok, toneMapped: false }));
      pole.position.copy(p).add(new Vector3(0, 2.5, 0));
      const flag = new Mesh(new BoxGeometry(0.1, 1.4, 2.2), new MeshBasicMaterial({ color: ok, toneMapped: false }));
      flag.position.copy(p).add(new Vector3(0, 4.3, 1.1));
      this.routeGroup.add(disc, pole, flag);
      this.label(r.musterLabels[i] ?? r.musterLabels[0], p.clone().add(new Vector3(0, 5.5, 0)), 'muster');
    });

    // blocked stairwell: red box + X
    if (r.blockedBox) {
      const b = r.blockedBox;
      const size = new Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const c = new Vector3((b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2);
      const box = new Mesh(new BoxGeometry(size.x, size.y, size.z),
        new MeshBasicMaterial({ color: red, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }));
      box.position.copy(c);
      this.routeGroup.add(box);
      const xMat = new MeshBasicMaterial({ color: red, toneMapped: false, depthTest: false });
      const diag = Math.hypot(size.y, size.z);
      for (const sgn of [1, -1]) {
        // X on the starboard face of the stairwell (the side the camera looks from)
        const bar = new Mesh(new BoxGeometry(0.5, diag * 0.9, 0.9), xMat);
        bar.position.set(b.max[0] + 0.4, c.y, c.z);
        bar.rotation.x = sgn * Math.atan2(size.z, size.y);
        bar.renderOrder = 14;
        this.routeGroup.add(bar);
      }
      this.label(r.blockedLabel, new Vector3(c.x, b.max[1] + 2, c.z), 'blocked');
    }

    this.applyMaterials();
    this.framedRoute = false;
    if (this.active) this.frameRoute();
    this.dirty = true;
  }

  frameRoute() {
    if (!this.routePts.length) return;
    const b = new Box3().setFromPoints(this.routePts);
    b.expandByScalar(6);
    this.fit(b, new Vector3(1, 0.62, 0.3));
    this.framedRoute = true;
  }

  private label(text: string, pos: Vector3, kind: 'start' | 'muster' | 'blocked') {
    const el = document.createElement('div');
    el.textContent = text;
    const bg = kind === 'start' ? 'var(--c-gold-ink)' : kind === 'muster' ? 'var(--c-ok)' : 'var(--c-danger)';
    el.style.cssText = `position:absolute;left:0;top:0;transform:translate(-50%,-100%);white-space:nowrap;font:700 13px/1.2 var(--font-sans, system-ui);` +
      `letter-spacing:.04em;text-transform:uppercase;color:var(--c-on-strong, #fff);background:${bg};padding:4px 8px;border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,.25)`;
    this.overlay.appendChild(el);
    this.labels.push({ el, pos });
  }

  private placeArrows() {
    const a = this.arrows;
    if (!a || this.routePts.length < 2) return;
    const total = this.routeCum[this.routeCum.length - 1];
    const step = total / a.count;
    const m = new Matrix4(), q = new Quaternion(), p = new Vector3(), dir = new Vector3(), one = new Vector3(1, 1, 1), z = new Vector3(0, 0, 1);
    let seg = 0;
    for (let i = 0; i < a.count; i++) {
      const s = (i * step + this.offset) % total;
      seg = 0;
      while (seg < this.routeCum.length - 2 && this.routeCum[seg + 1] < s) seg++;
      const p0 = this.routePts[seg], p1 = this.routePts[seg + 1];
      const segLen = this.routeCum[seg + 1] - this.routeCum[seg] || 1;
      p.copy(p0).lerp(p1, (s - this.routeCum[seg]) / segLen);
      dir.subVectors(p1, p0).normalize();
      q.setFromUnitVectors(z, dir);
      m.compose(p, q, one);
      a.setMatrixAt(i, m);
    }
    a.instanceMatrix.needsUpdate = true;
  }

  // ---------- loop ----------
  private updateRunning = () => {
    const should = this.visible && !document.hidden && !this.disposed;
    if (should && !this.running) { this.running = true; this.last = performance.now(); this.raf = requestAnimationFrame(this.tick); }
    else if (!should && this.running) { this.running = false; cancelAnimationFrame(this.raf); }
  };

  private tick = (t: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (this.controls.update()) this.dirty = true;
    if (this.arrows && !this.reduced) {
      this.offset += dt * 4;
      this.placeArrows();
      this.dirty = true;
    }
    if (this.pendingPointer) {
      const g = this.pick(this.pendingPointer.x, this.pendingPointer.y);
      this.pendingPointer = null;
      if (g !== this.hover) { this.hover = g; this.applyMaterials(); this.cb.onHover(g); }
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    this.placeAnchors();
  };

  private anchorPos = new WeakMap<Element, { src: string; v: Vector3 }>();
  private placeAnchors() {
    const layer = this.anchorLayer;
    if (!layer) return;
    const w = this.host.clientWidth, h = this.host.clientHeight, v = new Vector3();
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const items = layer.querySelectorAll<HTMLElement>('[data-at]');
    const nudge: { el: HTMLElement; x: number; y: number; w: number; h: number }[] = [];
    for (const el of items) {
      const src = el.dataset.at ?? '';
      let c = this.anchorPos.get(el);
      if (!c || c.src !== src) {
        const [x, y, z] = src.split(',').map(Number);
        c = { src, v: new Vector3(x, y, z) };
        this.anchorPos.set(el, c);
      }
      v.copy(c.v).project(this.camera);
      const off = v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.15 || Math.abs(v.y) > 1.15 || (this.anchorFilter ? !this.anchorFilter(c.v) : false);
      if (off) { el.style.visibility = 'hidden'; continue; }
      el.style.visibility = '';
      const ew = el.offsetWidth, eh = el.offsetHeight;
      const x = ((v.x + 1) / 2) * w - ew / 2;
      const y = ((1 - v.y) / 2) * h - (el.dataset.anchor === 'bottom' ? eh : eh / 2);
      if (el.dataset.nudge) nudge.push({ el, x, y, w: ew, h: eh });
      else el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
    // greedy: badges further down the screen first stay put, the others step up until free
    nudge.sort((a, b) => b.y - a.y);
    for (const n of nudge) {
      let y = n.y;
      for (let i = 0; i < 12; i++) {
        const hit = placed.find((p) => n.x < p.x + p.w + 2 && n.x + n.w + 2 > p.x && y < p.y + p.h + 2 && y + n.h + 2 > p.y);
        if (!hit) break;
        y = hit.y - n.h - 3;
      }
      placed.push({ x: n.x, y, w: n.w, h: n.h });
      n.el.style.transform = `translate(${Math.round(n.x)}px, ${Math.round(y)}px)`;
    }
  }

  private placeLabels() {
    if (!this.labels.length) return;
    const w = this.host.clientWidth, h = this.host.clientHeight, v = new Vector3();
    for (const l of this.labels) {
      v.copy(l.pos).project(this.camera);
      const hidden = v.z > 1 || v.z < -1;
      l.el.style.display = hidden ? 'none' : '';
      l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  setReducedMotion(r: boolean) { this.reduced = r; if (r) { this.offset = 0; this.placeArrows(); } this.dirty = true; }

  private disposeTree(o: Object3D) {
    o.traverse((c) => {
      const m = c as Mesh;
      if (!m.isMesh) return;
      (m.geometry as BufferGeometry | undefined)?.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) mat?.dispose();
    });
  }

  dispose() {
    this.disposed = true;
    this.updateRunning();
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
    document.removeEventListener('visibilitychange', this.updateRunning);
    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointerleave', this.onLeave);
    this.controls.dispose();
    this.clearRoute();
    for (const m of this.matCache.values()) m.dispose();
    this.matCache.clear();
    for (const p of this.cache.values()) p.then((l) => this.disposeTree(l.root), () => {});
    this.scene.environment?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    el.remove();
    this.overlay.remove();
  }
}
