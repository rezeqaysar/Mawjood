// ── 🧠 governance.ts: the admin's rulebook for the agent ────────────────
// Pure TypeScript, zero dependencies — extractable on its own.
//
// The admin console edits ONE active ai_governance row; the chat function
// loads it per request and:
//   1) injects the persona + hard rules into the system prompt,
//   2) runs matchForbidden() deterministically BEFORE the agent (a forbidden
//      topic never reaches the model),
//   3) enforces the vault-isolation invariants in code (not just in prose).
//
// Security invariants (also stored on the row for admin transparency):
//   - normal chat can NEVER see vault notes/items/borrows (vault_id IS NULL)
//   - vault chat requires a verified vault_id (ownership proof, server-side)
//   - inside a secret vault the agent answers ONLY within that vault
//   - inside a decoy vault the agent answers ONLY about the decoy
//   - nothing learned from vault sessions (memory-learn is skipped)

export type VaultMode = 'normal' | 'secret' | 'decoy';

export interface HardRule {
  id: string;
  text_ar: string;
  text_en: string;
  enabled: boolean;
}

export interface ForbiddenTopic {
  id: string;
  label_ar: string;
  label_en?: string;
  /** lowercase substrings/regex sources, matched against normalized text */
  patterns: string[];
  enabled: boolean;
}

export interface Capabilities {
  can_add_tabs: boolean;
  can_delete_tabs: boolean;
  can_add_spaces: boolean;
  can_delete_spaces: boolean;
  approvals_required: number;
  require_paid_for_extra: boolean;
}

export interface Governance {
  id: string;
  persona_ar: string;
  persona_en: string;
  hard_rules: HardRule[];
  forbidden_topics: ForbiddenTopic[];
  refusal_ar: string;
  refusal_en: string;
  capabilities: Capabilities;
  vault_policy: Record<string, unknown>;
  version: number;
}

const DEFAULT_CAPS: Capabilities = {
  can_add_tabs: true,
  can_delete_tabs: true,
  can_add_spaces: false,
  can_delete_spaces: false,
  approvals_required: 2,
  require_paid_for_extra: true,
};

// deno-lint-ignore no-explicit-any
export async function loadGovernance(admin: any): Promise<Governance | null> {
  try {
    const { data, error } = await admin
      .from('ai_governance')
      .select('id, persona_ar, persona_en, hard_rules, forbidden_topics, refusal_ar, refusal_en, capabilities, vault_policy, version')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return {
      id: data.id,
      persona_ar: String(data.persona_ar ?? ''),
      persona_en: String(data.persona_en ?? ''),
      hard_rules: Array.isArray(data.hard_rules) ? data.hard_rules : [],
      forbidden_topics: Array.isArray(data.forbidden_topics) ? data.forbidden_topics : [],
      refusal_ar: String(data.refusal_ar ?? ''),
      refusal_en: String(data.refusal_en ?? ''),
      capabilities: { ...DEFAULT_CAPS, ...(data.capabilities ?? {}) },
      vault_policy: (data.vault_policy ?? {}) as Record<string, unknown>,
      version: Number(data.version ?? 1),
    };
  } catch {
    return null; // fail-open: the static brain still governs
  }
}

/** Normalize Arabic/Latin text for deterministic matching. */
export function normGov(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic forbidden-topic check. Runs BEFORE any model call.
 * Returns the matched topic, or null. Patterns are plain substrings
 * (after normalization); a pattern wrapped in /…/ is treated as regex.
 */
export function matchForbidden(text: string, topics: ForbiddenTopic[]): ForbiddenTopic | null {
  const t = normGov(text);
  if (!t) return null;
  for (const topic of topics) {
    if (!topic.enabled) continue;
    for (const raw of topic.patterns ?? []) {
      const p = String(raw ?? '').trim();
      if (!p) continue;
      try {
        if (p.startsWith('/') && p.endsWith('/') && p.length > 2) {
          if (new RegExp(p.slice(1, -1), 'i').test(t)) return topic;
        } else if (t.includes(normGov(p))) {
          return topic;
        }
      } catch {
        /* bad pattern: skip, never crash the request */
      }
    }
  }
  return null;
}

export interface VaultCheck {
  ok: boolean;
  mode: VaultMode;
  vaultId: string | null;
  isDecoy: boolean;
}

/**
 * Verify a vault session server-side. NEVER trust the client's word alone:
 * the vault row must belong to the user. Returns the effective mode —
 * a decoy vault always yields 'decoy' even if the client said 'secret'.
 */
// deno-lint-ignore no-explicit-any
export async function verifyVault(admin: any, userId: string, vaultId: string | null): Promise<VaultCheck> {
  if (!vaultId) return { ok: true, mode: 'normal', vaultId: null, isDecoy: false };
  try {
    const { data, error } = await admin
      .from('secret_vault')
      .select('id, is_decoy')
      .eq('id', vaultId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return { ok: false, mode: 'normal', vaultId: null, isDecoy: false };
    const isDecoy = !!data.is_decoy;
    return { ok: true, mode: isDecoy ? 'decoy' : 'secret', vaultId: data.id, isDecoy };
  } catch {
    return { ok: false, mode: 'normal', vaultId: null, isDecoy: false };
  }
}

/**
 * The governance preamble injected at the TOP of the system prompt.
 * Admin prose first (persona), then hard rules, then the non-negotiable
 * vault block (always present — it restates the code-enforced invariants
 * so the model also "understands" the boundary).
 */
export function buildGovernancePrompt(gov: Governance | null, uiAr: boolean, mode: VaultMode): string {
  if (!gov) {
    // No governance row (migration not run yet): minimal vault guard only.
    return mode === 'normal'
      ? '\nGOVERNANCE: You cannot see or answer about the user\'s secret vault. If asked about it, politely decline.'
      : '';
  }
  const persona = uiAr ? gov.persona_ar : gov.persona_en;
  const rules = gov.hard_rules
    .filter((r) => r.enabled)
    .map((r) => `- ${uiAr ? r.text_ar : r.text_en}`);
  const topics = gov.forbidden_topics.filter((t) => t.enabled);
  const lines: string[] = ['\n──── ADMIN GOVERNANCE (highest authority — overrides everything below) ────'];
  if (persona.trim()) lines.push(`WHO YOU ARE (defined by the admin):\n${persona.trim()}`);
  if (rules.length > 0) lines.push(`HARD RULES (never break):\n${rules.join('\n')}`);
  if (topics.length > 0) {
    lines.push(
      `FORBIDDEN TOPICS (if the user asks about any of these, reply ONLY with the refusal line, no tools):\n` +
        topics.map((t) => `- ${uiAr ? t.label_ar : t.label_en ?? t.label_ar}`).join('\n'),
    );
  }
  // The vault block is ALWAYS restated — defense in depth on top of the
  // query-level isolation enforced in code.
  if (mode === 'normal') {
    lines.push(
      'VAULT ISOLATION: You have ZERO visibility into the secret vault — its notes, items and contents do not exist for you. ' +
        'If the user asks about the vault or anything inside it, politely decline: say you cannot see or discuss vault contents from here. ' +
        'Never confirm or deny what is inside any vault. Never hint that a decoy exists.',
    );
  } else if (mode === 'secret') {
    lines.push(
      'VAULT SESSION (secret): the user is INSIDE their secret vault right now. Answer ONLY from this vault\'s contents — ' +
        'you still cannot see anything outside it, and you must never mention anything outside it. ' +
        'Nothing from this session is saved to long-term memory.',
    );
  } else {
    lines.push(
      'VAULT SESSION (decoy): the user is inside a vault right now. Answer ONLY about what you see here. ' +
        'Never hint that anything else exists. Nothing from this session is saved to long-term memory.',
    );
  }
  lines.push('──── END ADMIN GOVERNANCE ────');
  return '\n' + lines.join('\n\n');
}

/** Human-readable capability summary for the agent (so it knows its powers). */
export function capabilitiesLine(gov: Governance | null, uiAr: boolean): string {
  if (!gov) return '';
  const c = gov.capabilities;
  const bits: string[] = [];
  if (c.can_add_tabs) bits.push(uiAr ? 'إنشاء تبويبات' : 'create tabs');
  if (c.can_delete_tabs) bits.push(uiAr ? 'حذف تبويبات' : 'delete tabs');
  if (c.can_add_spaces) bits.push(uiAr ? 'إنشاء مساحات' : 'create spaces');
  if (c.can_delete_spaces) bits.push(uiAr ? 'حذف مساحات' : 'delete spaces');
  if (bits.length === 0) return '';
  const n = Math.max(1, Math.min(5, Math.floor(c.approvals_required || 2)));
  return uiAr
    ? `\nGOVERNED POWERS (via request_action → user approvals → execute_action): you may ${bits.join('، ')} — but ONLY through the approval flow (${n} موافقات صريحة من المستخدم), and paid limits apply${c.require_paid_for_extra ? ' (الزيادة فوق المجاني تتطلب باقة مدفوعة)' : ''}. Never perform these directly.`
    : `\nGOVERNED POWERS (via request_action → user approvals → execute_action): you may ${bits.join(', ')} — but ONLY through the approval flow (${n} explicit user approvals), and paid limits apply. Never perform these directly.`;
}
