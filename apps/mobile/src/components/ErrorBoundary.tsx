import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../lib/theme';
import { useLang } from '../lib/i18n';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/** Catches render crashes and shows the message on screen instead of a
 *  white page — the user screenshots it and we fix the real bug. */
class Boundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[Mawjood] render crash:', error);
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return <CrashScreen error={this.state.error} onRetry={this.retry} />;
  }
}

function CrashScreen({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { palette: P } = useTheme();
  const lang = useLang();
  const ar = lang === 'ar';
  return (
    <View style={{ flex: 1, backgroundColor: P.paper, padding: 24, justifyContent: 'center' }}>
      <Text style={{ fontSize: 48, textAlign: 'center', marginBottom: 12 }}>🛠️</Text>
      <Text style={{ fontSize: 18, fontWeight: '800', color: P.ink, textAlign: 'center', marginBottom: 8 }}>
        {ar ? 'عطل غير متوقع' : 'Something broke'}
      </Text>
      <Text style={{ fontSize: 14, color: P.muted, textAlign: 'center', marginBottom: 12 }}>
        {ar ? 'صوّر الشاشة وابعثها — هاد بيساعدنا نصلّحها' : 'Screenshot this and send it — it helps us fix it'}
      </Text>
      <ScrollView
        style={{
          maxHeight: 220,
          backgroundColor: P.input,
          borderRadius: 12,
          padding: 12,
          marginBottom: 16,
        }}
      >
        <Text selectable style={{ fontSize: 12, color: P.ink, fontFamily: 'monospace' }}>
          {error.message}
          {'\n\n'}
          {(error.stack ?? '').split('\n').slice(0, 8).join('\n')}
        </Text>
      </ScrollView>
      <Pressable
        onPress={onRetry}
        style={{
          backgroundColor: P.accent,
          borderRadius: 14,
          minHeight: 52,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
          {ar ? 'حاول مرة ثانية 🔄' : 'Try again 🔄'}
        </Text>
      </Pressable>
    </View>
  );
}

export default function ErrorBoundary({ children }: Props) {
  return <Boundary>{children}</Boundary>;
}
