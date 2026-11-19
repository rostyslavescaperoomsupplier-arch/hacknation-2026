// The four big shortcuts of the assistant home (56 px targets, two columns on phones).
// Glyphs are drawn here (no icon library); colour is never the only cue, every button has its words.
import type { QuickAction } from '../i18n';

const GLYPH: Record<QuickAction['id'], string[]> = {
  // flame
  fire: ['M12 21c-3.7 0-6.5-2.6-6.5-6.2 0-3.4 2.4-5.3 3.7-7.8.4 1.7 1.2 2.8 2.4 3.4.3-3 1.6-5.6 3.7-7.4-.2 2.9.8 4.8 2 6.4 1.1 1.5 1.7 2.9 1.7 4.6 0 4-2.9 7-7 7Z',
    'M12 21c-1.6 0-2.8-1.1-2.8-2.7 0-1.6 1.2-2.5 2-3.9.9 1.4 3.6 2.2 3.6 4.1 0 1.5-1.2 2.5-2.8 2.5Z'],
  // bell with sound arcs
  alarm: ['M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5Z', 'M10 21h4', 'M3.2 9.5A9.5 9.5 0 0 1 5.4 5', 'M20.8 9.5A9.5 9.5 0 0 0 18.6 5'],
  // walking arrow toward a flag (muster station), same glyph as the route action in the chat
  route: ['M3 18h9.5', 'M9.5 15l3 3-3 3', 'M17 20V4', 'M17 4.5h4.5l-1.5 2.5 1.5 2.5H17'],
  // map pin
  where: ['M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z', 'M12 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z'],
};

export interface QuickActionsProps {
  items: QuickAction[];
  title: string;
  disabled?: boolean;
  onPick(a: QuickAction): void;
  /** pointer / keyboard is on a shortcut: the big Mewka can point at it */
  onAim?(el: HTMLElement): void;
}

export default function QuickActions({ items, title, disabled, onPick, onAim }: QuickActionsProps) {
  return (
    <section aria-labelledby="asst-qa-h" className="asst-qa-wrap">
      <h2 id="asst-qa-h" className="tech-kicker sr-only">{title}</h2>
      <ul className="asst-qa">
        {items.map((a, i) => (
          <li key={a.id} style={{ ['--i' as string]: i }}>
            <button type="button" className="asst-qa-btn" data-kind={a.id} disabled={disabled}
                    onClick={() => onPick(a)}
                    onPointerEnter={(e) => { if (e.pointerType === 'mouse') onAim?.(e.currentTarget); }}
                    onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) onAim?.(e.currentTarget); }}>
              <svg className="asst-qa-ic" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                {GLYPH[a.id].map((d) => <path key={d} d={d} />)}
              </svg>
              <span className="min-w-0">
                <span className="asst-qa-label">{a.label}</span>
                <span className="asst-qa-sub">{a.sub}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
