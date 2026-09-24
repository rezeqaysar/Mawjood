import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from './theme';
import { getLang, t } from './i18n';

interface Props {
  /** YYYY-MM-DD counts of appointments per day */
  counts: Record<string, number>;
  selected: string | null;
  onSelect: (day: string | null) => void;
}

const toISODate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * ONE week strip for the agenda tab: ‹ week › navigation, tap a day to
 * filter appointments, tap again (or الكل) to clear.
 * Week starts Saturday in Arabic, Sunday in English.
 */
export function WeekStrip({ counts, selected, onSelect }: Props) {
  const { palette: P } = useTheme();
  const [weekOffset, setWeekOffset] = useState(0);
  const lang = getLang();
  const weekStart = lang === 'ar' ? 6 : 0; // Saturday : Sunday

  const days = useMemo(() => {
    const today = new Date();
    const dow = today.getDay();
    const delta = (dow - weekStart + 7) % 7;
    const start = new Date(today);
    start.setDate(today.getDate() - delta + weekOffset * 7);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [weekOffset, weekStart]);

  const dayName = (d: Date) =>
    d.toLocaleDateString(lang === 'ar' ? 'ar' : 'en-US', { weekday: 'short' });
  const todayISO = useMemo(() => toISODate(new Date()), []);

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setWeekOffset((w) => w - 1)}
        hitSlop={10}
        style={[styles.arrow, { borderColor: P.border }]}
      >
        <Text style={[styles.arrowText, { color: P.ink }]}>‹</Text>
      </Pressable>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        <Pressable
          onPress={() => onSelect(null)}
          style={[
            styles.day,
            { borderColor: P.border, backgroundColor: P.surface },
            selected === null && { backgroundColor: P.ink, borderColor: P.ink },
          ]}
        >
          <Text
            style={[styles.dayNum, { color: selected === null ? P.paper : P.ink }]}
          >
            {t('weekAll')}
          </Text>
        </Pressable>
        {days.map((d) => {
          const iso = toISODate(d);
          const isSel = selected === iso;
          const isToday = iso === todayISO;
          return (
            <Pressable
              key={iso}
              onPress={() => onSelect(isSel ? null : iso)}
              style={[
                styles.day,
                { borderColor: P.border, backgroundColor: P.surface },
                isSel && { backgroundColor: P.accent, borderColor: P.accent },
                !isSel && isToday && { borderColor: P.accent, borderWidth: 1.5 },
              ]}
            >
              <Text
                style={[
                  styles.dayName,
                  { color: isSel ? '#fff' : P.faint },
                ]}
              >
                {dayName(d)}
              </Text>
              <Text style={[styles.dayNum, { color: isSel ? '#fff' : P.ink }]}>
                {d.getDate()}
              </Text>
              {(counts[iso] ?? 0) > 0 ? (
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: isSel ? '#fff' : P.accent },
                  ]}
                />
              ) : (
                <View style={styles.dotPlaceholder} />
              )}
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable
        onPress={() => setWeekOffset((w) => w + 1)}
        hitSlop={10}
        style={[styles.arrow, { borderColor: P.border }]}
      >
        <Text style={[styles.arrowText, { color: P.ink }]}>›</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    gap: 4,
  },
  arrow: {
    width: 30,
    height: 56,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowText: {
    fontSize: 22,
    fontWeight: '700',
  },
  strip: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 2,
    alignItems: 'center',
  },
  day: {
    width: 46,
    height: 56,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  dayName: {
    fontSize: 10,
  },
  dayNum: {
    fontSize: 16,
    fontWeight: '700',
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  dotPlaceholder: {
    width: 5,
    height: 5,
  },
});
