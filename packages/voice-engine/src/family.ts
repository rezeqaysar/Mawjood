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

// ── directed shopping: "يا جون جيب تفاح خيار بندورة" ──
// One shopping list is created for the named person, who gets the
// notification; everyone in the family space can see the list.

const SHOP_VERBS = 'جيب|جيبي|هات|هاتي|اشتري|اشتر|خذ|خد|خود|جبلنا|جبلي|جبيلي|جيبلي';
// note: \b doesn't work after Arabic letters (\w is latin-only), so the
// verb is followed by an explicit whitespace/end lookahead instead.
const DIRECTED_SHOP_RE = new RegExp(
  `^\\s*يا\\s+([\\p{L}][\\p{L} ]{1,38}?)\\s+(?:${SHOP_VERBS})(?=\\s|$)\\s*(.+)$`,
  'u',
);

/**
 * Detect "يا {name} {buy-verb} {items}". Returns null when the text
 * isn't a directed shopping request.
 */
export function parseDirectedShopping(text: string): { name: string; itemsRaw: string } | null {
  const m = text.trim().match(DIRECTED_SHOP_RE);
  if (!m) return null;
  const name = m[1].trim();
  const itemsRaw = m[2].trim();
  if (!itemsRaw) return null;
  return { name, itemsRaw };
}

/**
 * Split "تفاح، خيار وبندورة" / "تفاح خيار بندورة" into item titles.
 * Explicit separators (، , و) first; bare words as a last resort —
 * in a spoken grocery list "جيب تفاح خيار بندورة" almost always
 * means three items, and a wrong split only costs an extra checkbox.
 */
export function splitShoppingItems(raw: string): string[] {
  const out: string[] = [];
  for (const chunk of raw.split(/[،,]/)) {
    for (const part of chunk.split(/\s+و\s+/)) {
      for (const w of part.trim().split(/\s+/)) {
        const word = w.replace(/^و/, '').trim();
        if (word) out.push(word);
      }
    }
  }
  return out;
}

/** Arabic-name normalization for member matching (أ/إ/آ→ا, ة→ه, ى→ي). */
export function normalizeName(s: string): string {
  return s
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .trim();
}

export interface FamilyMemberLike {
  user_id: string;
  display_name: string | null;
  is_manager: boolean;
  role: string;
}

/**
 * Resolve "جون" / "زوجي" to a family member.
 * - زوجي/جوزي → the family manager (owner)
 * - otherwise → exact match on the first word of a member's display name
 * Returns null when nobody matches — the caller then falls back to the
 * normal flow instead of notifying the wrong person.
 */
export function resolveFamilyMember(
  rawName: string,
  members: FamilyMemberLike[],
): { user_id: string; display_name: string | null } | null {
  const n = normalizeName(rawName);
  if (/^(زوجي|جوزي)$/.test(n)) {
    const o = members.find((m) => m.is_manager || m.role === 'owner');
    return o ? { user_id: o.user_id, display_name: o.display_name } : null;
  }
  for (const m of members) {
    const dn = normalizeName(m.display_name ?? '');
    if (!dn) continue;
    const first = dn.split(/\s+/)[0];
    if (first === n || dn === n) {
      return { user_id: m.user_id, display_name: m.display_name };
    }
  }
  return null;
}
