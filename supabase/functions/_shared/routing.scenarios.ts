// ── 🧭 routing.scenarios.ts: the deep scenario suite ────────────────────────
// Every routing change must pass these: { text, expectSpace, expectTab? }.
// Tabs referenced: 'papers' = 📄 اوراقي الخاصة (private), plus custom tabs
// the suite defines per-space. Run after ANY prompt/rule change — a failing
// scenario means the agent would misfile a real user note.
//
// Pure data + a tiny verifier. No dependencies.

import {
  routeText,
  type TabInfo,
  type LearnedRoute,
  type SpaceType,
} from './routing.ts';

export interface Scenario {
  text: string;
  expectSpace: SpaceType;
  /** tab title the note should land in (null = main notes) */
  expectTab: string | null;
  why: string;
  /** true when the engine SHOULD abstain (layer 4) and let the model decide */
  expectAbstain?: boolean;
}

// The tab universe the scenarios assume (mirrors a real user setup).
export const SCENARIO_TABS: TabInfo[] = [
  { id: 'papers', title: 'اوراقي الخاصة', icon: '📄', space: 'private' },
  { id: 'tab-fam-shop', title: 'مشتريات', icon: '🛒', space: 'family' },
  { id: 'tab-fam-trips', title: 'رحلات', icon: '🧳', space: 'family' },
  { id: 'tab-work-meet', title: 'اجتماعات', icon: '💼', space: 'work' },
];

export const SCENARIOS: Scenario[] = [
  // ── layer 1: explicit commands ──
  { text: 'حطها بالعيلة: رحلة يوم الجمعة', expectSpace: 'family', expectTab: null, why: 'أمر صريح بالمساحة' },
  { text: 'سجلها بالشغل: اجتماع بكرا الساعة 10', expectSpace: 'work', expectTab: null, why: 'أمر صريح بالمساحة' },
  { text: 'احفظها ع الخاص: فكرة مشروع جانبي', expectSpace: 'private', expectTab: null, why: 'أمر صريح بالمساحة' },
  { text: 'حطها بتبويب الأوراق: صورة الجواز', expectSpace: 'private', expectTab: 'اوراقي الخاصة', why: 'أمر صريح بالتبويب' },
  { text: 'ضيفها بتبويب المشتريات: حليب وبيض', expectSpace: 'family', expectTab: 'مشتريات', why: 'تبويب صريح يحدد المساحة' },
  { text: 'للعيلة: بدنا نطلع مشوار', expectSpace: 'family', expectTab: null, why: 'وجهة مختصرة' },

  // ── layer 3: rules ──
  { text: 'اشتريت حليب وخبز من السوبرماركت', expectSpace: 'family', expectTab: 'مشتريات', why: 'مشتريات → تبويب المشتريات' },
  { text: 'ناقصنا بيض وجبنة', expectSpace: 'family', expectTab: 'مشتريات', why: 'ناقصنا → مشتريات' },
  { text: 'صورة فاتورة الكهربا', expectSpace: 'private', expectTab: 'اوراقي الخاصة', why: 'فاتورة → الأوراق' },
  { text: 'عقد إيجار المحل الجديد', expectSpace: 'private', expectTab: 'اوراقي الخاصة', why: 'عقد → الأوراق' },
  { text: 'بكرا عندي اجتماع مع العميل الساعة ٣', expectSpace: 'work', expectTab: null, why: 'اجتماع → الشغل' },
  { text: 'المدير طلب التقرير قبل الخميس', expectSpace: 'work', expectTab: null, why: 'كلمات شغل' },
  { text: 'رحلة العيلة يوم الجمعة على البحر', expectSpace: 'family', expectTab: null, why: 'رحلة عيلة (تبويب الرحلات اختياري للنموذج)' },
  { text: 'الأم بدها دوا من الصيدلية', expectSpace: 'family', expectTab: null, why: 'كلمات عيلة' },
  { text: 'فكرة: أتعلم عزف العود', expectSpace: 'private', expectTab: null, why: 'لا إشارة → المحرك يمتنع والنموذج يقرر (الافتراضي الخاص)', expectAbstain: true },
  { text: 'I need to buy milk tomorrow', expectSpace: 'family', expectTab: 'مشتريات', why: 'إنجليزي: milk → مشتريات' },
  { text: 'meeting with the client at 3pm', expectSpace: 'work', expectTab: null, why: 'إنجليزي: meeting → الشغل' },
  { text: 'اشتريت ساعة جديدة', expectSpace: 'private', expectTab: null, why: 'شراء شخصي بلا علامة → المحرك يمتنع والنموذج يقرر (الخاص)', expectAbstain: true },
  { text: 'اشتريت عطر', expectSpace: 'private', expectTab: null, why: 'شراء شخصي بلا علامة → يمتنع', expectAbstain: true },
  { text: 'I bought a watch', expectSpace: 'private', expectTab: null, why: 'إنجليزي: شراء شخصي → يمتنع', expectAbstain: true },
  { text: 'اشتريت حليب', expectSpace: 'family', expectTab: 'مشتريات', why: 'حليب وحده → مشتريات' },
  { text: 'ستي عملت كعك', expectSpace: 'family', expectTab: null, why: 'عملت (فعل) ≠ عمل — ستي standalone → عيلة' },
  { text: 'خلصت عمل اليوم', expectSpace: 'work', expectTab: null, why: 'عمل standalone → الشغل' },

  // ── tricky: mixed signals → model must decide (engine abstains) ──
  // (these expect null from the engine; the suite marks them model-only)
];

export interface ScenarioResult {
  scenario: Scenario;
  passed: boolean;
  got: { space: SpaceType; tab: string | null; source: string } | null;
}

/** Run the suite. `learned` injects learned-route fixtures for layer-2 tests. */
export function verifyRouting(learned: LearnedRoute[] = []): {
  passed: number;
  failed: number;
  results: ScenarioResult[];
} {
  const results: ScenarioResult[] = SCENARIOS.map((s) => {
    const d = routeText(s.text, { tabs: SCENARIO_TABS, learned });
    if (s.expectAbstain) {
      const passed = d === null;
      return { scenario: s, passed, got: d ? { space: d.space, tab: null, source: d.source } : null };
    }
    const tabTitle = d?.tabId
      ? SCENARIO_TABS.find((t) => t.id === d.tabId)?.title ?? d.tabId
      : null;
    const passed =
      !!d && d.space === s.expectSpace && tabTitle === s.expectTab;
    return {
      scenario: s,
      passed,
      got: d ? { space: d.space, tab: tabTitle, source: d.source } : null,
    };
  });
  return {
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
  };
}

// Layer-2 fixture: the user once corrected "دوا الضغط" → family.
export const LEARNED_FIXTURE: LearnedRoute[] = [
  { keywords: ['دوا', 'ضغط', 'صيدليه'], space: 'family', tabId: null, hits: 2 },
];

export const LEARNED_SCENARIOS: Scenario[] = [
  { text: 'دوا الضغط خلص بدنا نجيب', expectSpace: 'family', expectTab: null, why: 'تعلم من التصحيح' },
];
