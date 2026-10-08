// Deterministic shopping-list detection + parsing for the chat fast path.
// Zero dependencies: pure string functions, unit-tested in supabase/tests.
// Why this exists: a clear shopping list ("بدنا نشتري: حليب، خبز") used to
// fall into the generic "confident space → save a plain note" fast path,
// leaving list creation to the fire-and-forget extract chain — which can
// silently fail (rate limits, model hiccups), stranding the list as a note.

// Intent phrases that unambiguously open a shopping list (Levantine Arabic + English).
const INTENT_RE =
  /(بدنا نشتري|منشتري|لازم نشتري|ناقصنا|ناقصني|(قائمة|قايمة|قائمه)\s+(ال)?(تسوق|مشتريات)|shopping list|grocery list|groceries to buy)/i;

// Verb-first commands: "جيب حليب، خبز" / "buy milk, bread".
const LEAD_VERB_RE = /^(جيب|جيبي|هات|هاتي|اشتري|اشتريلي|buy)\s+/i;

/** True when the message is clearly a shopping list (not a question/correction — caller checks that). */
export function looksLikeShoppingList(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  if (INTENT_RE.test(t)) return true;
  if (LEAD_VERB_RE.test(t)) {
    // verb-first needs list shape: at least one separator between items
    return /[،,؛;\n]/.test(t);
  }
  return false;
}

/** Split a shopping-list message into clean item titles. Keeps qualifiers
 *  ("صابون إيدين نوع نضيف") as part of the title; never splits on "و". */
export function parseShoppingItems(text: string): string[] {
  let t = text.trim();
  // strip the intent prefix ("بدنا نشتري: ", "قائمة تسوق - ", ...)
  t = t.replace(
    /^[^:،,؛;\n]*?(بدنا نشتري|منشتري|لازم نشتري|ناقصنا|ناقصني|(قائمة|قايمة|قائمه)\s+(ال)?(تسوق|مشتريات)|shopping list|grocery list|groceries to buy)\s*:?\s*/i,
    '',
  );
  t = t.replace(LEAD_VERB_RE, '');
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of t.split(/[،,؛;\n]+/)) {
    let item = raw.trim().replace(/\s+/g, ' ').replace(LEAD_VERB_RE, '').trim();
    if (item.length < 2 || item.length > 80) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= 40) break;
  }
  return items;
}
