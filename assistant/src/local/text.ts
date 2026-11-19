// Text utilities of the local Mewka engine (pure, no DOM, no Node): diacritics-insensitive ("pozar" = "pożar"),
// prefix stems ("pozar" matches "pożaru", "pożarze") and small typo tolerance (Levenshtein on longer tokens).

/** lowercase, Polish diacritics folded (ł -> l), no punctuation */
export const fold = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[łŁ]/g, 'l').toLowerCase();

/** folded text, punctuation collapsed to single spaces, padded with one space on both ends (for " word " regexes) */
export const norm = (s: string) => ' ' + fold(s).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

export const tokens = (s: string) => norm(s).trim().split(' ').filter(Boolean);

/** Optimal-string-alignment distance (Levenshtein + adjacent transposition), capped at max + 1. */
export function lev(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let pp: number[] = [];
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, pp[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    pp = prev;
    prev = cur;
  }
  return prev[m];
}

/** token matches a stem: prefix, or (stems of 5+ letters) one typo in the stem-long head ("pozr" no, "pozsr" yes) */
export function stemMatch(token: string, stem: string): boolean {
  if (token.startsWith(stem)) return true;
  if (stem.length < 5 || token.length < stem.length - 1) return false;
  return lev(token.slice(0, stem.length), stem, 1) <= 1;
}

export const hasStem = (toks: string[], stems: string[]) => toks.some((t) => stems.some((s) => stemMatch(t, s)));
export const countStems = (toks: string[], stems: string[]) => toks.filter((t) => stems.some((s) => stemMatch(t, s))).length;
