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
  transcript: string | null;
  language: string | null;
  duration_sec: number | null;
  status: NoteStatus;
  error: string | null;
  created_by: string;
  created_at: string;
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
  | 'checklist'; // things to remember/bring ("before travel: passport, charger")

export type ItemStatus = 'open' | 'done';

export interface Item {
  id: string;
  space_id: string;
  note_id: string | null;
  kind: ItemKind;
  title: string;
  details: string | null;
  due_at: string | null;
  status: ItemStatus;
  created_by: string | null;
  created_at: string;
}
