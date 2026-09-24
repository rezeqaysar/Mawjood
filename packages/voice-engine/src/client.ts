import type { SupabaseClient } from '@supabase/supabase-js';
import type { Borrow, Item, ItemKind, Note, RecordedAudio, Space, SpaceTab, SpaceType } from './types';
import { suggestSpaceType } from './suggest';
import { isCorrection, isQuestion } from './answer';

/** Tiny v4 UUID (no dependency) — used so the note id exists before insert. */
function uuid4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export interface RouteResult {
  action: 'question' | 'note' | 'correction';
  space_type: SpaceType;
}

export interface HistoryMsg {
  role: 'user' | 'app';
  text: string;
}

/** One row of the family roster (from the `family-members` edge function). */
export interface FamilyMember {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: 'owner' | 'member';
  is_manager: boolean;
  joined_at: string | null;
}

/** A directed shopping list ("يا جون جيب تفاح…") with its items. */
export interface ShoppingList {
  id: string;
  space_id: string;
  title: string;
  assigned_to: string | null; // user id — gets the targeted push
  assigned_name: string | null; // display-name snapshot for the UI chip
  status: 'open' | 'done'; // done = archived to history
  completed_at: string | null; // stamped when the list is archived
  created_at: string;
  items: Item[];
}

/** A secret vault: one row per code — each code opens its own hidden page. */
export interface SecretVault {
  id: string;
  code: string;
}

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
      .is('deleted_at', null)
      .or('tab_id.is.null,tab_id.neq.secret') // the hidden vault tab never leaks into lists
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as Note[];
  }

  /**
   * Full pipeline for one voice note:
   * 1. create note row + upload audio IN PARALLEL (id is generated client-side,
   *    and the public URL is deterministic so no extra update round-trip)
   * 2. invoke `transcribe` edge function
   * 3. return the note (caller can re-fetch for the transcript)
   */
  async saveVoiceNote(
    spaceId: string,
    audio: RecordedAudio,
    userId: string,
    photoUrl?: string | null,
  ): Promise<Note> {
    const noteId = uuid4();
    const mt = audio.mimeType.toLowerCase();
    const ext = mt.includes('m4a') || mt.includes('mp4') ? 'm4a' : mt.includes('webm') ? 'webm' : 'wav';
    const path = `${userId}/${noteId}.${ext}`;
    const file = await this.uriToBlob(audio.uri, audio.mimeType);
    const {
      data: { publicUrl },
    } = this.supabase.storage.from('voice-notes').getPublicUrl(path);

    // 1. insert + upload in parallel
    const [{ data: note, error: insertError }, { error: uploadError }] =
      await Promise.all([
        this.supabase
          .from('notes')
          .insert({
            id: noteId,
            space_id: spaceId,
            audio_url: publicUrl,
            photo_url: photoUrl ?? null,
            status: 'transcribing',
            duration_sec: Math.round(audio.durationSec),
            created_by: userId,
          })
          .select()
          .single(),
        this.supabase.storage
          .from('voice-notes')
          .upload(path, file, { contentType: audio.mimeType, upsert: true }),
      ]);
    if (insertError) throw insertError;
    if (uploadError) {
      await this.supabase
        .from('notes')
        .update({ status: 'failed', error: 'upload failed' })
        .eq('id', noteId);
      throw uploadError;
    }

    try {
      // 2. trigger transcription (edge function updates the row when done)
      const { error: fnError } = await this.supabase.functions.invoke(
        'transcribe',
        { body: { note_id: noteId } },
      );
      if (fnError) throw fnError;

      return { ...note, audio_url: publicUrl, status: 'transcribing' } as Note;
    } catch (err) {
      await this.supabase
        .from('notes')
        .update({
          status: 'failed',
          error: err instanceof Error ? err.message : 'upload failed',
        })
        .eq('id', noteId);
      throw err;
    }
  }

  async getNote(noteId: string): Promise<Note> {
    const { data, error } = await this.supabase
      .from('notes')
      .select('*')
      .eq('id', noteId)
      .is('deleted_at', null)
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
    photoUrl?: string | null,
  ): Promise<Note> {
    const clean = text.trim();
    if (!clean) throw new Error('empty text');
    const { data: note, error } = await this.supabase
      .from('notes')
      .insert({
        space_id: spaceId,
        transcript: clean,
        photo_url: photoUrl ?? null,
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
   * AI chooses the space for a note (the `classify` edge function).
   * Falls back to the local heuristic when the AI is unreachable —
   * the app never blocks on the AI, and never asks the user to choose.
   */
  async classifySpace(text: string): Promise<SpaceType> {
    try {
      const { data, error } = await this.supabase.functions.invoke('classify', {
        body: { text: text.slice(0, 500) },
      });
      if (error) throw error;
      const t = (data as { space_type?: string } | null)?.space_type;
      if (t === 'private' || t === 'family' || t === 'work') return t;
      throw new Error('bad classify response');
    } catch (e) {
      console.warn('classify failed, using local heuristic', e);
      return suggestSpaceType(text);
    }
  }

  /**
   * The unified agent brain: one call that understands the input in context,
   * uses tools (search/save/update/delete/agenda) and returns a final answer.
   * Returns null when unreachable — the caller then uses the legacy
   * route→ask pipeline so the app never blocks on the agent.
   */
  async chat(
    text: string,
    history: HistoryMsg[],
    noteId?: string,
    photoUrl?: string | null,
    uiLang?: string,
  ): Promise<{ answer: string; actions: string[] } | null> {
    try {
      const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in device TZ
      const { data, error } = await this.supabase.functions.invoke('chat', {
        body: {
          text: text.slice(0, 1000),
          history: history.slice(-6).map((m) => ({
            role: m.role,
            text: m.text.slice(0, 300),
          })),
          note_id: noteId ?? null,
          photo_url: photoUrl ?? null,
          today,
          ui_lang: uiLang ?? 'ar',
        },
      });
      if (error) throw error;
      const d = data as { answer?: string; actions?: string[]; error?: string } | null;
      if (d?.error) throw new Error(d.error);
      if (typeof d?.answer !== 'string') throw new Error('bad chat response');
      return { answer: d.answer, actions: Array.isArray(d.actions) ? d.actions : [] };
    } catch (e) {
      console.warn('chat agent failed, caller should use legacy pipeline', e);
      return null;
    }
  }

  /**
   * AI input router: question | note | correction (+ space for notes).
  ): Promise<{ answer: string; actions: string[] } | null> {
    try {
      const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in device TZ
      const { data, error } = await this.supabase.functions.invoke('chat', {
        body: {
          text: text.slice(0, 1000),
          history: history.slice(-6).map((m) => ({
            role: m.role,
            text: m.text.slice(0, 300),
          })),
          note_id: noteId ?? null,
          today,
        },
      });
      if (error) throw error;
      const d = data as { answer?: string; actions?: string[]; error?: string } | null;
      if (d?.error) throw new Error(d.error);
      if (typeof d?.answer !== 'string') throw new Error('bad chat response');
      return { answer: d.answer, actions: Array.isArray(d.actions) ? d.actions : [] };
    } catch (e) {
      console.warn('chat agent failed, caller should use legacy pipeline', e);
      return null;
    }
  }

  /**
   * AI input router: question | note | correction (+ space for notes).
   * Gets the recent conversation so follow-ups and re-asks are understood.
   * Falls back to local heuristics when the AI is unreachable.
   */
  async route(text: string, history: HistoryMsg[]): Promise<RouteResult> {
    try {
      const { data, error } = await this.supabase.functions.invoke('route', {
        body: {
          text: text.slice(0, 500),
          history: history.slice(-6).map((m) => ({
            role: m.role,
            text: m.text.slice(0, 300),
          })),
        },
      });
      if (error) throw error;
      const a = (data as { action?: string; space_type?: string } | null)?.action;
      const s = (data as { space_type?: string } | null)?.space_type;
      if (a === 'question' || a === 'note' || a === 'correction') {
        const space_type: SpaceType =
          s === 'family' || s === 'work' ? s : 'private';
        return { action: a, space_type };
      }
      throw new Error('bad route response');
    } catch (e) {
      console.warn('route failed, using local heuristics', e);
      if (isQuestion(text)) return { action: 'question', space_type: 'private' };
      if (isCorrection(text)) return { action: 'correction', space_type: 'private' };
      return { action: 'note', space_type: suggestSpaceType(text) };
    }
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

  async setItemStatus(
    itemId: string,
    status: 'open' | 'done' | 'not_found',
  ): Promise<Item> {
    const { data, error } = await this.supabase
      .from('items')
      .update({
        status,
        // purchase-history hook: bought_at is stamped only when bought
        bought_at: status === 'done' ? new Date().toISOString() : null,
      })
      .eq('id', itemId)
      .select()
      .single();
    if (error) throw error;
    return data as Item;
  }

  // ── place photo proof ("وين أغراضي؟" بدليل بصري) ──

  /** Upload a photo for an item into the item-photos bucket; returns the public URL. */
  async uploadItemPhoto(itemId: string, localUri: string, userId: string): Promise<string> {
    const path = `${userId}/${itemId}.jpg`;
    const file = await this.uriToBlob(localUri, 'image/jpeg');
    const {
      data: { publicUrl },
    } = this.supabase.storage.from('item-photos').getPublicUrl(path);
    const { error } = await this.supabase.storage
      .from('item-photos')
      .upload(path, file, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
    return publicUrl;
  }

  /** Upload a photo attached to a chat note into the item-photos bucket; returns the public URL. */
  async uploadNotePhoto(localUri: string, userId: string): Promise<string> {
    const path = `${userId}/notes/${uuid4()}.jpg`;
    const file = await this.uriToBlob(localUri, 'image/jpeg');
    const {
      data: { publicUrl },
    } = this.supabase.storage.from('item-photos').getPublicUrl(path);
    const { error } = await this.supabase.storage
      .from('item-photos')
      .upload(path, file, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
    return publicUrl;
  }

  /** Merge a photo URL into the item's meta (keeps price etc.). Pass null to remove. */
  async setItemPhoto(itemId: string, photoUrl: string | null): Promise<Item> {
    const { data: cur, error: readErr } = await this.supabase
      .from('items')
      .select('meta')
      .eq('id', itemId)
      .single();
    if (readErr) throw readErr;
    const meta = { ...(((cur as { meta: unknown } | null)?.meta as Record<string, unknown>) ?? {}), photo_url: photoUrl };
    const { data, error } = await this.supabase
      .from('items')
      .update({ meta })
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

  // ── directed shopping lists ("يا جون جيب تفاح…") ──

  /** Create a list + its items in one go. */
  async createShoppingList(input: {
    spaceId: string;
    title: string;
    assignedTo: string | null; // user id — the only one who gets notified
    assignedName: string | null;
    items: string[];
    userId?: string;
  }): Promise<ShoppingList> {
    const { data: list, error: lErr } = await this.supabase
      .from('shopping_lists')
      .insert({
        space_id: input.spaceId,
        title: input.title,
        assigned_to: input.assignedTo,
        assigned_name: input.assignedName,
        created_by: input.userId ?? null,
      })
      .select()
      .single();
    if (lErr) throw lErr;
    const rows = input.items.map((title) => ({
      space_id: input.spaceId,
      kind: 'shopping',
      title,
      list_id: (list as { id: string }).id,
      assigned_to: input.assignedName,
      created_by: input.userId ?? null,
    }));
    const { data: items, error: iErr } = await this.supabase
      .from('items')
      .insert(rows)
      .select();
    if (iErr) throw iErr;
    return { ...(list as Omit<ShoppingList, 'items'>), items: (items ?? []) as Item[] };
  }

  /** All lists of a space, each with its items (open first). */
  async listShoppingLists(spaceId: string): Promise<ShoppingList[]> {
    const { data, error } = await this.supabase
      .from('shopping_lists')
      .select('*, items(*)')
      .eq('space_id', spaceId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return ((data ?? []) as (Omit<ShoppingList, 'items'> & { items: Item[] | null })[]).map(
      (l) => ({ ...l, items: (l.items ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at)) }),
    );
  }

  /** Attach existing loose items to a list (list-only shopping adoption). */
  async attachItemsToList(itemIds: string[], listId: string): Promise<void> {
    if (itemIds.length === 0) return;
    const { error } = await this.supabase
      .from('items')
      .update({ list_id: listId })
      .in('id', itemIds);
    if (error) throw error;
  }

  /** Mark an item bought (sets bought_at — the purchase-history hook) or un-bought. */
  async setItemBought(itemId: string, bought: boolean): Promise<Item> {
    const { data, error } = await this.supabase
      .from('items')
      .update({ status: bought ? 'done' : 'open', bought_at: bought ? new Date().toISOString() : null })
      .eq('id', itemId)
      .select()
      .single();
    if (error) throw error;
    return data as Item;
  }

  async setShoppingListStatus(
    listId: string,
    status: 'open' | 'done',
    completedAt?: string | null,
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      status,
      // archiving: stamp completion; reopening clears it. Callers may pass the
      // existing stamp to preserve the original archive date on edits.
      completed_at: status === 'done' ? (completedAt ?? new Date().toISOString()) : null,
    };
    const { error } = await this.supabase.from('shopping_lists').update(patch).eq('id', listId);
    if (error) {
      // migration 0015 (completed_at) not applied yet → retry without it
      if (/completed_at/i.test(error.message)) {
        const { error: retryErr } = await this.supabase
          .from('shopping_lists')
          .update({ status })
          .eq('id', listId);
        if (retryErr) throw retryErr;
        return;
      }
      throw error;
    }
  }

  /** Delete a list — its items cascade. */
  async deleteShoppingList(listId: string): Promise<void> {
    const { error } = await this.supabase.from('shopping_lists').delete().eq('id', listId);
    if (error) throw error;
  }

  /**
   * Restore an archived list back to live: list → open with completed_at
   * cleared; not_found items flip back to open so they can be bought next
   * time. Done items stay done (purchase history is preserved).
   */
  async restoreShoppingList(listId: string): Promise<void> {
    const { error: lErr } = await this.supabase
      .from('shopping_lists')
      .update({ status: 'open', completed_at: null })
      .eq('id', listId);
    if (lErr) throw lErr;
    const { error: iErr } = await this.supabase
      .from('items')
      .update({ status: 'open' })
      .eq('list_id', listId)
      .eq('status', 'not_found');
    if (iErr) throw iErr;
  }

  // ── custom tabs ──────────────────────────────────────────────

  /** User-created tabs of a space, in position order. */
  async listSpaceTabs(spaceId: string): Promise<SpaceTab[]> {
    const { data, error } = await this.supabase
      .from('space_tabs')
      .select('*')
      .eq('space_id', spaceId)
      .is('deleted_at', null)
      .order('position', { ascending: true });
    if (error) throw error;
    return (data ?? []) as SpaceTab[];
  }

  /** Create a custom tab (owner only; the free-tier limit is enforced by the caller). */
  async createSpaceTab(
    spaceId: string,
    userId: string,
    title: string,
    icon: string,
  ): Promise<SpaceTab> {
    const { count } = await this.supabase
      .from('space_tabs')
      .select('id', { count: 'exact', head: true })
      .eq('space_id', spaceId);
    const { data, error } = await this.supabase
      .from('space_tabs')
      .insert({
        space_id: spaceId,
        title: title.trim().slice(0, 40),
        icon: icon || '📁',
        position: count ?? 0,
        created_by: userId,
      })
      .select()
      .single();
    if (error) throw error;
    return data as SpaceTab;
  }

  async renameSpaceTab(tabId: string, title: string): Promise<void> {
    const { error } = await this.supabase
      .from('space_tabs')
      .update({ title: title.trim().slice(0, 40) })
      .eq('id', tabId);
    if (error) throw error;
  }

  /**
   * Delete a tab.
   * - opts.moveTo !== undefined: its notes move to that tab (null = main, 'papers', or a tab id),
   *   the tab itself is removed for good.
   * - otherwise the notes are trashed (opts.trash, Plus) or destroyed forever, same for the tab.
   */
  async deleteSpaceTab(tabId: string, opts: { moveTo?: string | null; trash: boolean }): Promise<void> {
    if (opts.moveTo !== undefined) {
      const { error: nErr } = await this.supabase
        .from('notes')
        .update({ tab_id: opts.moveTo })
        .eq('tab_id', tabId)
        .is('deleted_at', null);
      if (nErr) throw nErr;
      const { error: tErr } = await this.supabase.from('space_tabs').delete().eq('id', tabId);
      if (tErr) throw tErr;
      return;
    }
    if (opts.trash) {
      const now = new Date().toISOString();
      const { error: nErr } = await this.supabase
        .from('notes')
        .update({ deleted_at: now })
        .eq('tab_id', tabId)
        .is('deleted_at', null);
      if (nErr) throw nErr;
      const { error: tErr } = await this.supabase
        .from('space_tabs')
        .update({ deleted_at: now })
        .eq('id', tabId);
      if (tErr) throw tErr;
      return;
    }
    await this.deleteTabForever(tabId);
  }

  /** Hard-delete a tab with all its notes and their items. No trash, no way back. */
  async deleteTabForever(tabId: string): Promise<void> {
    const { data: notes } = await this.supabase.from('notes').select('id').eq('tab_id', tabId);
    const ids = ((notes ?? []) as { id: string }[]).map((n) => n.id);
    if (ids.length > 0) {
      await this.supabase.from('items').delete().in('note_id', ids);
      await this.supabase.from('notes').delete().in('id', ids);
    }
    const { error } = await this.supabase.from('space_tabs').delete().eq('id', tabId);
    if (error) throw error;
  }

  // ── trash ──────────────────────────────────────────────────────

  /** Soft-deleted notes + tabs across the given spaces, newest first. */
  async listTrash(spaceIds: string[]): Promise<{ notes: Note[]; tabs: SpaceTab[] }> {
    if (spaceIds.length === 0) return { notes: [], tabs: [] };
    const [n, t] = await Promise.all([
      this.supabase
        .from('notes')
        .select('*')
        .in('space_id', spaceIds)
        .not('deleted_at', 'is', null)
        // secret vault notes never surface in trash — they live and die inside the vault
        .neq('tab_id', 'secret')
        .order('deleted_at', { ascending: false }),
      this.supabase
        .from('space_tabs')
        .select('*')
        .in('space_id', spaceIds)
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false }),
    ]);
    if (n.error) throw n.error;
    if (t.error) throw t.error;
    return { notes: (n.data ?? []) as Note[], tabs: (t.data ?? []) as SpaceTab[] };
  }

  /** Bring a note back from the trash into the given tab (null = main). */
  async restoreNote(noteId: string, tabId: string | null): Promise<void> {
    const { error } = await this.supabase
      .from('notes')
      .update({ deleted_at: null, tab_id: tabId })
      .eq('id', noteId);
    if (error) throw error;
  }

  /** Bring a tab back with all its trashed notes. */
  async restoreTab(tabId: string): Promise<void> {
    const { error: tErr } = await this.supabase
      .from('space_tabs')
      .update({ deleted_at: null })
      .eq('id', tabId);
    if (tErr) throw tErr;
    const { error: nErr } = await this.supabase
      .from('notes')
      .update({ deleted_at: null })
      .eq('tab_id', tabId)
      .not('deleted_at', 'is', null);
    if (nErr) throw nErr;
  }

  /** Permanently delete one trashed note (with its items). */
  async deleteNoteForever(noteId: string): Promise<void> {
    await this.supabase.from('items').delete().eq('note_id', noteId);
    const { error } = await this.supabase.from('notes').delete().eq('id', noteId);
    if (error) throw error;
  }

  /** Permanently delete everything in the trash across the given spaces. */
  async emptyTrash(spaceIds: string[]): Promise<void> {
    if (spaceIds.length === 0) return;
    const { data: notes } = await this.supabase
      .from('notes')
      .select('id')
      .in('space_id', spaceIds)
      .not('deleted_at', 'is', null);
    const ids = ((notes ?? []) as { id: string }[]).map((n) => n.id);
    if (ids.length > 0) {
      await this.supabase.from('items').delete().in('note_id', ids);
      await this.supabase.from('notes').delete().in('id', ids);
    }
    await this.supabase
      .from('space_tabs')
      .delete()
      .in('space_id', spaceIds)
      .not('deleted_at', 'is', null);
  }

  /**
   * Hard-delete trashed rows older than retentionDays (lazy purge, runs on trash open).
   * A server cron can take over later; the client purge keeps it correct meanwhile.
   */
  async purgeTrash(spaceIds: string[], retentionDays: number): Promise<{ notes: number; tabs: number }> {
    if (spaceIds.length === 0 || retentionDays <= 0) return { notes: 0, tabs: 0 };
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    const { data: oldNotes } = await this.supabase
      .from('notes')
      .select('id')
      .in('space_id', spaceIds)
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff);
    const noteIds = ((oldNotes ?? []) as { id: string }[]).map((n) => n.id);
    if (noteIds.length > 0) {
      await this.supabase.from('items').delete().in('note_id', noteIds);
      await this.supabase.from('notes').delete().in('id', noteIds);
    }
    const { data: oldTabs } = await this.supabase
      .from('space_tabs')
      .select('id')
      .in('space_id', spaceIds)
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff);
    const tabIds = ((oldTabs ?? []) as { id: string }[]).map((t) => t.id);
    if (tabIds.length > 0) {
      await this.supabase.from('space_tabs').delete().in('id', tabIds);
    }
    return { notes: noteIds.length, tabs: tabIds.length };
  }

  /** Trash retention tier (paid hook): 0 = free/permanent delete, 30 = Plus. */
  async getTrashRetention(userId: string): Promise<number> {
    try {
      const { data, error } = await this.supabase
        .from('profiles')
        .select('trash_retention_days')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return (data as { trash_retention_days: number } | null)?.trash_retention_days ?? 0;
    } catch {
      return 0;
    }
  }

  // ── secret vaults (multi: every code gets its own vault) ──────────

  /** Owner-only vault list (separate table: profiles is peer-readable). */
  async getSecretVault(userId: string): Promise<{ enabled: boolean; vaults: SecretVault[] }> {
    try {
      const { data, error } = await this.supabase
        .from('secret_vault')
        .select('id, secret_code')
        .eq('user_id', userId);
      if (error) throw error;
      const vaults = ((data ?? []) as { id: string; secret_code: string | null }[])
        .filter((r) => r.secret_code)
        .map((r) => ({ id: r.id, code: r.secret_code as string }));
      // Testing default: vault UI available even before the first code is saved.
      // LAUNCH: flip to enabled:false when vaults.length === 0 (paid only).
      return { enabled: true, vaults };
    } catch {
      return { enabled: false, vaults: [] };
    }
  }

  /**
   * Save a code → its own vault page. Returns the vault id (existing vault when
   * the code was used before). Throws 'vault_limit' when the plan's vault cap
   * is hit (profiles.secret_vaults_limit — the paid-plans hook).
   */
  async setSecretCode(userId: string, code: string): Promise<string> {
    const clean = code.trim().slice(0, 60);
    if (!clean) throw new Error('empty code');
    const { data: existing } = await this.supabase
      .from('secret_vault')
      .select('id')
      .eq('user_id', userId)
      .eq('secret_code', clean)
      .maybeSingle();
    if (existing) return (existing as { id: string }).id;
    const [{ count }, { data: prof }] = await Promise.all([
      this.supabase.from('secret_vault').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      this.supabase.from('profiles').select('secret_vaults_limit').eq('user_id', userId).maybeSingle(),
    ]);
    const limit = (prof as { secret_vaults_limit?: number } | null)?.secret_vaults_limit ?? 5;
    if ((count ?? 0) >= limit) throw new Error('vault_limit');
    const { data, error } = await this.supabase
      .from('secret_vault')
      .insert({ user_id: userId, secret_code: clean, updated_at: new Date().toISOString() })
      .select('id')
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  /** Notes filed in one vault (private space only). */
  async listSecretNotes(spaceId: string, userId: string, vaultId: string): Promise<Note[]> {
    // Adopt pre-multi-vault secret notes (vault_id null) into the user's only vault.
    const { count } = await this.supabase
      .from('secret_vault')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (count === 1) {
      await this.supabase
        .from('notes')
        .update({ vault_id: vaultId })
        .eq('space_id', spaceId)
        .eq('tab_id', 'secret')
        .is('vault_id', null);
    }
    const { data, error } = await this.supabase
      .from('notes')
      .select('*')
      .eq('space_id', spaceId)
      .eq('tab_id', 'secret')
      .eq('vault_id', vaultId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data ?? []) as Note[];
  }

  async saveSecretNote(
    spaceId: string,
    userId: string,
    text: string,
    vaultId: string,
    photoUrl?: string | null,
  ): Promise<Note> {
    const clean = text.trim();
    if (!clean) throw new Error('empty text');
    const { data, error } = await this.supabase
      .from('notes')
      .insert({
        space_id: spaceId,
        transcript: clean,
        status: 'ready',
        created_by: userId,
        tab_id: 'secret',
        vault_id: vaultId,
        photo_url: photoUrl ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return data as Note;
  }

  /**
   * Voice note straight into a secret vault. The row is born with
   * tab_id='secret', so it is invisible to lists, search, the agent and
   * extraction from the very first second. The transcribe function deletes
   * the audio after transcription (text-only retention policy).
   */
  async saveSecretVoiceNote(
    spaceId: string,
    audio: RecordedAudio,
    userId: string,
    vaultId: string,
    photoUrl?: string | null,
  ): Promise<Note> {
    const noteId = uuid4();
    const mt = audio.mimeType.toLowerCase();
    const ext = mt.includes('m4a') || mt.includes('mp4') ? 'm4a' : mt.includes('webm') ? 'webm' : 'wav';
    const path = `${userId}/${noteId}.${ext}`;
    const file = await this.uriToBlob(audio.uri, audio.mimeType);
    const {
      data: { publicUrl },
    } = this.supabase.storage.from('voice-notes').getPublicUrl(path);

    const [{ data: note, error: insertError }, { error: uploadError }] =
      await Promise.all([
        this.supabase
          .from('notes')
          .insert({
            id: noteId,
            space_id: spaceId,
            audio_url: publicUrl,
            photo_url: photoUrl ?? null,
            status: 'transcribing',
            duration_sec: Math.round(audio.durationSec),
            created_by: userId,
            tab_id: 'secret',
            vault_id: vaultId,
          })
          .select()
          .single(),
        this.supabase.storage
          .from('voice-notes')
          .upload(path, file, { contentType: audio.mimeType, upsert: true }),
      ]);
    if (insertError) throw insertError;
    if (uploadError) {
      await this.supabase
        .from('notes')
        .update({ status: 'failed', error: 'upload failed' })
        .eq('id', noteId);
      throw uploadError;
    }

    try {
      const { error: fnError } = await this.supabase.functions.invoke(
        'transcribe',
        { body: { note_id: noteId } },
      );
      if (fnError) throw fnError;
      return { ...note, audio_url: publicUrl, status: 'transcribing' } as Note;
    } catch (err) {
      await this.supabase
        .from('notes')
        .update({
          status: 'failed',
          error: err instanceof Error ? err.message : 'upload failed',
        })
        .eq('id', noteId);
      throw err;
    }
  }

  /** Edit a secret note's text (owner-only via RLS). */
  async updateSecretNote(noteId: string, text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) throw new Error('empty text');
    const { error } = await this.supabase
      .from('notes')
      .update({ transcript: clean })
      .eq('id', noteId)
      .eq('tab_id', 'secret');
    if (error) throw error;
  }

  /** Permanently delete a secret note (two-tap confirm in UI; never goes to trash). */
  async deleteSecretNote(noteId: string): Promise<void> {
    const { error: itemsErr } = await this.supabase
      .from('items')
      .delete()
      .eq('note_id', noteId);
    if (itemsErr) throw itemsErr;
    const { error: noteErr } = await this.supabase
      .from('notes')
      .delete()
      .eq('id', noteId)
      .eq('tab_id', 'secret');
    if (noteErr) throw noteErr;
  }

  /** File a note into a tab: null = main notes, 'papers' = papers tab, else a tab id. */
  async moveNoteToTab(noteId: string, tabId: string | null): Promise<void> {
    const { error } = await this.supabase.from('notes').update({ tab_id: tabId }).eq('id', noteId);
    if (error) throw error;
  }

  /** Free-tier cap of custom tabs per space (the paid-plans hook). */
  async getCustomTabLimit(userId: string): Promise<number> {
    try {
      const { data, error } = await this.supabase
        .from('profiles')
        .select('custom_tabs_limit')
        .eq('id', userId)
        .single();
      if (error || !data) return 3;
      return (data as { custom_tabs_limit: number }).custom_tabs_limit ?? 3;
    } catch {
      return 3;
    }
  }

  /** Push notification to ONE user only (the shopping-list assignee). */
  async notifyUser(userId: string, title: string, body: string): Promise<void> {
    const { error } = await this.supabase.functions.invoke('notify', {
      body: { to_user_id: userId, title, body },
    });
    if (error) throw error;
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

  /** 📦 أشيائي: owned/bought things in a space, newest first. */
  async listThings(spaceId: string, limit = 100): Promise<Item[]> {
    const { data, error } = await this.supabase
      .from('items')
      .select('*')
      .eq('space_id', spaceId)
      .eq('kind', 'thing')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as Item[];
  }

  // ── Borrowing ("مين أخذها؟") ──

  /** Currently lent-out items in a space (returned_at is null), newest first. */
  async listBorrows(spaceId: string, limit = 100): Promise<Borrow[]> {
    const { data, error } = await this.supabase
      .from('borrows')
      .select('*')
      .eq('space_id', spaceId)
      .is('returned_at', null)
      .order('lent_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as Borrow[];
  }

  /** Mark a borrow as returned. */
  async returnBorrow(borrowId: string): Promise<void> {
    const { error } = await this.supabase
      .from('borrows')
      .update({ returned_at: new Date().toISOString() })
      .eq('id', borrowId)
      .is('returned_at', null);
    if (error) throw error;
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
        .is('deleted_at', null)
        .or('tab_id.is.null,tab_id.neq.secret') // trashed + vault notes never surface in search
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
    history: HistoryMsg[] = [],
  ): Promise<{ answer: string; sources: { note_id: string; snippet: string }[] }> {
    const { data, error } = await this.supabase.functions.invoke('ask', {
      body: {
        question,
        space_id: spaceId,
        history: history.slice(-6).map((m) => ({
          role: m.role,
          text: m.text.slice(0, 300),
        })),
      },
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

  // ── Family invites ──────────────────────────────────────────

  /** Generate a human-friendly invite code (no confusing chars). */
  private makeInviteCode(): string {
    const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => ABC[b % ABC.length]).join('');
  }

  /** Create (or reuse) an active invite code for a space. */
  async getOrCreateInvite(spaceId: string): Promise<{ code: string; expires_at: string }> {
    const { data: existing } = await this.supabase
      .from('space_invites')
      .select('code, expires_at')
      .eq('space_id', spaceId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return existing as { code: string; expires_at: string };
    const { data: user } = await this.supabase.auth.getUser();
    for (let i = 0; i < 3; i++) {
      const code = this.makeInviteCode();
      const { data, error } = await this.supabase
        .from('space_invites')
        .insert({ space_id: spaceId, code, created_by: user.user!.id })
        .select('code, expires_at')
        .single();
      if (!error) return data as { code: string; expires_at: string };
    }
    throw new Error('could not create invite code');
  }

  /** Revoke all active invite codes for a space (regenerate). */
  async revokeInvites(spaceId: string): Promise<void> {
    const { error } = await this.supabase
      .from('space_invites')
      .delete()
      .eq('space_id', spaceId)
      .gt('expires_at', new Date().toISOString());
    if (error) throw error;
  }

  /** Redeem an invite code → joins the family space. */
  async joinFamily(code: string): Promise<{ id: string; name: string; already?: boolean }> {
    const { data, error } = await this.supabase.functions.invoke('join-family', {
      body: { code },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data as { id: string; name: string; already?: boolean };
  }

  /** Leave a space (deletes own membership row). */
  async leaveSpace(spaceId: string): Promise<void> {
    const { data: user } = await this.supabase.auth.getUser();
    const { error } = await this.supabase
      .from('space_members')
      .delete()
      .eq('space_id', spaceId)
      .eq('user_id', user.user!.id);
    if (error) throw error;
  }

  /** Roster of a space (ids only — names stay private). */
  async listMembers(spaceId: string): Promise<{ user_id: string; role: string }[]> {
    const { data, error } = await this.supabase
      .from('space_members')
      .select('user_id, role')
      .eq('space_id', spaceId);
    if (error) throw error;
    return (data ?? []) as { user_id: string; role: string }[];
  }

  /** Detailed family roster: manager + members with emails and display names. */
  async getFamilyMembers(spaceId: string): Promise<FamilyMember[]> {
    const { data, error } = await this.supabase.functions.invoke('family-members', {
      body: { space_id: spaceId },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return (data?.members ?? []) as FamilyMember[];
  }

  /** Own display name (from the profiles table). */
  async getMyProfile(): Promise<{ display_name: string | null } | null> {
    const { data: user } = await this.supabase.auth.getUser();
    if (!user.user) return null;
    const { data, error } = await this.supabase
      .from('profiles')
      .select('display_name')
      .eq('id', user.user.id)
      .maybeSingle();
    if (error) throw error;
    return (data as { display_name: string | null } | null) ?? null;
  }

  /** Set own display name (upserts the profiles row). */
  async setDisplayName(name: string): Promise<void> {
    const { data: user } = await this.supabase.auth.getUser();
    if (!user.user) throw new Error('not authenticated');
    const clean = name.trim().slice(0, 60);
    const { error } = await this.supabase.from('profiles').upsert(
      {
        id: user.user.id,
        display_name: clean ? clean : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
    if (error) throw error;
  }

  /** Manager removes a member from the family space (RLS: owner-only). */
  async removeMember(spaceId: string, memberId: string): Promise<void> {
    const { error } = await this.supabase
      .from('space_members')
      .delete()
      .eq('space_id', spaceId)
      .eq('user_id', memberId);
    if (error) throw error;
  }

  private async uriToBlob(uri: string, mimeType: string): Promise<Blob> {
    const res = await fetch(uri);
    const buf = await res.arrayBuffer();
    return new Blob([buf], { type: mimeType });
  }
}
