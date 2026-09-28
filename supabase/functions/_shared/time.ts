// Phase E P2-3: timezone model helpers.
//
// The app stores the device IANA timezone on profiles.timezone. Edge
// functions resolve relative dates ("tomorrow", "بكرا") against the user's
// real zone instead of a hardcoded America/New_York.
//
// Model: absolute datetimes are stored as ISO8601 UTC; date-only intent
// ("on Friday") is resolved in the user's zone at parse time; the zone
// itself travels with the request (chat body `tz`) or the profile row.

/** IANA-ish validation: "Area/Location", e.g. America/New_York. */
export function isValidTimezone(tz: unknown): tz is string {
  return (
    typeof tz === 'string' &&
    tz.length <= 64 &&
    /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+$/.test(tz)
  );
}

/**
 * Safe timezone or the fallback. Never throws, never returns garbage —
 * an invalid value always collapses to the user's home zone.
 */
export function sanitizeTimezone(tz: unknown, fallback = 'America/New_York'): string {
  return isValidTimezone(tz) ? (tz as string) : fallback;
}
