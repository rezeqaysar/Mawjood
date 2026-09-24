import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from './theme';
import { t } from './i18n';

interface Props {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

/** ONE undo snackbar for the whole app: "X deleted — [تراجع]". */
export function UndoBar({ message, onUndo, onDismiss }: Props) {
  const { palette: P } = useTheme();
  return (
    <View style={[styles.wrap, { backgroundColor: P.ink, shadowColor: P.ink }]}>
      <Text style={styles.msg}>{message}</Text>
      <Pressable
        onPress={onUndo}
        hitSlop={12}
        style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
      >
        <Text style={[styles.btnText, { color: P.accent }]}>{t('undo')}</Text>
      </Pressable>
      <Pressable onPress={onDismiss} hitSlop={12}>
        <Text style={styles.close}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 92,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
    zIndex: 60,
  },
  msg: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
  },
  btn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  pressed: {
    opacity: 0.6,
  },
  btnText: {
    fontSize: 15,
    fontWeight: '700',
  },
  close: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
  },
});
