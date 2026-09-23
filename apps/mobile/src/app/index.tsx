import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  VoiceEngine,
  answerLocally,
  extractCorrectionPlace,
  isCorrection,
  isQuestion,
  suggestSpaceType,
} from '@mawjood/voice-engine';
import type { Item, Note, Space, SpaceType } from '@mawjood/voice-engine';
import { ensureSignedIn, supabase } from '../lib/supabase';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';

const engine = new VoiceEngine(supabase);

const KIND_ICON: Record<string, string> = {
  task: '⬜',
  appointment: '📅',
  shopping: '🛒',
  place: '📍',
  spec: '📏',
  opinion: '💭',
  checklist: '🧳',
};

const SPACE_LABELS: Record<string, string> = {
  private: '🔒 Private',
  family: '👨‍👩‍👧 Family',
  work: '💼 Work',
};

function statusLabel(n: Note): string {
  switch (n.status) {
    case 'ready':
      return n.transcript || '(empty transcript)';
    case 'failed':
      return `⚠️ failed: ${n.error ?? 'unknown error'}`;
    case 'transcribing':
      return '⏳ transcribing…';
    case 'uploading':
      return '⏳ uploading…';
    default:
      return '⏳ processing…';
  }
}

interface AskAnswer {
  text: string;
  sources: { note_id: string; snippet: string }[];
  demo: boolean;
}

export default function HomeScreen() {
  const [userId, setUserId] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpace, setActiveSpace] = useState<Space | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteItems, setNoteItems] = useState<Record<string, Item[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const pollers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const { isRecording, duration, start, stop } = useVoiceRecorder();

  // Phase 1: input mode (voice/text), move picker, space suggestions, demo data
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');
  const [textNote, setTextNote] = useState('');
  const [textTargetSpaceId, setTextTargetSpaceId] = useState<string | null>(null);
  const [savingText, setSavingText] = useState(false);
  const [movePickerFor, setMovePickerFor] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [spaceSuggestions, setSpaceSuggestions] = useState<Record<string, SpaceType>>({});
  const [dismissedSug, setDismissedSug] = useState<Record<string, true>>({});
  const [showDemo, setShowDemo] = useState(false);
  const [demoNoteIds, setDemoNoteIds] = useState<string[]>([]);

  // Phase 2: search + unified Q&A (question → answer, statement → note)
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ notes: Note[]; items: Item[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  // the item the last answer was based on — enables "لا، نقلته على الخزانة"
  const [lastAnswerItem, setLastAnswerItem] = useState<Item | null>(null);
  const lastAnswerItemRef = useRef<Item | null>(null);

  const setLastAnswer = useCallback((item: Item | null) => {
    setLastAnswerItem(item);
    lastAnswerItemRef.current = item;
  }, []);

  const refreshNotes = useCallback(async (spaceId: string) => {
    try {
      setNotes(await engine.listNotes(spaceId));
    } catch (e) {
      console.warn('listNotes failed', e);
    }
  }, []);

  const refreshItems = useCallback(async (spaceId: string) => {
    try {
      const items = await engine.listItems(spaceId);
      const grouped: Record<string, Item[]> = {};
      for (const it of items) {
        if (!it.note_id) continue;
        (grouped[it.note_id] ??= []).push(it);
      }
      setNoteItems(grouped);
    } catch (e) {
      console.warn('listItems failed', e);
    }
  }, []);

  const toggleItem = useCallback(async (item: Item) => {
    const next = item.status === 'open' ? 'done' : 'open';
    setNoteItems((prev) => ({
      ...prev,
      [item.note_id!]: (prev[item.note_id!] ?? []).map((p) =>
        p.id === item.id ? { ...p, status: next } : p,
      ),
    }));
    try {
      await engine.setItemStatus(item.id, next);
    } catch (e) {
      console.warn('setItemStatus failed', e);
    }
  }, []);

  const spaceIdByType = useCallback(
    (t: SpaceType) => spaces.find((s) => s.type === t)?.id ?? null,
    [spaces],
  );

  const doMove = useCallback(async (note: Note, targetSpaceId: string | null) => {
    if (!targetSpaceId || targetSpaceId === note.space_id) return;
    setMovingId(note.id);
    try {
      await engine.moveNote(note.id, targetSpaceId);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      setNoteItems((prev) => {
        const copy = { ...prev };
        delete copy[note.id];
        return copy;
      });
      setMovePickerFor(null);
      setDismissedSug((prev) => ({ ...prev, [note.id]: true }));
    } catch (e) {
      console.warn('moveNote failed', e);
    } finally {
      setMovingId(null);
    }
  }, []);

  // ── unified Q&A ─────────────────────────────────────────────

  /** Answer a question (AI first, local fallback). Never saves a note. */
  const doAsk = useCallback(
    async (q: string) => {
      const spaceId = activeSpace?.id;
      if (!q.trim() || !spaceId) return;
      setAsking(true);
      setAnswer(null);
      try {
        const r = await engine.ask(q, spaceId);
        setAnswer({ text: r.answer, sources: r.sources, demo: false });
        setLastAnswer(null);
      } catch (e) {
        console.warn('ask fn failed, using local fallback', e);
        try {
          const [allNotes, allItems] = await Promise.all([
            engine.listNotes(spaceId, 60),
            engine.listItems(spaceId, 120),
          ]);
          const local = answerLocally(q, allNotes, allItems);
          if (local) {
            setAnswer({ text: local.answer, sources: local.sources, demo: true });
            setLastAnswer(local.item ?? null);
          } else {
            setAnswer({
              text: '🧪 ما لقيت إجابة بملاحظات هالمساحة.',
              sources: [],
              demo: true,
            });
            setLastAnswer(null);
          }
        } catch {
          setAnswer({ text: 'تعذّر السؤال — جرّب لاحقاً.', sources: [], demo: true });
          setLastAnswer(null);
        }
      } finally {
        setAsking(false);
      }
    },
    [activeSpace, setLastAnswer],
  );

  /** Conversational correction: "لا، نقلته على الخزانة" → update the item. */
  const doCorrect = useCallback(
    async (text: string) => {
      const item = lastAnswerItemRef.current;
      const place = item ? extractCorrectionPlace(text) : null;
      if (!item || !place) return;
      try {
        await engine.updateItemDetails(item.id, place);
        setNoteItems((prev) => {
          const copy = { ...prev };
          if (item.note_id && copy[item.note_id]) {
            copy[item.note_id] = copy[item.note_id].map((p) =>
              p.id === item.id ? { ...p, details: place } : p,
            );
          }
          return copy;
        });
        const updated = { ...item, details: place };
        setLastAnswer(updated);
        setAnswer({
          text: `✅ تم التحديث: ${item.title} صار ${place}`,
          sources: [],
          demo: true,
        });
      } catch (e) {
        console.warn('correction failed', e);
      }
    },
    [setLastAnswer],
  );

  /** Route unified input: question → answer, correction → update, else note. */
  const routeInput = useCallback(
    (text: string): 'question' | 'correction' | 'note' => {
      if (isQuestion(text)) return 'question';
      if (lastAnswerItemRef.current && isCorrection(text)) return 'correction';
      return 'note';
    },
    [],
  );

  // boot: sign in → spaces → notes
  useEffect(() => {
    (async () => {
      try {
        const user = await ensureSignedIn();
        setUserId(user.id);
        const list = await engine.ensureDefaultSpaces(user.id);
        setSpaces(list);
        const first = list[0] ?? null;
        setActiveSpace(first);
        setTextTargetSpaceId(first?.id ?? null);
        if (first) {
          await refreshNotes(first.id);
          await refreshItems(first.id);
        }
      } catch (e) {
        console.warn('boot failed', e);
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      Object.values(pollers.current).forEach(clearInterval);
    };
  }, [refreshNotes, refreshItems]);

  // debounced search
  useEffect(() => {
    const q = query.trim();
    const t = setTimeout(async () => {
      if (!q || !activeSpace) {
        setSearchResults(null);
        return;
      }
      setSearching(true);
      try {
        setSearchResults(await engine.search(activeSpace.id, q));
      } catch (e) {
        console.warn('search failed', e);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [query, activeSpace]);

  const pollUntilReady = useCallback(
    (noteId: string, spaceId: string, spaceType: SpaceType) => {
      const timer = setInterval(async () => {
        try {
          const n = await engine.getNote(noteId);
          setNotes((prev) => prev.map((p) => (p.id === n.id ? n : p)));
          if (n.status === 'ready' || n.status === 'failed') {
            clearInterval(timer);
            delete pollers.current[noteId];
            if (n.status === 'ready' && n.transcript?.trim()) {
              const t = n.transcript.trim();
              const route = routeInput(t);
              if (route !== 'note') {
                // questions & corrections are not notes — remove the row
                try {
                  await engine.deleteNote(n.id);
                } catch {
                  /* best effort */
                }
                setNotes((prev) => prev.filter((p) => p.id !== n.id));
                if (route === 'question') doAsk(t);
                else doCorrect(t);
                return;
              }
              const sug = suggestSpaceType(t);
              if (sug !== spaceType) {
                setSpaceSuggestions((prev) => ({ ...prev, [n.id]: sug }));
              }
            }
            refreshItems(spaceId);
            setTimeout(() => refreshItems(spaceId), 8000);
          }
        } catch (e) {
          console.warn('poll failed', e);
        }
      }, 3000);
      pollers.current[noteId] = timer;
      setTimeout(() => {
        if (pollers.current[noteId]) {
          clearInterval(timer);
          delete pollers.current[noteId];
          refreshNotes(spaceId);
          refreshItems(spaceId);
        }
      }, 180_000);
    },
    [refreshNotes, refreshItems, routeInput, doAsk, doCorrect],
  );

  const onRecordPress = useCallback(async () => {
    if (isRecording) {
      const audio = await stop();
      if (!audio || !activeSpace || !userId) return;
      setSaving(true);
      try {
        const note = await engine.saveVoiceNote(activeSpace.id, audio, userId);
        setNotes((prev) => [note, ...prev]);
        pollUntilReady(note.id, activeSpace.id, activeSpace.type);
      } catch (e) {
        console.warn('saveVoiceNote failed', e);
      } finally {
        setSaving(false);
      }
    } else {
      await start();
    }
  }, [isRecording, stop, start, activeSpace, userId, pollUntilReady]);

  const onSaveText = useCallback(async () => {
    const clean = textNote.trim();
    const targetId = textTargetSpaceId ?? activeSpace?.id;
    if (!clean || !targetId || !userId) return;
    // unified input: questions get answered, corrections update, rest is a note
    const route = routeInput(clean);
    if (route === 'question') {
      setTextNote('');
      doAsk(clean);
      return;
    }
    if (route === 'correction') {
      setTextNote('');
      doCorrect(clean);
      return;
    }
    setSavingText(true);
    try {
      const note = await engine.saveTextNote(targetId, clean, userId);
      if (targetId === activeSpace?.id) {
        setNotes((prev) => [note, ...prev]);
      }
      setTextNote('');
      setTimeout(() => refreshItems(targetId), 6000);
    } catch (e) {
      console.warn('saveTextNote failed', e);
    } finally {
      setSavingText(false);
    }
  }, [textNote, textTargetSpaceId, activeSpace, userId, refreshItems, routeInput, doAsk, doCorrect]);

  const onSeedDemo = useCallback(async () => {
    if (!userId) return;
    try {
      const ids = await engine.seedDemoData(userId, spaces);
      setDemoNoteIds(ids);
      if (activeSpace) {
        await refreshNotes(activeSpace.id);
        await refreshItems(activeSpace.id);
      }
    } catch (e) {
      console.warn('seedDemoData failed', e);
    }
  }, [userId, spaces, activeSpace, refreshNotes, refreshItems]);

  const onClearDemo = useCallback(async () => {
    for (const id of demoNoteIds) {
      try {
        await engine.deleteNote(id);
      } catch (e) {
        console.warn('deleteNote failed', e);
      }
    }
    setDemoNoteIds([]);
    if (activeSpace) {
      await refreshNotes(activeSpace.id);
      await refreshItems(activeSpace.id);
    }
  }, [demoNoteIds, activeSpace, refreshNotes, refreshItems]);

  const switchSpace = useCallback(
    (s: Space) => {
      setActiveSpace(s);
      setTextTargetSpaceId(s.id);
      setMovePickerFor(null);
      setQuery('');
      refreshNotes(s.id);
      refreshItems(s.id);
    },
    [refreshNotes, refreshItems],
  );

  const dismissAnswer = useCallback(() => {
    setAnswer(null);
    setLastAnswer(null);
  }, [setLastAnswer]);

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const typedSuggestion: SpaceType | null = textNote.trim()
    ? suggestSpaceType(textNote)
    : null;

  const renderNote = ({ item }: { item: Note }) => {
    const items = noteItems[item.id] ?? [];
    const sug = spaceSuggestions[item.id];
    const showSug = sug && !dismissedSug[item.id];
    return (
      <Pressable
        onLongPress={() => setMovePickerFor(movePickerFor === item.id ? null : item.id)}
        delayLongPress={400}
      >
        <View style={styles.card}>
          <View style={styles.cardTop}>
            <Text style={styles.cardMeta}>
              {new Date(item.created_at).toLocaleString()}
              {item.duration_sec ? ` · ${fmtTime(item.duration_sec)}` : ''}
            </Text>
            <Pressable
              onPress={() => setMovePickerFor(movePickerFor === item.id ? null : item.id)}
              style={styles.moveBtn}
            >
              <Text style={styles.moveBtnText}>
                {movingId === item.id ? '…' : '⇄ نقل'}
              </Text>
            </Pressable>
          </View>

          {movePickerFor === item.id && (
            <View style={styles.moveRow}>
              <Text style={styles.moveLabel}>انقل إلى:</Text>
              {spaces
                .filter((s) => s.id !== item.space_id)
                .map((s) => (
                  <Pressable
                    key={s.id}
                    disabled={movingId === item.id}
                    onPress={() => doMove(item, s.id)}
                    style={styles.moveTarget}
                  >
                    <Text style={styles.moveTargetText}>
                      {SPACE_LABELS[s.type] ?? s.name}
                    </Text>
                  </Pressable>
                ))}
            </View>
          )}

          {showSug && (
            <View style={styles.sugBanner}>
              <Text style={styles.sugText}>
                💡 هاي بتناسب مساحة {SPACE_LABELS[sug]}
              </Text>
              <View style={styles.sugBtns}>
                <Pressable
                  onPress={() => doMove(item, spaceIdByType(sug))}
                  style={styles.sugGo}
                >
                  <Text style={styles.sugGoText}>نقل</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    setDismissedSug((prev) => ({ ...prev, [item.id]: true }))
                  }
                >
                  <Text style={styles.sugNo}>✕</Text>
                </Pressable>
              </View>
            </View>
          )}

          <Text style={styles.cardText}>{statusLabel(item)}</Text>
          {items.map((it) => (
            <Pressable key={it.id} onPress={() => toggleItem(it)} style={styles.itemRow}>
              <Text style={styles.itemIcon}>
                {it.kind === 'task'
                  ? it.status === 'done'
                    ? '✅'
                    : '⬜'
                  : (KIND_ICON[it.kind] ?? '•')}
              </Text>
              <View style={styles.itemBody}>
                <Text
                  style={[styles.itemTitle, it.status === 'done' && styles.itemDone]}
                >
                  {it.title}
                </Text>
                {it.details ? (
                  <Text style={styles.itemDetails}>{it.details}</Text>
                ) : null}
                {it.due_at && (
                  <Text style={styles.itemDue}>
                    📅 {new Date(it.due_at).toLocaleString()}
                  </Text>
                )}
              </View>
            </Pressable>
          ))}
        </View>
      </Pressable>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#B3541E" />
        <Text style={styles.muted}>loading Mawjood…</Text>
      </SafeAreaView>
    );
  }

  const inSearch = query.trim().length > 0;
  const listData = inSearch ? (searchResults?.notes ?? []) : notes;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Mawjood — موجود</Text>
          <Text style={styles.subtitle}>Lost it? Mawjood.</Text>
        </View>
        <Pressable onPress={() => setShowDemo((v) => !v)} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>🧪</Text>
        </Pressable>
      </View>

      {showDemo && (
        <View style={styles.demoPanel}>
          <Text style={styles.demoTitle}>بيانات تجريبية — للتجربة بدون OpenAI</Text>
          <View style={styles.demoRow}>
            <Pressable onPress={onSeedDemo} style={styles.demoAction}>
              <Text style={styles.demoActionText}>➕ إضافة بيانات تجريبية</Text>
            </Pressable>
            {demoNoteIds.length > 0 && (
              <Pressable onPress={onClearDemo} style={[styles.demoAction, styles.demoDanger]}>
                <Text style={styles.demoActionText}>🗑️ مسح التجربة ({demoNoteIds.length})</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      <View style={styles.tabs}>
        {spaces.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => switchSpace(s)}
            style={[styles.tab, activeSpace?.id === s.id && styles.tabActive]}
          >
            <Text style={[styles.tabText, activeSpace?.id === s.id && styles.tabTextActive]}>
              {SPACE_LABELS[s.type] ?? s.name}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="🔍 ابحث في الملاحظات والعناصر…"
          placeholderTextColor="#A09485"
          style={styles.searchInput}
        />
        {searching && <ActivityIndicator size="small" color="#B3541E" />}
      </View>

      {asking && (
        <View style={styles.thinking}>
          <ActivityIndicator size="small" color="#1E5A8A" />
          <Text style={styles.thinkingText}>عم دوّر بذاكرتك…</Text>
        </View>
      )}

      {answer && !asking && (
        <View style={styles.answerCard}>
          <View style={styles.answerTop}>
            <Text style={styles.answerLabel}>
              {answer.demo ? '🧪 إجابة تجريبية' : '🤖 إجابة'}
            </Text>
            <Pressable onPress={dismissAnswer}>
              <Text style={styles.sugNo}>✕</Text>
            </Pressable>
          </View>
          <Text style={styles.answerText}>{answer.text}</Text>
          {answer.sources.length > 0 && (
            <View style={styles.sourcesWrap}>
              <Text style={styles.sourcesLabel}>📎 المصدر:</Text>
              {answer.sources
                .filter((s) => s.snippet)
                .map((s, i) => (
                  <Text key={`${s.note_id}-${i}`} style={styles.sourceSnippet}>
                    “{s.snippet}”
                  </Text>
                ))}
            </View>
          )}
          {lastAnswerItem && (
            <Text style={styles.correctHint}>
              💡 تغيّر المكان؟ احكيلي: نقلته على …
            </Text>
          )}
        </View>
      )}

      <FlatList
        data={listData}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.muted}>
            {inSearch ? 'لا نتائج — جرّب كلمة ثانية.' : 'No notes yet — tap 🎙️ and tell me something.'}
          </Text>
        }
        ListHeaderComponent={
          inSearch && searchResults && searchResults.items.length > 0 ? (
            <View style={styles.searchItems}>
              <Text style={styles.searchItemsLabel}>
                العناصر ({searchResults.items.length}):
              </Text>
              {searchResults.items.map((it) => (
                <Pressable key={it.id} onPress={() => toggleItem(it)} style={styles.searchItemRow}>
                  <Text style={styles.itemIcon}>{KIND_ICON[it.kind] ?? '•'}</Text>
                  <Text style={[styles.itemTitle, it.status === 'done' && styles.itemDone]}>
                    {it.title}
                    {it.details ? ` — ${it.details}` : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null
        }
        renderItem={renderNote}
      />

      <View style={styles.footer}>
        <View style={styles.modeToggle}>
          <Pressable
            onPress={() => setInputMode('voice')}
            style={[styles.modeBtn, inputMode === 'voice' && styles.modeBtnActive]}
          >
            <Text style={[styles.modeText, inputMode === 'voice' && styles.modeTextActive]}>
              🎙️ صوت
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setInputMode('text')}
            style={[styles.modeBtn, inputMode === 'text' && styles.modeBtnActive]}
          >
            <Text style={[styles.modeText, inputMode === 'text' && styles.modeTextActive]}>
              ⌨️ نص
            </Text>
          </Pressable>
        </View>

        {inputMode === 'voice' ? (
          <>
            {isRecording && <Text style={styles.timer}>🔴 {fmtTime(duration)}</Text>}
            <Pressable
              onPress={onRecordPress}
              disabled={saving || !activeSpace}
              style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
            >
              {saving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.recordText}>{isRecording ? '⏹' : '🎙️'}</Text>
              )}
            </Pressable>
            <Text style={styles.muted}>
              {isRecording
                ? 'tap to stop & save'
                : 'احكي ملاحظة — أو اسأل: وين جواز السفر؟'}
            </Text>
          </>
        ) : (
          <View style={styles.textBox}>
            <TextInput
              multiline
              value={textNote}
              onChangeText={setTextNote}
              placeholder="اكتب ملاحظة… أو اسأل: وين حطيت الجواز؟"
              placeholderTextColor="#A09485"
              style={styles.textInput}
              onSubmitEditing={onSaveText}
            />
            <Text style={styles.chipLabel}>الحفظ في:</Text>
            <View style={styles.chips}>
              {spaces.map((s) => {
                const isTarget = (textTargetSpaceId ?? activeSpace?.id) === s.id;
                const isSug = typedSuggestion === s.type && textNote.trim().length > 0;
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => setTextTargetSpaceId(s.id)}
                    style={[styles.chip, isTarget && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, isTarget && styles.chipTextActive]}>
                      {isSug ? '💡 ' : ''}{SPACE_LABELS[s.type] ?? s.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {typedSuggestion && activeSpace && typedSuggestion !== activeSpace.type && (
              <Text style={styles.sugHint}>
                💡 الاقتراح التلقائي: مساحة {SPACE_LABELS[typedSuggestion]} — اضغط عليها للتأكيد
              </Text>
            )}
            <Pressable
              onPress={onSaveText}
              disabled={!textNote.trim() || savingText}
              style={[styles.saveBtn, (!textNote.trim() || savingText) && styles.saveBtnDisabled]}
            >
              {savingText ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.saveBtnText}>إرسال</Text>
              )}
            </Pressable>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { fontSize: 26, fontWeight: '800', color: '#2B2118' },
  subtitle: { fontSize: 14, color: '#8A7B6C', marginTop: 2 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#EFE7DC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: { fontSize: 20 },
  demoPanel: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    backgroundColor: '#FFF8E7',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#EAD9A8',
  },
  demoTitle: { fontSize: 13, fontWeight: '700', color: '#7A5C14', marginBottom: 8 },
  demoRow: { flexDirection: 'row', gap: 8 },
  demoAction: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#B3541E',
  },
  demoDanger: { backgroundColor: '#8A8A8A' },
  demoActionText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  tabs: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 8 },
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: '#EFE7DC',
  },
  tabActive: { backgroundColor: '#2B2118' },
  tabText: { fontSize: 14, fontWeight: '600', color: '#5C4F42' },
  tabTextActive: { color: '#FAF7F2' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 14,
    color: '#2B2118',
    borderWidth: 1,
    borderColor: '#EADFCF',
  },
  searchItems: {
    backgroundColor: '#FFF8E7',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#EAD9A8',
  },
  searchItemsLabel: { fontSize: 13, fontWeight: '700', color: '#7A5C14', marginBottom: 6 },
  searchItemRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    backgroundColor: '#E8F4FF',
    borderRadius: 10,
  },
  thinkingText: { fontSize: 13, color: '#1E5A8A', fontWeight: '600' },
  answerCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#BFDDF5',
    gap: 8,
  },
  answerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  answerLabel: { fontSize: 12, fontWeight: '700', color: '#1E5A8A' },
  answerText: { fontSize: 16, color: '#2B2118', lineHeight: 24 },
  sourcesWrap: { marginTop: 4, gap: 6 },
  sourcesLabel: { fontSize: 13, fontWeight: '700', color: '#5C4F42' },
  sourceSnippet: {
    fontSize: 13,
    color: '#8A7B6C',
    fontStyle: 'italic',
    backgroundColor: '#FAF7F2',
    borderRadius: 8,
    padding: 8,
  },
  correctHint: { fontSize: 13, color: '#1E5A8A', fontWeight: '600' },
  list: { paddingHorizontal: 16, paddingBottom: 16, gap: 10 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  moveBtn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#EFE7DC',
  },
  moveBtnText: { fontSize: 12, fontWeight: '700', color: '#5C4F42' },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 8,
    padding: 8,
    backgroundColor: '#FAF7F2',
    borderRadius: 10,
  },
  moveLabel: { fontSize: 13, fontWeight: '700', color: '#5C4F42' },
  moveTarget: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: '#2B2118',
  },
  moveTargetText: { fontSize: 13, fontWeight: '700', color: '#FAF7F2' },
  sugBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 8,
    padding: 10,
    backgroundColor: '#E8F4FF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BFDDF5',
  },
  sugText: { fontSize: 13, fontWeight: '600', color: '#1E5A8A', flex: 1 },
  sugBtns: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sugGo: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#1E5A8A',
  },
  sugGoText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  sugNo: { fontSize: 16, color: '#8A7B6C', paddingHorizontal: 4 },
  cardText: { fontSize: 15, color: '#2B2118', lineHeight: 22 },
  cardMeta: { fontSize: 12, color: '#A09485' },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#F1EAE0',
  },
  itemIcon: { fontSize: 15, marginTop: 1 },
  itemBody: { flex: 1 },
  itemTitle: { fontSize: 14, fontWeight: '600', color: '#2B2118', lineHeight: 20 },
  itemDetails: { fontSize: 13, color: '#8A7B6C', marginTop: 2 },
  itemDone: { textDecorationLine: 'line-through', color: '#A09485' },
  itemDue: { fontSize: 12, color: '#B3541E', marginTop: 2 },
  footer: { alignItems: 'center', paddingBottom: 20, paddingTop: 8, gap: 8, paddingHorizontal: 16 },
  timer: { fontSize: 16, fontWeight: '700', color: '#B3541E' },
  recordBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#B3541E',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#B3541E',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 4,
  },
  recordBtnActive: { backgroundColor: '#7A3A14' },
  recordText: { fontSize: 32 },
  muted: { fontSize: 13, color: '#A09485' },
  modeToggle: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  modeBtn: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: '#EFE7DC',
  },
  modeBtnActive: { backgroundColor: '#2B2118' },
  modeText: { fontSize: 14, fontWeight: '700', color: '#5C4F42' },
  modeTextActive: { color: '#FAF7F2' },
  textBox: { width: '100%', gap: 8 },
  textInput: {
    minHeight: 90,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    fontSize: 15,
    color: '#2B2118',
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: '#EADFCF',
  },
  chipLabel: { fontSize: 13, fontWeight: '700', color: '#5C4F42' },
  chips: { flexDirection: 'row', gap: 8 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: '#EFE7DC',
  },
  chipActive: { backgroundColor: '#2B2118' },
  chipText: { fontSize: 14, fontWeight: '600', color: '#5C4F42' },
  chipTextActive: { color: '#FAF7F2' },
  sugHint: { fontSize: 13, color: '#1E5A8A', fontWeight: '600' },
  saveBtn: {
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: '#B3541E',
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
