// Phase 3 — family pillar helpers.
// "سارة: اشتري خبز" → { name: 'سارة', task: 'اشتري خبز' }

const ASSIGN_RE = /^([\p{L}][\p{L} .]{1,20}?)\s*[:：]\s*(.+)$/u;
const NON_NAME_START = /^(الساعة|ساعة|الوقت|وقت|اليوم|بكرا|غدا)\b/;

/**
 * Detect the "name: task" assignment pattern in a family-space note.
 * Returns null when the text isn't an assignment.
 */
export function parseAssignment(text: string): { name: string; task: string } | null {
  const m = text.trim().match(ASSIGN_RE);
  if (!m) return null;
  const name = m[1].trim();
  const task = m[2].trim();
  if (!task || NON_NAME_START.test(name)) return null;
  return { name, task };
}
