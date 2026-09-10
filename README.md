# 📊 DEPI Attendance Automation

تطبيق Desktop (Electron) لأتمتة شغل الحضور بتاع DEPI:

- **سحب الحضور** من DEPI Dashboard وتصديره لملفات CSV / Excel لكل جروب.
- **رفع الحضور على الـ LMS** (`lms-bot/upload.py`).
- **تعديل عناوين السيشنز على الـ LMS** (`lms-bot/edit.py`).
- **تعديل لينكات السيشنز** على الـ Dashboard (`edit_dashboard_links.js`).

كل ده من واجهة واحدة فيها فلاتر (تاريخ، جروب، راوند، باتش، تراك) ولوج بيظهر لحظيًا.

---

## 📦 المتطلبات

لازم تنزّل الحاجات دي على الجهاز الأول:

| البرنامج | الإصدار | ليه محتاجينه |
|---|---|---|
| [Node.js](https://nodejs.org/) | 20 LTS أو أحدث | تشغيل التطبيق وسكريبت الحضور |
| [Python](https://www.python.org/downloads/) | 3.9 أو أحدث | سكريبتات الـ LMS (رفع وتعديل) |
| [Google Chrome](https://www.google.com/chrome/) | آخر إصدار | كل السكريبتات بتفتح Chrome المتسطب على الجهاز |
| [Git](https://git-scm.com/) | أي إصدار | عشان تعمل clone للمشروع |

> ⚠️ **مهم وانت بتسطّب Python على Windows:** علّم على **"Add python.exe to PATH"** في أول شاشة. التطبيق بيشغّل سكريبتات الـ LMS بالأمر `python`، فلو مش موجود في الـ PATH هيطلعلك خطأ.

اتأكد إن كله متسطب صح:

```bash
node --version
```

```bash
npm --version
```

```bash
python --version
```

---

## 🚀 التثبيت (أول مرة بس)

### 1. نزّل المشروع

```bash
git clone https://github.com/mohabmohamed4888-hash/Attendence_depi.git
```

```bash
cd Attendence_depi
```

### 2. نزّل مكتبات Node.js

```bash
npm install
```

الأمر ده بينزّل:
- `electron` — الواجهة
- `playwright` — التحكم في المتصفح
- `xlsx` — قراءة وكتابة ملفات Excel
- `dotenv` — قراءة ملف `.env`

### 3. نزّل مكتبات Python

```bash
pip install -r lms-bot/requirements.txt
```

الأمر ده بينزّل `playwright` و `python-dotenv`.

> لو `pip` مش شغال جرّب: `python -m pip install -r lms-bot/requirements.txt`

### 4. (اختياري) لو Google Chrome مش متسطب

السكريبتات بتستخدم Chrome اللي على الجهاز. لو مش عندك Chrome، تقدر تنزّله عن طريق Playwright:

```bash
npx playwright install chrome
```

### 5. اعمل ملف `.env`

اعمل ملف اسمه `.env` في فولدر المشروع الرئيسي (جنب `package.json`) وحط فيه بيانات الدخول:

```env
# حساب DEPI Dashboard (لسحب الحضور وتعديل اللينكات)
LOGIN_EMAIL=your_email@example.com
LOGIN_PASSWORD=your_password

# حساب الـ LMS للجروبات الـ Technical
LMS_EMAIL=your_lms_email@example.com
LMS_PASSWORD=your_lms_password

# حساب الـ LMS للجروبات الـ Non-Technical
LMS_NONTECH_EMAIL=your_nontech_lms_email@example.com
LMS_NONTECH_PASSWORD=your_nontech_lms_password

# فولدر بروفايلات Chrome اللي بتستخدمها سكريبتات الـ LMS
# (غيّره لمسار موجود على جهازك)
CHROME_PROFILE_BASE_DIR=C:\Users\<USERNAME>\Desktop\pw-profile
```

> 🔒 ملف `.env` موجود في `.gitignore`، يعني مش هيترفع على GitHub. **ماتحطش الباسوردات في أي ملف تاني.**

---

## ▶️ تشغيل التطبيق

اختار أي طريقة من دول:

### الطريقة 1: من الـ Terminal

```bash
npm start
```

### الطريقة 2: وضع التطوير (بيفتح DevTools)

```bash
npm run dev
```

### الطريقة 3: دبل كليك (Windows)

- **`Open Attendance App.vbs`** — بيفتح التطبيق على طول من غير ما يظهر Terminal.
- **`run_gui.bat`** — بيعمل `npm install` لوحده لو `node_modules` مش موجود، وبعدين يشغّل التطبيق.
- **`run_gui.ps1`** — نفس فكرة الـ `.bat` بس PowerShell.

---

## 📖 طريقة الاستخدام

1. افتح التطبيق.
2. اختار **من تاريخ** و **إلى تاريخ**.
3. (اختياري) فلتر بالجروب أو الراوند أو الباتش أو التراك (Technical / Non-Technical).
4. اختار العملية اللي عايزها ودوس **ابدأ**:
   - **سحب الحضور** من الـ Dashboard
   - **رفع على الـ LMS**
   - **تعديل على الـ LMS**
   - **تعديل لينكات الـ Dashboard**
5. تابع اللوج على الشاشة. تقدر توقف العملية في أي وقت بزرار **إيقاف**.

> 💡 هيتفتح Chrome قدامك وهو بيشتغل — **ماتقفلوش** لحد ما العملية تخلص.
> لو في عملية شغالة، مش هتقدر تبدأ عملية تانية غير لما الأولى تخلص أو توقفها.

---

## 📂 الملفات اللي التطبيق محتاجها

| الملف | الوصف |
|---|---|
| `groups.xlsx` | قائمة الجروبات (لازم يكون فيه عمود اسمه `group`) |
| `group_batches.js` | تقسيم الجروبات على الباتشات |
| `group_tracks.js` | تحديد كل جروب Technical ولا Non-Technical |
| `lms-bot/round5_groups.json` | IDs جروبات الـ Technical على الـ LMS |
| `lms-bot/round5_nontechnical_groups.json` | IDs جروبات الـ Non-Technical على الـ LMS |

---

## 📊 المخرجات

كل الملفات بتتحفظ في فولدر `exports/`:

```
exports/
├── Technical groups/
│   ├── CSV Titles/
│   └── <GROUP_NAME>/
├── Non Technical groups/
│   ├── CSV Titles/
│   └── <GROUP_NAME>/
├── skipped_sessions_<FROM>_to_<TO>.xlsx   # السيشنز اللي فشلت
└── missing_names_<FROM>_to_<TO>.xlsx      # أسماء مش موجودة في الـ roster
```

---

## 🗂️ هيكل المشروع

```
Attendence_depi/
├── main.js                    # Electron main process
├── preload.js                 # الربط بين الواجهة والـ main process
├── src/                       # الواجهة (HTML / CSS / JS)
├── run_attendance.js          # سحب الحضور من الـ Dashboard
├── edit_dashboard_links.js    # تعديل لينكات السيشنز
├── group_batches.js           # الباتشات
├── group_tracks.js            # التراكات
├── group_workbook.js          # تحديد مكان groups.xlsx
├── lms-bot/
│   ├── upload.py              # رفع الحضور على الـ LMS
│   ├── edit.py                # تعديل السيشنز على الـ LMS
│   ├── lms_session.py         # تسجيل الدخول والحسابات والبروفايلات
│   └── requirements.txt       # مكتبات Python
├── scripts/                   # سكريبتات مساعدة (بتشتغل بعد npm install)
├── package.json               # مكتبات Node.js والأوامر
└── .env                       # بيانات الدخول (مش بيترفع على GitHub)
```

---

## 🔧 حل المشاكل

**`'npm' is not recognized` أو `'node' is not recognized`**
Node.js مش متسطب أو مش في الـ PATH. سطّبه من [nodejs.org](https://nodejs.org/) واقفل الـ Terminal وافتحه تاني.

**`Failed to start LMS upload: spawn python ENOENT`**
Python مش في الـ PATH. سطّبه تاني وعلّم على **"Add python.exe to PATH"**.

**`ModuleNotFoundError: No module named 'dotenv'` أو `'playwright'`**
مكتبات Python مش متسطبة:
```bash
pip install -r lms-bot/requirements.txt
```

**`Chromium distribution 'chrome' is not found`**
Google Chrome مش متسطب. سطّبه أو شغّل:
```bash
npx playwright install chrome
```

**Chrome بيفتح ويقفل على طول / خطأ في البروفايل (سكريبتات الـ LMS)**
- اقفل كل نوافذ Chrome المفتوحة وجرّب تاني.
- اتأكد إن `CHROME_PROFILE_BASE_DIR` في `.env` مسار صح على جهازك.

**`Groups workbook not found`**
ملف `groups.xlsx` مش موجود في فولدر المشروع الرئيسي.

**خطأ في تسجيل الدخول**
راجع الإيميل والباسورد في `.env`، واتأكد إن النت شغال.

**`run_gui.ps1 cannot be loaded because running scripts is disabled`**
استخدم `run_gui.bat` أو `Open Attendance App.vbs` بدل منه، أو شغّله كده:
```bash
powershell -ExecutionPolicy Bypass -File run_gui.ps1
```

**التطبيق مش بيفتح خالص**
امسح `node_modules` ونزّل المكتبات تاني:
```bash
npm install
```

---

## 📚 ملفات تانية

- [GUI_README.md](GUI_README.md) — شرح تفصيلي للواجهة
- [UPDATES.md](UPDATES.md) — آخر التحديثات
- [QUICK_START.txt](QUICK_START.txt) — بداية سريعة
