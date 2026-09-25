import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';
import { TYPO, SPACE, RADIUS } from '../lib/theme';
import { t } from '../lib/i18n';

interface Props {
  visible: boolean;
  onDone: () => void;
}

/**
 * First-run welcome: 3 swipe-free steps that explain the app in 20 seconds.
 * Shows once per device (flag in AsyncStorage, owned by the caller).
 */
export function WelcomeScreen({ visible, onDone }: Props) {
  const { palette: P } = useTheme();
  const [page, setPage] = useState(0);

  const pages = [
    { icon: '🎙️', title: t('wel1Title'), body: t('wel1Body') },
    { icon: '🧠', title: t('wel2Title'), body: t('wel2Body') },
    { icon: '👨‍👩‍👧', title: t('wel3Title'), body: t('wel3Body') },
  ];
  const last = page === pages.length - 1;
  const cur = pages[page];

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onDone}>
      <SafeAreaView style={[styles.root, { backgroundColor: P.paper }]} edges={['top', 'bottom']}>
        <View style={styles.topRow}>
          <Pressable onPress={onDone} hitSlop={12} style={styles.skipBtn}>
            <Text style={[styles.skipText, { color: P.faint }]}>{t('welSkip')}</Text>
          </Pressable>
        </View>

        <View style={styles.body}>
          <Text style={styles.icon}>{cur.icon}</Text>
          <Text style={[styles.title, { color: P.ink }]}>{cur.title}</Text>
          <Text style={[styles.sub, { color: P.text2 }]}>{cur.body}</Text>
        </View>

        <View style={styles.bottom}>
          <View style={styles.dots}>
            {pages.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  { backgroundColor: i === page ? P.accent : P.surface2 },
                  i === page && styles.dotActive,
                ]}
              />
            ))}
          </View>
          <Pressable
            onPress={() => (last ? onDone() : setPage(page + 1))}
            style={[styles.cta, { backgroundColor: P.accent }]}
          >
            <Text style={[styles.ctaText, { color: '#fff' }]}>
              {last ? t('welStart') : t('welNext')}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: SPACE.lg,
    paddingTop: SPACE.sm,
  },
  skipBtn: { padding: SPACE.sm, minWidth: 64, alignItems: 'center' },
  skipText: { fontSize: TYPO.sub.size, fontWeight: '600' },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACE.xxxl,
    gap: SPACE.lg,
  },
  icon: { fontSize: 76 },
  title: {
    fontSize: TYPO.title.size,
    lineHeight: TYPO.title.height,
    fontWeight: TYPO.title.weight,
    textAlign: 'center',
  },
  sub: {
    fontSize: TYPO.body.size,
    lineHeight: TYPO.body.height + 4,
    textAlign: 'center',
  },
  bottom: { paddingHorizontal: SPACE.xxl, paddingBottom: SPACE.xxl, gap: SPACE.lg },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: SPACE.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotActive: { width: 26 },
  cta: {
    minHeight: 56,
    borderRadius: RADIUS.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: { fontSize: TYPO.headline.size, fontWeight: '800' },
});
