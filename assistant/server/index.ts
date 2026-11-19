// Assistant server: POST /api/chat { lang, messages: [{ role, content }] } -> { text: string[], sources: [], fallback? }.
// Calls Claude with the conversation so far, so the user can keep asking follow-up questions.
// The API key stays here (ANTHROPIC_API_KEY or an `ant auth login` profile); the browser never sees it.
// In production it also serves the built front end from ../dist.
import Anthropic from '@anthropic-ai/sdk';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachCrewVideoWebSocket } from './crew-video.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
const KNOWLEDGE = readFileSync(path.join(here, 'knowledge.md'), 'utf8');
const DIST = path.join(here, '..', 'dist');
const CONTACT_MARK = '[[KONTAKT]]';

const LANG_NAME: Record<string, string> = { pl: 'Polish', en: 'English', de: 'German', uk: 'Ukrainian' };

// Frozen system prompt (cached): persona + rules + knowledge. Nothing per-request goes in here.
const SYSTEM = `You are Mewka, a friendly herring-gull mascot and assistant on a website built for the HackNation 2026 hackathon.
You talk with visitors in a chat; your replies are also read aloud by a speech synthesiser, so:
- write plain text only, no Markdown, no lists with symbols, no emoji;
- keep replies short: usually 1-4 sentences, split into short paragraphs with a blank line;
- be warm and concrete, and ask a short follow-up question when the request is unclear.
Base factual answers on the knowledge below. If the answer is not there and you are not sure, say honestly that you do not know,
do not invent facts, and end the reply with the exact marker ${CONTACT_MARK} so the page shows the contact buttons.
Never ask for personal data. You are an AI; say so if asked.

<knowledge>
${KNOWLEDGE}
</knowledge>`;

let client: Anthropic | undefined;
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
  const response = await (client ??= new Anthropic()).beta.messages.create({
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
  if (response.stop_reason === 'refusal') return { text: [], fallback: true };
  let text = '';
  for (const block of response.content) if (block.type === 'text') text += block.text;
  const fallback = text.includes(CONTACT_MARK);
  text = text.split(CONTACT_MARK).join('').trim();
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return { text: paras, fallback };
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

const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/api/chat')) {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    try {
      const body = JSON.parse(await readBody(req));
      const messages = clean(body.messages);
      if (!messages.length) return send(res, 400, { error: 'no question' });
      const lang = typeof body.lang === 'string' ? body.lang : 'pl';
      const r = await chat(lang, messages);
      return send(res, 200, { text: r.text, sources: [], fallback: r.fallback || !r.text.length });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) console.warn('[assistant] rate limited');
      else if (e instanceof Anthropic.APIError) console.error('[assistant] API error', e.status, e.message);
      else console.error('[assistant]', e);
      return send(res, 502, { error: 'assistant unavailable' });
    }
  }
  serveStatic(req, res);
});
attachCrewVideoWebSocket(server);
server.listen(PORT, () => console.log(`[assistant] http://localhost:${PORT}  model=${MODEL}`));
