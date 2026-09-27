import type { SpaceType } from '@mawjood/voice-engine';

/** Home-screen module constants (extracted from the home screen monolith, Phase C). */

export const VOICE_REPLY_KEY = 'mawjood.voice-reply'; // '1' = speak replies to voice notes

export const KIND_ICON: Record<string, string> = {
  task: '⬜',
  appointment: '📅',
  shopping: '🛒',
  place: '📍',
  spec: '📏',
  opinion: '💭',
  checklist: '🧳',
  thing: '📦',
};

export const SPACE_LABELS: Record<string, string> = {
  private: '🔒 Private',
  family: '👨‍👩‍👧 Family',
  work: '💼 Work',
};

// built-in family tab keys — anything else in familyTab is a custom tab id
export const FAMILY_BUILTIN_KEYS: ReadonlySet<string> = new Set([
  'members',
  'shopping',
  'tasks',
  'agenda',
  'things',
  'notes',
]);

export const SPACE_SHORT: Record<SpaceType, string> = {
  private: '🔒',
  family: '👨‍👩‍👧',
  work: '💼',
};

export type AppView = 'chat' | SpaceType;

export const ACTIVE_CHAT_KEY = 'mawjood.active-chat'; // in-progress chat draft
export const ACTIVE_FAMILY_KEY = 'mawjood.active-family.v1'; // last-viewed family space id
export const HISTORY_IDLE_MS = 2 * 60 * 1000; // current chat survives 2 min after background
export const MAX_HISTORY_MSGS = 100; // cap stored messages per session
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
