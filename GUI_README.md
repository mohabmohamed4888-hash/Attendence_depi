# 📊 تطبيق تسجيل الحضور - DEPI Attendance Automation GUI

تطبيق desktop بواجهة جميلة لإدارة وتسجيل حضور الطلاب من لوحة DEPI.

## 🎯 المميزات

✅ واجهة رسومية جميلة وسهلة الاستخدام  
✅ تحديد نطاق التواريخ بسهولة  
✅ عرض السجل (Log) في الوقت الفعلي  
✅ حالة تشغيل فوري  
✅ إمكانية إيقاف العملية في أي وقت  

## 📦 المتطلبات

- **Node.js** v14 أو أحدث
- ملف `.env` يحتوي على بيانات المسؤول:
  ```
  LOGIN_EMAIL=your_email@example.com
  LOGIN_PASSWORD=your_password
  ```

## 🚀 التثبيت والتشغيل

### 1. تثبيت المكتبات المطلوبة

```bash
npm install
```

Electron سيتم تثبيته تلقائيًا من devDependencies.

### 2. تشغيل التطبيق

#### الوضع العادي:
```bash
npm start
```

#### وضع التطوير (مع DevTools):
```bash
npm run dev
```

## 📖 طريقة الاستخدام

### 1. **تعيين التواريخ:**
   - انقر على حقل "من تاريخ" واختر تاريخ البداية
   - انقر على حقل "إلى تاريخ" واختر تاريخ النهاية

### 2. **بدء العملية:**
   - انقر على زر "ابدأ العملية" ▶️
   - سيظهر السجل في الجزء الأيمن يعرض تقدم العملية

### 3. **المراقبة:**
   - راقب السجل لترى تقدم العملية
   - يمكنك رؤية الحالة الحالية في لوحة التحكم

### 4. **الإيقاف:**
   - اضغط على زر "إيقاف" ⏹️ لإيقاف العملية في أي وقت

### 5. **مسح السجل:**
   - اضغط على "مسح السجل" 🗑️ لحذف السجل

## 📂 هيكل المشروع

```
eyouth-Attendence/
├── main.js                 # عملية Electron الرئيسية
├── preload.js             # نسخة معلومات الأمان
├── run_attendance.js      # سكريبت تسجيل الحضور
├── package.json           # المكتبات والإعدادات
├── .env                   # بيانات المسؤول
└── src/
    ├── index.html         # واجهة المستخدم
    ├── app.js            # منطق الواجهة الأمامية
    └── styles.css        # تصميم الواجهة
```

## ⚙️ الإعدادات

### متغيرات البيئة (.env)

```env
# بيانات دخول DEPI
LOGIN_EMAIL=your_email@example.com
LOGIN_PASSWORD=your_password
```

### التواريخ الافتراضية

يتم تعيين التواريخ تلقائيًا عند فتح التطبيق:
- **من**: قبل 14 يومًا من اليوم الحالي
- **إلى**: اليوم الحالي

## 🔧 استكشاف الأخطاء

### المشكلة: لا يفتح التطبيق
**الحل:**
```bash
npm install
npm start
```

### المشكلة: خطأ في المصادقة
**التحقق من:**
1. بيانات `.env` صحيحة
2. اتصال الإنترنت متاح
3. حساب DEPI نشط

### المشكلة: العملية بطيئة
**الملاحظات:**
- قد تستغرق العملية وقتًا طويلًا حسب عدد الجلسات
- الانتظار ضروري لتحميل كل صفحة

## 📊 المخرجات

الملفات المُنتجة تُحفظ في مجلد `exports/`:

```
exports/
├── Technical groups/
│   ├── CSV Titles/
│   └── <GROUP_NAME>/
│       ├── attendance_data_1.csv
│       └── ...
├── Non Technical groups/
│   ├── CSV Titles/
│   └── <GROUP_NAME>/
│       └── ...
└── skipped_sessions_*.xlsx
```

## 🎨 المميزات البصرية

- 🌙 **الوضع الداكن**: واجهة أنيقة بألوان داكنة
- 📱 **تصميم متجاوب**: يعمل على شاشات مختلفة
- ⚡ **تحديثات فورية**: السجل يتحدث في الوقت الفعلي
- 🎭 **رموز تعبيرية**: واجهة ودية وسهلة الفهم

## 🤝 المساهمة

للمساهمة في تحسين التطبيق، يرجى:
1. إرسال تقارير الأخطاء
2. اقتراح مميزات جديدة
3. تحسين الأداء

## 📝 الترخيص

جميع الحقوق محفوظة © 2026 DEPI

## 📞 الدعم

في حالة واجهت مشاكل:
- تحقق من ملف `.env`
- تأكد من تثبيت npm packages
- جرب `npm run dev` لفتح المستكشف

---

**تم إنشاؤه بـ ❤️ لجعل تسجيل الحضور أسهل**

## متابعة الجروبات والسيشنات

افتح تبويب **Groups & sessions** لمتابعة Export ثم Check ثم Add / Sync ثم Upload.
يوجد شريط للتكنيكال وآخر للنون تكنيكال، وبحث وفلاتر للأخطاء والجروبات التي لا تحتوي
على ملفات حضور. اضغط على الجروب لعرض سيشناته. علامة النجاح في Upload تعني أن الحضور
تم التحقق منه على LMS أو كان موجودًا بالفعل، وليس مجرد انتهاء العملية.

زر **Retry this session** يظهر للأخطاء أو التشغيل المتوقف، ويتاح بعد توقف التشغيل
الحالي. يعيد فحص السيشن المحددة قبل استكمال العمل؛ إذا كان السبب ملفًا ناقصًا أو
بيانات غير صحيحة، أصلح السبب ثم أعد المحاولة. نتائج المتابعة تحفظ محليًا في
`exports/gui_progress.json`. **Check Missing** يفحص ويعرض النتائج فقط.

اختبارات المتابعة (بدون رفع بيانات حقيقية):

```bash
node --test tests/run_monitor.test.js tests/retry_ipc.test.js
python tests/test_retry_scope.py
node tests/monitor_gui.cjs
node tests/monitor_electron.cjs
```

### Full progress window

Click **Open full progress** beside the progress tabs to open a separate, maximized window. It shows the saved results and live updates from the current run, with Technical / Non-Technical filters, search, status filters, pagination, and Expand all / Collapse all controls. Sessions and verified Export / Check / Add-Sync / Upload steps are expanded automatically, including newly discovered groups and other pages. You can collapse individual groups or use Collapse all. Failed, retryable sessions have a **Retry this session** button; retry is disabled while another process is running. **Run controls** returns to the main window. Closing only the progress window leaves the run running.

You can also launch directly into this view with `npm start -- --progress`.

**Running now** stays visible at the top while scrolling. It shows active sessions and their current stage regardless of the selected page, search, track, or status filter. During group checks it lists the groups being scanned; when multiple operations run together it lists them all. Completed or stopped operations are removed from this panel.
