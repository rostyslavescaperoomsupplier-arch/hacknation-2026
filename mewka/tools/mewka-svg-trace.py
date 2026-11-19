"""Dev tool (not shipped). Trace the 3D gull's rest pose (flat ID renders from __mw3d.trace) into the SVG rig for mewka-svg.ts.
Output: svg.txt (the inline SVG) + pivots.json. viewBox 0 0 48 48 = the 3D box; the renders cover -12..60."""
import json, sys, os
import numpy as np, cv2
from PIL import Image

D = sys.argv[1] if len(sys.argv) > 1 else '.'  # folder with meta.json + g_*.png from mewka-svg-grab.mjs
meta = json.load(open(f'{D}/meta.json'))
LAB = {k: np.array([int(v[i:i + 2], 16) for i in (1, 3, 5)]) for k, v in meta['labels'].items()}
PX = 1536
SC = 72 / PX
def vb(x, y): return x * SC - 12, y * SC - 12

def load(name):
    return np.array(Image.open(f'{D}/g_{name}.png').convert('RGBA')).astype(int)

def masks(img, names):
    a = img[..., 3] > 200
    rgb = img[..., :3]
    keys = [k for k in names if k in LAB]
    d = np.stack([np.abs(rgb - LAB[k]).sum(-1) for k in keys], -1)
    idx = d.argmin(-1); best = d.min(-1)
    out = {k: ((idx == i) & a & (best < 70)).astype(np.uint8) for i, k in enumerate(keys)}
    return out, (img[..., 3] > 127).astype(np.uint8)

def clean(m, k=3):
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    return cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))

def contours(m, min_area=60, eps=2.2):
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = []
    for c in cs:
        if cv2.contourArea(c) < min_area: continue
        a = cv2.approxPolyDP(c, eps, True)[:, 0, :]
        out.append((c[:, 0, :], a))
    return out

def fmt(v, nd=2):
    s = f'{v:.{nd}f}'.rstrip('0').rstrip('.')
    if s.startswith('0.'): s = s[1:]
    elif s.startswith('-0.'): s = '-' + s[2:]
    return s if s not in ('', '-') else '0'

def path(pts, closed=True, nd=2):
    p = [vb(*q) for q in pts]
    d = 'M' + fmt(p[0][0], nd) + ' ' + fmt(p[0][1], nd)
    for (x0, y0), (x1, y1) in zip(p, p[1:]):
        dx, dy = x1 - x0, y1 - y0
        d += 'l' + fmt(dx, nd) + ('' if fmt(dy, nd).startswith('-') else ' ') + fmt(dy, nd)
    return d + ('z' if closed else '')

def region_path(m, eps=2.2, min_area=60, nd=2):
    return ''.join(path(a, True, nd) for _, a in contours(m, min_area, eps))

def ellipse(m):
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs: return None
    c = max(cs, key=cv2.contourArea)
    if len(c) >= 5:
        (cx, cy), (w, h), ang = cv2.fitEllipse(c)
    else:
        (cx, cy), r = cv2.minEnclosingCircle(c); w = h = 2 * r; ang = 0
    x, y = vb(cx, cy)
    return x, y, w / 2 * SC, h / 2 * SC, ang

def ell_svg(e, cls='', id_=''):
    x, y, rx, ry, ang = e
    a = f' id="{id_}"' if id_ else ''
    c = f' class="{cls}"' if cls else ''
    if abs(rx - ry) < 0.04:
        return f'<circle{a}{c} cx="{fmt(x)}" cy="{fmt(y)}" r="{fmt((rx + ry) / 2)}"/>'
    return f'<ellipse{a}{c} cx="{fmt(x)}" cy="{fmt(y)}" rx="{fmt(rx)}" ry="{fmt(ry)}" transform="rotate({fmt(ang, 1)} {fmt(x)} {fmt(y)})"/>'

# ── colours: sample the lit renders (light + dark) inside each label region ──
lit = np.array(Image.open(f'{D}/g_lit.png').convert('RGBA')).astype(int)
litd = np.array(Image.open(f'{D}/g_lit_dark.png').convert('RGBA')).astype(int)
def sample(img, m, part=None):
    m = cv2.erode(m, np.ones((7, 7), np.uint8))
    ys, xs = np.nonzero(m)
    if part is not None and len(ys):
        lo, hi = np.percentile(ys, [part[0], part[1]])
        sel = (ys >= lo) & (ys <= hi); ys, xs = ys[sel], xs[sel]
    if not len(ys): return None
    px = img[ys, xs]
    px = px[px[:, 3] > 250]
    if not len(px): return None
    c = np.median(px[:, :3], 0).astype(int)
    return '#%02x%02x%02x' % tuple(c)

groups = {}
for g, names in {
    'farWing': ['mantle', 'covert', 'black', 'tip', 'mirror', 'tertial'],
    'tail': ['tail'], 'legs': ['leg'], 'body': ['body'],
    'nearWing': ['mantle', 'covert', 'black', 'tip', 'mirror', 'tertial'],
    'head': ['head', 'beakU', 'beakL', 'gonys', 'ring', 'orb', 'iris', 'pupil', 'glint', 'fring', 'forb', 'firis', 'fpupil', 'fglint'],
    'shadow': ['shadow'],
}.items():
    img = load(g)
    ms, sil = masks(img, names)
    groups[g] = (ms, clean(sil), img)

# union silhouette of the bird (no shadow), for the head's silhouette-only outline
union = np.zeros((PX, PX), np.uint8)
for g in ['farWing', 'tail', 'legs', 'body', 'nearWing', 'head']:
    union |= groups[g][1]
edge = cv2.morphologyEx(union, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
edge = cv2.dilate(edge, np.ones((7, 7), np.uint8))

def silhouette_runs(m, eps=2.2):
    """open polylines of m's contour that lie on the overall silhouette"""
    out = ''
    for full, _ in contours(m, 60, eps):
        on = edge[full[:, 1], full[:, 0]] > 0
        if on.all():
            out += path(cv2.approxPolyDP(full[:, None, :], eps, True)[:, 0, :], True); continue
        # rotate so the run starts at an off-silhouette point
        k = int(np.argmin(on)); full = np.roll(full, -k, 0); on = np.roll(on, -k)
        i = 0
        while i < len(full):
            if not on[i]: i += 1; continue
            j = i
            while j < len(full) and on[j]: j += 1
            run = full[max(0, i - 1):min(len(full), j + 1)]
            if len(run) > 6:
                a = cv2.approxPolyDP(run[:, None, :], eps, False)[:, 0, :]
                out += path(a, False)
            i = j
    return out

col = {}
def C(name, m, img=lit, part=None, fallback='#ffffff'):
    return sample(img, m, part) or fallback

fw, _, _ = groups['farWing']; nw, nsil, _ = groups['nearWing']
body_m = groups['body'][1]; head_ms, head_sil, _ = groups['head']
colors = {
    'body_top': C('body', body_m, part=(0, 30)), 'body_bot': C('body', body_m, part=(75, 100)),
    'head': C('head', head_ms['head'], part=(0, 60)),
    'mantle': C('mantle', nw['mantle']), 'covert': C('covert', nw['covert']), 'black': C('black', nw['black']),
    'beak': C('beak', head_ms['beakU']), 'leg': C('leg', groups['legs'][1]), 'orb': C('orb', head_ms['orb'], fallback='#e0913a'),
    'iris': C('iris', head_ms['iris'], fallback='#f2dc8c'),
    'tail': C('tail', groups['tail'][1]),
}
colors_dark = {
    'body_top': C('body', body_m, litd, (0, 30)), 'body_bot': C('body', body_m, litd, (75, 100)),
    'mantle': C('mantle', nw['mantle'], litd), 'covert': C('covert', nw['covert'], litd), 'head': C('head', head_ms['head'], litd, (0, 60)),
}
print('colors', colors, '\ndark', colors_dark, file=sys.stderr)

# ── assemble ──
def wing(ms, sil, full_stroke=True):
    s = f'<path class="mw-wg" d="{region_path(sil)}"/>'
    if ms['covert'].sum(): s += f'<path class="mw-cv" d="{region_path(clean(ms["covert"]), 1.6, 80)}"/>'
    blk = clean(ms['black'] | ms['tip'] | ms['mirror'])
    if blk.sum(): s += f'<path class="mw-bk" d="{region_path(blk, 1.6, 40)}"/>'
    wt = clean(ms['tip'] | ms['mirror'] | ms['tertial'], 2)
    if wt.sum(): s += f'<path class="mw-wt" d="{region_path(wt, 1.2, 25)}"/>'
    # soft seam where the wing lies on the body (the 3D bird shows it only by shading) + ink on the silhouette
    s += f'<path class="mw-sm" d="{region_path(sil)}"/><path class="mw-ln" d="{silhouette_runs(sil)}"/>'
    return s

hm = head_ms
eyeN = {k: ellipse(clean(hm[k], 2)) for k in ['ring', 'orb', 'iris', 'pupil', 'glint']}
eyeF = {k: ellipse(clean(hm['f' + k], 2)) if hm['f' + k].sum() > 20 else None for k in ['ring', 'orb', 'iris', 'pupil', 'glint']}
head_fill = clean(hm['head'] | hm['ring'] | hm['orb'] | hm['iris'] | hm['pupil'] | hm['glint'] | hm['fring'] | hm['forb'] | hm['firis'] | hm['fpupil'] | hm['fglint'])
beakU = clean(hm['beakU']); beakL = clean(hm['beakL'] | hm['gonys'])
gonys = ellipse(clean(hm['gonys'], 2)) if hm['gonys'].sum() > 10 else None

def eye(e, side):
    if not e['ring']: return ''
    x, y, rx, ry, _ = e['ring']
    s = f'<g id="mw-eye-{side}">' + ell_svg(e['ring'], 'mw-er')
    if e['orb']: s += ell_svg(e['orb'], 'mw-eo')
    if e['iris']: s += ell_svg(e['iris'], 'mw-ei')
    s += f'<g id="mw-pupil-{side}">' + (ell_svg(e['pupil'], 'mw-ep') if e['pupil'] else '')
    if e['glint']: s += ell_svg(e['glint'], 'mw-eg')
    s += '</g>'
    # lid: a head-coloured disc over the eye, scaled from the top edge (scaleY 0 = open … 1 = shut) + its lash line
    r = max(rx, ry) * 1.04
    s += (f'<g id="mw-lid-{side}"><circle class="mw-lid" cx="{fmt(x)}" cy="{fmt(y)}" r="{fmt(r)}"/>'
          f'<path class="mw-lash" d="M{fmt(x - r * .96)} {fmt(y + r * .1)}q{fmt(r * .96)} {fmt(r * .55)} {fmt(r * 1.92)} 0"/></g>')
    return s + '</g>', (x, y - r)

eN, lidN = eye(eyeN, 'l')
eF_s, lidF = eye(eyeF, 'r') if eyeF['ring'] else ('', None)

legs_m = groups['legs'][1]
tail_m = groups['tail'][1]
sh = groups['shadow'][1]
shE = ellipse(sh)

P = meta['pivots']
svg = ['<svg viewBox="0 0 48 48" focusable="false">',
       '<defs><linearGradient id="mw-gb" gradientUnits="userSpaceOnUse" x1="0" y1="20" x2="0" y2="40">'
       '<stop offset="0" stop-color="var(--mw-b1)"/><stop offset="1" stop-color="var(--mw-b2)"/></linearGradient>'
       '<radialGradient id="mw-gs"><stop offset="0" stop-color="var(--mw-sh)" stop-opacity=".4"/><stop offset=".55" stop-color="var(--mw-sh)" stop-opacity=".16"/><stop offset="1" stop-color="var(--mw-sh)" stop-opacity="0"/></radialGradient></defs>']
x, y, rx, ry, ang = shE
if 45 < ang % 180 < 135: rx, ry = ry, rx
svg.append(f'<ellipse id="mw-shadow" cx="{fmt(x)}" cy="{fmt(y)}" rx="{fmt(rx * .95)}" ry="{fmt(ry * .9)}" fill="url(#mw-gs)"/>')
svg.append('<g id="mw">')
svg.append(f'<g id="mw-legs"><path class="mw-lg" d="{region_path(legs_m, 1.4, 20)}"/></g>')
svg.append('<g id="mw-body">')
svg.append(f'<g id="mw-wing-r">{wing(*groups["farWing"][:2])}</g>')
svg.append(f'<path class="mw-tl" d="{region_path(tail_m, 1.6, 30)}"/><path class="mw-ln" d="{silhouette_runs(tail_m, 1.6)}"/>')
svg.append(f'<path class="mw-bd" d="{region_path(body_m)}"/><path class="mw-ln" d="{silhouette_runs(body_m)}"/>')
svg.append(f'<g id="mw-wing-l">{wing(*groups["nearWing"][:2])}</g>')
svg.append('<g id="mw-dots"><circle cx="41" cy="9" r=".9"/><circle cx="43.6" cy="6.6" r="1.1"/><circle cx="46.4" cy="4.2" r="1.3"/></g>')
svg.append('<g id="mw-head"><g class="mw-look">')
svg.append(f'<path class="mw-hd" d="{region_path(head_fill)}"/><path class="mw-ln" d="{silhouette_runs(head_fill)}"/>')
svg.append(f'<path id="mw-beak-top" class="mw-bkk" d="{region_path(beakU, 1.4, 20)}"/>')
svg.append(f'<g id="mw-beak-bottom"><path class="mw-bkk" d="{region_path(beakL, 1.4, 20)}"/>' + (ell_svg(gonys, 'mw-gy') if gonys else '') + '</g>')
svg.append(eN + eF_s)
svg.append('</g></g></g></g></svg>')
out = ''.join(svg)
open(f'{D}/svg.txt', 'w').write(out)
json.dump({'pivots': P, 'lidN': lidN, 'lidF': lidF, 'colors': colors, 'colors_dark': colors_dark}, open(f'{D}/pivots.json', 'w'), indent=1)
print(len(out), 'bytes', file=sys.stderr)

P2 = {k: [round(v[0], 2), round(v[1], 2)] for k, v in P.items()}
ts = ("// Mewka rig: one inline SVG shared by Mewka.astro and MewkaReact.tsx. GENERATED from the 3D gull's rest pose\n"
      "// (mewka3d.ts __mw3d.trace() + a dev tracer), so the fallback has the 3D bird's silhouette, framing and colours\n"
      "// and the SVG -> 3D swap is invisible. viewBox = the 3D box (the 3D canvas is 1.5x it). Pivots (mewka.css):\n"
      f"// neck {P2['neck'][0]} {P2['neck'][1]}, shoulder-l {P2['shoulderN'][0]} {P2['shoulderN'][1]}, shoulder-r {P2['shoulderF'][0]} {P2['shoulderF'][1]}, "
      f"beak hinge {P2['jaw'][0]} {P2['jaw'][1]}, feet {P2['feet'][0]} {P2['feet'][1]}.\n"
      "// Outline = silhouette only, like the 3D bird: wings, legs and beak are stroked in full; body, tail and head only\n"
      "// along the runs that are on the bird's outer silhouette (no seams at the neck or rump).\n"
      "export const MEWKA_SVG = `" + out + "`;\n")
open(f'{D}/mewka-svg.ts', 'w').write(ts)
