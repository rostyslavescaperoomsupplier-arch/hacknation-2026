// Minimal Server-Sent Events parser for the tests (and a reference for the browser client).
// Splits the byte stream into events on blank lines; `event:` names the event, `data:` lines are joined with '\n'.

export interface SSEEvent { event: string; data: string; json?: any }

/** Parse a complete SSE text (e.g. a whole response body) into events. */
export function parseSSE(text: string): SSEEvent[] {
  const p = new SSEParser();
  const out = p.push(text);
  out.push(...p.flush());
  return out;
}

/** Incremental parser: push chunks as they arrive, get finished events back. */
export class SSEParser {
  private buf = '';
  push(chunk: string): SSEEvent[] {
    this.buf += chunk.replace(/\r\n?/g, '\n');
    const out: SSEEvent[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const ev = parseBlock(block);
      if (ev) out.push(ev);
    }
    return out;
  }
  flush(): SSEEvent[] {
    const rest = this.buf.trim();
    this.buf = '';
    const ev = rest ? parseBlock(rest) : null;
    return ev ? [ev] : [];
  }
}

function parseBlock(block: string): SSEEvent | null {
  let event = 'message';
  const data: string[] = [];
  let any = false;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue; // comment / keep-alive
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') { event = value; any = true; }
    else if (field === 'data') { data.push(value); any = true; }
  }
  if (!any) return null;
  const ev: SSEEvent = { event, data: data.join('\n') };
  try { ev.json = JSON.parse(ev.data); } catch { /* not JSON */ }
  return ev;
}

/** Read a fetch Response body as SSE events, calling onEvent for each as it arrives. */
export async function readSSE(res: Response, onEvent?: (e: SSEEvent) => void | boolean): Promise<SSEEvent[]> {
  const all: SSEEvent[] = [];
  const parser = new SSEParser();
  const dec = new TextDecoder();
  const reader = res.body!.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    const evs = done ? [...parser.push(dec.decode()), ...parser.flush()] : parser.push(dec.decode(value, { stream: true }));
    for (const e of evs) {
      all.push(e);
      if (onEvent && onEvent(e) === false) { await reader.cancel(); return all; }
    }
    if (done) return all;
  }
}
