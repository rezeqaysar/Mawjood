// remoteConfig — pull-based public app config (plans, feature flags,
// broadcasts) from the anon-safe `public-config` edge function.
// Fetched once per app session and cached in memory; the admin's feature
// flags act as real kill switches the client gates paid hooks on.
import { supabase } from './supabase';

export interface RemotePlan {
  id: string;
  name_ar: string;
  name_en: string;
  price_cents: number | null; // null = not priced yet (proposal)
  currency: string;
  duration_days: number;
  features: string[];
}

export interface RemoteBroadcast {
  id: string;
  title_ar: string;
  body_ar: string;
  title_en: string;
  body_en: string;
  target: 'all' | 'premium' | 'free';
}

export interface RemoteConfig {
  plans: RemotePlan[];
  flags: Record<string, boolean>;
  broadcasts: RemoteBroadcast[];
  is_premium: boolean;
}

let cached: RemoteConfig | null = null;
let inflight: Promise<RemoteConfig | null> | null = null;

const EMPTY: RemoteConfig = { plans: [], flags: {}, broadcasts: [], is_premium: false };

/** Fetch once, cache in memory. Fail-open: returns null on error. */
export function fetchRemoteConfig(force = false): Promise<RemoteConfig | null> {
  if (cached && !force) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await supabase.functions.invoke('public-config', { method: 'POST' });
      if (error) throw error;
      const d = (data ?? {}) as Partial<RemoteConfig>;
      cached = {
        plans: Array.isArray(d.plans) ? d.plans : [],
        flags: d.flags && typeof d.flags === 'object' ? d.flags : {},
        broadcasts: Array.isArray(d.broadcasts) ? d.broadcasts : [],
        is_premium: d.is_premium === true,
      };
      return cached;
    } catch (e) {
      console.warn('public-config failed', e);
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getCachedConfig(): RemoteConfig {
  return cached ?? EMPTY;
}

/** Kill-switch check: only an explicit `false` disables (fail-open offline). */
export function flagOn(flags: Record<string, boolean> | null | undefined, key: string): boolean {
  if (!flags) return true;
  return flags[key] !== false;
}
