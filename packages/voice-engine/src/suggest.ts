import type { SpaceType } from './types';

// Heuristic space suggestion from note content (bilingual AR/EN).
// Runs fully on-device: no network, no AI cost.
const FAMILY_RE =
  /(أولاد|اولاد|عيلة|عائلة|العيلة|بيت|البيت|دار|مدرسة|المدرسة|زوجة|زوج|أم|ام|أب|اب|بنت|ولد|جد|ست|خال|عم|family|kids|kid|home|house|wife|husband|school|mama|baba|mother|father|son|daughter)/i;
const WORK_RE =
  /(شغل|الشغل|عمل|اجتماع|الاجتماع|مدير|المدير|عميل|العميل|شركة|الشركة|مكتب|المكتب|مشروع|المشروع|راتب|work|meeting|boss|manager|client|office|company|project|salary)/i;

/** Suggest the most fitting space for a note's text. Defaults to private. */
export function suggestSpaceType(text: string): SpaceType {
  if (!text || !text.trim()) return 'private';
  if (FAMILY_RE.test(text)) return 'family';
  if (WORK_RE.test(text)) return 'work';
  return 'private';
}
