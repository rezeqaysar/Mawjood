import type { SpaceType } from './types';

// Local space suggestion (bilingual AR/EN) — mirrors the rule layer of the
// `classify` edge function. Used as a fallback when the AI is unreachable;
// the app itself never asks the user to choose a space.
const WORK_RE =
  /(شغل|الشغل|عمل|اجتماع|الاجتماع|مدير|المدير|عميل|العميل|شركة|الشركة|مكتب|المكتب|مشروع|المشروع|راتب|work|meeting|boss|manager|client|office|company|project|salary|invoice)/i;
const FAMILY_RE =
  /(أولاد|اولاد|عيلة|عائلة|العيلة|بيت|البيت|دار|مدرسة|المدرسة|زوجة|زوج|أم|ام|أب|اب|بنت|ولد|جد|ست|خال|عم|بدنا|نشتري|منشتري|اشتري|إشتري|شراء|شرا|سوبرماركت|مشتريات|تسوق|family|kids|kid|home|house|wife|husband|school|mama|baba|mother|father|son|daughter|buy|buying|groceries|grocery|supermarket|shopping)/i;
const ASSIGN_RE = /^([^\d:؟?]{1,15}):\s*\S/;
// "درج المكتب / طاولة المكتب" = furniture (a desk), not a workplace
const DESK_RE = /(درج|جارور|طاولة)\s+(المكتب|مكتب)/;

/** Suggest the most fitting space for a note's text. Defaults to private. */
export function suggestSpaceType(text: string): SpaceType {
  if (!text || !text.trim()) return 'private';
  const t = DESK_RE.test(text) ? text.replace(/المكتب|مكتب/g, '') : text;
  if (WORK_RE.test(t)) return 'work';
  if (FAMILY_RE.test(t)) return 'family';
  if (ASSIGN_RE.test(t)) return 'family';
  return 'private';
}
