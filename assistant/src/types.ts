export type Lang = 'pl' | 'en' | 'de' | 'uk';

export interface Source { label: string; href: string }

export type Stair = 'stair-aft' | 'stair-fwd';

/** UI action proposed by the assistant (parsed and validated on the server from [[ROUTE:..]] / [[DRILL:..]]).
 *  `zone` / `id` are ZoneId / DrillId strings from the contract; `label` is the human name in the reply language. */
export type Action =
  | { type: 'route'; zone: string; blocked?: Stair; label: string }
  | { type: 'drill'; id: string; label: string };

/** One assistant turn as the UI shows (and reads aloud) it. */
export interface Answer {
  text: string[];
  sources: Source[];
  /** the assistant could not answer: show the contact links */
  fallback?: boolean;
  /** buttons under the answer: open an evacuation route or a drill */
  actions?: Action[];
}

/** Conversation history sent to the server (plain text turns). */
export interface Turn { role: 'user' | 'assistant'; content: string }
