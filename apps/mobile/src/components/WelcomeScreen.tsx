import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, TYPO, SPACE, RADIUS } from '../lib/theme';
import { t } from '../lib/i18n';
import { VoiceWave } from '../lib/VoiceWave';

interface Props {
  visible: boolean;
  onDone: () => void;
  /** seconds elapsed while recording */
  recDuration: number;
  /** start the mic; resolves true when recording actually started */
  onStartRecord: () => Promise<boolean>;
  /** stop → upload → transcribe → save a real note; resolves the transcript (null on failure) */
  onStopRecord: () => Promise<string | null>;
  /** typed fallback: save the text as a real note; resolves the text (null on failure) */
  onSaveTextDemo: (text: string) => Promise<string | null>;
  /** send the demo question to the agent; resolves the answer text (null on failure) */
  onAskDemo: (q: string) => Promise<string | null>;
  /** replay the answer out loud */
  onSpeakDemo: (text: string) => void;
}

type Step = 'intro' | 'speak' | 'ask';
type MicState = 'idle' | 'waiting' | 'recording' | 'transcribing' | 'done' | 'failed';

const alignFor = (s: string): 'right' | 'left' => (/[\u0600-\u06FF]/.test(s) ? 'right' : 'left');
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Interactive first-run onboarding: the user records a REAL voice note, then
 * asks the agent about it and watches the magic happen — the core loop in
 * 60 seconds instead of a read-through. Shows once per device (flag owned by
 * the caller). Skip is always available.
 */
export function WelcomeScreen({
  visible,
  onDone,
  recDuration,
  onStartRecord,
  onStopRecord,
  onSaveTextDemo,
  onAskDemo,
  onSpeakDemo,
}: Props) {
  const { palette: P } = useTheme();
  const [step, setStep] = useState<Step>('intro');
  const [mic, setMic] = useState<MicState>('idle');
  const [transcript, setTranscript] = useState('');
  const [writeMode, setWriteMode] = useState(false);
  const [typed, setTyped] = useState('');
  const [saving, setSaving] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [askFailed, setAskFailed] = useState(false);

  const onMicPress = async () => {
    if (mic === 'idle' || mic === 'failed') {
      setMic('waiting');
      setWriteMode(false);
      const ok = await onStartRecord();
      // mic denied / unavailable → fall back to typing
      setMic(ok ? 'recording' : 'failed');
    } else if (mic === 'recording') {
      setMic('transcribing');
      const tr = await onStopRecord();
      if (tr) {
        setTranscript(tr);
        setMic('done');
        setTimeout(() => setStep('ask'), 1600);
      } else {
        setMic('failed');
      }
    }
  };

  const onSaveTyped = async () => {
    const clean = typed.trim();
    if (!clean || saving) return;
    setSaving(true);
    const tr = await onSaveTextDemo(clean);
    setSaving(false);
    if (tr) {
      setTranscript(tr);
      setMic('done');
      setTimeout(() => setStep('ask'), 1200);
    }
  };

  const ask = async (q: string) => {
    const clean = q.trim();
    if (!clean || asking) return;
    setAsking(true);
    setAskFailed(false);
    setAnswer(null);
    const a = await onAskDemo(clean);
    setAsking(false);
    if (a) setAnswer(a);
    else setAskFailed(true);
  };

  const showMilkChip = /حليب|milk/i.test(transcript);

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onDone}>
      <SafeAreaView style={[styles.root, { backgroundColor: P.paper }]} edges={['top', 'bottom']}>
        <View style={styles.topRow}>
          <Pressable onPress={onDone} hitSlop={12} style={styles.skipBtn}>
            <Text style={[styles.skipText, { color: P.faint }]}>{t('obSkip')}</Text>
          </Pressable>
        </View>

        {step === 'intro' && (
          <View style={styles.body}>
            <Text style={styles.icon}>✨</Text>
            <Text style={[styles.title, { color: P.ink }]}>{t('obIntroTitle')}</Text>
            <Text style={[styles.sub, { color: P.text2 }]}>{t('obIntroBody')}</Text>
            <Pressable onPress={() => setStep('speak')} style={[styles.cta, { backgroundColor: P.accent }]}>
              <Text style={styles.ctaText}>{t('obIntroCta')}</Text>
            </Pressable>
            <Text style={[styles.hint, { color: P.faint }]}>{t('obFamilyHint')}</Text>
          </View>
        )}

        {step === 'speak' && (
          <View style={styles.body}>
            <Text style={[styles.title, { color: P.ink }]}>{t('obSayTitle')}</Text>

            {!writeMode ? (
              <>
                <View style={[styles.phraseCard, { backgroundColor: P.surface, borderColor: P.border }]}>
                  <Text style={[styles.phraseLabel, { color: P.faint }]}>{t('obSayPhrase')}</Text>
                  <Text style={[styles.phrase, { color: P.ink, textAlign: alignFor(t('obDemoPhrase')) }]}>
                    «{t('obDemoPhrase')}»
                  </Text>
                  <Text style={[styles.hint, { color: P.faint }]}>{t('obOrSay')}</Text>
                </View>

                <Pressable
                  onPress={onMicPress}
                  disabled={mic === 'waiting' || mic === 'transcribing'}
                  style={[
                    styles.micBtn,
                    {
                      backgroundColor: mic === 'recording' ? '#e5484d' : P.accent,
                      opacity: mic === 'waiting' || mic === 'transcribing' ? 0.7 : 1,
                    },
                  ]}
                >
                  {mic === 'transcribing' ? (
                    <ActivityIndicator color="#fff" size="large" />
                  ) : (
                    <Text style={styles.micIcon}>{mic === 'recording' ? '⏹️' : '🎙️'}</Text>
                  )}
                </Pressable>
                {mic === 'recording' && (
                  <View style={styles.recRow}>
                    <VoiceWave />
                    <Text style={[styles.recTime, { color: '#e5484d' }]}>{fmtDur(recDuration)}</Text>
                  </View>
                )}
                <Text style={[styles.hint, { color: P.faint }]}>
                  {mic === 'recording'
                    ? t('obTapStop')
                    : mic === 'transcribing'
                      ? t('obTranscribing')
                      : mic === 'done'
                        ? `${t('obRecorded')} ${transcript}`
                        : t('obTapMic')}
                </Text>
                {(mic === 'idle' || mic === 'failed') && (
                  <Pressable onPress={() => setWriteMode(true)} hitSlop={8}>
                    <Text style={[styles.link, { color: P.accent }]}>{t('obWriteInstead')}</Text>
                  </Pressable>
                )}
                {mic === 'failed' && (
                  <Text style={[styles.err, { color: '#e5484d' }]}>{t('obDemoFail')}</Text>
                )}
              </>
            ) : (
              <>
                <TextInput
                  value={typed}
                  onChangeText={setTyped}
                  placeholder={t('obWritePh')}
                  placeholderTextColor={P.faint}
                  multiline
                  style={[
                    styles.input,
                    {
                      backgroundColor: P.surface,
                      borderColor: P.border,
                      color: P.ink,
                      textAlign: alignFor(typed || t('obDemoPhrase')),
                    },
                  ]}
                />
                <Pressable
                  onPress={onSaveTyped}
                  disabled={!typed.trim() || saving}
                  style={[styles.cta, { backgroundColor: P.accent, opacity: !typed.trim() || saving ? 0.6 : 1 }]}
                >
                  {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>{t('obSave')}</Text>}
                </Pressable>
                <Pressable onPress={() => setWriteMode(false)} hitSlop={8}>
                  <Text style={[styles.link, { color: P.accent }]}>🎙️</Text>
                </Pressable>
              </>
            )}
          </View>
        )}

        {step === 'ask' && (
          <View style={styles.body}>
            <Text style={[styles.title, { color: P.ink }]}>{t('obAskTitle')}</Text>
            {!!transcript && (
              <Text style={[styles.hint, { color: P.faint, textAlign: alignFor(transcript) }]} numberOfLines={2}>
                {t('obRecorded')} {transcript}
              </Text>
            )}
            <Text style={[styles.sub, { color: P.text2 }]}>{t('obAskHint')}</Text>

            <View style={styles.chips}>
              {showMilkChip && (
                <Pressable
                  onPress={() => ask(t('obWhereMilk'))}
                  disabled={asking}
                  style={[styles.chip, { backgroundColor: P.surface, borderColor: P.accent }]}
                >
                  <Text style={[styles.chipText, { color: P.ink }]}>{t('obWhereMilk')}</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => ask(t('obWhatRecorded'))}
                disabled={asking}
                style={[styles.chip, { backgroundColor: P.surface, borderColor: P.border }]}
              >
                <Text style={[styles.chipText, { color: P.ink }]}>{t('obWhatRecorded')}</Text>
              </Pressable>
            </View>

            <View style={styles.askRow}>
              <TextInput
                value={question}
                onChangeText={setQuestion}
                placeholder={t('obAskPh')}
                placeholderTextColor={P.faint}
                onSubmitEditing={() => {
                  ask(question);
                  setQuestion('');
                }}
                returnKeyType="send"
                style={[
                  styles.askInput,
                  {
                    backgroundColor: P.surface,
                    borderColor: P.border,
                    color: P.ink,
                    textAlign: alignFor(question),
                  },
                ]}
              />
              <Pressable
                onPress={() => {
                  ask(question);
                  setQuestion('');
                }}
                disabled={!question.trim() || asking}
                style={[styles.sendBtn, { backgroundColor: P.accent, opacity: !question.trim() || asking ? 0.5 : 1 }]}
              >
                <Text style={styles.sendIcon}>➤</Text>
              </Pressable>
            </View>

            {asking && (
              <View style={[styles.answerCard, { backgroundColor: P.bubbleApp, borderColor: P.border }]}>
                <ActivityIndicator color={P.accent} />
                <Text style={[styles.hint, { color: P.faint }]}>{t('obThinking')}</Text>
              </View>
            )}
            {!!answer && (
              <View style={[styles.answerCard, { backgroundColor: P.bubbleApp, borderColor: P.accent }]}>
                <Text style={[styles.answerText, { color: P.ink, textAlign: alignFor(answer) }]}>{answer}</Text>
                <Pressable onPress={() => onSpeakDemo(answer)} hitSlop={8} style={styles.replayBtn}>
                  <Text style={[styles.link, { color: P.accent }]}>{t('obReplay')}</Text>
                </Pressable>
              </View>
            )}
            {askFailed && <Text style={[styles.err, { color: '#e5484d' }]}>{t('obAskFail')}</Text>}

            {!!answer && (
              <Pressable onPress={onDone} style={[styles.cta, { backgroundColor: P.accent }]}>
                <Text style={styles.ctaText}>{t('obDoneCta')}</Text>
              </Pressable>
            )}
          </View>
        )}
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
    paddingHorizontal: SPACE.xxl,
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
  hint: { fontSize: TYPO.sub.size, textAlign: 'center' },
  err: { fontSize: TYPO.sub.size, textAlign: 'center', fontWeight: '600' },
  link: { fontSize: TYPO.body.size, fontWeight: '700' },
  cta: {
    minHeight: 56,
    borderRadius: RADIUS.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACE.xxl,
    minWidth: 220,
  },
  ctaText: { fontSize: TYPO.headline.size, fontWeight: '800', color: '#fff' },
  phraseCard: {
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACE.lg,
    gap: SPACE.sm,
    width: '100%',
  },
  phraseLabel: { fontSize: TYPO.sub.size, textAlign: 'center' },
  phrase: { fontSize: TYPO.headline.size, fontWeight: '700', lineHeight: TYPO.headline.height + 6 },
  micBtn: {
    width: 104,
    height: 104,
    borderRadius: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACE.sm,
  },
  micIcon: { fontSize: 44 },
  recRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  recTime: { fontSize: TYPO.headline.size, fontWeight: '800', fontVariant: ['tabular-nums'] },
  input: {
    width: '100%',
    minHeight: 96,
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACE.md,
    fontSize: TYPO.body.size,
    textAlignVertical: 'top',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: SPACE.sm },
  chip: {
    borderWidth: 1.5,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.sm,
  },
  chipText: { fontSize: TYPO.body.size, fontWeight: '700' },
  askRow: { flexDirection: 'row', width: '100%', gap: SPACE.sm, alignItems: 'center' },
  askInput: {
    flex: 1,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    paddingHorizontal: SPACE.md,
    fontSize: TYPO.body.size,
  },
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendIcon: { fontSize: 20, color: '#fff' },
  answerCard: {
    borderWidth: 1.5,
    borderRadius: RADIUS.lg,
    padding: SPACE.lg,
    gap: SPACE.sm,
    width: '100%',
    alignItems: 'center',
  },
  answerText: { fontSize: TYPO.headline.size, fontWeight: '700', lineHeight: TYPO.headline.height + 6 },
  replayBtn: { padding: SPACE.xs },
});
