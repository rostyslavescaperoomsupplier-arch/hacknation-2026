// Tiny page-wide "audio bus": whoever makes sound claims it, so voices never talk over each other.
// Owners today: 'assistant' (its TTS answers), 'rhythm' (the nest mini-game round), 'mewka' (the gull voice).
// The registry lives on window, so separately bundled islands and scripts share one bus.
// Every change is also a window event 'fs-audio-bus' { owner, active }.

type Reg = Set<string>;
const W = (typeof window !== 'undefined' ? window : {}) as { __fsAudioBus?: Reg };
const reg = (): Reg => (W.__fsAudioBus ||= new Set());

function emit(owner: string, active: boolean) {
  try { dispatchEvent(new CustomEvent('fs-audio-bus', { detail: { owner, active } })); } catch { /* SSR */ }
}

export function claim(owner: string) {
  if (reg().has(owner)) return;
  reg().add(owner);
  emit(owner, true);
}

export function release(owner: string) {
  if (!reg().delete(owner)) return;
  emit(owner, false);
}

/** someone other than `self` holds the bus */
export function busyFor(self: string): boolean {
  for (const o of reg()) if (o !== self) return true;
  return false;
}

export function onBus(fn: (owner: string, active: boolean) => void): () => void {
  const h = (e: Event) => { const d = (e as CustomEvent).detail; fn(d.owner, d.active); };
  addEventListener('fs-audio-bus', h);
  return () => removeEventListener('fs-audio-bus', h);
}
