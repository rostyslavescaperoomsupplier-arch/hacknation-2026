// Assistant server: POST /api/chat { lang, messages: [{ role, content }] }
//   -> { text: string[], sources: [], fallback?, actions: Action[] }.
// Calls Claude with the conversation so far, so the crew member can keep asking follow-up questions.
// The model may propose UI actions with markers; they are parsed and validated here and stripped from the text:
//   [[ROUTE:<zone>]]  [[ROUTE:<zone>:<stair-aft|stair-fwd>]]  [[DRILL:<id>]]
// The API key stays here (ANTHROPIC_API_KEY or an `ant auth login` profile); the browser never sees it.
// In production it also serves the built front end from ../dist.
import Anthropic from '@anthropic-ai/sdk';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
const KNOWLEDGE = readFileSync(path.join(here, 'knowledge.md'), 'utf8');
const DIST = path.join(here, '..', 'dist');
const CONTACT_MARK = '[[KONTAKT]]';

const LANG_NAME: Record<string, string> = { pl: 'Polish', en: 'English', de: 'German', uk: 'Ukrainian' };

// Shared ids (assistant/CONTRACT.md). [pl, en] names; de/uk fall back to en.
const ZONES: Record<string, [string, string]> = {
  'bridge': ['mostek nawigacyjny', 'navigation bridge'],
  'cabins-fwd': ['kabiny na dziobie, pokład 3', 'forward cabins, deck 3'],
  'cabins-mid': ['kabiny na śródokręciu, pokład 3', 'midship cabins, deck 3'],
  'cabins-aft': ['kabiny na rufie, pokład 3', 'aft cabins, deck 3'],
  'restaurant': ['restauracja, pokład 4', 'restaurant, deck 4'],
  'lounge': ['salon, pokład 4', 'lounge, deck 4'],
  'reclining-lounge': ['sala foteli lotniczych, pokład 4', 'reclining seat lounge, deck 4'],
  'vehicle-d1': ['pokład samochodowy 1', 'vehicle deck 1'],
  'vehicle-d2': ['pokład samochodowy 2', 'vehicle deck 2'],
  'engine-room': ['maszynownia', 'engine room'],
  'engine-control': ['centrala manewrowo-kontrolna (CMK)', 'engine control room'],
};
const STAIRS: Record<string, [string, string]> = {
  'stair-aft': ['klatka schodowa rufowa', 'aft stairwell'],
  'stair-fwd': ['klatka schodowa dziobowa', 'forward stairwell'],
};
const DRILLS: Record<string, [string, string]> = {
  'fire': ['pożar', 'fire'],
  'abandon': ['opuszczenie statku', 'abandon ship'],
  'mob': ['człowiek za burtą', 'man overboard'],
  'flooding': ['przeciek i zalanie', 'flooding'],
  'pollution': ['zanieczyszczenie morza olejem', 'oil pollution'],
  'blackout': ['zanik zasilania (blackout)', 'blackout'],
  'medical': ['nagły wypadek medyczny', 'medical emergency'],
};
const ACTION_RE = /\[\[(ROUTE|DRILL):([a-z0-9-]+)(?::([a-z-]+))?\]\]/g;

type Action =
  | { type: 'route'; zone: string; blocked?: 'stair-aft' | 'stair-fwd'; label: string }
  | { type: 'drill'; id: string; label: string };

const name = (pair: [string, string], lang: string) => (lang === 'pl' ? pair[0] : pair[1]);
const idList = (m: Record<string, [string, string]>) =>
  Object.entries(m).map(([id, [pl, en]]) => `- ${id}: ${pl} (${en})`).join('\n');

/** Pull validated action markers out of the reply text (unknown ids are dropped silently). */
function parseActions(text: string, lang: string): { text: string; actions: Action[] } {
  const actions: Action[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ACTION_RE)) {
    const [, kind, id, extra] = m;
    const key = m[0];
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === 'ROUTE' && ZONES[id]) {
      const blocked = extra && STAIRS[extra] ? (extra as 'stair-aft' | 'stair-fwd') : undefined;
      let label = name(ZONES[id], lang);
      if (blocked) label += lang === 'pl' ? `, zablokowana ${name(STAIRS[blocked], lang)}` : `, ${name(STAIRS[blocked], lang)} blocked`;
      actions.push(blocked ? { type: 'route', zone: id, blocked, label } : { type: 'route', zone: id, label });
    } else if (kind === 'DRILL' && DRILLS[id]) {
      actions.push({ type: 'drill', id, label: name(DRILLS[id], lang) });
    }
  }
  return { text: text.replace(ACTION_RE, '').replace(/[ \t]+\n/g, '\n'), actions: actions.slice(0, 4) };
}

// Frozen system prompt (cached): persona + rules + ids + knowledge. Nothing per-request goes in here.
const SYSTEM = `You are Mewka, a herring-gull mascot and the on-board training assistant for the CREW of MF Jantar Unity,
a Unity Line ro-pax ferry on the Świnoujście - Ystad route. You help deck, engine and hotel crew and officers
revise emergency procedures, find evacuation routes on the ship model and run drills.

Style:
- precise, calm, procedural, safety-first; like a good officer briefing a colleague;
- reply in Polish unless told otherwise; your replies are read aloud by a speech synthesiser, so write plain text only:
  no Markdown, no bullet symbols, no emoji; numbered steps may be written as short sentences "Jeden. ... Dwa. ...";
- keep replies short: usually 2-5 short sentences, split into short paragraphs with a blank line.

Emergencies: when the question describes an emergency (fire, smoke, flooding, man overboard, injury, alarm, blackout),
first give the immediate actions in order (raise the alarm, report to the bridge with location and type, protect people,
first response only if safe), then say plainly to follow the master's orders, the ship's Muster List and the SMS procedures.
Never suggest abandoning ship unless the master orders it. Never invent ship-specific data (numbers, locations, crew roles,
phone extensions) that is not in the knowledge below; say it must be checked in the ship's documents.
This is training material based on general SOLAS / IMO practice and a stylised 3D model, not the ship's official documents;
say so briefly when it matters.

Actions: the app can open an evacuation route or a drill. When useful, add these exact markers at the very end of the reply,
on their own line (the app turns them into buttons and removes them from the text; never explain the markers):
[[ROUTE:<zone>]] shows the evacuation route from that zone to the muster station;
[[ROUTE:<zone>:<stair>]] does the same with that stairwell blocked (e.g. by fire or smoke);
[[DRILL:<id>]] opens that drill card.
Use at most one ROUTE and one DRILL marker per reply. Only use the ids below.
Zones:
${idList(ZONES)}
Stairwells:
${idList(STAIRS)}
Drills:
${idList(DRILLS)}
Examples: "pożar w kabinach na rufie" -> immediate actions, then [[ROUTE:cabins-aft:stair-aft]] and [[DRILL:fire]];
"droga ewakuacji z maszynowni" -> [[ROUTE:engine-room]]; "ćwiczenie człowiek za burtą" -> [[DRILL:mob]].

If the answer is not in the knowledge and you are not sure, say honestly that you do not know, tell them to ask
the officer on watch, and end the reply with the exact marker ${CONTACT_MARK} so the app shows the contact to the bridge.
Never ask for personal data. You are an AI; say so if asked.

<knowledge>
${KNOWLEDGE}
</knowledge>`;

const client = new Anthropic();
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_PROFILE)
  console.warn('[assistant] no ANTHROPIC_API_KEY in env or .env: answers will fail unless an `ant auth login` profile exists');

interface Turn { role: 'user' | 'assistant'; content: string }

function clean(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const out: Turn[] = [];
  for (const m of raw.slice(-20)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const content = m.content.slice(0, 2000).trim();
    if (!content) continue;
    // the API needs alternating turns that start with the user
    if (!out.length && m.role !== 'user') continue;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n\n' + content;
    else out.push({ role: m.role, content });
  }
  return out.length && out[out.length - 1].role === 'user' ? out : [];
}

async function chat(lang: string, messages: Turn[]) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      ...messages,
      { role: 'system', content: `Reply in ${LANG_NAME[lang] ?? 'the language of the last user message'}.` },
    ],
  });
  if (response.stop_reason === 'refusal') return { text: [], fallback: true, actions: [] as Action[] };
  let text = '';
  for (const block of response.content) if (block.type === 'text') text += block.text;
  const fallback = text.includes(CONTACT_MARK);
  text = text.split(CONTACT_MARK).join('');
  const parsed = parseActions(text, lang);
  const paras = parsed.text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return { text: paras, fallback, actions: parsed.actions };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100_000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2',
};

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://x');
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('Run `npm run build` first, or use `npm run dev`.'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

createServer(async (req, res) => {
  if (req.url?.startsWith('/api/chat')) {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    try {
      const body = JSON.parse(await readBody(req));
      const messages = clean(body.messages);
      if (!messages.length) return send(res, 400, { error: 'no question' });
      const lang = typeof body.lang === 'string' ? body.lang : 'pl';
      const r = await chat(lang, messages);
      return send(res, 200, { text: r.text, sources: [], fallback: r.fallback || !r.text.length, actions: r.actions });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) console.warn('[assistant] rate limited');
      else if (e instanceof Anthropic.APIError) console.error('[assistant] API error', e.status, e.message);
      else console.error('[assistant]', e);
      return send(res, 502, { error: 'assistant unavailable' });
    }
  }
  serveStatic(req, res);
}).listen(PORT, () => console.log(`[assistant] http://localhost:${PORT}  model=${MODEL}`));
