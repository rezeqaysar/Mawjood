// AuthScreen: email magic-link sign-in for new users.
// The parent owns the auth-state listener; this screen is presentational.
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { sendMagicLink } from '../lib/auth';
import { useTheme, type Palette } from '../lib/theme';
import { t, tx } from '../lib/i18n';

export default function AuthScreen() {
  const { palette: P } = useTheme();
  const styles = useMemo(() => makeStyles(P), [P]);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const clean = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
      setError(t('invalidEmail'));
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendMagicLink(clean);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('authSendFail'));
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.root}
    >
      <View style={styles.card}>
        <Text style={styles.logo}>{t('logo')}</Text>
        <Text style={styles.tagline}>Lost it? Mawjood.</Text>
        {sent ? (
          <>
            <Text style={styles.title}>{t('checkEmail')}</Text>
            <Text style={styles.body}>
              {tx('magicSent', { email: email.trim() })}
            </Text>
            <Pressable onPress={() => setSent(false)} style={styles.ghostBtn}>
              <Text style={styles.ghostText}>{t('useOtherEmail')}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.title}>{t('loginWithEmail')}</Text>
            <Text style={styles.body}>{t('loginSub')}</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor="P.faint"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              onSubmitEditing={submit}
              returnKeyType="send"
              textAlign="left"
            />
            {error ? <Text style={styles.err}>{error}</Text> : null}
            <Pressable onPress={submit} disabled={sending} style={styles.btn}>
              {sending ? (
                <ActivityIndicator color={P.paper} />
              ) : (
                <Text style={styles.btnText}>{t('sendLink')}</Text>
              )}
            </Pressable>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (P: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: P.paper, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 380, alignItems: 'center' },
  logo: { fontSize: 44, fontWeight: '800', color: P.ink, marginBottom: 4 },
  tagline: { fontSize: 15, color: P.faint, marginBottom: 32 },
  title: { fontSize: 22, fontWeight: '700', color: P.ink, marginBottom: 8 },
  body: { fontSize: 15, color: P.text3, textAlign: 'center', marginBottom: 20, lineHeight: 22 },
  input: {
    width: '100%',
    backgroundColor: P.input,
    borderRadius: 14,
    padding: 14,
    fontSize: 16,
    color: P.ink,
    borderWidth: 1,
    borderColor: P.border,
    marginBottom: 12,
  },
  err: { color: P.danger, marginBottom: 8, fontSize: 14 },
  btn: {
    width: '100%',
    backgroundColor: P.ink,
    borderRadius: 14,
    padding: 15,
    alignItems: 'center',
  },
  btnText: { color: P.paper, fontSize: 16, fontWeight: '700' },
  ghostBtn: { marginTop: 16, padding: 8 },
  ghostText: { color: P.faint, fontSize: 14 },
});
