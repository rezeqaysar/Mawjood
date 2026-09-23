import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioQuality,
  getRecordingPermissionsAsync,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import type { RecordedAudio } from '@mawjood/voice-engine';

/**
 * Voice-memo preset: 16 kHz mono AAC at 32 kbps.
 * Whisper resamples to 16 kHz internally, so anything above this only costs
 * upload time — a 60 s note is ~240 KB instead of ~1 MB (HIGH_QUALITY).
 */
const VOICE_PRESET: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  android: {
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    extension: '.m4a',
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.LOW,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 32000,
  },
};

/**
 * Voice recording for Mawjood (expo-audio, SDK 57).
 * VOICE_PRESET → small .m4a file, tuned for Whisper transcription speed.
 */
export function useVoiceRecorder() {
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const durationRef = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorder = useAudioRecorder(VOICE_PRESET);

  useEffect(() => {
    getRecordingPermissionsAsync().then((p) => {
      if (p.granted) setPermissionGranted(true);
    });
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async () => {
    if (isRecording) return;
    if (!permissionGranted) {
      const res = await requestRecordingPermissionsAsync();
      if (!res.granted) return;
      setPermissionGranted(true);
    }
    await recorder.prepareToRecordAsync();
    recorder.record();
    durationRef.current = 0;
    setDuration(0);
    setIsRecording(true);
    timer.current = setInterval(() => {
      durationRef.current += 1;
      setDuration(durationRef.current);
    }, 1000);
  }, [isRecording, permissionGranted, recorder]);

  const stop = useCallback(async (): Promise<RecordedAudio | null> => {
    if (!isRecording) return null;
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    await recorder.stop();
    setIsRecording(false);
    const uri = recorder.uri;
    if (!uri) return null;
    return {
      uri,
      durationSec: durationRef.current,
      mimeType: 'audio/m4a',
    };
  }, [isRecording, recorder]);

  return { isRecording, duration, permissionGranted, start, stop };
}
