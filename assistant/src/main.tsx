import { createRoot } from 'react-dom/client';
import Assistant from './Assistant';
import type { Lang } from './types';
import './styles.css';

const LANGS: Lang[] = ['pl', 'en', 'de', 'uk'];
function pickLang(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  if (q && (LANGS as string[]).includes(q)) return q as Lang;
  const nav = (navigator.language || 'pl').slice(0, 2);
  return (LANGS as string[]).includes(nav) ? (nav as Lang) : 'pl';
}
const lang = pickLang();
document.documentElement.lang = lang;
createRoot(document.getElementById('app')!).render(<Assistant lang={lang} />);
