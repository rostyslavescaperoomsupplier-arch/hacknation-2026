// What the assistant says out loud: the answer text, without links or e-mail addresses.
import type { Answer, Lang } from '../types';
import type { Seg } from './engine';
import { VSTR } from './i18n';

/** Make one paragraph pleasant to hear. */
export function speechText(t: string, lang: Lang): string {
  const v = VSTR[lang];
  let s = ' ' + t + ' ';
  s = s
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\bwww\.\S+/g, ' ')
    .replace(/\S+@\S+\.\w+/g, ' ')
    .replace(/[*_#`>]+/g, ' ');
  s = s.replace(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/g, (_, a, b) => v.range(a, b));
  if (lang === 'pl' || lang === 'uk') s = s.replace(/\b(\d{1,2}):00\b/g, '$1');
  s = s
    .replace(/(\d)\s*(?:zł|PLN)(?=[\s.,;:!?)]|$)/g, `$1 ${v.money}`)
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s·\s/g, ', ')
    .replace(/…/g, '.')
    .replace(/[„“”"«»]/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s;
}

export function speakable(a: Answer, lang: Lang): Seg[] {
  return a.text.map((p) => ({ text: speechText(p, lang) })).filter((s) => s.text);
}

export function spokenWords(segs: Seg[]): string {
  return segs.map((s) => s.text).join(' ');
}
