import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useTheme } from '../lib/theme';
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

export default function RootLayout() {
  const { resolved, palette: P } = useTheme();
  useNoInputFocusRing();
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: P.paper }}>
      <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      <ErrorBoundary>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: P.paper },
          }}
        />
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}
