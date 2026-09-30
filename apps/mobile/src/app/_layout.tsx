import { View, Text } from 'react-native';

// ULTIMATE DIAGNOSTIC: no expo-router Stack, no navigation, no theme,
// no gestures — just a bare View. If this crashes, it's core RN/Expo.
// If it works, the crash is in expo-router/react-native-screens.
export default function RootLayout() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
      <Text style={{ fontSize: 24 }}>Mawjood Test</Text>
      <Text style={{ fontSize: 14, marginTop: 8 }}>If you see this, core RN works</Text>
    </View>
  );
}
