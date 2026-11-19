// Hero <-> chat morph of the assistant home: one View Transition that moves and resizes the same elements
// (the big Mewka is never remounted). No View Transitions, reduced motion or a hidden tab: the change is instant.
import { flushSync } from 'react-dom';

type VTDoc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

const reduced = () =>
  document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

/** run a React state change; animate it as a View Transition when the browser can and the user wants motion */
export function morph(update: () => void) {
  const d = document as VTDoc;
  if (!d.startViewTransition || reduced() || document.hidden) { update(); return; }
  const root = document.documentElement;
  // the transition names are only set while morphing (html[data-asst-morph] in home.css)
  root.dataset.asstMorph = '';
  try {
    d.startViewTransition(() => flushSync(update)).finished.finally(() => { delete root.dataset.asstMorph; });
  } catch {
    delete root.dataset.asstMorph;
    update();
  }
}
