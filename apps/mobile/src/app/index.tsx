import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  FlatList,
  Modal,
  Platform,
  Pressable,
  Share,
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
  parseAssignment,
} from '@mawjood/voice-engine';
import type { Item, Note, Space, SpaceType } from '@mawjood/voice-engine';
import { supabase } from '../lib/supabase';
import { linkEmailToAnonymous, signOut } from '../lib/auth';
import { registerForPushNotifications } from '../lib/push';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import AuthScreen from '../components/AuthScreen';

const engine = new VoiceEngine(supabase);

const KIND_ICON: Record<string, string> = {
  task: '⬜',
  appointment: '📅',
  shopping: '🛒',
  place: '📍',
  spec: '📏',
  opinion: '💭',
  checklist: '🧳',
  thing: '📦',
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

  // ── Phase 3: family pillar ──
  const [familyTab, setFamilyTab] = useState<'shopping' | 'tasks' | 'agenda' | 'notes' | 'things'>('shopping');
  const [shopping, setShopping] = useState<Item[]>([]);
  const [tasks, setTasks] = useState<Item[]>([]);
  const [upcoming, setUpcoming] = useState<Item[]>([]);
  // ── Phase 4: 📦 أشيائي pillar (all spaces) ──
  const [things, setThings] = useState<Item[]>([]);
  const [spaceTab, setSpaceTab] = useState<'notes' | 'things'>('notes');
  const [newShopping, setNewShopping] = useState('');
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [assignName, setAssignName] = useState('');
  const itemsSub = useRef<(() => void) | null>(null);

  // ── Auth: real accounts + family invites ──
  const [authState, setAuthState] = useState<'loading' | 'signed-out' | 'signed-in'>('loading');
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [upgradeEmail, setUpgradeEmail] = useState('');
  const [upgradeSent, setUpgradeSent] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [memberCount, setMemberCount] = useState(1);
  // ── side menu (drawer) ──
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [memberSince, setMemberSince] = useState<string | null>(null);
  const [inviteSpaceId, setInviteSpaceId] = useState<string | null>(null);
  const [menuX] = useState(() => new Animated.Value(-320));

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

  const updateMsg = useCallback((id: string, patch: Partial<ChatMsg>) => {    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const removeMsg = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // pick the right space of a type: the shared (joined) family space wins
  // over your own, so a joined household sees one family space
  const pickSpace = useCallback(
    (t: SpaceType): Space | null => {
      const list = spaces.filter((x) => x.type === t);
      if (t === 'family' && userId) {
        list.sort((a, b) => (a.owner_id === userId ? 1 : 0) - (b.owner_id === userId ? 1 : 0));
      }
      return list[0] ?? null;
    },
    [spaces, userId],
  );

  const spaceIdByType = useCallback(
    (t: SpaceType) => pickSpace(t)?.id ?? null,
    [pickSpace],
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
    const next: Item['status'] = item.status === 'open' ? 'done' : 'open';
    const patch = (list: Item[]): Item[] =>
      list.map((p) => (p.id === item.id ? { ...p, status: next } : p));
    setShopping(patch);
    setTasks(patch);
    setUpcoming(patch);
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

  // ── Phase 3: family lists ──
  const refreshFamily = useCallback(async (spaceId: string) => {
    try {
      const [s, t, u] = await Promise.all([
        engine.listShopping(spaceId),
        engine.listTasks(spaceId),
        engine.listUpcoming(spaceId),
      ]);
      setShopping(s);
      setTasks(t);
      setUpcoming(u);
    } catch (e) {
      console.warn('refreshFamily failed', e);
    }
  }, []);

  // ── Phase 4: 📦 أشيائي ──
  const refreshThings = useCallback(async (spaceId: string) => {
    try {
      setThings(await engine.listThings(spaceId));
    } catch (e) {
      console.warn('listThings failed', e);
    }
  }, []);

  // ── family members ──
  const refreshMembers = useCallback(
    async (space: Space) => {
      try {
        const members = await engine.listMembers(space.id);
        const ids = new Set(members.map((m) => m.user_id));
        ids.add(space.owner_id);
        setMemberCount(ids.size);
      } catch {
        setMemberCount(1);
      }
    },
    [],
  );

  // ── side menu open/close (slides from the left) ──
  const openMenu = useCallback(() => {
    setMenuOpen(true);
    menuX.setValue(-320);
    Animated.timing(menuX, { toValue: 0, duration: 220, useNativeDriver: false }).start();
  }, [menuX]);

  const closeMenu = useCallback(() => {
    Animated.timing(menuX, { toValue: -320, duration: 200, useNativeDriver: false }).start(
      () => setMenuOpen(false),
    );
  }, [menuX]);

  // ── family invites ──
  // works from anywhere (drawer) or from the family tab
  const openInviteFor = useCallback(
    async (spaceId: string | null) => {
      if (!spaceId) return;
      closeMenu();
      setInviteSpaceId(spaceId);
      setInviteOpen(true);
      setInviteBusy(true);
      try {
        const inv = await engine.getOrCreateInvite(spaceId);
        setInviteCode(inv.code);
      } catch (e) {
        console.warn('invite failed', e);
        setInviteCode(null);
      } finally {
        setInviteBusy(false);
      }
    },
    [closeMenu],
  );

  const openInvite = useCallback(async () => {
    await openInviteFor(viewSpace?.type === 'family' ? viewSpace.id : null);
  }, [openInviteFor, viewSpace]);

  const regenerateInvite = useCallback(async () => {
    const spaceId = inviteSpaceId ?? (viewSpace?.type === 'family' ? viewSpace.id : null);
    if (!spaceId) return;
    setInviteBusy(true);
    try {
      await engine.revokeInvites(spaceId);
      const inv = await engine.getOrCreateInvite(spaceId);
      setInviteCode(inv.code);
    } catch (e) {
      console.warn('regenerate failed', e);
    } finally {
      setInviteBusy(false);
    }
  }, [inviteSpaceId, viewSpace]);

  const copyInviteCode = useCallback(async () => {
    if (!inviteCode) return;
    try {
      // web clipboard
      await navigator.clipboard.writeText(inviteCode);
    } catch {
      try {
        await Share.share({ message: `رمز دعوة العائلة في موجود: ${inviteCode}` });
      } catch {}
    }
  }, [inviteCode]);

  const shareInvite = useCallback(async () => {
    if (!inviteCode) return;
    const text = `انضم لمساحة العائلة في موجود بهذا الرمز: ${inviteCode}`;
    try {
      const nav = navigator as Navigator & { share?: (d: { text: string }) => Promise<void> };
      if (typeof nav.share === 'function') await nav.share({ text });
      else await Share.share({ message: text });
    } catch {}
  }, [inviteCode]);

  const doJoin = useCallback(async () => {
    const code = joinCode.trim();
    if (!code || joinBusy) return;
    setJoinBusy(true);
    setJoinError(null);
    try {
      const res = await engine.joinFamily(code);
      setJoinOpen(false);
      setJoinCode('');
      const fresh = await engine.listSpaces();
      setSpaces(fresh);
      const joined = fresh.find((s) => s.id === res.id) ?? null;
      if (joined) {
        setViewSpace(joined);
        setView('family');
        setQuery('');
        refreshMembers(joined);
        refreshNotes(joined.id);
        refreshItems(joined.id);
        refreshThings(joined.id);
        refreshFamily(joined.id);
      }
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : 'فشل الانضمام — جرّب مجدداً');
    } finally {
      setJoinBusy(false);
    }
  }, [joinCode, joinBusy, refreshMembers, refreshNotes, refreshItems, refreshThings, refreshFamily]);


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
  // ── AI input router needs conversation memory; defined before doAsk ──
  const chatHistory = useCallback(() => {
    return messages
      .filter((m) => !m.pending && m.text.trim() && m.text.trim() !== '…')
      .slice(-6)
      .map((m) => ({ role: m.role as 'user' | 'app', text: m.text }));
  }, [messages]);

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
        const r = await engine.ask(q, spaceId, chatHistory());
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
    [spaces, pushMsg, updateMsg, setLastAnswer, chatHistory],
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

  // ── AI input router (with conversation memory) ──
  // What ChatGPT does natively: every input is understood in context.
  // (chatHistory is defined above, before doAsk)

  const routeInput = useCallback(
    async (
      text: string,
    ): Promise<{ action: 'question' | 'correction' | 'note'; space_type: SpaceType }> => {
      const r = await engine.route(text, chatHistory());
      // correction only makes sense right after an answer about an item
      if (r.action === 'correction' && !lastAnswerItemRef.current)
        return { action: 'note', space_type: r.space_type };
      return r;
    },
    [chatHistory],
  );

  // ── boot / auth gate ──
  // No session → AuthScreen (email magic link). Anonymous sessions from the
  // trial keep working and can be upgraded to permanent (same user id).
  const boot = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session) {
        setAuthState('signed-out');
        return;
      }
      const user = session.user;
      setUserId(user.id);
      setIsAnonymous(!!user.is_anonymous);
      setUserEmail(user.email ?? null);
      setMemberSince(user.created_at ?? null);
      setSpaces(await engine.ensureDefaultSpaces(user.id));
      setAuthState('signed-in');
      // Phase 3: register this device for family push notifications (no-op on web)
      registerForPushNotifications().then((token) => {
        if (token) engine.registerPushToken(user.id, token, Platform.OS).catch(() => {});
      });
    } catch (e) {
      console.warn('boot failed', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleAuthEvent = useCallback(
    (event: string, session: { user: { id: string; is_anonymous?: boolean } } | null) => {
      if (event === 'SIGNED_OUT') {
        setUserId(null);
        setUserEmail(null);
        setMemberSince(null);
        setSpaces([]);
        setViewSpace(null);
        setView('chat');
        setIsAnonymous(false);
        setAuthState('signed-out');
      } else if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && session) {
        // magic-link return, or anonymous → permanent upgrade
        boot();
      }
    },
    [boot],
  );

  useEffect(() => {
    // async boundary: boot() sets state, keep it out of the sync effect body
    (async () => {
      await boot();
    })();
    const { data: sub } = supabase.auth.onAuthStateChange(handleAuthEvent);
    return () => {
      sub.subscription.unsubscribe();
      Object.values(pollers.current).forEach(clearInterval);
      itemsSub.current?.();
    };
  }, [boot, handleAuthEvent]);

  const doUpgrade = useCallback(async () => {
    const clean = upgradeEmail.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
      setUpgradeError('اكتب بريد صحيح');
      return;
    }
    setUpgradeBusy(true);
    setUpgradeError(null);
    try {
      await linkEmailToAnonymous(clean);
      setUpgradeSent(true);
    } catch (e) {
      setUpgradeError(e instanceof Error ? e.message : 'فشل — جرّب مجدداً');
    } finally {
      setUpgradeBusy(false);
    }
  }, [upgradeEmail]);

  const doSignOut = useCallback(async () => {
    try {
      await signOut();
    } catch (e) {
      console.warn('sign out failed', e);
    }
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

  /** "سارة: اشتري خبز" in the family space → creates an assigned task item. */
  const maybeAssignTask = useCallback(
    async (spaceType: SpaceType, text: string, spaceId: string, uid: string) => {
      if (spaceType !== 'family') return;
      const asg = parseAssignment(text);
      if (!asg) return;
      try {
        const it = await engine.createItem({
          spaceId,
          kind: 'task',
          title: asg.task,
          assignedTo: asg.name,
          userId: uid,
        });
        setTasks((prev) => [it, ...prev]);
        pushMsg('app', `✅ مهمة مسندة لـ${asg.name}: ${asg.task}`);
        engine
          .notifySpace(spaceId, '👨‍👩‍👧 مهمة عائلية', `${asg.name}: ${asg.task}`, uid)
          .catch(() => {});
      } catch (e) {
        console.warn('assign-task failed', e);
      }
    },
    [pushMsg],
  );

  // ── chat: voice note polling ──
  // ── legacy pipeline (route → ask/correct/save): fallback when the agent is unreachable ──
  const legacyVoice = useCallback(
    async (t: string, n: { id: string }, msgId: string) => {
      updateMsg(msgId, { text: t, pending: false });
      // AI router (with conversation memory) decides: answer it,
      // save it, or treat it as a correction — like ChatGPT would.
      const { action: route, space_type } = await routeInput(t);
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
      // ── THE AI CHOSE THE SPACE (inside route). The app never asks. ──
      // Notes land in private first (safest default); the router
      // moves them to family/work when the content says so.
      const finalType = space_type;
      const targetId = spaceIdByType(finalType);
      if (targetId) {
        try {
          await engine.moveNote(n.id, targetId);
        } catch (e) {
          console.warn('auto space move failed', e);
        }
        pushMsg('app', `✅ انحفظت بمساحة ${SPACE_LABELS[finalType]}`);
        if (userId) await maybeAssignTask(finalType, t, targetId, userId);
      } else {
        pushMsg('app', '✅ انحفظت');
      }
    },
    [routeInput, doAsk, doCorrect, pushMsg, updateMsg, maybeAssignTask, userId, spaceIdByType],
  );

  // ── THE AGENT BRAIN: one call understands + acts (with legacy fallback) ──
  const doChatVoice = useCallback(
    async (t: string, n: { id: string }, msgId: string) => {
      updateMsg(msgId, { text: t, pending: false });
      const thinkId = pushMsg('app', '…', { pending: true });
      const r = await engine.chat(t, chatHistory(), n.id);
      if (r) {
        updateMsg(thinkId, { text: r.answer, pending: false });
      } else {
        removeMsg(thinkId);
        await legacyVoice(t, n, msgId);
      }
    },
    [chatHistory, pushMsg, updateMsg, removeMsg, legacyVoice],
  );

  const pollChatNote = useCallback(
    (noteId: string, msgId: string) => {
      const timer = setInterval(async () => {
        try {
          const n = await engine.getNote(noteId);
          if (n.status === 'ready' || n.status === 'failed') {
            clearInterval(timer);
            delete pollers.current[noteId];
            if (n.status === 'ready' && n.transcript?.trim()) {
              const t = n.transcript.trim();
              await doChatVoice(t, n, msgId);
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
    [doChatVoice, updateMsg],
  );

  const onRecordPress = useCallback(async () => {
    if (isRecording) {
      const audio = await stop();
      // Notes always land in private first — the AI moves them after transcription.
      const spaceId = spaceIdByType('private');
      if (!audio || !spaceId || !userId) return;
      const msgId = pushMsg('user', '🎙️ جاري التفريغ…', { pending: true });
      setSaving(true);
      try {
        const note = await engine.saveVoiceNote(spaceId, audio, userId);
        pollChatNote(note.id, msgId);
      } catch (e) {
        console.warn('saveVoiceNote failed', e);
        updateMsg(msgId, { text: '⚠️ فشل التسجيل', pending: false });
      } finally {
        setSaving(false);
      }
    } else {
      await start();
    }
  }, [isRecording, stop, start, userId, spaceIdByType, pollChatNote, pushMsg, updateMsg]);

  // ── chat: text send ──
  // ── chat: text send — the agent brain first, legacy pipeline as fallback ──
  const legacyText = useCallback(
    async (clean: string) => {
      const spaceId = spaceIdByType('private');
      if (!spaceId || !userId) return;
      // AI router (with conversation memory) — same as voice notes.
      const { action: route, space_type } = await routeInput(clean);
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
        const note = await engine.saveTextNote(spaceId, clean, userId);
        // The AI chose the space inside route — no separate classify call.
        const finalType = space_type;
        const targetId = spaceIdByType(finalType);
        if (targetId) {
          try {
            await engine.moveNote(note.id, targetId);
          } catch (e) {
            console.warn('auto space move failed', e);
          }
          pushMsg('app', `✅ انحفظت بمساحة ${SPACE_LABELS[finalType]}`);
          await maybeAssignTask(finalType, clean, targetId, userId);
        } else {
          pushMsg('app', '✅ انحفظت');
        }
      } catch (e) {
        console.warn('saveTextNote failed', e);
        pushMsg('app', '⚠️ ما انحفظت — جرّب مرة ثانية');
      } finally {
        setSavingText(false);
      }
    },
    [userId, spaceIdByType, routeInput, pushMsg, doAsk, doCorrect, maybeAssignTask],
  );

  const onSendText = useCallback(async () => {
    const clean = textNote.trim();
    if (!clean || !userId) return;
    pushMsg('user', clean);
    setTextNote('');
    const thinkId = pushMsg('app', '…', { pending: true });
    const r = await engine.chat(clean, chatHistory());
    if (r) {
      updateMsg(thinkId, { text: r.answer, pending: false });
    } else {
      removeMsg(thinkId);
      await legacyText(clean);
    }
  }, [textNote, userId, pushMsg, updateMsg, removeMsg, chatHistory, legacyText]);

  // ── space browsing ──
  const openSpace = useCallback(
    (t: SpaceType) => {
      const s = pickSpace(t);
      itemsSub.current?.();
      itemsSub.current = null;
      setViewSpace(s);
      setView(t);
      setQuery('');
      setSpaceTab('notes');
      if (s) {
        refreshNotes(s.id);
        refreshItems(s.id);
        refreshThings(s.id);
        if (s.type === 'family') {
          refreshFamily(s.id);
          refreshMembers(s);
          // realtime: any family member's change refreshes everyone's lists
          itemsSub.current = engine.subscribeItems(s.id, () => {
            refreshFamily(s.id);
            refreshItems(s.id);
            refreshThings(s.id);
          });
        }
      }
    },
    [pickSpace, refreshNotes, refreshItems, refreshFamily, refreshThings, refreshMembers],
  );

  // ── Phase 3: shopping add + task assign ──
  const onAddShopping = useCallback(async () => {
    const title = newShopping.trim();
    const sid = viewSpace?.id;
    if (!title || !sid || !userId) return;
    setNewShopping('');
    try {
      const it = await engine.createItem({ spaceId: sid, kind: 'shopping', title, userId });
      setShopping((prev) => [it, ...prev]);
    } catch (e) {
      console.warn('createItem failed', e);
    }
  }, [newShopping, viewSpace, userId]);

  const onAssign = useCallback(
    async (item: Item) => {
      const name = assignName.trim();
      const sid = viewSpace?.id;
      if (!name || !sid || !userId) return;
      try {
        const updated = await engine.assignItem(item.id, name);
        setTasks((prev) => prev.map((p) => (p.id === item.id ? updated : p)));
        setAssignFor(null);
        setAssignName('');
        // notify the family (works once the notify edge fn is deployed)
        engine
          .notifySpace(sid, '👨‍👩‍👧 مهمة عائلية', `${name}: ${item.title}`, userId)
          .catch(() => {});
      } catch (e) {
        console.warn('assignItem failed', e);
      }
    },
    [assignName, viewSpace, userId],
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

  if (authState === 'signed-out') {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <AuthScreen />
      </SafeAreaView>
    );
  }

  const inSearch = query.trim().length > 0;
  const listData = inSearch ? (searchResults?.notes ?? []) : notes;

  // notes browser (shared by all spaces; family shows it under the 📝 tab)
  // ── Phase 4: 📦 أشيائي list (shared by all space views) ──
  const thingsList = (
    <FlatList
      style={styles.fill}
      data={things}
      keyExtractor={(i) => i.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <Text style={styles.muted}>لا أغراض بعد — احكيلي «اشتريت …» بالشات 📦</Text>
      }
      renderItem={({ item }) => (
        <View style={styles.famRow}>
          <Text style={styles.itemIcon}>📦</Text>
          <View style={styles.itemBody}>
            <Text style={styles.itemTitle}>{item.title}</Text>
            {item.details ? (
              <Text style={styles.itemDetails}>📍 {item.details}</Text>
            ) : null}
            {item.meta?.price ? (
              <Text style={styles.itemDue}>💰 {item.meta.price}</Text>
            ) : null}
          </View>
        </View>
      )}
    />
  );

  const notesBrowser = (
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
  );

  const FAMILY_TABS = [
    ['shopping', '🛒 تسوق'],
    ['tasks', '✅ مهام'],
    ['agenda', '📅 مواعيد'],
    ['things', '📦 أشيائي'],
    ['notes', '📝 ملاحظات'],
  ] as const;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Pressable onPress={openMenu} style={styles.iconBtn}>
            <Text style={styles.iconBtnText}>☰</Text>
          </Pressable>
          <View>
            <Text style={styles.title}>Mawjood — موجود</Text>
            <Text style={styles.subtitle}>Lost it? Mawjood.</Text>
          </View>
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

      {/* anonymous trial account → link an email to keep the data */}
      {isAnonymous && !upgradeSent && (
        <View style={styles.upgradeBanner}>
          <Text style={styles.upgradeText}>💾 حساب تجريبي — سجّل بريدك عشان بياناتك ما تضيع</Text>
          <View style={styles.upgradeRow}>
            <TextInput
              value={upgradeEmail}
              onChangeText={setUpgradeEmail}
              placeholder="you@example.com"
              placeholderTextColor="#A09485"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.upgradeInput}
              returnKeyType="send"
              onSubmitEditing={doUpgrade}
              textAlign="left"
            />
            <Pressable onPress={doUpgrade} disabled={upgradeBusy} style={styles.upgradeBtn}>
              {upgradeBusy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.upgradeBtnText}>حفظ</Text>
              )}
            </Pressable>
          </View>
          {upgradeError ? <Text style={styles.upgradeErr}>{upgradeError}</Text> : null}
        </View>
      )}
      {isAnonymous && upgradeSent && (
        <View style={styles.upgradeBanner}>
          <Text style={styles.upgradeText}>✉️ أرسلنا رابط التأكيد — اضغطه من بريدك وبيصير حسابك دائم</Text>
        </View>
      )}

      {/* ── side drawer menu ── */}
      {menuOpen && (
        <View style={styles.menuOverlay}>
          <Pressable style={styles.menuBackdrop} onPress={closeMenu} />
          <Animated.View style={[styles.menuPanel, { transform: [{ translateX: menuX }] }]}>
            <View style={styles.menuProfile}>
              <View style={styles.menuAvatar}>
                <Text style={styles.menuAvatarText}>
                  {userEmail ? userEmail[0].toUpperCase() : '👤'}
                </Text>
              </View>
              <View style={styles.menuProfileInfo}>
                <Text style={styles.menuEmail} numberOfLines={1}>
                  {userEmail ?? 'حساب تجريبي'}
                </Text>
                <Text style={styles.menuBadge}>
                  {isAnonymous ? '🧪 تجريبي' : '✅ حساب دائم'}
                </Text>
              </View>
            </View>

            <Pressable
              style={styles.menuItem}
              onPress={() => {
                closeMenu();
                setProfileOpen(true);
              }}
            >
              <Text style={styles.menuItemIcon}>👤</Text>
              <Text style={styles.menuItemText}>الملف الشخصي</Text>
            </Pressable>

            <Pressable
              style={styles.menuItem}
              onPress={() => openInviteFor(pickSpace('family')?.id ?? null)}
            >
              <Text style={styles.menuItemIcon}>✉️</Text>
              <Text style={styles.menuItemText}>دعوة العائلة</Text>
            </Pressable>

            <View style={styles.menuItem}>
              <Text style={styles.menuItemIcon}>💳</Text>
              <Text style={styles.menuItemText}>الاشتراك</Text>
              <Text style={styles.menuSoon}>قريباً</Text>
            </View>

            <Pressable
              style={styles.menuItem}
              onPress={() => {
                closeMenu();
                setAboutOpen(true);
              }}
            >
              <Text style={styles.menuItemIcon}>ℹ️</Text>
              <Text style={styles.menuItemText}>حول التطبيق</Text>
            </Pressable>

            {!isAnonymous && authState === 'signed-in' && (
              <Pressable
                style={[styles.menuItem, styles.menuLogout]}
                onPress={() => {
                  closeMenu();
                  doSignOut();
                }}
              >
                <Text style={styles.menuItemIcon}>🚪</Text>
                <Text style={[styles.menuItemText, styles.menuLogoutText]}>تسجيل الخروج</Text>
              </Pressable>
            )}
          </Animated.View>
        </View>
      )}

      {/* ── profile modal ── */}
      <Modal visible={profileOpen} transparent animationType="fade" onRequestClose={() => setProfileOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>👤 الملف الشخصي</Text>
            <View style={styles.profileRow}>
              <Text style={styles.profileLabel}>البريد</Text>
              <Text style={styles.profileValue}>{userEmail ?? '—'}</Text>
            </View>
            <View style={styles.profileRow}>
              <Text style={styles.profileLabel}>نوع الحساب</Text>
              <Text style={styles.profileValue}>{isAnonymous ? 'تجريبي' : 'دائم'}</Text>
            </View>
            {memberSince ? (
              <View style={styles.profileRow}>
                <Text style={styles.profileLabel}>عضو منذ</Text>
                <Text style={styles.profileValue}>
                  {new Date(memberSince).toLocaleDateString('ar')}
                </Text>
              </View>
            ) : null}
            <View style={styles.profileRow}>
              <Text style={styles.profileLabel}>المساحات</Text>
              <Text style={styles.profileValue}>
                {spaces.length > 0 ? `${spaces.length}` : '—'}
              </Text>
            </View>
            <Pressable onPress={() => setProfileOpen(false)} style={[styles.modalBtn, { marginTop: 16 }]}>
              <Text style={styles.modalBtnText}>إغلاق</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── about modal ── */}
      <Modal visible={aboutOpen} transparent animationType="fade" onRequestClose={() => setAboutOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>موجود — Mawjood</Text>
            <Text style={styles.modalBody}>
              ذاكرتك الصوتية: احكيلي وين حطيت أغراضك، شو لازم تشتري، ومتى مواعيدك — وأنا بتذكر عنك.
              {'\n\n'}Lost it? Mawjood.
            </Text>
            <Pressable onPress={() => setAboutOpen(false)} style={[styles.modalBtn, { marginTop: 8 }]}>
              <Text style={styles.modalBtnText}>إغلاق</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

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
      ) : viewSpace?.type === 'family' ? (
        <>
          <View style={styles.famHeader}>
            <Text style={styles.famMembers}>👥 {memberCount}</Text>
            <View style={styles.famActions}>
              <Pressable onPress={() => setJoinOpen(true)} style={styles.famLink}>
                <Text style={styles.famLinkText}>عندك رمز؟ انضم</Text>
              </Pressable>
              <Pressable onPress={openInvite} style={styles.inviteBtn}>
                <Text style={styles.inviteBtnText}>✉️ دعوة</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.segRow}>
            {FAMILY_TABS.map(([k, label]) => (
              <Pressable
                key={k}
                onPress={() => setFamilyTab(k)}
                style={[styles.seg, familyTab === k && styles.segActive]}
              >
                <Text style={[styles.segText, familyTab === k && styles.segTextActive]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>

          {familyTab === 'shopping' && (
            <>
              <View style={styles.addRow}>
                <TextInput
                  value={newShopping}
                  onChangeText={setNewShopping}
                  placeholder="أضف غرض… حليب، خبز، بيض"
                  placeholderTextColor="#A09485"
                  style={styles.chatInput}
                  onSubmitEditing={onAddShopping}
                  returnKeyType="done"
                />
                <Pressable onPress={onAddShopping} style={styles.sendBtn}>
                  <Text style={styles.sendBtnText}>＋</Text>
                </Pressable>
              </View>
              <FlatList
                style={styles.fill}
                data={shopping}
                keyExtractor={(i) => i.id}
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                  <Text style={styles.muted}>القائمة فاضية — أضف أول غرض 🛒</Text>
                }
                renderItem={({ item }) => (
                  <Pressable onPress={() => toggleItem(item)} style={styles.famRow}>
                    <Text style={styles.itemIcon}>{item.status === 'done' ? '✅' : '⬜'}</Text>
                    <Text style={[styles.itemTitle, item.status === 'done' && styles.itemDone]}>
                      {item.title}
                    </Text>
                  </Pressable>
                )}
              />
            </>
          )}

          {familyTab === 'tasks' && (
            <FlatList
              style={styles.fill}
              data={tasks}
              keyExtractor={(i) => i.id}
              contentContainerStyle={styles.list}
              ListEmptyComponent={
                <Text style={styles.muted}>لا مهام بعد — من الشات اكتب “سارة: اشتري خبز” ✅</Text>
              }
              renderItem={({ item }) => (
                <>
                  <View style={styles.famRow}>
                    <Pressable onPress={() => toggleItem(item)}>
                      <Text style={styles.itemIcon}>{item.status === 'done' ? '✅' : '⬜'}</Text>
                    </Pressable>
                    <View style={styles.itemBody}>
                      <Text style={[styles.itemTitle, item.status === 'done' && styles.itemDone]}>
                        {item.title}
                      </Text>
                      {item.details ? (
                        <Text style={styles.itemDetails}>{item.details}</Text>
                      ) : null}
                    </View>
                    {item.assigned_to ? (
                      <View style={styles.assigneeChip}>
                        <Text style={styles.assigneeText}>👤 {item.assigned_to}</Text>
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => {
                          setAssignFor(assignFor === item.id ? null : item.id);
                          setAssignName('');
                        }}
                        style={styles.assignBtn}
                      >
                        <Text style={styles.assignBtnText}>إسناد</Text>
                      </Pressable>
                    )}
                  </View>
                  {assignFor === item.id && (
                    <View style={styles.addRow}>
                      <TextInput
                        value={assignName}
                        onChangeText={setAssignName}
                        placeholder="اسم الشخص… سارة"
                        placeholderTextColor="#A09485"
                        style={styles.chatInput}
                        onSubmitEditing={() => onAssign(item)}
                        returnKeyType="done"
                      />
                      <Pressable onPress={() => onAssign(item)} style={styles.sendBtn}>
                        <Text style={styles.sendBtnText}>➤</Text>
                      </Pressable>
                    </View>
                  )}
                </>
              )}
            />
          )}

          {familyTab === 'agenda' && (
            <FlatList
              style={styles.fill}
              data={upcoming}
              keyExtractor={(i) => i.id}
              contentContainerStyle={styles.list}
              ListEmptyComponent={
                <Text style={styles.muted}>لا مواعيد قادمة — المواعيد المستخرجة من ملاحظات العائلة بتظهر هون 📅</Text>
              }
              renderItem={({ item }) => (
                <View style={styles.famRow}>
                  <Text style={styles.itemIcon}>📅</Text>
                  <View style={styles.itemBody}>
                    <Text style={styles.itemTitle}>{item.title}</Text>
                    <Text style={styles.itemDue}>
                      {item.due_at ? new Date(item.due_at).toLocaleString() : ''}
                    </Text>
                  </View>
                </View>
              )}
            />
          )}

          {familyTab === 'things' && thingsList}

          {familyTab === 'notes' && notesBrowser}
        </>
      ) : (
        <>
          <View style={styles.segRow}>
            {(
              [
                ['notes', '📝 ملاحظات'],
                ['things', '📦 أشيائي'],
              ] as const
            ).map(([k, label]) => (
              <Pressable
                key={k}
                onPress={() => setSpaceTab(k)}
                style={[styles.seg, spaceTab === k && styles.segActive]}
              >
                <Text style={[styles.segText, spaceTab === k && styles.segTextActive]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
          {spaceTab === 'things' ? thingsList : notesBrowser}
        </>
      )}

      {/* ── invite modal ── */}
      <Modal visible={inviteOpen} transparent animationType="fade" onRequestClose={() => setInviteOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>✉️ دعوة للعائلة</Text>
            <Text style={styles.modalBody}>
              شارك هذا الرمز مع أهلك — بيدخلوه من تبويب العائلة وبينضموا لمساحتك. صالح ٧ أيام.
            </Text>
            {inviteBusy ? (
              <ActivityIndicator color="#B3541E" style={{ marginVertical: 16 }} />
            ) : inviteCode ? (
              <Text style={styles.inviteCode}>{inviteCode}</Text>
            ) : (
              <Text style={styles.modalBody}>تعذر إنشاء الرمز — جرّب مجدداً</Text>
            )}
            <View style={styles.modalRow}>
              <Pressable onPress={shareInvite} disabled={!inviteCode} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>مشاركة</Text>
              </Pressable>
              <Pressable onPress={copyInviteCode} disabled={!inviteCode} style={[styles.modalBtn, styles.modalBtnGhost]}>
                <Text style={[styles.modalBtnText, styles.modalBtnGhostText]}>نسخ</Text>
              </Pressable>
            </View>
            <Pressable onPress={regenerateInvite} disabled={inviteBusy} style={styles.famLink}>
              <Text style={styles.famLinkText}>🔄 رمز جديد (بلغي القديم)</Text>
            </Pressable>
            <Pressable onPress={() => setInviteOpen(false)} style={[styles.famLink, { marginTop: 12 }]}>
              <Text style={styles.famLinkText}>إغلاق</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── join modal ── */}
      <Modal visible={joinOpen} transparent animationType="fade" onRequestClose={() => setJoinOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>👨‍👩‍👧 انضم لعائلة</Text>
            <Text style={styles.modalBody}>ادخل رمز الدعوة اللي وصلك من أهلك:</Text>
            <TextInput
              value={joinCode}
              onChangeText={(t) => setJoinCode(t.toUpperCase())}
              placeholder="ABC123"
              placeholderTextColor="#A09485"
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.inviteInput}
              textAlign="center"
              maxLength={12}
            />
            {joinError ? <Text style={styles.upgradeErr}>{joinError}</Text> : null}
            <View style={styles.modalRow}>
              <Pressable onPress={doJoin} disabled={joinBusy} style={styles.modalBtn}>
                {joinBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.modalBtnText}>انضم</Text>
                )}
              </Pressable>
              <Pressable onPress={() => setJoinOpen(false)} style={[styles.modalBtn, styles.modalBtnGhost]}>
                <Text style={[styles.modalBtnText, styles.modalBtnGhostText]}>إلغاء</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  // ── side drawer menu ──
  menuOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    flexDirection: 'row',
  },
  menuBackdrop: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(43,33,24,0.45)',
  },
  menuPanel: {
    width: 300,
    maxWidth: '85%',
    backgroundColor: '#FAF7F2',
    paddingTop: 56,
    paddingHorizontal: 0,
    paddingBottom: 24,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 12,
  },
  menuProfile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#EFE7DC',
    marginBottom: 8,
  },
  menuAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#B3541E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuAvatarText: { fontSize: 20, fontWeight: '800', color: '#fff' },
  menuProfileInfo: { flex: 1 },
  menuEmail: { fontSize: 15, fontWeight: '700', color: '#2B2118', textAlign: 'right' },
  menuBadge: { fontSize: 12, color: '#8A7B6C', marginTop: 2, textAlign: 'right' },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  menuItemIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  menuItemText: { fontSize: 16, fontWeight: '600', color: '#2B2118', flex: 1, textAlign: 'right' },
  menuSoon: {
    fontSize: 11,
    fontWeight: '700',
    color: '#B3541E',
    backgroundColor: '#F5E6D3',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  menuLogout: { marginTop: 8, borderTopWidth: 1, borderTopColor: '#EFE7DC' },
  menuLogoutText: { color: '#B33A2B' },
  profileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F1EAE0',
  },
  profileLabel: { fontSize: 14, color: '#8A7B6C' },
  profileValue: { fontSize: 14, fontWeight: '700', color: '#2B2118' },
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
  chatFooter: { paddingHorizontal: 16, paddingBottom: 20, paddingTop: 8, gap: 8 },
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
  segRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 6, marginBottom: 8 },
  seg: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: '#EFE7DC',
    alignItems: 'center',
  },
  segActive: { backgroundColor: '#1E5A8A' },
  segText: { fontSize: 13, fontWeight: '700', color: '#5C4F42' },
  segTextActive: { color: '#fff' },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  famRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  assigneeChip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#E8F4FF',
  },
  assigneeText: { fontSize: 12, fontWeight: '700', color: '#1E5A8A' },
  assignBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#EFE7DC',
  },
  assignBtnText: { fontSize: 12, fontWeight: '700', color: '#5C4F42' },
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

  // ── auth + invites ──
  upgradeBanner: {
    backgroundColor: '#FFF8EC',
    borderBottomWidth: 1,
    borderBottomColor: '#F1E4C8',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  upgradeText: { fontSize: 13, fontWeight: '600', color: '#8A6D3B', marginBottom: 8 },
  upgradeRow: { flexDirection: 'row', gap: 8 },
  upgradeInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#2B2118',
    borderWidth: 1,
    borderColor: '#E8DCC4',
  },
  upgradeBtn: {
    backgroundColor: '#2B2118',
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  upgradeBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  upgradeErr: { color: '#B3402E', fontSize: 13, marginTop: 6 },
  famHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  famMembers: { fontSize: 14, color: '#6B5D4F', fontWeight: '600' },
  famActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  famLink: { padding: 4 },
  famLinkText: { fontSize: 13, color: '#B3541E', fontWeight: '600' },
  inviteBtn: {
    backgroundColor: '#2B2118',
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  inviteBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(43,33,24,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#FAF7F2',
    borderRadius: 18,
    padding: 22,
    alignItems: 'center',
  },
  modalTitle: { fontSize: 19, fontWeight: '800', color: '#2B2118', marginBottom: 10 },
  modalBody: { fontSize: 14, color: '#6B5D4F', textAlign: 'center', lineHeight: 21, marginBottom: 14 },
  inviteCode: {
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 6,
    color: '#2B2118',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E8E0D4',
  },
  inviteInput: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 4,
    color: '#2B2118',
    borderWidth: 1,
    borderColor: '#E8E0D4',
    marginBottom: 12,
  },
  modalRow: { flexDirection: 'row', gap: 10, width: '100%' },
  modalBtn: {
    flex: 1,
    backgroundColor: '#2B2118',
    borderRadius: 12,
    padding: 13,
    alignItems: 'center',
  },
  modalBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  modalBtnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#D8CDBB' },
  modalBtnGhostText: { color: '#6B5D4F' },
});
