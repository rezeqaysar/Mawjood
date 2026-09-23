import type { SupabaseClient } from '@supabase/supabase-js';
import type { Item, ItemKind, Note, RecordedAudio, Space } from './types';

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
      const mt = audio.mimeType.toLowerCase();
      const ext = mt.includes('m4a') || mt.includes('mp4') ? 'm4a' : mt.includes('webm') ? 'webm' : 'wav';
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

  /**
   * Text-note pipeline: no audio involved — the typed text IS the transcript.
   * Inserts the note as `ready`, then triggers `extract` fire-and-forget
   * (same as the transcribe function does for voice notes).
   */
  async saveTextNote(
    spaceId: string,
    text: string,
    userId: string,
  ): Promise<Note> {
    const clean = text.trim();
    if (!clean) throw new Error('empty text');
    const { data: note, error } = await this.supabase
      .from('notes')
      .insert({
        space_id: spaceId,
        transcript: clean,
        status: 'ready',
        created_by: userId,
      })
      .select()
      .single();
    if (error) throw error;
    // extraction runs in the background; caller can refresh items shortly after
    this.supabase.functions
      .invoke('extract', { body: { note_id: note.id } })
      .catch(() => {});
    return note as Note;
  }

  /** Move a note (and all its extracted items) to another space. */
  async moveNote(noteId: string, targetSpaceId: string): Promise<void> {
    const { error: itemsErr } = await this.supabase
      .from('items')
      .update({ space_id: targetSpaceId })
      .eq('note_id', noteId);
    if (itemsErr) throw itemsErr;
    const { error: noteErr } = await this.supabase
      .from('notes')
      .update({ space_id: targetSpaceId })
      .eq('id', noteId);
    if (noteErr) throw noteErr;
  }

  /** Delete a note and its extracted items. */
  async deleteNote(noteId: string): Promise<void> {
    const { error: itemsErr } = await this.supabase
      .from('items')
      .delete()
      .eq('note_id', noteId);
    if (itemsErr) throw itemsErr;
    const { error: noteErr } = await this.supabase
      .from('notes')
      .delete()
      .eq('id', noteId);
    if (noteErr) throw noteErr;
  }

  /**
   * Insert clearly-labeled demo notes + items across the user's spaces.
   * Lets the user try move/suggest/toggle flows while live transcription
   * (OpenAI) is unavailable. Returns the created note ids for later cleanup.
   */
  async seedDemoData(userId: string, spaces: Space[]): Promise<string[]> {
    const byType = Object.fromEntries(spaces.map((s) => [s.type, s.id]));
    const in3d = new Date(Date.now() + 3 * 864e5).toISOString();
    const lastWeek = new Date(Date.now() - 7 * 864e5).toISOString();
    const demos: Array<{
      space: string;
      transcript: string;
      items: Array<{
        kind: Item['kind'];
        title: string;
        details?: string;
        due_at?: string;
      }>;
    }> = [
      {
        space: 'private',
        transcript: '🧪 تجربة: جواز السفر حطيته بالدرج العلوي بغرفة النوم',
        items: [
          { kind: 'place', title: 'جواز السفر', details: 'الدرج العلوي بغرفة النوم' },
        ],
      },
      {
        space: 'private',
        transcript: '🧪 تجربة: مقاس فلتر المكيف 20x25x1',
        items: [
          { kind: 'spec', title: 'فلتر المكيف', details: 'المقاس 20x25x1' },
        ],
      },
      {
        space: 'private',
        transcript: '🧪 تجربة: فاتورة الأرضيات محفوظة بملف المشتريات بالمكتب',
        items: [
          { kind: 'place', title: 'فاتورة الأرضيات', details: 'ملف المشتريات بالمكتب' },
        ],
      },
      {
        space: 'private',
        transcript: '🧪 تجربة: اشتريت فلتر مكيف جديد',
        items: [{ kind: 'shopping', title: 'فلتر مكيف' }],
      },
      {
        space: 'private',
        transcript: '🧪 تجربة: حطيت العدة والدراجة بالكراج',
        items: [
          { kind: 'place', title: 'العدة', details: 'بالكراج' },
          { kind: 'place', title: 'الدراجة', details: 'بالكراج' },
        ],
      },
      {
        space: 'private',
        transcript: '🧪 تجربة: صلحت السيارة الأسبوع الماضي',
        items: [
          { kind: 'task', title: 'تصليح السيارة', details: 'الأسبوع الماضي', due_at: lastWeek },
        ],
      },
      {
        space: 'family',
        transcript: '🧪 تجربة: لازم نشتري حليب وخبز وجبنة من السوبرماركت',
        items: [
          { kind: 'shopping', title: 'حليب' },
          { kind: 'shopping', title: 'خبز' },
          { kind: 'shopping', title: 'جبنة' },
        ],
      },
      {
        space: 'family',
        transcript: '🧪 تجربة: ذكّر الأولاد بموعد دكتور الأسنان يوم الخميس',
        items: [
          { kind: 'task', title: 'تذكير الأولاد بموعد دكتور الأسنان', details: 'يوم الخميس' },
        ],
      },
      {
        space: 'family',
        transcript: '🧪 تجربة: جربنا مطعم البيتزا الجديد وما عجب الأولاد',
        items: [
          { kind: 'opinion', title: 'مطعم البيتزا الجديد', details: 'جربناه وما عجب الأولاد' },
        ],
      },
      {
        space: 'family',
        transcript: '🧪 تجربة: قبل السفر لازم نتأكد من جواز السفر والشاحن والدوا',
        items: [
          { kind: 'checklist', title: 'جواز السفر' },
          { kind: 'checklist', title: 'الشاحن' },
          { kind: 'checklist', title: 'الدوا' },
        ],
      },
      {
        space: 'work',
        transcript: '🧪 تجربة: اجتماع مع العميل يوم الثلاثاء الساعة 10 الصبح',
        items: [
          { kind: 'appointment', title: 'اجتماع مع العميل', details: 'الساعة 10 الصبح', due_at: in3d },
        ],
      },
    ];

    const ids: string[] = [];
    for (const d of demos) {
      const spaceId = byType[d.space];
      if (!spaceId) continue;
      const { data: note, error: noteErr } = await this.supabase
        .from('notes')
        .insert({
          space_id: spaceId,
          transcript: d.transcript,
          status: 'ready',
          created_by: userId,
        })
        .select()
        .single();
      if (noteErr) throw noteErr;
      ids.push(note.id);
      if (d.items.length > 0) {
        const { error: itemsErr } = await this.supabase.from('items').insert(
          d.items.map((it) => ({
            space_id: spaceId,
            note_id: note.id,
            kind: it.kind,
            title: it.title,
            details: it.details ?? null,
            due_at: it.due_at ?? null,
            created_by: userId,
          })),
        );
        if (itemsErr) throw itemsErr;
      }
    }
    return ids;
  }

  // ── Items (extracted tasks / appointments / shopping / places) ──

  async listItems(spaceId: string, limit = 100): Promise<Item[]> {
    const { data, error } = await this.supabase
      .from('items')
      .select('*')
      .eq('space_id', spaceId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as Item[];
  }

  async listNoteItems(noteId: string): Promise<Item[]> {
    const { data, error } = await this.supabase
      .from('items')
      .select('*')
      .eq('note_id', noteId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data as Item[];
  }

  async setItemStatus(itemId: string, status: 'open' | 'done'): Promise<Item> {
    const { data, error } = await this.supabase
      .from('items')
      .update({ status })
      .eq('id', itemId)
      .select()
      .single();
    if (error) throw error;
    return data as Item;
  }

  // ── Phase 3: family pillar ──────────────────────────────

  async createItem(input: {
    spaceId: string;
    kind: ItemKind;
    title: string;
    details?: string | null;
    dueAt?: string | null;
    assignedTo?: string | null;
    noteId?: string | null;
    userId?: string;
  }): Promise<Item> {
    const { data, error } = await this.supabase
      .from('items')
      .insert({
        space_id: input.spaceId,
        kind: input.kind,
        title: input.title,
        details: input.details ?? null,
        due_at: input.dueAt ?? null,
        assigned_to: input.assignedTo ?? null,
        note_id: input.noteId ?? null,
        created_by: input.userId ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return data as Item;
  }

  async assignItem(itemId: string, name: string | null): Promise<Item> {
    const { data, error } = await this.supabase
      .from('items')
      .update({ assigned_to: name })
      .eq('id', itemId)
      .select()
      .single();
    if (error) throw error;
    return data as Item;
  }

  /** Shared shopping list: open items first, newest first. */
  async listShopping(spaceId: string, limit = 100): Promise<Item[]> {
    const { data, error } = await this.supabase
      .from('items')
      .select('*')
      .eq('space_id', spaceId)
      .eq('kind', 'shopping')
      .order('status', { ascending: false }) // 'open' > 'done' → open first
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as Item[];
  }

  /** Family tasks: open first, newest first. */
  async listTasks(spaceId: string, limit = 100): Promise<Item[]> {
    const { data, error } = await this.supabase
      .from('items')
      .select('*')
      .eq('space_id', spaceId)
      .eq('kind', 'task')
      .order('status', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as Item[];
  }

  /** Family agenda: open appointments with a due date, soonest first. */
  async listUpcoming(spaceId: string, limit = 100): Promise<Item[]> {
    const { data, error } = await this.supabase
      .from('items')
      .select('*')
      .eq('space_id', spaceId)
      .eq('kind', 'appointment')
      .eq('status', 'open')
      .not('due_at', 'is', null)
      .order('due_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return data as Item[];
  }

  /**
   * Realtime subscription for a space's items (shared shopping list / tasks).
   * Fires onChange on any insert/update/delete. Returns an unsubscribe fn.
   */
  subscribeItems(spaceId: string, onChange: () => void): () => void {
    const channel = this.supabase
      .channel(`items-${spaceId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'items',
          filter: `space_id=eq.${spaceId}`,
        },
        onChange,
      )
      .subscribe();
    return () => {
      this.supabase.removeChannel(channel);
    };
  }

  async registerPushToken(userId: string, token: string, platform: string): Promise<void> {
    const { error } = await this.supabase.from('device_tokens').upsert(
      { user_id: userId, expo_push_token: token, platform },
      { onConflict: 'user_id,expo_push_token' },
    );
    if (error) throw error;
  }

  /** Ask the `notify` edge function to push a message to the space's members. */
  async notifySpace(
    spaceId: string,
    title: string,
    body: string,
    excludeUserId?: string,
  ): Promise<void> {
    const { error } = await this.supabase.functions.invoke('notify', {
      body: { space_id: spaceId, title, body, exclude_user_id: excludeUserId ?? null },
    });
    if (error) throw error;
  }

  // ── Search (Phase 2) ────────────────────────────────────

  /** Escape a raw query for use inside ilike/or patterns. */
  private sanitizeQuery(q: string): string {
    return q.replace(/[%_,()\\]/g, ' ').trim();
  }

  /**
   * Text search across a space's notes (transcript) and extracted items
   * (title + details). Works fully without AI.
   */
  async search(
    spaceId: string,
    query: string,
  ): Promise<{ notes: Note[]; items: Item[] }> {
    const q = this.sanitizeQuery(query);
    if (!q) return { notes: [], items: [] };
    const pattern = `%${q}%`;
    const [n, i] = await Promise.all([
      this.supabase
        .from('notes')
        .select('*')
        .eq('space_id', spaceId)
        .ilike('transcript', pattern)
        .order('created_at', { ascending: false })
        .limit(20),
      this.supabase
        .from('items')
        .select('*')
        .eq('space_id', spaceId)
        .or(`title.ilike.${pattern},details.ilike.${pattern}`)
        .order('created_at', { ascending: false })
        .limit(30),
    ]);
    if (n.error) throw n.error;
    if (i.error) throw i.error;
    return { notes: n.data as Note[], items: i.data as Item[] };
  }

  // ── Q&A (Phase 2) ─────────────────────────────────────────

  /**
   * Ask a question over a space (or all spaces when spaceId is null).
   * Served by the `ask` edge function (gpt-4o-mini). Throws when the
   * function is unavailable — caller falls back to `answerLocally`.
   */
  async ask(
    question: string,
    spaceId: string | null,
  ): Promise<{ answer: string; sources: { note_id: string; snippet: string }[] }> {
    const { data, error } = await this.supabase.functions.invoke('ask', {
      body: { question, space_id: spaceId },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data as {
      answer: string;
      sources: { note_id: string; snippet: string }[];
    };
  }

  /**
   * Update an item's details (used by the conversational correction loop:
   * "لا، نقلته على الخزانة" → updates the place item in place).
   */
  async updateItemDetails(itemId: string, details: string): Promise<void> {
    const { error } = await this.supabase
      .from('items')
      .update({ details })
      .eq('id', itemId);
    if (error) throw error;
  }

  private async uriToBlob(uri: string, mimeType: string): Promise<Blob> {
    const res = await fetch(uri);
    const buf = await res.arrayBuffer();
    return new Blob([buf], { type: mimeType });
  }
}
