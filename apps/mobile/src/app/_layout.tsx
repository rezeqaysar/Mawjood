import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useEffect } from 'react';
import { Platform, StatusBar, Text } from 'react-native';
import { useTheme, initTheme } from '../lib/theme';
import ErrorBoundary from '../components/ErrorBoundary';

/**
 * Web only: browsers draw their own focus ring on text inputs/textareas and
 * react-native-web doesn't forward outline styles, so a tiny CSS rule removes
 * it (the composer has its own visible border already).
 */
function useNoInputFocusRing() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const el = document.createElement('style');
    el.setAttribute('data-mawjood', 'no-input-ring');
    el.textContent =
      'textarea:focus,input:focus{outline:none !important;box-shadow:none !important;}';
    document.head.appendChild(el);
    return () => {
      el.remove();
    };
  }, []);
}

// Inner component: all the hooks and UI that might throw.
// Wrapped by ErrorBoundary OUTSIDE so any startup JS error
// shows on screen instead of crashing the app.
function InnerLayout() {
  const { resolved, palette: P } = useTheme();
  useNoInputFocusRing();
  // Init theme AFTER mount — calling AsyncStorage at import time crashes
  // on iOS 26 (TurboModule NSException during bridge init).
  useEffect(() => {
    initTheme();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: P.paper }}>
      <StatusBar barStyle={resolved === 'dark' ? 'light-content' : 'dark-content'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: P.paper },
        }}
      />
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <InnerLayout />
    </ErrorBoundary>
  );
}
