import { aiConfig } from '../_shared/ai.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

// ── Layer 1: high-precision deterministic rules ──
// Clear cases never reach the model: instant, free, and consistent.
const WORK_RE =
  /(شغل|الشغل|عمل|اجتماع|الاجتماع|مدير|المدير|عميل|العميل|شركة|الشركة|مكتب|المكتب|مشروع|المشروع|راتب|work|meeting|boss|manager|client|office|company|project|salary|invoice)/i;
const FAMILY_RE =
  /(أولاد|اولاد|عيلة|عائلة|العيلة|بيت|البيت|دار|مدرسة|المدرسة|زوجة|زوج|أم|ام|أب|اب|بنت|ولد|جد|ست|خال|عم|بدنا|نشتري|منشتري|اشتري|إشتري|شراء|شرا|سوبرماركت|مشتريات|تسوق|family|kids|kid|home|house|wife|husband|school|mama|baba|mother|father|son|daughter|buy|buying|groceries|grocery|supermarket|shopping)/i;
// "name: do X" assignment pattern (e.g. "سارة: اشتري خبز") — name part has no digits
const ASSIGN_RE = /^([^\d:؟?]{1,15}):\s*\S/;

// "درج المكتب / طاولة المكتب" = furniture (a desk), not a workplace —
// neutralize it before the work rule runs, so genuinely ambiguous cases
// fall through to the AI instead of being forced into work.
const DESK_RE = /(درج|جارور|طاولة)\s+(المكتب|مكتب)/;

function ruleClassify(text: string): 'private' | 'family' | 'work' | null {
  const t = DESK_RE.test(text) ? text.replace(/المكتب|مكتب/g, '') : text;
  if (WORK_RE.test(t)) return 'work';
  if (FAMILY_RE.test(t)) return 'family';
  if (ASSIGN_RE.test(t)) return 'family';
  return null;
}

// ── Layer 2: the model, for genuinely ambiguous notes ──
const SYSTEM = `You are a classifier. Reply with EXACTLY one word: private, family, or work. No punctuation, no explanation.

family = home life: groceries, shopping, household, spouse, kids, family members
work = job: meeting, boss, client, office, invoice, project
private = personal: health, medication, personal belongings, everything else

Examples:
"بكرا عندي اجتماع مع المدير" → work
"بدنا نشتري حليب وخبز من السوبرماركت" → family
"حطيت جواز السفر بالدرج" → private
"ذكرني آخذ الدوا" → private`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { text } = await req.json();
    if (!text?.trim()) throw new Error('text is required');
    const t = text.slice(0, 500);

    const ruled = ruleClassify(t);
    if (ruled) {
      return new Response(JSON.stringify({ space_type: ruled, via: 'rules' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const ai = aiConfig();
    const aiRes = await fetch(`${ai.base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ai.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ai.chatModel,
        temperature: 0,
        max_tokens: 60,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: t },
        ],
      }),
    });
    if (!aiRes.ok) {
      const b = await aiRes.text();
      throw new Error(`${ai.provider} ${aiRes.status}: ${b.slice(0, 120)}`);
    }
    const j = await aiRes.json();
    const raw = (j.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
    let space_type = 'private';
    const m = raw.match(/\b(private|family|work)\b/);
    if (m) space_type = m[1];
    return new Response(JSON.stringify({ space_type, via: 'ai' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
