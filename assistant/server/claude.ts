// Claude call for the assistant, shared by POST /api/chat (ask) and POST /api/chat/stream (askStream).
// Both return the same shape: { text: string[], sources: Source[], fallback: boolean, actions: Action[] }.
//
// Request layout (cache-friendly, nothing per-request before the history):
//   system  = frozen persona/rules/ids/knowledge.md (cache_control)
//   messages[0] (user) = ship documents from server/knowledge/ as `document` blocks with citations (last one cached)
//                        + the first user question
//   ... rest of the history ...
//   { role: 'system', content: 'Reply in <language>.' }   (mid-conversation system message, keeps the cache)
//
// Test hooks:
//   setClient(fake)       injects any object with `beta.messages.create(params, opts)` and `beta.messages.stream(params, opts)`.
//   ASSISTANT_FAKE=1      makes the server use the built-in deterministic fake client (no API key, no network).
//     The fake echoes the last question, streams in small chunks with markers split across chunks
//     ([[ROUTE:cabins-aft:stair-aft]] [[DRILL:fire]]), cites the first knowledge document when there is one, and reacts
//     to trigger words in the last question: FAKE_REFUSAL -> stop_reason "refusal"; FAKE_ERROR -> upstream error (502 /
//     SSE error); FAKE_KONTAKT -> adds [[KONTAKT]] (fallback: true); FAKE_SLOW -> 200 ms between chunks (disconnect tests);
//     FAKE_TOOL -> (when the crew tools are on) first calls find_crew {query:"bosman"} (stop_reason "tool_use"), then
//     answers from the tool result: the first person's name, rank and room, plus [[ROUTE:<zone>]] for that room.
//
// Crew tools (crew.ts, only when CREW_API is not "off"): read-only tools over the live crew database. Both ask() and
// askStream() run a manual tool loop: stop_reason "tool_use" -> run every tool_use block, send all tool_result blocks back
// in one user message (is_error on failures), at most MAX_TOOL_ROUNDS rounds; the last allowed round sets
// tool_choice "none". The text of all rounds makes up the reply; deltas pass through one MarkerFilter across rounds.
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  BetaRequestDocumentBlock,
  BetaTextCitation,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Lang, Turn } from './guard.ts';
import { CREW_TOOLS, CREW_TOOL_NAMES, crewEnabled, runCrewTool } from './crew.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
export const FAKE = process.env.ASSISTANT_FAKE === '1';
const MAX_TOKENS = 4000; // replies are 2-5 sentences read aloud; a hard cost cap
const KNOWLEDGE = readFileSync(path.join(here, 'knowledge.md'), 'utf8');
const KNOWLEDGE_DIR = path.join(here, 'knowledge');
const CONTACT_MARK = '[[KONTAKT]]';
const MAX_TOOL_ROUNDS = 5;

export interface Source { label: string; href: string }
export type Action =
  | { type: 'route'; zone: string; blocked?: 'stair-aft' | 'stair-fwd'; label: string }
  | { type: 'drill'; id: string; label: string };
export interface Reply { text: string[]; sources: Source[]; fallback: boolean; actions: Action[] }

const LANG_NAME: Record<Lang, string> = { pl: 'Polish', en: 'English', de: 'German', uk: 'Ukrainian' };

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
/** Any marker-shaped token: [[WORD]] or [[WORD:args]] (ROUTE, DRILL, KONTAKT, SRC, future ones). */
const ANY_MARKER_RE = /\[\[[A-Z]+(?::[A-Za-z0-9:_-]*)?\]\]/g;

const name = (pair: [string, string], lang: string) => (lang === 'pl' ? pair[0] : pair[1]);
const idList = (m: Record<string, [string, string]>) =>
  Object.entries(m).map(([id, [pl, en]]) => `- ${id}: ${pl} (${en})`).join('\n');

/** Pull validated action markers out of the reply text (unknown ids are dropped silently). */
export function parseActions(text: string, lang: string): { text: string; actions: Action[] } {
  const actions: Action[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ACTION_RE)) {
    const [key, kind, id, extra] = m;
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
  return { text: text.replace(ANY_MARKER_RE, '').replace(/[ \t]+\n/g, '\n'), actions: actions.slice(0, 4) };
}

// ---------- ship documents (server/knowledge/) ----------
interface Doc { file: string; title: string; block: BetaRequestDocumentBlock; chars: number; text?: string }
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024; // the API takes 32 MB per request; base64 PDFs grow by a third

function loadDocs(): Doc[] {
  if (!existsSync(KNOWLEDGE_DIR)) return [];
  const docs: Doc[] = [];
  let total = 0;
  for (const file of readdirSync(KNOWLEDGE_DIR).sort()) {
    const ext = path.extname(file).toLowerCase();
    if (file.toLowerCase() === 'readme.md' || file.startsWith('.') || !['.md', '.txt', '.pdf'].includes(ext)) continue;
    const full = path.join(KNOWLEDGE_DIR, file);
    const size = statSync(full).size;
    if (!size) continue;
    if (size > MAX_FILE) { console.warn(`[assistant] knowledge: skipping ${file} (${(size / 1048576).toFixed(1)} MB > 5 MB)`); continue; }
    if (total + size > MAX_TOTAL) { console.warn(`[assistant] knowledge: skipping ${file}, total over 20 MB`); continue; }
    total += size;
    const title = path.basename(file, path.extname(file));
    if (ext === '.pdf') {
      docs.push({
        file, title, chars: size,
        block: { type: 'document', title, citations: { enabled: true },
          source: { type: 'base64', media_type: 'application/pdf', data: readFileSync(full).toString('base64') } },
      });
    } else {
      const text = readFileSync(full, 'utf8');
      docs.push({
        file, title, chars: text.length, text,
        block: { type: 'document', title, citations: { enabled: true },
          source: { type: 'text', media_type: 'text/plain', data: text } },
      });
    }
  }
  if (docs.length) docs[docs.length - 1].block.cache_control = { type: 'ephemeral' };
  return docs;
}

const DOCS = loadDocs();
export const knowledgeStats = { files: DOCS.length, chars: DOCS.reduce((n, d) => n + d.chars, 0) };
if (DOCS.length) console.log(`[assistant] knowledge: ${DOCS.length} document(s): ${DOCS.map((d) => d.file).join(', ')}`);

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
phone extensions) that is not in the knowledge below${crewEnabled ? ' or in a crew tool result' : ''}; say it must be checked in the ship's documents.
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
${crewEnabled ? `
Crew database: you have read-only tools over the live crew database. It is filled by the card check-in terminals in the
rooms: each card tap records who entered which room and when, so "where someone is" means the room of their last check-in
(and "since" is that time). Use the tools whenever the question is about specific people, who is where, how many people are
in a room or zone, staffing, lone workers or overdue check-ins; never guess these from memory. Answer with names, ranks and
places (room name, deck) and say how long ago the check-in was, in minutes or hours, not as a raw timestamp. Times in the
results are UTC. If several people match, name them briefly or ask which one. Privacy: share only on-board information
(where, since when, rank, cabin, phone extension); give nationality or date of birth only when the user says they need it
for their role (e.g. muster list, medical, the master) and then call find_crew with details true. If a tool returns
"crew database unavailable", say plainly that the crew database (baza załogi) is unavailable right now and suggest asking
the bridge; do not make up locations. When you tell where a person or a room is and its result has a zone from the Zones
list below, you may add [[ROUTE:<zone>]] for that zone so the app can show it on the ship model; zone "boat-deck" or null
has no route marker.
` : ''}${DOCS.length ? `
Documents: the first user message carries the ship documents loaded on this terminal (${DOCS.map((d) => d.title).join(', ')}).
When a question is covered by them, answer from them and rely on them over general practice; the app shows your citations
as sources. If a document is marked as a sample or training material, say so when you use it.
` : ''}
<knowledge>
${KNOWLEDGE}
</knowledge>`;

// ---------- client ----------
type CreateParams = MessageCreateParamsNonStreaming;
interface ReqOpts { signal?: AbortSignal }
export interface StreamLike extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
  abort(): void;
}
export interface ClaudeClient {
  beta: { messages: {
    create(params: CreateParams, opts?: ReqOpts): PromiseLike<BetaMessage>;
    stream(params: CreateParams, opts?: ReqOpts): StreamLike;
  } };
}

let client: ClaudeClient | null = null;
/** Inject a client (tests). Pass null to go back to the default (real or ASSISTANT_FAKE). */
export function setClient(c: ClaudeClient | null) { client = c; }
function getClient(): ClaudeClient {
  if (!client) {
    if (FAKE) client = fakeClient();
    else {
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_PROFILE)
        console.warn('[assistant] no ANTHROPIC_API_KEY in env or .env: answers will fail unless an `ant auth login` profile exists');
      client = new Anthropic({ timeout: 90_000, maxRetries: 1 }) as unknown as ClaudeClient;
    }
  }
  return client;
}

// ---------- request ----------
export function buildParams(lang: Lang, turns: Turn[]): CreateParams {
  const messages: BetaMessageParam[] = turns.map((t, i) => {
    if (i === 0 && t.role === 'user' && DOCS.length) {
      const content: BetaContentBlockParam[] = [...DOCS.map((d) => d.block), { type: 'text', text: t.content }];
      return { role: 'user', content };
    }
    return { role: t.role, content: t.content };
  });
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    ...(crewEnabled ? { tools: CREW_TOOLS, tool_choice: { type: 'auto' } } : {}),
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [...messages, { role: 'system', content: `Reply in ${LANG_NAME[lang] ?? 'the language of the last user message'}.` }],
  } as CreateParams;
}

// ---------- response ----------
const short = (s: string, n = 80) => {
  const t = s.replace(/[#*_`>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};

function citationsToSources(cits: BetaTextCitation[]): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const c of cits) {
    if (!('document_index' in c)) continue;
    const doc = DOCS[c.document_index];
    if (!doc) continue;
    const page = c.type === 'page_location' ? ` (s. ${c.start_page_number})` : '';
    const label = `${doc.title}${page} - ${short(c.cited_text)}`;
    const key = doc.file + '|' + label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, href: `#doc:${doc.file}` });
    if (out.length >= 4) break;
  }
  return out;
}

/** Text of one message (text blocks only; tool_use, thinking and fallback boundaries are skipped). */
const messageText = (msg: BetaMessage) => msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
/** Text of all tool-loop rounds: rounds with text joined by a blank line (askStream emits the same separator). */
const roundsText = (msgs: BetaMessage[]) => msgs.map(messageText).filter((t) => t.trim()).join('\n\n');

/** Final shape from the complete message(s) of one answer (one per tool-loop round). */
export function toReply(msgs: BetaMessage | BetaMessage[], lang: Lang): Reply {
  const list = Array.isArray(msgs) ? msgs : [msgs];
  if (!list.length || list[list.length - 1].stop_reason === 'refusal') return { text: [], sources: [], fallback: true, actions: [] };
  const text = roundsText(list);
  const cits: BetaTextCitation[] = [];
  for (const msg of list) for (const block of msg.content) if (block.type === 'text' && block.citations) cits.push(...block.citations);
  const contact = text.includes(CONTACT_MARK);
  const parsed = parseActions(text, lang);
  const paras = parsed.text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return { text: paras, sources: citationsToSources(cits), fallback: contact || !paras.length, actions: parsed.actions };
}

/** After one round: when the model asked for crew tools, append its whole response and all tool results to the
 *  conversation and return true (call again); otherwise false (the answer is complete). */
async function toolRound(params: CreateParams, msg: BetaMessage, round: number): Promise<boolean> {
  if (msg.stop_reason !== 'tool_use') return false; // end_turn, max_tokens (a cut tool input never runs), refusal, ...
  const uses = msg.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
  if (!uses.length) return false;
  const results: BetaToolResultBlockParam[] = await Promise.all(uses.map(async (u) => {
    const out = CREW_TOOL_NAMES.has(u.name)
      ? await runCrewTool(u.name, u.input)
      : { content: JSON.stringify({ error: `unknown tool ${u.name}` }), isError: true };
    return { type: 'tool_result', tool_use_id: u.id, content: out.content, ...(out.isError ? { is_error: true } : {}) };
  }));
  params.messages.push({ role: 'assistant', content: msg.content as BetaContentBlockParam[] });
  params.messages.push({ role: 'user', content: results });
  if (round + 1 >= MAX_TOOL_ROUNDS) params.tool_choice = { type: 'none' }; // last call: answer from what is there
  return true;
}

/** Non-streaming call (POST /api/chat), with the crew tool loop. */
export async function ask(lang: Lang, turns: Turn[], signal?: AbortSignal): Promise<Reply> {
  const params = buildParams(lang, turns);
  const msgs: BetaMessage[] = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    signal?.throwIfAborted();
    const msg = await getClient().beta.messages.create(params, { signal });
    msgs.push(msg);
    if (!(await toolRound(params, msg, round))) break;
  }
  return toReply(msgs, lang);
}

/** Holds back text from `[[` until the marker closes (dropped) or clearly is not a marker (released). */
export class MarkerFilter {
  private buf = '';
  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      const i = this.buf.indexOf('[');
      if (i < 0) { out += this.buf; this.buf = ''; break; }
      out += this.buf.slice(0, i);
      this.buf = this.buf.slice(i);
      if (this.buf.length < 2) break; // a lone '[' may become '[['
      if (this.buf[1] !== '[') { out += '['; this.buf = this.buf.slice(1); continue; }
      const m = /^\[\[[A-Z]*(?::[A-Za-z0-9:_-]*)?(\]\]?)?/.exec(this.buf)!;
      const closed = m[1] === ']]';
      if (closed && m[0].length > 4) { this.buf = this.buf.slice(m[0].length); continue; } // a marker: drop it
      if (!closed && m[0].length === this.buf.length && m[0].length <= 64) break; // still could be a marker: wait
      out += '['; this.buf = this.buf.slice(1); // not a marker: release one char and rescan
    }
    return out;
  }
  /** End of stream: release what is left unless it is an unfinished marker. */
  flush(): string {
    const rest = this.buf;
    this.buf = '';
    return /^\[\[[A-Z]*(?::[A-Za-z0-9:_-]*)?\]?$/.test(rest) ? '' : rest;
  }
}

/** Streaming call (POST /api/chat/stream), with the crew tool loop. onDelta gets marker-free text only (never tool
 *  input); one MarkerFilter spans all rounds, so a marker split across rounds is still held back. The Reply is authoritative. */
export async function askStream(lang: Lang, turns: Turn[], onDelta: (text: string) => void, signal?: AbortSignal): Promise<Reply> {
  const params = buildParams(lang, turns);
  const filter = new MarkerFilter();
  const msgs: BetaMessage[] = [];
  let hadText = false; // some earlier round produced text: the next round's text starts after a blank line
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    signal?.throwIfAborted();
    const stream = getClient().beta.messages.stream(params, { signal });
    const onAbort = () => stream.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let roundText = '';
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          let chunk = event.delta.text;
          if (!roundText.trim() && hadText && chunk.trim()) chunk = '\n\n' + chunk.trimStart();
          roundText += event.delta.text;
          const t = filter.push(chunk);
          if (t) onDelta(t);
        }
      }
      msgs.push(await stream.finalMessage());
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (roundText.trim()) hadText = true;
    if (!(await toolRound(params, msgs[msgs.length - 1], round))) break;
  }
  const t = filter.flush();
  if (t) onDelta(t);
  return toReply(msgs, lang);
}

/** Short log line for an upstream error (never sent to clients). */
export function describeError(e: unknown): string {
  if (e instanceof Anthropic.APIUserAbortError) return 'aborted';
  if (e instanceof Anthropic.RateLimitError) return 'upstream rate limited (429)';
  if (e instanceof Anthropic.AuthenticationError) return 'upstream auth failed (401): check ANTHROPIC_API_KEY';
  if (e instanceof Anthropic.APIConnectionError) return 'upstream connection error';
  if (e instanceof Anthropic.APIError) return `upstream API error ${e.status}: ${e.message.slice(0, 200)}`;
  return e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e);
}

// ---------- deterministic fake (ASSISTANT_FAKE=1 or tests) ----------
export function fakeClient(): ClaudeClient {
  const lastQuestion = (p: CreateParams): string => {
    for (let i = p.messages.length - 1; i >= 0; i--) {
      const m = p.messages[i];
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      for (const b of m.content) if (b.type === 'text') return b.text;
    }
    return '';
  };
  /** tool_result blocks of the last turn, when the last turn is the tool results of a fake tool round. */
  const lastToolResults = (p: CreateParams): BetaToolResultBlockParam[] => {
    const m = [...p.messages].reverse().find((x) => (x.role as string) !== 'system');
    if (!m || m.role !== 'user' || typeof m.content === 'string') return [];
    return m.content.filter((b): b is BetaToolResultBlockParam => b.type === 'tool_result');
  };
  const split = (text: string) => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 7) chunks.push(text.slice(i, i + 7)); // splits markers across chunks
    return chunks;
  };
  const build = (p: CreateParams): { chunks: string[]; msg: BetaMessage; error?: boolean; slow: boolean } => {
    const q = lastQuestion(p);
    const base = { id: 'msg_fake', type: 'message', role: 'assistant', model: MODEL, stop_sequence: null, stop_details: null,
      usage: { input_tokens: 0, output_tokens: 0 } };
    if (q.includes('FAKE_REFUSAL'))
      return { chunks: [], slow: false, msg: { ...base, content: [], stop_reason: 'refusal' } as unknown as BetaMessage };
    const hasCrewTool = (p.tools ?? []).some((t) => (t as { name?: string }).name === 'find_crew');
    if (q.includes('FAKE_TOOL') && hasCrewTool) {
      const results = lastToolResults(p);
      if (!results.length) { // round 1: a short preamble, then the tool call
        const text = 'Sprawdzam w bazie załogi.';
        const msg = { ...base, stop_reason: 'tool_use', content: [
          { type: 'text', text, citations: null },
          { type: 'tool_use', id: 'toolu_fake_1', name: 'find_crew', input: { query: 'bosman' } },
        ] } as unknown as BetaMessage;
        return { chunks: split(text), msg, slow: false };
      }
      // round 2: answer from the tool result
      const r = results[0];
      const raw = typeof r.content === 'string' ? r.content : (r.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
      let text: string;
      try {
        const data = JSON.parse(raw);
        const c = data.crew?.[0];
        if (r.is_error || !c) text = `Baza załogi jest teraz niedostępna (${data.error ?? 'brak wyników'}). Zapytaj mostek.`;
        else text = `Z bazy załogi: ${c.name}, ${c.rank}, jest teraz w: ${c.where ?? 'poza statkiem'}`
          + `${c.minutes_ago != null ? `, od ${c.minutes_ago} min` : ''}.\n\n${c.zone ? `[[ROUTE:${c.zone}]]` : ''}`;
      } catch { text = 'Baza załogi zwróciła niepoprawne dane.'; }
      const msg = { ...base, stop_reason: 'end_turn', content: [{ type: 'text', text, citations: null }] } as unknown as BetaMessage;
      return { chunks: split(text), msg, slow: false };
    }
    const text = `Tryb testowy. Pytanie: ${short(q, 60)}\n\nJeden. Podnieś alarm. Dwa. Zgłoś na mostek.\n\n`
      + `[[ROUTE:cabins-aft:stair-aft]] [[DRILL:fire]]${q.includes('FAKE_KONTAKT') ? ' ' + CONTACT_MARK : ''}`;
    const chunks = split(text);
    const doc = DOCS[0];
    const citations = doc
      ? [{ type: 'char_location', cited_text: (doc.text ?? doc.title).slice(0, 120), document_index: 0, document_title: doc.title,
          start_char_index: 0, end_char_index: Math.min(120, (doc.text ?? doc.title).length), file_id: null }]
      : null;
    const msg = { ...base, stop_reason: 'end_turn', content: [{ type: 'text', text, citations }] } as unknown as BetaMessage;
    return { chunks, msg, error: q.includes('FAKE_ERROR'), slow: q.includes('FAKE_SLOW') };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    beta: { messages: {
      async create(p) {
        const r = build(p);
        if (r.error) throw new Error('fake upstream failure');
        return r.msg;
      },
      stream(p, opts) {
        const r = build(p);
        let aborted = false;
        const ev = (e: unknown) => e as BetaRawMessageStreamEvent;
        return {
          abort() { aborted = true; },
          async finalMessage() { if (r.error) throw new Error('fake upstream failure'); return r.msg; },
          async *[Symbol.asyncIterator]() {
            yield ev({ type: 'message_start', message: { ...r.msg, content: [] } });
            if (r.chunks.length) yield ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } });
            for (const [i, text] of r.chunks.entries()) {
              await sleep(r.slow ? 200 : 2);
              if (aborted || opts?.signal?.aborted) throw new Anthropic.APIUserAbortError();
              if (r.error && i === 3) throw new Error('fake upstream failure');
              yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
            }
            if (r.chunks.length) yield ev({ type: 'content_block_stop', index: 0 });
            for (const [i, b] of r.msg.content.entries()) { // tool_use blocks: start, input JSON, stop (never text)
              if (b.type !== 'tool_use') continue;
              yield ev({ type: 'content_block_start', index: i, content_block: { ...b, input: {} } });
              yield ev({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
              yield ev({ type: 'content_block_stop', index: i });
            }
            yield ev({ type: 'message_delta', delta: { stop_reason: r.msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 0 } });
            yield ev({ type: 'message_stop' });
          },
        };
      },
    } },
  };
}
