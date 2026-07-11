# 🚀 Setup — صفحة `/careers` + Auto-poster للسوشيال ميديا

الدليل ده لمرة واحدة: تجهيز الـ tokens ووضعها في `.env` على السيرفر.

---

## 📋 الـ Env Vars المطلوبة كلها

```env
# Careers admin (Basic Auth)
ADMIN_PASSWORD=<اختر باسورد قوي>

# Public base — يستخدم في روابط البوستات
PUBLIC_BASE_URL=https://wzyfa.com

# Google Drive (اختياري — بدونه، CVs تتحفظ محلي فقط)
GOOGLE_DRIVE_CLIENT_ID=...
GOOGLE_DRIVE_CLIENT_SECRET=...
GOOGLE_DRIVE_REFRESH_TOKEN=...
GOOGLE_DRIVE_FOLDER_ID=...

# Facebook Page (اختياري — بدونه، الـ FB posting معطّل)
FB_PAGE_ID=...
FB_PAGE_ACCESS_TOKEN=...

# X / Twitter (اختياري — بدونه، الـ X posting معطّل)
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_SECRET=...
```

**كل واحد اختياري** — لو مش عايز تفعّل قناة معينة، سيبها. الصفحة والفورم بيشتغلوا حتى بدون أي من دي.

---

## 1️⃣ Google Drive — لحفظ الـ CVs في درايفك

### الخطوات (لمرة واحدة):

1. روح [Google Cloud Console](https://console.cloud.google.com/) → أنشئ Project (أو استخدم موجود).
2. **APIs & Services → Library** → ابحث "Google Drive API" → **Enable**.
3. **OAuth consent screen** →
   - User Type: **External**
   - Fill app name (مثلاً "Wzyfa Careers")
   - Add scope: `.../auth/drive.file`
   - Test users: أضف `islam.aboughazala@gmail.com`
4. **Credentials → Create Credentials → OAuth client ID** →
   - Type: **Web application**
   - Name: "Wzyfa Drive"
   - Authorized redirect URI: `http://127.0.0.1:53682/callback`
   - انسخ الـ **Client ID** و **Client Secret**
5. من terminal (على جهازك أو السيرفر):
   ```bash
   node scripts/get-drive-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
   ```
6. المتصفح هيفتح → sign in بـ `islam.aboughazala@gmail.com` → وافق.
7. الترمنال هيطبع 4 سطور env — انسخهم للـ `.env`.

بعدها هتلاقي فولدر **"وظيفة — طلبات التوظيف"** في درايفك، وكل CV بيتقدم هيتخزن هناك.

---

## 2️⃣ Facebook Page — Meta Graph API

### الخطوات:

1. روح [Meta for Developers](https://developers.facebook.com/) → **My Apps → Create App**.
2. Use case: **Other** → Type: **Business**.
3. من إعدادات الـ App:
   - **Add Product → Facebook Login for Business**
   - أضف **pages_manage_posts** و **pages_read_engagement** كـ permissions.
4. Business Portfolio: اربط الـ App بـ [صفحة wzifa.me](https://www.facebook.com/wzifa.me).
5. **Graph API Explorer** → [https://developers.facebook.com/tools/explorer/](https://developers.facebook.com/tools/explorer/):
   - اختار الـ app
   - User or Page: **Get Page Access Token** → اختار wzifa.me
   - أضف الـ permissions: `pages_manage_posts`, `pages_read_engagement`
   - انسخ الـ Access Token (ده short-lived — ساعة تقريباً)
6. **تحويله لـ long-lived** (60 يوم):
   ```bash
   curl -G "https://graph.facebook.com/v18.0/oauth/access_token" \
     -d "grant_type=fb_exchange_token" \
     -d "client_id=<APP_ID>" \
     -d "client_secret=<APP_SECRET>" \
     -d "fb_exchange_token=<SHORT_LIVED_TOKEN>"
   ```
7. **تحويله لـ never-expiring Page Token**:
   ```bash
   curl -G "https://graph.facebook.com/v18.0/<YOUR_USER_ID>/accounts" \
     -d "access_token=<LONG_LIVED_USER_TOKEN>"
   ```
   الرد هيحتوي على `access_token` للـ Page — ده اللي بيبقى **دائم** (طول ما الـ user token صالح، والـ page token المستخرج منه بعدها بيبقى بلا انتهاء).

8. عرّف في `.env`:
   ```env
   FB_PAGE_ID=<id بتاع wzifa.me — يظهر في الـ Graph Explorer response>
   FB_PAGE_ACCESS_TOKEN=<الـ never-expiring token>
   ```

### إزاي تجيب Page ID بسرعة:
- روح [facebook.com/wzifa.me](https://www.facebook.com/wzifa.me) → About → في آخر الصفحة "Page ID".
- أو: `curl "https://graph.facebook.com/v18.0/wzifa.me?access_token=<TOKEN>"`.

---

## 3️⃣ X (Twitter) API v2

### الخطوات:

1. روح [developer.x.com](https://developer.x.com/) → **Sign in** بحساب [@wzifaorg](https://x.com/wzifaorg).
2. **Sign up for a Free account** (مجاني — 500 post/شهر).
3. **Projects & Apps → Add App** → اختار الـ Project الجديد.
4. **User authentication settings**:
   - App permissions: **Read and write**
   - Type of App: **Web App**
   - Callback URL: `https://wzyfa.com/callback` (مش هنستخدمه فعلياً)
   - Website URL: `https://wzyfa.com`
5. **Keys and tokens**:
   - **API Key** و **API Key Secret** — انسخ الاتنين
   - **Access Token and Secret** → Generate → لازم يكون Read+Write
     - لو الـ token القديم Read-only، regenerate بعد ما غيّرت الـ permissions
   - انسخ **Access Token** و **Access Token Secret**
6. عرّف في `.env`:
   ```env
   X_API_KEY=...
   X_API_SECRET=...
   X_ACCESS_TOKEN=...
   X_ACCESS_SECRET=...
   ```

### ملاحظات مهمة على الـ Free tier:
- **500 POST/شهر** لكل app (يكفي 3–10/يوم × 30 = 300).
- الحد على مستوى الـ user كمان: 500 post شهرياً.
- لو تعدّيت الحد، الـ tweets ترجع 429 لحد أول الشهر.

---

## 4️⃣ نشر على الـ VPS

### `.env` على السيرفر:

```bash
# على الـ VPS
cd /path/to/wzyfa-search
nano .env
# انسخ كل الـ env vars اللي فوق
```

### تعديل `docker-compose.yml`:

تأكد إن `.env` بتنتقل للـ container:

```yaml
services:
  wzyfa:
    env_file: .env
    # ...
```

أو ضيف كل واحد كـ `environment:`.

### إعادة تشغيل:

```bash
docker compose up -d --build
docker compose logs -f wzyfa
```

هتلاقي في الـ logs:
```
[Server] وظيفة running on http://localhost:3000
```

---

## 5️⃣ التحقق إن كل حاجة شغالة

### الصفحة العامة:
- [https://wzyfa.com/careers](https://wzyfa.com/careers) → يفتح الفورم.
- ارفع CV تجريبي → لو فيه Drive credentials هتلاقيه فوراً في فولدر Drive.

### الإدارة:
- [https://wzyfa.com/careers/admin](https://wzyfa.com/careers/admin) → Basic Auth prompt.
- User: **أي حاجة** — Password: **قيمة ADMIN_PASSWORD**.
- هتشوف كل المتقدمين + روابط CVs.

### السوشيال:
- **Status:** `GET /api/social/status` (public) — يقولك القنوات مضبوطة ولا لأ.
- **Preview:** `GET /api/social/preview?count=5` (admin auth) — يعرض شكل البوستات قبل النشر.
- **Post now (test):** `POST /api/social/post-now` بـ body `{"count": 1}` (admin auth) — ينشر بوست واحد فوراً كتجربة.

مثال curl للـ test post:
```bash
curl -u admin:PASSWORD -X POST https://wzyfa.com/api/social/post-now \
  -H "Content-Type: application/json" \
  -d '{"count":1}'
```

### Cron:
- بشكل تلقائي: كل يوم **9:00 UTC** (12:00 مصر) بينشر **3–10 وظائف** (عدد عشوائي عشان يبان بشري).
- الوظائف اللي معاها HR email بتاخد أولوية.
- كل وظيفة اتنشرت مرة واحدة بس — بتتسجل في `data/social-posted.json`.

---

## 🔧 Troubleshooting

**"admin area disabled"** → `ADMIN_PASSWORD` مش متعرّف.

**"Drive upload failed: invalid_grant"** → الـ refresh token انتهى (نادر، بيحصل لو غيرت الـ password). كرر خطوة 1.

**"Facebook post failed: (#200) The user hasn't authorized..."** → الـ page token صلاحياته غلط. رجع Graph Explorer، تأكد من `pages_manage_posts`.

**"X post failed: Unauthorized"** → غالباً الـ access token Read-only. رجع developer portal → App permissions: **Read+Write** → Regenerate access token.

**عاوز تفصل نشر لقناة واحدة بس** → سيب env vars بتاعة القناة التانية فاضية.
