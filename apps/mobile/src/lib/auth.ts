// Real-account auth: email magic link for new users,
// and anonymous → permanent upgrade (keeps the same user id + all data).

import { Platform } from 'react-native';
import { supabase } from './supabase';

function redirectUrl(): string | undefined {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
  // land back on the app page itself; the client picks the session from the URL
  return window.location.href.split('#')[0].split('?')[0];
}

/** Send a magic-link sign-in email. */
export async function sendMagicLink(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: redirectUrl() },
  });
  if (error) throw error;
}

/**
 * Convert the current anonymous user into a permanent account.
 * Same user id → notes, items and spaces are preserved.
 * Supabase emails a confirmation link; the link completes the upgrade.
 */
export async function linkEmailToAnonymous(email: string): Promise<void> {
  const { error } = await supabase.auth.updateUser(
    { email: email.trim() },
    { emailRedirectTo: redirectUrl() },
  );
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
