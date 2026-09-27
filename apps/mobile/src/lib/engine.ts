import { VoiceEngine } from '@mawjood/voice-engine';
import { supabase } from './supabase';

/** Shared VoiceEngine singleton (was module-level in the home screen). */
export const engine = new VoiceEngine(supabase);
