import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useTheme } from '../lib/theme';
import ErrorBoundary from '../components/ErrorBoundary';

export default function RootLayout() {
  const { resolved, palette: P } = useTheme();
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
