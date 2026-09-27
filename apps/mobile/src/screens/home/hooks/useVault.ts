// Phase C: vault/ghost domain extracted from HomeScreen (pure move, no behavior change).
// States, refs and callbacks for: secret vaults, ghost master key, duress decoy,
// decoy master, vault management (P0-4/P0-5), secret notes.
import { useCallback, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import bcrypt from 'bcryptjs';
import type { ManagedVault, Note, RecordedAudio, SpaceType } from '@mawjood/voice-engine';
import { engine } from '../../../lib/engine';
import { t, getLang, DECOY_FILLER } from '../../../lib/i18n';
import { recoveryWaitInfo } from '../helpers';

export interface UseVaultArgs {
  userId: string | null;
  spaceIdByType: (t: SpaceType) => string | null;
  trashRetention: number;
  isRecording: boolean;
  start: () => Promise<boolean>;
  stop: () => Promise<RecordedAudio | null>;
}

export function useVault({ userId, spaceIdByType, trashRetention, isRecording, start, stop }: UseVaultArgs) {
  const [secretVault, setSecretVault] = useState<{ enabled: boolean; vaults: { id: string; codeHash: string; isDecoy?: boolean }[] }>({
    enabled: false,
    vaults: [],
  });
  const [trashSecret, setTrashSecret] = useState(false); // true = the secret trash (inside vaults)
  // ── ghost key: master key + duress decoy + vault management ──
  // masterHashRef holds the bcrypt hash in MEMORY ONLY for this session —
  // never persisted; it lets the chat compare the master word locally
  // without ever storing or re-sending it.
  const masterHashRef = useRef<string | null>(null);
  // 🪞 decoy master: opens FAKE management (decoy vault only, same look).
  // Same rules as the real master: memory only, never persisted, never sent.
  const decoyMasterHashRef = useRef<string | null>(null);
  // P0-5: server-issued management capability (from a successful master
  // `verify`, 10-min). Management actions present it; a JWT alone is not
  // proof of master verification. Cleared when management closes.
  const mgmtTokenRef = useRef<string>('');
  /** Does this plaintext match any saved vault code? Hashes only (P0-4). */
  const vaultCodeTaken = useCallback(async (clean: string): Promise<boolean> => {
    for (const v of secretVault.vaults) {
      try {
        if (await bcrypt.compare(clean, v.codeHash)) return true;
      } catch { /* malformed hash: skip */ }
    }
    return false;
  }, [secretVault]);
  const [mgmtDecoyMode, setMgmtDecoyMode] = useState(false); // fake mgmt session
  const [decoyMasterSet, setDecoyMasterSet] = useState(false);
  const [decoyMasterNew, setDecoyMasterNew] = useState('');
  const [decoyMasterSaving, setDecoyMasterSaving] = useState(false);
  const [duressConfirmReplace, setDuressConfirmReplace] = useState(false); // two-tap decoy replace
  const [masterState, setMasterState] = useState<{ hasMaster: boolean; lockedUntil: string | null; failedCount: number; recoveryRequestedAt: string | null } | null>(null);
  const [masterFormOpen, setMasterFormOpen] = useState(false); // profile: master setup form
  // opsec: the form ALWAYS looks like first-time setup — it never reveals
  // whether a master key exists. Recovery UI only opens via the 💡 note.
  const [masterFormMode, setMasterFormMode] = useState<'setup' | 'recover'>('setup');
  const [masterNew, setMasterNew] = useState('');
  const [masterMsg, setMasterMsg] = useState<string | null>(null);
  const [masterMsgOk, setMasterMsgOk] = useState(false);
  const [masterSaving, setMasterSaving] = useState(false);
  /** 7-day recovery wait: ready? days left? (set alongside masterState, never in render) */
  const [recoveryInfo, setRecoveryInfo] = useState<{ ready: boolean; daysLeft: number } | null>(null);
  const [duressFormOpen, setDuressFormOpen] = useState(false); // profile: duress setup form
  const [duressDraft, setDuressDraft] = useState('');
  const [duressMsg, setDuressMsg] = useState<string | null>(null);
  const [duressSaving, setDuressSaving] = useState(false);
  const [mgmtOpen, setMgmtOpen] = useState(false); // management modal (after master typed in chat)
  const [mgmtVaults, setMgmtVaults] = useState<ManagedVault[]>([]);
  const [mgmtLoading, setMgmtLoading] = useState(false);
  const [vaultCodeEditId, setVaultCodeEditId] = useState<string | null>(null);
  const [vaultCodeDraft, setVaultCodeDraft] = useState('');
  const [vaultDelId, setVaultDelId] = useState<string | null>(null); // two-tap delete confirm
  const [vaultDelMaster, setVaultDelMaster] = useState('');
  const [mgmtMasterNew, setMgmtMasterNew] = useState('');
  const [mgmtMasterCur, setMgmtMasterCur] = useState(''); // current word (re-auth before rotating)
  const [mgmtMsg, setMgmtMsg] = useState<string | null>(null);
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
  /** Re-read the open vault's notes (after a secret restore/delete). */
  const refreshSecretNotes = useCallback(() => {
    if (!secretVaultId || !userId) return;
    const pid = spaceIdByType('private');
    if (!pid) return;
    engine
      .listSecretNotes(pid, userId, secretVaultId)
      .then(setSecretNotes)
      .catch((e) => console.warn('refreshSecretNotes failed', e));
  }, [secretVaultId, userId, spaceIdByType]);
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

  /** Two-tap delete: first tap arms, second tap moves to the SECRET trash (or permanent when free). */
  const askDeleteSecret = useCallback(
    (id: string) => {
      if (secretDelId === id) {
        setSecretDelId(null);
        setSecretEditingId((cur) => (cur === id ? null : cur));
        if (userId && secretVaultId) {
          engine
            .trashSecretNote(id, secretVaultId, userId, trashRetention)
            .then(() => setSecretNotes((prev) => prev.filter((n) => n.id !== id)))
            .catch((e) => console.warn('trashSecretNote failed', e));
        }
      } else {
        setSecretDelId(id);
        setTimeout(() => setSecretDelId((cur) => (cur === id ? null : cur)), 4000);
      }
    },
    [secretDelId, userId, secretVaultId, trashRetention],
  );

  const saveSecretCode = useCallback(async () => {
    if (!userId || !secretCodeDraft.trim()) return;
    setSecretCodeMsg(null);
    const clean = secretCodeDraft.trim();
    try {
      // opsec: a vault code must NEVER equal the master key (chat checks vaults first)
      if (masterHashRef.current) {
        try {
          if (await bcrypt.compare(clean, masterHashRef.current)) {
            setSecretCodeMsg(t('vaultIsMasterCode'));
            setSecretCodeMsgOk(false);
            return;
          }
        } catch (e) { console.warn('master compare failed', e); }
      }
      // …nor the decoy master (it would shadow the fake-management intercept)
      if (decoyMasterHashRef.current) {
        try {
          if (await bcrypt.compare(clean, decoyMasterHashRef.current)) {
            setSecretCodeMsg(t('decoyMasterIsMaster'));
            setSecretCodeMsgOk(false);
            return;
          }
        } catch (e) { console.warn('decoy master compare failed', e); }
      }
      // refresh: a code saved on another device must still collide here
      const fresh = await engine.getSecretVault(userId);
      setSecretVault(fresh);
      // re-saving an old code reopens its vault (no duplicate vaults)
      for (const v of fresh.vaults) {
        try {
          if (await bcrypt.compare(clean, v.codeHash)) {
            setSecretCodeDraft('');
            setSecretCodeMsg(t('secretCodeSaved'));
            setSecretCodeMsgOk(true);
            setTimeout(() => { setSecretCodeMsg(null); setSecretCodeMsgOk(false); }, 3500);
            return;
          }
        } catch { /* ignore */ }
      }
      // P0-4: hash on-device (bcryptjs) — plaintext never leaves the device
      const hash = await bcrypt.hash(clean, 10);
      const vaultId = await engine.createVaultCode(userId, hash);
      setSecretVault((v) =>
        v.vaults.some((x) => x.id === vaultId) ? v : { ...v, vaults: [...v.vaults, { id: vaultId, codeHash: hash }] },
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

  // ── 👻 ghost key: master key + duress decoy + vault management ──
  const masterMsgFlash = useCallback((msg: string, ok: boolean) => {
    setMasterMsg(msg);
    setMasterMsgOk(ok);
    setTimeout(() => { setMasterMsg(null); setMasterMsgOk(false); }, 3500);
  }, []);
  const duressMsgFlash = useCallback((msg: string) => {
    setDuressMsg(msg);
    setTimeout(() => setDuressMsg(null), 3500);
  }, []);
  /** Human text for vault-master edge errors. */
  const masterErrText = useCallback((e: unknown): string => {
    const msg = e instanceof Error ? e.message : '';
    if (msg === 'locked') return t('masterLocked');
    if (msg === 'too_early') {
      const d = (e as { daysLeft?: number }).daysLeft;
      return `${t('masterRecoverTooEarly')}${d ? ` (${d} ⏳)` : ''}`;
    }
    if (msg === 'code_taken') return t('masterIsVaultCode');
    if (msg === 'mgmt_required') return t('mgmtSessionExpired');
    if (msg === 'wrong') {
      const left = (e as { triesLeft?: number }).triesLeft;
      return `${t('masterWrong')}${left != null ? ` — ${left} ${t('masterTriesLeft')}` : ''}`;
    }
    return t('secretCodeFail');
  }, []);
  const refreshMaster = useCallback(async () => {
    if (!userId) return;
    try {
      const hashes = await engine.getMasterHashes(userId);
      masterHashRef.current = hashes.master;
      decoyMasterHashRef.current = hashes.decoy;
      setDecoyMasterSet(!!hashes.decoy);
      const st = await engine.getVaultMasterState(userId);
      setMasterState(st);
      setRecoveryInfo(recoveryWaitInfo(st.recoveryRequestedAt));
    } catch (e) { console.warn('refreshMaster failed', e); }
  }, [userId]);

  /** Profile: FIRST-TIME master set only. Changing it happens in management. */
  const saveMasterKeyLocal = useCallback(async () => {
    if (!userId || !masterNew.trim() || masterSaving) return;
    // the form always looks like first-time setup (opsec), so an existing
    // master can only be discovered by actively trying to save over it
    if (masterState?.hasMaster) { masterMsgFlash(masterErrText(new Error('exists')), false); return; }
    if (await vaultCodeTaken(masterNew.trim())) {
      masterMsgFlash(t('masterIsVaultCode'), false);
      return;
    }
    setMasterSaving(true);
    try {
      const hash = await engine.setMasterKey(masterNew);
      masterHashRef.current = hash;
      setMasterNew('');
      masterMsgFlash(t('masterSaved'), true);
      await refreshMaster();
      // opsec: collapse the form — the word lives in his head now, no trace left
      setTimeout(() => { setMasterFormOpen(false); setMasterMsg(null); }, 1600);
    } catch (e) {
      console.warn('setMasterKey failed', e);
      masterMsgFlash(masterErrText(e), false);
    } finally {
      setMasterSaving(false);
    }
  }, [userId, masterNew, masterSaving, masterState, refreshMaster, masterMsgFlash, masterErrText, vaultCodeTaken]);

  const requestRecoveryLocal = useCallback(async () => {
    if (!userId) return;
    try {
      await engine.requestMasterRecovery(getLang());
      await refreshMaster();
      masterMsgFlash(t('masterRecoverActive'), true);
      // opsec: collapse — the countdown lives on under the ghost buttons
      setTimeout(() => { setMasterFormOpen(false); setMasterMsg(null); setMasterFormMode('setup'); }, 1600);
    } catch (e) { console.warn('requestRecovery failed', e); masterMsgFlash(masterErrText(e), false); }
  }, [userId, refreshMaster, masterMsgFlash, masterErrText]);

  const cancelRecoveryLocal = useCallback(async () => {
    if (!userId) return;
    try {
      await engine.cancelMasterRecovery();
      await refreshMaster();
      setTimeout(() => { setMasterFormOpen(false); setMasterMsg(null); setMasterFormMode('setup'); }, 1200);
    } catch (e) { console.warn('cancelRecovery failed', e); }
  }, [userId, refreshMaster]);

  /** Recovery complete: sets the NEW master key (only after the 7-day wait). */
  const completeRecoveryLocal = useCallback(async () => {
    if (!userId || !masterNew.trim() || masterSaving) return;
    if (await vaultCodeTaken(masterNew.trim())) {
      masterMsgFlash(t('masterIsVaultCode'), false);
      return;
    }
    setMasterSaving(true);
    try {
      const hash = await engine.completeMasterRecovery(masterNew);
      masterHashRef.current = hash;
      setMasterNew('');
      masterMsgFlash(t('masterRecovered'), true);
      await refreshMaster();
      // opsec: collapse back to "nothing ever happened"
      setTimeout(() => { setMasterFormOpen(false); setMasterMsg(null); setMasterFormMode('setup'); }, 1600);
    } catch (e) {
      console.warn('completeRecovery failed', e);
      masterMsgFlash(masterErrText(e), false);
    } finally {
      setMasterSaving(false);
    }
  }, [userId, masterNew, masterSaving, refreshMaster, masterMsgFlash, masterErrText, vaultCodeTaken]);

  const saveDuressLocal = useCallback(async () => {
    if (!userId || !duressDraft.trim() || duressSaving) return;
    // (6.5) replacing the duress word SILENTLY deletes the old decoy + its
    // notes server-side — require an explicit two-tap confirm for that
    if (secretVault.vaults.some((v) => v.isDecoy) && !duressConfirmReplace) {
      setDuressConfirmReplace(true);
      duressMsgFlash(t('duressReplaceWarn'));
      setTimeout(() => setDuressConfirmReplace(false), 8000);
      return;
    }
    setDuressConfirmReplace(false);
    // the duress word must never be the master key (the chat checks vaults first)
    if (masterHashRef.current) {
      try {
        if (await bcrypt.compare(duressDraft.trim(), masterHashRef.current)) {
          duressMsgFlash(t('vaultIsMasterCode'));
          return;
        }
      } catch (e) { console.warn('master compare failed', e); }
    }
    // …nor the decoy master (it would shadow the fake-management intercept)
    if (decoyMasterHashRef.current) {
      try {
        if (await bcrypt.compare(duressDraft.trim(), decoyMasterHashRef.current)) {
          duressMsgFlash(t('decoyMasterIsMaster'));
          return;
        }
      } catch (e) { console.warn('decoy master compare failed', e); }
    }
    setDuressSaving(true);
    try {
      const clean = duressDraft.trim();
      // the duress word must not collide with a real vault code either
      if (await vaultCodeTaken(clean)) {
        duressMsgFlash(t('duressTaken'));
        return;
      }
      // P0-4: hash on-device (bcryptjs) — plaintext never leaves the device
      const hash = await bcrypt.hash(clean, 10);
      const vaultId = await engine.saveDuressCode(userId, hash);
      setSecretVault((v) => ({
        ...v,
        vaults: [
          ...v.vaults.filter((x) => !x.isDecoy),
          { id: vaultId, codeHash: hash, isDecoy: true },
        ],
      }));
      setDuressDraft('');
      duressMsgFlash(t('duressSaved'));
      // opsec: collapse the form — no trace left
      setTimeout(() => { setDuressFormOpen(false); setDuressMsg(null); }, 1600);
    } catch (e) {
      console.warn('setDuressCode failed', e);
      duressMsgFlash(t('secretCodeFail'));
    } finally {
      setDuressSaving(false);
    }
  }, [userId, duressDraft, duressSaving, duressMsgFlash, secretVault, duressConfirmReplace, vaultCodeTaken]);

  const removeDuressLocal = useCallback(async () => {
    if (!userId) return;
    try {
      await engine.removeDuressCode(userId);
      setSecretVault((v) => ({ ...v, vaults: v.vaults.filter((x) => !x.isDecoy) }));
      duressMsgFlash(t('duressRemoved'));
    } catch (e) { console.warn('removeDuressCode failed', e); duressMsgFlash(t('secretCodeFail')); }
  }, [userId, duressMsgFlash]);

  /** Opens vault management: the master word was typed in chat and verified locally. */
  /**
   * Open vault management. decoy=true opens the FAKE management (6.6): the
   * same screen, but only the decoy vault is listed — every op inside applies
   * to the decoy layer. The open_log push fires identically either way
   * (silent alarm for the owner on their other devices).
   */
  const openVaultManagement = useCallback(async (decoy: boolean = false) => {
    if (!userId) return;
    setMgmtDecoyMode(decoy);
    setDecoyMasterSet(!!decoyMasterHashRef.current);
    setMgmtOpen(true);
    setMgmtLoading(true);
    setMgmtMsg(null);
    try {
      const all = await engine.listManagedVaults(userId);
      setMgmtVaults(decoy ? all.filter((v) => v.isDecoy) : all);
    } catch (e) { console.warn('listManagedVaults failed', e); }
    finally { setMgmtLoading(false); }
    // every management open pings ALL owner devices instantly (fire-and-forget)
    engine.logMasterOpen(getLang());
  }, [userId]);
  const closeMgmt = useCallback(() => {
    setMgmtOpen(false);
    setMgmtDecoyMode(false);
    setVaultCodeEditId(null);
    setVaultCodeDraft('');
    setVaultDelId(null);
    setVaultDelMaster('');
    setMgmtMasterNew('');
    setMgmtMasterCur('');
    setDecoyMasterNew('');
    setMgmtMsg(null);
    mgmtTokenRef.current = ''; // the capability dies with the session
  }, []);

  /**
   * 🔒👻🪞 Ghost intercept — shared by typed AND voice input (6.1).
   * A saved vault code / the master word / the decoy-master word opens its
   * target directly: never saved as a note, never sent to the agent, never
   * shown as a chat bubble. Returns true when a word matched.
   */
  const tryGhostIntercept = useCallback(async (raw: string): Promise<boolean> => {
    const clean = raw.trim();
    if (!clean) return false;
    // 🔒 secret vaults: a saved code opens ITS vault page.
    // P0-4: codes are bcrypt hashes — compare locally (hashes only, never
    // plaintext). Single-word gate: codes are words; this keeps multi-word
    // chat messages at zero added cost.
    if (secretVault.enabled && !/\s/.test(clean) && clean.length <= 60) {
      for (const v of secretVault.vaults) {
        try {
          if (await bcrypt.compare(clean, v.codeHash)) {
            void openSecretVault(v.id);
            return true;
          }
        } catch { /* malformed hash: skip */ }
      }
    }
    // 👻 ghost key: the master word opens vault MANAGEMENT
    if (masterHashRef.current) {
      try {
        if (await bcrypt.compare(clean, masterHashRef.current)) {
          // P0-5: the session also needs the SERVER-issued mgmt capability —
          // fetch it now (attempt-counted, success resets the counter).
          try {
            mgmtTokenRef.current = await engine.verifyMasterKey(clean);
          } catch (e) {
            console.warn('mgmt token fetch failed', e);
            mgmtTokenRef.current = '';
          }
          void openVaultManagement(false);
          return true;
        }
      } catch (e) { console.warn('master compare failed', e); }
    }
    // 🪞 decoy master: opens FAKE management (decoy vault only, same look)
    if (decoyMasterHashRef.current) {
      try {
        if (await bcrypt.compare(clean, decoyMasterHashRef.current)) {
          void openVaultManagement(true);
          return true;
        }
      } catch (e) { console.warn('decoy master compare failed', e); }
    }
    return false;
  }, [secretVault, openSecretVault, openVaultManagement]);

  /** Management: change a vault's code (session already proved the master in chat). */
  const changeVaultCodeLocal = useCallback(async (vaultId: string) => {
    const clean = vaultCodeDraft.trim();
    if (!clean) return;
    // a vault code must never equal the master key
    if (masterHashRef.current) {
      try {
        if (await bcrypt.compare(clean, masterHashRef.current)) {
          setMgmtMsg(t('vaultIsMasterCode'));
          return;
        }
      } catch (e) { console.warn('master compare failed', e); }
    }
    // …nor the decoy master, nor another vault's code (ambiguous intercept)
    if (decoyMasterHashRef.current) {
      try {
        if (await bcrypt.compare(clean, decoyMasterHashRef.current)) {
          setMgmtMsg(t('decoyMasterIsMaster'));
          return;
        }
      } catch (e) { console.warn('decoy master compare failed', e); }
    }
    for (const v of secretVault.vaults) {
      if (v.id === vaultId) continue;
      try {
        if (await bcrypt.compare(clean, v.codeHash)) {
          setMgmtMsg(t('duressTaken'));
          return;
        }
      } catch { /* ignore */ }
    }
    try {
      // P0-4: hash on-device; P0-5: the mgmt capability proves the session
      const hash = await bcrypt.hash(clean, 10);
      if (mgmtDecoyMode) {
        // fake management: the decoy vault is sacrificed by design — its row
        // is managed directly (owner RLS), never touching real vaults.
        await engine.updateDecoyVaultCode(vaultId, hash);
      } else {
        await engine.updateVaultCode(vaultId, hash, mgmtTokenRef.current);
      }
      setVaultCodeEditId(null);
      setVaultCodeDraft('');
      setSecretVault((v) => ({ ...v, vaults: v.vaults.map((x) => (x.id === vaultId ? { ...x, codeHash: hash } : x)) }));
      setMgmtMsg(t('mgmtCodeChanged'));
    } catch (e) { console.warn('changeVaultCode failed', e); setMgmtMsg(masterErrText(e)); }
  }, [vaultCodeDraft, secretVault, masterErrText, mgmtDecoyMode]);

  /** Management: delete a vault — two-tap + master re-verify (edge counts attempts). */
  const deleteVaultLocal = useCallback(async (vaultId: string) => {
    if (vaultDelId !== vaultId) {
      setVaultDelId(vaultId);
      setVaultDelMaster('');
      setTimeout(() => setVaultDelId((cur) => (cur === vaultId ? null : cur)), 8000);
      return;
    }
    if (!userId || !vaultDelMaster.trim()) return;
    try {
      if (mgmtDecoyMode) {
        // (6.6) fake management: the delete confirm checks the DECOY master
        // locally — the real master must never be asked for here (a coercer
        // is watching). The list only contains the decoy anyway.
        const ok = decoyMasterHashRef.current
          ? await bcrypt.compare(vaultDelMaster.trim(), decoyMasterHashRef.current).catch(() => false)
          : false;
        if (!ok) {
          setMgmtMsg(t('masterWrong'));
          return;
        }
        // fake management: the decoy vault is sacrificed by design — deleted
        // directly (owner RLS), never touching real vaults.
        await engine.deleteDecoyVault(vaultId);
      } else {
        // real management: fresh server verify → fresh mgmt capability,
        // which the delete must present (P0-5)
        const tok = await engine.verifyMasterKey(vaultDelMaster); // 5 wrong = 1h lock
        await engine.deleteVault(vaultId, tok);
      }
      setSecretVault((v) => ({ ...v, vaults: v.vaults.filter((x) => x.id !== vaultId) }));
      setMgmtVaults((prev) => prev.filter((x) => x.id !== vaultId));
      setVaultDelId(null);
      setVaultDelMaster('');
      setMgmtMsg(t('mgmtDeleted'));
    } catch (e) {
      console.warn('deleteVault failed', e);
      setMgmtMsg(masterErrText(e));
    }
  }, [vaultDelId, vaultDelMaster, userId, masterErrText, mgmtDecoyMode]);

  /** Management: change the master key. Both modes ask for the CURRENT word
   *  first (re-auth before rotating — and the two UIs stay pixel-identical). */
  const changeMasterFromMgmt = useCallback(async () => {
    if (!userId || !mgmtMasterNew.trim() || !mgmtMasterCur.trim()) return;
    // (6.6) in FAKE management the "change master" section rotates the DECOY
    // master instead — identical UI, decoy layer. Proof is the CURRENT decoy
    // word (server compares it against the stored decoy hash); the new word
    // arrives pre-hashed and never travels.
    if (mgmtDecoyMode) {
      const clean = mgmtMasterNew.trim();
      if (await vaultCodeTaken(clean)) {
        setMgmtMsg(t('masterIsVaultCode'));
        return;
      }
      if (masterHashRef.current) {
        try {
          if (await bcrypt.compare(clean, masterHashRef.current)) {
            setMgmtMsg(t('decoyMasterIsMaster'));
            return;
          }
        } catch (e) { console.warn('master compare failed', e); }
      }
      try {
        const hash = await bcrypt.hash(clean, 10);
        const returned = await engine.rotateDecoyMaster(mgmtMasterCur.trim(), hash);
        decoyMasterHashRef.current = returned || hash;
        setDecoyMasterSet(true);
        setMgmtMasterNew('');
        setMgmtMasterCur('');
        setMgmtMsg(t('masterChanged'));
      } catch (e) {
        console.warn('changeDecoyMaster failed', e);
        setMgmtMsg(masterErrText(e));
      }
      return;
    }
    if (await vaultCodeTaken(mgmtMasterNew.trim())) {
      setMgmtMsg(t('masterIsVaultCode'));
      return;
    }
    // re-auth: the current word must still match the session's master hash
    try {
      const curOk = masterHashRef.current
        ? await bcrypt.compare(mgmtMasterCur.trim(), masterHashRef.current).catch(() => false)
        : false;
      if (!curOk) {
        setMgmtMsg(t('masterWrong'));
        return;
      }
    } catch (e) { console.warn('master re-auth failed', e); }
    try {
      // app-layer bcrypt (the engine stays dependency-free); the raw key never travels
      const hash = await bcrypt.hash(mgmtMasterNew.trim(), 10);
      const returned = await engine.rotateMasterHash(hash, mgmtTokenRef.current);
      masterHashRef.current = returned || hash;
      setMgmtMasterNew('');
      setMgmtMasterCur('');
      setMgmtMsg(t('masterChanged'));
      await refreshMaster();
    } catch (e) {
      console.warn('changeMasterKey failed', e);
      setMgmtMsg(masterErrText(e));
    }
  }, [userId, mgmtMasterNew, mgmtMasterCur, refreshMaster, masterErrText, mgmtDecoyMode, vaultCodeTaken]);

  /**
   * (6.4) Decoy filler wizard: an empty decoy isn't convincing. Inserts a few
   * mundane, plausible notes (from DECOY_FILLER templates) into the decoy
   * vault so it looks lived-in. Real-management only.
   */
  const fillDecoyLocal = useCallback(async () => {
    if (!userId) return;
    const pid = spaceIdByType('private');
    const decoy = secretVault.vaults.find((v) => v.isDecoy);
    if (!pid || !decoy) return;
    setMgmtMsg(null);
    try {
      const pool = [...DECOY_FILLER[getLang()]];
      // pick 6 random templates
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const text of pool.slice(0, 6)) {
        await engine.saveSecretNote(pid, userId, text, decoy.id, null);
      }
      setMgmtMsg(t('fillDecoyDone'));
      // refresh the decoy row's note count
      setMgmtVaults(await engine.listManagedVaults(userId));
    } catch (e) { console.warn('fillDecoy failed', e); setMgmtMsg(t('secretCodeFail')); }
  }, [userId, secretVault, spaceIdByType]);

  /**
   * (6.6) Set the DECOY master from REAL management only (the session proved
   * the real master in chat). The app pre-hashes; the raw word never travels.
   * Guards: a decoy vault must exist, and the word must differ from the real
   * master and from every vault code.
   */
  const setDecoyMasterLocal = useCallback(async () => {
    if (!userId || !decoyMasterNew.trim() || decoyMasterSaving) return;
    const clean = decoyMasterNew.trim();
    if (!secretVault.vaults.some((v) => v.isDecoy)) {
      setMgmtMsg(t('decoyMasterNoDecoy'));
      return;
    }
    if (await vaultCodeTaken(clean)) {
      setMgmtMsg(t('masterIsVaultCode'));
      return;
    }
    if (masterHashRef.current) {
      try {
        if (await bcrypt.compare(clean, masterHashRef.current)) {
          setMgmtMsg(t('decoyMasterIsMaster'));
          return;
        }
      } catch (e) { console.warn('master compare failed', e); }
    }
    setDecoyMasterSaving(true);
    try {
      const hash = await bcrypt.hash(clean, 10);
      const returned = await engine.setDecoyMaster(hash, mgmtTokenRef.current);
      decoyMasterHashRef.current = returned || hash;
      setDecoyMasterSet(true);
      setDecoyMasterNew('');
      setMgmtMsg(t('decoyMasterSaved'));
    } catch (e) {
      console.warn('setDecoyMaster failed', e);
      setMgmtMsg(masterErrText(e));
    } finally {
      setDecoyMasterSaving(false);
    }
  }, [userId, decoyMasterNew, decoyMasterSaving, secretVault, masterErrText, vaultCodeTaken]);

  /** (6.6) Remove the decoy master — real management only. */
  const removeDecoyMasterLocal = useCallback(async () => {
    if (!userId) return;
    try {
      await engine.removeDecoyMaster(mgmtTokenRef.current);
      decoyMasterHashRef.current = null;
      setDecoyMasterSet(false);
      setMgmtMsg(t('decoyMasterRemoved'));
    } catch (e) { console.warn('removeDecoyMaster failed', e); setMgmtMsg(masterErrText(e)); }
  }, [userId, masterErrText]);

  return {
    secretVault,
    setSecretVault,
    trashSecret,
    setTrashSecret,
    masterHashRef,
    decoyMasterHashRef,
    mgmtTokenRef,
    vaultCodeTaken,
    mgmtDecoyMode,
    setMgmtDecoyMode,
    decoyMasterSet,
    setDecoyMasterSet,
    decoyMasterNew,
    setDecoyMasterNew,
    decoyMasterSaving,
    setDecoyMasterSaving,
    duressConfirmReplace,
    setDuressConfirmReplace,
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
    setMasterMsgOk,
    masterSaving,
    setMasterSaving,
    recoveryInfo,
    setRecoveryInfo,
    duressFormOpen,
    setDuressFormOpen,
    duressDraft,
    setDuressDraft,
    duressMsg,
    setDuressMsg,
    duressSaving,
    setDuressSaving,
    mgmtOpen,
    setMgmtOpen,
    mgmtVaults,
    setMgmtVaults,
    mgmtLoading,
    setMgmtLoading,
    vaultCodeEditId,
    setVaultCodeEditId,
    vaultCodeDraft,
    setVaultCodeDraft,
    vaultDelId,
    setVaultDelId,
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
    setSecretNotes,
    secretDraft,
    setSecretDraft,
    secretSaving,
    setSecretSaving,
    secretSearchOpen,
    setSecretSearchOpen,
    secretSearch,
    setSecretSearch,
    secretEditingId,
    setSecretEditingId,
    secretEditDraft,
    setSecretEditDraft,
    secretDelId,
    setSecretDelId,
    secretPhotoUri,
    setSecretPhotoUri,
    secretCodeDraft,
    setSecretCodeDraft,
    secretCodeMsg,
    setSecretCodeMsg,
    secretCodeMsgOk,
    setSecretCodeMsgOk,
    refreshSecretNotes,
    openSecretVault,
    saveSecretNoteLocal,
    pollSecretNote,
    onSecretRecordPress,
    pickSecretPhoto,
    askSecretPhotoSource,
    startEditSecret,
    saveEditSecret,
    askDeleteSecret,
    saveSecretCode,
    masterMsgFlash,
    duressMsgFlash,
    masterErrText,
    refreshMaster,
    saveMasterKeyLocal,
    requestRecoveryLocal,
    cancelRecoveryLocal,
    completeRecoveryLocal,
    saveDuressLocal,
    removeDuressLocal,
    openVaultManagement,
    closeMgmt,
    tryGhostIntercept,
    changeVaultCodeLocal,
    deleteVaultLocal,
    changeMasterFromMgmt,
    fillDecoyLocal,
    setDecoyMasterLocal,
    removeDecoyMasterLocal,
  };
}
