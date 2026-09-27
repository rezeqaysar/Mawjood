import type { Note } from '@mawjood/voice-engine';
import { tx } from '../../lib/i18n';

/** Home-screen pure helpers (extracted from the home screen monolith, Phase C). */

export function statusLabel(n: Note): string {
  switch (n.status) {
    case 'ready':
      return n.transcript || '(empty transcript)';
    case 'failed':
      return `⚠️ failed: ${n.error ?? 'unknown error'}`;
    case 'transcribing':
      return '⏳ transcribing…';
    case 'uploading':
      return '⏳ uploading…';
    default:
      return '⏳ processing…';
  }
}

export const newSessionId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** delete-countdown text; called from event handlers (impure: Date.now), never render */
export function ttlText(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return '…';
  const mins = Math.max(1, Math.floor(ms / 60000));
  if (mins < 60) return tx('ttlMins', { n: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return tx('ttlHours', { n: hrs });
  return tx('ttlDays', { n: Math.floor(hrs / 24) });
}

/** master-key recovery wait; called from event handlers (impure: Date.now), never render */
export function recoveryWaitInfo(requestedAt: string | null): { ready: boolean; daysLeft: number } | null {
  if (!requestedAt) return null;
  const elapsed = Date.now() - new Date(requestedAt).getTime();
  const wait = 7 * 24 * 3600 * 1000;
  return { ready: elapsed >= wait, daysLeft: Math.max(1, Math.ceil((wait - elapsed) / 86400000)) };
}

// secret-word inputs follow the CONTENT (keyboard) language, not the UI language:
// Arabic-script content → right aligned, anything else → left aligned.
const RTL_RE = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
export const codeAlign = (s: string): 'left' | 'right' => (s && RTL_RE.test(s) ? 'right' : 'left');
