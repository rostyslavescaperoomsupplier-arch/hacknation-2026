// React twin of Icon.astro for islands. Same data (./icons.ts), same defaults.
import { ICONS, type IconName } from './icons';

interface Props { name: IconName; size?: number | string; stroke?: number; label?: string; className?: string }

export default function Icon({ name, size = 20, stroke = 1.5, label, className }: Props) {
  const icon = ICONS[name] as { d: string[]; fill?: string[] };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
         strokeLinecap="butt" strokeLinejoin="miter" strokeMiterlimit={10} focusable="false"
         className={className ? `fs-icon ${className}` : 'fs-icon'}
         aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      {icon.d.map((d, i) => <path key={i} d={d} />)}
      {icon.fill?.map((d, i) => <path key={`f${i}`} d={d} fill="currentColor" stroke="none" />)}
    </svg>
  );
}
export { Icon };
