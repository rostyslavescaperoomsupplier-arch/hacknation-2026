// The on-screen keyboard. Most mobile browsers lay it over the page (the layout viewport keeps its height), so a
// sticky / fixed bottom bar would sit under it. While the keyboard is up this sets --kb (px of the layout viewport it
// covers) and data-kb on each tracked element, so CSS can lift the bar onto the keyboard's top edge; the focused field
// is then scrolled clear of that bar (the browser only clears the keyboard itself). Returns a cleanup function.
export function trackKeyboardInset(els: () => (HTMLElement | null)[]): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  let raf = 0;
  const update = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      const list = els().filter((x): x is HTMLElement => !!x);
      for (const el of list) {
        if (inset > 80) { el.style.setProperty('--kb', `${inset}px`); el.dataset.kb = ''; }
        else { el.style.removeProperty('--kb'); delete el.dataset.kb; }
      }
      if (inset <= 80) return;
      requestAnimationFrame(() => {
        const f = document.activeElement as HTMLElement | null;
        if (!f || !f.matches('input, select, textarea')) return;
        const bar = list.find((el) => el.getClientRects().length && !el.contains(f));
        if (!bar) return;
        // where the bar ends up on the keyboard edge (its own top may not have settled yet in this frame)
        const barTop = Math.min(bar.getBoundingClientRect().top, window.innerHeight - inset - bar.offsetHeight);
        const over = f.getBoundingClientRect().bottom + 12 - barTop;
        if (over > 0) window.scrollBy({ top: over });
      });
    });
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
  return () => { cancelAnimationFrame(raf); vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
}
