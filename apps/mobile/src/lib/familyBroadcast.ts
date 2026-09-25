// ── 👨‍👩‍👧 Family-broadcast engine ("العيلة كحسّاسات") ────────────────────
// "اسأل العيلة مين شاف الريموت؟" → one question pushed to every family
// member (except the sender) + a shared note in the family space as the
// visible record everyone can see. The detective hands off here with
// "بث للعيلة" while a search is active.
//
// REUSABLE BY DESIGN: no React, no UI imports — pure intent detection,
// data shaping and formatting. Nothing here touches storage except
// through the structural BroadcastClient.

import { t, tx } from './i18n';

/** Minimal client surface the broadcast needs — structural typing. */
export interface BroadcastClient {
  getFamilyMembers(spaceId: string): Promise<{ user_id: string; display_name: string | null }[]>;
  saveTextNote(spaceId: string, text: string, userId: string): Promise<unknown>;
  notifySpace(spaceId: string, title: string, body: string, excludeUserId?: string): Promise<void>;
}

export class NoFamilyMembersError extends Error {
  constructor() {
    super('no-family-members');
    this.name = 'NoFamilyMembersError';
  }
}

// ── intent detection ────────────────────────────────────────────────

function cleanQuestion(s: string): string {
  return s.trim().replace(/[؟?!.,،:؛]+$/g, '').trim();
}

const AR_EXPLICIT: RegExp[] = [
  /^(?:اسأل|اسال)\s+(?:العيلة|العائلة)\s*[:؟]?\s*(.+)/, // اسأل العيلة مين شاف الريموت
  /^(?:بث|ابث)\s+(?:للعيلة|للعائلة)\s*[:؟]?\s*(.+)/, // بث للعيلة: مين شاف الريموت؟
];

const AR_BARE: RegExp[] = [
  /^(?:بث|ابث)\s+(?:للعيلة|للعائلة)\s*$/, // بث للعيلة (needs the active search item)
  /^(?:بثها|ابثها)(?:\s+للعيلة)?\s*$/,
];

const EN_EXPLICIT: RegExp[] = [
  /^ask the family\s+(.+)/i,
  /^broadcast to the family\s+(.+)/i,
];

/**
 * Parse a broadcast request. `fallbackItem` is the detective's active
 * search item — a bare "بث للعيلة" broadcasts "مين شاف {item}؟".
 * Returns the question, else null.
 */
export function parseBroadcast(text: string, fallbackItem?: string | null): string | null {
  const clean = text.trim();
  for (const re of [...AR_EXPLICIT, ...EN_EXPLICIT]) {
    const m = clean.match(re);
    if (m?.[1]) {
      const q = cleanQuestion(m[1]);
      if (q.length > 0) return q;
    }
  }
  if (fallbackItem) {
    for (const re of AR_BARE) {
      if (re.test(clean)) return broadcastQuestionFor(fallbackItem);
    }
  }
  return null;
}

/** "مين شاف الريموت؟" / "Who has seen the remote?" */
export function broadcastQuestionFor(item: string): string {
  return tx('broadcastQuestionFor', { item });
}

// ── sending ─────────────────────────────────────────────────────────

export interface BroadcastInput {
  spaceId: string;
  question: string;
  senderName: string;
  senderUserId: string;
}

export interface BroadcastResult {
  /** family members the question went to (sender excluded) */
  recipients: number;
  /** false when the push failed but the shared note was still saved */
  pushOk: boolean;
}

/**
 * Save the question as a shared family note (the visible record), then
 * push it to every family member except the sender.
 * Throws NoFamilyMembersError when the sender is alone in the space.
 */
export async function sendFamilyBroadcast(
  client: BroadcastClient,
  input: BroadcastInput,
): Promise<BroadcastResult> {
  const members = await client.getFamilyMembers(input.spaceId).catch(() => []);
  const others = (members ?? []).filter((m) => m.user_id !== input.senderUserId);
  if (others.length === 0) throw new NoFamilyMembersError();

  // the shared record — everyone sees the question in the family space
  const noteText = tx('broadcastNote', { question: input.question, sender: input.senderName });
  await client.saveTextNote(input.spaceId, noteText, input.senderUserId);

  // the ping — push only, never fails the broadcast
  let pushOk = true;
  try {
    await client.notifySpace(
      input.spaceId,
      tx('broadcastPushTitle', { sender: input.senderName }),
      input.question,
      input.senderUserId,
    );
  } catch {
    pushOk = false;
  }
  return { recipients: others.length, pushOk };
}

export function formatBroadcastSent(question: string, recipients: number): string {
  return tx('broadcastSent', { n: String(recipients), question });
}

export function formatNoMembers(): string {
  return t('broadcastNoMembers');
}
