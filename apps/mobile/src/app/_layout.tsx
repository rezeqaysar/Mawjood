import { Stack } from 'expo-router';
import { View } from 'react-native';

// STEP 1: Add back Stack only — no theme, no gestures, no StatusBar.
// If this crashes, the culprit is expo-router/react-native-screens.
export default function RootLayout() {
  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }} />
    </View>
  );
}
