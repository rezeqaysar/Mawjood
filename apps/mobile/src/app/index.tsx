import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  FlatList,
  RefreshControl,
  Image,
  I18nManager,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import * as Speech from 'expo-speech';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  answerLocally,
  extractCorrectionPlace,
  parseAssignment,
  parseDirectedShopping,
  splitShoppingItems,
  resolveFamilyMember,
} from '@mawjood/voice-engine';
import type { FamilyMember, Item, Note, Space, SpaceTab, SpaceType, TrashKind, TrashRow } from '@mawjood/voice-engine';
import { supabase } from '../lib/supabase';
import { linkEmailToAnonymous, signOut } from '../lib/auth';
import { registerForPushNotifications } from '../lib/push';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import AuthScreen from '../components/AuthScreen';
import { WelcomeScreen } from '../components/WelcomeScreen';
import { t, tx, ta, useLang, getLang, setLanguage, initLanguage } from '../lib/i18n';
import { fetchRemoteConfig, flagOn, type RemoteConfig } from '../lib/remoteConfig';
import { useTheme } from '../lib/theme';
import { SearchBar } from '../lib/SearchBar';
import { SwipeRow } from '../lib/SwipeRow';
import { EmptyState } from '../lib/EmptyState';
import { WeekStrip } from '../lib/WeekStrip';
import { Highlight } from '../lib/Highlight';
import { VoiceWave } from '../lib/VoiceWave';
import { tap } from '../lib/haptics';
import { isDigestRequest, fetchDigestData, formatDigest } from '../lib/morningDigest';
import {
  parseExpenseRecord,
  parseExpenseQuery,
  recordExpense,
  summarizeExpenses,
  formatExpenseRecorded,
  formatExpenseSummary,
  fetchAllExpenses,
} from '../lib/expenses';
import {
  parseLostReport,
  parseFoundIt,
  parseCheckedPlace,
  buildSearchPlan,
  startSession,
  checkPlace,
  formatSearchPlan,
  formatChecked,
  formatFoundAsk,
  formatPlaceSaved,
  type SearchSession,
} from '../lib/lostItem';
import {
  parseBroadcast,
  sendFamilyBroadcast,
  formatBroadcastSent,
  formatNoMembers,
  NoFamilyMembersError,
} from '../lib/familyBroadcast';
import {
  parseTakeTo,
  parseWatchReply,
  createWatch,
  listOpenWatches,
  resolveWatchReply,
  snoozeDueAt,
  formatWatchCreated,
  formatWatchDone,
  formatWatchSnoozed,
  formatWatchWhich,
} from '../lib/watch';
import { parseHabitQuery, getPlaceHabits, formatHabit } from '../lib/habits';
import { detectOutOfScope, formatScopeRedirect } from '../lib/scopeGuard';
import {
  parseMemoryStatement,
  loadMemoryFacts,
  upsertMemoryFact,
  formatMemorySaved,
  type MemoryClient,
  type MemoryFact,
} from '../lib/userMemory';
import {
  parseTimelineQuery,
  getItemTimeline,
  formatTimeline,
} from '../lib/itemTimeline';
import {
  parseSmartQuery,
  parseSmartAdd,
  getBuyHistory,
  computeRhythms,
  getSuggestions,
  formatSuggestions,
  formatSmartAdded,
} from '../lib/smartShopping';
import { UndoBar } from '../lib/UndoBar';
import { usePaginatedList } from '../lib/usePaginatedList';
import { useTabSearch } from '../lib/useTabSearch';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { engine } from '../lib/engine';
import { SignedImage } from '../components/SignedImage';
import {
  VOICE_REPLY_KEY,
  KIND_ICON,
  SPACE_LABELS,
  FAMILY_BUILTIN_KEYS,
  SPACE_SHORT,
  ACTIVE_CHAT_KEY,
  ACTIVE_FAMILY_KEY,
  HISTORY_IDLE_MS,
  MAX_HISTORY_MSGS,
  UUID_RE,
  type AppView,
} from '../screens/home/constants';
import type { ChatMsg, ChatSession, TabProposal } from '../screens/home/types';
import { statusLabel, newSessionId, ttlText, recoveryWaitInfo, codeAlign } from '../screens/home/helpers';
import { useVault } from '../screens/home/hooks/useVault';
import { useBorrows } from '../screens/home/hooks/useBorrows';
import { useAgenda } from '../screens/home/hooks/useAgenda';
import { useShopping } from '../screens/home/hooks/useShopping';
import { makeStyles } from '../screens/home/styles';

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
  // ── paginated tab lists (10/page, infinite scroll — one generic hook per list) ──
  // `notes`/`setNotes` etc. are aliases: every existing local mutation
  // (toggle/delete/prepend/…) keeps working unchanged.
  const notesPage = usePaginatedList<Note>();
  const thingsPage = usePaginatedList<Item>();
  const tasksPage = usePaginatedList<Item>();
  const upcomingPage = usePaginatedList<Item>();
  const notes = notesPage.data;
  const setNotes = notesPage.setData;
  const things = thingsPage.data;
  const setThings = thingsPage.setData;
  const tasks = tasksPage.data;
  const setTasks = tasksPage.setData;
  const upcoming = upcomingPage.data;
  const setUpcoming = upcomingPage.setData;
  const [noteItems, setNoteItems] = useState<Record<string, Item[]>>({});

  // ── undo snackbar (one for the whole app) ──
  const [undo, setUndo] = useState<{ msg: string; run: () => void } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showUndo = useCallback((msg: string, run: () => void) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ msg, run });
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  }, []);
  const dismissUndo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(null);
  }, []);
  const doUndo = useCallback(() => {
    const u = undo;
    dismissUndo();
    u?.run();
  }, [undo, dismissUndo]);

  // ── chat state (in-memory only — cleared when the app is backgrounded) ──
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  /** long-press reaction bar open for this message id (null = closed) */
  const [reactFor, setReactFor] = useState<string | null>(null);
  // first-run welcome (once per device)
  const WELCOME_KEY = 'mawjood.welcomed.v1';
  const BC_DISMISS_KEY = 'mawjood.dismissed-broadcasts.v1';
  const [showWelcome, setShowWelcome] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem(WELCOME_KEY)
      .then((v) => {
        if (!v) setShowWelcome(true);
      })
      .catch(() => {});
    AsyncStorage.getItem(BC_DISMISS_KEY)
      .then((v) => {
        if (!v) return;
        try {
          const arr = JSON.parse(v);
          if (Array.isArray(arr)) setDismissedBc(arr.filter((x) => typeof x === 'string'));
        } catch { /* ignore */ }
      })
      .catch(() => {});
  }, []);
  const finishWelcome = useCallback(() => {
    setShowWelcome(false);
    AsyncStorage.setItem(WELCOME_KEY, '1').catch(() => {});
  }, []);
  const [textNote, setTextNote] = useState('');
  /** chat composer auto-grow height: follows content size, clamped 36–120 */
  const [composerH, setComposerH] = useState(36);

  /** empty-state example chip → fill the chat input and jump to Home */
  const tryExample = useCallback((example: string) => {
    setTextNote(example);
    setView('chat');
  }, []);
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
  // ── generic per-tab search: one hook per tab, each declares WHERE it searches ──
  const notesSearch = useTabSearch<Note, { notes: Note[]; items: Item[] }>({
    search: (q) =>
      viewSpace ? engine.search(viewSpace.id, q) : Promise.resolve({ notes: [], items: [] }),
  });
  const thingsSearch = useTabSearch<Item>({
    search: (q) =>
      viewSpace
        ? engine.search(viewSpace.id, q, { kinds: ['thing'], includeNotes: false }).then((r) => r.items)
        : Promise.resolve([]),
  });
  const tasksSearch = useTabSearch<Item>({
    search: (q) =>
      viewSpace
        ? engine.search(viewSpace.id, q, { kinds: ['task'], includeNotes: false }).then((r) => r.items)
        : Promise.resolve([]),
  });
  // ── Phase C: agenda domain (see screens/home/hooks/useAgenda.ts) ──
  const { agendaSearch, agendaDay, setAgendaDay, agendaCounts, agendaVisible } =
    useAgenda({ upcoming, viewSpace });
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
  // ── client-side per-tab search (small collections — no server round-trip) ──
  const memberSearch = useTabSearch<FamilyMember>({
    items: familyMembers ?? [],
    filter: (ms, q) =>
      ms.filter(
        (m) =>
          (m.display_name ?? '').toLowerCase().includes(q) ||
          (m.email ?? '').toLowerCase().includes(q),
      ),
  });
  // ── custom tabs (user-created; family tabs are shared with all members) ──
  const [spaceTabs, setSpaceTabs] = useState<SpaceTab[]>([]);
  const [tabLimit, setTabLimit] = useState(3); // free-tier cap per space (paid → unlimited)
  const [spaceTab, setSpaceTab] = useState<string>('notes'); // 'notes'|'things'|'papers' or custom tab id

  // the tab whose notes the notes browser shows: null = main tab, '—' = browser hidden
  const notesTabId =
    viewSpace?.type === 'family'
      ? familyTab === 'notes'
        ? null
        : FAMILY_BUILTIN_KEYS.has(familyTab)
          ? '—'
          : familyTab
      : spaceTab === 'things'
        ? '—'
        : spaceTab === 'notes'
          ? null
          : spaceTab;
  const notesTabIdRef = useRef<string | null>(null);
  // keep the ref fresh for callbacks (join flow) without writing during render
  useEffect(() => {
    notesTabIdRef.current = notesTabId === '—' ? null : notesTabId;
  }, [notesTabId]);

  // reload the notes page when the visible notes tab changes (server-side tab filter)
  useEffect(() => {
    const s = viewSpace;
    if (!s || notesTabId === '—') return;
    notesPage.refresh((o, l) => engine.listNotes(s.id, { offset: o, limit: l, tabId: notesTabId }));
  }, [notesTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // paged lists are cleared when the space is (sign-out / leave-space)
  useEffect(() => {
    if (viewSpace) return;
    notesPage.setData([]);
    thingsPage.setData([]);
    tasksPage.setData([]);
    upcomingPage.setData([]);
  }, [viewSpace, notesPage, thingsPage, tasksPage, upcomingPage]);
  const [tabModalOpen, setTabModalOpen] = useState(false); // create / rename tab
  const [editingTab, setEditingTab] = useState<SpaceTab | null>(null);
  const [tabName, setTabName] = useState('');
  const [tabIcon, setTabIcon] = useState('📁');
  const [tabMenuId, setTabMenuId] = useState<string | null>(null); // long-press menu on a tab
  const [tabMoveFor, setTabMoveFor] = useState<string | null>(null); // tab id → space picker open
  const [limitModalOpen, setLimitModalOpen] = useState(false); // free-tier cap reached
  const [fileNoteId, setFileNoteId] = useState<string | null>(null); // note being filed into a tab
  // ── remote config (public-config): plans, feature flags, broadcasts ──
  const [remoteCfg, setRemoteCfg] = useState<RemoteConfig | null>(null);
  const [dismissedBc, setDismissedBc] = useState<string[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2600);
  }, []);

  // ── broadcasts: dismissible announcement cards above the chat ──
  const dismissBroadcast = useCallback((id: string) => {
    setDismissedBc((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      AsyncStorage.setItem(BC_DISMISS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);
  const visibleBroadcasts = useMemo(() => {
    if (!remoteCfg || !flagOn(remoteCfg.flags, 'broadcasts')) return [];
    const premium = remoteCfg.is_premium;
    return remoteCfg.broadcasts.filter(
      (b) =>
        !dismissedBc.includes(b.id) &&
        (b.target === 'all' || (b.target === 'premium' && premium) || (b.target === 'free' && !premium)),
    );
  }, [remoteCfg, dismissedBc]);
  const bcTitle = (b: { title_ar: string; title_en: string }) =>
    lang === 'ar' ? b.title_ar || b.title_en : b.title_en || b.title_ar;
  const bcBody = (b: { body_ar: string; body_en: string }) =>
    lang === 'ar' ? b.body_ar || b.body_en : b.body_en || b.body_ar;
  // ── trash (Plus: 30-day soft delete) + secret vault tab ──
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

  const [trashRetention, setTrashRetention] = useState(30);
  // ── Phase C: vault/ghost domain (see screens/home/hooks/useVault.ts) ──
  // (only the names HomeScreen itself uses; the hook returns the full domain)
  const {
    secretVault,
    setSecretVault,
    trashSecret,
    setTrashSecret,
    masterHashRef,
    decoyMasterHashRef,
    mgmtDecoyMode,
    decoyMasterSet,
    setDecoyMasterSet,
    decoyMasterNew,
    setDecoyMasterNew,
    decoyMasterSaving,
    masterState,
    setMasterState,
    masterFormOpen,
    setMasterFormOpen,
    masterFormMode,
    setMasterFormMode,
    masterNew,
    setMasterNew,
    masterMsg,
    setMasterMsg,
    masterMsgOk,
    masterSaving,
    recoveryInfo,
    setRecoveryInfo,
    duressFormOpen,
    setDuressFormOpen,
    duressDraft,
    setDuressDraft,
    duressMsg,
    setDuressMsg,
    duressSaving,
    mgmtOpen,
    mgmtVaults,
    mgmtLoading,
    vaultCodeEditId,
    setVaultCodeEditId,
    vaultCodeDraft,
    setVaultCodeDraft,
    vaultDelId,
    vaultDelMaster,
    setVaultDelMaster,
    mgmtMasterNew,
    setMgmtMasterNew,
    mgmtMasterCur,
    setMgmtMasterCur,
    mgmtMsg,
    setMgmtMsg,
    secretVaultId,
    setSecretVaultId,
    secretNotes,
    secretDraft,
    setSecretDraft,
    secretSaving,
    secretSearchOpen,
    setSecretSearchOpen,
    secretSearch,
    setSecretSearch,
    secretEditingId,
    setSecretEditingId,
    secretEditDraft,
    setSecretEditDraft,
    secretDelId,
    secretPhotoUri,
    setSecretPhotoUri,
    secretCodeDraft,
    setSecretCodeDraft,
    secretCodeMsg,
    setSecretCodeMsg,
    secretCodeMsgOk,
    refreshSecretNotes,
    saveSecretNoteLocal,
    onSecretRecordPress,
    askSecretPhotoSource,
    startEditSecret,
    saveEditSecret,
    askDeleteSecret,
    saveSecretCode,
    refreshMaster,
    saveMasterKeyLocal,
    requestRecoveryLocal,
    cancelRecoveryLocal,
    completeRecoveryLocal,
    saveDuressLocal,
    removeDuressLocal,
    closeMgmt,
    tryGhostIntercept,
    changeVaultCodeLocal,
    deleteVaultLocal,
    changeMasterFromMgmt,
    fillDecoyLocal,
    setDecoyMasterLocal,
    removeDecoyMasterLocal,
  } = useVault({ userId, spaceIdByType, trashRetention, isRecording, start, stop, featureFlags: remoteCfg?.flags ?? null });
  const [delTab, setDelTab] = useState<SpaceTab | null>(null); // tab being deleted → move or trash modal
  const [delTabCount, setDelTabCount] = useState(0);
  const [delTabPickTarget, setDelTabPickTarget] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashRows, setTrashRows] = useState<(TrashRow & { daysLeft: number })[]>([]);
  const [trashBusy, setTrashBusy] = useState(false);
  const [trashFilter, setTrashFilter] = useState<'all' | TrashKind>('all');
  const [moveItemFor, setMoveItemFor] = useState<string | null>(null); // item id → space picker open
  // ── Phase 4: 📦 أشيائي pillar (all spaces) — paginated via thingsPage above ──
  // ── borrowing (مين أخذها؟): open borrows per space ──
  // ── Phase C: borrowing domain (see screens/home/hooks/useBorrows.ts) ──
  const { setBorrows, confirmReturnId, borrowFor, onReturnBorrow } = useBorrows();
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
    [userId, setThings],
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
  // ── multi-family: slots (paid hook), switcher, paywall ──
  const [familySlots, setFamilySlots] = useState(1);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [famsOpen, setFamsOpen] = useState(false);
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);
  const [activeFamilyId, setActiveFamilyId] = useState<string | null>(null);
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

  // ── Phase C: shopping domain (see screens/home/hooks/useShopping.ts) ──
  // (call placed after profile states: createManualList needs displayName/userEmail;
  //  toggleItem below consumes the destructured setters)
  const {
    setShopping, shopLists, setShopLists, shopSearch,
    activeListId, setActiveListId,
    newListOpen, setNewListOpen, newListTitle, setNewListTitle,
    newListItems, setNewListItems, newListAssignee, setNewListAssignee,
    archOpenId, setArchOpenId, assignFor, setAssignFor, assignName, setAssignName,
    shopRefreshing, setShopRefreshing,
    setShopItemStatus, deleteShopList, shareShoppingList, restoreShopList, createManualList,
  } = useShopping({ userId, viewSpace, trashRetention, familyMembers, displayName, userEmail, showUndo });

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


  // ── multi-family: all family spaces (own + joined), active one, switching ──
  const familySpaces = useMemo(() => {
    const list = spaces.filter((x) => x.type === 'family');
    // active first, then own, then oldest
    list.sort((a, b) => {
      if (a.id === activeFamilyId) return -1;
      if (b.id === activeFamilyId) return 1;
      return (a.owner_id === userId ? 0 : 1) - (b.owner_id === userId ? 0 : 1);
    });
    return list;
  }, [spaces, activeFamilyId, userId]);

  /** The family space the tab shows: last-viewed if still available, else the
   *  pickSpace default (joined wins over own). */
  const resolveFamilySpace = useCallback((): Space | null => {
    const fams = spaces.filter((x) => x.type === 'family');
    if (activeFamilyId) {
      const hit = fams.find((s) => s.id === activeFamilyId);
      if (hit) return hit;
    }
    return pickSpace('family');
  }, [spaces, activeFamilyId, pickSpace]);

  const rememberActiveFamily = useCallback((id: string | null) => {
    setActiveFamilyId(id);
    if (id) AsyncStorage.setItem(ACTIVE_FAMILY_KEY, id).catch(() => {});
    else AsyncStorage.removeItem(ACTIVE_FAMILY_KEY).catch(() => {});
  }, []);

  // ── data helpers ──
  // NOTE: notes/things/tasks/upcoming are paginated (usePaginatedList) and are
  // (re)loaded with explicit loaders in openSpace / the join flow / the tab
  // effect, or via notesPage.refresh() etc. (latest loader) elsewhere.

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
    tap('light');
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
  }, [setTasks, setUpcoming, setShopping, setShopLists]);





  // ── Phase 3: family lists ──
  // loose shopping items + directed lists only — tasks/upcoming/things/notes
  // are paginated via their own loaders (openSpace / join flow / tab effect).
  const refreshFamily = useCallback(async (spaceId: string) => {
    try {
      const s = await engine.listShopping(spaceId, { limit: 100 });
      setShopping(s.filter((i) => !i.list_id)); // loose items only — list items live under their list
    } catch (e) {
      console.warn('refreshFamily failed', e);
    }
    // directed shopping lists (graceful until migration 0014 is run)
    try {
      setShopLists(await engine.listShoppingLists(spaceId));
    } catch {
      setShopLists([]);
    }
  }, [setShopping, setShopLists]);

  const onRefreshShopping = useCallback(async () => {
    if (!viewSpace) return;
    setShopRefreshing(true);
    try {
      await refreshFamily(viewSpace.id);
    } finally {
      setShopRefreshing(false);
    }
  }, [viewSpace, refreshFamily, setShopRefreshing]);

  // ── Phase 4: 📦 أشيائي ──
  const refreshThings = useCallback(async (spaceId: string) => {
    thingsPage.refresh(); // paginated list (latest loader)
    // ── borrowing (مين أخذها؟) ──
    try {
      setBorrows(await engine.listBorrows(spaceId));
    } catch (e) {
      console.warn('listBorrows failed', e);
    }
  }, [thingsPage, setBorrows]);

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
    // kill switch: admin can pause custom-tab creation from the admin panel
    if (!editingTab && !flagOn(remoteCfg?.flags, 'custom_tabs')) {
      setTabModalOpen(false);
      showToast(t('featurePaused'));
      return;
    }
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
  }, [viewSpace, userId, tabName, tabIcon, editingTab, spaceTabs.length, tabLimit, remoteCfg, showToast]);

  // ── 🗂️ tab proposal card actions (tab-aware AI) ──
  const clearProposal = useCallback((msgId: string) => {
    updateMsg(msgId, { proposal: null });
  }, [updateMsg]);

  /** ✅ create the proposed tab — same guards as the manual flow (flag, limit). */
  const createProposedTab = useCallback(async (msgId: string, p: TabProposal) => {
    const space = spaces.find((s) => s.id === p.space_id);
    if (!space || !userId || space.owner_id !== userId) return; // members send to manager instead
    if (!flagOn(remoteCfg?.flags, 'custom_tabs')) {
      showToast(t('featurePaused'));
      return;
    }
    let count = 0;
    try {
      count = (await engine.listSpaceTabs(p.space_id)).length;
    } catch { /* fail-open: try the create */ }
    if (count >= tabLimit) {
      setLimitModalOpen(true); // the paywall — the indirect upsell lands here
      return;
    }
    try {
      const tab = await engine.createSpaceTab(p.space_id, userId, p.name, p.emoji || '📁');
      await engine.updateTabProposal(p.id, 'created').catch(() => {});
      clearProposal(msgId);
      if (viewSpace?.id === p.space_id) setSpaceTabs((prev) => [...prev, tab]);
      showToast(t('tabProposalCreated'));
    } catch (e) {
      console.warn('createProposedTab failed', e);
    }
  }, [spaces, userId, remoteCfg, tabLimit, viewSpace, showToast, clearProposal]);

  /** 📤 family member → manager: post the proposal as a family note. */
  const sendProposalToManager = useCallback(async (msgId: string, p: TabProposal) => {
    const famId = spaceIdByType('family');
    if (!famId || !userId) return;
    try {
      await engine.saveTextNote(
        famId,
        `💡 ${t('tabProposalNotePrefix')}: ${p.emoji} ${p.name}${p.reason ? ` — ${p.reason}` : ''}`,
        userId,
      );
      await engine.updateTabProposal(p.id, 'dismissed').catch(() => {});
      clearProposal(msgId);
      showToast(t('tabProposalSent'));
    } catch (e) {
      console.warn('sendProposalToManager failed', e);
    }
  }, [spaceIdByType, userId, showToast, clearProposal]);

  /** ✖ dismiss the proposal (the agent never re-proposes it). */
  const dismissProposal = useCallback(async (msgId: string, p: TabProposal) => {
    await engine.updateTabProposal(p.id, 'dismissed').catch(() => {});
    clearProposal(msgId);
  }, [clearProposal]);

  const runDeleteTab = useCallback(
    async (tabId: string, opts: { moveTo?: string | null; trashDays: number }) => {
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
    [spaceTab, familyTab, setNotes],
  );

  /** Move a custom tab (+ its notes) to another space. */
  const moveTabSpace = useCallback(
    async (tabId: string, spaceId: string) => {
      setTabMoveFor(null);
      setTabMenuId(null);
      if (spaceTab === tabId) setSpaceTab('notes');
      if (familyTab === tabId) setFamilyTab('members');
      try {
        await engine.moveTabToSpace(tabId, spaceId);
        if (viewSpace) {
          void refreshTabs(viewSpace.id);
          notesPage.refresh();
        }
      } catch (e) {
        console.warn('moveTabToSpace failed', e);
      }
    },
    [spaceTab, familyTab, viewSpace, refreshTabs, notesPage],
  );

  /** Delete a custom tab → modal: move its notes to another tab, or trash/delete them. */
  const askDeleteTab = useCallback(
    (tab: SpaceTab) => {
      setTabMenuId(null);
      const n = notes.filter((x) => x.tab_id === tab.id).length;
      if (n === 0) {
        void runDeleteTab(tab.id, { trashDays: trashRetention });
        return;
      }
      setDelTab(tab);
      setDelTabCount(n);
      setDelTabPickTarget(false);
    },
    [notes, runDeleteTab, trashRetention],
  );

  // ── universal trash (one bin for the whole account; vault_id set = secret trash) ──
  const [delForeverId, setDelForeverId] = useState<string | null>(null); // two-tap permanent delete in trash

  const TRASH_KINDS: TrashKind[] = ['chat', 'tab', 'note', 'task', 'appointment', 'thing', 'shopping_list'];

  /** icon + label for a trash kind. */
  const trashKindMeta = (kind: TrashKind): { icon: string; label: string } => {
    switch (kind) {
      case 'chat': return { icon: '💬', label: t('trashKindChat') };
      case 'tab': return { icon: '📑', label: t('trashKindTab') };
      case 'note': return { icon: '📝', label: t('trashKindNote') };
      case 'task': return { icon: '✅', label: t('trashKindTask') };
      case 'appointment': return { icon: '📅', label: t('trashKindAppt') };
      case 'thing': return { icon: '📦', label: t('trashKindThing') };
      case 'shopping_list': return { icon: '🛒', label: t('trashKindList') };
    }
  };

  /** origin space name for a trash row. */
  const trashOrigin = (row: TrashRow): string => {
    if (row.kind === 'chat') return '';
    const sp = spaces.find((s) => s.id === row.space_id);
    return sp ? (SPACE_LABELS[sp.type] ?? sp.name) : '';
  };

  const openTrash = useCallback(async (secret: boolean) => {
    if (!userId) return;
    setTrashSecret(secret);
    setTrashFilter('all');
    setTrashOpen(true);
    setTrashBusy(true);
    try {
      await engine.purgeExpiredTrash(userId, secret); // lazy expiry of old rows
      const rows = await engine.listTrash(userId, secret);
      const nowMs = Date.now();
      setTrashRows(
        rows.map((r) => ({
          ...r,
          daysLeft: Math.max(0, Math.ceil((new Date(r.expires_at).getTime() - nowMs) / 86400_000)),
        })),
      );
    } catch (e) {
      console.warn('openTrash failed', e);
    } finally {
      setTrashBusy(false);
    }
  }, [userId, setTrashSecret]);


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

  /** Refresh every list that a restore/delete could have touched. */
  const refreshAfterTrash = useCallback(() => {
    if (viewSpace) {
      notesPage.refresh();
      tasksPage.refresh();
      upcomingPage.refresh();
      void refreshTabs(viewSpace.id);
      void refreshFamily(viewSpace.id);
      void refreshThings(viewSpace.id);
    }
    void loadHistory();
    refreshSecretNotes();
  }, [viewSpace, notesPage, tasksPage, upcomingPage, refreshTabs, refreshFamily, refreshThings, refreshSecretNotes, loadHistory]);

  /** Bring one trash row back. */
  const restoreTrashRow = useCallback(
    async (row: TrashRow) => {
      setTrashRows((prev) => prev.filter((r) => r.id !== row.id));
      try {
        await engine.restoreTrashRow(row, userId!, {
          chatRetentionDays: retentionDaysRef.current,
          fallbackVaultId: secretVaultId,
        });
        refreshAfterTrash();
      } catch (e) {
        console.warn('restoreTrashRow failed', e);
      }
    },
    [userId, refreshAfterTrash, secretVaultId],
  );

  /** Restore everything in the open trash. */
  const restoreAllTrash = useCallback(async () => {
    const rows = trashRows;
    setTrashRows([]);
    try {
      for (const r of rows) {
        await engine.restoreTrashRow(r, userId!, {
          chatRetentionDays: retentionDaysRef.current,
          fallbackVaultId: secretVaultId,
        });
      }
      refreshAfterTrash();
    } catch (e) {
      console.warn('restoreAllTrash failed', e);
    }
  }, [trashRows, userId, refreshAfterTrash, secretVaultId]);

  /** Two-tap permanent delete of one trash row (no way back). */
  const nukeTrashRow = useCallback(
    async (row: TrashRow) => {
      if (delForeverId !== row.id) {
        setDelForeverId(row.id);
        setTimeout(() => setDelForeverId((cur) => (cur === row.id ? null : cur)), 4000);
        return;
      }
      setDelForeverId(null);
      setTrashRows((prev) => prev.filter((r) => r.id !== row.id));
      try {
        await engine.deleteTrashRowForever(row);
      } catch (e) {
        console.warn('deleteTrashRowForever failed', e);
      }
    },
    [delForeverId],
  );

  /** Two-tap: permanently empty the open trash. */
  const emptyTrashAll = useCallback(async () => {
    if (delForeverId !== 'all') {
      setDelForeverId('all');
      setTimeout(() => setDelForeverId((cur) => (cur === 'all' ? null : cur)), 4000);
      return;
    }
    setDelForeverId(null);
    setTrashRows([]);
    try {
      await engine.emptyTrash(userId!, trashSecret);
    } catch (e) {
      console.warn('emptyTrash failed', e);
    }
  }, [delForeverId, userId, trashSecret]);

  /** Delete a note → trash (Plus) or permanent (free). Single tap: trash is the safety net. */
  const askDeleteNote = useCallback(
    async (noteId: string) => {
      if (!userId) return;
      const snap = notes.find((n) => n.id === noteId);
      const snapItems = noteItems[noteId] ?? [];
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      try {
        await engine.trashNote(noteId, userId, trashRetention);
        tap('medium');
        if (viewSpace) notesPage.refresh();
        if (snap) {
          showUndo(t('deletedNote'), () => {
            setNotes((prev) => [snap, ...prev]);
            setNoteItems((prev) => ({ ...prev, [noteId]: snapItems }));
            void engine
              .undelete(noteId, 'notes', snap as unknown as Record<string, unknown>, snapItems as unknown as Record<string, unknown>[])
              .catch((e) => console.warn('undelete failed', e));
          });
        }
      } catch (e) {
        console.warn('trashNote failed', e);
      }
    },
    [userId, trashRetention, viewSpace, notesPage, setNotes, notes, noteItems, showUndo],
  );

  /** Delete a task/appointment/thing → trash (Plus) or permanent (free). */
  const askDeleteItem = useCallback(
    async (item: Item) => {
      if (!userId) return;
      const snap = item;
      const putBack = (prev: Item[]) => [snap, ...prev.filter((x) => x.id !== snap.id)];
      setTasks((prev) => prev.filter((x) => x.id !== item.id));
      setThings((prev) => prev.filter((x) => x.id !== item.id));
      setUpcoming((prev) => prev.filter((x) => x.id !== item.id));
      try {
        await engine.trashItem(item.id, userId, trashRetention);
        tap('medium');
        if (viewSpace) {
          void refreshFamily(viewSpace.id);
          void refreshThings(viewSpace.id);
          tasksPage.refresh();
          upcomingPage.refresh();
        }
        showUndo(t('deletedTask'), () => {
          if (snap.kind === 'task') setTasks(putBack);
          else if (snap.kind === 'appointment') setUpcoming(putBack);
          else setThings(putBack);
          void engine
            .undelete(snap.id, 'items', snap as unknown as Record<string, unknown>)
            .catch((e) => console.warn('undelete failed', e));
        });
      } catch (e) {
        console.warn('trashItem failed', e);
      }
    },
    [userId, trashRetention, viewSpace, refreshFamily, refreshThings, tasksPage, upcomingPage, setTasks, setThings, setUpcoming, showUndo],
  );

  /** Move a task/appointment/thing to another space. */
  const moveItemSpace = useCallback(
    async (item: Item, spaceId: string) => {
      setMoveItemFor(null);
      try {
        await engine.moveItemToSpace(item.id, spaceId);
        if (viewSpace) {
          void refreshFamily(viewSpace.id);
          void refreshThings(viewSpace.id);
          tasksPage.refresh();
          upcomingPage.refresh();
        }
      } catch (e) {
        console.warn('moveItemToSpace failed', e);
      }
    },
    [viewSpace, refreshFamily, refreshThings, tasksPage, upcomingPage],
  );

  // ── secret vaults (hidden; each code opens its own vault page via private chat) ──

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
    [setNotes],
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
        reaction: m.reaction ?? null,
        // proposal cards are live UI — a reloaded session re-renders stale
        // buttons that would double-create tabs, so they never persist
        proposal: null,
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

  /** open the side drawer; refreshes chat history (fresh delete-countdowns) */
  const openMenu = useCallback(() => {
    setMenuOpen(true);
    menuX.setValue(-320);
    Animated.timing(menuX, { toValue: 0, duration: 220, useNativeDriver: false }).start();
    void loadHistory();
  }, [menuX, loadHistory]);

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

  /** Delete a chat → trash (Plus) or permanent (free). Single tap: trash is the safety net. */
  const deleteSession = useCallback(
    async (id: string) => {
      setHistory((prev) => prev.filter((s) => s.id !== id));
      if (id === sessionIdRef.current) sessionIdRef.current = newSessionId();
      if (!userId) return;
      try {
        await engine.trashChat(id, userId, trashRetention);
      } catch {
        /* ignore */
      }
    },
    [userId, trashRetention],
  );

  // debounced draft persistence: the in-progress chat survives app kills;
  // the 2-min background rule decides whether it stays open or is archived
  useEffect(() => {
    if (!userId) return;
    const t = setTimeout(() => {
      saveDraft(messages, sessionIdRef.current);
    }, 800);
    return () => clearTimeout(t);
  }, [messages, userId, saveDraft]);

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

  /** Show a family space in the tab: view + every list refreshed. */
  const activateFamilySpace = useCallback((s: Space) => {
    const sid = s.id;
    rememberActiveFamily(sid);
    const tabId = notesTabIdRef.current; // null = main tab (matches the notes-tab effect)
    setViewSpace(s);
    setView('family');
    notesSearch.setQuery('');
    refreshFamilyMembers(s);
    // paginated tab lists, 10/page (explicit loaders — sid is fresh before re-render)
    notesPage.refresh((o, l) => engine.listNotes(sid, { offset: o, limit: l, tabId }));
    thingsPage.refresh((o, l) => engine.listThings(sid, { offset: o, limit: l }));
    tasksPage.refresh((o, l) => engine.listTasks(sid, { offset: o, limit: l }));
    upcomingPage.refresh((o, l) => engine.listUpcoming(sid, { offset: o, limit: l }));
    refreshItems(sid);
    refreshFamily(sid);
    refreshTabs(sid);
  }, [rememberActiveFamily, refreshFamilyMembers, refreshItems, refreshFamily, refreshTabs, notesPage, thingsPage, tasksPage, upcomingPage, notesSearch]);

  /** Core join: redeem the code and activate the joined family. No slot check. */
  const runJoin = useCallback(async (code: string) => {
    if (!code || joinBusy) return;
    setJoinBusy(true);
    setJoinError(null);
    try {
      const res = await engine.joinFamily(code);
      setJoinOpen(false);
      setJoinCode('');
      setPendingJoinCode(null);
      const fresh = await engine.listSpaces();
      setSpaces(fresh);
      const joinedId = (res as { space?: { id: string }; id?: string })?.space?.id ?? res.id;
      const joined = fresh.find((s) => s.id === joinedId) ?? null;
      if (joined) activateFamilySpace(joined);
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : t('joinFail'));
    } finally {
      setJoinBusy(false);
    }
  }, [joinBusy, activateFamilySpace]);

  const doJoin = useCallback(() => {
    const code = joinCode.trim();
    if (!code || joinBusy) return;
    // ── family slots: first family free; extra families need a free slot ──
    const famCount = spaces.filter((s) => s.type === 'family').length;
    if (famCount >= familySlots) {
      // kill switch: admin can pause extra-family joins from the admin panel
      if (!flagOn(remoteCfg?.flags, 'extra_families')) {
        setJoinOpen(false);
        showToast(t('featurePaused'));
        return;
      }
      setPendingJoinCode(code);
      setJoinOpen(false);
      setPaywallOpen(true);
      return;
    }
    void runJoin(code);
  }, [joinCode, joinBusy, spaces, familySlots, runJoin, remoteCfg, showToast]);

  /** Leave an invited family from the switcher; frees a slot and resumes a
   *  pending join if the paywall opened this modal. Your own family
   *  (owner) is permanent and can never be deleted. */
  const [famConfirm, setFamConfirm] = useState<string | null>(null);
  const [famMsg, setFamMsg] = useState<string | null>(null);
  // family rename (owner only): the name shows to every member.
  // NOTE: hooks must stay above the early returns (loading / signed-out),
  // so the family space is derived from viewSpace here, not the later famSpace.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameMsg, setRenameMsg] = useState<string | null>(null);
  const openRename = useCallback(() => {
    const fs = viewSpace?.type === 'family' ? viewSpace : null;
    setRenameValue(fs && fs.name !== 'Family' ? fs.name : '');
    setRenameMsg(null);
    setRenameOpen(true);
  }, [viewSpace]);
  const doRename = useCallback(async () => {
    const fs = viewSpace?.type === 'family' ? viewSpace : null;
    if (!fs || renameBusy) return;
    if (!renameValue.trim()) { setRenameMsg(t('renameEmpty')); return; }
    setRenameBusy(true);
    try {
      await engine.renameSpace(fs.id, renameValue);
      setSpaces(await engine.listSpaces());
      setRenameOpen(false);
    } catch {
      setRenameMsg(t('nameSaveFail'));
    } finally {
      setRenameBusy(false);
    }
  }, [viewSpace, renameValue, renameBusy]);  const onFamAction = useCallback(async (s: Space) => {
    if (!!userId && s.owner_id === userId) return; // own family: locked
    if (famConfirm !== s.id) {
      setFamConfirm(s.id);
      setFamMsg(null);
      return;
    }
    setFamConfirm(null);
    try {
      await engine.leaveSpace(s.id);
      const fresh = await engine.listSpaces();
      setSpaces(fresh);
      const rest = fresh.filter((x) => x.type === 'family');
      const next = rest.find((x) => x.id === activeFamilyId) ?? rest[0] ?? null;
      if (view === 'family' && next) activateFamilySpace(next);
      else rememberActiveFamily(next?.id ?? null);
      setFamMsg(null);
      // a slot just freed — resume the join the paywall was blocking
      if (pendingJoinCode && rest.length < familySlots) {
        const code = pendingJoinCode;
        setPendingJoinCode(null);
        setFamsOpen(false);
        setPaywallOpen(false);
        void runJoin(code);
      }
    } catch (e) {
      setFamMsg(e instanceof Error ? e.message : t('joinFail'));
    }
  }, [userId, famConfirm, activeFamilyId, view, pendingJoinCode, familySlots, activateFamilySpace, rememberActiveFamily, runJoin]);

  const familyTitle = useCallback((s: Space | null): string => {
    if (!s) return '';
    // owner-set custom name wins for everyone (invited members see the owner's name)
    if (s.name && s.name !== 'Family') return s.name;
    if (!!userId && s.owner_id === userId) return t('myFamily');
    return t('aFamily');
  }, [userId]);


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
  }, [setNotes]);

  // ── unified Q&A over one space (or all when null) ──
  // ── AI input router needs conversation memory; defined before doAsk ──
  const chatHistory = useCallback(() => {
    return messages
      .filter((m) => !m.pending && m.text.trim() && m.text.trim() !== '…')
      .slice(-6)
      .map((m) => ({
        role: m.role as 'user' | 'app',
        // the agent sees reactions inline, so it understands them like any chat app would
        text: m.reaction ? `${m.text}\n[user reacted ${m.reaction} to this message]` : m.text,
      }));
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
      // 👻 ghost key: master + decoy-master hashes live in memory only (never persisted);
      // state drives the profile setup forms
      engine
        .getMasterHashes(user.id)
        .then((h) => { masterHashRef.current = h.master; decoyMasterHashRef.current = h.decoy; setDecoyMasterSet(!!h.decoy); })
        .catch(() => {});
      engine
        .getVaultMasterState(user.id)
        .then((st) => { setMasterState(st); setRecoveryInfo(recoveryWaitInfo(st.recoveryRequestedAt)); })
        .catch(() => {});
      // family slots (paid hook): 1 = free tier, first family free
      engine
        .getFamilySlots(user.id)
        .then(setFamilySlots)
        .catch(() => {});
      // remote config: feature flags (kill switches) + broadcasts + plans
      fetchRemoteConfig()
        .then((cfg) => {
          if (cfg) setRemoteCfg(cfg);
        })
        .catch(() => {});
      // restore last-viewed family (multi-family switcher)
      AsyncStorage.getItem(ACTIVE_FAMILY_KEY)
        .then((v) => { if (v) setActiveFamilyId(v); })
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
      // Phase E P2-3: sync device timezone → profiles.timezone (fire-and-forget)
      engine.syncDeviceTimezone().catch(() => {});
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
  }, [persistSession, clearDraft, loadHistory, decoyMasterHashRef, masterHashRef, setDecoyMasterSet, setMasterState, setRecoveryInfo, setSecretVault]);

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

  const [privacyBusy, setPrivacyBusy] = useState(false);

  // ── P2-1: crash/error telemetry — the global handler reports to the
  // server (error class only, never user content), then chains to the
  // previous handler so the red screen / crash behavior is unchanged.
  useEffect(() => {
    const report = (message: string, stack?: string) => {
      try {
        supabase.functions
          .invoke('report-error', {
            body: {
              message: String(message).slice(0, 300),
              stack: stack ? String(stack).slice(0, 1000) : undefined,
              context: 'global',
            },
          })
          .catch(() => {});
      } catch {
        /* telemetry never breaks the app */
      }
    };
    const prev = (ErrorUtils as { getGlobalHandler?: () => ((e: unknown, fatal?: boolean) => void) | undefined }).getGlobalHandler?.();
    (ErrorUtils as { setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void }).setGlobalHandler(
      (error, isFatal) => {
        const err = error as { message?: string; stack?: string } | null;
        report(`${isFatal ? 'fatal: ' : ''}${err?.message ?? String(error)}`, err?.stack);
        if (prev) prev(error, isFatal);
      },
    );
    return () => {
      if (prev) {
        (ErrorUtils as { setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void }).setGlobalHandler(prev);
      }
    };
  }, []);

  // ── P2-4: data portability — export my data ──────────────────────────
  const doExportData = useCallback(async () => {
    if (privacyBusy) return;
    setPrivacyBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('account-export', { body: {} });
      if (error) throw error;
      const d = data as { ok?: boolean; export?: unknown; error?: string } | null;
      if (!d?.ok || !d.export) throw new Error(d?.error || t('genericFail'));
      const json = JSON.stringify(d.export, null, 2);
      closeMenu();
      if (Platform.OS === 'web') {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'mawjood-export.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } else {
        await Share.share({ message: json, title: t('exportDataTitle') });
      }
    } catch (e) {
      Alert.alert(t('genericFail'), e instanceof Error ? e.message : t('genericFail'));
    } finally {
      setPrivacyBusy(false);
    }
  }, [privacyBusy, closeMenu]);

  // ── P2-4: right to be forgotten — double confirm, then server wipes all ──
  const doDeleteAccount = useCallback(async () => {
    closeMenu();
    const first = Platform.OS === 'web'
      ? window.confirm(`${t('deleteAccountTitle')}\n\n${t('deleteAccountWarn1')}`)
      : await new Promise<boolean>((resolve) => {
          Alert.alert(t('deleteAccountTitle'), t('deleteAccountWarn1'), [
            { text: t('cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: t('yesDeleteAccount'), style: 'destructive', onPress: () => resolve(true) },
          ]);
        });
    if (!first) return;
    const second = Platform.OS === 'web'
      ? window.confirm(`${t('deleteAccountTitle')}\n\n${t('deleteAccountWarn2')}`)
      : await new Promise<boolean>((resolve) => {
          Alert.alert(t('deleteAccountTitle'), t('deleteAccountWarn2'), [
            { text: t('cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: t('yesDeleteAccount'), style: 'destructive', onPress: () => resolve(true) },
          ]);
        });
    if (!second) return;
    try {
      const { data, error } = await supabase.functions.invoke('account-delete', {
        body: { confirm: true },
      });
      if (error) throw error;
      const d = data as { ok?: boolean; error?: string } | null;
      if (!d?.ok) throw new Error(d?.error || t('genericFail'));
      await signOut();
    } catch (e) {
      Alert.alert(t('genericFail'), e instanceof Error ? e.message : t('genericFail'));
    }
  }, [closeMenu]);

  // chat lifecycle: the current chat stays open 2 min after backgrounding
  // (grace period); past that it's archived into history and a fresh chat
  // starts. Tapping "new chat" archives immediately — same as ChatGPT.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') {
        backgroundedAtRef.current = Date.now();
        saveDraft(messagesRef.current, sessionIdRef.current);
        // (6.3) an open vault or management screen must never survive the
        // background — the next foreground starts clean, as if it was closed
        setSecretVaultId(null);
        closeMgmt();
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
  }, [saveDraft, startNewChat, refreshTheme, closeMgmt, setSecretVaultId]);

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
    [pushMsg, setTasks],
  );

  /**
   * "يا جون جيب تفاح خيار بندورة" → creates a shopping list for جون,
   * notifies ONLY him (targeted push), everyone sees the list in the
   * family space. Returns true when handled (caller skips the agent).
   * Falls through to the normal flow when the name doesn't resolve —
   * never notify the wrong person.
   */
  // ── 🔍 detective + 👨‍👩‍👧 family broadcast ─────────────────────────────
  // "ضيّعت الريموت" → ranked search plan + an interactive check-off
  // session ("شطبت الصالون" / "لقيته!" / "بث للعيلة").
  // "اسأل العيلة …" → the question pushed to every family member.
  // Runs FIRST in the interception chain: an active search conversation
  // must win over every other parser.
  const activeSearchRef = useRef<SearchSession | null>(null);
  // 🛒 smart shopping: the last suggestions ("شو ناقصنا؟") so "ضيفهم" can add them
  const smartSuggestionsRef = useRef<string[] | null>(null);
  // 🧠 user memory: cached facts ("ناديني أبو كريم") injected into the agent prompt
  const memoriesRef = useRef<MemoryFact[] | null>(null);
  // 👍👎 feedback: last user question (paired with the next agent answer) + voted message ids
  const lastQuestionRef = useRef<string>('');
  const [voted, setVoted] = useState<Record<string, 'up' | 'down'>>({});

  const looksLikeOtherCommand = useCallback((text: string): boolean => {
    return (
      !!parseDirectedShopping(text) ||
      !!parseExpenseRecord(text) ||
      !!parseExpenseQuery(text) ||
      isDigestRequest(text) ||
      !!parseBroadcast(text) ||
      !!parseTakeTo(text) ||
      !!parseWatchReply(text) ||
      !!parseHabitQuery(text) ||
      !!parseTimelineQuery(text) ||
      !!parseSmartQuery(text) ||
      !!parseSmartAdd(text) ||
      !!parseMemoryStatement(text) ||
      detectOutOfScope(text).out
    );
  }, []);

  const doBroadcast = useCallback(
    async (question: string, noteId?: string): Promise<boolean> => {
      const famId = spaceIdByType('family');
      if (!famId || !userId) return false;
      try {
        const { recipients } = await sendFamilyBroadcast(engine, {
          spaceId: famId,
          question,
          senderName: displayName ?? userEmail ?? '',
          senderUserId: userId,
        });
        if (noteId) {
          try {
            await engine.deleteNote(noteId);
          } catch {
            /* best effort */
          }
        }
        const msg = formatBroadcastSent(question, recipients);
        pushMsg('app', msg);
        speak(msg);
        return true;
      } catch (e) {
        if (e instanceof NoFamilyMembersError) {
          if (noteId) {
            try {
              await engine.deleteNote(noteId);
            } catch {
              /* best effort */
            }
          }
          const msg = formatNoMembers();
          pushMsg('app', msg);
          speak(msg);
          return true;
        }
        console.warn('family broadcast failed', e);
        return false;
      }
    },
    [userId, spaceIdByType, displayName, userEmail, pushMsg, speak],
  );

  const maybeDetective = useCallback(
    async (text: string, noteId?: string): Promise<boolean> => {
      if (!userId) return false;
      const dropNote = async () => {
        if (noteId) {
          try {
            await engine.deleteNote(noteId);
          } catch {
            /* best effort */
          }
        }
      };
      const session = activeSearchRef.current;

      // ── an active search: follow-ups ──
      if (session) {
        // "لقيته!" → celebrate, ask where, save the answer as place memory
        if (parseFoundIt(text)) {
          session.awaitingPlace = true;
          await dropNote();
          const msg = formatFoundAsk();
          pushMsg('app', msg);
          speak(msg);
          return true;
        }
        // "شطبت الصالون" → mark checked, suggest the next spot
        const checked = parseCheckedPlace(text);
        if (checked) {
          const hit = checkPlace(session, checked);
          await dropNote();
          const msg = hit ? formatChecked(session, hit) : tx('detectivePlaceUnknown', { place: checked });
          pushMsg('app', msg);
          speak(msg);
          return true;
        }
        // "بث للعيلة" → family broadcast about the lost item
        const bq = parseBroadcast(text, session.item);
        if (bq) return doBroadcast(bq, noteId);
        // the "وين لقيته؟" answer → save it (unless it's another command)
        if (session.awaitingPlace && !looksLikeOtherCommand(text)) {
          try {
            const famId = spaceIdByType('family') ?? spaceIdByType('private');
            if (!famId) return false;
            await engine.createItem({
              spaceId: famId,
              kind: 'place',
              title: session.item,
              details: text,
              userId,
            });
            await dropNote();
            activeSearchRef.current = null;
            const msg = formatPlaceSaved(session.item, text);
            pushMsg('app', msg);
            speak(msg);
            return true;
          } catch (e) {
            console.warn('detective place save failed', e);
            return false;
          }
        }
        return false; // session stays alive; other parsers / the agent handle it
      }

      // ── no active search: new lost reports + standalone broadcasts ──
      const lost = parseLostReport(text);
      if (lost) {
        try {
          const plan = await buildSearchPlan(engine, lost);
          activeSearchRef.current = startSession(plan);
          await dropNote();
          const msg = formatSearchPlan(plan);
          pushMsg('app', msg);
          speak(msg);
          return true;
        } catch (e) {
          console.warn('detective plan failed', e);
          return false;
        }
      }
      const bq = parseBroadcast(text);
      if (bq) return doBroadcast(bq, noteId);
      return false;
    },
    [userId, spaceIdByType, pushMsg, speak, doBroadcast, looksLikeOtherCommand],
  );

  const maybeWatch = useCallback(
    async (text: string, noteId?: string): Promise<boolean> => {
      if (!userId) return false;
      const dropNote = async () => {
        if (noteId) {
          try {
            await engine.deleteNote(noteId);
          } catch {
            /* best effort */
          }
        }
      };

      // "أخذت المفك على الكراج" → watch item + a 4h "رجّعته لمكانه؟" nudge
      const take = parseTakeTo(text);
      if (take) {
        try {
          const famId = spaceIdByType('family') ?? spaceIdByType('private');
          if (!famId) return false;
          const { homePlace } = await createWatch(engine, {
            spaceId: famId,
            userId,
            item: take.item,
            place: take.place,
          });
          await dropNote();
          const msg = formatWatchCreated(take.item, homePlace);
          pushMsg('app', msg);
          speak(msg);
          return true;
        } catch (e) {
          console.warn('watch create failed', e);
          return false; // falls through to the agent
        }
      }

      // "وين بلاقي الريموت عادة؟" → habit answer ("9 من 10 مرات")
      const hq = parseHabitQuery(text);
      if (hq) {
        try {
          const habits = await getPlaceHabits(engine, hq);
          await dropNote();
          const msg = formatHabit(hq, habits);
          pushMsg('app', msg);
          speak(msg);
          return true;
        } catch (e) {
          console.warn('habit query failed', e);
          return false;
        }
      }

      // "رجعته" / "لسا" → resolve / snooze an open watch
      const reply = parseWatchReply(text);
      if (reply) {
        try {
          const watches = await listOpenWatches(engine);
          const target = resolveWatchReply(watches, reply);
          if (target === null) return false; // no open watches → the agent handles it
          await dropNote();
          if (target === 'ambiguous') {
            const msg = formatWatchWhich(watches);
            pushMsg('app', msg);
            speak(msg);
            return true;
          }
          if (reply.action === 'done') {
            await engine.resolveWatch(target.id);
            const msg = formatWatchDone(target.title);
            pushMsg('app', msg);
            speak(msg);
          } else {
            await engine.setItemDueAt(target.id, snoozeDueAt());
            const msg = formatWatchSnoozed(target.title);
            pushMsg('app', msg);
            speak(msg);
          }
          return true;
        } catch (e) {
          console.warn('watch reply failed', e);
          return false;
        }
      }
      return false;
    },
    [userId, spaceIdByType, pushMsg, speak],
  );

  // 🕰️ "وين كان المفك؟" → the item's timeline (places + borrows + watches)
  const maybeTimeline = useCallback(
    async (text: string, noteId?: string): Promise<boolean> => {
      if (!userId) return false;
      const item = parseTimelineQuery(text);
      if (!item) return false;
      try {
        const events = await getItemTimeline(engine, item);
        if (noteId) {
          try {
            await engine.deleteNote(noteId);
          } catch {
            /* best effort */
          }
        }
        const msg = formatTimeline(item, events);
        pushMsg('app', msg);
        speak(msg);
        return true;
      } catch (e) {
        console.warn('timeline failed', e);
        return false; // falls through to the agent
      }
    },
    [userId, pushMsg, speak],
  );

  // 🛒 "شو ناقصنا؟" → rhythm-based suggestions; "ضيفهم" → new list
  const maybeSmartShopping = useCallback(
    async (text: string, noteId?: string): Promise<boolean> => {
      if (!userId) return false;
      const dropNote = async () => {
        if (noteId) {
          try {
            await engine.deleteNote(noteId);
          } catch {
            /* best effort */
          }
        }
      };

      // follow-up: add the last suggestions to a new list
      if (parseSmartAdd(text) && smartSuggestionsRef.current?.length) {
        try {
          const famId = spaceIdByType('family') ?? spaceIdByType('private');
          if (!famId) return false;
          const items = smartSuggestionsRef.current;
          smartSuggestionsRef.current = null;
          const title = t('smartListTitle');
          await engine.createShoppingList({
            spaceId: famId,
            title,
            assignedTo: null,
            assignedName: null,
            items,
            userId,
          });
          await dropNote();
          const msg = formatSmartAdded(title, items);
          pushMsg('app', msg);
          speak(msg);
          return true;
        } catch (e) {
          console.warn('smart add failed', e);
          return false;
        }
      }

      if (!parseSmartQuery(text)) return false;
      try {
        const famId = spaceIdByType('family') ?? spaceIdByType('private');
        if (!famId) return false;
        const history = await getBuyHistory(engine, famId);
        const rhythms = getSuggestions(computeRhythms(history));
        smartSuggestionsRef.current = rhythms.length > 0 ? rhythms.map((s) => s.item) : null;
        await dropNote();
        const msg = formatSuggestions(rhythms);
        pushMsg('app', msg);
        speak(msg);
        return true;
      } catch (e) {
        console.warn('smart shopping failed', e);
        return false;
      }
    },
    [userId, spaceIdByType, pushMsg, speak],
  );

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
    [userId, spaceIdByType, displayName, userEmail, pushMsg, speak, setShopLists],
  );

  /**
   * ☀️ Morning digest — "شو عندي اليوم؟" → today's appointments +
   * due/overdue tasks + open shopping lists + open borrows, formatted by
   * the digest engine (src/lib/morningDigest.ts). Returns true when handled
   * (caller skips the agent). A question is not a note — the raw voice
   * note is dropped, like other questions. On failure returns false so
   * the agent still gets a chance to answer.
   */
  const maybeMorningDigest = useCallback(
    async (text: string, noteId?: string): Promise<boolean> => {
      if (!isDigestRequest(text) || !userId) return false;
      try {
        const data = await fetchDigestData(engine);
        const msg = formatDigest(data);
        if (noteId) {
          try {
            await engine.deleteNote(noteId);
          } catch {
            /* best effort */
          }
        }
        pushMsg('app', msg);
        speak(msg);
        return true;
      } catch (e) {
        console.warn('morning-digest failed', e);
        return false;
      }
    },
    [userId, pushMsg, speak],
  );

  /**
   * 💰 Household-expenses interception ("صرفت 40 على الخضرة" → record;
   * "قديش صرفنا هالشهر؟" → summary). Deterministic front-door for the
   * expenses engine (src/lib/expenses.ts). Returns true when handled.
   * Records go to the family space (fallback: private); the raw note is
   * dropped after handling, like other commands. On failure returns false
   * so the agent gets its turn.
   */
  const maybeExpense = useCallback(
    async (text: string, noteId?: string): Promise<boolean> => {
      if (!userId) return false;
      // ── record: "صرفت 40 على الخضرة" ──
      const rec = parseExpenseRecord(text);
      if (rec) {
        try {
          const famId = spaceIdByType('family') ?? spaceIdByType('private');
          if (!famId) return false;
          await recordExpense(engine, {
            spaceId: famId,
            userId,
            title: rec.title,
            amount: rec.amount,
            paidBy: displayName ?? userEmail ?? null,
          });
          if (noteId) {
            try {
              await engine.deleteNote(noteId);
            } catch {
              /* best effort */
            }
          }
          const msg = formatExpenseRecorded(rec);
          pushMsg('app', msg);
          speak(msg);
          return true;
        } catch (e) {
          console.warn('expense record failed', e);
          return false;
        }
      }
      // ── query: "قديش صرفنا هالشهر؟" (across all spaces) ──
      const q = parseExpenseQuery(text);
      if (!q) return false;
      try {
        const spaces = await engine.listSpaces();
        const items = await fetchAllExpenses(engine, spaces);
        const summary = summarizeExpenses(items, q);
        if (noteId) {
          try {
            await engine.deleteNote(noteId);
          } catch {
            /* best effort */
          }
        }
        const msg = formatExpenseSummary(summary);
        pushMsg('app', msg);
        speak(msg);
        return true;
      } catch (e) {
        console.warn('expense query failed', e);
        return false;
      }
    },
    [userId, spaceIdByType, displayName, userEmail, pushMsg, speak],
  );

  /**
   * 🧠 User-memory interception ("ناديني أبو كريم" / "الخضرة عندي يعني بندورة").
   * Deterministic front-door for the userMemory engine (src/lib/userMemory.ts):
   * explicit "remember this about me" statements are stored as items with
   * kind='memory' (upsert by key — no duplicates) instead of becoming junk
   * notes. The facts are injected into the agent prompt on every turn
   * (getMemories → engine.chat). Returns true when handled.
   */
  const memoryClient = useMemo<MemoryClient>(
    () => ({
      listMemoryItems: async (sid: string) =>
        (await engine.listItems(sid)).filter((i) => i.kind === 'memory' && i.status === 'open'),
      deleteMemoryItem: async (id: string) => {
        const { error } = await supabase.from('items').delete().eq('id', id);
        if (error) throw error;
      },
      createMemoryItem: async (input) => {
        await engine.createItem({
          spaceId: input.spaceId,
          kind: 'memory',
          title: input.title,
          details: input.details,
          meta: input.meta,
          userId: input.userId,
        });
      },
    }),
    [],
  );

  /** cached facts; invalidated whenever a fact is saved */
  const getMemories = useCallback(async (): Promise<MemoryFact[]> => {
    if (memoriesRef.current) return memoriesRef.current;
    const pid = spaceIdByType('private');
    if (!pid) return [];
    try {
      const facts = await loadMemoryFacts(memoryClient, pid);
      memoriesRef.current = facts;
      return facts;
    } catch {
      return [];
    }
  }, [spaceIdByType, memoryClient]);

  const maybeMemory = useCallback(
    async (text: string, noteId?: string): Promise<boolean> => {
      if (!userId) return false;
      const fact = parseMemoryStatement(text, getLang());
      if (!fact) return false;
      try {
        const pid = spaceIdByType('private');
        if (!pid) return false;
        await upsertMemoryFact(memoryClient, pid, userId, fact);
        memoriesRef.current = null; // refresh the prompt-injection cache
        if (noteId) {
          try {
            await engine.deleteNote(noteId);
          } catch {
            /* best effort */
          }
        }
        const msg = formatMemorySaved(fact, getLang());
        pushMsg('app', msg);
        speak(msg);
        return true;
      } catch (e) {
        console.warn('memory save failed', e);
        return false;
      }
    },
    [userId, spaceIdByType, memoryClient, pushMsg, speak],
  );

  /**
   * 🛡️ Scope-guard interception ("شو عاصمة فرنسا؟" → polite decline).
   * Runs AFTER every feature engine and BEFORE the agent: clearly
   * out-of-scope inputs (general knowledge, weather, news/sports, jokes,
   * translation) never reach the model. Conservative by design — anything
   * ambiguous passes through to the agent.
   */
  const maybeScopeGuard = useCallback(
    async (text: string, noteId?: string): Promise<boolean> => {
      if (!detectOutOfScope(text).out) return false;
      if (noteId) {
        try {
          await engine.deleteNote(noteId);
        } catch {
          /* best effort */
        }
      }
      const msg = formatScopeRedirect(getLang());
      pushMsg('app', msg);
      speak(msg);
      return true;
    },
    [pushMsg, speak],
  );

  /**
   * 👍👎 Answer feedback: records a vote as an items row with kind='feedback'
   * (meta = { rating, question, answer }) — the learning signal the app
   * accumulates for future few-shot / fine-tuning. Silent best-effort.
   */
  const voteAnswer = useCallback(
    async (msgId: string, rating: 'up' | 'down', answer: string) => {
      if (!userId || voted[msgId]) return;
      setVoted((p) => ({ ...p, [msgId]: rating }));
      try {
        tap();
      } catch {
        /* haptics best effort */
      }
      try {
        const pid = spaceIdByType('private') ?? spaceIdByType('family');
        if (!pid) return;
        await engine.createItem({
          spaceId: pid,
          kind: 'feedback',
          title: rating === 'up' ? '👍 جواب عجبني' : '👎 جواب ما عجبني',
          details: lastQuestionRef.current.slice(0, 200),
          meta: {
            rating,
            question: lastQuestionRef.current.slice(0, 300),
            answer: answer.slice(0, 300),
          },
          userId,
        });
      } catch (e) {
        console.warn('feedback save failed', e);
      }
    },
    [userId, voted, spaceIdByType],
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
      // 🔒👻🪞 (6.1) ghost intercept FIRST: a spoken vault/master/decoy word
      // must never reach the agent, never be saved, never be shown. The voice
      // note (already transcribed server-side) is hard-deleted and its chat
      // bubble removed — as if it never happened.
      if (await tryGhostIntercept(t)) {
        removeMsg(msgId);
        void engine.deleteNote(n.id).catch((e) => console.warn('ghost voice cleanup failed', e));
        return;
      }
      updateMsg(msgId, { text: t, pending: false });
      // "ضيّعت الريموت" (voice) → detective search plan; active-search
      // follow-ups ("شطبت"، "لقيته"، "بث للعيلة") win over every parser
      if (await maybeDetective(t, n.id)) return;
      // "أخذت المفك على الكراج" (voice) → prevention watch; "رجعته"/"لسا"
      // resolve it; "وين بلاقي الريموت عادة؟" → habit answer
      if (await maybeWatch(t, n.id)) return;
      // "وين كان المفك؟" (voice) → item timeline (no agent round-trip)
      if (await maybeTimeline(t, n.id)) return;
      // "شو ناقصنا؟" (voice) → smart shopping suggestions; "ضيفهم" → new list
      if (await maybeSmartShopping(t, n.id)) return;
      // "يا جون جيب تفاح…" (voice) → shopping list; the note is dropped, the list is the record
      if (await maybeDirectedShopping(t, n.id)) return;
      // "شو عندي اليوم؟" (voice) → morning digest; the question is not saved as a note
      if (await maybeMorningDigest(t, n.id)) return;
      // "صرفت 40 على الخضرة" / "قديش صرفنا هالشهر؟" (voice) → expenses engine
      if (await maybeExpense(t, n.id)) return;
      // "ناديني أبو كريم" (voice) → user-memory fact, not a junk note
      if (await maybeMemory(t, n.id)) return;
      // out-of-scope ("شو عاصمة فرنسا؟") → polite decline, never reaches the model
      if (await maybeScopeGuard(t, n.id)) return;
      lastQuestionRef.current = t;
      const thinkId = pushMsg('app', '…', { pending: true });
      const mems = await getMemories();
      const r = await engine.chat(t, chatHistory(), n.id, null, getLang(), mems.map((m) => m.label));
      if (r) {
        updateMsg(thinkId, { text: r.answer, pending: false, proposal: r.proposal ?? null });
        speak(r.answer);
      } else {
        removeMsg(thinkId);
        await legacyVoice(t, n, msgId);
      }
    },
    [chatHistory, pushMsg, updateMsg, removeMsg, legacyVoice, speak, maybeDetective, maybeWatch, maybeTimeline, maybeSmartShopping, maybeDirectedShopping, maybeMorningDigest, maybeExpense, maybeMemory, maybeScopeGuard, getMemories, tryGhostIntercept],
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

  /**
   * 🔒👻🪞 Ghost intercept — shared by typed AND voice input (6.1).
   * A saved vault code / the master word / the decoy-master word opens its
   * target directly: never saved as a note, never sent to the agent, never
   * shown as a chat bubble. Returns true when a word matched.
   */
  const onSendText = useCallback(async (override?: string) => {
    const clean = (override ?? textNote).trim();
    if (!clean || !userId) return;
    // 🔒👻🪞 ghost intercept: a saved code / master / decoy-master opens its
    // target — never saved as a note, never sent anywhere (see tryGhostIntercept)
    if (await tryGhostIntercept(clean)) {
      setTextNote('');
      setComposerH(36);
      return;
    }
    voiceModeRef.current = false; // text in → text out (no voice reply)
    // attached photo goes with the note: upload it before the agent runs
    const photoUri = chatPhotoUri;
    setChatPhotoUri(null);
    const userMsgId = pushMsg('user', clean, { photo: photoUri });
    setTextNote('');
    setComposerH(36);
    // "ضيّعت الريموت" → detective (no photo: with a photo the normal flow
    // keeps it — a photo of the lost item must never be silently dropped)
    if (!photoUri && (await maybeDetective(clean))) return;
    // "أخذت المفك على الكراج" → prevention watch (no photo: a photo of the
    // taken item must never be silently dropped)
    if (!photoUri && (await maybeWatch(clean))) return;
    // "وين كان المفك؟" → item timeline (no agent round-trip)
    if (!photoUri && (await maybeTimeline(clean))) return;
    // "شو ناقصنا؟" → smart shopping (no agent round-trip)
    if (!photoUri && (await maybeSmartShopping(clean))) return;
    // "يا جون جيب تفاح…" → shopping list (no agent round-trip); photo+list combo → normal flow
    if (!photoUri && (await maybeDirectedShopping(clean))) return;
    // "شو عندي اليوم؟" → morning digest (no agent round-trip)
    if (await maybeMorningDigest(clean)) return;
    // "صرفت 40 على الخضرة" / "قديش صرفنا هالشهر؟" → expenses engine (no photo: with a
    // photo the normal flow keeps it — a receipt photo must never be silently dropped)
    if (!photoUri && (await maybeExpense(clean))) return;
    // "ناديني أبو كريم" → user-memory fact (no photo: the photo must never be dropped)
    if (!photoUri && (await maybeMemory(clean))) return;
    // out-of-scope ("شو عاصمة فرنسا؟") → polite decline (no photo: same reason)
    if (!photoUri && (await maybeScopeGuard(clean))) return;
    lastQuestionRef.current = clean;
    const photoUrl = photoUri
      ? await engine.uploadNotePhoto(photoUri, userId).catch(() => null)
      : null;
    if (photoUri && !photoUrl) {
      updateMsg(userMsgId, { photo: null });
      pushMsg('app', t('photoFailNote'));
    }
    const thinkId = pushMsg('app', '…', { pending: true });
    const mems = await getMemories();
    const r = await engine.chat(clean, chatHistory(), undefined, photoUrl, getLang(), mems.map((m) => m.label));
    if (r) {
      updateMsg(thinkId, { text: r.answer, pending: false, proposal: r.proposal ?? null });
    } else {
      removeMsg(thinkId);
      await legacyText(clean, photoUrl);
    }
  }, [textNote, userId, pushMsg, updateMsg, removeMsg, chatHistory, legacyText, chatPhotoUri, maybeDetective, maybeWatch, maybeTimeline, maybeSmartShopping, maybeDirectedShopping, maybeMorningDigest, maybeExpense, maybeMemory, maybeScopeGuard, getMemories, tryGhostIntercept]);

  // ── interactive onboarding (first run): the demo exchange is voice-led ──
  // A real note is recorded + saved, the agent answers it, the answer is spoken
  // (voice in → voice out, same rule as chat), and the whole exchange stays in
  // the chat as real history once the welcome modal closes.
  const demoStartRecord = useCallback(async (): Promise<boolean> => {
    // 20s safety: a dismissed permission prompt must never wedge the UI
    return await Promise.race([
      start(),
      new Promise<boolean>((res) => setTimeout(() => res(false), 20000)),
    ]);
  }, [start]);

  const demoStopRecord = useCallback(async (): Promise<string | null> => {
    const audio = await stop();
    const spaceId = spaceIdByType('private');
    if (!audio || !spaceId || !userId) return null;
    try {
      const note = await engine.saveVoiceNote(spaceId, audio, userId, null);
      const deadline = Date.now() + 90_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        const n = await engine.getNote(note.id).catch(() => null);
        if (n && (n.status === 'ready' || n.status === 'failed')) {
          const tr = n.status === 'ready' ? n.transcript?.trim() || null : null;
          // ghost words never survive onboarding either — same rule as chat
          if (tr && (await tryGhostIntercept(tr))) return null;
          return tr;
        }
        if (Date.now() > deadline) return null;
      }
    } catch (e) {
      console.warn('demoStopRecord failed', e);
      return null;
    }
  }, [stop, spaceIdByType, userId, tryGhostIntercept]);

  const demoSaveText = useCallback(
    async (text: string): Promise<string | null> => {
      const clean = text.trim();
      const spaceId = spaceIdByType('private');
      if (!clean || !spaceId || !userId) return null;
      if (await tryGhostIntercept(clean)) return null;
      try {
        await engine.saveTextNote(spaceId, clean, userId, null);
        return clean;
      } catch (e) {
        console.warn('demoSaveText failed', e);
        return null;
      }
    },
    [spaceIdByType, userId, tryGhostIntercept],
  );

  const demoAsk = useCallback(
    async (question: string): Promise<string | null> => {
      const clean = question.trim();
      if (!clean || !userId) return null;
      if (await tryGhostIntercept(clean)) return null;
      voiceModeRef.current = true; // voice-led demo exchange → spoken answer
      pushMsg('user', clean);
      const thinkId = pushMsg('app', '…', { pending: true });
      try {
        const mems = await getMemories();
        const r = await engine.chat(
          clean,
          chatHistory(),
          undefined,
          null,
          getLang(),
          mems.map((m) => m.label),
        );
        if (r?.answer) {
          updateMsg(thinkId, { text: r.answer, pending: false, proposal: r.proposal ?? null });
          speak(r.answer);
          return r.answer;
        }
        removeMsg(thinkId);
        return null;
      } catch (e) {
        console.warn('demoAsk failed', e);
        removeMsg(thinkId);
        return null;
      }
    },
    [userId, pushMsg, updateMsg, removeMsg, chatHistory, getMemories, speak, tryGhostIntercept],
  );

  // ── space browsing ──
  const openSpace = useCallback(
    (t: SpaceType) => {
      // family tab reopens the last-viewed family (multi-family switcher)
      const s = t === 'family' ? resolveFamilySpace() : pickSpace(t);
      itemsSub.current?.();
      itemsSub.current = null;
      setViewSpace(s);
      setView(t);
      // clear every tab's search when switching spaces
      notesSearch.setQuery('');
      thingsSearch.setQuery('');
      tasksSearch.setQuery('');
      agendaSearch.setQuery('');
      shopSearch.setQuery('');
      memberSearch.setQuery('');
      setSpaceTab('notes');
      if (s) {
        const sid = s.id;
        // paginated tab lists, 10/page (explicit loaders — sid is fresh before re-render)
        notesPage.refresh((o, l) => engine.listNotes(sid, { offset: o, limit: l, tabId: null }));
        thingsPage.refresh((o, l) => engine.listThings(sid, { offset: o, limit: l }));
        refreshItems(sid);
        refreshTabs(sid);
        if (s.type === 'family') {
          tasksPage.refresh((o, l) => engine.listTasks(sid, { offset: o, limit: l }));
          upcomingPage.refresh((o, l) => engine.listUpcoming(sid, { offset: o, limit: l }));
          refreshFamily(sid);
          refreshFamilyMembers(s);
          // realtime: any family member's change refreshes everyone's lists
          itemsSub.current = engine.subscribeItems(s.id, () => {
            tasksPage.refresh();
            upcomingPage.refresh();
            thingsPage.refresh();
            refreshFamily(s.id);
            refreshItems(s.id);
          });
        }
      }
    },
    [
      pickSpace,
      resolveFamilySpace,
      refreshItems,
      refreshFamily,
      refreshTabs,
      refreshFamilyMembers,
      notesPage,
      thingsPage,
      tasksPage,
      upcomingPage,
      notesSearch,
      thingsSearch,
      tasksSearch,
      agendaSearch,
      shopSearch,
      memberSearch,
    ],
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
        // 🔥 stir the pot: the kicked member gets a push naming who removed them
        const by = displayName ?? userEmail ?? '';
        engine
          .notifyUser(memberId, t('kickedPushTitle'), tx('kickedPushBody', { by }))
          .catch(() => {});
      } catch (e) {
        console.warn('remove member failed', e);
      }
    },
    [confirmRemove, refreshFamilyMembers, displayName, userEmail],
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
        // multi-family: fall back to another family if one remains
        const rest = fresh.filter((s) => s.type === 'family' && s.id !== space.id);
        if (rest.length > 0) {
          const next = rest.find((s) => s.id === activeFamilyId) ?? rest[0];
          activateFamilySpace(next);
        } else {
          rememberActiveFamily(null);
          setViewSpace(null);
          setView('chat');
        }
        setFamilyMembers(null);
      } catch (e) {
        console.warn('leave failed', e);
      }
    },
    [confirmLeave, activeFamilyId, activateFamilySpace, rememberActiveFamily],
  );

  // ── Shopping is list-only: manual list creator (+ assignee picker) ──


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
    [assignName, viewSpace, userId, setTasks, setAssignFor, setAssignName],
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
  /** long-press reaction emojis, WhatsApp-style */
  const REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏', '👎'];

  /** 👎 on an agent answer → the agent notices and offers to redo it. */
  const agentNoticesReaction = useCallback(
    (msg: ChatMsg) => {
      if (msg.role !== 'app' || msg.pending) return;
      pushMsg('app', t('reactionMissed'));
    },
    [pushMsg],
  );

  /** tap an emoji in the reaction bar: set it, or tap again to remove it. */
  const applyReaction = useCallback(
    (msg: ChatMsg, emoji: string) => {
      const next = msg.reaction === emoji ? null : emoji;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, reaction: next } : m)));
      setReactFor(null);
      tap('light');
      if (next === '👎') agentNoticesReaction(msg);
    },
    [agentNoticesReaction],
  );

  /** delete any chat bubble via the reaction bar. */
  const deleteMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setReactFor(null);
    tap('medium');
  }, []);

  // ── render: chat message (long-press → emoji reactions + delete) ──
  const renderMsg = ({ item }: { item: ChatMsg }) => {
    const reacting = reactFor === item.id && !item.pending;
    return (
      <View
        style={[styles.msgWrap, item.role === 'user' ? styles.msgWrapUser : styles.msgWrapApp]}
      >
        {reacting && (
          <View style={styles.reactBar}>
            {REACTION_EMOJIS.map((e) => (
              <Pressable key={e} onPress={() => applyReaction(item, e)} hitSlop={6}>
                <View style={[styles.reactHit, item.reaction === e && styles.reactHitOn]}>
                  <Text style={styles.reactEmoji}>{e}</Text>
                </View>
              </Pressable>
            ))}
            <Pressable onPress={() => deleteMessage(item.id)} hitSlop={6}>
              <View style={styles.reactHit}>
                <Text style={styles.reactEmoji}>🗑️</Text>
              </View>
            </Pressable>
          </View>
        )}
        <Pressable
          onLongPress={() => !item.pending && setReactFor(reacting ? null : item.id)}
          delayLongPress={350}
        >
          <View style={[styles.bubble, item.role === 'user' ? styles.bubbleUser : styles.bubbleApp]}>
            {item.photo ? (
              <Pressable onPress={() => setPhotoViewer(item.photo!)}>
                <SignedImage photo={item.photo} style={styles.bubblePhoto} />
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
            {item.role === 'app' && !item.pending && (
              <View style={styles.feedbackRow}>
                <Pressable onPress={() => voteAnswer(item.id, 'up', item.text)} hitSlop={10}>
                  <Text
                    style={[styles.feedbackBtn, voted[item.id] === 'up' && styles.feedbackBtnOn]}
                  >
                    👍
                  </Text>
                </Pressable>
                <Pressable onPress={() => voteAnswer(item.id, 'down', item.text)} hitSlop={10}>
                  <Text
                    style={[styles.feedbackBtn, voted[item.id] === 'down' && styles.feedbackBtnOn]}
                  >
                    👎
                  </Text>
                </Pressable>
              </View>
            )}
            {item.reaction ? (
              <View
                style={[
                  styles.reactionBadge,
                  item.role === 'user' ? styles.reactionBadgeUser : styles.reactionBadgeApp,
                ]}
              >
                <Text style={styles.reactionBadgeText}>{item.reaction}</Text>
              </View>
            ) : null}
            {/* ── 🗂️ tab proposal card: create / send-to-manager / dismiss ── */}
            {item.role === 'app' && item.proposal ? (
              <View style={styles.proposalCard}>
                <Text style={styles.proposalTitle}>
                  {item.proposal.emoji} {item.proposal.name}
                </Text>
                {item.proposal.reason ? (
                  <Text style={styles.proposalReason}>{item.proposal.reason}</Text>
                ) : null}
                <View style={styles.proposalBtns}>
                  {(() => {
                    const pSpace = spaces.find((s) => s.id === item.proposal!.space_id);
                    const canCreate = !!pSpace && !!userId && pSpace.owner_id === userId;
                    return canCreate ? (
                      <Pressable
                        onPress={() => createProposedTab(item.id, item.proposal!)}
                        style={styles.proposalBtn}
                      >
                        <Text style={styles.proposalBtnText}>{t('tabProposalCreate')}</Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        onPress={() => sendProposalToManager(item.id, item.proposal!)}
                        style={styles.proposalBtn}
                      >
                        <Text style={styles.proposalBtnText}>{t('tabProposalSend')}</Text>
                      </Pressable>
                    );
                  })()}
                  <Pressable
                    onPress={() => dismissProposal(item.id, item.proposal!)}
                    style={styles.proposalBtnGhost}
                    hitSlop={8}
                  >
                    <Text style={styles.proposalBtnGhostText}>✕</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>
        </Pressable>
      </View>
    );
  };

  // ── render: space note card ──
  const renderNote = ({ item }: { item: Note }) => {
    const items = noteItems[item.id] ?? [];
    return (
      <SwipeRow onSwipeLeft={() => void askDeleteNote(item.id)}>
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
              <Pressable
                onPress={() => void askDeleteNote(item.id)}
                style={styles.moveBtn}
                accessibilityLabel={t('deleteNote')}
              >
                <Text style={styles.moveBtnText}>🗑️</Text>
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

          {notesSearch.inSearch ? (
            <Highlight text={statusLabel(item)} query={notesSearch.query} style={styles.cardText} />
          ) : (
            <Text style={styles.cardText}>{statusLabel(item)}</Text>
          )}
          {item.photo_url ? (
            <Pressable onPress={() => setPhotoViewer(item.photo_url!)} style={{ marginTop: 8 }}>
              <SignedImage photo={item.photo_url} style={styles.cardPhoto} />
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
                {notesSearch.inSearch ? (
                  <Highlight
                    text={it.title}
                    query={notesSearch.query}
                    style={[styles.itemTitle, it.status === 'done' && styles.itemDone]}
                  />
                ) : (
                  <Text
                    style={[styles.itemTitle, it.status === 'done' && styles.itemDone]}
                  >
                    {it.title}
                  </Text>
                )}
                {it.details ? (
                  notesSearch.inSearch ? (
                    <Highlight text={it.details} query={notesSearch.query} style={styles.itemDetails} />
                  ) : (
                    <Text style={styles.itemDetails}>{it.details}</Text>
                  )
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
      </SwipeRow>
    );
  };

  /** Secret vault note card: edit + delete, exactly like app note cards. */
  const renderSecretNote = ({ item }: { item: Note }) => {
    const editing = secretEditingId === item.id;
    const delArmed = secretDelId === item.id;
    return (
      <SwipeRow onSwipeLeft={() => askDeleteSecret(item.id)}>
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
        ) : secretSearch.trim() ? (
          <Highlight text={item.transcript ?? ''} query={secretSearch.trim()} style={styles.cardText} />
        ) : (
          <Text style={styles.cardText}>{item.transcript}</Text>
        )}
        {item.photo_url ? (
          <Pressable onPress={() => setPhotoViewer(item.photo_url!)} style={{ marginTop: 8 }}>
            <SignedImage photo={item.photo_url} style={styles.cardPhoto} />
          </Pressable>
        ) : null}
      </View>
      </SwipeRow>
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

  // notes list: search results replace the paged list while searching.
  // (tab filtering now happens server-side via listNotes' tabId)
  const listData = notesSearch.inSearch ? (notesSearch.results?.notes ?? []) : notes;

  // notes browser (shared by all spaces; family shows it under the 📝 tab)
  // ── Phase 4: 📦 أشيائي list (shared by all space views) ──
  const thingsList = (
    <>
      <SearchBar
        value={thingsSearch.query}
        onChange={thingsSearch.setQuery}
        placeholder={t('searchThings')}
        searching={thingsSearch.searching}
      />
      <FlatList
        style={styles.fill}
        data={thingsSearch.inSearch ? (thingsSearch.results ?? []) : things}
        keyExtractor={(i) => i.id}
        contentContainerStyle={styles.list}
        onEndReached={thingsSearch.inSearch ? undefined : thingsPage.loadMore}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          !thingsSearch.inSearch && thingsPage.loadingMore ? (
            <ActivityIndicator size="small" color={P.accent} style={styles.moreSpinner} />
          ) : null
        }
      refreshControl={<RefreshControl refreshing={thingsPage.loading} onRefresh={() => thingsPage.refresh()} tintColor={P.accent} colors={[P.accent]} />}
      ListEmptyComponent={
        thingsSearch.inSearch ? (
          <Text style={styles.muted}>{t('noResults')}</Text>
        ) : thingsPage.loading && things.length === 0 ? (
          <ActivityIndicator size="small" color={P.accent} style={styles.moreSpinner} />
        ) : (
          <EmptyState icon="📦" message={t('thingsEmpty')} example={t('exThings')} onTryExample={tryExample} />
        )
      }
      renderItem={({ item }) => {
        const photoUrl = item.meta?.photo_url ?? null;
        const br = borrowFor(item.title);
        return (
          <>
            <SwipeRow onSwipeLeft={() => void askDeleteItem(item)}>
            <View style={styles.famRow}>
              {photoUrl ? (
                <Pressable onPress={() => setPhotoViewer(photoUrl)}>
                  <SignedImage photo={photoUrl} style={styles.thingThumb} />
                </Pressable>
              ) : (
                <Text style={styles.itemIcon}>📦</Text>
              )}
              <View style={styles.itemBody}>
                {thingsSearch.inSearch ? (
                  <Highlight text={item.title} query={thingsSearch.query} style={styles.itemTitle} />
                ) : (
                  <Text style={styles.itemTitle}>{item.title}</Text>
                )}
                {item.details ? (
                  thingsSearch.inSearch ? (
                    <Highlight text={`📍 ${item.details}`} query={thingsSearch.query} style={styles.itemDetails} />
                  ) : (
                    <Text style={styles.itemDetails}>📍 {item.details}</Text>
                  )
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
                onPress={() => setMoveItemFor(moveItemFor === item.id ? null : item.id)}
                style={styles.moveBtn}
                accessibilityLabel={t('moveToSpace')}
              >
                <Text style={styles.moveBtnText}>{t('move')}</Text>
              </Pressable>
              <Pressable
                onPress={() => void askDeleteItem(item)}
                style={styles.moveBtn}
                accessibilityLabel={t('deleteThing')}
              >
                <Text style={styles.moveBtnText}>🗑️</Text>
              </Pressable>
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
            </SwipeRow>
            {moveItemFor === item.id && (
              <View style={styles.moveRow}>
                <Text style={styles.moveLabel}>{t('moveTo')}</Text>
                {spaces
                  .filter((s) => s.id !== item.space_id)
                  .map((s) => (
                    <Pressable
                      key={s.id}
                      onPress={() => void moveItemSpace(item, s.id)}
                      style={styles.moveTarget}
                    >
                      <Text style={styles.moveTargetText}>
                        {SPACE_LABELS[s.type] ?? s.name}
                      </Text>
                    </Pressable>
                  ))}
              </View>
            )}
          </>
        );
      }}
    />
    </>
  );

  const notesBrowser = (
    <>
      <SearchBar
        value={notesSearch.query}
        onChange={notesSearch.setQuery}
        placeholder={t('searchPh')}
        searching={notesSearch.searching}
      />

      <FlatList
        style={styles.fill}
        data={listData}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        onEndReached={notesSearch.inSearch ? undefined : notesPage.loadMore}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          !notesSearch.inSearch && notesPage.loadingMore ? (
            <ActivityIndicator size="small" color={P.accent} style={styles.moreSpinner} />
          ) : null
        }
        refreshControl={<RefreshControl refreshing={notesPage.loading} onRefresh={() => notesPage.refresh()} tintColor={P.accent} colors={[P.accent]} />}
        ListEmptyComponent={
          notesSearch.inSearch ? (
            <Text style={styles.muted}>{t('noResults')}</Text>
          ) : notesPage.loading && notes.length === 0 ? (
            <ActivityIndicator size="small" color={P.accent} style={styles.moreSpinner} />
          ) : (
            <EmptyState icon="📝" message={t('notesEmpty')} example={t('exNotes')} onTryExample={tryExample} />
          )
        }
        ListHeaderComponent={
          notesSearch.inSearch &&
          notesSearch.results &&
          notesSearch.results.items.length > 0 ? (
            <View style={styles.searchItems}>
              <Text style={styles.searchItemsLabel}>
                {tx('searchItems', { count: String(notesSearch.results.items.length) })}
              </Text>
              {notesSearch.results.items.map((it) => (
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
              onPress={() => setTabMoveFor(tabMoveFor === menuTab.id ? null : menuTab.id)}
              style={styles.tabMenuBtn}
            >
              <Text style={styles.tabMenuText}>📦 {t('moveToSpace')}</Text>
            </Pressable>
            {tabMoveFor === menuTab.id && (
              <View>
                {spaces
                  .filter((s) => s.id !== menuTab.space_id)
                  .map((s) => (
                    <Pressable
                      key={s.id}
                      onPress={() => void moveTabSpace(menuTab.id, s.id)}
                      style={styles.tabMenuBtn}
                    >
                      <Text style={styles.tabMenuText}>
                        {SPACE_LABELS[s.type] ?? s.name}
                      </Text>
                    </Pressable>
                  ))}
              </View>
            )}
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
  const drawerFamSpace = resolveFamilySpace();
  const drawerIsManager = !!userId && !!drawerFamSpace && drawerFamSpace.owner_id === userId;

  // shopping is list-only: active lists + archived history
  // (client-side search filter — collections are small)
  const shopFiltered = shopSearch.inSearch ? (shopSearch.results ?? []) : shopLists;
  const activeLists = shopFiltered.filter((l) => l.status !== 'done');
  const archivedLists = shopFiltered.filter((l) => l.status === 'done');
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

            {/* multi-family switcher lives here now (keeps the family page short) */}
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                closeMenu();
                setFamMsg(null);
                setFamConfirm(null);
                setFamsOpen(true);
              }}
            >
              <Text style={styles.menuItemIcon}>👨‍👩‍👧</Text>
              <Text style={[styles.menuItemText, { textAlign: ta() }]}>{t('menuFamilies')}</Text>
              <Text style={styles.menuSoon} numberOfLines={1}>
                {familyTitle(drawerFamSpace)}
              </Text>
            </Pressable>

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

            {/* ── P2-4: privacy — export / delete ── */}
            <Pressable
              style={styles.menuItem}
              onPress={doExportData}
              disabled={privacyBusy}
            >
              <Text style={styles.menuItemIcon}>📥</Text>
              <Text style={[styles.menuItemText, { textAlign: ta() }]}>
                {privacyBusy ? '…' : t('menuPrivacyExport')}
              </Text>
            </Pressable>

            <Pressable
              style={styles.menuItem}
              onPress={doDeleteAccount}
            >
              <Text style={styles.menuItemIcon}>🗑️</Text>
              <Text style={[styles.menuItemText, { textAlign: ta(), color: '#d33' }]}>
                {t('menuPrivacyDelete')}
              </Text>
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
                  void openTrash(false);
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
          <View style={[styles.modalCard, styles.profileCard]}>
            <ScrollView showsVerticalScrollIndicator={false} style={styles.profileScroll}>
              {/* ── identity header (avatar 64 · name 20/700 · email 13 gray) ── */}
              <View style={styles.profileHeader}>
                <View style={styles.profileAvatar}>
                  <Text style={styles.profileAvatarText}>
                    {(displayName?.[0] ?? userEmail?.[0] ?? '؟').toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.profileName} numberOfLines={1}>
                  {displayName ?? userEmail ?? t('trialAccount')}
                </Text>
                {displayName && userEmail ? (
                  <Text style={styles.profileEmail} numberOfLines={1}>{userEmail}</Text>
                ) : null}
                <Text style={styles.profileBadge}>
                  {isAnonymous ? t('trialBadge') : t('permAccountBadge')}
                </Text>
              </View>

              {/* ── info section: grouped card with dividers ── */}
              <Text style={styles.sectionHeader}>{t('profileInfoSection')}</Text>
              <View style={styles.infoCard}>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>{t('emailLabel')}</Text>
                  <Text style={styles.infoValue} numberOfLines={1}>{userEmail ?? '—'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>{t('accountType')}</Text>
                  <Text style={styles.infoValue}>{isAnonymous ? t('trial') : t('permanent')}</Text>
                </View>
                {memberSince ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>{t('memberSince')}</Text>
                    <Text style={styles.infoValue}>
                      {new Date(memberSince).toLocaleDateString(getLang() === 'ar' ? 'ar' : 'en')}
                    </Text>
                  </View>
                ) : null}
                <View style={[styles.infoRow, styles.infoRowLast]}>
                  <Text style={styles.infoLabel}>{t('spacesLabel')}</Text>
                  <Text style={styles.infoValue}>
                    {spaces.length > 0 ? `${spaces.length}` : '—'}
                  </Text>
                </View>
              </View>

              {/* ── display name: filled input (16px — no iOS zoom) ── */}
              <Text style={styles.sectionHeader}>{t('displayNameLabel')}</Text>
              <TextInput
                style={[styles.fieldInput, { textAlign: ta() }]}
                value={nameDraft}
                onChangeText={(tt) => {
                  setNameDraft(tt);
                  setNameError(null);
                }}
                placeholder={t('nameExample')}
                placeholderTextColor={P.faint2}
                maxLength={60}
              />
              {nameError ? <Text style={styles.fieldError}>⚠️ {nameError}</Text> : null}
              <Pressable
                onPress={saveDisplayName}
                disabled={nameSaving}
                style={[styles.primaryBtn, nameSaving && styles.primaryBtnDisabled]}
              >
                <Text style={styles.primaryBtnText}>
                  {nameSaving ? t('saving') : nameSavedTick ? t('nameSaved') : t('saveName')}
                </Text>
              </Pressable>

              {secretVault.enabled ? (
                /* opsec: the section ALWAYS looks pristine — saving a code changes
                   nothing visually, so nobody holding the phone can tell a vault
                   exists. A new code simply opens a new vault page. */
                <>
                  <Text style={styles.sectionHeader}>🔒 {t('secretTab')}</Text>
                  <Text style={styles.fieldHint}>{t('secretHint')}</Text>
                  <TextInput
                    style={[styles.fieldInput, { textAlign: secretCodeDraft ? codeAlign(secretCodeDraft) : ta() }]}
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
                    <Text style={secretCodeMsgOk ? styles.fieldOk : styles.fieldError}>
                      {secretCodeMsgOk ? '✅ ' : '⚠️ '}{secretCodeMsg}
                    </Text>
                  ) : null}
                  <Pressable onPress={() => void saveSecretCode()} style={styles.primaryBtn}>
                    <Text style={styles.primaryBtnText}>{t('saveSecretCode')}</Text>
                  </Pressable>
                  {/* 👻 ghost key: two tiny buttons — no trace of anything, forms reveal on tap only */}
                  <View style={styles.secretGhostRow}>
                    <Pressable onPress={() => { const opening = !masterFormOpen; setMasterFormMode('setup'); setMasterFormOpen(opening); if (opening) void refreshMaster(); }} style={styles.ghostBtnSmall}>
                      <Text style={styles.ghostBtnSmallText}>👻 {t('masterKey')}</Text>
                    </Pressable>
                    <Pressable onPress={() => setDuressFormOpen((v) => !v)} style={styles.ghostBtnSmall}>
                      <Text style={styles.ghostBtnSmallText}>🎭 {t('duressKey')}</Text>
                    </Pressable>
                  </View>
                  {masterState?.hasMaster && !masterFormOpen ? (
                    recoveryInfo ? (
                      <View style={{ marginTop: 6 }}>
                        <Text style={[styles.fieldHint, { textAlign: ta() }]}>
                          ⏳ {t('masterRecoverActive')} — {recoveryInfo.daysLeft} ⏳
                        </Text>
                        <Pressable onPress={() => void cancelRecoveryLocal()} style={[styles.ghostBtnSmall, { marginTop: 4 }]}>
                          <Text style={styles.ghostBtnSmallText}>{t('masterRecoverCancel')}</Text>
                        </Pressable>
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => { setMasterFormMode('recover'); setMasterFormOpen(true); void refreshMaster(); }}
                        style={{ marginTop: 6 }}
                      >
                        <Text style={[styles.fieldHint, { textAlign: ta() }]}>💡 {t('masterForgot')}</Text>
                      </Pressable>
                    )
                  ) : null}
                  {masterFormOpen ? (
                    <View style={styles.secretSubForm}>
                      <Text style={styles.fieldHint}>{t('masterHint')}</Text>
                      {masterFormMode === 'recover' && masterState?.hasMaster ? (
                        recoveryInfo?.ready ? (
                          <>
                            <TextInput
                              style={[styles.fieldInput, { textAlign: masterNew ? codeAlign(masterNew) : ta() }]}
                              value={masterNew}
                              onChangeText={(x) => { setMasterNew(x); setMasterMsg(null); }}
                              placeholder={t('masterNewPh')}
                              placeholderTextColor={P.faint2}
                              maxLength={60}
                              secureTextEntry
                            />
                            <Text style={styles.fieldHint}>⚠️ {t('codeExactNote')}</Text>
                            <Pressable
                              onPress={() => void completeRecoveryLocal()}
                              disabled={masterSaving}
                              style={[styles.primaryBtn, masterSaving && styles.primaryBtnDisabled]}
                            >
                              <Text style={styles.primaryBtnText}>{t('saveSecretCode')}</Text>
                            </Pressable>
                          </>
                        ) : recoveryInfo ? (
                          <>
                            <Text style={styles.fieldHint}>
                              ⏳ {t('masterRecoverActive')} — {recoveryInfo.daysLeft} ⏳
                            </Text>
                            <Pressable onPress={() => void cancelRecoveryLocal()} style={styles.ghostBtnSmall}>
                              <Text style={styles.ghostBtnSmallText}>{t('masterRecoverCancel')}</Text>
                            </Pressable>
                          </>
                        ) : (
                          <Pressable onPress={() => void requestRecoveryLocal()} style={styles.ghostBtnSmall}>
                            <Text style={styles.ghostBtnSmallText}>{t('masterForgot')} — {t('masterRecoverReq')}</Text>
                          </Pressable>
                        )
                      ) : (
                        <>
                          <TextInput
                            style={[styles.fieldInput, { textAlign: masterNew ? codeAlign(masterNew) : ta() }]}
                            value={masterNew}
                            onChangeText={(x) => { setMasterNew(x); setMasterMsg(null); }}
                            placeholder={t('masterNewPh')}
                            placeholderTextColor={P.faint2}
                            maxLength={60}
                            secureTextEntry
                          />
                          <Text style={styles.fieldHint}>⚠️ {t('codeExactNote')}</Text>
                          <Pressable
                            onPress={() => void saveMasterKeyLocal()}
                            disabled={masterSaving}
                            style={[styles.primaryBtn, masterSaving && styles.primaryBtnDisabled]}
                          >
                            <Text style={styles.primaryBtnText}>{t('saveSecretCode')}</Text>
                          </Pressable>
                        </>
                      )}
                      {masterMsg ? (
                        <Text style={masterMsgOk ? styles.fieldOk : styles.fieldError}>
                          {masterMsgOk ? '✅ ' : '⚠️ '}{masterMsg}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                  {duressFormOpen ? (
                    <View style={styles.secretSubForm}>
                      <Text style={styles.fieldHint}>{t('duressHint')}</Text>
                      {secretVault.vaults.some((v) => v.isDecoy) ? (
                        <Pressable onPress={() => void removeDuressLocal()} style={styles.ghostBtnSmall}>
                          <Text style={styles.ghostBtnSmallText}>🎭 {t('duressRemove')}</Text>
                        </Pressable>
                      ) : (
                        <>
                          <TextInput
                            style={[styles.fieldInput, { textAlign: duressDraft ? codeAlign(duressDraft) : ta() }]}
                            value={duressDraft}
                            onChangeText={(x) => { setDuressDraft(x); setDuressMsg(null); }}
                            placeholder={t('duressPh')}
                            placeholderTextColor={P.faint2}
                            maxLength={60}
                            secureTextEntry
                          />
                          <Text style={styles.fieldHint}>⚠️ {t('codeExactNote')}</Text>
                          <Pressable
                            onPress={() => void saveDuressLocal()}
                            disabled={duressSaving}
                            style={[styles.primaryBtn, duressSaving && styles.primaryBtnDisabled]}
                          >
                            <Text style={styles.primaryBtnText}>{t('saveSecretCode')}</Text>
                          </Pressable>
                        </>
                      )}
                      {duressMsg ? <Text style={styles.fieldOk}>✅ {duressMsg}</Text> : null}
                    </View>
                  ) : null}
                </>
              ) : null}

              <Pressable onPress={() => setProfileOpen(false)} style={styles.ghostBtn}>
                <Text style={styles.ghostBtnText}>{t('close')}</Text>
              </Pressable>
            </ScrollView>
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
                {/* first-use teacher: tappable examples that run for real */}
                <Text style={styles.tryLabel}>{t('tryTapOne')}</Text>
                {[
                  { icon: '🔍', text: t('exWhere') },
                  { icon: '⏰', text: t('exRemind') },
                  { icon: '🛒', text: t('exWhatMissing') },
                ].map((ex) => (
                  <Pressable
                    key={ex.text}
                    onPress={() => onSendText(ex.text)}
                    style={({ pressed }) => [styles.exampleCard, pressed && styles.pressed]}
                  >
                    <Text style={styles.exampleIcon}>{ex.icon}</Text>
                    <Text style={styles.exampleText} numberOfLines={2}>
                      {ex.text}
                    </Text>
                    <Text style={styles.exampleGo}>{I18nManager.isRTL ? '‹' : '›'}</Text>
                  </Pressable>
                ))}
              </View>
            }
            renderItem={renderMsg}
          />

          {visibleBroadcasts.map((b) => (
            <View key={b.id} style={styles.bcCard}>
              <View style={styles.bcTextWrap}>
                <Text style={styles.bcTitle}>📣 {bcTitle(b)}</Text>
                <Text style={styles.bcBody}>{bcBody(b)}</Text>
              </View>
              <Pressable onPress={() => dismissBroadcast(b.id)} style={styles.bcX} hitSlop={8}>
                <Text style={styles.bcXText}>✕</Text>
              </Pressable>
            </View>
          ))}

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
                  style={[styles.composerInput, { height: composerH }]}
                  onContentSizeChange={(e) =>
                    setComposerH(
                      Math.max(36, Math.min(120, e.nativeEvent.contentSize.height)),
                    )
                  }
                  multiline
                  maxLength={2000}
                />
              </View>
              <Pressable
                onPress={textNote.trim() && !isRecording ? () => onSendText() : onRecordPress}
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
            {isRecording && (
              <View style={styles.recRow}>
                <VoiceWave />
                <Text style={styles.timer}>🔴 {fmtTime(duration)}</Text>
              </View>
            )}
            {messages.length === 0 && !isRecording && (
              <Text style={styles.micHint}>{t('micHint')}</Text>
            )}
          </View>
        </>
      ) : viewSpace?.type === 'family' ? (
        <>
          <View style={styles.famHeader}>
            <Pressable
              onPress={() => { setFamMsg(null); setFamConfirm(null); setFamsOpen(true); }}
              style={styles.famTitleBtn}
              hitSlop={8}
            >
              <Text style={styles.famSwitchText} numberOfLines={1}>
                {t('familyWord')} {familyTitle(viewSpace)}
                {familySpaces.length > 1 ? ' ▾' : ''}
              </Text>
            </Pressable>
            {isManager && (
              <Pressable onPress={openRename} style={styles.famEditBtn} hitSlop={10}>
                <Text style={styles.famEditBtnText}>✏️</Text>
              </Pressable>
            )}
            <Text style={styles.famMembers}>👥 {memberCount}</Text>
          </View>
          {renderTabBar(FAMILY_TABS, familyTab, setFamilyTab, isManager)}

          {familyTab === 'members' && (
            <ScrollView
              style={styles.membersWrap}
              contentContainerStyle={{ paddingBottom: 24 }}
              refreshControl={
                <RefreshControl
                  refreshing={membersBusy}
                  onRefresh={() => famSpace && void refreshFamilyMembers(famSpace)}
                  tintColor={P.accent}
                  colors={[P.accent]}
                />
              }
            >
              {isManager && famSpace && (
                <Pressable onPress={() => openInviteFor(famSpace.id)} style={styles.inviteBtnFull}>
                  <Text style={styles.inviteBtnText}>{t('inviteTitle')}</Text>
                </Pressable>
              )}
              <SearchBar
                value={memberSearch.query}
                onChange={memberSearch.setQuery}
                placeholder={t('searchMembers')}
                searching={memberSearch.searching}
              />
              {membersBusy && !familyMembers ? (
                <ActivityIndicator color={P.accent} style={{ marginTop: 24 }} />
              ) : memberSearch.inSearch && (memberSearch.results ?? []).length === 0 ? (
                <Text style={styles.muted}>{t('noResults')}</Text>
              ) : (
                (memberSearch.inSearch ? (memberSearch.results ?? []) : (familyMembers ?? [])).map((m) => (
                  <View key={m.user_id} style={styles.memberRow}>
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberAvatarText}>
                        {(m.display_name?.[0] ?? m.email?.[0] ?? '؟').toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.memberInfo}>
                      {memberSearch.inSearch ? (
                        <Highlight
                          text={`${m.display_name ?? m.email ?? '—'}${m.user_id === userId ? t('youSuffix') : ''}`}
                          query={memberSearch.query}
                          style={styles.memberEmail}
                          numberOfLines={1}
                        />
                      ) : (
                        <Text style={styles.memberEmail} numberOfLines={1}>
                          {m.display_name ?? m.email ?? '—'}
                          {m.user_id === userId ? t('youSuffix') : ''}
                        </Text>
                      )}
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
              {!membersBusy && familyMembers && familyMembers.length === 0 && !memberSearch.inSearch ? (
                <EmptyState icon="👥" message={t('membersEmpty')} />
              ) : null}
              {famSpace && (
                <Pressable onPress={() => setJoinOpen(true)} style={styles.famLinkCenter}>
                  <Text style={styles.famLinkText}>{t('haveCode')}</Text>
                </Pressable>
              )}
              {!isManager && famSpace && (
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
              )}
            </ScrollView>
          )}
          {familyTab === 'shopping' && (
            <ScrollView
              style={styles.fill}
              contentContainerStyle={styles.list}
              refreshControl={
                <RefreshControl
                  refreshing={shopRefreshing}
                  onRefresh={() => void onRefreshShopping()}
                  tintColor={P.accent}
                  colors={[P.accent]}
                />
              }
            >
              <SearchBar
                value={shopSearch.query}
                onChange={shopSearch.setQuery}
                placeholder={t('searchShopping')}
                searching={shopSearch.searching}
              />
              {/* ── active lists ── */}
              <Text style={styles.sectionTitle}>{t('shopListsTitle')}</Text>
              {activeLists.length === 0 && archivedLists.length === 0 ? (
                shopSearch.inSearch ? (
                  <Text style={styles.muted}>{t('noResults')}</Text>
                ) : (
                  <EmptyState icon="🛒" message={t('shopEmpty')} example={t('exShopping')} onTryExample={tryExample} />
                )
              ) : null}
              {activeLists.map((l) => {
                const resolved = l.items.filter((i) => i.status !== 'open').length;
                const total = l.items.length;
                return (
                  <SwipeRow key={l.id} onSwipeLeft={() => deleteShopList(l.id)}>
                  <View style={styles.shopListCard}>
                    <View style={styles.shopListHead}>
                       {shopSearch.inSearch ? (
                        <Highlight text={l.title} query={shopSearch.query} style={styles.shopListTitle} />
                      ) : (
                        <Text style={styles.shopListTitle}>{l.title}</Text>
                      )}
                      <Pressable
                        onPress={() => deleteShopList(l.id)}
                        hitSlop={10}
                        accessibilityLabel={t('deleteList')}
                      >
                        <Text style={styles.shopListDel}>🗑️</Text>
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
                  </SwipeRow>
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
                      <SwipeRow key={l.id} onSwipeLeft={() => deleteShopList(l.id)}>
                      <View style={[styles.shopListCard, styles.shopListArchived]}>
                        <Pressable onPress={() => setArchOpenId(expanded ? null : l.id)}>
                          <View style={styles.shopListHead}>
                             {shopSearch.inSearch ? (
                        <Highlight text={l.title} query={shopSearch.query} style={styles.shopListTitle} />
                      ) : (
                        <Text style={styles.shopListTitle}>{l.title}</Text>
                      )}
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
                            <Text style={styles.shopListDel}>🗑️</Text>
                          </Pressable>
                        </View>
                      </View>
                      </SwipeRow>
                    );
                  })}
                </>
              )}
            </ScrollView>
          )}

          {familyTab === 'tasks' && (
            <>
              <SearchBar
                value={tasksSearch.query}
                onChange={tasksSearch.setQuery}
                placeholder={t('searchTasks')}
                searching={tasksSearch.searching}
              />
              <FlatList
              style={styles.fill}
              data={tasksSearch.inSearch ? (tasksSearch.results ?? []) : tasks}
              keyExtractor={(i) => i.id}
              contentContainerStyle={styles.list}
              onEndReached={tasksSearch.inSearch ? undefined : tasksPage.loadMore}
              onEndReachedThreshold={0.5}
              ListFooterComponent={
                !tasksSearch.inSearch && tasksPage.loadingMore ? (
                  <ActivityIndicator size="small" color={P.accent} style={styles.moreSpinner} />
                ) : null
              }
              refreshControl={<RefreshControl refreshing={tasksPage.loading} onRefresh={() => tasksPage.refresh()} tintColor={P.accent} colors={[P.accent]} />}
              ListEmptyComponent={
                tasksSearch.inSearch ? (
                  <Text style={styles.muted}>{t('noResults')}</Text>
                ) : tasksPage.loading && tasks.length === 0 ? (
                  <ActivityIndicator size="small" color={P.accent} style={styles.moreSpinner} />
                ) : (
                  <EmptyState icon="✅" message={t('tasksEmpty')} example={t('exTasks')} onTryExample={tryExample} />
                )
              }
              renderItem={({ item }) => (
                <>
                  <SwipeRow
                    onSwipeRight={() => toggleItem(item)}
                    onSwipeLeft={() => void askDeleteItem(item)}
                  >
                  <View style={styles.famRow}>
                    <Pressable onPress={() => toggleItem(item)}>
                      <Text style={styles.itemIcon}>{item.status === 'done' ? '✅' : '⬜'}</Text>
                    </Pressable>
                    <View style={styles.itemBody}>
                      {tasksSearch.inSearch ? (
                        <Highlight
                          text={item.title}
                          query={tasksSearch.query}
                          style={[styles.itemTitle, item.status === 'done' && styles.itemDone]}
                        />
                      ) : (
                        <Text style={[styles.itemTitle, item.status === 'done' && styles.itemDone]}>
                          {item.title}
                        </Text>
                      )}
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
                    <Pressable
                      onPress={() => setMoveItemFor(moveItemFor === item.id ? null : item.id)}
                      style={styles.moveBtn}
                      accessibilityLabel={t('moveToSpace')}
                    >
                      <Text style={styles.moveBtnText}>{t('move')}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void askDeleteItem(item)}
                      style={styles.moveBtn}
                      accessibilityLabel={t('deleteTask')}
                    >
                      <Text style={styles.moveBtnText}>🗑️</Text>
                    </Pressable>
                  </View>
                  </SwipeRow>
                  {moveItemFor === item.id && (
                    <View style={styles.moveRow}>
                      <Text style={styles.moveLabel}>{t('moveTo')}</Text>
                      {spaces
                        .filter((s) => s.id !== item.space_id)
                        .map((s) => (
                          <Pressable
                            key={s.id}
                            onPress={() => void moveItemSpace(item, s.id)}
                            style={styles.moveTarget}
                          >
                            <Text style={styles.moveTargetText}>
                              {SPACE_LABELS[s.type] ?? s.name}
                            </Text>
                          </Pressable>
                        ))}
                    </View>
                  )}
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
            </>
          )}

          {familyTab === 'agenda' && (
            <>
              <SearchBar
                value={agendaSearch.query}
                onChange={agendaSearch.setQuery}
                placeholder={t('searchAgenda')}
                searching={agendaSearch.searching}
              />
              {!agendaSearch.inSearch ? (
                <WeekStrip
                  counts={agendaCounts}
                  selected={agendaDay}
                  onSelect={(d) => {
                    tap('light');
                    setAgendaDay(d);
                  }}
                />
              ) : null}
              <FlatList
              style={styles.fill}
              data={agendaSearch.inSearch ? (agendaSearch.results ?? []) : agendaVisible}
              keyExtractor={(i) => i.id}
              contentContainerStyle={styles.list}
              onEndReached={agendaSearch.inSearch ? undefined : upcomingPage.loadMore}
              onEndReachedThreshold={0.5}
              ListFooterComponent={
                !agendaSearch.inSearch && upcomingPage.loadingMore ? (
                  <ActivityIndicator size="small" color={P.accent} style={styles.moreSpinner} />
                ) : null
              }
              refreshControl={<RefreshControl refreshing={upcomingPage.loading} onRefresh={() => upcomingPage.refresh()} tintColor={P.accent} colors={[P.accent]} />}
              ListEmptyComponent={
                agendaSearch.inSearch || (agendaDay && agendaVisible.length === 0) ? (
                  <Text style={styles.muted}>{t('noResults')}</Text>
                ) : upcomingPage.loading && upcoming.length === 0 ? (
                  <ActivityIndicator size="small" color={P.accent} style={styles.moreSpinner} />
                ) : (
                  <EmptyState icon="📅" message={t('agendaEmpty')} example={t('exAgenda')} onTryExample={tryExample} />
                )
              }
              renderItem={({ item }) => (
                <SwipeRow onSwipeLeft={() => void askDeleteItem(item)}>
                <View style={styles.famRow}>
                  <Text style={styles.itemIcon}>📅</Text>
                  <View style={styles.itemBody}>
                    {agendaSearch.inSearch ? (
                      <Highlight text={item.title} query={agendaSearch.query} style={styles.itemTitle} />
                    ) : (
                      <Text style={styles.itemTitle}>{item.title}</Text>
                    )}
                    <Text style={styles.itemDue}>
                      {item.due_at ? new Date(item.due_at).toLocaleString() : ''}
                    </Text>
                  </View>
                </View>
                </SwipeRow>
              )}
              />
            </>
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
                  onPress={() => delTab && void runDeleteTab(delTab.id, { trashDays: trashRetention })}
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
                      onPress={() => delTab && void runDeleteTab(delTab.id, { moveTo: opt.id, trashDays: 0 })}
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

      {/* ── secret vault: full hidden page ── */}
      <Modal visible={secretVaultId !== null} animationType="slide" onRequestClose={() => setSecretVaultId(null)}>
        <SafeAreaView style={styles.vaultPage} edges={['top', 'bottom']}>
          <View style={styles.vaultHeader}>
            <Pressable onPress={() => setSecretVaultId(null)} style={styles.trashBtn} accessibilityLabel={t('close')}>
              <Text style={styles.trashBtnText}>🔒</Text>
            </Pressable>
            <Text style={styles.vaultTitle}>🔒 {t('secretTab')}</Text>
            {/* (6.2) the decoy vault has NO trash button: secret trash is
                global across vaults, and a coercer inside the decoy must
                never see real deleted notes */}
            {trashRetention > 0 && !secretVault.vaults.some((v) => v.id === secretVaultId && v.isDecoy) ? (
              <Pressable onPress={() => void openTrash(true)} style={styles.trashBtn} accessibilityLabel={t('trashSecretTitle')}>
                <Text style={styles.trashBtnText}>🗑️</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setSecretSearchOpen((v) => !v)} style={styles.trashBtn}>
              <Text style={styles.trashBtnText}>🔍</Text>
            </Pressable>
          </View>
          {secretSearchOpen ? (
            <SearchBar
              value={secretSearch}
              onChange={setSecretSearch}
              placeholder={t('secretSearch')}
            />
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
      {/* ── 👻 ghost key: vault MANAGEMENT (master word verified in chat) ── */}
      <Modal visible={mgmtOpen} animationType="slide" onRequestClose={closeMgmt}>
        <SafeAreaView style={styles.vaultPage} edges={['top', 'bottom']}>
          <View style={styles.vaultHeader}>
            <Pressable onPress={closeMgmt} style={styles.trashBtn}>
              <Text style={styles.trashBtnText}>‹ {t('close')}</Text>
            </Pressable>
            <Text style={styles.vaultTitle}>👻 {t('mgmtTitle')}</Text>
          </View>
          <ScrollView style={styles.vaultList} contentContainerStyle={{ paddingBottom: 48 }}>
            {mgmtMsg ? <Text style={styles.fieldHint}>ℹ️ {mgmtMsg}</Text> : null}
            <Text style={styles.sectionHeader}>{t('mgmtVaults')}</Text>
            {mgmtLoading ? (
              <ActivityIndicator />
            ) : mgmtVaults.length === 0 ? (
              <Text style={styles.fieldHint}>{t('mgmtEmpty')}</Text>
            ) : (
              mgmtVaults.map((v) => (
                <View key={v.id} style={styles.mgmtRow}>
                  <View style={styles.mgmtRowHead}>
                    <Text style={styles.mgmtRowTitle}>
                      {/* (6.6) fake management: the decoy row wears a normal 🔒
                          label — the word "decoy" must never appear here */}
                      {mgmtDecoyMode ? `🔒 ${t('secretTab')}` : `${v.isDecoy ? '🎭' : '🔒'} ${v.isDecoy ? t('mgmtDecoy') : t('secretTab')}`} · {v.noteCount} {t('mgmtNotes')}
                    </Text>
                    <View style={styles.mgmtRowActions}>
                      <Pressable
                        onPress={() => { setVaultCodeEditId(v.id); setVaultCodeDraft(''); setMgmtMsg(null); }}
                        style={styles.ghostBtnSmall}
                      >
                        <Text style={styles.ghostBtnSmallText}>{t('mgmtChangeCode')}</Text>
                      </Pressable>
                      <Pressable onPress={() => void deleteVaultLocal(v.id)} style={styles.ghostBtnSmall}>
                        <Text style={[styles.ghostBtnSmallText, { color: P.danger }]}>
                          {vaultDelId === v.id ? '⚠️ ' : ''}{t('mgmtDelete')}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                  {vaultCodeEditId === v.id ? (
                    <View style={styles.mgmtInline}>
                      <TextInput
                        style={[styles.fieldInput, { textAlign: vaultCodeDraft ? codeAlign(vaultCodeDraft) : ta() }]}
                        value={vaultCodeDraft}
                        onChangeText={setVaultCodeDraft}
                        placeholder={t('mgmtNewCodePh')}
                        placeholderTextColor={P.faint2}
                        maxLength={60}
                        secureTextEntry
                      />
                      <Pressable onPress={() => void changeVaultCodeLocal(v.id)} style={styles.primaryBtn}>
                        <Text style={styles.primaryBtnText}>{t('saveSecretCode')}</Text>
                      </Pressable>
                    </View>
                  ) : null}
                  {vaultDelId === v.id ? (
                    <View style={styles.mgmtInline}>
                      <Text style={styles.fieldHint}>{t('mgmtDeleteConfirm')}</Text>
                      <TextInput
                        style={[styles.fieldInput, { textAlign: vaultDelMaster ? codeAlign(vaultDelMaster) : ta() }]}
                        value={vaultDelMaster}
                        onChangeText={setVaultDelMaster}
                        placeholder={mgmtDecoyMode ? t('mgmtDeleteDecoyMasterPh') : t('mgmtDeleteMasterPh')}
                        placeholderTextColor={P.faint2}
                        maxLength={60}
                        secureTextEntry
                      />
                      <Pressable
                        onPress={() => void deleteVaultLocal(v.id)}
                        style={[styles.primaryBtn, { backgroundColor: P.danger }]}
                      >
                        <Text style={styles.primaryBtnText}>{t('mgmtDelete')}</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ))
            )}
            {/* (6.4) decoy filler — real management only: make the decoy look lived-in */}
            {!mgmtDecoyMode && secretVault.vaults.some((v) => v.isDecoy) ? (
              <Pressable onPress={() => void fillDecoyLocal()} style={[styles.ghostBtnSmall, { marginTop: 12, alignSelf: 'flex-start' }]}>
                <Text style={styles.ghostBtnSmallText}>{t('mgmtFillDecoy')}</Text>
              </Pressable>
            ) : null}
            {/* (6.6) decoy master setup — real management ONLY. Never rendered
                in fake management (a third button/section there = a trace). */}
            {!mgmtDecoyMode ? (
              <>
                <Text style={[styles.sectionHeader, { marginTop: 16 }]}>{t('decoyMasterTitle')}</Text>
                <Text style={styles.fieldHint}>{t('decoyMasterHint')}</Text>
                {decoyMasterSet ? <Text style={styles.fieldHint}>✅ {t('decoyMasterSet')}</Text> : null}
                <TextInput
                  style={[styles.fieldInput, { textAlign: decoyMasterNew ? codeAlign(decoyMasterNew) : ta() }]}
                  value={decoyMasterNew}
                  onChangeText={(x) => { setDecoyMasterNew(x); setMgmtMsg(null); }}
                  placeholder={t('decoyMasterPh')}
                  placeholderTextColor={P.faint2}
                  maxLength={60}
                  secureTextEntry
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable onPress={() => void setDecoyMasterLocal()} style={styles.primaryBtn} disabled={decoyMasterSaving}>
                    <Text style={styles.primaryBtnText}>{t('saveSecretCode')}</Text>
                  </Pressable>
                  {decoyMasterSet ? (
                    <Pressable onPress={() => void removeDecoyMasterLocal()} style={styles.ghostBtnSmall}>
                      <Text style={[styles.ghostBtnSmallText, { color: P.danger }]}>{t('decoyMasterRemove')}</Text>
                    </Pressable>
                  ) : null}
                </View>
              </>
            ) : null}
            <Text style={[styles.sectionHeader, { marginTop: 16 }]}>{t('mgmtChangeMaster')}</Text>
            <TextInput
              style={[styles.fieldInput, { textAlign: mgmtMasterCur ? codeAlign(mgmtMasterCur) : ta() }]}
              value={mgmtMasterCur}
              onChangeText={(x) => { setMgmtMasterCur(x); setMgmtMsg(null); }}
              placeholder={t('masterCurPh')}
              placeholderTextColor={P.faint2}
              maxLength={60}
              secureTextEntry
            />
            <TextInput
              style={[styles.fieldInput, { textAlign: mgmtMasterNew ? codeAlign(mgmtMasterNew) : ta() }]}
              value={mgmtMasterNew}
              onChangeText={(x) => { setMgmtMasterNew(x); setMgmtMsg(null); }}
              placeholder={t('masterNewPh')}
              placeholderTextColor={P.faint2}
              maxLength={60}
              secureTextEntry
            />
            <Pressable onPress={() => void changeMasterFromMgmt()} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>{t('saveSecretCode')}</Text>
            </Pressable>
          </ScrollView>
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
              onChangeText={(tt) => setJoinCode(tt.toUpperCase())}
              placeholder="ABC123"
              placeholderTextColor={P.faint2}
              autoCapitalize="characters"
              autoCorrect={false}
              style={[styles.fieldInput, styles.joinCodeInput]}
              textAlign="center"
              maxLength={12}
            />
            {joinError ? <Text style={styles.fieldError}>⚠️ {joinError}</Text> : null}
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

      {/* ── family-slots paywall: first family free, extras need a slot ── */}
      <Modal visible={paywallOpen} transparent animationType="fade" onRequestClose={() => { setPaywallOpen(false); setPendingJoinCode(null); }}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('paywallTitle')}</Text>
            <Text style={styles.modalBody}>{t('paywallBody')}</Text>
            <Pressable
              onPress={() => { setPaywallOpen(false); setFamMsg(null); setFamConfirm(null); setFamsOpen(true); }}
              style={[styles.primaryBtn, { marginTop: 4 }]}
            >
              <Text style={styles.primaryBtnText}>{t('manageFamilies')}</Text>
            </Pressable>
            {/* Stripe is parked until launch — the button stays visible-but-soon */}
            <View style={[styles.primaryBtn, styles.primaryBtnDisabled, { marginTop: 10 }]}>
              <Text style={styles.primaryBtnText}>{t('payForFamily')}</Text>
            </View>
            <Text style={[styles.fieldHint, { textAlign: 'center', marginTop: 6 }]}>{t('paySoon')}</Text>
            <Pressable onPress={() => { setPaywallOpen(false); setPendingJoinCode(null); }} style={styles.ghostBtn}>
              <Text style={styles.ghostBtnText}>{t('cancel')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── families switcher + manager ── */}
      <Modal visible={famsOpen} transparent animationType="fade" onRequestClose={() => setFamsOpen(false)}>
        <View style={styles.modalBg}>
          <View style={[styles.modalCard, styles.profileCard]}>
            <ScrollView showsVerticalScrollIndicator={false} style={styles.profileScroll}>
              <Text style={styles.modalTitle}>{t('familiesTitle')}</Text>
              <Text style={[styles.modalBody, { marginBottom: 10 }]}>
                {tx('familiesSlots', { used: familySpaces.length, slots: familySlots })}
              </Text>
              {familySpaces.map((s) => {
                const isOwner = !!userId && s.owner_id === userId;
                const isActive = viewSpace?.id === s.id && view === 'family';
                const armed = famConfirm === s.id;
                return (
                  <View key={s.id} style={[styles.famSwitchRow, isActive && styles.famSwitchRowActive]}>
                    <Pressable
                      style={styles.famSwitchRowMain}
                      onPress={() => { setFamsOpen(false); setFamConfirm(null); activateFamilySpace(s); }}
                    >
                      <Text style={styles.famSwitchRowName} numberOfLines={1}>
                        👨‍👩‍👧 {familyTitle(s)}
                      </Text>
                      <Text style={styles.famSwitchRowSub}>
                        {isOwner ? t('managerBadge') : t('memberBadge')}
                        {isActive ? ` · ${t('currentBadge')}` : ''}
                      </Text>
                    </Pressable>
                    {isOwner ? (
                      <Text style={styles.famRowLocked}>{t('ownFamilyLocked')}</Text>
                    ) : (
                      <Pressable
                        onPress={() => void onFamAction(s)}
                        style={[styles.famActionBtn, armed && styles.famActionBtnArmed]}
                      >
                        <Text style={[styles.famActionText, armed && styles.famActionTextArmed]}>
                          {armed ? t('confirmLeave') : t('leaveShort')}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
              {famMsg ? <Text style={styles.fieldError}>⚠️ {famMsg}</Text> : null}
              <Pressable onPress={() => { setFamsOpen(false); setFamConfirm(null); }} style={styles.ghostBtn}>
                <Text style={styles.ghostBtnText}>{t('close')}</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── rename family (owner only) ── */}
      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('renameFamily')}</Text>
            <Text style={styles.modalBody}>{t('renameHint')}</Text>
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder={t('familyNamePh')}
              placeholderTextColor={P.faint2}
              autoCorrect={false}
              style={styles.fieldInput}
              maxLength={40}
              autoFocus
              onSubmitEditing={doRename}
              returnKeyType="done"
            />
            {renameMsg ? <Text style={styles.fieldError}>⚠️ {renameMsg}</Text> : null}
            <View style={styles.modalRow}>
              <Pressable onPress={doRename} disabled={renameBusy} style={styles.modalBtn}>
                {renameBusy ? (
                  <ActivityIndicator color={P.paper} />
                ) : (
                  <Text style={styles.modalBtnText}>{t('save')}</Text>
                )}
              </Pressable>
              <Pressable onPress={() => setRenameOpen(false)} style={[styles.modalBtn, styles.modalBtnGhost]}>
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
                    <View style={styles.shopModalHeadBtns}>
                      <Pressable
                        onPress={() => shareShoppingList(list)}
                        hitSlop={10}
                        accessibilityLabel={t('shareWhatsApp')}
                      >
                        <Text style={styles.shopShareBtn}>📤 {t('shareWhatsApp')}</Text>
                      </Pressable>
                      <Pressable onPress={() => setActiveListId(null)} hitSlop={10}>
                        <Text style={styles.shopListDel}>✕</Text>
                      </Pressable>
                    </View>
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
                    refreshControl={
                      <RefreshControl
                        refreshing={shopRefreshing}
                        onRefresh={() => void onRefreshShopping()}
                        tintColor={P.accent}
                        colors={[P.accent]}
                      />
                    }
                    renderItem={({ item }) => (
                      <SwipeRow
                        onSwipeRight={() =>
                          setShopItemStatus(
                            list.id,
                            item,
                            item.status === 'done' ? 'open' : 'done',
                          )
                        }
                        onSwipeLeft={() =>
                          setShopItemStatus(
                            list.id,
                            item,
                            item.status === 'not_found' ? 'open' : 'not_found',
                          )
                        }
                        leftIcon="❌"
                      >
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
                      </SwipeRow>
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
            <SignedImage photo={photoViewer} style={styles.viewerImg} resizeMode="contain" />
          ) : null}
          <Text style={styles.viewerHint}>{t('tapToClose')}</Text>
        </Pressable>
      </Modal>

      {/* ── undo snackbar (after any delete) ── */}
      {undo ? (
        <UndoBar message={undo.msg} onUndo={doUndo} onDismiss={dismissUndo} />
      ) : null}

      {/* ── trash: full page, filterable by kind ── */}
      <Modal visible={trashOpen} animationType="slide" onRequestClose={() => setTrashOpen(false)}>
        <SafeAreaView style={styles.trashPage} edges={['top', 'bottom']}>
          <View style={styles.trashPageHeader}>
            <Pressable
              onPress={() => setTrashOpen(false)}
              style={styles.trashBtn}
              accessibilityLabel={t('close')}
            >
              <Text style={styles.trashBtnText}>✕</Text>
            </Pressable>
            <View style={styles.trashPageTitleWrap}>
              <Text style={styles.trashPageTitle}>
                🗑️ {trashSecret ? t('trashSecretTitle') : t('trashTitle')}
              </Text>
              <Text style={styles.trashPageSub}>
                {tx('trashSubtitle', { days: String(trashRetention) })}
              </Text>
            </View>
            <View style={{ width: 44 }} />
          </View>
          {/* filter chips */}
          <View style={styles.trashFilters}>
            <Pressable
              onPress={() => setTrashFilter('all')}
              style={[styles.trashChip, trashFilter === 'all' && styles.trashChipOn]}
            >
              <Text style={[styles.trashChipText, trashFilter === 'all' && styles.trashChipTextOn]}>
                {t('trashFilterAll')}
              </Text>
            </Pressable>
            {TRASH_KINDS.filter((k) => trashRows.some((r) => r.kind === k)).map((k) => {
              const meta = trashKindMeta(k);
              const on = trashFilter === k;
              return (
                <Pressable
                  key={k}
                  onPress={() => setTrashFilter(on ? 'all' : k)}
                  style={[styles.trashChip, on && styles.trashChipOn]}
                >
                  <Text style={[styles.trashChipText, on && styles.trashChipTextOn]}>
                    {meta.icon} {meta.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {trashBusy ? (
            <Text style={styles.trashEmptyText}>{t('loading')}</Text>
          ) : trashRows.length === 0 ? (
            <Text style={styles.trashEmptyText}>{t('trashEmpty')}</Text>
          ) : (
            <ScrollView style={styles.trashList} contentContainerStyle={{ paddingBottom: 16 }}>
              {trashRows
                .filter((r) => trashFilter === 'all' || r.kind === trashFilter)
                .map((r) => {
                  const meta = trashKindMeta(r.kind);
                  const origin = trashOrigin(r);
                  const delDate = new Date(r.deleted_at).toLocaleDateString();
                  return (
                    <View key={r.id} style={styles.trashRow}>
                      <View style={styles.trashMain}>
                        <Text style={styles.trashTitle} numberOfLines={2}>
                          {meta.icon} {r.title || '…'}
                        </Text>
                        <Text style={styles.trashMeta}>
                          {meta.label}
                          {origin ? ` · ${origin}` : ''}
                        </Text>
                        <Text style={styles.trashMeta}>
                          {tx('trashDeletedOn', { date: delDate })} ·{' '}
                          {tx('trashDaysLeft', { days: String(r.daysLeft) })}
                        </Text>
                      </View>
                      <View style={styles.trashActions}>
                        <Pressable onPress={() => void restoreTrashRow(r)} style={styles.trashBtn}>
                          <Text style={styles.trashBtnText}>↩️</Text>
                        </Pressable>
                        <Pressable onPress={() => void nukeTrashRow(r)} style={styles.trashBtn}>
                          <Text style={styles.trashBtnText}>{delForeverId === r.id ? '⚠️' : '✕'}</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
            </ScrollView>
          )}
          {trashRows.length > 0 && !trashBusy && (
            <View style={styles.trashFooter}>
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
        </SafeAreaView>
      </Modal>
      {/* first-run welcome: 3 steps, once per device */}
      <WelcomeScreen
        visible={showWelcome}
        onDone={finishWelcome}
        recDuration={duration}
        onStartRecord={demoStartRecord}
        onStopRecord={demoStopRecord}
        onSaveTextDemo={demoSaveText}
        onAskDemo={demoAsk}
        onSpeakDemo={speak}
      />
      {toastMsg ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMsg}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}
