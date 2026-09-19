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

   في خانة **Group Names** تقدر تحط **أكتر من جروب** مفصولين بفاصلة، مثلًا:

   ```
   ONL5_SWD5_G1, ONL5_ISS3_S4, CAI5_SWD5_S2
   ```

   سحب الحضور بيخلص جروب ويدخل على اللي بعده بالترتيب اللي كتبته، وبيطلب من الـ Dashboard **السيشنز بتاعة الجروبات دي بس** مش كل سيشنز المدى الزمني. يعني 5 سيشنز بدل 366 لما تختار 3 جروبات. الراوند كمان بيتبعت في نفس الطلب (`round=second` للراوند 5). زرار **Edit Dashboard Link** بياخد جروب واحد بس.
4. اختار العملية اللي عايزها ودوس عليها:
   - **Run Everything** — التلاتة ورا بعض من غير أي انتظار بينهم (تحت)
   - **سحب الحضور** من الـ Dashboard
   - **رفع على الـ LMS**
   - **تعديل على الـ LMS**
   - **تعديل لينكات الـ Dashboard**
   - **Clean Exports** — تنضيف فولدر الـ exports (تحت)

### ▶️ زرار Run Everything

بيشغّل التلات خطوات ورا بعض بنفس الفلاتر اللي فوق، من غير ما تستنى وتدوس بين كل واحدة والتانية:

1. **سحب الحضور** — بينزّل ملفات الـ CSV وعناوين السيشنز.
2. **Sync / Edit Sessions** — بيتأكد إن كل سيشن موجودة على الـ LMS بعنوانها ووقتها الصح.
3. **Upload Attendance** — بيرفع الحضور على السيشنز دي.

الترتيب ده إجباري: الرفع محتاج السيشنز تكون موجودة على الـ LMS الأول. لو أي خطوة وقعت، **الباقي مش بيشتغل** وبيظهرلك رقم الخطوة والسبب، عشان الحضور ما يتحطش على سيشن غلط. زرار **Cancel** بيوقف الخطوة الشغالة ومبيبدأش اللي بعدها.

### 🧹 زرار Clean Exports

بيمسح ملفات الحضور (CSV) بتاعة السيشنز من `exports/` **نهائيًا**، وبيشيل فولدرات الجروبات اللي فضيت. بيشتغل بس لما تدوس عليه وبيسألك تأكيد الأول.

- **مش بيمسح** أي ملف لسه مستني رفع تاني (اللي في `pending_reuploads.json`).
- **مش بيمسح** عناوين السيشنز (`CSV Titles`) ولا التقارير ولا ملفات المتابعة.
- أي ملف اتمسح بيرجع تاني لو شغّلت سحب الحضور على نفس التواريخ.
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
├── Lms missing names.csv                  # طلاب حضروا ومش في الـ roster ومعرفناش نضيفهم أوتوماتيك (مع السبب)
├── Roster additions.csv                   # كل طالب اتضاف أوتوماتيك على groups.xlsx (التاريخ، الجروب، الاسم، الإيميل)
├── pending_reuploads.json                 # ملفات CSV اتغيرت بعد ما اترفعت؛ Upload Attendance بيرفعها تاني وبيشيلها من القائمة
├── missing from wavz.csv                  # طلاب الـ LMS رفضهم (مش في كورس Wavz) وهم لسه active على الـ Dashboard
├── student_status.json                    # حالة كل طالب على الـ Dashboard (active / not_active)
└── groups_backups/                        # نسخة من groups.xlsx قبل كل تعديل أوتوماتيك
```

### 👤 الطلاب الناقصين من الـ roster

لو طالب ظهر في حضور سيشن وهو مش موجود في roster الجروب في `groups.xlsx`، سحب الحضور بيعمل نفس اللي كان بيتعمل بالإيد:

1. بيدور عليه في صفحة الطلاب على الـ Dashboard (`/super_admin/students?search=`) بالإيميل، ولو ملقاهوش بالاسم بالظبط.
2. بياخد الإيميل والجروب من بيانات الطالب، وبيضيف سطر `الاسم<TAB>الإيميل` في آخر خلية الـ roster بتاعة الجروب ده في `groups.xlsx` من غير ما يلمس أي تنسيق في الشيت.
3. بيكتب ملفات الحضور CSV بعد الإضافة، فالطالب بيبقى موجود فيها على طول.
4. اللي معرفش يلاقيه (مش موجود على الـ Dashboard، أو فيه أكتر من طالب بنفس الاسم، أو جروبه مالوش roster في الشيت) بيفضل في `exports/Lms missing names.csv` مع عمود `reason`، وبيحاول تاني في كل تشغيلة.

> ⚠️ اقفل `groups.xlsx` قبل ما تشغّل سحب الحضور. لو الملف مفتوح في Excel مش هيتعدل، والطلاب هيفضلوا في الـ CSV لحد التشغيلة الجاية.

### 🚫 الطلاب اللي الـ LMS رافضهم (missing from wavz)

وانت بترفع الحضور، الـ LMS أحيانًا بيقول `A user with the email set to ... could not be found in this course`، يعني الإيميل ده مش متسجل في كورس الـ Wavz فغيابه مش بيتسجل. الطلاب دول بيتكتبوا في `exports/missing from wavz.csv`.

بس الطالب اللي ساب البرنامج (**not_active** على الـ Dashboard) طبيعي إنه مش في الكورس، فمش منطقي يفضل في القايمة. عشان كده:

- **سحب الحضور** بيسجّل حالة كل طالب في `exports/student_status.json`. البيانات دي موجودة أصلًا جوه بيانات الحضور اللي بيسحبها، يعني **من غير أي طلب زيادة**.
- **رفع الحضور** بيقرا الملف ده، ولو الطالب `not_active` مبيكتبوش في القايمة خالص، وكمان بينضّف القايمة القديمة من أي حد بقى not_active.
- **سحب الحضور** كمان بينضّف القايمة في آخر كل تشغيلة، وأي إيميل حالته لسه مش معروفة بيدوّر عليه على الـ Dashboard على طول (ربع ثانية للواحد).

> الطالب اللي حالته **مش معروفة** بيفضل في القايمة. حالة مجهولة المفروض ماتخبّيش مشكلة تسجيل حقيقية.

يعني القايمة في الآخر بتبقى فيها **بس** الطلاب اللي لسه active ومحتاجين حد يضيفهم لكورس الـ Wavz.

### ♻️ السيشنز اللي غيابها متاخد على الـ LMS

السيشن اللي غيابها متاخد بيظهر جنبها السهم الأخضر (Change attendance) بدل أيقونة Take attendance.

- **Upload Attendance** بيعدّي السيشنز دي زي الأول، إلا لو سحب الحضور غيّر ملف الـ CSV بتاعها بعد ما اترفع (الحضور اتغير على الـ Dashboard أو طالب اتضاف على الـ roster). الملفات دي بتتسجل في `exports/pending_reuploads.json`، وبتترفع تاني من زرار Change attendance، وبعد الرفع بتتشال من القائمة.
- **Sync / Edit Sessions** مش بيعدّل أي سيشن غيابها متاخد، وبيكتبها في تقرير الـ UNMATCHED في آخر اللوج بسبب `attendance already taken on LMS; edit skipped`.

### ⚡ الـ Upload والـ Sync / Edit بقوا أسرع

- كل جروب بيتحمل جدول السيشنز بتاعه **مرة واحدة** وبيتقرا كله في نداء واحد، وكل قرار (تعديل، إنشاء، رفع، تخطي) بيتاخد على الصورة دي. قبل كده الجدول كان بيتحمل من جديد لكل سطر في ملف الـ titles ولكل صف في الـ Upload.
- التعديل والرفع بيفتحوا لينك السيشن نفسها (فيه `sessionid`) بدل الضغط على الأيقونة بترتيبها في الجدول.
- بعد كل تعديل أو إنشاء أو رفع فيه **تحقق**: الجدول بيتقرا تاني وبيتأكد إن السيشن موجودة بالعنوان والوقت الصح، أو إن الغياب بقى متاخد. أي اختلاف بيتكتب في التقرير كـ `failed` أو `verify_failed`.
- مقارنة العنوان في الـ Edit اتصلحت: كانت بتقارن عنوان الـ LMS ومعاه الوقت والجروب في أوله، فكانت بتلاقيه مختلف دايمًا وتعدّل كل سيشن في كل تشغيلة.
- الصف اللي في ملف الـ titles مش بيتشارك سيشن مع صف تاني في نفس التشغيلة: سيشنين في نفس اليوم بيفضلوا سيشنين، ولو صفين بيشاوروا على نفس السيشن في نفس اليوم والوقت بيتكتبوا في تقرير الـ UNMATCHED كـ conflict من غير أي تعديل.
- `DRY_RUN=true` مع `lms-bot/edit.py` بيطبع اللي هيتعدل أو يتعمل من غير ما يلمس الـ LMS. في آخر كل جروب بيتطبع وقته بالثواني.

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
├── group_roster_sync.js       # إضافة الطلاب الناقصين على groups.xlsx من الـ Dashboard
├── student_status.js          # حالة الطلاب على الـ Dashboard وتنضيف قايمة missing from wavz
├── exports_cleanup.js         # زرار Clean Exports: مسح ملفات الحضور اللي اترفعت
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
