import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ta } from './i18n';
import { useTheme } from './theme';

interface SearchBarProps {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  /** true while a server search is in flight (shows a spinner) */
  searching?: boolean;
}

/**
 * The ONE search input every tab uses. Themed, RTL-aware, with a spinner
 * while searching and a clear (✕) button when there is text.
 */
export function SearchBar({ value, onChange, placeholder, searching }: SearchBarProps) {
  const { palette: P } = useTheme();
  const styles = useMemo(() => makeStyles(P), [P]);
  return (
    <View style={styles.wrap}>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={P.faint}
        style={[styles.input, { textAlign: ta() }]}
        returnKeyType="search"
        autoCorrect={false}
      />
      {searching ? (
        <ActivityIndicator size="small" color={P.accent} style={styles.icon} />
      ) : value.length > 0 ? (
        <Pressable onPress={() => onChange('')} hitSlop={10} style={styles.icon}>
          <Text style={styles.clear}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (P: ReturnType<typeof useTheme>['palette']) =>
  StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: P.surface,
      borderRadius: 10,
      paddingHorizontal: 12,
      marginHorizontal: 16,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: P.faint2,
    },
    input: {
      flex: 1,
      paddingVertical: 10,
      fontSize: 15,
      color: P.ink,
    },
    icon: {
      marginStart: 8,
    },
    clear: {
      fontSize: 14,
      color: P.faint,
    },
  });
