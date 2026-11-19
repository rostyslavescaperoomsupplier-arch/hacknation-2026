import { mountMewka, playGull, GULL_LENGTH, type MewkaState, type GullSound } from './index';

const stage = document.getElementById('stage')!;
const big = mountMewka(stage, { size: 'xl', state: 'peek' });
mountMewka(stage, { size: 'lg', state: 'idle' }).lookAtPointer(true);
mountMewka(stage, { size: 'sm', state: 'idle' });
big.lookAtPointer(true);

const btn = (parent: string, label: string, on: () => void) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = on;
  document.getElementById(parent)!.append(b);
};

const STATES: MewkaState[] = ['hidden', 'peek', 'idle', 'listen-invite', 'listening', 'thinking', 'talking', 'pointing', 'unsure', 'happy', 'greet'];
STATES.forEach((s) => btn('states', s, () => big.setState(s)));

let ctx: AudioContext | null = null;
(Object.keys(GULL_LENGTH) as GullSound[]).forEach((s) =>
  btn('sounds', s, () => {
    ctx ??= new AudioContext();
    playGull(ctx, ctx.destination, s, ctx.currentTime + 0.02);
  }),
);

document.getElementById('theme')!.onclick = () => {
  const r = document.documentElement;
  r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark';
};
document.getElementById('point')!.onclick = () => big.pointAt(document.getElementById('target'));
