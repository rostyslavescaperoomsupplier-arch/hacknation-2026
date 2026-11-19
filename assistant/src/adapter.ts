// The chat talks to one function: ask(history, lang) -> Answer.
// It POSTs the whole conversation to the assistant server (server/index.ts), which calls Claude with the API key
// kept on the server. On error or timeout the UI gets an offline answer with the contact links.
import type { Answer, Lang, Turn } from './types';
import { STR } from './i18n';

const URL = (import.meta.env.VITE_ASSISTANT_URL as string | undefined) || '/api/chat';

export async function ask(history: Turn[], lang: Lang): Promise<Answer & { remoteFailed?: boolean }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang, messages: history.slice(-20) }),
      signal: ctrl.signal,
      credentials: 'omit',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(String(res.status));
    const r = (await res.json()) as Answer;
    return { text: r.text?.length ? r.text : [STR[lang].offline], sources: r.sources ?? [], fallback: r.fallback };
  } catch {
    return { text: [STR[lang].offline], sources: [], fallback: true, remoteFailed: true };
  }
}
