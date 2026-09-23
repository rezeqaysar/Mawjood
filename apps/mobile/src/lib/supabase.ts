import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    'Supabase env vars missing — set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY',
  );
}

export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // web: pick up the session from the magic-link redirect URL fragment
    detectSessionInUrl: Platform.OS === 'web',
  },
});

/** Anonymous sign-in for the trial (kept for returning anon users). */
export async function ensureSignedIn() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user;
  const { data: anon, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return anon.user!;
}
