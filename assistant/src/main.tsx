import { createRoot } from 'react-dom/client';
import App from './App';
import type { Lang } from './types';
import './styles.css';

// Polish is the main language: the app always opens in Polish; ?lang=en (or de / uk) is an explicit option only.
const LANGS: Lang[] = ['pl', 'en', 'de', 'uk'];
function pickLang(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  return q && (LANGS as string[]).includes(q) ? (q as Lang) : 'pl';
}
const lang = pickLang();
document.documentElement.lang = lang;
createRoot(document.getElementById('app')!).render(<App initialLang={lang} />);
