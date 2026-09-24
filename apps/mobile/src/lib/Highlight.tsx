import { useMemo } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { useTheme } from './theme';

interface Props {
  text: string;
  /** the search query — matches are highlighted; empty query = plain text */
  query: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}

/**
 * ONE match-highlighter for every search result in every tab.
 * Splits on the query (case-insensitive, Arabic-safe) and paints matches
 * with the accent soft background.
 */
export function Highlight({ text, query, style, numberOfLines }: Props) {
  const { palette: P } = useTheme();
  const parts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !text) return null;
    const lower = text.toLowerCase();
    const out: { key: number; str: string; hit: boolean }[] = [];
    let i = 0;
    let k = 0;
    while (i < text.length) {
      const j = lower.indexOf(q, i);
      if (j === -1) {
        out.push({ key: k++, str: text.slice(i), hit: false });
        break;
      }
      if (j > i) out.push({ key: k++, str: text.slice(i, j), hit: false });
      out.push({ key: k++, str: text.slice(j, j + q.length), hit: true });
      i = j + q.length;
    }
    return out;
  }, [text, query]);

  if (!parts) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {parts.map((p) =>
        p.hit ? (
          <Text key={p.key} style={[styles.hit, { backgroundColor: `${P.accent}40` }]}>
            {p.str}
          </Text>
        ) : (
          <Text key={p.key}>{p.str}</Text>
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  hit: {
    borderRadius: 3,
  },
});
