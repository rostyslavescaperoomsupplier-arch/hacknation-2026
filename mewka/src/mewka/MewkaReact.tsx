import { useEffect, useRef } from 'react';
import { MEWKA_SVG } from './mewka-svg';
import { createMewka, type MewkaApi, type MewkaState } from './mewka';
import type { Outfit } from './outfit';

export interface MewkaReactProps {
  state?: MewkaState;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  /** optional: element the wing aims at while state is 'pointing' (default: down-right) */
  pointTarget?: Element | null;
  /** optional: receive the engine (pointAt, lookAtPointer) once mounted */
  onReady?: (api: MewkaApi) => void;
  /** optional: Gniazdo Mewki items worn by the 3D bird (re-applied when it changes; SVG fallback: none) */
  outfit?: Outfit | null;
  /** follow the mouse with the head (default true; touch screens and reduced motion never track) */
  follow?: boolean;
}

const svgHtml = { __html: MEWKA_SVG };

export function MewkaReact({ state = 'idle', size = 'md', className, pointTarget, onReady, outfit, follow = true }: MewkaReactProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const api = useRef<MewkaApi | null>(null);
  // data-state is owned by the engine after mount (it must interrupt gestures first)
  const initial = useRef(state);

  useEffect(() => {
    const m = createMewka(ref.current!);
    api.current = m;
    if (m.state !== state) m.setState(state);
    if (follow) m.lookAtPointer(true);
    onReady?.(m);
    return () => { m.destroy(); api.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = api.current;
    if (!m) return;
    if (state === 'pointing' && pointTarget) m.pointAt(pointTarget);
    else if (m.state !== state) m.setState(state);
  }, [state, pointTarget]);

  // stable key: a new object with the same items does not re-apply
  const outfitKey = outfit ? Object.entries(outfit).filter(([, v]) => v).sort().map(([k, v]) => `${k}:${v}`).join('|') : '';
  useEffect(() => {
    if (outfit !== undefined) api.current?.setOutfit(outfit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outfitKey]);

  return (
    <span
      ref={ref}
      className={`mewka mewka--${size}${className ? ' ' + className : ''}`}
      data-state={initial.current}
      aria-hidden="true"
      dangerouslySetInnerHTML={svgHtml}
    />
  );
}

export default MewkaReact;
export type { MewkaState, MewkaApi };
