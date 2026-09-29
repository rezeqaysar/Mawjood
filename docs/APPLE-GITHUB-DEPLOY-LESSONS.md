# ملخص مشاكل النشر مع Apple و GitHub — دروس 29 سبتمبر 2026

> **الهدف:** قبل أي نشر جديد (تطبيق جديد أو نسخة جديدة)، راجع هذا الملف لتتجنب نفس المتاهات.
> آخر تحديث: 29 سبتمبر 2026 — أول نشر ناجح لـ Mawjood على TestFlight.

---

## 1. تجهيز حساب Apple Developer

| المشكلة | الحل |
|---|---|
| بعد الدفع، التفعيل أخذ أيام بدون إيميل من Apple | الحالة بتتغير في بوابة التسجيل نفسها (developer.apple.com) — افحصها يدوياً بدل انتظار الإيميل |

**قبل النشر تأكد من:**
- [ ] عضوية Apple Developer Program مفعّلة (مش "قيد المعالجة")
- [ ] الـ Bundle ID مسجّل في Identifiers (مثل `com.rezeqaysar.mawjood`)

---

## 2. شهادات التوقيع (Code Signing) — أكبر مصدر للمشاكل

| المشكلة | الحل |
|---|---|
| شهادة التوزيع (Distribution Certificate) في EAS كانت تالفة → البناء يفشل فوراً | أعد رفع ملف `.p12` بصيغة legacy من Keychain، وتأكد من صلاحيته قبل الرفع |
| ملف الـ Provisioning Profile بدون Push → الـ build ينجح لكن الإشعارات ما بتشتغل | فعّل **Push Notifications** على الـ App ID أولاً، ثم أعد توليد الـ Profile وحمّل النسخة الجديدة (تأكد أنها تحتوي `aps-environment`) |

**قبل النشر تأكد من:**
- [ ] Push مفعّل على الـ App ID (إذا التطبيق بيستخدم إشعارات)
- [ ] الـ Provisioning Profile مولّد **بعد** تفعيل Push (القديم ما بينفع)
- [ ] شهادة التوزيع صالحة وغير منتهية في EAS Credentials

---

## 3. إعدادات البناء في `app.json` / `eas.json`

| المشكلة | الحل |
|---|---|
| `experiments.baseUrl` في `app.json` سبّب خطأ `ENOTDIR` وفشل البناء | احذف `baseUrl` من `app.json` — كان مخصصاً لنسخة الويب على GitHub Pages فقط، وبيكسر بناء iOS |

**قبل النشر تأكد من:**
- [ ] لا يوجد إعدادات خاصة بالويب في `app.json` بتأثر على iOS
- [ ] `eas.json` فيه بروفايل `production` سليم

---

## 4. مفتاح App Store Connect API

| المشكلة | الحل |
|---|---|
| إنشاء المفتاح يحتاج موافقة يدوية على اتفاقيتين (ToS + API Access) | يُنشأ من `appstoreconnect.apple.com` → Users and Access → API Keys — خطوة يدوية، ما بتنعمل برمجياً |
| ملف `.p8` يُحمّل مرة واحدة فقط | احفظه فوراً في مكان آمن (`~/.config/eas/` بصلاحيات 600) — إذا ضاع لازم تحذف المفتاح وتنشئ واحد جديد |

**البيانات المطلوبة للنشر (احفظها):**
- Key ID (مثال: `9Y35U5F6BQ`)
- Issuer ID (مثال: `a53dca44-ab24-4089-ac0f-5178e8168459`)
- Team ID (مثال: `QPC5GGK875`)
- ملف `.p8` نفسه

---

## 5. سجل التطبيق في App Store Connect

| المشكلة | الحل |
|---|---|
| الـ API رجّع "No apps found" و `eas submit` طلب `ascAppId` | إنشاء الـ App ID في Developer Portal **لا يكفي** — لازم تنشئ سجل التطبيق في `appstoreconnect.apple.com` → Apps → `+` → New App (تختار نفس الـ Bundle ID) |

**قبل النشر تأكد من:**
- [ ] التطبيق موجود في App Store Connect (افتح صفحة التطبيق وانسخ الرقم من الرابط)
- [ ] `ascAppId` (الرقم من رابط App Store Connect) مضاف في `eas.json` تحت `submit.production.ios`

---

## 6. طريقة النشر من الآيفون (بدون كمبيوتر): GitHub Actions

**السياق:** `eas submit` ما بيشتغل من سيرفر التطوير (الشبكة محجوبة)، ولوحة تحكم Expo على الويب ما فيها زر submit. الحل: workflow في GitHub Actions بيشتغل على `macos-latest`.

**الملف:** `.github/workflows/submit-ios.yml` — يُشغّل يدوياً من تبويب Actions في تطبيق GitHub.

### الأسرار المطلوبة (Repo Settings → Secrets → Actions)
| Secret | المصدر |
|---|---|
| `EXPO_TOKEN` | يُنشأ يدوياً من `expo.dev/settings/access-tokens` → **Personal Access Token** (Full Access) — **ليس** Robot |
| `ASC_KEY_ID` | من خطوة 4 |
| `ASC_ISSUER_ID` | من خطوة 4 |
| `ASC_KEY_P8` | محتوى ملف `.p8` كاملاً |

### أخطاء الـ workflow والحلول (بالترتيب اللي ظهرت فيه)

| # | الخطأ | السبب | الحل |
|---|---|---|---|
| 1 | `eas submit` فشل فوراً | الـ workflow ما كان ينزّل الريبو | أضف خطوة `actions/checkout@v4` |
| 2 | `Nonexistent flags: --key-id, --issuer-id` | هالـ flags مش موجودة في `eas submit` | انقل الإعدادات إلى `eas.json`: `ascApiKeyPath` + `ascApiKeyIssuerId` + `ascApiKeyId` تحت `submit.production.ios` |
| 3 | `Failed to resolve plugin for module "expo-router"` | `eas submit` بيقرأ إعدادات المشروع وبيحتاج `node_modules` | أضف خطوة `npm install` (من جذر الريبو للـ monorepo) قبل الـ submit |
| 4 | `Set ascAppId in the submit profile (eas.json)` | التطبيق مش موجود في App Store Connect | أنشئ التطبيق (خطوة 5) وأضف `ascAppId` في `eas.json` |

### ملاحظات إضافية
- الـ `.p8` يُكتب في `apps/mobile/asc-key.p8` أثناء الـ workflow — مضاف في `.gitignore` عشان ما يتسرّب للريبو
- الـ Key ID والـ Issuer ID **مش** حساسة — آمنة في `eas.json` (المحتوى الحساس هو الـ `.p8` فقط)
- إنشاء الـ Expo Token **ما بينعمل برمجياً** (لا GraphQL ولا REST) — خطوة يدوية إلزامية
- إضافة الـ Secrets **ما بتنعمل** بالـ API إذا الـ PAT محدود الصلاحيات — المستخدم بيضيفها يدوياً من الموبايل

---

## 7. إضافة المختبرين (Testers) على TestFlight

| المشكلة | الحل |
|---|---|
| إيميل الآيفون (`Rezeq.usa2015@gmail.com`) مختلف عن إيميل حساب المطوّر (`rezeqaysar@gmail.com`) — التطبيق ما بيظهر في TestFlight | أضف الإيميل كمستخدم في App Store Connect عبر الـ API (`POST /v1/userInvitations`) — بيستلم دعوة وبيقبلها، وبصير internal tester |
| إشعارات "البناء جاهز" بتروح لإيميل حساب المطوّر فقط | طبيعي — راقب إيميل المطوّر لمعرفة متى تخلص معالجة Apple (10-30 دقيقة عادةً) |

**ملاحظة:** المختبر الداخلي (internal) بيشوف النسخة فور انتهاء المعالجة بدون مراجعة. المختبر الخارجي (external) بيحتاج **Beta App Review** من Apple أول مرة (قد يأخذ 24-48 ساعة).

---

## 8. التحديثات بعد النشر الأول — مش كل مرة نفس العذاب

| نوع التغيير | الطريقة | السرعة |
|---|---|---|
| شاشات، ألوان، نصوص، منطق (JS/TS) | `eas update` (Over-The-Air) | **فوري** — بيوصل لما المستخدم يفتح التطبيق، بدون Apple |
| صلاحيات جديدة، مكتبات native، تحديث SDK | `eas build` + نفس workflow الـ submit | نفس خطوات اليوم (لكن الـ workflow جاهز — ضغطة زر) |

---

## قائمة الفحص السريع قبل أي نشر جديد ✅

- [ ] عضوية Apple Developer مفعّلة
- [ ] Bundle ID مسجّل + Push مفعّل (إذا لازم)
- [ ] Provisioning Profile جديد (بعد تفعيل Push) مرفوع في EAS
- [ ] شهادة التوزيع صالحة في EAS
- [ ] `app.json` نظيف من إعدادات الويب
- [ ] مفتاح ASC API موجود (Key ID + Issuer ID + ملف `.p8`)
- [ ] التطبيق منشأ في App Store Connect + `ascAppId` في `eas.json`
- [ ] Expo Token (Personal Access Token) موجود
- [ ] أسرار GitHub الأربعة محدّثة
- [ ] المختبرين مدعوّين وقابلين الدعوة

> **القاعدة الذهبية:** أي خطوة فشلت اليوم، سببها كان "شي ناقص قبل ما نبلش" — مشكلة في الإعداد، مش في الأدوات. راجع القائمة أولاً.
