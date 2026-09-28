/** Home-screen shared types (extracted from the home screen monolith, Phase C). */

/** A tab proposal from the chat agent: rendered as an action card in the bubble. */
export interface TabProposal {
  id: string; // tab_proposals row id
  space_id: string;
  name: string;
  emoji: string;
  reason: string;
  audience: 'manager' | 'member';
  at_limit: boolean;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'app';
  text: string;
  pending?: boolean; // spinner bubble
  photo?: string | null; // attached photo (local uri or remote URL) shown in the bubble
  sources?: { note_id: string; snippet: string }[];
  reaction?: string | null; // user's emoji reaction on this bubble (long-press)
  proposal?: TabProposal | null; // agent-proposed tab card (cleared after action)
}

/** a saved chat session (ChatGPT-style history) */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMsg[];
  updated_at: string;
  expires_at: string;
  ttl: string; // precomputed delete-countdown text (computed at load, not render)
}
