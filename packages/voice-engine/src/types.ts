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
