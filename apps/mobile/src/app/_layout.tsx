import { Stack } from 'expo-router';
import { View } from 'react-native';
import { useTheme } from '../lib/theme';
import ErrorBoundary from '../components/ErrorBoundary';

// DIAGNOSTIC: minimal layout — StatusBar and GestureHandlerRootView removed
// to isolate the TurboModule crash. Will restore after identifying culprit.
export default function RootLayout() {
  const { palette: P } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: P.paper }}>
      <ErrorBoundary>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: P.paper },
          }}
        />
      </ErrorBoundary>
    </View>
  );
}
