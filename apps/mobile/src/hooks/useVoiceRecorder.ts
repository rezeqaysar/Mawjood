import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  RecordingPresets,
  useAudioRecorder,
} from 'expo-audio';
import type { RecordedAudio } from '@mawjood/voice-engine';

/**
 * Voice recording for Mawjood (expo-audio, SDK 57).
 * HIGH_QUALITY preset → .m4a file, suitable for gpt-4o-mini-transcribe.
 */
export function useVoiceRecorder() {
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const durationRef = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

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
