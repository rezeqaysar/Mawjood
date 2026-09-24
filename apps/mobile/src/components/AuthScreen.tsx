// AuthScreen: email magic-link sign-in for new users.
// The parent owns the auth-state listener; this screen is presentational.
import { useState } from 'react';
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
import { t, tx } from '../lib/i18n';

export default function AuthScreen() {
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
              placeholderTextColor="#A09485"
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
                <ActivityIndicator color="#fff" />
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FAF7F2', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 380, alignItems: 'center' },
  logo: { fontSize: 44, fontWeight: '800', color: '#2B2118', marginBottom: 4 },
  tagline: { fontSize: 15, color: '#A09485', marginBottom: 32 },
  title: { fontSize: 22, fontWeight: '700', color: '#2B2118', marginBottom: 8 },
  body: { fontSize: 15, color: '#6B5D4F', textAlign: 'center', marginBottom: 20, lineHeight: 22 },
  input: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    fontSize: 16,
    color: '#2B2118',
    borderWidth: 1,
    borderColor: '#E8E0D4',
    marginBottom: 12,
  },
  err: { color: '#B3402E', marginBottom: 8, fontSize: 14 },
  btn: {
    width: '100%',
    backgroundColor: '#2B2118',
    borderRadius: 14,
    padding: 15,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  ghostBtn: { marginTop: 16, padding: 8 },
  ghostText: { color: '#A09485', fontSize: 14 },
});
