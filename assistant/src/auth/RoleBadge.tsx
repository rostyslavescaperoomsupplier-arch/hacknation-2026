import type { Lang } from '../types';
import type { Role } from './AuthProvider';

export const L = (lang: Lang, pl: string, en: string) => (lang === 'pl' ? pl : en);

export const ROLE_LABEL: Record<Role, [string, string]> = {
  captain: ['Kapitan', 'Master'],
  bridge: ['Mostek', 'Bridge'],
  engine: ['Maszynownia', 'Engine'],
  crew: ['Załoga', 'Crew'],
};
export const roleLabel = (lang: Lang, r: Role) => L(lang, ...ROLE_LABEL[r]);

/** Small uppercase role tag. Bridge-level roles (captain, bridge) are filled, the others outlined: shape + text, not colour alone. */
export default function RoleBadge({ lang, role, className = '' }: { lang: Lang; role: Role; className?: string }) {
  const strong = role === 'captain' || role === 'bridge';
  return (
    <span data-role={role}
          className={`auth-badge inline-flex shrink-0 items-center rounded-card px-1.5 py-0.5 text-[0.6875rem] font-bold uppercase leading-none tracking-[0.08em]
                      ${strong ? 'bg-navy text-on-strong' : 'border border-line text-ink-2'} ${className}`}>
      {roleLabel(lang, role)}
    </span>
  );
}
