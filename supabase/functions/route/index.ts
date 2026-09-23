import { aiConfig } from '../_shared/ai.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

// ── space rules (same as `classify`: instant, deterministic) ──
const WORK_RE =
  /(شغل|الشغل|عمل|اجتماع|الاجتماع|مدير|المدير|عميل|العميل|شركة|الشركة|مكتب|المكتب|مشروع|المشروع|راتب|work|meeting|boss|manager|client|office|company|project|salary|invoice)/i;
const FAMILY_RE =
  /(أولاد|اولاد|عيلة|عائلة|العيلة|بيت|البيت|دار|مدرسة|المدرسة|زوجة|زوج|أم|ام|أب|اب|بنت|ولد|جد|ست|خال|عم|بدنا|نشتري|منشتري|اشتري|إشتري|شراء|شرا|سوبرماركت|مشتريات|تسوق|family|kids|kid|home|house|wife|husband|school|mama|baba|mother|father|son|daughter|buy|buying|groceries|grocery|supermarket|shopping)/i;
const ASSIGN_RE = /^([^\d:؟?]{1,15}):\s*\S/;
const DESK_RE = /(درج|جارور|طاولة)\s+(المكتب|مكتب)/;

function ruleSpace(text: string): 'private' | 'family' | 'work' | null {
  const t = DESK_RE.test(text) ? text.replace(/المكتب|مكتب/g, '') : text;
  if (WORK_RE.test(t)) return 'work';
  if (FAMILY_RE.test(t)) return 'family';
  if (ASSIGN_RE.test(t)) return 'family';
  return null;
}

// ── instant layer: obvious questions, re-asks & corrections never reach the model ──
const CORRECTION_START = /^(لا|بس|بل)([\s،,؛;:.!?؟]|$)/;
const QUESTION_MARK = /[؟?]/;
// re-ask / complaint that a question was mishandled → question:
// "انا سالتك متى..." (I asked YOU) / "ما حكيتلك تضيفها" / "ما جاوبتني"
const REASK_RE =
  /(سالتك|سألتك|سئلتك)|ما (حكيت|قلت)(لك|لي) (تضيف|تحفظ|تسجل)|ما (جاوبت|رديت)/;
// clear question patterns (mirrors the client-side isQuestion fallback):
// question word at start, "show me" commands, "remind me what..." phrasing
const QUESTION_RE =
  /^(وين|وينتا|وينت|فين|اين|متى|متي|امتى|امتي|ايمتى|ايمت|وقتاش|شو|ايش|اشنو|شنو|ماذا|مذا|كم|قديش|كيف|ليش|لماذا|هل|مين|من)(\s|$)|^(اعرض|اعرضي|اعرضلي|فرجيني|فرجيلي|ورجيني|ارجيني|طلعلي)(\s|$)|(^|\s)(ذكرني|ذكري|فكرني|قلي|قولي|احكيلي|احكي)(\s+)(شو|وين|وينتا|وينت|فين|اين|متى|متي|امتى|امتي|ايمتى|ايش|اشنو|شنو|ماذا|مذا|كم|قديش|كيف|ليش|لماذا|هل|مين|من)(\s|$)/;

const SYSTEM = `You are the input router for Mawjood, a voice-memory app. Look at the conversation and classify the LAST user message.

Reply with ONLY JSON: {"action":"question|note|correction","space_type":"private|family|work"}

- "question": the user ASKS about their own data — appointments, where things are, shopping lists, tasks. Includes re-asking after a mistake ("I asked you when the appointment is, I didn't tell you to save it"), and "show me / remind me what ..." requests.
- "note": the user STATES something to remember — "I have a ...", "buy ...", "I put X in ...".
- "correction": the user CORRECTS the assistant's previous answer — gives a new value for what was just answered.

RE-ASK RULE (important): if the user says they already asked ("انا سالتك", "سألتك", "ما جاوبتني") or complains the assistant saved instead of answering ("ما حكيتلك تضيفها", "ما قلتلك احفظها", "ليش حفظتها") → "question". They want the ANSWER now, not another note.
REPORTED SPEECH RULE: "سألته متى" / "حكيتله وين" / "اتصلت وسألت" (I asked HIM...) = "note" — it's reporting something that happened, not asking the assistant.

space_type is only used when action=note (best guess is fine):
- family: home life — groceries, supermarket, household, spouse, kids, family members, "we"
- work: job — meeting, boss, client, office
- private: personal — health, medication, personal belongings

Examples:
"وينتا موعدي عند المحامي" → {"action":"question","space_type":"private"}
"متى موعد العيادة؟" → {"action":"question","space_type":"private"}
"انا سالتك متى الموعد عند المحامي ما حكيتلك تضيفها" → {"action":"question","space_type":"private"}
"سألتك وين حطيت المفاتيح وما رديت علي" → {"action":"question","space_type":"private"}
"اتصلت بالدكتور وسألته متى بيجي" → {"action":"note","space_type":"private"}
"اعرضلي قائمة التسوق" → {"action":"question","space_type":"private"}
"عندي موعد عيادة بعد بكرا الساعة ١٢" → {"action":"note","space_type":"family"}
"بدنا نشتري حليب" → {"action":"note","space_type":"family"}
"لا، نقلته على الخزانة" → {"action":"correction","space_type":"private"}

Reply with ONLY the JSON object, nothing else.`;

type HistMsg = { role: string; text: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { text, history } = await req.json();
    if (!text?.trim()) throw new Error('text is required');
    const t = text.slice(0, 500);
    const hist: HistMsg[] = Array.isArray(history) ? history.slice(-6) : [];

    // instant layer
    let action: 'question' | 'note' | 'correction' | null = null;
    if (QUESTION_MARK.test(t)) action = 'question';
    else if (CORRECTION_START.test(t.trim())) action = 'correction';
    else if (REASK_RE.test(t)) action = 'question';
    else if (QUESTION_RE.test(t.trim())) action = 'question';

    let space_type: 'private' | 'family' | 'work' = 'private';

    if (!action) {
      const ai = aiConfig();
      const convo = hist
        .map((m) => `${m.role === 'user' ? 'user' : 'assistant'}: ${m.text}`)
        .join('\n');
      const aiRes = await fetch(`${ai.base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ai.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ai.chatModel,
          temperature: 0,
          max_tokens: 80,
          messages: [
            { role: 'system', content: SYSTEM },
            {
              role: 'user',
              content: `Conversation:\n${convo || '(none)'}\n\nLast user message: ${t}\n\nReply with ONLY the JSON object.`,
            },
          ],
        }),
      });
      if (!aiRes.ok) {
        const b = await aiRes.text();
        throw new Error(`${ai.provider} ${aiRes.status}: ${b.slice(0, 120)}`);
      }
      const j = await aiRes.json();
      const raw = (j.choices?.[0]?.message?.content ?? '').trim();
      const clean = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
      try {
        const p = JSON.parse(clean);
        if (['question', 'note', 'correction'].includes(p.action)) action = p.action;
        if (['private', 'family', 'work'].includes(p.space_type)) space_type = p.space_type;
      } catch {
        const m = clean.match(/"(question|note|correction)"/);
        if (m) action = m[1] as typeof action;
      }
    }

    if (!action) action = 'note';
    // deterministic space rules win for notes (tested 10/10)
    if (action === 'note') space_type = ruleSpace(t) ?? space_type;

    return new Response(JSON.stringify({ action, space_type }), {
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
