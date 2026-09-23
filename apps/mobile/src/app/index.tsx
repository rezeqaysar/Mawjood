import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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

const SPACE_SHORT: Record<SpaceType, string> = {
  private: '🔒',
  family: '👨‍👩‍👧',
  work: '💼',
};

type AppView = 'chat' | SpaceType;

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

interface ChatMsg {
  id: string;
  role: 'user' | 'app';
  text: string;
  pending?: boolean; // spinner bubble
  sources?: { note_id: string; snippet: string }[];
  moveSuggest?: { noteId: string; toType: SpaceType }; // "نقل إلى مساحة؟" actions
}

export default function HomeScreen() {
  const [userId, setUserId] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const pollers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const { isRecording, duration, start, stop } = useVoiceRecorder();

  // ── views: chat home vs space browsing ──
  const [view, setView] = useState<AppView>('chat');
  const [viewSpace, setViewSpace] = useState<Space | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteItems, setNoteItems] = useState<Record<string, Item[]>>({});

  // ── chat state (in-memory only — cleared when the app is backgrounded) ──
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');
  const [textNote, setTextNote] = useState('');
  const [chatTarget, setChatTarget] = useState<SpaceType>('private');
  const [savingText, setSavingText] = useState(false);
  const [asking, setAsking] = useState(false);
  const lastAnswerItemRef = useRef<Item | null>(null);

  // ── space browsing state ──
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ notes: Note[]; items: Item[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [movePickerFor, setMovePickerFor] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [showDemo, setShowDemo] = useState(false);
  const [demoNoteIds, setDemoNoteIds] = useState<string[]>([]);

  const setLastAnswer = useCallback((item: Item | null) => {
    lastAnswerItemRef.current = item;
  }, []);

  const pushMsg = useCallback((role: 'user' | 'app', text: string, extra?: Partial<ChatMsg>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setMessages((prev) => [...prev, { id, role, text, ...extra }]);
    return id;
  }, []);

  // chat auto-scrolls to the newest message like any chat app
  const chatListRef = useRef<FlatList<ChatMsg>>(null);
  const scrollChatToEnd = useCallback((animated = true) => {
    chatListRef.current?.scrollToEnd({ animated });
  }, []);
  // backup trigger: scroll after each new message lands (web timing)
  useEffect(() => {
    if (messages.length === 0) return;
    const t = setTimeout(() => scrollChatToEnd(true), 120);
    return () => clearTimeout(t);
  }, [messages, scrollChatToEnd]);

  const updateMsg = useCallback((id: string, patch: Partial<ChatMsg>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const spaceIdByType = useCallback(
    (t: SpaceType) => spaces.find((s) => s.type === t)?.id ?? null,
    [spaces],
  );

  // ── data helpers ──
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
    } catch (e) {
      console.warn('moveNote failed', e);
    } finally {
      setMovingId(null);
    }
  }, []);

  // ── unified Q&A over one space (or all when null) ──
  const doAsk = useCallback(
    async (q: string, spaceId: string | null) => {
      if (!q.trim()) return;
      setAsking(true);
      const thinkId = pushMsg('app', '…', { pending: true });
      const done = (text: string, sources: ChatMsg['sources'], item: Item | null, demo: boolean) => {
        updateMsg(thinkId, { text: demo ? `🧪 ${text}` : text, pending: false, sources });
        setLastAnswer(item);
        setAsking(false);
      };
      try {
        const r = await engine.ask(q, spaceId);
        done(r.answer, r.sources, null, false);
      } catch (e) {
        console.warn('ask fn failed, using local fallback', e);
        try {
          const allNotes: Note[] = [];
          const allItems: Item[] = [];
          const targets = spaceId
            ? [{ id: spaceId }]
            : spaces.map((s) => ({ id: s.id }));
          for (const t of targets) {
            const [n, i] = await Promise.all([
              engine.listNotes(t.id, 30),
              engine.listItems(t.id, 60),
            ]);
            allNotes.push(...n);
            allItems.push(...i);
          }
          const local = answerLocally(q, allNotes, allItems);
          if (local) done(local.answer, local.sources, local.item ?? null, true);
          else done('ما لقيت إجابة بملاحظاتك.', [], null, true);
        } catch {
          done('تعذّر السؤال — جرّب لاحقاً.', [], null, true);
        }
      }
    },
    [spaces, pushMsg, updateMsg, setLastAnswer],
  );

  /** Conversational correction: "لا، نقلته على الخزانة" → update the item. */
  const doCorrect = useCallback(
    async (text: string) => {
      const item = lastAnswerItemRef.current;
      const place = item ? extractCorrectionPlace(text) : null;
      if (!item || !place) return;
      try {
        await engine.updateItemDetails(item.id, place);
        setLastAnswer({ ...item, details: place });
        pushMsg('app', `✅ تم التحديث: ${item.title} صار ${place}`);
      } catch (e) {
        console.warn('correction failed', e);
      }
    },
    [pushMsg, setLastAnswer],
  );

  const routeInput = useCallback((text: string): 'question' | 'correction' | 'note' => {
    if (isQuestion(text)) return 'question';
    if (lastAnswerItemRef.current && isCorrection(text)) return 'correction';
    return 'note';
  }, []);

  // ── boot ──
  useEffect(() => {
    (async () => {
      try {
        const user = await ensureSignedIn();
        setUserId(user.id);
        setSpaces(await engine.ensureDefaultSpaces(user.id));
      } catch (e) {
        console.warn('boot failed', e);
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      Object.values(pollers.current).forEach(clearInterval);
    };
  }, []);

  // chat clears when the user leaves the app — data stays on the server
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') {
        setMessages([]);
        setLastAnswer(null);
      }
    });
    return () => sub.remove();
  }, [setLastAnswer]);

  // debounced search (space view)
  useEffect(() => {
    const q = query.trim();
    const t = setTimeout(async () => {
      if (!q || !viewSpace) {
        setSearchResults(null);
        return;
      }
      setSearching(true);
      try {
        setSearchResults(await engine.search(viewSpace.id, q));
      } catch (e) {
        console.warn('search failed', e);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [query, viewSpace]);

  // ── chat: voice note polling ──
  const pollChatNote = useCallback(
    (noteId: string, spaceId: string, spaceType: SpaceType, msgId: string) => {
      const timer = setInterval(async () => {
        try {
          const n = await engine.getNote(noteId);
          if (n.status === 'ready' || n.status === 'failed') {
            clearInterval(timer);
            delete pollers.current[noteId];
            if (n.status === 'ready' && n.transcript?.trim()) {
              const t = n.transcript.trim();
              updateMsg(msgId, { text: t, pending: false });
              const route = routeInput(t);
              if (route === 'question') {
                try {
                  await engine.deleteNote(n.id);
                } catch { /* best effort */ }
                doAsk(t, null);
                return;
              }
              if (route === 'correction') {
                try {
                  await engine.deleteNote(n.id);
                } catch { /* best effort */ }
                doCorrect(t);
                return;
              }
              const sug = suggestSpaceType(t);
              if (sug !== spaceType) {
                updateMsg(msgId, {
                  moveSuggest: { noteId: n.id, toType: sug },
                });
              } else {
                pushMsg('app', `✅ انحفظت بمساحة ${SPACE_LABELS[spaceType]}`);
              }
            } else {
              updateMsg(msgId, { text: '⚠️ ما قدرت أفرّغ التسجيل', pending: false });
            }
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
          updateMsg(msgId, { text: '⏳ طول التفريغ — بتلاقيها بالمساحة', pending: false });
        }
      }, 180_000);
    },
    [routeInput, doAsk, doCorrect, pushMsg, updateMsg],
  );

  const onRecordPress = useCallback(async () => {
    if (isRecording) {
      const audio = await stop();
      const spaceId = spaceIdByType(chatTarget);
      if (!audio || !spaceId || !userId) return;
      const msgId = pushMsg('user', '🎙️ جاري التفريغ…', { pending: true });
      setSaving(true);
      try {
        const note = await engine.saveVoiceNote(spaceId, audio, userId);
        pollChatNote(note.id, spaceId, chatTarget, msgId);
      } catch (e) {
        console.warn('saveVoiceNote failed', e);
        updateMsg(msgId, { text: '⚠️ فشل التسجيل', pending: false });
      } finally {
        setSaving(false);
      }
    } else {
      await start();
    }
  }, [isRecording, stop, start, chatTarget, userId, spaceIdByType, pollChatNote, pushMsg, updateMsg]);

  // ── chat: text send ──
  const onSendText = useCallback(async () => {
    const clean = textNote.trim();
    const spaceId = spaceIdByType(chatTarget);
    if (!clean || !spaceId || !userId) return;
    const route = routeInput(clean);
    pushMsg('user', clean);
    setTextNote('');
    if (route === 'question') {
      doAsk(clean, null);
      return;
    }
    if (route === 'correction') {
      doCorrect(clean);
      return;
    }
    setSavingText(true);
    try {
      await engine.saveTextNote(spaceId, clean, userId);
      pushMsg('app', `✅ انحفظت بمساحة ${SPACE_LABELS[chatTarget]}`);
    } catch (e) {
      console.warn('saveTextNote failed', e);
      pushMsg('app', '⚠️ ما انحفظت — جرّب مرة ثانية');
    } finally {
      setSavingText(false);
    }
  }, [textNote, chatTarget, userId, spaceIdByType, routeInput, pushMsg, doAsk, doCorrect]);

  const onMoveSuggest = useCallback(
    async (msgId: string, noteId: string, toType: SpaceType, keep: boolean) => {
      updateMsg(msgId, { moveSuggest: undefined });
      if (keep) {
        pushMsg('app', '👍 تمام، بتضل محلها');
        return;
      }
      const targetId = spaceIdByType(toType);
      if (!targetId) return;
      try {
        await engine.moveNote(noteId, targetId);
        pushMsg('app', `✅ انتقلت إلى ${SPACE_LABELS[toType]}`);
      } catch (e) {
        console.warn('moveNote failed', e);
        pushMsg('app', '⚠️ ما قدرت أنقلها');
      }
    },
    [spaceIdByType, pushMsg, updateMsg],
  );

  // ── space browsing ──
  const openSpace = useCallback(
    (t: SpaceType) => {
      const s = spaces.find((x) => x.type === t) ?? null;
      setViewSpace(s);
      setView(t);
      setQuery('');
      if (s) {
        refreshNotes(s.id);
        refreshItems(s.id);
      }
    },
    [spaces, refreshNotes, refreshItems],
  );

  const onSeedDemo = useCallback(async () => {
    if (!userId) return;
    try {
      const ids = await engine.seedDemoData(userId, spaces);
      setDemoNoteIds(ids);
      if (view !== 'chat') openSpace(view);
    } catch (e) {
      console.warn('seedDemoData failed', e);
    }
  }, [userId, spaces, view, openSpace]);

  const onClearDemo = useCallback(async () => {
    for (const id of demoNoteIds) {
      try {
        await engine.deleteNote(id);
      } catch (e) {
        console.warn('deleteNote failed', e);
      }
    }
    setDemoNoteIds([]);
    if (view !== 'chat') openSpace(view);
  }, [demoNoteIds, view, openSpace]);

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const typedSuggestion: SpaceType | null = textNote.trim()
    ? suggestSpaceType(textNote)
    : null;

  // ── render: chat message ──
  const renderMsg = ({ item }: { item: ChatMsg }) => (
    <View style={[styles.bubble, item.role === 'user' ? styles.bubbleUser : styles.bubbleApp]}>
      {item.pending && item.text === '…' ? (
        <ActivityIndicator size="small" color="#1E5A8A" />
      ) : (
        <Text style={[styles.bubbleText, item.role === 'user' && styles.bubbleTextUser]}>
          {item.text}
        </Text>
      )}
      {item.pending && item.text !== '…' && (
        <ActivityIndicator size="small" color="#fff" style={styles.bubbleSpinner} />
      )}
      {item.sources && item.sources.length > 0 && (
        <View style={styles.msgSources}>
          {item.sources
            .filter((s) => s.snippet)
            .map((s, i) => (
              <Text key={`${s.note_id}-${i}`} style={styles.msgSource}>
                📎 “{s.snippet}”
              </Text>
            ))}
        </View>
      )}
      {item.moveSuggest && (
        <View style={styles.moveSuggest}>
          <Text style={styles.moveSuggestText}>
            💡 هاي بتناسب مساحة {SPACE_LABELS[item.moveSuggest.toType]} — أنقلها؟
          </Text>
          <View style={styles.moveSuggestBtns}>
            <Pressable
              onPress={() => onMoveSuggest(item.id, item.moveSuggest!.noteId, item.moveSuggest!.toType, false)}
              style={styles.sugGo}
            >
              <Text style={styles.sugGoText}>نقل</Text>
            </Pressable>
            <Pressable
              onPress={() => onMoveSuggest(item.id, item.moveSuggest!.noteId, item.moveSuggest!.toType, true)}
            >
              <Text style={styles.sugKeep}>إبقاء</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );

  // ── render: space note card ──
  const renderNote = ({ item }: { item: Note }) => {
    const items = noteItems[item.id] ?? [];
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

      {/* view tabs: chat home + spaces for browsing */}
      <View style={styles.tabs}>
        <Pressable
          onPress={() => setView('chat')}
          style={[styles.tab, view === 'chat' && styles.tabActive]}
        >
          <Text style={[styles.tabText, view === 'chat' && styles.tabTextActive]}>
            💬 الرئيسية
          </Text>
        </Pressable>
        {(Object.keys(SPACE_LABELS) as SpaceType[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => openSpace(t)}
            style={[styles.tab, view === t && styles.tabActive]}
          >
            <Text style={[styles.tabText, view === t && styles.tabTextActive]}>
              {SPACE_SHORT[t]}
            </Text>
          </Pressable>
        ))}
      </View>

      {view === 'chat' ? (
        <>
          <FlatList
            ref={chatListRef}
            style={styles.fill}
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.chatList}
            onContentSizeChange={() => scrollChatToEnd(true)}
            onLayout={() => scrollChatToEnd(false)}
            ListEmptyComponent={
              <View style={styles.emptyChat}>
                <Text style={styles.emptyIcon}>💭</Text>
                <Text style={styles.emptyTitle}>احكيلي شي…</Text>
                <Text style={styles.emptySub}>
                  “حطيت الجواز بالدرج”{'\n'}أو اسألني “وين حطيت الجواز؟”
                </Text>
              </View>
            }
            renderItem={renderMsg}
          />

          <View style={styles.chatFooter}>
            <View style={styles.targetRow}>
              <Text style={styles.targetLabel}>الحفظ في:</Text>
              {(Object.keys(SPACE_LABELS) as SpaceType[]).map((t) => {
                const isTarget = chatTarget === t;
                const isSug = typedSuggestion === t && textNote.trim().length > 0;
                return (
                  <Pressable
                    key={t}
                    onPress={() => setChatTarget(t)}
                    style={[styles.targetChip, isTarget && styles.targetChipActive]}
                  >
                    <Text style={[styles.targetChipText, isTarget && styles.targetChipTextActive]}>
                      {isSug ? '💡 ' : ''}{SPACE_SHORT[t]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.inputRow}>
              <Pressable
                onPress={() => setInputMode(inputMode === 'voice' ? 'text' : 'voice')}
                style={styles.modeBtn}
              >
                <Text style={styles.modeBtnText}>
                  {inputMode === 'voice' ? '⌨️' : '🎙️'}
                </Text>
              </Pressable>

              {inputMode === 'voice' ? (
                <Pressable
                  onPress={onRecordPress}
                  disabled={saving}
                  style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
                >
                  {saving ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.recordText}>{isRecording ? '⏹' : '🎙️'}</Text>
                  )}
                </Pressable>
              ) : (
                <>
                  <TextInput
                    value={textNote}
                    onChangeText={setTextNote}
                    placeholder="اكتب ملاحظة أو سؤال…"
                    placeholderTextColor="#A09485"
                    style={styles.chatInput}
                    onSubmitEditing={onSendText}
                    returnKeyType="send"
                  />
                  <Pressable
                    onPress={onSendText}
                    disabled={!textNote.trim() || savingText || asking}
                    style={[styles.sendBtn, (!textNote.trim() || savingText || asking) && styles.sendBtnDisabled]}
                  >
                    {savingText ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.sendBtnText}>➤</Text>
                    )}
                  </Pressable>
                </>
              )}
            </View>
            {isRecording && <Text style={styles.timer}>🔴 {fmtTime(duration)}</Text>}
          </View>
        </>
      ) : (
        <>
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

          <FlatList
            style={styles.fill}
            data={listData}
            keyExtractor={(n) => n.id}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <Text style={styles.muted}>
                {inSearch ? 'لا نتائج — جرّب كلمة ثانية.' : 'لا ملاحظات بعد — احكيلي شي من الرئيسية 💬'}
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
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
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
  // chat
  chatList: { paddingHorizontal: 16, paddingVertical: 8, gap: 10, flexGrow: 1 },
  emptyChat: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 8 },
  emptyIcon: { fontSize: 56 },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: '#2B2118' },
  emptySub: { fontSize: 14, color: '#A09485', textAlign: 'center', lineHeight: 22 },
  bubble: {
    maxWidth: '85%',
    borderRadius: 16,
    padding: 12,
    gap: 6,
  },
  bubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: '#1E5A8A',
    borderBottomRightRadius: 4,
  },
  bubbleApp: {
    alignSelf: 'flex-start',
    backgroundColor: '#fff',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: '#EADFCF',
  },
  bubbleText: { fontSize: 15, color: '#2B2118', lineHeight: 22 },
  bubbleTextUser: { color: '#fff' },
  bubbleSpinner: { marginTop: 4 },
  msgSources: { gap: 4, marginTop: 4 },
  msgSource: {
    fontSize: 12,
    color: '#8A7B6C',
    fontStyle: 'italic',
    backgroundColor: '#FAF7F2',
    borderRadius: 8,
    padding: 6,
  },
  moveSuggest: { gap: 8, marginTop: 4 },
  moveSuggestText: { fontSize: 13, fontWeight: '600', color: '#1E5A8A' },
  moveSuggestBtns: { flexDirection: 'row', gap: 8 },
  sugGo: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#1E5A8A',
  },
  sugGoText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  sugKeep: { fontSize: 13, fontWeight: '700', color: '#8A7B6C', paddingVertical: 6 },
  chatFooter: { paddingHorizontal: 16, paddingBottom: 20, paddingTop: 8, gap: 8 },
  targetRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  targetLabel: { fontSize: 12, fontWeight: '700', color: '#8A7B6C' },
  targetChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: '#EFE7DC',
  },
  targetChipActive: { backgroundColor: '#2B2118' },
  targetChipText: { fontSize: 14, color: '#5C4F42' },
  targetChipTextActive: { color: '#FAF7F2' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modeBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#EFE7DC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeBtnText: { fontSize: 22 },
  chatInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 24,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 15,
    color: '#2B2118',
    borderWidth: 1,
    borderColor: '#EADFCF',
  },
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#B3541E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: '#fff', fontSize: 20, fontWeight: '800' },
  recordBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#B3541E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordBtnActive: { backgroundColor: '#7A3A14' },
  recordText: { fontSize: 28 },
  timer: { fontSize: 14, fontWeight: '700', color: '#B3541E', textAlign: 'center' },
  // space browsing
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
  sugBtns: { flexDirection: 'row', alignItems: 'center', gap: 10 },
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
  muted: { fontSize: 13, color: '#A09485' },
});
