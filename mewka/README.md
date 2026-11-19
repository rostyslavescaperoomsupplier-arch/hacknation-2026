# Mewka

Animated seagull mascot pulled out of the Filharmonia Szczecin concept site. A procedural 3D herring gull (three.js, no model files), an SVG fallback traced from the 3D rest pose, and a gull voice synthesised with Web Audio.

## Run

```bash
cd mewka
npm install
npm run dev      # demo at http://localhost:5173
npm run build
```

## Use

```ts
import { mountMewka } from './src';

const bird = mountMewka(document.getElementById('perch')!, { size: 'xl', state: 'peek' });
bird.setState('greet');            // hidden peek idle listen-invite listening thinking talking pointing unsure happy greet
bird.lookAtPointer(true);          // head follows the mouse (desktop only)
bird.pointAt(someElement);         // wing points at an element
bird.setOutfit({ head: 'top-hat', neck: 'bowtie-gold' });   // ids in src/mewka/outfit.ts, 3D only
```

React: `src/mewka/MewkaReact.tsx` (`<MewkaReact state="thinking" size="lg" />`).

Sound: `playGull(ctx, ctx.destination, 'greet', ctx.currentTime)` from `src/audio/gull-synth.ts`.

## Files

| File | What it is |
|---|---|
| `src/mewka/mewka.ts` | Engine `createMewka(el)`: state machine, SVG gestures, hands off to 3D |
| `src/mewka/mewka.css` | Poses, sizes (`sm` 28, `md` 44, `lg` 72, `xl` 104 px), dark theme |
| `src/mewka/mewka-svg.ts` | Inline SVG rig (fallback) |
| `src/mewka/mewka3d-gate.ts` | Loads 3D lazily when the bird is visible and the browser is idle |
| `src/mewka/mewka3d.ts` | Procedural 3D gull + spring animation (three.js) |
| `src/mewka/mewka3d-outfit.ts`, `outfit.ts` | Clothes for the 3D bird |
| `src/audio/gull-synth.ts` | Gull sounds, Web Audio only |
| `tools/` | Dev tools that traced the 3D pose into the SVG |

No 3D (SVG instead) at size `sm`, with reduced motion, Save-Data, no WebGL2, `localStorage['fs-mascot']='off'` or `?mewka3d=0`. Theme colours come from `--c-paper` / `--c-ink` on `:root` and `data-theme="dark"`.
