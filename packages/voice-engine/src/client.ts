import type { SupabaseClient } from '@supabase/supabase-js';
import type { Note, RecordedAudio, Space } from './types';

/**
 * API-first client for the Mawjood voice-memory engine.
 * Owns the whole lifecycle: upload audio → trigger transcription → read notes.
 * Storage + DB live in Supabase; transcription runs in the `transcribe` edge function.
 */
export class VoiceEngine {
  constructor(private supabase: SupabaseClient) {}

  // ── Spaces ──────────────────────────────────────────────

  async listSpaces(): Promise<Space[]> {
    const { data, error } = await this.supabase
      .from('spaces')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data as Space[];
  }

  async ensureDefaultSpaces(userId: string): Promise<Space[]> {
    const existing = await this.listSpaces();
    if (existing.length > 0) return existing;
    const defaults = [
      { owner_id: userId, type: 'private', name: 'Private' },
      { owner_id: userId, type: 'family', name: 'Family' },
      { owner_id: userId, type: 'work', name: 'Work' },
    ];
    const { data, error } = await this.supabase
      .from('spaces')
      .insert(defaults)
      .select();
    if (error) throw error;
    return data as Space[];
  }

  // ── Notes ───────────────────────────────────────────────

  async listNotes(spaceId: string, limit = 50): Promise<Note[]> {
    const { data, error } = await this.supabase
      .from('notes')
      .select('*')
      .eq('space_id', spaceId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as Note[];
  }

  /**
   * Full pipeline for one voice note:
   * 1. create note row (status: uploading)
   * 2. upload audio to storage
   * 3. mark transcribing + invoke `transcribe` edge function
   * 4. return the note (caller can re-fetch for the transcript)
   */
  async saveVoiceNote(
    spaceId: string,
    audio: RecordedAudio,
    userId: string,
  ): Promise<Note> {
    // 1. create the row
    const { data: note, error: insertError } = await this.supabase
      .from('notes')
      .insert({
        space_id: spaceId,
        status: 'uploading',
        duration_sec: Math.round(audio.durationSec),
        created_by: userId,
      })
      .select()
      .single();
    if (insertError) throw insertError;

    try {
      // 2. upload audio
      const ext = audio.mimeType.includes('mp4') || audio.mimeType.includes('m4a') ? 'm4a' : 'wav';
      const path = `${userId}/${note.id}.${ext}`;
      const file = await this.uriToBlob(audio.uri, audio.mimeType);
      const { error: uploadError } = await this.supabase.storage
        .from('voice-notes')
        .upload(path, file, { contentType: audio.mimeType, upsert: true });
      if (uploadError) throw uploadError;

      const { data: urlData } = this.supabase.storage
        .from('voice-notes')
        .getPublicUrl(path);

      await this.supabase
        .from('notes')
        .update({ audio_url: urlData.publicUrl, status: 'transcribing' })
        .eq('id', note.id);

      // 3. trigger transcription (edge function updates the row when done)
      const { error: fnError } = await this.supabase.functions.invoke(
        'transcribe',
        { body: { note_id: note.id } },
      );
      if (fnError) throw fnError;

      return { ...note, audio_url: urlData.publicUrl, status: 'transcribing' } as Note;
    } catch (err) {
      await this.supabase
        .from('notes')
        .update({
          status: 'failed',
          error: err instanceof Error ? err.message : 'upload failed',
        })
        .eq('id', note.id);
      throw err;
    }
  }

  async getNote(noteId: string): Promise<Note> {
    const { data, error } = await this.supabase
      .from('notes')
      .select('*')
      .eq('id', noteId)
      .single();
    if (error) throw error;
    return data as Note;
  }

  private async uriToBlob(uri: string, mimeType: string): Promise<Blob> {
    const res = await fetch(uri);
    const buf = await res.arrayBuffer();
    return new Blob([buf], { type: mimeType });
  }
}
