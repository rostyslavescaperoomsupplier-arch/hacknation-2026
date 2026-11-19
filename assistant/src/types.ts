export type Lang = 'pl' | 'en' | 'de' | 'uk';

export interface Source { label: string; href: string }

/** One assistant turn as the UI shows (and reads aloud) it. */
export interface Answer {
  text: string[];
  sources: Source[];
  /** the assistant could not answer: show the contact links */
  fallback?: boolean;
}

/** Conversation history sent to the server (plain text turns). */
export interface Turn { role: 'user' | 'assistant'; content: string }
