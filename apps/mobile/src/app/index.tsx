import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import * as Speech from 'expo-speech';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  VoiceEngine,
  answerLocally,
  extractCorrectionPlace,
  parseAssignment,
  parseDirectedShopping,
  splitShoppingItems,
  resolveFamilyMember,
} from '@mawjood/voice-engine';
import type { Borrow, FamilyMember, Item, Note, ShoppingList, Space, SpaceTab, SpaceType } from '@mawjood/voice-engine';
import { supabase } from '../lib/supabase';
import { linkEmailToAnonymous, signOut } from '../lib/auth';
import { registerForPushNotifications } from '../lib/push';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import AuthScreen from '../components/AuthScreen';
import { t, tx, ta, useLang, getLang, setLanguage, initLanguage } from '../lib/i18n';
import { useTheme, type Palette } from '../lib/theme';
import AsyncStorage from '@react-native-async-storage/async-storage';

const VOICE_REPLY_KEY = 'mawjood.voice-reply'; // '1' = speak replies to voice notes

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

// built-in family tab keys — anything else in familyTab is a custom tab id
const FAMILY_BUILTIN_KEYS: ReadonlySet<string> = new Set([
  'members',
  'shopping',
  'tasks',
  'agenda',
  'things',
  'notes',
]);

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
  photo?: string | null; // attached photo (local uri or remote URL) shown in the bubble
  sources?: { note_id: string; snippet: string }[];
}

/** a saved chat session (ChatGPT-style history) */
interface ChatSession {
  id: string;
  title: string;
  messages: ChatMsg[];
  updated_at: string;
  expires_at: string;
  ttl: string; // precomputed delete-countdown text (computed at load, not render)
}

const ACTIVE_CHAT_KEY = 'mawjood.active-chat'; // in-progress chat draft
const HISTORY_IDLE_MS = 2 * 60 * 1000; // current chat survives 2 min after background
const MAX_HISTORY_MSGS = 100; // cap stored messages per session
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const newSessionId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** delete-countdown text; called from event handlers (impure: Date.now), never render */
function ttlText(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return '…';
  const mins = Math.max(1, Math.floor(ms / 60000));
  if (mins < 60) return tx('ttlMins', { n: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return tx('ttlHours', { n: hrs });
  return tx('ttlDays', { n: Math.floor(hrs / 24) });
}

export default function HomeScreen() {
  const lang = useLang(); // re-renders the whole screen when the language changes
  const { mode: themeMode, cycle: cycleTheme, refresh: refreshTheme, palette: P } = useTheme();
  const styles = useMemo(() => makeStyles(P), [P]);
  const [userId, setUserId] = useState<string | null>(null);
  // stable mirror for callbacks that must not re-create (boot chain)
  const userIdRef = useRef<string | null>(null);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
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
  const [textNote, setTextNote] = useState('');
  const [savingText, setSavingText] = useState(false);
  const [asking, setAsking] = useState(false);
  // voice replies: a voice note gets a SPOKEN answer (like a live chat);
  // text stays text. voiceModeRef = last user input was voice.
  const [voiceReplyOn, setVoiceReplyOn] = useState(true);
  const voiceReplyRef = useRef(true);
  const voiceModeRef = useRef(false);
  // ── chat history (ChatGPT-style): sessions live in the side menu,
  // auto-delete after retention days; current chat survives 2 min idle ──
  const sessionIdRef = useRef(newSessionId());
  const [history, setHistory] = useState<ChatSession[]>([]);
  const [histVisible, setHistVisible] = useState(10); // drawer shows 10 chats at a time
  const [historyLoading, setHistoryLoading] = useState(false);
  const backgroundedAtRef = useRef(0);
  const retentionDaysRef = useRef(7); // profiles.chat_retention_days (future paid plans)
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
  const [familyTab, setFamilyTab] = useState<string>('members'); // built-in key or custom tab id
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[] | null>(null);
  const [membersBusy, setMembersBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [shopping, setShopping] = useState<Item[]>([]);
  const [shopLists, setShopLists] = useState<ShoppingList[]>([]); // directed lists ("يا جون جيب…")
  const [activeListId, setActiveListId] = useState<string | null>(null); // shopping-mode modal
  const [delListId, setDelListId] = useState<string | null>(null); // two-tap list delete
  const adoptedRef = useRef<string | null>(null); // loose-shopping adoption, once per space
  const [tasks, setTasks] = useState<Item[]>([]);
  const [upcoming, setUpcoming] = useState<Item[]>([]);
  // ── custom tabs (user-created; family tabs are shared with all members) ──
  const [spaceTabs, setSpaceTabs] = useState<SpaceTab[]>([]);
  const [tabLimit, setTabLimit] = useState(3); // free-tier cap per space (paid → unlimited)
  const [spaceTab, setSpaceTab] = useState<string>('notes'); // 'notes'|'things'|'papers' or custom tab id
  const [tabModalOpen, setTabModalOpen] = useState(false); // create / rename tab
  const [editingTab, setEditingTab] = useState<SpaceTab | null>(null);
  const [tabName, setTabName] = useState('');
  const [tabIcon, setTabIcon] = useState('📁');
  const [tabMenuId, setTabMenuId] = useState<string | null>(null); // long-press menu on a tab
  const [limitModalOpen, setLimitModalOpen] = useState(false); // free-tier cap reached
  const [fileNoteId, setFileNoteId] = useState<string | null>(null); // note being filed into a tab
  // ── trash (Plus: 30-day soft delete) + secret vault tab ──
  const [trashRetention, setTrashRetention] = useState(30);
  const [secretVault, setSecretVault] = useState<{ enabled: boolean; vaults: { id: string; code: string }[] }>({
    enabled: false,
    vaults: [],
  });
  const [delTab, setDelTab] = useState<SpaceTab | null>(null); // tab being deleted → move or trash modal
  const [delTabCount, setDelTabCount] = useState(0);
  const [delTabPickTarget, setDelTabPickTarget] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashNotes, setTrashNotes] = useState<(Note & { daysLeft: number })[]>([]);
  const [trashTabs, setTrashTabs] = useState<(SpaceTab & { daysLeft: number })[]>([]);
  const [trashBusy, setTrashBusy] = useState(false);
  const [restorePick, setRestorePick] = useState<Note | null>(null); // trashed note → choose target tab
  const [secretVaultId, setSecretVaultId] = useState<string | null>(null); // open vault page
  const [secretNotes, setSecretNotes] = useState<Note[]>([]);
  const [secretDraft, setSecretDraft] = useState('');
  const [secretSaving, setSecretSaving] = useState(false);
  const [secretSearchOpen, setSecretSearchOpen] = useState(false);
  const [secretSearch, setSecretSearch] = useState('');
  const [secretEditingId, setSecretEditingId] = useState<string | null>(null);
  const [secretEditDraft, setSecretEditDraft] = useState('');
  const [secretDelId, setSecretDelId] = useState<string | null>(null);
  const [secretPhotoUri, setSecretPhotoUri] = useState<string | null>(null);
  const [secretCodeDraft, setSecretCodeDraft] = useState('');
  const [secretCodeMsg, setSecretCodeMsg] = useState<string | null>(null);
  const [secretCodeMsgOk, setSecretCodeMsgOk] = useState(false);
  // ── Phase 4: 📦 أشيائي pillar (all spaces) ──
  const [things, setThings] = useState<Item[]>([]);
  // ── borrowing (مين أخذها؟): open borrows per space ──
  const [borrows, setBorrows] = useState<Borrow[]>([]);
  const [confirmReturnId, setConfirmReturnId] = useState<string | null>(null);
  const [newListOpen, setNewListOpen] = useState(false); // manual list creator modal
  const [newListTitle, setNewListTitle] = useState('');
  const [newListItems, setNewListItems] = useState('');
  const [newListAssignee, setNewListAssignee] = useState<string | null>(null);
  const [archOpenId, setArchOpenId] = useState<string | null>(null); // expanded archived list
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [assignName, setAssignName] = useState('');
  const itemsSub = useRef<(() => void) | null>(null);

  // ── voice note playback (expo-audio, one shared player) ──
  const player = useAudioPlayer();
  const playerStatus = useAudioPlayerStatus(player);
  const [playingId, setPlayingId] = useState<string | null>(null);

  useEffect(() => () => player.remove(), [player]);

  const togglePlay = useCallback(
    (note: Note) => {
      if (!note.audio_url) return;
      if (playingId === note.id) {
        // pause / resume (resume also replays after the track finished)
        if (playerStatus.playing) player.pause();
        else player.play();
        return;
      }
      try {
        player.replace({ uri: note.audio_url });
        player.play();
        setPlayingId(note.id);
      } catch (e) {
        console.warn('play failed', e);
      }
    },
    [player, playerStatus.playing, playingId],
  );

  // ── place photo proof (وين أغراضي؟ بدليل بصري) ──
  const [photoViewer, setPhotoViewer] = useState<string | null>(null);
  const [uploadingPhotoId, setUploadingPhotoId] = useState<string | null>(null);

  // ── chat note photo: photograph first, then talk/write about it ──
  const [chatPhotoUri, setChatPhotoUri] = useState<string | null>(null);

  const pickChatPhoto = useCallback(
    async (useCamera: boolean) => {
      try {
        const perm = useCamera
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert(
            t('permRequired'),
            useCamera ? t('permCamera') : t('permPhotos'),
          );
          return;
        }
        const res = useCamera
          ? await ImagePicker.launchCameraAsync({ allowsEditing: true, aspect: [4, 3], quality: 0.7 })
          : await ImagePicker.launchImageLibraryAsync({ allowsEditing: true, aspect: [4, 3], quality: 0.7 });
        if (res.canceled || !res.assets?.[0]?.uri) return;
        setChatPhotoUri(res.assets[0].uri);
      } catch (e) {
        console.warn('chat photo pick failed', e);
      }
    },
    [],
  );

  const askChatPhotoSource = useCallback(() => {
    // Alert.alert is a no-op on react-native-web: on web go straight to the
    // file picker — iOS Safari natively offers Take Photo / Photo Library.
    if (Platform.OS === 'web') {
      pickChatPhoto(false);
      return;
    }
    Alert.alert(t('photoWithNote'), t('photoThenTell'), [
      { text: t('camera'), onPress: () => pickChatPhoto(true) },
      { text: t('gallery'), onPress: () => pickChatPhoto(false) },
      { text: t('cancel'), style: 'cancel' },
    ]);
  }, [pickChatPhoto]);

  const pickItemPhoto = useCallback(
    async (item: Item, useCamera: boolean) => {
      try {
        const perm = useCamera
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert(
            t('permRequired'),
            useCamera ? t('permCamera') : t('permPhotos'),
          );
          return;
        }
        const res = useCamera
          ? await ImagePicker.launchCameraAsync({ allowsEditing: true, aspect: [4, 3], quality: 0.7 })
          : await ImagePicker.launchImageLibraryAsync({ allowsEditing: true, aspect: [4, 3], quality: 0.7 });
        if (res.canceled || !res.assets?.[0]?.uri || !userId) return;
        setUploadingPhotoId(item.id);
        const url = await engine.uploadItemPhoto(item.id, res.assets[0].uri, userId);
        const updated = await engine.setItemPhoto(item.id, url);
        setThings((prev) => prev.map((t) => (t.id === item.id ? updated : t)));
      } catch (e) {
        console.warn('photo upload failed', e);
        Alert.alert(t('photoUploadFail'), t('tryAgain'));
      } finally {
        setUploadingPhotoId(null);
      }
    },
    [userId],
  );

  // ── borrowing (مين أخذها؟): match a thing to its open borrow ──
  const normAr = (t: string) =>
    t
      .toLowerCase()
      .replace(/[ً-ٰٟ]/g, '')
      .replace(/ـ/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .split(/\s+/)
      .map((w) => w.replace(/^ال/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  const borrowFor = (title: string): Borrow | undefined => {
    const nt = normAr(title);
    return borrows.find((b) => normAr(b.item_title) === nt);
  };
  const onReturnBorrow = useCallback(
    async (br: Borrow) => {
      if (confirmReturnId !== br.id) {
        setConfirmReturnId(br.id); // first tap → ask for confirmation
        return;
      }
      setConfirmReturnId(null);
      try {
        await engine.returnBorrow(br.id);
        setBorrows((prev) => prev.filter((b) => b.id !== br.id));
      } catch (e) {
        console.warn('returnBorrow failed', e);
      }
    },
    [confirmReturnId],
  );

  const askPhotoSource = useCallback(
    (item: Item) => {
      // Alert.alert is a no-op on react-native-web: on web go straight to the
      // file picker — iOS Safari natively offers Take Photo / Photo Library.
      if (Platform.OS === 'web') {
        pickItemPhoto(item, false);
        return;
      }
      Alert.alert(t('photoOfPlace'), t('photoSourceQ'), [
        { text: t('camera'), onPress: () => pickItemPhoto(item, true) },
        { text: t('gallery'), onPress: () => pickItemPhoto(item, false) },
        { text: t('cancel'), style: 'cancel' },
      ]);
    },
    [pickItemPhoto],
  );

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
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSavedTick, setNameSavedTick] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
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

  // live mirror of messages for callbacks (history archiving reads this)
  const messagesRef = useRef<ChatMsg[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const updateMsg = useCallback((id: string, patch: Partial<ChatMsg>) => {    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  /** Speak an assistant reply out loud — only when the last user input was
   *  voice (and the user kept voice replies on). Text input → text reply. */
  const speak = useCallback((text: string) => {
    if (!voiceReplyRef.current || !voiceModeRef.current) return;
    const clean = text.replace(/^🧪\s*/, '').trim();
    if (!clean || clean === '…') return;
    try {
      Speech.stop();
      Speech.speak(clean, { language: getLang() === 'ar' ? 'ar' : 'en' });
    } catch {
      /* TTS unavailable — the text reply is still on screen */
    }
  }, []);

  const setVoiceReply = useCallback((on: boolean) => {
    setVoiceReplyOn(on);
    voiceReplyRef.current = on;
    AsyncStorage.setItem(VOICE_REPLY_KEY, on ? '1' : '0').catch(() => {});
    if (!on) {
      try {
        Speech.stop();
      } catch {
        /* ignore */
      }
    }
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
    const boughtAt = item.kind === 'shopping' ? (next === 'done' ? new Date().toISOString() : null) : item.bought_at;
    const patch = (list: Item[]): Item[] =>
      list.map((p) => (p.id === item.id ? { ...p, status: next, bought_at: boughtAt } : p));
    setShopping(patch);
    setTasks(patch);
    setUpcoming(patch);
    setNoteItems((prev) => ({
      ...prev,
      [item.note_id!]: (prev[item.note_id!] ?? []).map((p) =>
        p.id === item.id ? { ...p, status: next, bought_at: boughtAt } : p,
      ),
    }));
    setShopLists((prev) =>
      prev.map((l) => ({
        ...l,
        items: l.items.map((p) => (p.id === item.id ? { ...p, status: next, bought_at: boughtAt } : p)),
      })),
    );
    try {
      await engine.setItemStatus(item.id, next);
    } catch (e) {
      console.warn('setItemStatus failed', e);
    }
  }, []);

  /**
   * Set one shopping-list item's status: bought (✅), not found (❌ ما لقيناه),
   * or back to open. When every item is resolved the list is archived
   * (status done → moves to the history section).
   */
  const setShopItemStatus = useCallback(
    async (listId: string, item: Item, status: Item['status']) => {
      const list = shopLists.find((l) => l.id === listId);
      if (!list) return;
      const now = new Date().toISOString();
      const items = list.items.map((p) =>
        p.id === item.id
          ? { ...p, status, bought_at: status === 'done' ? now : null }
          : p,
      );
      const allResolved = items.length > 0 && items.every((p) => p.status !== 'open');
      const listStatus = allResolved ? 'done' : 'open';
      // preserve the original archive date when editing an already-archived list
      const completedAt = allResolved ? (list.completed_at ?? now) : null;
      setShopLists((prev) =>
        prev.map((l) =>
          l.id === listId
            ? { ...l, items, status: listStatus, completed_at: completedAt }
            : l,
        ),
      );
      try {
        await engine.setItemStatus(item.id, status);
        await engine.setShoppingListStatus(listId, listStatus, completedAt);
      } catch (e) {
        console.warn('setShopItemStatus failed', e);
        // roll back the optimistic update (e.g. migration 0015 not run yet)
        setShopLists((prev) =>
          prev.map((l) =>
            l.id === listId ? { ...l, items: list.items, status: list.status } : l,
          ),
        );
      }
    },
    [shopLists],
  );

  /** Two taps to delete a shopping list (its items cascade). */
  const deleteShopList = useCallback(
    async (listId: string) => {
      if (delListId !== listId) {
        setDelListId(listId);
        setTimeout(() => setDelListId((cur) => (cur === listId ? null : cur)), 4000);
        return;
      }
      setDelListId(null);
      setShopLists((prev) => prev.filter((l) => l.id !== listId));
      if (activeListId === listId) setActiveListId(null);
      try {
        await engine.deleteShoppingList(listId);
      } catch (e) {
        console.warn('deleteShoppingList failed', e);
      }
    },
    [delListId, activeListId],
  );

  /** Restore an archived list to live: not_found items reopen, bought stay bought. */
  const restoreShopList = useCallback(
    async (listId: string) => {
      const list = shopLists.find((l) => l.id === listId);
      if (!list || list.status !== 'done') return;
      const items = list.items.map((p) =>
        p.status === 'not_found' ? { ...p, status: 'open' as const } : p,
      );
      setShopLists((prev) =>
        prev.map((l) =>
          l.id === listId ? { ...l, items, status: 'open' as const, completed_at: null } : l,
        ),
      );
      if (archOpenId === listId) setArchOpenId(null);
      try {
        await engine.restoreShoppingList(listId);
      } catch (e) {
        console.warn('restoreShoppingList failed', e);
        // roll back the optimistic update
        setShopLists((prev) =>
          prev.map((l) => (l.id === listId ? { ...list, status: 'done' as const } : l)),
        );
      }
    },
    [shopLists, archOpenId],
  );

  // ── Phase 3: family lists ──
  const refreshFamily = useCallback(async (spaceId: string) => {
    try {
      const [s, t, u] = await Promise.all([
        engine.listShopping(spaceId),
        engine.listTasks(spaceId),
        engine.listUpcoming(spaceId),
      ]);
      setShopping(s.filter((i) => !i.list_id)); // loose items only — list items live under their list
      setTasks(t);
      setUpcoming(u);
    } catch (e) {
      console.warn('refreshFamily failed', e);
    }
    // directed shopping lists (graceful until migration 0014 is run)
    try {
      setShopLists(await engine.listShoppingLists(spaceId));
    } catch {
      setShopLists([]);
    }
  }, []);

  // ── Phase 4: 📦 أشيائي ──
  const refreshThings = useCallback(async (spaceId: string) => {
    try {
      setThings(await engine.listThings(spaceId));
    } catch (e) {
      console.warn('listThings failed', e);
    }
    // ── borrowing (مين أخذها؟) ──
    try {
      setBorrows(await engine.listBorrows(spaceId));
    } catch (e) {
      console.warn('listBorrows failed', e);
    }
  }, []);

  // ── custom tabs ──
  const refreshTabs = useCallback(async (spaceId: string) => {
    try {
      setSpaceTabs(await engine.listSpaceTabs(spaceId));
    } catch (e) {
      console.warn('listSpaceTabs failed', e);
      setSpaceTabs([]);
    }
  }, []);

  /** Create / rename a custom tab (owner only; free-tier cap enforced). */
  const saveTab = useCallback(async () => {
    const spaceId = viewSpace?.id;
    if (!spaceId || !userId || !tabName.trim()) return;
    if (!editingTab && spaceTabs.length >= tabLimit) {
      setTabModalOpen(false);
      setLimitModalOpen(true);
      return;
    }
    setTabModalOpen(false);
    try {
      if (editingTab) {
        await engine.renameSpaceTab(editingTab.id, tabName);
        setSpaceTabs((prev) => prev.map((x) => (x.id === editingTab.id ? { ...x, title: tabName.trim() } : x)));
      } else {
        const tab = await engine.createSpaceTab(spaceId, userId, tabName, tabIcon);
        setSpaceTabs((prev) => [...prev, tab]);
        if (viewSpace?.type === 'family') setFamilyTab(tab.id);
        else setSpaceTab(tab.id);
      }
    } catch (e) {
      console.warn('saveTab failed', e);
    }
    setEditingTab(null);
    setTabName('');
    setTabIcon('📁');
  }, [viewSpace, userId, tabName, tabIcon, editingTab, spaceTabs.length, tabLimit]);

  const runDeleteTab = useCallback(
    async (tabId: string, opts: { moveTo?: string | null; trash: boolean }) => {
      if (spaceTab === tabId) setSpaceTab('notes');
      if (familyTab === tabId) setFamilyTab('members');
      setSpaceTabs((prev) => prev.filter((x) => x.id !== tabId));
      setNotes((prev) =>
        opts.moveTo !== undefined
          ? prev.map((n) => (n.tab_id === tabId ? { ...n, tab_id: opts.moveTo ?? null } : n))
          : prev.filter((n) => n.tab_id !== tabId),
      );
      setDelTab(null);
      setDelTabPickTarget(false);
      try {
        await engine.deleteSpaceTab(tabId, opts);
      } catch (e) {
        console.warn('deleteSpaceTab failed', e);
      }
    },
    [spaceTab, familyTab],
  );

  /** Delete a custom tab → modal: move its notes to another tab, or trash/delete them. */
  const askDeleteTab = useCallback(
    (tab: SpaceTab) => {
      setTabMenuId(null);
      const n = notes.filter((x) => x.tab_id === tab.id).length;
      if (n === 0) {
        void runDeleteTab(tab.id, { trash: false });
        return;
      }
      setDelTab(tab);
      setDelTabCount(n);
      setDelTabPickTarget(false);
    },
    [notes, runDeleteTab],
  );

  // ── trash (Plus: soft-deleted notes/tabs live here until expiry) ──
  const [delForeverId, setDelForeverId] = useState<string | null>(null); // two-tap permanent delete in trash

  const openTrash = useCallback(async () => {
    if (!userId) return;
    setTrashOpen(true);
    setTrashBusy(true);
    try {
      const ids = spaces.map((s) => s.id);
      await engine.purgeTrash(ids, trashRetention); // lazy expiry of old rows
      const res = await engine.listTrash(ids);
      const nowMs = Date.now();
      const dl = (deletedAt: string | null) =>
        Math.max(
          0,
          Math.ceil((new Date(deletedAt ?? nowMs).getTime() + trashRetention * 86400_000 - nowMs) / 86400_000),
        );
      setTrashNotes(res.notes.map((n) => ({ ...n, daysLeft: dl(n.deleted_at) })));
      setTrashTabs(res.tabs.map((tb) => ({ ...tb, daysLeft: dl(tb.deleted_at) })));
    } catch (e) {
      console.warn('openTrash failed', e);
    } finally {
      setTrashBusy(false);
    }
  }, [userId, spaces, trashRetention]);

  const refreshAfterRestore = useCallback(
    (spaceId: string) => {
      if (viewSpace?.id === spaceId) {
        void refreshNotes(spaceId);
        void refreshTabs(spaceId);
      }
    },
    [viewSpace, refreshNotes, refreshTabs],
  );

  /** Original-tab label for a trashed note. */
  const trashNoteTabLabel = useCallback(
    (note: Note): string => {
      if (note.tab_id === null) {
        const sp = spaces.find((s) => s.id === note.space_id);
        return sp?.type === 'family' ? t('tabNotes') : t('tabMyNotes');
      }
      if (note.tab_id === 'papers') return t('tabMyPapers');
      if (note.tab_id === 'secret') return `🔒 ${t('secretTab')}`;
      const trashed = trashTabs.find((x) => x.id === note.tab_id);
      if (trashed) return `${trashed.icon} ${trashed.title}`;
      return t('deletedTabGone');
    },
    [spaces, trashTabs],
  );

  const restoreTrashNote = useCallback(
    async (note: Note, tabId: string | null) => {
      setRestorePick(null);
      setTrashNotes((prev) => prev.filter((n) => n.id !== note.id));
      try {
        await engine.restoreNote(note.id, tabId);
        refreshAfterRestore(note.space_id);
      } catch (e) {
        console.warn('restoreNote failed', e);
      }
    },
    [refreshAfterRestore],
  );

  const restoreTrashTab = useCallback(
    async (tab: SpaceTab) => {
      setTrashTabs((prev) => prev.filter((x) => x.id !== tab.id));
      setTrashNotes((prev) => prev.filter((n) => n.tab_id !== tab.id));
      try {
        await engine.restoreTab(tab.id);
        refreshAfterRestore(tab.space_id);
      } catch (e) {
        console.warn('restoreTab failed', e);
      }
    },
    [refreshAfterRestore],
  );

  const [restoreTargets, setRestoreTargets] = useState<{ id: string | null; label: string }[]>([]);

  /** Open the "restore to which tab?" picker for one trashed note. */
  const openRestorePick = useCallback(
    async (note: Note) => {
      setRestorePick(note);
      setRestoreTargets([]);
      try {
        const sp = spaces.find((s) => s.id === note.space_id);
        const tabs = await engine.listSpaceTabs(note.space_id);
        const list: { id: string | null; label: string }[] = [
          { id: null, label: sp?.type === 'family' ? t('tabNotes') : t('tabMyNotes') },
        ];
        if (sp?.type !== 'family') list.push({ id: 'papers', label: t('tabMyPapers') });
        if (note.tab_id === 'secret') list.push({ id: 'secret', label: `🔒 ${t('secretTab')}` });
        for (const tb of tabs) list.push({ id: tb.id, label: `${tb.icon} ${tb.title}` });
        setRestoreTargets(list);
      } catch (e) {
        console.warn('restore targets failed', e);
      }
    },
    [spaces],
  );

  /** Restore everything: tabs come back with their notes, the rest to their tab (or main). */
  const restoreAllTrash = useCallback(async () => {
    const tabs = trashTabs;
    const notes = trashNotes;
    setTrashTabs([]);
    setTrashNotes([]);
    try {
      const restoredTabIds = new Set(tabs.map((x) => x.id));
      for (const tb of tabs) await engine.restoreTab(tb.id);
      for (const n of notes) {
        if (n.tab_id && restoredTabIds.has(n.tab_id)) continue; // back with its tab
        const target =
          n.tab_id === 'papers' || n.tab_id === 'secret' ? n.tab_id : null;
        await engine.restoreNote(n.id, target);
      }
      if (viewSpace) {
        void refreshNotes(viewSpace.id);
        void refreshTabs(viewSpace.id);
      }
    } catch (e) {
      console.warn('restoreAllTrash failed', e);
    }
  }, [trashTabs, trashNotes, viewSpace, refreshNotes, refreshTabs]);

  /** Two-tap permanent delete of one trashed note (no way back). */
  const nukeTrashNote = useCallback(
    async (note: Note) => {
      const key = `n:${note.id}`;
      if (delForeverId !== key) {
        setDelForeverId(key);
        setTimeout(() => setDelForeverId((cur) => (cur === key ? null : cur)), 4000);
        return;
      }
      setDelForeverId(null);
      setTrashNotes((prev) => prev.filter((n) => n.id !== note.id));
      try {
        await engine.deleteNoteForever(note.id);
      } catch (e) {
        console.warn('deleteNoteForever failed', e);
      }
    },
    [delForeverId],
  );

  /** Two-tap permanent delete of one trashed tab + its notes. */
  const nukeTrashTab = useCallback(
    async (tab: SpaceTab) => {
      const key = `t:${tab.id}`;
      if (delForeverId !== key) {
        setDelForeverId(key);
        setTimeout(() => setDelForeverId((cur) => (cur === key ? null : cur)), 4000);
        return;
      }
      setDelForeverId(null);
      setTrashTabs((prev) => prev.filter((x) => x.id !== tab.id));
      setTrashNotes((prev) => prev.filter((n) => n.tab_id !== tab.id));
      try {
        await engine.deleteTabForever(tab.id);
      } catch (e) {
        console.warn('deleteTabForever failed', e);
      }
    },
    [delForeverId],
  );

  /** Two-tap: permanently empty the whole trash. */
  const emptyTrashAll = useCallback(async () => {
    if (delForeverId !== 'all') {
      setDelForeverId('all');
      setTimeout(() => setDelForeverId((cur) => (cur === 'all' ? null : cur)), 4000);
      return;
    }
    setDelForeverId(null);
    setTrashNotes([]);
    setTrashTabs([]);
    try {
      await engine.emptyTrash(spaces.map((s) => s.id));
    } catch (e) {
      console.warn('emptyTrash failed', e);
    }
  }, [delForeverId, spaces]);

  // ── secret vaults (hidden; each code opens its own vault page via private chat) ──
  const openSecretVault = useCallback(
    async (vaultId: string) => {
      const pid = spaceIdByType('private');
      if (!pid || !userId) return;
      setSecretVaultId(vaultId);
      try {
        setSecretNotes(await engine.listSecretNotes(pid, userId, vaultId));
      } catch (e) {
        console.warn('listSecretNotes failed', e);
      }
    },
    [spaceIdByType, userId],
  );

  const saveSecretNoteLocal = useCallback(async () => {
    const pid = spaceIdByType('private');
    const text = secretDraft.trim();
    if (!pid || !userId || !text || !secretVaultId || secretSaving) return;
    setSecretSaving(true);
    const photoUri = secretPhotoUri;
    setSecretPhotoUri(null);
    setSecretDraft('');
    try {
      const photoUrl = photoUri ? await engine.uploadNotePhoto(photoUri, userId).catch(() => null) : null;
      const note = await engine.saveSecretNote(pid, userId, text, secretVaultId, photoUrl);
      setSecretNotes((prev) => [note, ...prev]);
    } catch (e) {
      console.warn('saveSecretNote failed', e);
      setSecretDraft(text); // restore on failure
      setSecretPhotoUri(photoUri);
    } finally {
      setSecretSaving(false);
    }
  }, [spaceIdByType, userId, secretDraft, secretVaultId, secretSaving, secretPhotoUri]);

  /** Poll a secret voice note until the transcript lands (no agent, no extraction). */
  const pollSecretNote = useCallback((noteId: string) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > 180_000) {
        clearInterval(timer);
        return;
      }
      try {
        const n = await engine.getNote(noteId);
        if (n.status === 'ready' || n.status === 'failed') {
          clearInterval(timer);
          setSecretNotes((prev) =>
            prev.map((x) =>
              x.id === noteId
                ? {
                    ...x,
                    transcript: n.transcript?.trim() ? n.transcript : t('secretTranscribeFail'),
                    status: n.status,
                    photo_url: n.photo_url ?? x.photo_url,
                    duration_sec: n.duration_sec ?? x.duration_sec,
                  }
                : x,
            ),
          );
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
  }, []);

  /** Voice straight into the vault: record → transcribe → secret note. */
  const onSecretRecordPress = useCallback(async () => {
    if (isRecording) {
      const audio = await stop();
      const pid = spaceIdByType('private');
      if (!audio || !pid || !userId || !secretVaultId) return;
      const photoUri = secretPhotoUri;
      setSecretPhotoUri(null);
      setSecretSaving(true);
      try {
        const photoUrl = photoUri ? await engine.uploadNotePhoto(photoUri, userId).catch(() => null) : null;
        const note = await engine.saveSecretVoiceNote(pid, audio, userId, secretVaultId, photoUrl);
        setSecretNotes((prev) => [{ ...note, transcript: t('secretTranscribing') }, ...prev]);
        pollSecretNote(note.id);
      } catch (e) {
        console.warn('saveSecretVoiceNote failed', e);
      } finally {
        setSecretSaving(false);
      }
    } else {
      await start();
    }
  }, [isRecording, stop, start, userId, spaceIdByType, secretVaultId, secretPhotoUri, pollSecretNote]);

  const pickSecretPhoto = useCallback(
    async (useCamera: boolean) => {
      try {
        const perm = useCamera
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert(
            t('permRequired'),
            useCamera ? t('permCamera') : t('permPhotos'),
          );
          return;
        }
        const res = useCamera
          ? await ImagePicker.launchCameraAsync({ allowsEditing: true, aspect: [4, 3], quality: 0.7 })
          : await ImagePicker.launchImageLibraryAsync({ allowsEditing: true, aspect: [4, 3], quality: 0.7 });
        if (res.canceled || !res.assets?.[0]?.uri) return;
        setSecretPhotoUri(res.assets[0].uri);
      } catch (e) {
        console.warn('secret photo pick failed', e);
      }
    },
    [],
  );

  const askSecretPhotoSource = useCallback(() => {
    // Alert.alert is a no-op on react-native-web: on web go straight to the
    // file picker — iOS Safari natively offers Take Photo / Photo Library.
    if (Platform.OS === 'web') {
      pickSecretPhoto(false);
      return;
    }
    Alert.alert(t('photoWithNote'), t('photoThenTell'), [
      { text: t('camera'), onPress: () => pickSecretPhoto(true) },
      { text: t('gallery'), onPress: () => pickSecretPhoto(false) },
      { text: t('cancel'), style: 'cancel' },
    ]);
  }, [pickSecretPhoto]);

  const startEditSecret = useCallback((n: Note) => {
    setSecretEditingId(n.id);
    setSecretEditDraft(n.transcript ?? '');
    setSecretDelId(null);
  }, []);

  const saveEditSecret = useCallback(async () => {
    const id = secretEditingId;
    const text = secretEditDraft.trim();
    if (!id || !text) return;
    setSecretEditingId(null);
    setSecretNotes((prev) => prev.map((n) => (n.id === id ? { ...n, transcript: text } : n)));
    try {
      await engine.updateSecretNote(id, text);
    } catch (e) {
      console.warn('updateSecretNote failed', e);
    }
  }, [secretEditingId, secretEditDraft]);

  /** Two-tap delete: first tap arms, second tap deletes forever (never to trash). */
  const askDeleteSecret = useCallback(
    (id: string) => {
      if (secretDelId === id) {
        setSecretDelId(null);
        setSecretEditingId((cur) => (cur === id ? null : cur));
        engine
          .deleteSecretNote(id)
          .then(() => setSecretNotes((prev) => prev.filter((n) => n.id !== id)))
          .catch((e) => console.warn('deleteSecretNote failed', e));
      } else {
        setSecretDelId(id);
        setTimeout(() => setSecretDelId((cur) => (cur === id ? null : cur)), 4000);
      }
    },
    [secretDelId],
  );

  const saveSecretCode = useCallback(async () => {
    if (!userId || !secretCodeDraft.trim()) return;
    setSecretCodeMsg(null);
    try {
      // Every code gets its own vault page; re-saving an old code reopens its vault.
      const vaultId = await engine.setSecretCode(userId, secretCodeDraft);
      const clean = secretCodeDraft.trim();
      setSecretVault((v) =>
        v.vaults.some((x) => x.id === vaultId) ? v : { ...v, vaults: [...v.vaults, { id: vaultId, code: clean }] },
      );
      setSecretCodeDraft('');
      setSecretCodeMsg(t('secretCodeSaved'));
      setSecretCodeMsgOk(true);
      // opsec: brief confirmation, then the section looks untouched again
      setTimeout(() => {
        setSecretCodeMsg(null);
        setSecretCodeMsgOk(false);
      }, 3500);
    } catch (e) {
      console.warn('setSecretCode failed', e);
      const limited = e instanceof Error && e.message === 'vault_limit';
      setSecretCodeMsg(t(limited ? 'secretVaultLimit' : 'secretCodeFail'));
      setSecretCodeMsgOk(false);
    }
  }, [userId, secretCodeDraft]);

  /** File a note into a tab (null = main notes, 'papers' = papers tab). */
  const fileNote = useCallback(
    async (noteId: string, tabId: string | null) => {
      setFileNoteId(null);
      setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, tab_id: tabId } : n)));
      try {
        await engine.moveNoteToTab(noteId, tabId);
      } catch (e) {
        console.warn('moveNoteToTab failed', e);
      }
    },
    [],
  );

  // ── family members ──
  // detailed family roster (manager + members); also drives the member count
  const refreshFamilyMembers = useCallback(async (space: Space) => {
    setMembersBusy(true);
    try {
      const members = await engine.getFamilyMembers(space.id);
      setFamilyMembers(members);
      setMemberCount(members.length);
    } catch {
      setFamilyMembers(null);
      setMemberCount(1);
    } finally {
      setMembersBusy(false);
    }
  }, []);

  // ── side menu open/close (slides from the left) ──
  // loadHistory is defined below; the ref bridges the declaration order
  const loadHistoryRef = useRef<() => void>(() => {});
  const openMenu = useCallback(() => {
    setMenuOpen(true);
    menuX.setValue(-320);
    Animated.timing(menuX, { toValue: 0, duration: 220, useNativeDriver: false }).start();
    loadHistoryRef.current(); // fresh delete-countdowns every time the menu opens
  }, [menuX]);

  const closeMenu = useCallback(() => {
    setHistVisible(10); // collapse the history list back to 10 next open
    Animated.timing(menuX, { toValue: -320, duration: 200, useNativeDriver: false }).start(
      () => setMenuOpen(false),
    );
  }, [menuX]);

  // ── chat history (ChatGPT-style) ──
  // Sessions live in the side menu with a per-chat delete countdown.
  // The current chat survives 2 min after backgrounding; tapping
  // "new chat" archives it immediately. Retention comes from
  // profiles.chat_retention_days — the future paid-plans hook
  // (free=7, month=$1 → 30, year=$10 → 365): selling a plan later
  // is just updating that number, no app change needed.
  const serializeMessages = (msgs: ChatMsg[]): ChatMsg[] =>
    msgs
      .filter((m) => !m.pending && m.text.trim() && m.text !== '…')
      .slice(-MAX_HISTORY_MSGS)
      .map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        // local file:// photos don't survive a restart; remote URLs do
        photo: m.photo && m.photo.startsWith('http') ? m.photo : null,
        sources: m.sources,
      }));

  const sessionTitle = (msgs: ChatMsg[]): string => {
    const raw = (msgs.find((m) => m.role === 'user')?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!raw) return '💬';
    return raw.length > 42 ? raw.slice(0, 42) + '…' : raw;
  };

  const saveDraft = useCallback(async (msgs: ChatMsg[], sid: string) => {
    try {
      await AsyncStorage.setItem(
        ACTIVE_CHAT_KEY,
        JSON.stringify({
          sessionId: sid,
          messages: serializeMessages(msgs),
          updatedAt: Date.now(),
        }),
      );
    } catch {
      /* ignore */
    }
  }, []);

  const clearDraft = useCallback(async () => {
    try {
      await AsyncStorage.removeItem(ACTIVE_CHAT_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  /** insert-or-update one session row; sliding retention window */
  const persistSession = useCallback(async (sid: string, msgs: ChatMsg[], uid: string) => {
    if (msgs.length === 0) return;
    try {
      const iso = new Date().toISOString();
      const row = {
        user_id: uid,
        title: sessionTitle(msgs),
        messages: msgs,
        updated_at: iso,
        expires_at: new Date(Date.now() + retentionDaysRef.current * 86400000).toISOString(),
      };
      if (UUID_RE.test(sid)) {
        const { data } = await supabase
          .from('chat_sessions')
          .update(row)
          .eq('id', sid)
          .select('id');
        if (data && data.length > 0) return;
      }
      await supabase.from('chat_sessions').insert(row);
    } catch {
      /* table missing (migration not run yet) → history silently disabled */
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid) return;
    setHistoryLoading(true);
    try {
      const nowIso = new Date().toISOString();
      // sweep expired sessions for this user, then list the rest
      await supabase.from('chat_sessions').delete().eq('user_id', uid).lt('expires_at', nowIso);
      const { data, error } = await supabase
        .from('chat_sessions')
        .select('id,title,messages,updated_at,expires_at')
        .eq('user_id', uid)
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      setHistory(
        ((data ?? []) as Omit<ChatSession, 'ttl'>[]).map((s) => ({
          ...s,
          ttl: ttlText(s.expires_at),
        })),
      );
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  /** archive the current chat and start a fresh one */
  const startNewChat = useCallback(async () => {
    const oldSid = sessionIdRef.current;
    const msgs = serializeMessages(messagesRef.current);
    const uid = userId;
    sessionIdRef.current = newSessionId();
    setMessages([]);
    setLastAnswer(null);
    voiceModeRef.current = false;
    try {
      Speech.stop();
    } catch {
      /* ignore */
    }
    await clearDraft();
    if (uid && msgs.length > 0) await persistSession(oldSid, msgs, uid);
    loadHistory();
    closeMenu();
  }, [userId, clearDraft, persistSession, loadHistory, closeMenu, setLastAnswer]);

  const openSession = useCallback(
    async (s: ChatSession) => {
      closeMenu();
      if (s.id === sessionIdRef.current) return;
      const current = serializeMessages(messagesRef.current);
      if (userId && current.length > 0) {
        await persistSession(sessionIdRef.current, current, userId);
      }
      sessionIdRef.current = s.id;
      setMessages(s.messages);
      setLastAnswer(null);
      voiceModeRef.current = false;
      try {
        Speech.stop();
      } catch {
        /* ignore */
      }
      await saveDraft(s.messages, s.id);
      loadHistory();
    },
    [userId, persistSession, saveDraft, loadHistory, closeMenu, setLastAnswer],
  );

  const deleteSession = useCallback(async (id: string) => {
    setHistory((prev) => prev.filter((s) => s.id !== id));
    if (id === sessionIdRef.current) sessionIdRef.current = newSessionId();
    try {
      await supabase.from('chat_sessions').delete().eq('id', id);
    } catch {
      /* ignore */
    }
  }, []);

  // debounced draft persistence: the in-progress chat survives app kills;
  // the 2-min background rule decides whether it stays open or is archived
  useEffect(() => {
    if (!userId) return;
    const t = setTimeout(() => {
      saveDraft(messages, sessionIdRef.current);
    }, 800);
    return () => clearTimeout(t);
  }, [messages, userId, saveDraft]);

  // keep the menu-open refresh pointing at the latest loadHistory
  useEffect(() => {
    loadHistoryRef.current = loadHistory;
  }, [loadHistory]);

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
        await Share.share({ message: tx('shareInviteText', { code: inviteCode }) });
      } catch {}
    }
  }, [inviteCode]);

  const shareInvite = useCallback(async () => {
    if (!inviteCode) return;
    const text = tx('joinWithCode', { code: inviteCode });
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
        refreshFamilyMembers(joined);
        refreshNotes(joined.id);
        refreshItems(joined.id);
        refreshThings(joined.id);
        refreshFamily(joined.id);
        refreshTabs(joined.id);
      }
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : t('joinFail'));
    } finally {
      setJoinBusy(false);
    }
  }, [joinCode, joinBusy, refreshFamilyMembers, refreshNotes, refreshItems, refreshThings, refreshFamily, refreshTabs]);


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
        speak(text); // voice in → voice out; text in → silent (speak no-ops)
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
          for (const target of targets) {
            const [n, i] = await Promise.all([
              engine.listNotes(target.id, 30),
              engine.listItems(target.id, 60),
            ]);
            allNotes.push(...n);
            allItems.push(...i);
          }
          const local = answerLocally(q, allNotes, allItems, getLang());
          if (local) done(local.answer, local.sources, local.item ?? null, true);
          else done(t('noAnswer'), [], null, true);
        } catch {
          done(t('askFail'), [], null, true);
        }
      }
    },
    [spaces, pushMsg, updateMsg, setLastAnswer, chatHistory, speak],
  );

  /** Conversational correction: t('exampleCorrection') → update the item. */
  const doCorrect = useCallback(
    async (text: string) => {
      const item = lastAnswerItemRef.current;
      const place = item ? extractCorrectionPlace(text) : null;
      if (!item || !place) return;
      try {
        await engine.updateItemDetails(item.id, place);
        setLastAnswer({ ...item, details: place });
        const msg = tx('updatedPlace', { title: item.title, place });
        pushMsg('app', msg);
        speak(msg);
      } catch (e) {
        console.warn('correction failed', e);
      }
    },
    [pushMsg, setLastAnswer, speak],
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
    await initLanguage();
    try {
      const v = await AsyncStorage.getItem(VOICE_REPLY_KEY);
      const on = v !== '0';
      setVoiceReplyOn(on);
      voiceReplyRef.current = on;
    } catch {
      /* keep default (on) */
    }
    try {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session) {
        setAuthState('signed-out');
        return;
      }
      const user = session.user;
      setUserId(user.id);
      userIdRef.current = user.id;
      setIsAnonymous(!!user.is_anonymous);
      setUserEmail(user.email ?? null);
      setMemberSince(user.created_at ?? null);
      engine
        .getMyProfile()
        .then((p) => {
          setDisplayName(p?.display_name ?? null);
          setNameDraft(p?.display_name ?? '');
        })
        .catch(() => {});
      setSpaces(await engine.ensureDefaultSpaces(user.id));
      setAuthState('signed-in');
      // custom-tab free-tier cap (future paid plans raise it)
      engine
        .getCustomTabLimit(user.id)
        .then(setTabLimit)
        .catch(() => {});
      // trash retention tier: 0 = free (permanent delete), 30 = Plus (30-day trash)
      engine
        .getTrashRetention(user.id)
        .then(setTrashRetention)
        .catch(() => {});
      // secret vault tab (paid feature; owner-only settings)
      engine
        .getSecretVault(user.id)
        .then(setSecretVault)
        .catch(() => {});
      // chat history: retention tier (future paid plans), draft restore, history list
      try {
        const { data: prof } = await supabase
          .from('profiles')
          .select('chat_retention_days')
          .eq('id', user.id)
          .maybeSingle();
        if (prof?.chat_retention_days) retentionDaysRef.current = prof.chat_retention_days;
      } catch {
        /* keep default 7 */
      }
      try {
        const raw = await AsyncStorage.getItem(ACTIVE_CHAT_KEY);
        if (raw) {
          const d = JSON.parse(raw) as {
            sessionId: string;
            messages: ChatMsg[];
            updatedAt: number;
          };
          if (Date.now() - d.updatedAt > HISTORY_IDLE_MS) {
            // stale draft (app was killed long ago) → archive it silently
            if (d.messages?.length > 0) await persistSession(d.sessionId, d.messages, user.id);
            await clearDraft();
          } else if (d.messages?.length > 0) {
            sessionIdRef.current = d.sessionId;
            setMessages(d.messages);
          }
        }
      } catch {
        /* ignore */
      }
      loadHistory();
      // Phase 3: register this device for family push notifications (no-op on web)
      registerForPushNotifications().then((token) => {
        if (token) engine.registerPushToken(user.id, token, Platform.OS).catch(() => {});
      });
    } catch (e) {
      console.warn('boot failed', e);
    } finally {
      setLoading(false);
    }
  }, [persistSession, clearDraft, loadHistory]);

  const handleAuthEvent = useCallback(
    (event: string, session: { user: { id: string; is_anonymous?: boolean } } | null) => {
      if (event === 'SIGNED_OUT') {
        setUserId(null);
        setUserEmail(null);
        setMemberSince(null);
        setDisplayName(null);
        setNameDraft('');
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
      setUpgradeError(t('invalidEmail'));
      return;
    }
    setUpgradeBusy(true);
    setUpgradeError(null);
    try {
      await linkEmailToAnonymous(clean);
      setUpgradeSent(true);
    } catch (e) {
      setUpgradeError(e instanceof Error ? e.message : t('genericFail'));
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

  // chat lifecycle: the current chat stays open 2 min after backgrounding
  // (grace period); past that it's archived into history and a fresh chat
  // starts. Tapping "new chat" archives immediately — same as ChatGPT.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') {
        backgroundedAtRef.current = Date.now();
        saveDraft(messagesRef.current, sessionIdRef.current);
        try {
          Speech.stop();
        } catch {
          /* ignore */
        }
      } else if (s === 'active') {
        refreshTheme(); // auto dark/light follows the time of day
        const away = Date.now() - backgroundedAtRef.current;
        backgroundedAtRef.current = 0;
        if (away > HISTORY_IDLE_MS) {
          startNewChat();
        }
      }
    });
    return () => sub.remove();
  }, [saveDraft, startNewChat, refreshTheme]);

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

  /** t('exampleTask') in the family space → creates an assigned task item. */
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
        pushMsg('app', tx('taskAssigned', { name: asg.name, task: asg.task }));
        engine
          .notifySpace(spaceId, t('familyTask'), `${asg.name}: ${asg.task}`, uid)
          .catch(() => {});
      } catch (e) {
        console.warn('assign-task failed', e);
      }
    },
    [pushMsg],
  );

  /**
   * "يا جون جيب تفاح خيار بندورة" → creates a shopping list for جون,
   * notifies ONLY him (targeted push), everyone sees the list in the
   * family space. Returns true when handled (caller skips the agent).
   * Falls through to the normal flow when the name doesn't resolve —
   * never notify the wrong person.
   */
  const maybeDirectedShopping = useCallback(
    async (text: string, noteId?: string): Promise<boolean> => {
      const parsed = parseDirectedShopping(text);
      if (!parsed || !userId) return false;
      const famId = spaceIdByType('family');
      if (!famId) return false;
      let members: FamilyMember[] | null = null;
      try {
        members = await engine.getFamilyMembers(famId);
      } catch {
        return false;
      }
      const match = resolveFamilyMember(parsed.name, members ?? []);
      // Unresolved name → still create the list, but unassigned (visible to
      // the whole family, no push). Never fail silently: the chat message
      // says exactly what happened.
      const items = splitShoppingItems(parsed.itemsRaw);
      if (items.length === 0) return false;
      const assigneeName = match?.display_name ?? parsed.name;
      try {
        const list = await engine.createShoppingList({
          spaceId: famId,
          title: tx('shopListTitle', { name: assigneeName }),
          assignedTo: match?.user_id ?? null,
          assignedName: match?.display_name ?? null,
          items,
          userId,
        });
        // the list IS the record — drop the raw voice note now (only after
        // the list exists) so extraction can't duplicate its items
        if (noteId) {
          try {
            await engine.deleteNote(noteId);
          } catch {
            /* best effort */
          }
        }
        setShopLists((prev) => [list, ...prev]);
        let msg: string;
        if (match?.user_id) {
          // targeted push: only the assignee, never the whole family
          const speaker = displayName ?? userEmail ?? '';
          engine
            .notifyUser(
              match.user_id,
              t('shopListPushTitle'),
              tx('shopListPushBody', {
                by: speaker,
                items: items.join('، '),
              }),
            )
            .catch(() => {});
          msg = tx('shopListCreated', {
            name: assigneeName,
            items: items.join('، '),
          });
        } else {
          msg = tx('shopListUnassigned', {
            name: parsed.name,
            items: items.join('، '),
          });
        }
        pushMsg('app', msg);
        speak(msg);
        return true;
      } catch (e) {
        console.warn('directed-shopping failed', e);
        return false;
      }
    },
    [userId, spaceIdByType, displayName, userEmail, pushMsg, speak],
  );

  // ── chat: voice note polling ──
  // ── legacy pipeline (route → ask/correct/save): fallback when the agent is unreachable ──
  const legacyVoice = useCallback(
    async (transcript: string, n: { id: string }, msgId: string) => {
      updateMsg(msgId, { text: transcript, pending: false });
      // AI router (with conversation memory) decides: answer it,
      // save it, or treat it as a correction — like ChatGPT would.
      const { action: route, space_type } = await routeInput(transcript);
      if (route === 'question') {
        try {
          await engine.deleteNote(n.id);
        } catch { /* best effort */ }
        doAsk(transcript, null);
        return;
      }
      if (route === 'correction') {
        try {
          await engine.deleteNote(n.id);
        } catch { /* best effort */ }
        doCorrect(transcript);
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
        const msg = tx('savedInSpace', { space: SPACE_LABELS[finalType] });
        pushMsg('app', msg);
        speak(msg);
        if (userId) await maybeAssignTask(finalType, transcript, targetId, userId);
      } else {
        const msg = t('saved');
        pushMsg('app', msg);
        speak(msg);
      }
    },
    [routeInput, doAsk, doCorrect, pushMsg, updateMsg, maybeAssignTask, userId, spaceIdByType, speak],
  );

  // ── THE AGENT BRAIN: one call understands + acts (with legacy fallback) ──
  const doChatVoice = useCallback(
    async (t: string, n: { id: string }, msgId: string) => {
      voiceModeRef.current = true; // this whole exchange is voice → reply with voice
      updateMsg(msgId, { text: t, pending: false });
      // "يا جون جيب تفاح…" (voice) → shopping list; the note is dropped, the list is the record
      if (await maybeDirectedShopping(t, n.id)) return;
      const thinkId = pushMsg('app', '…', { pending: true });
      const r = await engine.chat(t, chatHistory(), n.id, null, getLang());
      if (r) {
        updateMsg(thinkId, { text: r.answer, pending: false });
        speak(r.answer);
      } else {
        removeMsg(thinkId);
        await legacyVoice(t, n, msgId);
      }
    },
    [chatHistory, pushMsg, updateMsg, removeMsg, legacyVoice, speak, maybeDirectedShopping],
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
              updateMsg(msgId, { text: t('transcribeFail'), pending: false });
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
          updateMsg(msgId, { text: t('transcribeSlow'), pending: false });
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
      // attached photo goes with the note: upload it before saving
      const photoUri = chatPhotoUri;
      setChatPhotoUri(null);
      const msgId = pushMsg('user', t('transcribing'), { pending: true, photo: photoUri });
      setSaving(true);
      try {
        const photoUrl = photoUri ? await engine.uploadNotePhoto(photoUri, userId).catch(() => null) : null;
        if (photoUri && !photoUrl) {
          updateMsg(msgId, { photo: null });
          pushMsg('app', t('photoFailVoice'));
        }
        const note = await engine.saveVoiceNote(spaceId, audio, userId, photoUrl);
        pollChatNote(note.id, msgId);
      } catch (e) {
        console.warn('saveVoiceNote failed', e);
        updateMsg(msgId, { text: t('recordFail'), pending: false });
      } finally {
        setSaving(false);
      }
    } else {
      await start();
    }
  }, [isRecording, stop, start, userId, spaceIdByType, pollChatNote, pushMsg, updateMsg, chatPhotoUri]);

  // ── chat: text send ──
  // ── chat: text send — the agent brain first, legacy pipeline as fallback ──
  const legacyText = useCallback(
    async (clean: string, photoUrl?: string | null) => {
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
        const note = await engine.saveTextNote(spaceId, clean, userId, photoUrl);
        // The AI chose the space inside route — no separate classify call.
        const finalType = space_type;
        const targetId = spaceIdByType(finalType);
        if (targetId) {
          try {
            await engine.moveNote(note.id, targetId);
          } catch (e) {
            console.warn('auto space move failed', e);
          }
          pushMsg('app', tx('savedInSpace', { space: SPACE_LABELS[finalType] }));
          await maybeAssignTask(finalType, clean, targetId, userId);
        } else {
          pushMsg('app', t('saved'));
        }
      } catch (e) {
        console.warn('saveTextNote failed', e);
        pushMsg('app', t('saveFail'));
      } finally {
        setSavingText(false);
      }
    },
    [userId, spaceIdByType, routeInput, pushMsg, doAsk, doCorrect, maybeAssignTask],
  );

  const onSendText = useCallback(async () => {
    const clean = textNote.trim();
    if (!clean || !userId) return;
    // 🔒 secret vaults: a saved code opens ITS vault page — never saved as a note
    if (secretVault.enabled) {
      const vault = secretVault.vaults.find((v) => v.code === clean);
      if (vault) {
        setTextNote('');
        void openSecretVault(vault.id);
        return;
      }
    }
    voiceModeRef.current = false; // text in → text out (no voice reply)
    // attached photo goes with the note: upload it before the agent runs
    const photoUri = chatPhotoUri;
    setChatPhotoUri(null);
    const userMsgId = pushMsg('user', clean, { photo: photoUri });
    setTextNote('');
    // "يا جون جيب تفاح…" → shopping list (no agent round-trip); photo+list combo → normal flow
    if (!photoUri && (await maybeDirectedShopping(clean))) return;
    const photoUrl = photoUri
      ? await engine.uploadNotePhoto(photoUri, userId).catch(() => null)
      : null;
    if (photoUri && !photoUrl) {
      updateMsg(userMsgId, { photo: null });
      pushMsg('app', t('photoFailNote'));
    }
    const thinkId = pushMsg('app', '…', { pending: true });
    const r = await engine.chat(clean, chatHistory(), undefined, photoUrl, getLang());
    if (r) {
      updateMsg(thinkId, { text: r.answer, pending: false });
    } else {
      removeMsg(thinkId);
      await legacyText(clean, photoUrl);
    }
  }, [textNote, userId, pushMsg, updateMsg, removeMsg, chatHistory, legacyText, chatPhotoUri, maybeDirectedShopping, openSecretVault, secretVault]);

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
        refreshTabs(s.id);
        if (s.type === 'family') {
          refreshFamily(s.id);
          refreshFamilyMembers(s);
          // realtime: any family member's change refreshes everyone's lists
          itemsSub.current = engine.subscribeItems(s.id, () => {
            refreshFamily(s.id);
            refreshItems(s.id);
            refreshThings(s.id);
          });
        }
      }
    },
    [pickSpace, refreshNotes, refreshItems, refreshFamily, refreshThings, refreshTabs, refreshFamilyMembers],
  );

  // ── family manager: remove a member (two taps to confirm) ──
  const doRemoveMember = useCallback(
    async (space: Space, memberId: string) => {
      if (confirmRemove !== memberId) {
        setConfirmRemove(memberId);
        return;
      }
      setConfirmRemove(null);
      try {
        await engine.removeMember(space.id, memberId);
        await refreshFamilyMembers(space);
      } catch (e) {
        console.warn('remove member failed', e);
      }
    },
    [confirmRemove, refreshFamilyMembers],
  );

  // ── save own display name (profile modal) ──
  const saveDisplayName = useCallback(async () => {
    setNameError(null);
    setNameSaving(true);
    try {
      await engine.setDisplayName(nameDraft);
      const clean = nameDraft.trim();
      setDisplayName(clean ? clean : null);
      setNameSavedTick(true);
      setTimeout(() => setNameSavedTick(false), 2500);
      const fs = pickSpace('family');
      if (fs) await refreshFamilyMembers(fs);
    } catch {
      setNameError(t('nameSaveFail'));
    } finally {
      setNameSaving(false);
    }
  }, [nameDraft, pickSpace, refreshFamilyMembers]);

  // ── member leaves the family (two taps to confirm) ──
  const doLeaveFamily = useCallback(
    async (space: Space) => {
      if (!confirmLeave) {
        setConfirmLeave(true);
        return;
      }
      setConfirmLeave(false);
      try {
        await engine.leaveSpace(space.id);
        const fresh = await engine.listSpaces();
        setSpaces(fresh);
        setViewSpace(null);
        setView('chat');
        setFamilyMembers(null);
      } catch (e) {
        console.warn('leave failed', e);
      }
    },
    [confirmLeave],
  );

  // ── Shopping is list-only: manual list creator (+ assignee picker) ──
  const createManualList = useCallback(async () => {
    const items = splitShoppingItems(newListItems);
    const sid = viewSpace?.id;
    if (items.length === 0 || !sid || !userId) return;
    const member = (familyMembers ?? []).find((m) => m.user_id === newListAssignee) ?? null;
    const assigneeName = member?.display_name ?? null;
    const title =
      newListTitle.trim() ||
      (assigneeName ? tx('shopListTitle', { name: assigneeName }) : t('shopListGenericTitle'));
    setNewListOpen(false);
    setNewListTitle('');
    setNewListItems('');
    setNewListAssignee(null);
    try {
      const list = await engine.createShoppingList({
        spaceId: sid,
        title,
        assignedTo: member?.user_id ?? null,
        assignedName: assigneeName,
        items,
        userId,
      });
      setShopLists((prev) => [list, ...prev]);
      if (member?.user_id) {
        const speaker = displayName ?? userEmail ?? '';
        engine
          .notifyUser(
            member.user_id,
            t('shopListPushTitle'),
            tx('shopListPushBody', { by: speaker, items: items.join('، ') }),
          )
          .catch(() => {});
      }
    } catch (e) {
      console.warn('createManualList failed', e);
    }
  }, [newListItems, newListTitle, newListAssignee, viewSpace, userId, familyMembers, displayName, userEmail]);

  /**
   * Transition helper: sweep any loose shopping items (created before the
   * list-only change, or by the old extract fn before its redeploy) into one
   * unassigned list so nothing stays invisible.
   */
  const adoptLooseShopping = useCallback(
    async (spaceId: string, loose: Item[]) => {
      if (loose.length === 0 || !userId) return;
      try {
        const list = await engine.createShoppingList({
          spaceId,
          title: t('shopListGenericTitle'),
          assignedTo: null,
          assignedName: null,
          items: [],
          userId,
        });
        await engine.attachItemsToList(
          loose.map((i) => i.id),
          list.id,
        );
        setShopping([]);
        const withItems = await engine.listShoppingLists(spaceId);
        setShopLists(withItems);
      } catch (e) {
        console.warn('adoptLooseShopping failed', e);
      }
    },
    [userId],
  );

  // list-only shopping: sweep stray loose items into one unassigned list
  // (once per space — covers items made before this change)
  useEffect(() => {
    adoptedRef.current = null;
  }, [viewSpace?.id]);
  useEffect(() => {
    const sid = viewSpace?.id;
    if (!sid || shopping.length === 0 || adoptedRef.current) return;
    adoptedRef.current = sid;
    void adoptLooseShopping(sid, shopping);
  }, [viewSpace?.id, shopping, adoptLooseShopping]);

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
          .notifySpace(sid, t('familyTask'), `${name}: ${item.title}`, userId)
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
      {item.photo ? (
        <Pressable onPress={() => setPhotoViewer(item.photo!)}>
          <Image source={{ uri: item.photo }} style={styles.bubblePhoto} />
        </Pressable>
      ) : null}
      {item.pending && item.text === '…' ? (
        <ActivityIndicator size="small" color={P.info} />
      ) : (
        <Text style={[styles.bubbleText, item.role === 'user' && styles.bubbleTextUser]}>
          {item.text}
        </Text>
      )}
      {item.pending && item.text !== '…' && (
        <ActivityIndicator size="small" color={P.paper} style={styles.bubbleSpinner} />
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
            <View style={styles.cardTopActions}>
              {item.audio_url ? (
                <Pressable onPress={() => togglePlay(item)} style={styles.playBtn}>
                  <Text style={styles.playBtnText}>
                    {playingId === item.id && playerStatus.playing ? t('pause') : t('play')}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => setMovePickerFor(movePickerFor === item.id ? null : item.id)}
                style={styles.moveBtn}
              >
                <Text style={styles.moveBtnText}>
                  {movingId === item.id ? '…' : t('move')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setFileNoteId(item.id)}
                style={styles.moveBtn}
                accessibilityLabel={t('moveToTab')}
              >
                <Text style={styles.moveBtnText}>📁</Text>
              </Pressable>
            </View>
          </View>

          {movePickerFor === item.id && (
            <View style={styles.moveRow}>
              <Text style={styles.moveLabel}>{t('moveTo')}</Text>
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
          {item.photo_url ? (
            <Pressable onPress={() => setPhotoViewer(item.photo_url!)} style={{ marginTop: 8 }}>
              <Image source={{ uri: item.photo_url }} style={styles.cardPhoto} />
            </Pressable>
          ) : null}
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

  /** Secret vault note card: edit + delete, exactly like app note cards. */
  const renderSecretNote = ({ item }: { item: Note }) => {
    const editing = secretEditingId === item.id;
    const delArmed = secretDelId === item.id;
    return (
      <View style={styles.card}>
        <View style={styles.cardTop}>
          <Text style={styles.cardMeta}>
            {new Date(item.created_at).toLocaleString()}
            {item.duration_sec ? ` · ${fmtTime(item.duration_sec)}` : ''}
          </Text>
          {!editing && (
            <View style={styles.cardTopActions}>
              <Pressable onPress={() => startEditSecret(item)} style={styles.moveBtn}>
                <Text style={styles.moveBtnText}>✏️</Text>
              </Pressable>
              <Pressable onPress={() => askDeleteSecret(item.id)} style={styles.moveBtn}>
                <Text style={styles.moveBtnText}>{delArmed ? '⚠️' : '🗑️'}</Text>
              </Pressable>
            </View>
          )}
        </View>
        {delArmed && <Text style={styles.upgradeErr}>{t('secretDelConfirm')}</Text>}
        {editing ? (
          <View>
            <TextInput
              style={[styles.vaultEditInput, { textAlign: ta() }]}
              value={secretEditDraft}
              onChangeText={setSecretEditDraft}
              multiline
              maxLength={2000}
              autoFocus
            />
            <View style={styles.vaultEditRow}>
              <Pressable onPress={() => void saveEditSecret()} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>{t('save')}</Text>
              </Pressable>
              <Pressable onPress={() => setSecretEditingId(null)}>
                <Text style={styles.famLinkText}>{t('cancel')}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Text style={styles.cardText}>{item.transcript}</Text>
        )}
        {item.photo_url ? (
          <Pressable onPress={() => setPhotoViewer(item.photo_url!)} style={{ marginTop: 8 }}>
            <Image source={{ uri: item.photo_url }} style={styles.cardPhoto} />
          </Pressable>
        ) : null}
      </View>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color={P.accent} />
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
  // notes filed under the active tab: null = main notes, 'papers' = papers tab,
  // otherwise a custom tab id. Search always spans everything.
  const activeTabId =
    viewSpace?.type === 'family'
      ? familyTab === 'notes'
        ? null
        : familyTab
      : spaceTab === 'notes'
        ? null
        : spaceTab;
  const listData = (() => {
    const base = inSearch ? (searchResults?.notes ?? []) : notes;
    if (inSearch) return base;
    return base.filter((n) => (n.tab_id ?? null) === activeTabId);
  })();

  // notes browser (shared by all spaces; family shows it under the 📝 tab)
  // ── Phase 4: 📦 أشيائي list (shared by all space views) ──
  const thingsList = (
    <FlatList
      style={styles.fill}
      data={things}
      keyExtractor={(i) => i.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <Text style={styles.muted}>{t('thingsEmpty')}</Text>
      }
      renderItem={({ item }) => {
        const photoUrl = item.meta?.photo_url ?? null;
        const br = borrowFor(item.title);
        return (
          <View style={styles.famRow}>
            {photoUrl ? (
              <Pressable onPress={() => setPhotoViewer(photoUrl)}>
                <Image source={{ uri: photoUrl }} style={styles.thingThumb} />
              </Pressable>
            ) : (
              <Text style={styles.itemIcon}>📦</Text>
            )}
            <View style={styles.itemBody}>
              <Text style={styles.itemTitle}>{item.title}</Text>
              {item.details ? (
                <Text style={styles.itemDetails}>📍 {item.details}</Text>
              ) : null}
              {item.meta?.price ? (
                <Text style={styles.itemDue}>💰 {item.meta.price}</Text>
              ) : null}
              {br ? (
                <Text style={styles.borrowBadge}>
                  {tx('borrowWith', { name: br.borrower })}
                  {br.due_at ? tx('dueBack', { date: br.due_at.slice(0, 10) }) : ''}
                </Text>
              ) : null}
              {br ? (
                <Pressable onPress={() => onReturnBorrow(br)}>
                  <Text
                    style={[
                      styles.returnBtn,
                      confirmReturnId === br.id && styles.returnBtnConfirm,
                    ]}
                  >
                    {confirmReturnId === br.id ? t('confirmReturn') : t('returned')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <Pressable
              onPress={() => askPhotoSource(item)}
              style={styles.photoBtn}
              disabled={uploadingPhotoId === item.id}
            >
              <Text style={styles.photoBtnText}>
                {uploadingPhotoId === item.id ? '…' : '📷'}
              </Text>
            </Pressable>
          </View>
        );
      }}
    />
  );

  const notesBrowser = (
    <>
      <View style={styles.searchWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('searchPh')}
          placeholderTextColor={P.faint}
          style={styles.searchInput}
        />
        {searching && <ActivityIndicator size="small" color={P.accent} />}
      </View>

      <FlatList
        style={styles.fill}
        data={listData}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.muted}>
            {inSearch ? t('noResults') : t('notesEmpty')}
          </Text>
        }
        ListHeaderComponent={
          inSearch && searchResults && searchResults.items.length > 0 ? (
            <View style={styles.searchItems}>
              <Text style={styles.searchItemsLabel}>
                {tx('searchItems', { count: String(searchResults.items.length) })}
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
    ['members', t('tabFamily')],
    ['shopping', t('tabShop')],
    ['tasks', t('tabTasks')],
    ['agenda', t('tabAgenda')],
    ['things', t('tabThings')],
    ['notes', t('tabNotes')],
  ] as const;
  const FAMILY_BUILTIN: ReadonlySet<string> = FAMILY_BUILTIN_KEYS;

  const TAB_ICON_CHOICES = ['📁', '📄', '💡', '🏠', '✈️', '💰', '🎓', '❤️', '🛒', '📌'];

  /**
   * Horizontal tab bar: built-in tabs + user-created tabs + ＋.
   * Long-press a custom tab (owner only) for rename/delete.
   */
  const renderTabBar = (
    builtIns: readonly (readonly [string, string])[],
    active: string,
    onPick: (id: string) => void,
    canManage: boolean,
  ) => {
    const menuTab = spaceTabs.find((x) => x.id === tabMenuId) ?? null;
    return (
      <>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBar}
          contentContainerStyle={styles.tabBarInner}
        >
          {builtIns.map(([k, label]) => (
            <Pressable
              key={k}
              onPress={() => {
                onPick(k);
                setTabMenuId(null);
              }}
              style={[styles.tab, active === k && styles.tabActive]}
            >
              <Text style={[styles.tabText, active === k && styles.tabTextActive]}>{label}</Text>
            </Pressable>
          ))}
          {spaceTabs.map((tb) => (
            <Pressable
              key={tb.id}
              onPress={() => {
                onPick(tb.id);
                setTabMenuId(null);
              }}
              onLongPress={() => canManage && setTabMenuId(tabMenuId === tb.id ? null : tb.id)}
              delayLongPress={400}
              style={[styles.tab, active === tb.id && styles.tabActive]}
            >
              <Text style={[styles.tabText, active === tb.id && styles.tabTextActive]}>
                {tb.icon} {tb.title}
              </Text>
            </Pressable>
          ))}
          {canManage && (
            <Pressable
              onPress={() => {
                setEditingTab(null);
                setTabName('');
                setTabIcon('📁');
                setTabModalOpen(true);
              }}
              style={styles.tabAdd}
              accessibilityLabel={t('newTab')}
            >
              <Text style={styles.tabAddText}>＋</Text>
            </Pressable>
          )}
        </ScrollView>
        {menuTab && (
          <View style={styles.tabMenu}>
            <Pressable
              onPress={() => {
                setEditingTab(menuTab);
                setTabName(menuTab.title);
                setTabIcon(menuTab.icon);
                setTabMenuId(null);
                setTabModalOpen(true);
              }}
              style={styles.tabMenuBtn}
            >
              <Text style={styles.tabMenuText}>✏️ {t('renameTab')}</Text>
            </Pressable>
            <Pressable
              onPress={() => askDeleteTab(menuTab)}
              style={[styles.tabMenuBtn, styles.tabMenuDel]}
            >
              <Text style={styles.tabMenuText}>🗑️ {t('deleteTab')}</Text>
            </Pressable>
          </View>
        )}
      </>
    );
  };

  // family manager = the space owner; only they can invite/remove members
  const famSpace = viewSpace?.type === 'family' ? viewSpace : null;
  const isManager = !!userId && !!famSpace && famSpace.owner_id === userId;
  // custom tabs: only the space owner creates/renames/deletes them
  const canManageTabs = !!userId && !!viewSpace && viewSpace.owner_id === userId;
  const drawerFamSpace = pickSpace('family');
  const drawerIsManager = !!userId && !!drawerFamSpace && drawerFamSpace.owner_id === userId;

  // shopping is list-only: active lists + archived history
  const activeLists = shopLists.filter((l) => l.status !== 'done');
  const archivedLists = shopLists.filter((l) => l.status === 'done');
  const fmtDay = (iso: string) =>
    new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar' : 'en', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    });

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Pressable onPress={openMenu} style={styles.iconBtn}>
            <Text style={styles.iconBtnText}>☰</Text>
          </Pressable>
          <View>
            <Text style={styles.title}>{t('appTitle')}</Text>
            <Text style={styles.subtitle}>Lost it? Mawjood.</Text>
          </View>
        </View>
        <Pressable onPress={() => setShowDemo((v) => !v)} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>🧪</Text>
        </Pressable>
      </View>

      {showDemo && (
        <View style={styles.demoPanel}>
          <Text style={styles.demoTitle}>{t('demoTitle')}</Text>
          <View style={styles.demoRow}>
            <Pressable onPress={onSeedDemo} style={styles.demoAction}>
              <Text style={styles.demoActionText}>{t('demoAdd')}</Text>
            </Pressable>
            {demoNoteIds.length > 0 && (
              <Pressable onPress={onClearDemo} style={[styles.demoAction, styles.demoDanger]}>
                <Text style={styles.demoActionText}>{tx('demoClear', { count: demoNoteIds.length })}</Text>
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
            {t('tabHome')}
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
          <Text style={styles.upgradeText}>{t('trialBanner')}</Text>
          <View style={styles.upgradeRow}>
            <TextInput
              value={upgradeEmail}
              onChangeText={setUpgradeEmail}
              placeholder="you@example.com"
              placeholderTextColor={P.faint}
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
                <ActivityIndicator color={P.paper} />
              ) : (
                <Text style={styles.upgradeBtnText}>{t('save')}</Text>
              )}
            </Pressable>
          </View>
          {upgradeError ? <Text style={styles.upgradeErr}>{upgradeError}</Text> : null}
        </View>
      )}
      {isAnonymous && upgradeSent && (
        <View style={styles.upgradeBanner}>
          <Text style={styles.upgradeText}>{t('confirmEmailSent')}</Text>
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
                  {(displayName?.[0] ?? userEmail?.[0] ?? '؟').toUpperCase()}
                </Text>
              </View>
              <View style={styles.menuProfileInfo}>
                <Text style={[styles.menuEmail, { textAlign: ta() }]} numberOfLines={1}>
                  {displayName ?? userEmail ?? t('trialAccount')}
                </Text>
                {displayName && userEmail ? (
                  <Text style={[styles.menuEmailSub, { textAlign: ta() }]} numberOfLines={1}>
                    {userEmail}
                  </Text>
                ) : null}
                <Text style={[styles.menuBadge, { textAlign: ta() }]}>
                  {isAnonymous ? t('trialBadge') : t('permAccountBadge')}
                </Text>
              </View>
            </View>


            <ScrollView style={styles.menuScroll} showsVerticalScrollIndicator={false}>

            <Pressable
              style={styles.menuItem}
              onPress={() => {
                closeMenu();
                setProfileOpen(true);
              }}
            >
              <Text style={styles.menuItemIcon}>👤</Text>
              <Text style={[styles.menuItemText, { textAlign: ta() }]}>{t('menuProfile')}</Text>
            </Pressable>

            {drawerIsManager && (
              <Pressable
                style={styles.menuItem}
                onPress={() => openInviteFor(drawerFamSpace?.id ?? null)}
              >
                <Text style={styles.menuItemIcon}>✉️</Text>
                <Text style={[styles.menuItemText, { textAlign: ta() }]}>{t('menuInvite')}</Text>
              </Pressable>
            )}

            <View style={styles.menuItem}>
              <Text style={styles.menuItemIcon}>💳</Text>
              <Text style={[styles.menuItemText, { textAlign: ta() }]}>{t('menuSubscription')}</Text>
              <Text style={styles.menuSoon}>{t('soon')}</Text>
            </View>

            <Pressable
              style={styles.menuItem}
              onPress={() => {
                closeMenu();
                setLanguage(lang === 'ar' ? 'en' : 'ar');
              }}
            >
              <Text style={styles.menuItemIcon}>🌐</Text>
              <Text style={[styles.menuItemText, { textAlign: ta() }]}>{t('menuLanguage')}</Text>
              <Text style={styles.menuSoon}>{lang === 'ar' ? 'EN' : 'عربي'}</Text>
            </Pressable>

            <Pressable
              style={styles.menuItem}
              onPress={() => {
                closeMenu();
                cycleTheme();
              }}
            >
              <Text style={styles.menuItemIcon}>{themeMode === 'light' ? '☀️' : themeMode === 'dark' ? '🌙' : '🌓'}</Text>
              <Text style={[styles.menuItemText, { textAlign: ta() }]}>{t('menuTheme')}</Text>
              <Text style={styles.menuSoon}>{themeMode === 'light' ? t('themeLight') : themeMode === 'dark' ? t('themeDark') : t('themeAuto')}</Text>
            </Pressable>

            <Pressable
              style={styles.menuItem}
              onPress={() => {
                closeMenu();
                setVoiceReply(!voiceReplyOn);
              }}
            >
              <Text style={styles.menuItemIcon}>{voiceReplyOn ? '🔊' : '🔇'}</Text>
              <Text style={[styles.menuItemText, { textAlign: ta() }]}>{t('menuVoiceReply')}</Text>
              <Text style={styles.menuSoon}>{voiceReplyOn ? '✓' : '–'}</Text>
            </Pressable>

            <Pressable
              style={styles.menuItem}
              onPress={() => {
                closeMenu();
                setAboutOpen(true);
              }}
            >
              <Text style={styles.menuItemIcon}>ℹ️</Text>
              <Text style={[styles.menuItemText, { textAlign: ta() }]}>{t('menuAbout')}</Text>
            </Pressable>

            {/* ── chat history (ChatGPT-style) — bottom of the drawer ── */}
            <View style={styles.histSection}>
              <Pressable style={styles.newChatBtn} onPress={startNewChat}>
                <Text style={styles.newChatBtnText}>{t('newChat')}</Text>
              </Pressable>
              <Text style={[styles.histTitle, { textAlign: ta() }]}>{t('chatHistory')}</Text>
              <View style={styles.histList}>
                {historyLoading ? (
                  <ActivityIndicator size="small" color={P.accentDeep} />
                ) : history.length === 0 ? (
                  <Text style={[styles.histEmpty, { textAlign: ta() }]}>{t('noHistory')}</Text>
                ) : (
                  history.slice(0, histVisible).map((sess) => (
                    <View key={sess.id} style={styles.histRow}>
                      <Pressable style={styles.histMain} onPress={() => openSession(sess)}>
                        <Text
                          style={[styles.histRowTitle, { textAlign: ta() }]}
                          numberOfLines={1}
                        >
                          {sess.title || '💬'}
                        </Text>
                        <Text style={[styles.histTtl, { textAlign: ta() }]}>
                          {sess.ttl}
                        </Text>
                      </Pressable>
                      <Pressable style={styles.histDel} onPress={() => deleteSession(sess.id)}>
                        <Text style={styles.histDelText}>✕</Text>
                      </Pressable>
                    </View>
                  ))
                )}
              </View>
              {histVisible < history.length && (
                <Pressable
                  style={styles.showMoreBtn}
                  onPress={() => setHistVisible((v) => v + 10)}
                >
                  <Text style={styles.showMoreText}>{t('showMore')}</Text>
                </Pressable>
              )}
              <Text style={[styles.histHint, { textAlign: ta() }]}>{t('historyHint')}</Text>
            </View>

            {trashRetention > 0 && (
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  closeMenu();
                  void openTrash();
                }}
              >
                <Text style={styles.menuItemIcon}>🗑️</Text>
                <Text style={[styles.menuItemText, { textAlign: ta() }]}>{t('menuTrash')}</Text>
              </Pressable>
            )}

            {!isAnonymous && authState === 'signed-in' && (
              <Pressable
                style={[styles.menuItem, styles.menuLogout]}
                onPress={() => {
                  closeMenu();
                  doSignOut();
                }}
              >
                <Text style={styles.menuItemIcon}>🚪</Text>
                <Text style={[styles.menuItemText, styles.menuLogoutText, { textAlign: ta() }]}>{t('menuLogout')}</Text>
              </Pressable>
            )}
            </ScrollView>
          </Animated.View>
        </View>
      )}

      {/* ── profile modal ── */}
      <Modal visible={profileOpen} transparent animationType="fade" onRequestClose={() => setProfileOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('profileTitle')}</Text>
            <View style={styles.profileRow}>
              <Text style={styles.profileLabel}>{t('emailLabel')}</Text>
              <Text style={styles.profileValue}>{userEmail ?? '—'}</Text>
            </View>
            <View style={styles.profileRow}>
              <Text style={styles.profileLabel}>{t('accountType')}</Text>
              <Text style={styles.profileValue}>{isAnonymous ? t('trial') : t('permanent')}</Text>
            </View>
            {memberSince ? (
              <View style={styles.profileRow}>
                <Text style={styles.profileLabel}>{t('memberSince')}</Text>
                <Text style={styles.profileValue}>
                  {new Date(memberSince).toLocaleDateString('ar')}
                </Text>
              </View>
            ) : null}
            <View style={styles.profileRow}>
              <Text style={styles.profileLabel}>{t('spacesLabel')}</Text>
              <Text style={styles.profileValue}>
                {spaces.length > 0 ? `${spaces.length}` : '—'}
              </Text>
            </View>
            <View style={styles.nameEditWrap}>
              <Text style={styles.profileLabel}>{t('displayNameLabel')}</Text>
              <TextInput
                style={[styles.nameInput, { textAlign: ta() }]}
                value={nameDraft}
                onChangeText={(t) => {
                  setNameDraft(t);
                  setNameError(null);
                }}
                placeholder={t('nameExample')}
                placeholderTextColor={P.faint2}
                maxLength={60}
              />
              {nameError ? <Text style={styles.upgradeErr}>{nameError}</Text> : null}
              <Pressable
                onPress={saveDisplayName}
                disabled={nameSaving}
                style={[styles.modalBtn, { marginTop: 8 }]}
              >
                <Text style={styles.modalBtnText}>
                  {nameSaving ? t('saving') : nameSavedTick ? t('nameSaved') : t('saveName')}
                </Text>
              </Pressable>
            </View>
            {secretVault.enabled ? (
              /* opsec: the section ALWAYS looks pristine — saving a code changes
                 nothing visually, so nobody holding the phone can tell a vault
                 exists. A new code simply opens a new vault page. */
              <View style={styles.nameEditWrap}>
                <Text style={styles.profileLabel}>🔒 {t('secretTab')}</Text>
                <Text style={[styles.modalBody, { marginTop: 0, marginBottom: 8 }]}>
                  {t('secretHint')}
                </Text>
                <TextInput
                  style={[styles.nameInput, { textAlign: ta() }]}
                  value={secretCodeDraft}
                  onChangeText={(x) => {
                    setSecretCodeDraft(x);
                    setSecretCodeMsg(null);
                  }}
                  placeholder={t('secretCodePlaceholder')}
                  placeholderTextColor={P.faint2}
                  maxLength={60}
                  secureTextEntry
                />
                {secretCodeMsg ? (
                  <Text style={secretCodeMsgOk ? { color: P.success, fontSize: 13, marginTop: 6 } : styles.upgradeErr}>
                    {secretCodeMsg}
                  </Text>
                ) : null}
                <Pressable onPress={() => void saveSecretCode()} style={[styles.modalBtn, { marginTop: 8 }]}>
                  <Text style={styles.modalBtnText}>{t('saveSecretCode')}</Text>
                </Pressable>
              </View>
            ) : null}
            <Pressable onPress={() => setProfileOpen(false)} style={[styles.modalBtn, { marginTop: 16 }]}>
              <Text style={styles.modalBtnText}>{t('close')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── about modal ── */}
      <Modal visible={aboutOpen} transparent animationType="fade" onRequestClose={() => setAboutOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('aboutTitle')}</Text>
            <Text style={styles.modalBody}>
              {t('aboutBody')}
              {'\n\n'}Lost it? Mawjood.
            </Text>
            <Pressable onPress={() => setAboutOpen(false)} style={[styles.modalBtn, { marginTop: 8 }]}>
              <Text style={styles.modalBtnText}>{t('close')}</Text>
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
                <Text style={styles.emptyTitle}>{t('emptyChatTitle')}</Text>
                <Text style={styles.emptySub}>
                  {t('emptyChatSub')}
                </Text>
              </View>
            }
            renderItem={renderMsg}
          />

          <View style={styles.chatFooter}>
            {chatPhotoUri ? (
              <View style={styles.photoPreview}>
                <Image source={{ uri: chatPhotoUri }} style={styles.photoPreviewImg} />
                <Pressable onPress={() => setChatPhotoUri(null)} style={styles.photoPreviewX}>
                  <Text style={styles.photoPreviewXText}>✕</Text>
                </Pressable>
                <Text style={styles.photoPreviewLabel}>{t('photoTalkOrType')}</Text>
              </View>
            ) : null}
            <View style={styles.inputRow}>
              {/* WhatsApp-style composer: camera inside the box, mic/send beside it */}
              <View style={styles.composerBox}>
                <Pressable onPress={askChatPhotoSource} style={styles.cameraBtn} hitSlop={8}>
                  <Text style={styles.cameraBtnText}>📷</Text>
                </Pressable>
                <TextInput
                  value={textNote}
                  onChangeText={setTextNote}
                  placeholder={t('chatPlaceholder')}
                  placeholderTextColor={P.faint}
                  style={styles.composerInput}
                  multiline
                  maxLength={2000}
                />
              </View>
              <Pressable
                onPress={textNote.trim() && !isRecording ? onSendText : onRecordPress}
                disabled={saving || savingText || asking}
                style={[
                  styles.micBtn,
                  isRecording && styles.micBtnRecording,
                  (saving || savingText || asking) && styles.micBtnDisabled,
                ]}
              >
                {saving || savingText ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.micBtnText}>
                    {isRecording ? '⏹' : textNote.trim() ? '➤' : '🎙️'}
                  </Text>
                )}
              </Pressable>
            </View>
            {isRecording && <Text style={styles.timer}>🔴 {fmtTime(duration)}</Text>}
          </View>
        </>
      ) : viewSpace?.type === 'family' ? (
        <>
          <View style={styles.famHeader}>
            <Text style={styles.famMembers}>👥 {memberCount}</Text>
          </View>
          {renderTabBar(FAMILY_TABS, familyTab, setFamilyTab, isManager)}

          {familyTab === 'members' && (
            <View style={styles.membersWrap}>
              {isManager && famSpace && (
                <Pressable onPress={() => openInviteFor(famSpace.id)} style={styles.inviteBtnFull}>
                  <Text style={styles.inviteBtnText}>{t('inviteTitle')}</Text>
                </Pressable>
              )}
              {membersBusy && !familyMembers ? (
                <ActivityIndicator color={P.accent} style={{ marginTop: 24 }} />
              ) : (
                (familyMembers ?? []).map((m) => (
                  <View key={m.user_id} style={styles.memberRow}>
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberAvatarText}>
                        {(m.display_name?.[0] ?? m.email?.[0] ?? '؟').toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.memberInfo}>
                      <Text style={styles.memberEmail} numberOfLines={1}>
                        {m.display_name ?? m.email ?? '—'}
                        {m.user_id === userId ? t('youSuffix') : ''}
                      </Text>
                      {m.display_name && m.email ? (
                        <Text style={styles.memberEmailSub} numberOfLines={1}>
                          {m.email}
                        </Text>
                      ) : null}
                      <Text style={styles.memberRole}>
                        {m.is_manager ? t('familyManager') : t('member')}
                      </Text>
                    </View>
                    {isManager && famSpace && m.user_id !== userId && (
                      <Pressable
                        onPress={() => doRemoveMember(famSpace, m.user_id)}
                        style={[
                          styles.removeBtn,
                          confirmRemove === m.user_id && styles.removeBtnConfirm,
                        ]}
                      >
                        <Text
                          style={[
                            styles.removeBtnText,
                            confirmRemove === m.user_id && styles.removeBtnTextConfirm,
                          ]}
                        >
                          {confirmRemove === m.user_id ? t('confirmRemove') : '❌'}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                ))
              )}
              {!isManager && famSpace && (
                <>
                  <Pressable onPress={() => setJoinOpen(true)} style={styles.famLinkCenter}>
                    <Text style={styles.famLinkText}>{t('haveCode')}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => doLeaveFamily(famSpace)}
                    style={[styles.leaveBtn, confirmLeave && styles.leaveBtnConfirm]}
                  >
                    <Text
                      style={[styles.leaveBtnText, confirmLeave && styles.leaveBtnTextConfirm]}
                    >
                      {confirmLeave ? t('confirmLeave') : t('leaveFamily')}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          )}
          {familyTab === 'shopping' && (
            <View style={styles.fill}>
              {/* ── active lists ── */}
              <Text style={styles.sectionTitle}>{t('shopListsTitle')}</Text>
              {activeLists.length === 0 && archivedLists.length === 0 ? (
                <Text style={styles.muted}>{t('shopEmpty')}</Text>
              ) : null}
              {activeLists.map((l) => {
                const resolved = l.items.filter((i) => i.status !== 'open').length;
                const total = l.items.length;
                return (
                  <View key={l.id} style={styles.shopListCard}>
                    <View style={styles.shopListHead}>
                      <Text style={styles.shopListTitle}>{l.title}</Text>
                      <Pressable
                        onPress={() => deleteShopList(l.id)}
                        hitSlop={10}
                        accessibilityLabel={t('deleteList')}
                      >
                        <Text style={styles.shopListDel}>{delListId === l.id ? '⚠️' : '✕'}</Text>
                      </Pressable>
                    </View>
                    {l.assigned_name ? (
                      <Text style={styles.shopListAssignee}>
                        {tx('shopListFor', { name: l.assigned_name })}
                      </Text>
                    ) : null}
                    <Text style={styles.shopListProg}>
                      {resolved}/{total}
                    </Text>
                    <Pressable onPress={() => setActiveListId(l.id)} style={styles.startShopBtn}>
                      <Text style={styles.startShopText}>{t('startShopping')}</Text>
                    </Pressable>
                  </View>
                );
              })}
              <Pressable onPress={() => setNewListOpen(true)} style={styles.newListBtn}>
                <Text style={styles.newListText}>＋ {t('newList')}</Text>
              </Pressable>
              {/* ── archive / history ── */}
              {archivedLists.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>{t('shopArchiveTitle')}</Text>
                  {archivedLists.map((l) => {
                    const bought = l.items.filter((i) => i.status === 'done').length;
                    const missing = l.items.filter((i) => i.status === 'not_found').length;
                    const expanded = archOpenId === l.id;
                    return (
                      <View key={l.id} style={[styles.shopListCard, styles.shopListArchived]}>
                        <Pressable onPress={() => setArchOpenId(expanded ? null : l.id)}>
                          <View style={styles.shopListHead}>
                            <Text style={styles.shopListTitle}>{l.title}</Text>
                            <Text style={styles.muted}>{expanded ? '▾' : '▸'}</Text>
                          </View>
                          <Text style={styles.muted}>
                            {l.completed_at ? fmtDay(l.completed_at) : ''} • ✅ {bought} • ❌{' '}
                            {missing}
                          </Text>
                        </Pressable>
                        {expanded &&
                          l.items.map((i) => (
                            <Pressable
                              key={i.id}
                              style={styles.archRow}
                              onPress={() =>
                                setShopItemStatus(l.id, i, i.status === 'done' ? 'not_found' : 'done')
                              }
                              accessibilityLabel={`${i.title}: ${
                                i.status === 'done' ? t('bought') : t('notFound')
                              }`}
                            >
                              <Text style={styles.itemIcon}>
                                {i.status === 'done' ? '✅' : i.status === 'not_found' ? '❌' : '⬜'}
                              </Text>
                              <Text
                                style={[styles.itemTitle, i.status !== 'open' && styles.itemDone]}
                              >
                                {i.title}
                              </Text>
                              {i.status === 'not_found' ? (
                                <Text style={styles.notFoundTag}>{t('notFound')}</Text>
                              ) : null}
                            </Pressable>
                          ))}
                        <View style={styles.archActions}>
                          {missing > 0 ? (
                            <Pressable onPress={() => restoreShopList(l.id)} hitSlop={10}>
                              <Text style={styles.restoreBtn}>{t('restoreList')}</Text>
                            </Pressable>
                          ) : null}
                          <Pressable
                            onPress={() => deleteShopList(l.id)}
                            hitSlop={10}
                            accessibilityLabel={t('deleteList')}
                          >
                            <Text style={styles.shopListDel}>{delListId === l.id ? '⚠️' : '✕'}</Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                </>
              )}
            </View>
          )}

          {familyTab === 'tasks' && (
            <FlatList
              style={styles.fill}
              data={tasks}
              keyExtractor={(i) => i.id}
              contentContainerStyle={styles.list}
              ListEmptyComponent={
                <Text style={styles.muted}>{t('tasksEmpty')}</Text>
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
                        <Text style={styles.assignBtnText}>{t('assign')}</Text>
                      </Pressable>
                    )}
                  </View>
                  {assignFor === item.id && (
                    <View style={styles.addRow}>
                      <TextInput
                        value={assignName}
                        onChangeText={setAssignName}
                        placeholder={t('assigneePh')}
                        placeholderTextColor={P.faint}
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
                <Text style={styles.muted}>{t('agendaEmpty')}</Text>
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

          {(familyTab === 'notes' || !FAMILY_BUILTIN.has(familyTab)) && notesBrowser}
        </>
      ) : (
        <>
          {renderTabBar(
            [
              ['notes', t('tabMyNotes')],
              ['things', t('tabMyThings')],
              ['papers', t('tabMyPapers')],
            ] as const,
            spaceTab,
            setSpaceTab,
            canManageTabs,
          )}
          {spaceTab === 'things' ? thingsList : notesBrowser}
        </>
      )}

      {/* ── custom tab modal (create / rename) ── */}
      <Modal visible={tabModalOpen} transparent animationType="fade" onRequestClose={() => setTabModalOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{editingTab ? t('renameTab') : t('newTab')}</Text>
            <View style={styles.iconRow}>
              {TAB_ICON_CHOICES.map((ic) => (
                <Pressable
                  key={ic}
                  onPress={() => setTabIcon(ic)}
                  style={[styles.iconPick, tabIcon === ic && styles.iconPickActive]}
                >
                  <Text style={styles.iconPickText}>{ic}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              value={tabName}
              onChangeText={setTabName}
              placeholder={t('tabNamePh')}
              placeholderTextColor={P.faint}
              style={styles.inviteInput}
              textAlign="center"
              maxLength={40}
              autoFocus
            />
            <View style={styles.modalRow}>
              <Pressable onPress={saveTab} disabled={!tabName.trim()} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>{editingTab ? t('save') : t('createTab')}</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setTabModalOpen(false);
                  setEditingTab(null);
                }}
                style={[styles.modalBtn, styles.modalBtnGhost]}
              >
                <Text style={[styles.modalBtnText, styles.modalBtnGhostText]}>{t('cancel')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── free-tier tab limit ── */}
      <Modal visible={limitModalOpen} transparent animationType="fade" onRequestClose={() => setLimitModalOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🔒 {t('tabLimitTitle')}</Text>
            <Text style={styles.modalBody}>{tx('tabLimitBody', { count: String(tabLimit) })}</Text>
            <View style={styles.modalRow}>
              <Pressable onPress={() => setLimitModalOpen(false)} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>{t('close')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── delete tab: move its notes or trash/delete them ── */}
      <Modal visible={delTab !== null} transparent animationType="fade" onRequestClose={() => setDelTab(null)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🗑️ {t('delTabTitle')}</Text>
            <Text style={styles.modalBody}>
              {tx('delTabBody', {
                name: delTab ? `${delTab.icon} ${delTab.title}` : '',
                count: String(delTabCount),
              })}
            </Text>
            {!delTabPickTarget ? (
              <>
                <Pressable
                  onPress={() => setDelTabPickTarget(true)}
                  style={[styles.modalBtn, { marginTop: 4 }]}
                >
                  <Text style={styles.modalBtnText}>
                    📁 {tx('delTabMove', { count: String(delTabCount) })}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => delTab && void runDeleteTab(delTab.id, { trash: trashRetention > 0 })}
                  style={[styles.modalBtn, { marginTop: 8, backgroundColor: P.danger }]}
                >
                  <Text style={styles.modalBtnText}>
                    {t('delTabDelete')}
                    {'\n'}
                    <Text style={{ fontWeight: '400', fontSize: 12 }}>
                      {trashRetention > 0
                        ? tx('delTabTrashHint', { days: String(trashRetention) })
                        : t('delTabForeverHint')}
                    </Text>
                  </Text>
                </Pressable>
                <Pressable onPress={() => setDelTab(null)} style={[styles.famLink, { marginTop: 12 }]}>
                  <Text style={styles.famLinkText}>{t('cancel')}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={[styles.modalBody, { marginTop: 0 }]}>{t('delTabPickTarget')}</Text>
                <ScrollView style={{ maxHeight: 280 }}>
                  {(
                    [
                      {
                        id: null as string | null,
                        label: viewSpace?.type === 'family' ? t('tabNotes') : t('tabMyNotes'),
                      },
                      ...(viewSpace?.type !== 'family'
                        ? [{ id: 'papers' as string | null, label: t('tabMyPapers') }]
                        : []),
                      ...spaceTabs
                        .filter((x) => delTab && x.id !== delTab.id)
                        .map((x) => ({ id: x.id as string | null, label: `${x.icon} ${x.title}` })),
                    ] as { id: string | null; label: string }[]
                  ).map((opt) => (
                    <Pressable
                      key={opt.id ?? 'main'}
                      onPress={() => delTab && void runDeleteTab(delTab.id, { moveTo: opt.id, trash: false })}
                      style={styles.fileRow}
                    >
                      <Text style={styles.fileRowText}>{opt.label}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <Pressable
                  onPress={() => setDelTabPickTarget(false)}
                  style={[styles.famLink, { marginTop: 12 }]}
                >
                  <Text style={styles.famLinkText}>{t('back')}</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* ── trash ── */}
      <Modal visible={trashOpen} transparent animationType="fade" onRequestClose={() => setTrashOpen(false)}>
        <View style={styles.modalBg}>
          <View style={[styles.modalCard, { maxHeight: '85%' }]}>
            <Text style={styles.modalTitle}>🗑️ {t('trashTitle')}</Text>
            <Text style={[styles.modalBody, { marginTop: 0 }]}>
              {tx('trashSubtitle', { days: String(trashRetention) })}
            </Text>
            {trashBusy ? (
              <Text style={styles.modalBody}>{t('loading')}</Text>
            ) : trashNotes.length === 0 && trashTabs.length === 0 ? (
              <Text style={styles.modalBody}>{t('trashEmpty')}</Text>
            ) : (
              <ScrollView style={{ maxHeight: 380 }}>
                {trashTabs.map((tb) => {
                  const nCount = trashNotes.filter((n) => n.tab_id === tb.id).length;
                  const key = `t:${tb.id}`;
                  return (
                    <View key={tb.id} style={styles.trashRow}>
                      <View style={styles.trashMain}>
                        <Text style={styles.trashTitle}>
                          {tb.icon} {tb.title}
                        </Text>
                        <Text style={styles.trashMeta}>
                          {tx('trashTabMeta', { count: String(nCount), days: String(tb.daysLeft) })}
                        </Text>
                      </View>
                      <View style={styles.trashActions}>
                        <Pressable onPress={() => void restoreTrashTab(tb)} style={styles.trashBtn}>
                          <Text style={styles.trashBtnText}>↩️</Text>
                        </Pressable>
                        <Pressable onPress={() => void nukeTrashTab(tb)} style={styles.trashBtn}>
                          <Text style={styles.trashBtnText}>{delForeverId === key ? '⚠️' : '✕'}</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
                {trashNotes
                  .filter((n) => !trashTabs.some((tb) => tb.id === n.tab_id))
                  .map((n) => {
                    const key = `n:${n.id}`;
                    return (
                      <View key={n.id} style={styles.trashRow}>
                        <View style={styles.trashMain}>
                          <Text style={styles.trashTitle} numberOfLines={2}>
                            {n.transcript || (n.photo_url ? '📷' : '…')}
                          </Text>
                          <Text style={styles.trashMeta}>
                            {trashNoteTabLabel(n)} · {tx('trashDaysLeft', { days: String(n.daysLeft) })}
                          </Text>
                        </View>
                        <View style={styles.trashActions}>
                          <Pressable onPress={() => void openRestorePick(n)} style={styles.trashBtn}>
                            <Text style={styles.trashBtnText}>↩️</Text>
                          </Pressable>
                          <Pressable onPress={() => void nukeTrashNote(n)} style={styles.trashBtn}>
                            <Text style={styles.trashBtnText}>{delForeverId === key ? '⚠️' : '✕'}</Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
              </ScrollView>
            )}
            {(trashNotes.length > 0 || trashTabs.length > 0) && !trashBusy && (
              <View style={styles.modalRow}>
                <Pressable onPress={() => void restoreAllTrash()} style={[styles.modalBtn, styles.modalBtnGhost]}>
                  <Text style={[styles.modalBtnText, { color: P.ink }]}>↩️ {t('trashRestoreAll')}</Text>
                </Pressable>
                <Pressable
                  onPress={() => void emptyTrashAll()}
                  style={[styles.modalBtn, { backgroundColor: P.danger }]}
                >
                  <Text style={styles.modalBtnText}>
                    {delForeverId === 'all' ? `⚠️ ${t('trashEmptyConfirm')}` : `🗑️ ${t('trashEmptyAll')}`}
                  </Text>
                </Pressable>
              </View>
            )}
            <Pressable onPress={() => setTrashOpen(false)} style={[styles.famLink, { marginTop: 12 }]}>
              <Text style={styles.famLinkText}>{t('close')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── restore note → pick target tab ── */}
      <Modal
        visible={restorePick !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRestorePick(null)}
      >
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>↩️ {t('restorePickTitle')}</Text>
            <Text style={[styles.modalBody, { marginTop: 0 }]} numberOfLines={2}>
              {restorePick?.transcript || '…'}
            </Text>
            <ScrollView style={{ maxHeight: 260 }}>
              {restoreTargets.map((opt) => (
                <Pressable
                  key={opt.id ?? 'main'}
                  onPress={() => restorePick && void restoreTrashNote(restorePick, opt.id)}
                  style={styles.fileRow}
                >
                  <Text style={styles.fileRowText}>{opt.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable onPress={() => setRestorePick(null)} style={[styles.famLink, { marginTop: 12 }]}>
              <Text style={styles.famLinkText}>{t('cancel')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── secret vault: full hidden page ── */}
      <Modal visible={secretVaultId !== null} animationType="slide" onRequestClose={() => setSecretVaultId(null)}>
        <SafeAreaView style={styles.vaultPage} edges={['top', 'bottom']}>
          <View style={styles.vaultHeader}>
            <Pressable onPress={() => setSecretVaultId(null)} style={styles.trashBtn} accessibilityLabel={t('close')}>
              <Text style={styles.trashBtnText}>🔒</Text>
            </Pressable>
            <Text style={styles.vaultTitle}>🔒 {t('secretTab')}</Text>
            <Pressable onPress={() => setSecretSearchOpen((v) => !v)} style={styles.trashBtn}>
              <Text style={styles.trashBtnText}>🔍</Text>
            </Pressable>
          </View>
          {secretSearchOpen ? (
            <View style={styles.vaultSearchWrap}>
              <TextInput
                style={[styles.nameInput, { marginBottom: 0, textAlign: ta() }]}
                value={secretSearch}
                onChangeText={setSecretSearch}
                placeholder={t('secretSearch')}
                placeholderTextColor={P.faint2}
              />
            </View>
          ) : null}
          <FlatList
            data={
              secretSearch.trim()
                ? secretNotes.filter((n) =>
                    (n.transcript ?? '').toLowerCase().includes(secretSearch.trim().toLowerCase()),
                  )
                : secretNotes
            }
            keyExtractor={(n) => n.id}
            renderItem={renderSecretNote}
            contentContainerStyle={styles.vaultList}
            ListEmptyComponent={<Text style={styles.modalBody}>{t('secretEmpty')}</Text>}
          />
          <View style={styles.vaultFooter}>
            <Text style={[styles.modalBody, { marginTop: 0, marginBottom: 6 }]}>{t('secretOpenHint')}</Text>
            {secretPhotoUri ? (
              <View style={styles.photoPreview}>
                <Image source={{ uri: secretPhotoUri }} style={styles.photoPreviewImg} />
                <Pressable onPress={() => setSecretPhotoUri(null)} style={styles.photoPreviewX}>
                  <Text style={styles.photoPreviewXText}>✕</Text>
                </Pressable>
              </View>
            ) : null}
            {isRecording ? <Text style={styles.timer}>🔴 {fmtTime(duration)}</Text> : null}
            <View style={styles.inputRow}>
              <View style={styles.composerBox}>
                <Pressable onPress={askSecretPhotoSource} style={styles.cameraBtn} hitSlop={8}>
                  <Text style={styles.cameraBtnText}>📷</Text>
                </Pressable>
                <TextInput
                  value={secretDraft}
                  onChangeText={setSecretDraft}
                  placeholder={t('secretAddPlaceholder')}
                  placeholderTextColor={P.faint}
                  style={styles.composerInput}
                  multiline
                  maxLength={2000}
                />
              </View>
              <Pressable
                onPress={
                  secretDraft.trim() && !isRecording ? () => void saveSecretNoteLocal() : onSecretRecordPress
                }
                disabled={secretSaving}
                style={[
                  styles.micBtn,
                  isRecording && styles.micBtnRecording,
                  secretSaving && styles.micBtnDisabled,
                ]}
              >
                {secretSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.micBtnText}>
                    {isRecording ? '⏹' : secretDraft.trim() ? '➤' : '🎙️'}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      </Modal>
      {/* ── file note into a tab ── */}
      <Modal
        visible={fileNoteId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setFileNoteId(null)}
      >
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('moveToTab')}</Text>
            {(
              [
                {
                  id: null as string | null,
                  icon: '',
                  label: viewSpace?.type === 'family' ? t('tabNotes') : t('tabMyNotes'),
                },
                ...(viewSpace?.type !== 'family'
                  ? [{ id: 'papers' as string | null, icon: '', label: t('tabMyPapers') }]
                  : []),
                ...spaceTabs.map((tb) => ({ id: tb.id as string | null, icon: tb.icon, label: tb.title })),
              ] as { id: string | null; icon: string; label: string }[]
            ).map((opt) => (
              <Pressable
                key={opt.id ?? 'main'}
                onPress={() => fileNoteId && fileNote(fileNoteId, opt.id)}
                style={styles.fileRow}
              >
                <Text style={styles.fileRowText}>
                  {opt.icon} {opt.label}
                </Text>
              </Pressable>
            ))}
            <Pressable onPress={() => setFileNoteId(null)} style={[styles.famLink, { marginTop: 12 }]}>
              <Text style={styles.famLinkText}>{t('cancel')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── invite modal ── */}
      <Modal visible={inviteOpen} transparent animationType="fade" onRequestClose={() => setInviteOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('inviteTitle')}</Text>
            <Text style={styles.modalBody}>
              {t('inviteBody')}
            </Text>
            {inviteBusy ? (
              <ActivityIndicator color={P.accent} style={{ marginVertical: 16 }} />
            ) : inviteCode ? (
              <Text style={styles.inviteCode}>{inviteCode}</Text>
            ) : (
              <Text style={styles.modalBody}>{t('codeFail')}</Text>
            )}
            <View style={styles.modalRow}>
              <Pressable onPress={shareInvite} disabled={!inviteCode} style={styles.modalBtn}>
                <Text style={styles.modalBtnText}>{t('share')}</Text>
              </Pressable>
              <Pressable onPress={copyInviteCode} disabled={!inviteCode} style={[styles.modalBtn, styles.modalBtnGhost]}>
                <Text style={[styles.modalBtnText, styles.modalBtnGhostText]}>{t('copy')}</Text>
              </Pressable>
            </View>
            <Pressable onPress={regenerateInvite} disabled={inviteBusy} style={styles.famLink}>
              <Text style={styles.famLinkText}>{t('newCode')}</Text>
            </Pressable>
            <Pressable onPress={() => setInviteOpen(false)} style={[styles.famLink, { marginTop: 12 }]}>
              <Text style={styles.famLinkText}>{t('close')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── join modal ── */}
      <Modal visible={joinOpen} transparent animationType="fade" onRequestClose={() => setJoinOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('joinFamilyTitle')}</Text>
            <Text style={styles.modalBody}>{t('enterCode')}</Text>
            <TextInput
              value={joinCode}
              onChangeText={(t) => setJoinCode(t.toUpperCase())}
              placeholder="ABC123"
              placeholderTextColor={P.faint}
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
                  <ActivityIndicator color={P.paper} />
                ) : (
                  <Text style={styles.modalBtnText}>{t('join')}</Text>
                )}
              </Pressable>
              <Pressable onPress={() => setJoinOpen(false)} style={[styles.modalBtn, styles.modalBtnGhost]}>
                <Text style={[styles.modalBtnText, styles.modalBtnGhostText]}>{t('cancel')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── shopping mode ("ابدا التسوق") ── */}
      <Modal
        visible={!!activeListId}
        transparent
        animationType="slide"
        onRequestClose={() => setActiveListId(null)}
      >
        <View style={styles.modalBg}>
          <View style={[styles.modalCard, styles.shopModalCard]}>
            {(() => {
              const list = shopLists.find((l) => l.id === activeListId);
              if (!list) return null;
              const resolved = list.items.filter((i) => i.status !== 'open').length;
              const total = list.items.length;
              const allResolved = total > 0 && resolved === total;
              return (
                <>
                  <View style={styles.shopModalHead}>
                    <Text style={styles.modalTitle}>{t('shoppingNow')}</Text>
                    <Pressable onPress={() => setActiveListId(null)} hitSlop={10}>
                      <Text style={styles.shopListDel}>✕</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.shopModalList}>{list.title}</Text>
                  {list.assigned_name ? (
                    <Text style={styles.shopListAssignee}>
                      {tx('shopListFor', { name: list.assigned_name })}
                    </Text>
                  ) : null}
                  <View style={styles.shopProgWrap}>
                    <View style={styles.shopProgBar}>
                      <View
                        style={[
                          styles.shopProgFill,
                          { width: `${total ? Math.round((resolved / total) * 100) : 0}%` },
                        ]}
                      />
                    </View>
                    <Text style={styles.shopProgText}>
                      {resolved}/{total}
                    </Text>
                  </View>
                  <FlatList
                    style={styles.shopModalList2}
                    data={list.items}
                    keyExtractor={(i) => i.id}
                    renderItem={({ item }) => (
                      <View
                        style={[
                          styles.shopBigRow,
                          item.status !== 'open' && styles.shopBigRowDone,
                        ]}
                      >
                        <Pressable
                          onPress={() =>
                            setShopItemStatus(
                              list.id,
                              item,
                              item.status === 'done' ? 'open' : 'done',
                            )
                          }
                          hitSlop={10}
                          accessibilityLabel={t('bought')}
                        >
                          <Text style={styles.shopBigCheck}>
                            {item.status === 'done' ? '✅' : '⬜'}
                          </Text>
                        </Pressable>
                        <Text
                          style={[
                            styles.shopBigTitle,
                            item.status !== 'open' && styles.itemDone,
                          ]}
                        >
                          {item.title}
                        </Text>
                        {item.status === 'not_found' ? (
                          <Text style={styles.notFoundTag}>{t('notFound')}</Text>
                        ) : null}
                        <Pressable
                          onPress={() =>
                            setShopItemStatus(
                              list.id,
                              item,
                              item.status === 'not_found' ? 'open' : 'not_found',
                            )
                          }
                          hitSlop={10}
                          accessibilityLabel={t('notFound')}
                        >
                          <Text style={styles.shopMissBtn}>
                            {item.status === 'not_found' ? '↩' : '❌'}
                          </Text>
                        </Pressable>
                      </View>
                    )}
                  />
                  {allResolved ? (
                    <Text style={styles.shopDoneBanner}>🎉 {t('listDoneMsg')}</Text>
                  ) : null}
                  <Pressable
                    onPress={() => setActiveListId(null)}
                    style={[styles.modalBtn, styles.shopDoneBtn]}
                  >
                    <Text style={styles.modalBtnText}>{t('shoppingDone')}</Text>
                  </Pressable>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>

      {/* ── new shopping list (manual) ── */}
      <Modal
        visible={newListOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setNewListOpen(false)}
      >
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('newList')}</Text>
            <TextInput
              value={newListTitle}
              onChangeText={setNewListTitle}
              placeholder={t('newListTitlePh')}
              placeholderTextColor={P.faint}
              style={styles.inviteInput}
            />
            <Text style={styles.modalLabel}>{t('newListFor')}</Text>
            <View style={styles.chipRow}>
              <Pressable
                onPress={() => setNewListAssignee(null)}
                style={[styles.chip, newListAssignee === null && styles.chipOn]}
              >
                <Text style={[styles.chipText, newListAssignee === null && { color: P.paper }]}>
                  {t('noAssignee')}
                </Text>
              </Pressable>
              {(familyMembers ?? []).map((m) => (
                <Pressable
                  key={m.user_id}
                  onPress={() => setNewListAssignee(m.user_id)}
                  style={[styles.chip, newListAssignee === m.user_id && styles.chipOn]}
                >
                  <Text
                    style={[styles.chipText, newListAssignee === m.user_id && { color: P.paper }]}
                  >
                    {m.display_name || m.email}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.modalLabel}>{t('newListItems')}</Text>
            <TextInput
              value={newListItems}
              onChangeText={setNewListItems}
              placeholder={t('newListItemsPh')}
              placeholderTextColor={P.faint}
              style={[styles.inviteInput, styles.modalInputMulti]}
              multiline
            />
            <View style={styles.modalBtns}>
              <Pressable
                onPress={() => setNewListOpen(false)}
                style={[styles.modalBtn, styles.modalBtnGhost]}
              >
                <Text style={styles.modalBtnGhostText}>{t('cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={createManualList}
                style={[
                  styles.modalBtn,
                  splitShoppingItems(newListItems).length === 0 && styles.modalBtnDisabled,
                ]}
                disabled={splitShoppingItems(newListItems).length === 0}
              >
                <Text style={styles.modalBtnText}>{t('create')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>


      {/* ── photo viewer ── */}
      <Modal
        visible={!!photoViewer}
        transparent
        animationType="fade"
        onRequestClose={() => setPhotoViewer(null)}
      >
        <Pressable style={styles.viewerBg} onPress={() => setPhotoViewer(null)}>
          {photoViewer ? (
            <Image
              source={{ uri: photoViewer }}
              style={styles.viewerImg}
              resizeMode="contain"
            />
          ) : null}
          <Text style={styles.viewerHint}>{t('tapToClose')}</Text>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (P: Palette) => StyleSheet.create({
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
  title: { fontSize: 26, fontWeight: '800', color: P.ink },
  subtitle: { fontSize: 14, color: P.muted, marginTop: 2 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: P.surface2,
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
    backgroundColor: P.overlay,
  },
  menuPanel: {
    width: 300,
    maxWidth: '85%',
    backgroundColor: P.paper,
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
    borderBottomColor: P.surface2,
    marginBottom: 8,
  },
  menuAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: P.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuAvatarText: { fontSize: 20, fontWeight: '800', color: '#fff' },
  menuScroll: { flex: 1 }, // the whole drawer scrolls — less clutter, less pressure
  menuProfileInfo: { flex: 1 },  menuEmail: { fontSize: 15, fontWeight: '700', color: P.ink },
  menuEmailSub: { fontSize: 11, color: P.faint2, marginTop: 1 },
  menuBadge: { fontSize: 12, color: P.muted, marginTop: 2 },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  // ── chat history (in-drawer) ──
  histSection: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: P.surface2,
    paddingTop: 10,
  },
  newChatBtn: {
    marginHorizontal: 20,
    marginBottom: 10,
    backgroundColor: P.ink,
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  newChatBtnText: { color: P.paper, fontSize: 15, fontWeight: '700' },
  histTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: P.accentDeep,
    paddingHorizontal: 20,
    marginBottom: 6,
  },
  histList: { paddingHorizontal: 20, marginBottom: 4 },
  showMoreBtn: {
    marginHorizontal: 20,
    marginBottom: 8,
    backgroundColor: P.surface2,
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: 'center',
  },
  showMoreText: { fontSize: 14, fontWeight: '700', color: P.accentDeep },
  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: P.surface,
    borderRadius: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: P.border,
  },
  histMain: { flex: 1, paddingVertical: 9, paddingHorizontal: 12 },
  histRowTitle: { fontSize: 14, fontWeight: '600', color: P.ink },
  histTtl: { fontSize: 11, color: P.accent, marginTop: 2, fontWeight: '600' },
  histDel: { paddingHorizontal: 12, paddingVertical: 9 },
  histDelText: { fontSize: 14, color: P.faint3 },
  histEmpty: { fontSize: 13, color: P.faint3, paddingVertical: 8 },
  histHint: { fontSize: 11, color: P.faint3, paddingHorizontal: 20, marginBottom: 10 },
  menuItemIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  menuItemText: { fontSize: 16, fontWeight: '600', color: P.ink, flex: 1 },
  menuSoon: {
    fontSize: 11,
    fontWeight: '700',
    color: P.accent,
    backgroundColor: P.tint,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  menuLogout: { marginTop: 8, borderTopWidth: 1, borderTopColor: P.surface2 },
  menuLogoutText: { color: P.danger },
  profileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: P.border,
  },
  profileLabel: { fontSize: 14, color: P.muted },
  profileValue: { fontSize: 14, fontWeight: '700', color: P.ink },
  nameEditWrap: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: P.border },
  nameInput: {
    marginTop: 8,
    backgroundColor: P.surface,
    borderWidth: 1,
    borderColor: P.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: P.ink,
  },
  demoPanel: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    backgroundColor: P.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: P.borderWarn,
  },
  demoTitle: { fontSize: 13, fontWeight: '700', color: P.warn, marginBottom: 8 },
  demoRow: { flexDirection: 'row', gap: 8 },
  demoAction: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: P.accent,
  },
  demoDanger: { backgroundColor: P.gray },
  demoActionText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  tabs: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 8 },
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: P.surface2,
  },
  // custom tabs: horizontal scrollable bar
  tabBar: { marginBottom: 8, maxHeight: 40 },
  tabBarInner: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  tabAdd: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: P.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: P.border,
    borderStyle: 'dashed',
  },
  tabAddText: { fontSize: 18, color: P.text2, fontWeight: '700' },
  tabMenu: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  tabMenuBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: P.surface2,
  },
  tabMenuDel: { backgroundColor: P.dangerSoft },
  tabMenuText: { fontSize: 13, fontWeight: '700', color: P.text2 },
  iconRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    justifyContent: 'center',
    marginBottom: 12,
  },
  iconPick: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: P.input,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconPickActive: { backgroundColor: P.ink },
  iconPickText: { fontSize: 20 },
  fileRow: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: P.input,
    marginBottom: 6,
  },
  fileRowText: { fontSize: 15, fontWeight: '600', color: P.ink2 },
  tabActive: { backgroundColor: P.ink },
  tabText: { fontSize: 14, fontWeight: '600', color: P.text2 },
  tabTextActive: { color: P.paper },
  // chat
  chatList: { paddingHorizontal: 16, paddingVertical: 8, gap: 10, flexGrow: 1 },
  emptyChat: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 8 },
  emptyIcon: { fontSize: 56 },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: P.ink },
  emptySub: { fontSize: 14, color: P.faint, textAlign: 'center', lineHeight: 22 },
  bubble: {
    maxWidth: '85%',
    borderRadius: 16,
    padding: 12,
    gap: 6,
  },
  bubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: P.info,
    borderBottomRightRadius: 4,
  },
  bubbleApp: {
    alignSelf: 'flex-start',
    backgroundColor: P.surface,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: P.border,
  },
  bubbleText: { fontSize: 15, color: P.ink, lineHeight: 22 },
  bubbleTextUser: { color: P.paper },
  bubbleSpinner: { marginTop: 4 },
  bubblePhoto: { width: 180, height: 135, borderRadius: 10, marginBottom: 6 },
  cardPhoto: { width: 120, height: 90, borderRadius: 10, backgroundColor: P.surface2 },
  // chat photo attach (photograph, then talk/write about it)
  photoPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: P.surface,
    borderRadius: 14,
    padding: 8,
    borderWidth: 1,
    borderColor: P.border,
  },
  photoPreviewImg: { width: 56, height: 56, borderRadius: 10, backgroundColor: P.surface2 },
  photoPreviewX: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: P.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoPreviewXText: { fontSize: 14, color: P.text2, fontWeight: '700' },
  photoPreviewLabel: { fontSize: 13, color: P.muted, flex: 1 },
  chatFooter: { paddingHorizontal: 16, paddingBottom: 20, paddingTop: 8, gap: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  composerBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: P.surface,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: P.border,
    paddingHorizontal: 6,
    paddingVertical: 6,
    maxHeight: 140,
  },
  cameraBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraBtnText: { fontSize: 22 },
  composerInput: {
    flex: 1,
    fontSize: 16,
    color: P.ink,
    paddingHorizontal: 4,
    paddingVertical: 10,
    maxHeight: 128,
  },
  micBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: P.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtnRecording: { backgroundColor: P.danger },
  micBtnDisabled: { opacity: 0.5 },
  micBtnText: { fontSize: 22 },
  chatInput: {
    flex: 1,
    backgroundColor: P.input,
    borderRadius: 24,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 15,
    color: P.ink,
    borderWidth: 1,
    borderColor: P.border,
  },
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: P.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnText: { color: '#fff', fontSize: 20, fontWeight: '800' },
  timer: { fontSize: 14, fontWeight: '700', color: P.accent, textAlign: 'center' },
  // space browsing
  segRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 6, marginBottom: 8 },
  seg: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: P.surface2,
    alignItems: 'center',
  },
  segActive: { backgroundColor: P.info },
  segText: { fontSize: 13, fontWeight: '700', color: P.text2 },
  segTextActive: { color: P.paper },
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
    backgroundColor: P.surface,
    borderRadius: 12,
    padding: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  // ── directed shopping lists ──
  sectionTitle: { fontSize: 15, fontWeight: '800', color: P.ink, marginBottom: 8 },
  shopListsWrap: { paddingHorizontal: 16, marginBottom: 12 },
  shopListCard: {
    backgroundColor: P.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: P.border,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  shopListHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  shopListTitle: { fontSize: 16, fontWeight: '800', color: P.ink, flex: 1 },
  shopListDel: { fontSize: 16, color: P.faint, padding: 4 },
  shopListAssignee: { fontSize: 13, color: P.info, fontWeight: '700', marginTop: 4 },
  shopListProg: { fontSize: 13, color: P.text3, marginTop: 4, fontWeight: '700' },
  startShopBtn: {
    marginTop: 10,
    backgroundColor: P.success,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  startShopText: { color: P.paper, fontSize: 15, fontWeight: '800' },
  shopModalCard: { maxWidth: 420, alignItems: 'stretch', maxHeight: '85%' },
  shopModalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  shopModalList: { fontSize: 16, fontWeight: '800', color: P.ink, marginTop: 2 },
  shopProgWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, marginBottom: 6 },
  shopProgBar: { flex: 1, height: 10, borderRadius: 6, backgroundColor: P.border, overflow: 'hidden' },
  shopProgFill: { height: '100%', backgroundColor: P.success, borderRadius: 6 },
  shopProgText: { fontSize: 14, fontWeight: '800', color: P.ink },
  shopModalList2: { marginTop: 6, maxHeight: 380 },
  shopBigRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: P.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: P.border,
  },
  shopBigRowDone: { backgroundColor: P.successSoft, borderColor: P.borderSuccess },
  shopBigCheck: { fontSize: 26 },
  shopBigTitle: { fontSize: 18, fontWeight: '700', color: P.ink, flex: 1 },
  shopDoneBanner: {
    fontSize: 15,
    fontWeight: '800',
    color: P.success,
    textAlign: 'center',
    marginTop: 6,
  },
  shopDoneBtn: { marginTop: 12, alignSelf: 'center', minWidth: 160 },
  assigneeChip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: P.infoSoft,
  },
  assigneeText: { fontSize: 12, fontWeight: '700', color: P.info },
  assignBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: P.surface2,
  },
  assignBtnText: { fontSize: 12, fontWeight: '700', color: P.text2 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    backgroundColor: P.input,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 14,
    color: P.ink,
    borderWidth: 1,
    borderColor: P.border,
  },
  searchItems: {
    backgroundColor: P.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: P.borderWarn,
  },
  searchItemsLabel: { fontSize: 13, fontWeight: '700', color: P.warn, marginBottom: 6 },
  searchItemRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  list: { paddingHorizontal: 16, paddingBottom: 16, gap: 10 },
  card: {
    backgroundColor: P.surface,
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
    backgroundColor: P.surface2,
  },
  moveBtnText: { fontSize: 12, fontWeight: '700', color: P.text2 },
  cardTopActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  playBtn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: P.info,
  },
  playBtnText: { fontSize: 12, fontWeight: '700', color: P.paper },
  thingThumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: P.surface2 },
  photoBtn: { padding: 6 },
  photoBtnText: { fontSize: 22 },
  viewerBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  viewerImg: { width: '100%', height: '80%' },
  viewerHint: { color: '#fff', marginTop: 12, fontSize: 14 },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 8,
    padding: 8,
    backgroundColor: P.paper,
    borderRadius: 10,
  },
  moveLabel: { fontSize: 13, fontWeight: '700', color: P.text2 },
  moveTarget: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: P.ink,
  },
  moveTargetText: { fontSize: 13, fontWeight: '700', color: P.paper },
  sugBtns: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardText: { fontSize: 15, color: P.ink, lineHeight: 22 },
  cardMeta: { fontSize: 12, color: P.faint },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: P.border,
  },
  itemIcon: { fontSize: 15, marginTop: 1 },
  itemBody: { flex: 1 },
  itemTitle: { fontSize: 14, fontWeight: '600', color: P.ink, lineHeight: 20 },
  itemDetails: { fontSize: 13, color: P.muted, marginTop: 2 },
  itemDone: { textDecorationLine: 'line-through', color: P.faint },
  itemDue: { fontSize: 12, color: P.accent, marginTop: 2 },
  // ── borrowing (مين أخذها؟) ──
  borrowBadge: { fontSize: 13, color: P.warn, marginTop: 2, fontWeight: '600' },
  returnBtn: { fontSize: 13, color: P.success, marginTop: 2 },
  returnBtnConfirm: { color: P.danger, fontWeight: 'bold' },
  muted: { fontSize: 13, color: P.faint },

  // ── auth + invites ──
  upgradeBanner: {
    backgroundColor: P.surface,
    borderBottomWidth: 1,
    borderBottomColor: P.border,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  upgradeText: { fontSize: 13, fontWeight: '600', color: P.warn, marginBottom: 8 },
  upgradeRow: { flexDirection: 'row', gap: 8 },
  upgradeInput: {
    flex: 1,
    backgroundColor: P.input,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 14,
    color: P.ink,
    borderWidth: 1,
    borderColor: P.border,
  },
  upgradeBtn: {
    backgroundColor: P.ink,
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  upgradeBtnText: { color: P.paper, fontSize: 14, fontWeight: '700' },
  upgradeErr: { color: P.danger, fontSize: 13, marginTop: 6 },
  famHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  famMembers: { fontSize: 14, color: P.text3, fontWeight: '600' },
  famLink: { padding: 4 },
  famLinkText: { fontSize: 13, color: P.accent, fontWeight: '600' },
  inviteBtn: {
    backgroundColor: P.ink,
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  inviteBtnText: { color: P.paper, fontSize: 13, fontWeight: '700' },
  inviteBtnFull: {
    backgroundColor: P.ink,
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center',
    marginBottom: 14,
  },
  membersWrap: { paddingHorizontal: 16, paddingTop: 10 },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: P.surface,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: P.border,
  },
  memberAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: P.tint,
    alignItems: 'center',
    justifyContent: 'center',
    marginEnd: 10,
  },
  memberAvatarText: { fontSize: 17, fontWeight: '700', color: P.accent },
  memberInfo: { flex: 1 },
  memberEmail: { fontSize: 14, fontWeight: '600', color: P.ink },
  memberEmailSub: { fontSize: 11, color: P.faint2, marginTop: 1 },
  memberRole: { fontSize: 12, color: P.text3, marginTop: 2 },
  removeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: P.surface,
  },
  removeBtnConfirm: { backgroundColor: P.danger },
  removeBtnText: { fontSize: 13, fontWeight: '700', color: P.danger },
  removeBtnTextConfirm: { color: P.paper },
  famLinkCenter: { alignItems: 'center', paddingVertical: 10 },
  leaveBtn: {
    marginTop: 6,
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: P.borderWarn,
    backgroundColor: P.surface,
  },
  leaveBtnConfirm: { backgroundColor: P.danger, borderColor: P.danger },
  leaveBtnText: { fontSize: 14, fontWeight: '700', color: P.danger },
  leaveBtnTextConfirm: { color: P.paper },
  modalBg: {
    flex: 1,
    backgroundColor: P.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: P.paper,
    borderRadius: 18,
    padding: 22,
    alignItems: 'center',
  },
  modalTitle: { fontSize: 19, fontWeight: '800', color: P.ink, marginBottom: 10 },
  modalBody: { fontSize: 14, color: P.text3, textAlign: 'center', lineHeight: 21, marginBottom: 14 },
  // trash rows
  trashRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: P.surface,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
  },
  trashMain: { flex: 1 },
  trashTitle: { fontSize: 14, fontWeight: '700', color: P.ink },
  trashMeta: { fontSize: 12, color: P.faint, marginTop: 3 },
  trashActions: { flexDirection: 'row', alignItems: 'center' },
  trashBtn: { paddingHorizontal: 10, paddingVertical: 8 },
  // secret vault full page
  vaultPage: { flex: 1, backgroundColor: P.paper },
  vaultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: P.border,
  },
  vaultTitle: { flex: 1, fontSize: 17, fontWeight: '800', color: P.ink, textAlign: 'center' },
  vaultSearchWrap: { paddingHorizontal: 12, paddingVertical: 8 },
  vaultList: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 16 },
  vaultFooter: {
    borderTopWidth: 1,
    borderTopColor: P.border,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: P.paper,
  },
  vaultEditRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  vaultEditInput: {
    backgroundColor: P.input,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: P.ink,
    borderWidth: 1,
    borderColor: P.border,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  trashBtnText: { fontSize: 17 },
  inviteCode: {
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 6,
    color: P.ink,
    backgroundColor: P.surface,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: P.border,
  },
  inviteInput: {
    width: '100%',
    backgroundColor: P.input,
    borderRadius: 12,
    padding: 14,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 4,
    color: P.ink,
    borderWidth: 1,
    borderColor: P.border,
    marginBottom: 12,
  },
  modalRow: { flexDirection: 'row', gap: 10, width: '100%' },
  modalBtn: {
    flex: 1,
    backgroundColor: P.ink,
    borderRadius: 12,
    padding: 13,
    alignItems: 'center',
  },
  modalBtnText: { color: P.paper, fontSize: 15, fontWeight: '700' },
  modalBtnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: P.border },
  modalBtnGhostText: { color: P.text3 },
  modalBtnDisabled: { opacity: 0.4 },
  modalLabel: { fontSize: 13, fontWeight: '700', color: P.text3, marginTop: 12, marginBottom: 6 },
  modalInputMulti: { minHeight: 90, textAlignVertical: 'top' },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: P.border,
    backgroundColor: P.surface,
  },
  chipOn: { backgroundColor: P.ink, borderColor: P.ink },
  chipText: { fontSize: 14, color: P.ink },
  // list-only shopping: active lists + archive
  newListBtn: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: P.border,
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    backgroundColor: P.surface,
  },
  newListText: { fontSize: 15, fontWeight: '700', color: P.ink },
  shopListArchived: { backgroundColor: P.surface, borderColor: P.border },
  archRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  archActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 6, gap: 14 },
  restoreBtn: { color: P.success, fontWeight: '700', fontSize: 14 },
  notFoundTag: {
    fontSize: 11,
    fontWeight: '700',
    color: P.dangerDeep,
    backgroundColor: P.dangerSoft,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  shopMissBtn: { fontSize: 22 },
});
