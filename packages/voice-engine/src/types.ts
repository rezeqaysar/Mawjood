// Domain types for the Mawjood voice-memory engine.
// API-first: these types define the contract every client (mobile, web, …) uses.

export type SpaceType = 'private' | 'family' | 'work';

export interface Space {
  id: string;
  owner_id: string;
  type: SpaceType;
  name: string;
  created_at: string;
}

export type NoteStatus =
  | 'recorded' // audio captured on device, not yet uploaded
  | 'uploading' // audio uploading to storage
  | 'transcribing' // audio with backend, transcription in flight
  | 'ready' // transcript available
  | 'failed'; // terminal failure (see error)

export interface Note {
  id: string;
  space_id: string;
  audio_url: string | null;
  photo_url: string | null; // optional photo attached in chat ("photograph, then talk about it")
  transcript: string | null;
  language: string | null;
  duration_sec: number | null;
  status: NoteStatus;
  error: string | null;
  created_by: string;
  created_at: string;
  tab_id: string | null; // custom tab filing: null = main notes, 'papers' = papers tab, 'secret' = hidden vault tab, else space_tabs id
  deleted_at: string | null; // soft delete → trash (Plus keeps 30 days)
}

/** A user-created tab inside a space (family tabs are shared with all members). */
export interface SpaceTab {
  id: string;
  space_id: string;
  title: string;
  icon: string;
  position: number;
  created_by: string;
  created_at: string;
  deleted_at: string | null; // soft delete → trash (Plus keeps 30 days)
}

export interface TranscriptionResult {
  text: string;
  language: string;
  duration_sec: number;
}

export interface RecordedAudio {
  /** Local file URI of the recorded audio */
  uri: string;
  /** Duration in seconds */
  durationSec: number;
  /** MIME type, e.g. 'audio/m4a' */
  mimeType: string;
}

// ── Extracted items ───────────────────────────────────────
// Actionable things pulled out of transcripts: tasks, appointments,
// shopping lists, and "where I put X" place notes.

export type ItemKind =
  | 'task'
  | 'appointment'
  | 'shopping'
  | 'place'
  | 'spec' // specifications & measurements ("filter size 20x25x1")
  | 'opinion' // tried / liked / disliked ("tried that brand, hated it")
  | 'checklist' // things to remember/bring ("before travel: passport, charger")
  | 'thing'; // owned/bought items — the 📦 "أشيائي" pillar (place + price)

export type ItemStatus = 'open' | 'done' | 'not_found'; // not_found = looked for, not found (ما لقيناه)

// ── Borrowing ("مين أخذها؟") ────────────────────────────────────
// Who borrowed what: lend events from chat create open rows
// (returned_at null); return events stamp returned_at.
export interface Borrow {
  id: string;
  space_id: string;
  item_title: string;
  borrower: string;
  lent_at: string;
  due_at: string | null;
  returned_at: string | null;
  note_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Item {
  id: string;
  space_id: string;
  note_id: string | null;
  kind: ItemKind;
  title: string;
  details: string | null;
  due_at: string | null;
  status: ItemStatus;
  assigned_to: string | null; // family member name, e.g. "سارة" ("سارة: اشتري خبز")
  list_id: string | null; // shopping_lists.id — null = loose item in the shared list
  bought_at: string | null; // when the item was actually bought (purchase history)
  meta: { price?: string | null; photo_url?: string | null } | null; // thing extras: price, place photo, etc.
  created_by: string | null;
  created_at: string;
}
