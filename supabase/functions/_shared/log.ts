// Shared structured logging for edge functions (Phase E, P2-1).
//
// Writes to public.ai_events / public.ops_events with the service_role
// client (both tables are locked to service_role).
//
// HARD RULE: never log message content, transcripts, note text, or secrets.
// ai_events carries latency/status/token counts only; ops_events carries
// short event classes. All writes are fire-and-forget-safe: they never throw.

// deno-lint-ignore no-explicit-any
type Supa = any;

export function newRequestId(): string {
  return crypto.randomUUID();
}

export interface AiEvent {
  user_id?: string | null;
  request_id: string;
  fn: string;
  provider: string;
  model: string;
  latency_ms?: number | null;
  status?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  /** Short error class (e.g. 'rate_limited', 'http_400'). Never content. */
  error?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Log one AI provider call. Never throws. */
export async function logAi(supa: Supa, e: AiEvent): Promise<void> {
  try {
    await supa.from('ai_events').insert({
      user_id: e.user_id ?? null,
      request_id: e.request_id,
      fn: e.fn,
      provider: e.provider,
      model: e.model,
      latency_ms: e.latency_ms ?? null,
      status: e.status ?? null,
      prompt_tokens: e.prompt_tokens ?? null,
      completion_tokens: e.completion_tokens ?? null,
      error: e.error ? String(e.error).slice(0, 200) : null,
      meta: e.meta ?? null,
    });
  } catch {
    /* telemetry never breaks the request */
  }
}

export interface OpsEvent {
  user_id?: string | null;
  request_id?: string | null;
  kind: string;
  ok?: boolean | null;
  detail?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Log one operational event. Never throws. */
export async function logOps(supa: Supa, e: OpsEvent): Promise<void> {
  try {
    await supa.from('ops_events').insert({
      user_id: e.user_id ?? null,
      request_id: e.request_id ?? null,
      kind: e.kind,
      ok: e.ok ?? null,
      detail: e.detail ? String(e.detail).slice(0, 300) : null,
      meta: e.meta ?? null,
    });
  } catch {
    /* telemetry never breaks the request */
  }
}
