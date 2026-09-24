import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from './theme';
import { t } from './i18n';

interface Props {
  icon: string;
  message: string;
  /** tappable voice example — fills the chat input and jumps to Home */
  example?: string;
  onTryExample?: (example: string) => void;
}

/**
 * ONE smart empty-state for every tab: a friendly icon, a short message,
 * and a tappable voice example that teaches the voice-first flow.
 */
export function EmptyState({ icon, message, example, onTryExample }: Props) {
  const { palette: P } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={styles.icon}>{icon}</Text>
      <Text style={[styles.msg, { color: P.faint }]}>{message}</Text>
      {example && onTryExample ? (
        <Pressable
          onPress={() => onTryExample(example)}
          style={({ pressed }) => [
            styles.chip,
            { borderColor: P.accent, backgroundColor: P.surface },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.chipText, { color: P.accent }]} numberOfLines={2}>
            💡 {t('tryExample')}: “{example}”
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingVertical: 36,
    paddingHorizontal: 28,
    gap: 10,
  },
  icon: {
    fontSize: 44,
  },
  msg: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  chip: {
    borderWidth: 1.5,
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginTop: 6,
  },
  pressed: {
    opacity: 0.6,
  },
  chipText: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
});
