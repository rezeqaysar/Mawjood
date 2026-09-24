import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Lang = 'ar' | 'en';

const STORE_KEY = 'mawjood.lang';

// ── Arabic (current UI, source of truth) ─────────────────────────────
const ar = {
  // permissions
  permRequired: 'صلاحية مطلوبة',
  permCamera: 'فعّل صلاحية الكاميرا من الإعدادات.',
  permPhotos: 'فعّل صلاحية الصور من الإعدادات.',
  cancel: 'إلغاء',
  camera: 'كاميرا',
  gallery: 'المعرض',
  // photo
  photoWithNote: '📷 صورة مع الملاحظة',
  photoThenTell: 'صوّر الغرض وبعدين احكيلي عنه أو اكتب',
  photoOfPlace: '📷 صورة المكان',
  photoSourceQ: 'من وين بدك تاخد الصورة؟',
  photoUploadFail: 'تعذّر رفع الصورة',
  tryAgain: 'جرّب مرة تانية.',
  photoFailVoice: '⚠️ الصورة ما اترفعت — انحفظ التسجيل بدونها',
  photoFailNote: '⚠️ الصورة ما اترفعت — انحفظت الملاحظة بدونها',
  photoTalkOrType: 'احكي عنها أو اكتب 🎙️',
  // borrowing
  whoTookIt: 'مين أخذها؟',
  dueBack: ' — ترجع {date}',
  borrowWith: '🤝 مع {name}',
  confirmReturn: 'تأكيد الإرجاع؟',
  returned: '✅ رجع',
  // chat
  transcribeFail: '⚠️ ما قدرت أفرّغ التسجيل',
  transcribeSlow: '⏳ طول التفريغ — بتلاقيها بالمساحة',
  transcribing: '🎙️ جاري التفريغ…',
  recordFail: '⚠️ فشل التسجيل',
  saveFail: '⚠️ ما انحفظت — جرّب مرة ثانية',
  saved: '✅ انحفظت',
  savedInSpace: '✅ انحفظت بمساحة {space}',
  noAnswer: 'ما لقيت إجابة بملاحظاتك.',
  askFail: 'تعذّر السؤال — جرّب لاحقاً.',
  updatedPlace: '✅ تم التحديث: {title} صار {place}',
  familyTask: '👨‍👩‍👧 مهمة عائلية',
  taskAssigned: '✅ مهمة مسندة لـ{name}: {task}',
  pause: '⏸ إيقاف',
  play: '▶ تشغيل',
  move: '⇄ نقل',
  moveTo: 'انقل إلى:',
  nameSaveFail: 'ما انحفظ الاسم — جرّب مرة ثانية',
  chatPlaceholder: 'اكتب ملاحظة أو سؤال…',
  emptyChatTitle: 'احكيلي شي…',
  emptyChatSub: '“حطيت الجواز بالدرج”\nأو اسألني “وين حطيت الجواز؟”',
  exampleWhere: 'وين أغراضي؟',
  exampleTask: 'سارة: اشتري خبز',
  exampleCorrection: 'لا، نقلته على الخزانة',
  // tabs
  tabFamily: '👥 العائلة',
  tabShop: '🛒 تسوق',
  tabTasks: '✅ مهام',
  tabAgenda: '📅 مواعيد',
  tabThings: '📦 أشيائي',
  tabNotes: '📝 ملاحظات',
  // drawer / profile
  appTitle: 'Mawjood — موجود',
  aboutTitle: 'موجود — Mawjood',
  menuProfile: 'الملف الشخصي',
  menuInvite: 'دعوة العائلة',
  menuSubscription: 'الاشتراك',
  soon: 'قريباً',
  menuAbout: 'حول التطبيق',
  menuLogout: 'تسجيل الخروج',
  menuLanguage: 'اللغة / Language',
  profileTitle: '👤 الملف الشخصي',
  emailLabel: 'البريد',
  accountType: 'نوع الحساب',
  trial: 'تجريبي',
  permanent: 'دائم',
  memberSince: 'عضو منذ',
  spacesLabel: 'المساحات',
  displayNameLabel: 'الاسم (بيظهر لعائلتك)',
  nameExample: 'مثال: رزق',
  saving: 'بحفظ…',
  nameSaved: '✅ انحفظ',
  saveName: 'حفظ الاسم',
  close: 'إغلاق',
  save: 'حفظ',
  trialAccount: 'حساب تجريبي',
  trialBadge: '🧪 تجريبي',
  permAccountBadge: '✅ حساب دائم',
  trialBanner: '💾 حساب تجريبي — سجّل بريدك عشان بياناتك ما تضيع',
  confirmEmailSent: '✉️ أرسلنا رابط التأكيد — اضغطه من بريدك وبيصير حسابك دائم',
  youSuffix: ' (أنت)',
  // demo data
  demoTitle: 'بيانات تجريبية — للتجربة بدون OpenAI',
  demoAdd: '➕ إضافة بيانات تجريبية',
  demoClear: '🗑️ مسح التجربة ({count})',
  // family / invites
  tabHome: '💬 الرئيسية',
  searchItems: 'العناصر ({count}):',
  aboutBody: 'ذاكرتك الصوتية: احكيلي وين حطيت أغراضك، شو لازم تشتري، ومتى مواعيدك — وأنا بتذكر عنك.',
  inviteTitle: '✉️ دعوة للعائلة',
  inviteBody: 'شارك هذا الرمز مع أهلك — بيدخلوه من تبويب العائلة وبينضموا لمساحتك. صالح ٧ أيام.',
  familyManager: '👑 مدير العائلة',
  member: 'عضو',
  confirmRemove: 'تأكيد الإزالة؟',
  haveCode: 'عندك رمز؟ انضم لعائلة ثانية',
  confirmLeave: 'تأكيد مغادرة العائلة؟',
  leaveFamily: 'مغادرة العائلة',
  shareInviteText: 'رمز دعوة العائلة في موجود: {code}',
  joinWithCode: 'انضم لمساحة العائلة في موجود بهذا الرمز: {code}',
  joinFail: 'فشل الانضمام — جرّب مجدداً',
  genericFail: 'فشل — جرّب مجدداً',
  codeFail: 'تعذر إنشاء الرمز — جرّب مجدداً',
  share: 'مشاركة',
  copy: 'نسخ',
  newCode: '🔄 رمز جديد (بلغي القديم)',
  joinFamilyTitle: '👨‍👩‍👧 انضم لعائلة',
  enterCode: 'ادخل رمز الدعوة اللي وصلك من أهلك:',
  join: 'انضم',
  invalidEmail: 'اكتب بريد صحيح',
  // shopping / lists
  addItemPh: 'أضف غرض… حليب، خبز، بيض',
  shopEmpty: 'القائمة فاضية — أضف أول غرض 🛒',
  searchPh: '🔍 ابحث في الملاحظات والعناصر…',
  noResults: 'لا نتائج — جرّب كلمة ثانية.',
  notesEmpty: 'لا ملاحظات بعد — احكيلي شي من الرئيسية 💬',
  thingsEmpty: 'لا أغراض بعد — احكيلي «اشتريت …» بالشات 📦',
  tasksEmpty: 'لا مهام بعد — من الشات اكتب “سارة: اشتري خبز” ✅',
  agendaEmpty: 'لا مواعيد قادمة — المواعيد المستخرجة من ملاحظات العائلة بتظهر هون 📅',
  assign: 'إسناد',
  assigneePh: 'اسم الشخص… سارة',
  tapToClose: 'اضغط بأي مكان للإغلاق ✕',
  // auth screen
  authSendFail: 'فشل الإرسال — جرّب مجدداً',
  logo: 'موجود',
  checkEmail: 'تفقد بريدك ✉️',
  magicSent: 'أرسلنا رابط الدخول إلى {email}. اضغط عليه من نفس الجهاز وبتدخل مباشرة.',
  useOtherEmail: 'استخدام بريد آخر',
  loginWithEmail: 'ادخل ببريدك',
  loginSub: 'بنبعتلك رابط دخول — بدون كلمات سر.',
  sendLink: 'أرسل رابط الدخول',
};

// ── English ──────────────────────────────────────────────────────────
const en: Record<keyof typeof ar, string> = {
  permRequired: 'Permission required',
  permCamera: 'Enable camera access in Settings.',
  permPhotos: 'Enable photo library access in Settings.',
  cancel: 'Cancel',
  camera: 'Camera',
  gallery: 'Gallery',
  photoWithNote: '📷 Photo with note',
  photoThenTell: 'Snap the item, then tell me about it or type',
  photoOfPlace: '📷 Photo of the place',
  photoSourceQ: 'Where should the photo come from?',
  photoUploadFail: "Couldn't upload the photo",
  tryAgain: 'Try again.',
  photoFailVoice: "⚠️ Photo didn't upload — voice note saved without it",
  photoFailNote: "⚠️ Photo didn't upload — note saved without it",
  photoTalkOrType: 'Talk about it or type 🎙️',
  whoTookIt: 'Who took it?',
  dueBack: ' — due back {date}',
  borrowWith: '🤝 with {name}',
  confirmReturn: 'Confirm return?',
  returned: '✅ Returned',
  transcribeFail: "⚠️ Couldn't transcribe the recording",
  transcribeSlow: "⏳ Transcription is taking long — you'll find it in the space",
  transcribing: '🎙️ Transcribing…',
  recordFail: '⚠️ Recording failed',
  saveFail: "⚠️ Didn't save — try again",
  saved: '✅ Saved',
  savedInSpace: '✅ Saved in {space}',
  noAnswer: 'No answer found in your notes.',
  askFail: "Couldn't ask — try later.",
  updatedPlace: '✅ Updated: {title} is now {place}',
  familyTask: '👨‍👩‍👧 Family task',
  taskAssigned: '✅ Task assigned to {name}: {task}',
  pause: '⏸ Pause',
  play: '▶ Play',
  move: '⇄ Move',
  moveTo: 'Move to:',
  nameSaveFail: "Couldn't save the name — try again",
  chatPlaceholder: 'Write a note or question…',
  emptyChatTitle: 'Tell me something…',
  emptyChatSub: '"I put the passport in the drawer"\nor ask me "where did I put the passport?"',
  exampleWhere: 'Where are my things?',
  exampleTask: 'Sara: buy bread',
  exampleCorrection: 'No, I moved it to the closet',
  tabFamily: '👥 Family',
  tabShop: '🛒 Shopping',
  tabTasks: '✅ Tasks',
  tabAgenda: '📅 Agenda',
  tabThings: '📦 My things',
  tabNotes: '📝 Notes',
  appTitle: 'Mawjood',
  aboutTitle: 'Mawjood',
  menuProfile: 'Profile',
  menuInvite: 'Family invite',
  menuSubscription: 'Subscription',
  soon: 'Soon',
  menuAbout: 'About the app',
  menuLogout: 'Log out',
  menuLanguage: 'Language / اللغة',
  profileTitle: '👤 Profile',
  emailLabel: 'Email',
  accountType: 'Account type',
  trial: 'Trial',
  permanent: 'Permanent',
  memberSince: 'Member since',
  spacesLabel: 'Spaces',
  displayNameLabel: 'Name (shown to your family)',
  nameExample: 'e.g. Rezeq',
  saving: 'Saving…',
  nameSaved: '✅ Saved',
  saveName: 'Save name',
  close: 'Close',
  save: 'Save',
  trialAccount: 'Trial account',
  trialBadge: '🧪 Trial',
  permAccountBadge: '✅ Permanent account',
  trialBanner: "💾 Trial account — add your email so you don't lose your data",
  confirmEmailSent: "✉️ We sent a confirmation link — tap it from your email and your account becomes permanent",
  youSuffix: ' (you)',
  demoTitle: 'Demo data — try it without OpenAI',
  demoAdd: '➕ Add demo data',
  demoClear: '🗑️ Clear demo ({count})',
  tabHome: '💬 Home',
  searchItems: 'Items ({count}):',
  aboutBody: 'Your voice memory: tell me where you put things, what to buy, and when your appointments are — and I remember for you.',
  inviteTitle: '✉️ Family invite',
  inviteBody: 'Share this code with your family — they enter it from the Family tab and join your space. Valid 7 days.',
  familyManager: '👑 Family manager',
  member: 'Member',
  confirmRemove: 'Confirm removal?',
  haveCode: 'Have a code? Join another family',
  confirmLeave: 'Confirm leaving the family?',
  leaveFamily: 'Leave family',
  shareInviteText: 'Mawjood family invite code: {code}',
  joinWithCode: 'Join the Mawjood family space with this code: {code}',
  joinFail: "Couldn't join — try again",
  genericFail: 'Failed — try again',
  codeFail: "Couldn't create the code — try again",
  share: 'Share',
  copy: 'Copy',
  newCode: '🔄 New code (invalidates the old one)',
  joinFamilyTitle: '👨‍👩‍👧 Join a family',
  enterCode: 'Enter the invite code you got from your family:',
  join: 'Join',
  invalidEmail: 'Enter a valid email',
  addItemPh: 'Add item… milk, bread, eggs',
  shopEmpty: 'List is empty — add your first item 🛒',
  searchPh: '🔍 Search notes and items…',
  noResults: 'No results — try another word.',
  notesEmpty: 'No notes yet — tell me something from Home 💬',
  thingsEmpty: 'No things yet — tell me "I bought …" in chat 📦',
  tasksEmpty: 'No tasks yet — in chat write "Sara: buy bread" ✅',
  agendaEmpty: 'No upcoming appointments — appointments from family notes show up here 📅',
  assign: 'Assign',
  assigneePh: "Person's name… Sara",
  tapToClose: 'Tap anywhere to close ✕',
  authSendFail: "Couldn't send — try again",
  logo: 'Mawjood',
  checkEmail: 'Check your email ✉️',
  magicSent: 'We sent a login link to {email}. Tap it from the same device to sign in.',
  useOtherEmail: 'Use another email',
  loginWithEmail: 'Sign in with your email',
  loginSub: "We'll send you a login link — no passwords.",
  sendLink: 'Send login link',
};

export type TKey = keyof typeof ar;
const DICT: Record<Lang, Record<TKey, string>> = { ar, en };

let lang: Lang = 'ar';
const listeners = new Set<(l: Lang) => void>();

export function getLang(): Lang {
  return lang;
}
/** text alignment for the few styles that hardcode a direction */
export function ta(): 'right' | 'left' {
  return lang === 'ar' ? 'right' : 'left';
}

export function t(key: TKey): string {
  return DICT[lang][key] ?? DICT.ar[key] ?? key;
}

export function tx(key: TKey, params: Record<string, string | number>): string {
  let s = t(key);
  for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
  return s;
}

/** call once during app init, before first render */
export async function initLanguage(): Promise<Lang> {
  try {
    const s = await AsyncStorage.getItem(STORE_KEY);
    if (s === 'ar' || s === 'en') lang = s;
  } catch {
    /* keep default */
  }
  return lang;
}

export async function setLanguage(l: Lang): Promise<void> {
  if (l === lang) return;
  lang = l;
  try {
    await AsyncStorage.setItem(STORE_KEY, l);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn(l));
}

/** re-renders the component whenever the language changes */
export function useLang(): Lang {
  const [l, setL] = useState(lang);
  useEffect(() => {
    listeners.add(setL);
    return () => {
      listeners.delete(setL);
    };
  }, []);
  return l;
}
