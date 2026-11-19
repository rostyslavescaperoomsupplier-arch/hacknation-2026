// Dev tool: grab flat ID renders of the 3D gull's rest pose for mewka-svg-trace.py.
// Needs the dev server (astro dev) and Playwright from a scratch install, NOT site/node_modules:
//   PW=/path/to/scratch/node_modules node mewka-svg-grab.mjs /tmp/mewka-trace
//   python3 mewka-svg-trace.py /tmp/mewka-trace   (numpy, opencv-python, pillow)  ->  /tmp/mewka-trace/mewka-svg.ts
// Then copy mewka-svg.ts here and update the pivots in mewka.css / SHOULDER in mewka.ts from pivots.json.
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire((process.env.PW || '.') + '/');
const { chromium } = require('playwright');
const OUT = (process.argv[2] || '.') + '/';
const URL = process.env.URL || 'http://localhost:4321/mewka-lab/';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const theme of ['light', 'dark']) {
  const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
  await p.goto(`${URL}?mwqa=1&theme=${theme}`);
  await p.waitForFunction(() => window.__mw3d && document.querySelectorAll('#solo canvas.mw3d').length >= 4, null, { timeout: 90000 });
  await p.evaluate(() => window.__mw3d.step(300, 10));
  const t = await p.evaluate(() => window.__mw3d.trace(1536)); // largest bird, rest pose, viewBox -12..60
  if (theme === 'light') {
    for (const [k, v] of Object.entries(t.images)) fs.writeFileSync(`${OUT}g_${k}.png`, Buffer.from(v.split(',')[1], 'base64'));
    fs.writeFileSync(`${OUT}meta.json`, JSON.stringify({ labels: t.labels, pivots: t.pivots }, null, 1));
  } else fs.writeFileSync(`${OUT}g_lit_dark.png`, Buffer.from(t.images.lit.split(',')[1], 'base64'));
  await p.close();
}
await b.close();
