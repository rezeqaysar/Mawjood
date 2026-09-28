// Shared per-user rate limiting for AI edge functions (Phase E, P1-10).
//
// Fixed windows backed by public.rate_limits through the bump_rate_limit()
// RPC (atomic INSERT ... ON CONFLICT DO UPDATE). Pure window math
// (windowStarts) is unit-testable; only the bump needs a client.
//
// Fail-open by design: if the counter store errors, the request is allowed.
// A broken telemetry table must never take chat offline (avoid self-DoS).

export interface RateLimitRule {
  perMinute: number;
  perHour: number;
}

/** Generous for a human, tight enough to stop runaway loops / abuse. */
export const AI_LIMITS: Record<string, RateLimitRule> = {
  chat: { perMinute: 20, perHour: 200 },
  ask: { perMinute: 20, perHour: 200 },
  extract: { perMinute: 20, perHour: 200 },
  transcribe: { perMinute: 10, perHour: 100 },
  'memory-learn': { perMinute: 20, perHour: 200 },
};

export const DEFAULT_LIMIT: RateLimitRule = { perMinute: 30, perHour: 300 };

/**
 * Non-AI operational limits (Phase E P2-4). Destructive / heavy endpoints
 * get deliberately tight quotas.
 */
export const OP_LIMITS: Record<string, RateLimitRule> = {
  'account-export': { perMinute: 5, perHour: 20 },
  'account-delete': { perMinute: 3, perHour: 10 },
  'report-error': { perMinute: 20, perHour: 200 },
};

/** Truncated window-start timestamps (ISO) for the given instant. Pure. */
export function windowStarts(nowMs: number): { minute: string; hour: string } {
  return {
    minute: new Date(Math.floor(nowMs / 60000) * 60000).toISOString(),
    hour: new Date(Math.floor(nowMs / 3600000) * 3600000).toISOString(),
  };
}

// deno-lint-ignore no-explicit-any
type Supa = any;

/**
 * Bump the caller's counters and report whether the call is within quota.
 * Uses the service_role client (rate_limits is locked to service_role).
 */
export async function checkRateLimit(
  supa: Supa,
  userId: string,
  fn: string,
  nowMs = Date.now(),
): Promise<{ allowed: boolean; window?: 'minute' | 'hour' }> {
  const rule = AI_LIMITS[fn] ?? OP_LIMITS[fn] ?? DEFAULT_LIMIT;
  const { minute, hour } = windowStarts(nowMs);
  try {
    const { data: mCount, error: mErr } = await supa.rpc('bump_rate_limit', {
      p_user_id: userId,
      p_fn: fn,
      p_window: minute,
    });
    if (mErr) return { allowed: true };
    if (typeof mCount === 'number' && mCount > rule.perMinute) {
      return { allowed: false, window: 'minute' };
    }
    const { data: hCount, error: hErr } = await supa.rpc('bump_rate_limit', {
      p_user_id: userId,
      p_fn: fn,
      p_window: hour,
    });
    if (hErr) return { allowed: true };
    if (typeof hCount === 'number' && hCount > rule.perHour) {
      return { allowed: false, window: 'hour' };
    }
    // Opportunistic cleanup of stale windows (>2h) for this user+fn.
    // Fire-and-forget: a failed cleanup must not fail the request.
    try {
      await supa
        .from('rate_limits')
        .delete()
        .eq('user_id', userId)
        .eq('fn', fn)
        .lt('window_start', new Date(nowMs - 2 * 3600000).toISOString());
    } catch { /* ignore */ }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

/** Honest 429 message for the client (uiAr aware). */
export function rateLimitMessage(uiAr: boolean): string {
  return uiAr
    ? 'وصلت للحد المسموح من الطلبات، جرّب بعد دقيقة.'
    : 'Rate limit reached, try again in a minute.';
}
