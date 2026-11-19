// Text utilities shared by assistant, search and wizard.
// Diacritics-insensitive ("karlowicz" = "Karłowicz"), typo-tolerant (Levenshtein on short tokens).

const EXTRA: Record<string, string> = { ł: 'l', Ł: 'l', ß: 'ss', ø: 'o', æ: 'ae', œ: 'oe', đ: 'd' };

/**
 * Cyrillic (Ukrainian, plus a few Russian letters) → Polish-style Latin, so a Ukrainian query
 * lands in the same token space as the data: "трамваєм" → "tramwajem", "Рахманінов" → "rachmaninow",
 * "Чайковський" → "czajkowskyj" (≈ "czajkowski" within typo tolerance).
 */
const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'w', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'je', ж: 'z', з: 'z', и: 'y', і: 'i', ї: 'ji', й: 'j',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'ch', ц: 'c', ч: 'cz',
  ш: 'sz', щ: 'szcz', ь: '', ю: 'ju', я: 'ja', ы: 'y', э: 'e', ё: 'jo', ъ: '',
};

/** lowercase, transliterate Cyrillic, strip diacritics (incl. Polish ł and German ß), collapse punctuation to spaces. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/([а-яёіїєґ])['’ʼ]([а-яёіїєґ])/g, '$1$2') // Ukrainian apostrophe: "п'ятниця" is one word
    .replace(/([сц])ьк(?:ий|ого|ому|им)(?![а-яёіїєґ])/g, '$1ki') // surnames: "Чайковський" → "czajkowski" (Polish spelling in the data)
    .replace(/[а-яёіїєґ]/g, (c) => CYR[c] ?? c)
    .replace(/[łŁßøæœđ]/g, (c) => EXTRA[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(s: string): string[] {
  return norm(s).split(' ').filter(Boolean);
}

/** Optimal-string-alignment distance (Levenshtein + adjacent transposition, so "mozrat" = 1 from "mozart"). */
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

/** Allowed edit distance by query-token length: 0 for ≤3, 1 for 4–6, 2 for ≥7. */
export function tolerance(len: number): number {
  return len <= 3 ? 0 : len <= 6 ? 1 : 2;
}

/**
 * How well a query token matches a document token. 1 = exact, 0.8 = prefix (≥3 chars),
 * 0.6 = typo within tolerance, 0 = no match.
 */
export function tokenMatch(q: string, d: string): number {
  if (q === d) return 1;
  if (q.length >= 3 && d.startsWith(q)) return 0.85;
  if (d.length >= 4 && q.length > d.length && q.startsWith(d)) return 0.7; // inflection: "karlowicza" vs "karlowicz"
  const tol = tolerance(q.length);
  if (tol && lev(q, d, tol) <= tol) return 0.6;
  // Polish/German inflection: compare stems (drop up to 2 trailing chars)
  if (q.length >= 6 && d.length >= 6 && q.slice(0, -2) === d.slice(0, -2)) return 0.6;
  if (q.length >= 7 && d.length >= 7 && q.slice(0, 6) === d.slice(0, 6)) return 0.5;
  return 0;
}

/** Best match of a query token against a set of doc tokens. */
export function bestMatch(q: string, docTokens: string[]): number {
  let best = 0;
  for (const d of docTokens) {
    const m = tokenMatch(q, d);
    if (m > best) best = m;
    if (best === 1) break;
  }
  return best;
}

/** Words that carry no retrieval meaning (PL/EN/DE/UK). Kept short on purpose. UK is written in Cyrillic and normalized. */
const STOP_UK =
  'я ми ви ти він вона воно вони це цей ця ці що як який яка яке які де коли скільки чи є в у на до від з із зі за для про ' +
  'і й та або але бо також вже ще будь ласка хочу хотів хотіла хотілося шукаю покажи покажіть підкажи підкажіть можна можу ' +
  'мені нам мене мій моя моє мої там тут є буде будь-ласка';
export const STOP = new Set(
  (STOP_UK.split(' ').map(norm).join(' ') + ' ' +
    'a i w z o u na do od po za ze we czy jak jaki jaka jakie jest sa jestem mam moge mozna sie to ten ta te tym tej ' +
    'co kto gdzie kiedy ile dla przez przy mi mnie my nas o oraz lub albo bo ze ktory ktora ktore tez juz jeszcze ' +
    'prosze chce chcialbym chcialabym szukam pokaz poprosze ' +
    'the a an is are am can could i we you me my of to in on at for with what which when where how much many do does there any some ' +
    'please want would like show find get ' +
    'der die das ein eine ist sind kann ich wir sie es zu im am um fur mit was wie wo wann welche welcher welches gibt es bitte und oder ' +
    'mochte moechte suche zeige'
  ).split(' '),
);
