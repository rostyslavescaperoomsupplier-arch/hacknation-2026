// Mewka: standalone seagull mascot (extracted from the Filharmonia Szczecin concept site).
import { MEWKA_SVG } from './mewka/mewka-svg';
import { createMewka, type MewkaApi, type MewkaState } from './mewka/mewka';
import './mewka/mewka.css';

export { MEWKA_SVG, createMewka };
export type { MewkaApi, MewkaState };
export type { Outfit, Slot } from './mewka/outfit';
export { playGull, MEWKA as MEWKA_VOICE, LENGTH as GULL_LENGTH, type GullSound } from './audio/gull-synth';

export type MewkaSize = 'sm' | 'md' | 'lg' | 'xl';

/** Put a bird into `host` (appends a <span class="mewka">) and start the engine. */
export function mountMewka(host: HTMLElement, opts: { size?: MewkaSize; state?: MewkaState } = {}): MewkaApi {
  const el = document.createElement('span');
  el.className = `mewka mewka--${opts.size ?? 'lg'}`;
  el.dataset.state = opts.state ?? 'idle';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = MEWKA_SVG;
  host.append(el);
  return createMewka(el);
}
