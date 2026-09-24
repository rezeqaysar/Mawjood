import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useTheme } from './theme';

const BARS = 14;
const MIN_H = 4;
const MAX_H = 26;

/**
 * Animated voice waveform shown while recording — a lively row of bars.
 * Purely visual (no mic metering on this path); loops until unmounted.
 */
export function VoiceWave() {
  const { palette: P } = useTheme();
  // stable animated values (never re-created)
  const [anims] = useState(() =>
    Array.from({ length: BARS }, () => new Animated.Value(MIN_H)),
  );

  useEffect(() => {
    const loops = anims.map((v) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {
            toValue: MIN_H + Math.random() * (MAX_H - MIN_H),
            duration: 180 + Math.random() * 220,
            useNativeDriver: false,
          }),
          Animated.timing(v, {
            toValue: MIN_H,
            duration: 180 + Math.random() * 220,
            useNativeDriver: false,
          }),
        ]),
        { iterations: -1 },
      ),
    );
    // stagger the starts so it looks like a real wave
    const timers = loops.map((l, i) => setTimeout(() => l.start(), i * 60));
    return () => {
      timers.forEach(clearTimeout);
      loops.forEach((l) => l.stop());
    };
  }, [anims]);

  return (
    <View style={styles.row} accessibilityLabel="recording">
      {anims.map((v, i) => (
        <Animated.View
          key={i}
          style={[styles.bar, { backgroundColor: P.danger, height: v }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    height: MAX_H + 4,
  },
  bar: {
    width: 3,
    borderRadius: 2,
  },
});
