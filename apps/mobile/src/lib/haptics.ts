import * as Haptics from 'expo-haptics';

/** ONE haptics helper for the whole app — safe no-op on web/unsupported. */
function safe(fn: () => Promise<unknown>) {
  try {
    void fn().catch(() => {});
  } catch {
    /* haptics unsupported here */
  }
}

/** light tap: toggles, checkmarks, selections */
export function tap(style: 'light' | 'medium' | 'heavy' = 'light') {
  const s =
    style === 'light'
      ? Haptics.ImpactFeedbackStyle.Light
      : style === 'medium'
        ? Haptics.ImpactFeedbackStyle.Medium
        : Haptics.ImpactFeedbackStyle.Heavy;
  safe(() => Haptics.impactAsync(s));
}

/** success ping: something finished well */
export function pingSuccess() {
  safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}
