import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { VoiceEngine } from '@mawjood/voice-engine';
import type { Item, Note, Space } from '@mawjood/voice-engine';
import { ensureSignedIn, supabase } from '../lib/supabase';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';

const engine = new VoiceEngine(supabase);

const KIND_ICON: Record<string, string> = {
  task: '⬜',
  appointment: '📅',
  shopping: '🛒',
  place: '📍',
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
    // optimistic update
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
  }, [refreshNotes]);

  const pollUntilReady = useCallback(
    (noteId: string, spaceId: string) => {
      const timer = setInterval(async () => {
        try {
          const n = await engine.getNote(noteId);
          setNotes((prev) => prev.map((p) => (p.id === n.id ? n : p)));
          if (n.status === 'ready' || n.status === 'failed') {
            clearInterval(timer);
            delete pollers.current[noteId];
            // extracted items land shortly after the transcript
            refreshItems(spaceId);
            setTimeout(() => refreshItems(spaceId), 8000);
          }
        } catch (e) {
          console.warn('poll failed', e);
        }
      }, 3000);
      pollers.current[noteId] = timer;
      // safety timeout: 3 minutes
      setTimeout(() => {
        if (pollers.current[noteId]) {
          clearInterval(pollers.current[noteId]);
          delete pollers.current[noteId];
          refreshNotes(spaceId);
          refreshItems(spaceId);
        }
      }, 180_000);
    },
    [refreshNotes, refreshItems],
  );

  const onRecordPress = useCallback(async () => {
    if (isRecording) {
      const audio = await stop();
      if (!audio || !activeSpace || !userId) return;
      setSaving(true);
      try {
        const note = await engine.saveVoiceNote(activeSpace.id, audio, userId);
        setNotes((prev) => [note, ...prev]);
        pollUntilReady(note.id, activeSpace.id);
      } catch (e) {
        console.warn('saveVoiceNote failed', e);
      } finally {
        setSaving(false);
      }
    } else {
      await start();
    }
  }, [isRecording, stop, start, activeSpace, userId, pollUntilReady]);

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#B3541E" />
        <Text style={styles.muted}>loading Mawjood…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Mawjood — موجود</Text>
        <Text style={styles.subtitle}>Lost it? Mawjood.</Text>
      </View>

      <View style={styles.tabs}>
        {spaces.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => {
              setActiveSpace(s);
              refreshNotes(s.id);
              refreshItems(s.id);
            }}
            style={[styles.tab, activeSpace?.id === s.id && styles.tabActive]}
          >
            <Text style={[styles.tabText, activeSpace?.id === s.id && styles.tabTextActive]}>
              {SPACE_LABELS[s.type] ?? s.name}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={notes}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.muted}>No notes yet — tap 🎙️ and tell me something.</Text>
        }
        renderItem={({ item }) => {
          const items = noteItems[item.id] ?? [];
          return (
            <View style={styles.card}>
              <Text style={styles.cardText}>{statusLabel(item)}</Text>
              {items.map((it) => (
                <Pressable key={it.id} onPress={() => toggleItem(it)} style={styles.itemRow}>
                  <Text style={styles.itemIcon}>
                    {it.kind === 'task' ? (it.status === 'done' ? '✅' : '⬜') : (KIND_ICON[it.kind] ?? '•')}
                  </Text>
                  <View style={styles.itemBody}>
                    <Text
                      style={[
                        styles.itemTitle,
                        it.status === 'done' && styles.itemDone,
                      ]}
                    >
                      {it.title}
                    </Text>
                    {it.due_at && (
                      <Text style={styles.itemDue}>
                        📅 {new Date(it.due_at).toLocaleString()}
                      </Text>
                    )}
                  </View>
                </Pressable>
              ))}
              <Text style={styles.cardMeta}>
                {new Date(item.created_at).toLocaleString()}
                {item.duration_sec ? ` · ${fmtTime(item.duration_sec)}` : ''}
              </Text>
            </View>
          );
        }}
      />

      <View style={styles.footer}>
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
          {isRecording ? 'tap to stop & save' : 'tap to record a voice note'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  title: { fontSize: 26, fontWeight: '800', color: '#2B2118' },
  subtitle: { fontSize: 14, color: '#8A7B6C', marginTop: 2 },
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
  cardText: { fontSize: 15, color: '#2B2118', lineHeight: 22 },
  cardMeta: { fontSize: 12, color: '#A09485', marginTop: 6 },
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
  itemDone: { textDecorationLine: 'line-through', color: '#A09485' },
  itemDue: { fontSize: 12, color: '#B3541E', marginTop: 2 },
  footer: { alignItems: 'center', paddingBottom: 20, paddingTop: 8, gap: 8 },
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
});
