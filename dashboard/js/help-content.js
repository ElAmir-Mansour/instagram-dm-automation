/**
 * help-content.js — every Help Center article, in Arabic and in English.
 *
 * Kept apart from i18n.js on purpose. i18n.js is interface copy that every screen loads at
 * boot; this is long-form reading that only the Help Center needs, so help.js loads it on
 * demand (and index.html preloads it when the first URL is a help link).
 *
 * ─── Shape ──────────────────────────────────────────────────────────────────
 *   { slug, group, icon, title: { ar, en }, summary: { ar, en }, related: [slug],
 *     sections: [{ id, title: { ar, en }, body: { ar: [block], en: [block] } }] }
 *
 * Each language has its OWN body rather than a sentence-by-sentence translation: the Arabic
 * is written as Arabic, for creators, in Modern Standard Arabic (فصحى), never a dialect:
 * scripts/check-register.mjs (`npm run check:register`, in CI) fails on dialect words such as «وش», «اللي», «عشان».
 * Section ids are shared, so
 * `#/help/<slug>#<id>` lands on the same section in either language.
 *
 * A block is one of:
 *   'text'                                   a paragraph
 *   { h: '…' }                               a sub-heading inside a section (an h4 under the section's own h3)
 *   { ul: ['…'] }  { ol: ['…'] }            a list; `ol` is for steps done in order
 *   { code: '…', caption: '…' }              a command to copy, always left to right
 *   { tip: '…' }  { note: '…' }  { warn: '…' }   a callout
 *   { dl: [['term', 'what it means'], …] }   field-by-field lists and statuses
 *   { qa: [['question', answer], …] }       the FAQ and symptom → fix lists, where an
 *                                            answer is a string, a block, or a list of them
 *
 * Inline, inside any string: **bold** for the names of buttons and fields, `code` for file
 * names and commands, and [[slug]], [[slug#section]] or [[slug#section|label]] for a link to
 * another article. Strings are escaped BEFORE this markup is applied, so none of it can
 * inject HTML, and src/dashboard/help.test.ts checks that every [[link]] resolves.
 *
 * Button and field names are written exactly as the interface shows them, in the same
 * language, so a reader can match the article to the screen. When a label changes in
 * i18n.js, change it here too.
 */
const HelpContent = {
    /** The article list's groups, in order. */
    groups: [
        { id: 'start', title: { ar: 'البداية', en: 'Getting started' } },
        { id: 'meta', title: { ar: 'إنستجرام وفيسبوك', en: 'Instagram & Facebook' } },
        { id: 'growth', title: { ar: 'النمو والتسويق', en: 'Growth & reach' } },
        { id: 'tiktok', title: { ar: 'تيك توك', en: 'TikTok' } },
        { id: 'youtube', title: { ar: 'يوتيوب', en: 'YouTube' } },
        { id: 'whatsapp', title: { ar: 'واتساب', en: 'WhatsApp' } },
        { id: 'ads', title: { ar: 'الإعلانات', en: 'Ads' } },
        { id: 'studio', title: { ar: 'الاستوديو', en: 'Studio' } },
        { id: 'more', title: { ar: 'الذكاء الاصطناعي والحلول', en: 'AI, fixes and questions' } },
    ],

    /** Shown on the Help Center's front page. */
    popular: ['getting-started', 'worker', 'tiktok', 'campaigns', 'troubleshooting', 'faq'],

    articles: [
        // ─── 1. Getting started ──────────────────────────────────────────────
        {
            slug: 'getting-started',
            group: 'start',
            icon: 'rocket',
            title: { ar: 'ابدأ من هنا', en: 'Getting started' },
            summary: {
                ar: 'ماذا يفعل لك أوتوريبلاي برو، وكيف تجهّز حسابك في أول عشر دقائق.',
                en: 'What AutoReply Pro does for you, and how to set up your account in the first ten minutes.',
            },
            related: ['onboarding', 'connect-meta', 'campaigns', 'dm-assistant', 'studio'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'ماذا يفعل لك؟', en: 'What it does' },
                    body: {
                        ar: [
                            'أوتوريبلاي برو يرد على جمهورك في إنستجرام وفيسبوك بدلاً منك، وينشر محتواك في وقته، حتى وأنت مشغول أو نائم. يعمل على حسابك الرسمي عبر ميتا نفسها، من دون حيل ولا إضافات.',
                            { ul: [
                                '**ردود الكلمات المفتاحية:** متابع يكتب كلمة تحددها في التعليقات (مثل «سعر»)، فتصله رسالة خاصة فيها الرابط، ويرى رداً علنياً على تعليقه إن أحببت.',
                                '**مساعد الرسائل:** أي رسالة تصلك في الخاص يردّ عليها مساعد يعرف منتجك ويتكلم بأسلوبك، ويمكنك إيقافه في أي محادثة.',
                                '**الجدولة:** صورة أو فيديو أو ريل أو كاروسيل، على إنستجرام وفيسبوك معاً، ومعها تيك توك إذا ربطته.',
                                '**استوديو الكاروسيل:** يحوّل دروسك المصوّرة إلى منشورات كاروسيل جاهزة، بالنص والكلمة المفتاحية والرسالة الخاصة.',
                            ] },
                        ],
                        en: [
                            'AutoReply Pro answers your audience on Instagram and Facebook for you, and publishes your content on time, even while you are busy or asleep. It works on your real account through Meta’s own API: no tricks, no browser extensions.',
                            { ul: [
                                '**Keyword replies:** someone comments a word you choose (say, “price”), gets a private DM with your link, and sees a public reply under their comment if you want one.',
                                '**DM assistant:** messages that land in your inbox are answered by an assistant that knows your product and writes in your voice. You can pause it in any conversation.',
                                '**Post scheduling:** images, videos, reels and carousels, to Instagram and Facebook together, and to TikTok too once it is connected.',
                                '**Carousel Studio:** turns your recorded lessons into ready carousel posts, with the caption, the keyword and the DM written for you.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'first-10',
                    title: { ar: 'أول عشر دقائق', en: 'Your first ten minutes' },
                    body: {
                        ar: [
                            'عشر دقائق تكفي ليبدأ الحساب العمل عنك. امضِ فيها بالترتيب:',
                            { ol: [
                                'افتح **الإعدادات** وتأكد أن قسم **رمز الوصول** مكتوب فيه **صالح**. وإن رأيت تنبيه **صلاحيات ميتا ناقصة**، فالحل في [[connect-meta#token-health]].',
                                'اذهب إلى **الردود التلقائية** واضغط **ردّ تلقائي جديد**: اكتب الكلمة المفتاحية، ونص الرسالة الخاصة، ورداً علنياً قصيراً. وقبل أن تختار الكلمة اقرأ [[campaigns#matching|كيف تعمل المطابقة]].',
                                'جرّبها بنفسك: من حساب آخر علّق بالكلمة على أحد منشوراتك، وخلال ثوانٍ تصلك الرسالة في الخاص. وكل ما جرى تجده في **السجل**.',
                                'افتح **مساعد الرسائل**، فعّل **تشغيل الردّ الآلي**، واكتب في **الشخصية والتعليمات** من هو المساعد وكيف يتكلم. جرّبه في **اختبار المساعد** قبل أن يردّ على أي عميل.',
                                'من **الجدولة** اضغط **جدوِل منشوراً** وجرّب منشوراً بسيطاً. التفاصيل في [[scheduling]].',
                                'اختياري: اربط تيك توك من **الإعدادات** ← **اربط تيك توك**، واقرأ [[tiktok]] قبل أول منشور.',
                                'اختياري: إذا كان عندك كورس أو دروس مصوّرة، جهّز **الاستوديو**. البداية من [[studio]].',
                            ] },
                            { tip: 'أي علامة استفهام صغيرة بجانب زر في اللوحة تقودك إلى الشرح الخاص به هنا مباشرة.' },
                        ],
                        en: [
                            'Ten minutes is enough to get the account working for you. Go through these in order:',
                            { ol: [
                                'Open **Settings** and check that the **Access token** section says **Valid**. If you see **Missing Meta permissions**, the fix is in [[connect-meta#token-health]].',
                                'Go to **Keyword replies** and press **New keyword reply**: enter a keyword, the DM text and a short public reply. Before you pick the keyword, read [[campaigns#matching|how matching works]].',
                                'Test it yourself: from another account, comment the keyword on one of your posts. The DM arrives within seconds, and everything that happened shows up in the **Log**.',
                                'Open **DM assistant**, switch on **Turn on auto-replies**, and describe in **Voice and instructions** who the assistant is and how it talks. Try it in the **Assistant sandbox** before it answers a real customer.',
                                'In the **Scheduler**, press **Schedule a post** and try a simple one. The details are in [[scheduling]].',
                                'Optional: connect TikTok from **Settings** → **Connect TikTok**, and read [[tiktok]] before your first post.',
                                'Optional: if you have a course or recorded lessons, set up the **Studio**. Start with [[studio]].',
                            ] },
                            { tip: 'The small question-mark links next to buttons around the dashboard bring you straight to the right article here.' },
                        ],
                    },
                },
                {
                    id: 'tour',
                    title: { ar: 'جولة سريعة في القائمة', en: 'A quick tour of the menu' },
                    body: {
                        ar: [
                            { dl: [
                                ['نظرة عامة', 'ملخص اليوم، وأي شيء يحتاج انتباهك.'],
                                ['الردود التلقائية', 'الكلمات المفتاحية، ورسائلها الخاصة، وردودها العلنية.'],
                                ['جدولة المنشورات', 'طابور المنشورات المجدولة، والمنشور فعلياً على حساباتك.'],
                                ['الاستوديو', 'كاروسيل من دروسك، من الفكرة إلى الجدولة.'],
                                ['صندوق الرسائل', 'محادثات عملائك. كل محادثة تُفتح على أحدث رسالة، والرسائل الأقدم تظهر عندما تمرّر للأعلى. يمكنك أن ترد بنفسك، وأي رد يدوي يوقف الرد الآلي في تلك المحادثة.'],
                                ['مساعد الرسائل', 'شخصية المساعد، ومعلوماته، والنموذج، ومكان تجربته.'],
                                ['التحليلات', 'أداء الأتمتة بالأرقام.'],
                                ['النمو والتسويق', 'أرقام محتواك، وخطة مدرب النمو، وأدوات السيو.'],
                                ['السجل', 'كل تعليق ورسالة وحالتها، لحظة بلحظة.'],
                                ['الإعدادات', 'رمز الوصول، ورمز التحقق، وتيك توك، والمظهر واللغة.'],
                                ['المساعدة', 'هنا: كل الشروحات، بالعربية والإنجليزية.'],
                            ] },
                        ],
                        en: [
                            { dl: [
                                ['Overview', 'Today at a glance, and anything that needs your attention.'],
                                ['Keyword replies', 'Keywords, their DMs and their public replies.'],
                                ['Posts Scheduler', 'The queue of scheduled posts, and what is already live on your accounts.'],
                                ['Studio', 'Carousels made from your lessons, from the idea to the schedule.'],
                                ['DM Inbox', 'Your customer conversations. Each one opens at its newest message, and older messages load as you scroll up. You can reply yourself, and a manual reply pauses the AI in that conversation.'],
                                ['AI Settings', 'The assistant’s voice, what it knows, the model, and a sandbox to try it.'],
                                ['Analytics', 'How the automation is performing, in numbers.'],
                                ['Growth', 'How your content performs, the Growth Coach’s plan, and the SEO tools.'],
                                ['Log', 'Every comment and message and what happened to it, as it happens.'],
                                ['Settings', 'The access token, the webhook verify token, TikTok, appearance and language.'],
                                ['Help', 'You are here: every guide, in Arabic and English.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'today',
                    title: { ar: 'شاشة «اليوم»: ما هو بحاجة إليك', en: 'Today: what needs you' },
                    body: {
                        ar: [
                            'تبدأ شاشة **اليوم** بسطر واحد يجيب عن سؤال «هل يعمل كل شيء؟»: آخر تعليق وصل، وآخر رسالة خاصة، وهل تصل الأحداث من ميتا، وهل عامل الماك متصل. بعده تأتي البطاقات، وكل بطاقة فعل واحد ورابط يفتح هذه العناصر بالذات.',
                            'القائمة كلها يبنيها الخادم، فهي الرقم نفسه الذي تراه على شارة «الرسائل» وعلى «الجدولة». لا تحسب الشاشة شيئًا بنفسها.',
                            { dl: [
                                ['منشورات فشل نشرها', 'تحت البطاقة سطر لكل سبب مع عدده وعمره (أو تاريخه بالسنة إن لم يحن موعده بعد): قاعدة تيك توك، أو منشور استبدلته عمدًا (لا شيء لإصلاحه، أرشِفه)، أو مشكلة في الوسائط. «أرشِف هذه» تضعها في «المؤرشفة» بضغطة واحدة ومعها «تراجع».'],
                                ['فشل قديم', 'الفشل الذي مضى عليه أكثر من 14 يومًا يصبح سطرًا هادئًا بعدد فقط، لا بطاقة حمراء. يبقى محسوبًا في الجدولة حتى تؤرشفه.'],
                                ['محادثات تنتظرك', 'تبدأ البطاقة بمهلة الردّ كما في «الرسائل»: «آخر رسالة منذ 22 ساعة · المتبقي للردّ: ساعتان». يُحسب الوقت من آخر رسالة كتبها العميل، لا من لحظة تحويل المحادثة إليك. وإن كانت نافذة ميتا (24 ساعة) قد أُغلقت فلا يستطيع ردٌّ من هنا أن يصل إليها: ردّ من تطبيق إنستجرام، ثم اضغط «تم التعامل» لتُخرجها من قائمتك، وتعود من تلقاء نفسها إن كتب صاحبها مجددًا.'],
                            ] },
                            { tip: 'لا تسأل الشاشة «هل أنت متأكد؟»: كل إجراء يمكن التراجع عنه من الإشعار الذي يظهر بعده، والمشاهد لا يرى هذه الأزرار أصلًا.' },
                        ],
                        en: [
                            '**Today** opens with one line that answers “is it working?”: the last comment that came in, the last DM, whether events are arriving from Meta, and whether the Mac worker is online. The cards come after it, each with one verb and a link that opens exactly those items.',
                            'The whole list is built by the server, so it is the same number the **Inbox** badge and the **Scheduler** show. The screen counts nothing of its own.',
                            { dl: [
                                ['Posts that failed', 'Under the card there is one line per reason with its count and age (or its date, with the year, for one whose time is still ahead): a TikTok rule, a post you replaced on purpose (nothing to fix: archive it), a media problem. **Archive these** puts them under Archived in one tap, with an **Undo**.'],
                                ['Older failures', 'A failure more than 14 days old becomes one quiet line with a number, not a red card. It stays counted in the Scheduler until you archive it.'],
                                ['Conversations waiting for you', 'The card leads with the reply window, as the **Inbox** does: “Last message 22 hours ago · 2 hours left to reply”. It counts from the customer’s last message, not from when the chat was handed to you. When Meta’s 24-hour window has closed, a reply from here can no longer reach them: reply from the Instagram app, then **Mark handled** takes them off your list, and they come back by themselves if the person writes again.'],
                            ] },
                            { tip: 'Today never asks “are you sure?”: every action can be taken back from the notice that appears after it, and a viewer is not shown these buttons at all.' },
                        ],
                    },
                },
                {
                    id: 'roles',
                    title: { ar: 'من يستطيع فعل ماذا؟', en: 'Who can do what' },
                    body: {
                        ar: [
                            'في مساحة العمل ثلاثة أدوار. وإن كان دورك يقيّدك فسترى شارته أعلى الصفحة، فتعرف لماذا لا يعمل زر معيّن لك:',
                            { dl: [
                                ['مالك', 'كل شيء، ومنه ربط ميتا نفسه (رمز وصول الصفحة ورمز التحقق)، وربط تيك توك.'],
                                ['مشغّل', 'الردود التلقائية والمنشورات المجدولة والرسائل ومساعد الرسائل، من دون لمس رموز ميتا.'],
                                ['مُطّلع', 'قراءة فقط: الإحصاءات والردود التلقائية والمنشورات والرسائل، دون أي تعديل.'],
                            ] },
                            'ويمكنك تبديل لغة اللوحة بين العربية والإنجليزية من الزر أعلى الصفحة، أو من **الإعدادات** ← **المظهر واللغة**.',
                        ],
                        en: [
                            'An account has three roles. When yours limits you, its badge appears at the top of the page, so you know why a button refuses:',
                            { dl: [
                                ['Owner', 'Everything, including the Meta connection itself (the page access token and the webhook verify token) and connecting TikTok.'],
                                ['Operator', 'Keyword replies, scheduled posts, the inbox and the AI assistant, without touching the Meta tokens.'],
                                ['Viewer', 'Read only: stats, keyword replies, posts and messages, with no changes.'],
                            ] },
                            'You can switch the dashboard between Arabic and English with the button at the top of the page, or in **Settings** → **Appearance & language**.',
                        ],
                    },
                },
            ],
        },

        // ─── 1b. Joining a new workspace ─────────────────────────────────────
        {
            slug: 'onboarding',
            group: 'start',
            icon: 'user-plus',
            title: { ar: 'الانضمام إلى مساحة جديدة: الرابط والإعداد', en: 'Joining a new workspace: the link and the setup' },
            summary: {
                ar: 'الرابط الذي يصلك، وخطوات الإعداد بالترتيب (عنك، وأسلوبك، وهويتك، وحساباتك، والعيّنات)، وزر «عبّئها عني»، وماذا يجهز عند الانتهاء.',
                en: 'The link you receive, the setup steps in order (about you, your voice, your look, accounts, samples), the Fill it for me button, and what is ready when you finish.',
            },
            related: ['getting-started', 'connect-meta', 'campaigns', 'dm-assistant'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'كيف تبدأ مساحة جديدة', en: 'How a new workspace starts' },
                    body: {
                        ar: [
                            'المساحة الجديدة تبدأ برابط. من يدير المنصة ينشئ لك مساحتك ويرسل لك الرابط، غالباً على واتساب. تفتحه وتختار كلمة مرور، وبعدها إعداد قصير يسألك عنك وعن أسلوبك. وعند انتهاء الإعداد تنفتح لوحتك.',
                            { dl: [
                                ['الرابط', 'صفحة ترحّب بك في مساحتك وتطلب كلمة مرور: [[onboarding#invite]].'],
                                ['الإعداد', 'شاشات قصيرة: عنك، وأسلوبك، وهويتك، وحساباتك، وعيّنات ردود: [[onboarding#steps]].'],
                                ['لوحتك', 'ينتهي الإعداد بزر **إلى لوحتي**. وقبل ذلك يُرجَع مالك مساحة العمل إلى الإعداد من كل صفحة أخرى.'],
                            ] },
                            { note: 'يُتمّ الإعداد مالك مساحة العمل وحده. وإن ظهرت لك رسالة «إتمام الإعداد لمالك مساحة العمل وحده» فاطلب من المالك أن يفتحه، ويمكنك استخدام اللوحة في الأثناء.' },
                        ],
                        en: [
                            'A new workspace starts with a link. The person who runs the platform makes your workspace and sends you the link, usually on WhatsApp. You open it and choose a password, and a short setup asks about you and your voice. When the setup ends, your dashboard opens.',
                            { dl: [
                                ['The link', 'A page that welcomes you to your workspace and asks for a password: [[onboarding#invite]].'],
                                ['The setup', 'A few short screens: about you, your voice, your look, your accounts and some sample replies: [[onboarding#steps]].'],
                                ['Your dashboard', 'The setup ends with **Go to my dashboard**. Until then the workspace owner is sent back to the setup from every other page.'],
                            ] },
                            { note: 'Only the workspace owner can finish the setup. If you see “Only the workspace owner can finish the setup”, ask the owner to open it: you can use the dashboard in the meantime.' },
                        ],
                    },
                },
                {
                    id: 'invite',
                    title: { ar: 'رابط الدعوة', en: 'The invite link' },
                    body: {
                        ar: [
                            'الرابط يفتح صفحة لا تحتاج إلى حساب بعد. تقول لك «أهلًا بك في» مساحتك، ومن دعاك، والصفة التي تنضم بها (**مالك** أو **مشغّل** أو **مُطّلع**: [[getting-started#roles]]). وتطلب منك:',
                            { ul: [
                                'بريدك الإلكتروني. إن كان الرابط مصنوعاً لبريد معيّن فيكون مكتوباً ومقفلاً («هذه الدعوة مخصّصة لهذا البريد»)، وإلا فتكتبه أنت.',
                                '**اختر كلمة مرور** من 12 حرفاً على الأقل. و**اقترح لي كلمة مرور** تملأ لك كلمة قوية: احفظها في مدير كلمات المرور قبل أن تتابع.',
                                'علامة، مفعّلة من البداية، تبقيك مسجّلاً للدخول عدداً من الأيام (30 ما لم يحدد مسؤول المنصة غيرها).',
                            ] },
                            'اضغط **افتح مساحة عملي**. يُنشأ حسابك، وتدخل، ويفتح لك الإعداد.',
                            { dl: [
                                ['الرابط يعمل مرة واحدة', 'وتنتهي صلاحيته بعد 7 أيام ما لم يحدد مسؤول المنصة وقتاً آخر. والرابط الذي استُخدم، أو حلّ محله رابط أحدث، أو أُلغي، أو انتهى، يقول «هذا الرابط لم يعد صالحًا»: اطلب رابطاً جديداً ممن أرسله، أو سجّل الدخول إن كنت قد عيّنت كلمة مرور من قبل.'],
                                ['هل لديك حساب أصلاً؟', 'اضغط **لدي حساب بالفعل**، وسجّل الدخول، وتعرض عليك الصفحة إضافة المساحة الجديدة إلى حسابك.'],
                                ['رابط لتعيين كلمة مرور جديدة', 'شكله نفسه، لكن الصفحة تقول **عيّن كلمة مرور جديدة**، وهو يعمل مرة واحدة أيضاً.'],
                                ['هل فتحته داخل إنستجرام أو فيسبوك أو واتساب؟', 'هذه التطبيقات تفتح الروابط في متصفح صغير خاص بها، وربط حساباتك فيه لا يعمل جيداً: اضغط القائمة (…) واختر «فتح في المتصفح».'],
                            ] },
                            'وإن كنت أنت من يرسل الرابط: يتيح لك حوار الدعوة **انسخ الرابط** و**أرسل عبر واتساب**. والرابط يظهر مرة واحدة فقط، لحظة إنشائه. و**إنشاء رابط جديد** يصدر رابطاً آخر ويوقف القديم، و**إلغاء الرابط** يوقفه.',
                        ],
                        en: [
                            'The link opens a page that needs no account yet. It says “Welcome to” your workspace, who invited you, and the role you will join as (**Owner**, **Operator** or **Viewer**: see [[getting-started#roles]]). It asks for:',
                            { ul: [
                                'Your email address. When the link was made for one address, it is filled in and locked (“This invitation is for this address.”). Otherwise you type it.',
                                '**Choose a password** of at least 12 characters. **Suggest one** fills in a strong one: save it in your password manager before you continue.',
                                'A tick, on from the start, that keeps you signed in for a number of days (30 unless the platform administrator set another number).',
                            ] },
                            'Press **Open my workspace**. Your account is made, you are signed in, and the setup opens.',
                            { dl: [
                                ['A link works once', 'And it expires, after 7 days unless the platform administrator set another time. A link that was used, replaced by a newer one, revoked or expired says “This link is no longer valid”: ask whoever sent it for a new one, or, if you already set a password, sign in instead.'],
                                ['Already have an account?', 'Press **I already have an account**, sign in, and the page offers to add the new workspace to that account.'],
                                ['A link to set a new password', 'Looks the same, but the page says **Set a new password**, and it works once too.'],
                                ['Opened inside Instagram, Facebook or WhatsApp?', 'Those apps open links in a small browser of their own, where connecting your accounts works badly: tap the menu (…) and choose “Open in browser”.'],
                            ] },
                            'If you are the person sending the link, the invite dialog gives you **Copy link** and **Send on WhatsApp**. The link is shown only once, when you make it. **Regenerate** makes a new one and stops the old one, and **Revoke** stops it.',
                        ],
                    },
                },
                {
                    id: 'steps',
                    title: { ar: 'خطوات الإعداد بالترتيب', en: 'The setup, step by step' },
                    body: {
                        ar: [
                            'الإعداد سؤال بعد سؤال. وإجاباتك تُحفظ وأنت تكتب، فيمكنك إغلاق الصفحة والمتابعة لاحقاً من حيث توقفت. **التالي** يقدّمك، و**رجوع** يعيدك، والشاشتان الأوليان إلزاميتان ولا يمكن تخطّيهما. وفي الباقي **تخطَّ الآن**.',
                            { dl: [
                                ['عنك', 'إلزامية. «عرّفنا بنفسك»: **اسمك أو اسم نشاطك**، و**ماذا تفعل؟** (تعليم، أو تدريب واستشارات، أو متجر، أو خدمات، أو صناعة محتوى)، و**ما مجالك؟ سطر واحد**، و**أهم ما تقدّمه**، و**كيف يحصل عليه الناس؟** (**من رابط** وتكتب الرابط، أو **يراسلونني برسالة خاصة**)، و**السعر (اختياري)**، و**الدولة (اختياري)**، و**المنطقة الزمنية**، وتُحدَّد من جهازك وبها تُضبط مواعيد النشر. وفوق النموذج يقترح عليك **عبّئها عني** الإجابات: [[onboarding#draft]].'],
                                ['أسلوبك', 'إلزامية. «كيف تخاطب متابعيك؟»: الرسالة نفسها بخمس طرق (فصحى، وخليجي، ومصري، وشامي، والإنجليزية). اختر الأقرب لأسلوبك، وحتى ثلاث كلمات للنبرة. واضغط **هذا أسلوبي**.'],
                                ['هويتك', 'اختيارية. لونان (**اللون الرئيسي** و**لون التمييز**)، ونمط التصاميم (داكن أو فاتح)، ومعرّفك وموقعك وصورتك، مع معاينة. اضغط **اعتمد هذه الألوان**، أو **تخطَّ الآن**.'],
                                ['الحسابات', 'اختيارية، ولا تظهر إلا إن فعّل مسؤول المنصة الربط من هنا: [[onboarding#accounts]].'],
                                ['العيّنات', 'اختيارية. «هل يبدو هذا كلامك؟»: عيّنتا ردود مكتوبتان لتحكم عليهما: [[onboarding#samples]].'],
                                ['جاهز', '«كل شيء جاهز»: [[onboarding#after]].'],
                            ] },
                        ],
                        en: [
                            'The setup is one question at a time. Your answers are saved as you type, so you can close the page and carry on later from where you stopped. **Next** moves on and **Back** goes back. The first two screens are required and cannot be skipped; the others have **Skip for now**.',
                            { dl: [
                                ['About you', 'Required. “Tell us about you”: **Your name, or your business name**, **What do you do?** (teaching, coaching and advice, a shop, a service business or content creator), **What is it about? One line**, **Your main offer**, **How do people get it?** (**From a link**, and you write the link, or **They message me**), **Price (optional)**, **Country (optional)** and **Time zone**, which is found from your device and which posting times use. Above the form, **Fill it for me** can suggest the answers: [[onboarding#draft]].'],
                                ['Your voice', 'Required. “How do you talk to your followers?”: the same message in five ways (Standard Arabic, Gulf, Egyptian, Levantine and English). Pick the one closest to you, and up to three words for the tone. Press **This sounds like me**.'],
                                ['Your look', 'Optional. Two colours (**Main colour** and **Highlight colour**), a graphics style (dark or light), your handle, your website and your photo, with a preview. Press **Use these colours**, or **Skip for now**.'],
                                ['Accounts', 'Optional, and only there when the platform administrator has switched on connecting from here: [[onboarding#accounts]].'],
                                ['Samples', 'Optional. “Does this sound like you?”: two sample replies, written for you to judge: [[onboarding#samples]].'],
                                ['Done', '“All set”: [[onboarding#after]].'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'draft',
                    title: { ar: '«عبّئها عني»', en: 'Fill it for me' },
                    body: {
                        ar: [
                            'في أول شاشة، **عبّئها عني** يقرأ صفحاتك العامة ويقترح عليك الإجابات، فتكتب أقل. اكتب اسم حسابك في **حسابك على إنستجرام** وعنوان موقعك في **موقعك**، واضغط **عبّئها عني**.',
                            { ul: [
                                'يقرأ ما هو عام فقط: ملفك في إنستجرام (النبذة وبعض منشوراتك)، وموقعك (صفحته الرئيسية وبعض الصفحات التي تشير إليها قائمته)، وقناتك على يوتيوب إذا كانت متصلة بالمساحة. ولا ينشر ولا يغيّر أي شيء.',
                                'يستغرق لحظات: يقرأ («نقرأ حساباتك…») ثم يكتب («نكتب الاقتراحات…»). وإن تعثّر يعيد المحاولة من تلقاء نفسه. ولا يلزمك الانتظار: **ابدأ دون انتظار** يطوي اللوحة في سطر وتبقى لك الاستمارة، وتظهر الاقتراحات عندما تجهز.',
                                'عندما يجهز، يعرض **هذا ما وجدناه** اقتراحاً تحت كل خانة فارغة، ومن أين جاء («من نبذتك على إنستجرام»، أو «من أحد منشوراتك»، أو «من موقعك»، أو «من قناتك على يوتيوب»). اضغط **استخدم هذا** ليدخل النموذج، أو **ليس هذا** ليُترك. والاقتراح الذي عليه «راجع هذا الاقتراح قبل استخدامه» وضعه المدقق للمراجعة: اقرأه مرتين.',
                                'لا يكتب فوق شيء كتبته أنت، ولا يُحفظ شيء حتى تضغط **التالي**.',
                                'يمكنك طلب الاقتراحات 5 مرات في اليوم. بعدها يقول «طلبت اقتراحات كثيرة اليوم»: عبّئ النموذج بنفسك، أو جرّب غداً.',
                                'وإن لم يكن الذكاء الاصطناعي مفعّلاً في المنصة، يقول إنه سيملأ هذا لاحقاً ويعرض ما وجده من دونه (المعرّف والموقع والألوان).',
                            ] },
                        ],
                        en: [
                            'On the first screen, **Fill it for me** reads your public pages and suggests answers, so you type less. Type your account name in **Your Instagram** and your site in **Your website**, and press **Fill it for me**.',
                            { ul: [
                                'It reads only what is public: your Instagram profile (your bio and some of your posts), your website (its home page and a few pages its menu points to), and your YouTube channel when YouTube is connected to the workspace. It never posts or changes anything.',
                                'It takes a moment: it reads (“Reading your accounts…”) and then writes (“Writing suggestions…”). If something slows it down it tries again by itself. You do not have to wait: **Start without waiting** folds the panel into one line and the form is yours, and the suggestions appear when they are ready.',
                                'When it is ready, **Here is what we found** shows a suggestion under each empty field, and where it came from (“From your Instagram bio”, “From one of your posts”, “From your website” or “From your YouTube channel”). Press **Use this** to put it in the form, or **Not this** to leave it. A suggestion marked “Please check this one before you use it.” is one the checker flagged: read it twice.',
                                'It never writes over what you typed, and nothing is saved until you press **Next**.',
                                'You can ask for suggestions 5 times a day. After that it says “You have asked for enough suggestions today”: fill in the form yourself, or try again tomorrow.',
                                'If the platform has no AI switched on yet, it says it will fill this in later and shows what it found without it (the handle, the site, your colours).',
                            ] },
                        ],
                    },
                },
                {
                    id: 'accounts',
                    title: { ar: 'ربط الحسابات', en: 'Connecting your accounts' },
                    body: {
                        ar: [
                            'شاشة **اربط حساباتك** فيها ثلاث بطاقات: إنستجرام وفيسبوك، وتيك توك، ويوتيوب. ولا تظهر إلا إذا فعّل مسؤول المنصة الربط من هنا («Connect with Facebook»). ومن دونها لا شيء عليك هنا: من دعاك يربط حساباتك عنك، بعد أن تمنحه صلاحية الوصول إلى صفحتك في Meta Business Suite (الإعدادات ثم الأشخاص).',
                            { ol: [
                                'اضغط **اربط** في بطاقة **إنستجرام وفيسبوك** واختر الصفحة المرتبطة بها حساب إنستجرام.',
                                'تيك توك ويوتيوب اختياريان: اربطهما الآن أو لاحقاً من الإعدادات.',
                                'تحقق اختياري: اطلب من صديق أن يكتب تعليق «test» على آخر منشور لك، من حساب آخر. وتقول الصفحة «وصل التعليق. التعليقات تصل إلى حسابك.» عندما يصل، وتنتظره 10 دقائق، ويمكنك الضغط على **تحقّق مجددًا**.',
                            ] },
                            'ويمكنك تخطي الشاشة كلها والربط لاحقاً من **الإعدادات** ← **الاتصالات**: [[connect-meta]].',
                        ],
                        en: [
                            '**Connect your accounts** shows three cards: Instagram & Facebook, TikTok and YouTube. It is only there when the platform administrator has switched on connecting from here (“Connect with Facebook”). Without it you do nothing here: the person who invited you connects your accounts for you, once you give them access to your Page in Meta Business Suite (Settings, then People).',
                            { ol: [
                                'Press **Connect** on the **Instagram & Facebook** card and choose the Page linked to your Instagram account.',
                                'TikTok and YouTube are optional: connect them now, or later in Settings.',
                                'An optional check: ask a friend to comment “test” on your latest post, from another account. The page says “Got it. Comments reach your account.” when it arrives. It waits for 10 minutes, and you can **Check again**.',
                            ] },
                            'You can skip the whole screen and connect later in **Settings** → **Connections**: [[connect-meta]].',
                        ],
                    },
                },
                {
                    id: 'samples',
                    title: { ar: 'عيّنات الردود', en: 'The sample replies' },
                    body: {
                        ar: [
                            '**هل يبدو هذا كلامك؟** يعرض عيّنتين كُتبتا من إجاباتك بالكتّاب أنفسهم الذين يستخدمهم التطبيق لاحقاً:',
                            { dl: [
                                ['نص منشور على إنستجرام', 'نص جديد بأسلوبك.'],
                                ['ردود التعليقات الأولى', 'ماذا يحدث عندما يعلّق أحد بكلمتك: **الرسالة الخاصة** و**الرد العلني**.'],
                            ] },
                            'احكم على كل واحدة: **يشبهني** أو **ليس تمامًا**. ومع «ليس تمامًا» اختر ما الخطأ (**رسمي أكثر من اللازم**، أو **طويل**، أو **معلومة خاطئة**، أو **سأعدّله بنفسي**) فيكتبها التطبيق من جديد. أو اكتب نسختك في **نسختك** واضغط **احفظ نسختي**.',
                            { ul: [
                                'كل عيّنة تُكتب من جديد حتى 3 مرات، والعيّنات تُكتب 3 مرات في اليوم.',
                                'ما تعتمده أو تعدّله يصبح مثالاً على أسلوبك يستخدمه الكتّاب بعد ذلك، وعيّنة التعليقات تصبح أيضاً أول رد تلقائي لك (القسم التالي).',
                                'هذه عيّنات فقط: لا يُنشر شيء ولا يُرسل إلى أحد.',
                                'وإن لم يكن في المنصة مفتاح ذكاء اصطناعي، تقول الخطوة «العيّنات تحتاج مفتاح ذكاء اصطناعي»، ويمكنك المتابعة: كل شيء آخر يعمل.',
                            ] },
                        ],
                        en: [
                            '**Does this sound like you?** shows two samples, written from your answers by the same writers the app uses later:',
                            { dl: [
                                ['An Instagram caption', 'A new caption in your voice.'],
                                ['Your first comment replies', 'What happens when someone comments your keyword: **The private message** and **The public reply**.'],
                            ] },
                            'Judge each one: **Sounds like me**, or **Not quite**. With “Not quite”, pick what is off (**Too formal**, **Too long**, **Wrong information** or **I’ll edit it myself**) and the app writes it again. Or type your own version in **Your version** and press **Save my version**.',
                            { ul: [
                                'Each sample can be written again up to 3 times, and samples can be written 3 times a day.',
                                'What you approve or edit becomes an example of your voice, which the writers use from then on, and the comment sample also becomes your first keyword reply (the next section).',
                                'These are samples only: nothing is posted and nothing is sent to anyone.',
                                'If the platform has no AI key, the step says “Samples need an AI key”, and you can carry on: everything else works.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'after',
                    title: { ar: 'عند الانتهاء', en: 'When you finish' },
                    body: {
                        ar: [
                            'آخر شاشة، **كل شيء جاهز**، تقول لك ما الجاهز وما الذي ينتظر:',
                            { dl: [
                                ['جاهز', 'اسمك وعرضك وأسلوبك وهويتك محفوظة.'],
                                ['ردود التعليقات', 'تعمل عندما يُربط إنستجرام. ويمكنك ربطه في أي وقت من الإعدادات.'],
                                ['نماذج ردود بأسلوبك', 'ما اعتمدته يوجّه ما يُكتب لك. وإن تخطيتها فكل شيء يبدأ من ملفك.'],
                                ['أول رد تلقائي على التعليقات', 'كُتب وهو متوقف. شغّله من **الردود التلقائية** بعد ربط إنستجرام.'],
                                ['قواعد المحتوى', 'القواعد التي تنطبق على ما يُكتب لك. تبدأ من الافتراضي للحسابات الجديدة، ويمكنك إزالة العلامة عمّا لا يناسبك بزر **تغيير**.'],
                            ] },
                            'اضغط **إلى لوحتي**. ويُنشأ أول رد تلقائي مرة واحدة عند إنهاء الإعداد، من عيّنتك المعتمدة (أو من الصياغة المعتادة باسم عرضك ورابطه)، ولا يُنشأ إلا إذا وُجد عرض وكلمة ورسالة تُرسل. ويُنشأ متوقفاً لأنه لا يجوز أن يُراسَل ناسٌ حقيقيون قبل أن تشغّله أنت.',
                            { tip: 'جرّبه من حساب آخر قبل أن تشغّله: علّق بكلمته على أحد منشوراتك: [[campaigns#how]].' },
                        ],
                        en: [
                            'The last screen, **All set**, says what is ready and what is waiting:',
                            { dl: [
                                ['Ready', 'Your name, offer, voice and look are saved.'],
                                ['Comment replies', 'They switch on when Instagram is connected. You can connect it at any time in Settings.'],
                                ['Sample replies in your voice', 'What you approved guides what is written for you. If you skipped them, everything still starts from your profile.'],
                                ['Your first comment keyword reply', 'It is written and switched off. Turn it on in **Keyword replies** once Instagram is connected.'],
                                ['Content rules', 'The rules that apply to what is written for you. They start from the default for new accounts, and you can untick one that does not suit you with **Change**.'],
                            ] },
                            'Press **Go to my dashboard**. The first keyword reply is made once, when the setup ends, from your approved sample (or from the standard wording with your offer’s name and link), and only if there is an offer, a keyword and a message to send. It is made switched off because nobody real may be messaged until you turn it on.',
                            { tip: 'Try it from a second account before you turn it on: comment its keyword on one of your posts: [[campaigns#how]].' },
                        ],
                    },
                },
                {
                    id: 'troubleshooting',
                    title: { ar: 'عندما يتوقف شيء', en: 'When something stops' },
                    body: {
                        ar: [
                            { qa: [
                                ['«هذا الرابط لم يعد صالحًا»', 'اطلب رابطاً جديداً ممن أرسله لك، أو سجّل الدخول إن كنت قد عيّنت كلمة مرور من قبل: [[onboarding#invite]].'],
                                ['«محاولات كثيرة» في صفحة الدعوة', 'انتظر عدد الثواني المكتوب وحاول من جديد.'],
                                ['«ما زالت بعض الإجابات ناقصة»', 'يجب أن تحتوي الشاشتان الأوليان على كل الخانات الإلزامية: أكملها لتنهي الإعداد.'],
                                ['«حدّث شخص آخر هذه البيانات أثناء تعديلك»', 'حمّلنا لك النسخة الأحدث (غالباً يعبّئها معك مسؤول المنصة). راجعها ثم تابع.'],
                                ['لم تصل الاقتراحات', 'اضغط **ابدأ دون انتظار** وعبّئ النموذج، أو أعد المحاولة: إن قالت الصفحة «تعذّر إعداد الاقتراحات هذه المرة» فجرّب مرة أخرى أو عبّئ بنفسك.'],
                                ['العيّنات تقول إنها تحتاج مفتاح ذكاء اصطناعي', 'على مسؤول المنصة أن يضيف مفتاحاً. تابع من دونها: كل شيء آخر يعمل.'],
                                ['أغلقت الصفحة في منتصف الإعداد', 'افتح رابط اللوحة وسجّل الدخول: يكمل الإعداد من حيث توقفت، وإجاباتك محفوظة.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['“This link is no longer valid”', 'Ask whoever sent it for a new link, or, if you already set a password, sign in instead: [[onboarding#invite]].'],
                                ['“Too many attempts” on the invite page', 'Wait the number of seconds it says and try again.'],
                                ['“A few answers are still missing”', 'The first two screens need every required field. Fill them in to finish the setup.'],
                                ['“Someone updated this while you were editing”', 'The newer version was loaded for you (often the platform administrator filling in with you). Check it, then continue.'],
                                ['The suggestions never came', 'Press **Start without waiting** and fill in the form yourself. If the page says “We could not make suggestions this time”, try again or fill it in yourself.'],
                                ['The samples say they need an AI key', 'The platform administrator has to add one. Carry on without them: everything else works.'],
                                ['I closed the page in the middle of the setup', 'Open the dashboard address and sign in: the setup resumes where you stopped, and your answers are kept.'],
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 2. Connect Instagram & Facebook ─────────────────────────────────
        {
            slug: 'connect-meta',
            group: 'meta',
            icon: 'plug-zap',
            title: { ar: 'ربط إنستجرام وفيسبوك', en: 'Connect Instagram & Facebook' },
            summary: {
                ar: 'ما الذي يحتاجه الربط، وأين تجده في الإعدادات، وكيف تتأكد أن رمز الوصول سليم.',
                en: 'What the connection needs, where it lives in Settings, and how to tell the access token is healthy.',
            },
            related: ['campaigns', 'troubleshooting', 'getting-started', 'whatsapp'],
            sections: [
                {
                    id: 'needs',
                    title: { ar: 'ماذا تحتاج؟', en: 'What you need' },
                    body: {
                        ar: [
                            { ul: [
                                'حساب إنستجرام **احترافي** (حساب أعمال أو صانع محتوى)، وليس حساباً شخصياً.',
                                'صفحة فيسبوك مرتبطة بحساب إنستجرام هذا.',
                                '**رمز وصول للصفحة** (Page Access Token) من ميتا، فيه الصلاحيات المطلوبة. الأفضل أن يكون رمزاً دائماً لا ينتهي.',
                                'دور **مالك** في مساحة العمل هنا، لأن المالك وحده يستطيع تغيير رموز ميتا.',
                            ] },
                            { note: 'تطبيق ميتا نفسه ورابط الويبهوك يجهّزهما مدير المنصة مرة واحدة للجميع. وما يخصك أنت: رمز صفحتك وصلاحياته.' },
                        ],
                        en: [
                            { ul: [
                                'An Instagram **professional** account (Business or Creator), not a personal one.',
                                'A Facebook Page connected to that Instagram account.',
                                'A **Page Access Token** from Meta with the right permissions. A permanent, never-expiring token is best.',
                                'The **Owner** role in this account, because only owners can change the Meta tokens.',
                            ] },
                            { note: 'The Meta app itself and the webhook address are set up once, for everyone, by the platform administrator. What is yours to manage is your Page token and its permissions.' },
                        ],
                    },
                },
                {
                    id: 'where',
                    title: { ar: 'أين أجده في الإعدادات؟', en: 'Where it lives in Settings' },
                    body: {
                        ar: [
                            'كل شيء في صفحة **الإعدادات**:',
                            { dl: [
                                ['رمز الوصول', 'حالة الرمز، ونوعه، ومتى ينتهي، وصلاحياته. ومنه تلصق رمزاً جديداً في **تحديث رمز الوصول** وتضغط **تحقّق واحفظ**. يُفحص الرمز عند ميتا قبل أن يُحفظ، ويُخزَّن مشفّراً.'],
                                ['رمز التحقق للويبهوك', 'كلمة سرية تخترعها أنت وتكتبها بالشكل نفسه في تطبيق ميتا. ميتا تفحصها فقط عندما يُنشأ اشتراك أو يتغيّر رابطه، والحفظ هنا بـ**احفظ رمز التحقق** يعمل في الحال.'],
                                ['بيانات الحساب', 'معرّف صفحة إنستجرام وفيسبوك، وحالة الحساب، و**عنوان الويبهوك** الذي تحتاجه ميتا.'],
                            ] },
                        ],
                        en: [
                            'Everything is on the **Settings** page:',
                            { dl: [
                                ['Access token', 'The token’s status, type, expiry date and permissions. To replace it, paste a new one into **Update access token** and press **Validate & save**. The token is checked with Meta before it is saved, and stored encrypted.'],
                                ['Webhook verify token', 'A secret you make up and type identically into the Meta app. Meta only checks it when a subscription is created or its callback URL changes, and saving it here with **Save verify token** takes effect at once.'],
                                ['Account info', 'The Instagram and Facebook page IDs, the account status, and the **Webhook URL** Meta needs.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'token-health',
                    title: { ar: 'صحة رمز الوصول', en: 'Token health' },
                    body: {
                        ar: [
                            'أعلى قسم **رمز الوصول** شارة تقول لك الحالة:',
                            { dl: [
                                ['صالح', 'كل شيء على ما يرام.'],
                                ['غير صالح أو منتهٍ', 'ستتوقف الردود والنشر. الصق رمزاً جديداً واضغط **تحقّق واحفظ**.'],
                                ['ينتهي: أبداً (رمز طويل الأمد)', 'هذا الأفضل. وإن رأيت تاريخ انتهاء بدلاً منها، اضغط **مدّد إلى رمز دائم**. يبقى الرمز القديم يعمل، لأن ميتا لا تلغيه عند إصدار الجديد.'],
                                ['صلاحيات ميتا ناقصة', 'تنبيه أعلى الصفحة يسمّي الصلاحية الناقصة. ومن دونها تفشل بعض الردود من دون أن تنتبه.'],
                            ] },
                            'الصلاحيات الأساسية، وما فائدة كل واحدة:',
                            { dl: [
                                ['`instagram_manage_comments`', 'قراءة تعليقات إنستجرام والرد عليها.'],
                                ['`instagram_manage_messages`', 'أتمتة رسائل إنستجرام.'],
                                ['`instagram_content_publish`', 'نشر وجدولة منشورات إنستجرام.'],
                                ['`pages_manage_engagement`', 'الرد على تعليقات فيسبوك.'],
                                ['`pages_messaging`', 'رسائل ماسنجر.'],
                            ] },
                            { warn: 'حتى الرمز الدائم له حد: توقف ميتا **الوصول للبيانات** بعد 90 يوماً من آخر مرة أكّدت فيها الصلاحيات، ويبقى مكتوباً على الرمز **صالح**. وإن توقفت الردود فجأة بلا سبب واضح، فأصدر الرمز من جديد من ميتا والصقه هنا.' },
                        ],
                        en: [
                            'A badge at the top of the **Access token** section tells you where things stand:',
                            { dl: [
                                ['Valid', 'All good.'],
                                ['Invalid / expired', 'Replies and publishing will stop. Paste a new token and press **Validate & save**.'],
                                ['Expires: never (long-lived)', 'The best case. If you see a date instead, press **Extend to never-expiring**. The old token keeps working, because Meta does not revoke it when it issues a new one.'],
                                ['Missing Meta permissions', 'A warning at the top of the page naming what is missing. Without it, some replies fail quietly.'],
                            ] },
                            'The core permissions, and what each one is for:',
                            { dl: [
                                ['`instagram_manage_comments`', 'Reading Instagram comments and replying to them.'],
                                ['`instagram_manage_messages`', 'Instagram DM automation.'],
                                ['`instagram_content_publish`', 'Publishing and scheduling Instagram posts.'],
                                ['`pages_manage_engagement`', 'Replying to Facebook comments.'],
                                ['`pages_messaging`', 'Messenger replies.'],
                            ] },
                            { warn: 'Even a permanent token has a limit: Meta lapses **data access** 90 days after you last re-confirmed the permissions, while the token still reads **Valid**. If replies stop for no visible reason, issue a fresh token in Meta and paste it here.' },
                        ],
                    },
                },
                {
                    id: 'check',
                    title: { ar: 'تأكد أن الربط يعمل', en: 'Check the connection works' },
                    body: {
                        ar: [
                            { ol: [
                                'بجانب **رمز الوصول** مكتوب **صالح**، ولا يوجد تنبيه صلاحيات ناقصة.',
                                'من حساب آخر، علّق بكلمة رد تلقائي مفعّل، وتأكد أن الرسالة وصلت.',
                                'افتح **النتائج** ثم **السجل**: كل تعليق طابق ردّاً تلقائياً يظهر هنا مع ما انتهت إليه رسالته (وصلت، بحاجة إليك، مقصود، قيد الانتظار، رسائله مغلقة).',
                            ] },
                            { note: 'التعليق الذي لا يطابق أي رد تلقائي لا يُسجَّل أصلاً. أي أن غيابه من السجل ليس دليلاً على أن الربط معطّل؛ تأكد من الكلمة أولاً.' },
                        ],
                        en: [
                            { ol: [
                                'The **Access token** reads **Valid**, with no missing-permissions warning.',
                                'From another account, comment the keyword of an active keyword reply and check the DM arrives.',
                                'Open **Results**, then **Log**: every comment that matched a keyword reply is listed with what became of its DM (Delivered, Needs you, By design, Waiting, DMs closed).',
                            ] },
                            { note: 'A comment that matches no keyword reply is not recorded at all, so its absence from the log does not mean the connection is broken. Check the keyword first.' },
                        ],
                    },
                },
                {
                    id: 'events-destination',
                    title: { ar: 'إلى أين ترسل ميتا أحداثك؟', en: 'Where Meta sends your events' },
                    body: {
                        ar: [
                            'كل نوع من الأحداث في ميتا (إنستجرام، صفحة فيسبوك، واتساب) له عنوان واحد يصل إليه، وهذا إعداد لتطبيق ميتا كله، لا لحسابك وحدك. فإن كان مشروع آخر يستخدم التطبيق نفسه ووجّه نوعاً منها إلى موقعه، تذهب كل أحداث ذلك النوع إلى هناك، ولا يسمع AutoReply شيئاً.',
                            { warn: 'كلمة **متصل** لا تكفي دليلاً. يبقى رمز الوصول صالحاً، ويبقى الربط يعمل، ولا يظهر أي خطأ، لكن الأحداث لا تصل. وزر **اختبر التحقق** في **متقدم** يسأل جهة AutoReply وحدها، ولا يخبرك أين تذهب الأحداث.' },
                            { h: 'ماذا تعرض البطاقة' },
                            'افتح **الإعدادات** ← **المنصة** ← **إلى أين ترسل ميتا أحداثك**. البطاقة لمدير المنصة وحده، وتقرأ ميتا لحظة فتحها. فيها صف لكل نوع، وكل صف يقول أين يذهب هذا النوع:',
                            { dl: [
                                ['AutoReply', 'النوع يصل إلى عنوان AutoReply، وهذا المطلوب.'],
                                ['موقع آخر: …', 'ميتا ترسل هذا النوع إلى موقع غير AutoReply، ويظهر اسم الموقع. وإن كان النوع إنستجرام أو صفحة فيسبوك فهذا هو العطل نفسه.'],
                                ['متوقف', 'الاشتراك موجود لكن ميتا أوقفته، فلا يُرسَل شيء.'],
                                ['أحداث ناقصة', 'العنوان صحيح لكن ينقصه حدث مطلوب، مثل التعليقات أو الرسائل في إنستجرام.'],
                                ['غير مشترك', 'ليس عند ميتا اشتراك لهذا النوع أصلاً.'],
                            ] },
                            'وتحت كل صف الأحداث المشترك فيها، وتنبيه إن نقص حدث، وآخر مرة وصل فيها حدث من هذا النوع إلى هذه المساحة بالذات. هذا السطر الأخير هو ما يفرّق بين منصة هادئة ومنصة أحداثها ذاهبة إلى مكان آخر.',
                            { note: 'نوع ليس فيه أحداث مشترك فيها (مثل user) ويشير إلى موقع آخر: تنبيه بسيط فقط، وليس عطلاً.' },
                            { h: 'الزر' },
                            'زر **أرسل كل شيء إلى AutoReply** يعيد الأنواع الخاطئة إلى عنوان AutoReply. قبل أي تغيير يفتح سؤالاً يسرد بالضبط ما الذي سيتغيّر، ولا يُرسَل شيء قبل موافقتك. وهو يغيّر هذا فقط:',
                            { ul: [
                                'نوعاً يذهب إلى موقع آخر: يعود إلى عنوان AutoReply بأحداثه نفسها.',
                                'نوعاً متوقفاً: يعمل من جديد.',
                                'نوعاً ينقصه حدث مطلوب: يضيف الحدث، ويبقي كل ما كان مشتركاً فيه.',
                                'نوعاً يلزمه اشتراك وليس عنده: ينشئه.',
                            ] },
                            'ولا يلمس نوعاً سليماً. بعدها يقرأ ميتا من جديد ويعرض الحالة كما هي الآن، ثم يفحص صفحاتك المتصلة ويعيد الاشتراك فقط للصفحة التي ليس فيها AutoReply أو ينقصها حدث. ويسجّل العملية في سجل التدقيق بلا أي رمز. وإن كان كل شيء سليماً يصبح الزر معطّلاً ومكتوباً عليه **كل شيء يصل إلى AutoReply بالفعل**.',
                            { warn: 'لميتا عنوان واحد لكل نوع، فأي موقع آخر يستخدم هذا التطبيق يتوقف عنده النوع الذي أرجعته. هذا هو المقصود، لكن اعرفه قبل أن تضغط.' },
                            { note: 'ميتا تتصل بعنوانك وتفحص رمز التحقق وقت التغيير. وإن لم يكن هناك رمز محفوظ تخبرك البطاقة: احفظه في **الإعدادات** ← **متقدم**. الشرح في [[connect-meta#where]].' },
                            { h: 'وكيف تعرف من دون فتح البطاقة' },
                            'AutoReply يقرأ ميتا مرة كل ساعة تقريباً ويحفظ الجواب. فإن وجد مشكلة:',
                            { ul: [
                                'يظهر تنبيه أحمر في **اليوم** وشريط فوق قائمة **الرسائل**، يقولان أي نوع يذهب إلى أي موقع وماذا لن يردّ عليه AutoReply. ومدير المنصة معه زر يفتح البطاقة، وغيره يُقال له أن يسأل مالك المنصة.',
                                'ويصلك تنبيه على البريد وتيليجرام (إن فعّلتهما من **الإعدادات**) مرة في اليوم لكل مشكلة، بالعربية ثم الإنجليزية، وفيه رابط البطاقة. وإن لم يُرسَل التنبيه فسيجرّب مرة أخرى في الفحص التالي.',
                                'وبعد أن تضغط الزر تختفي التنبيهات في الحال، لأن النتيجة تُحفظ من القراءة الأخيرة.',
                            ] },
                            { note: 'زر **افحص من جديد** في البطاقة يقرأ ميتا في الحال بدل أن تنتظر الساعة.' },
                        ],
                        en: [
                            'Meta delivers each kind of event (Instagram, a Facebook Page, WhatsApp) to one address, and that is a setting of the Meta app as a whole, not of your account. So if another project that uses the same app points one kind at its own site, every event of that kind goes there, and AutoReply hears nothing.',
                            { warn: '**Connected** is not enough to go on. The access token stays valid, the connection stays up and no error appears: the events just never arrive. And **Test the handshake** in **Advanced** asks AutoReply’s side only: it does not say where Meta sends your events.' },
                            { h: 'What the card shows' },
                            'Open **Settings** → **Platform** → **Where Meta sends your events**. The card is for the platform administrator, and it reads Meta the moment it opens. It has a row for each kind, saying where that kind goes:',
                            { dl: [
                                ['AutoReply', 'This kind reaches AutoReply’s address, which is what you want.'],
                                ['Another website: …', 'Meta sends this kind to a site that is not AutoReply, and the card names it. For Instagram or a Facebook Page this is the fault itself.'],
                                ['Switched off', 'The subscription exists but Meta has switched it off, so nothing is sent.'],
                                ['Missing events', 'The address is right but an event it needs is not subscribed, such as comments or messages on Instagram.'],
                                ['Not subscribed', 'Meta has no subscription for this kind at all.'],
                            ] },
                            'Under each row are the events it is subscribed to, a warning when one is missing, and when an event of that kind last reached this workspace. That last line is what tells a quiet platform from one whose events go somewhere else.',
                            { note: 'A kind with no events subscribed (such as user) that points at another site is a mild warning, not a fault.' },
                            { h: 'The button' },
                            '**Send everything to AutoReply** puts the wrong kinds back on AutoReply’s address. Before it changes anything it opens a question listing exactly what will change, and nothing is sent until you agree. It changes only this:',
                            { ul: [
                                'A kind that goes to another website: it goes back to AutoReply’s address with the events it had.',
                                'A kind that is switched off: it is switched back on.',
                                'A kind that lacks an event it needs: the event is added, and everything it was subscribed to stays.',
                                'A kind AutoReply needs that has no subscription: it is created.',
                            ] },
                            'It does not touch a kind that is fine. Afterwards it reads Meta again and shows how things stand now, then checks your connected Pages and subscribes again only a Page that does not list AutoReply or lacks an event. The change is recorded in the audit log, with no token in it. When everything is fine the button is disabled and reads **Everything already goes to AutoReply**.',
                            { warn: 'Meta has one address per kind, so any other website that uses this app stops receiving the kind you put back. That is the point, but know it before you press.' },
                            { note: 'Meta calls your address and checks the verify token while it makes the change. If none is saved the card tells you: save one in **Settings** → **Advanced**. It is explained in [[connect-meta#where]].' },
                            { h: 'How you find out without opening the card' },
                            'AutoReply reads Meta about once an hour and keeps the answer. If it finds a problem:',
                            { ul: [
                                'A red alert appears on **Today** and a strip above the **Inbox** list, saying which kind goes to which site and what AutoReply therefore cannot answer. The platform administrator gets a button that opens the card; everyone else is told to ask the platform owner.',
                                'You get a message by email and Telegram (if you switched them on in **Settings**) once a day for each problem, in Arabic and then English, with a link to the card. If it could not be sent, it tries again at the next check.',
                                'After you press the button the alerts go away at once, because the result is saved from the last read.',
                            ] },
                            { note: '**Check again** on the card reads Meta right away instead of waiting for the hour.' },
                        ],
                    },
                },
            ],
        },
        // ─── 3. Keyword replies and auto-DMs ───────────────────────────────
        {
            slug: 'campaigns',
            group: 'meta',
            icon: 'megaphone',
            title: { ar: 'الردود التلقائية بالكلمات المفتاحية والرسائل الخاصة', en: 'Keyword replies and auto-DMs' },
            summary: {
                ar: 'كيف تُطابَق الكلمة، والرد العلني، وكيف تكتب رسالة خاصة تأتي بنتيجة.',
                en: 'How keywords are matched, the public reply, and how to write a DM that gets results.',
            },
            related: ['connect-meta', 'dm-assistant', 'troubleshooting', 'create'],
            sections: [
                {
                    id: 'how',
                    title: { ar: 'كيف يعمل الرد التلقائي؟', en: 'How a keyword reply works' },
                    body: {
                        ar: [
                            { ol: [
                                'متابع يعلّق على منشورك في إنستجرام أو فيسبوك.',
                                'النظام يبحث في ردودك التلقائية المفعّلة عن كلمة موجودة في تعليقه.',
                                'إذا وجدها، يرسل له **قالب الرسالة الخاصة** رداً خاصاً على تعليقه.',
                                'ويردّ على التعليق علناً بواحد من ردودك، إذا كتبت **الردّ العلني على التعليق**.',
                            ] },
                            'أنشئ رداً تلقائياً من **الردود التلقائية** ← **ردّ تلقائي جديد**، أو أضف عدة ردود مرة واحدة من **استورد من CSV**. ويمكنك إيقاف أي رد دون حذفه من مفتاح **تفعيل الردّ التلقائي**.',
                            '**معرّف المنشور المستهدف** اختياري: إذا حددته (أو اخترته من **اختر منشوراً**)، يعمل الرد على تعليقات هذا المنشور فقط. وإذا تركته فارغاً، يعمل على كل منشوراتك.',
                        ],
                        en: [
                            { ol: [
                                'Someone comments on your post on Instagram or Facebook.',
                                'AutoReply Pro looks through your active keyword replies for a keyword that appears in the comment.',
                                'When one matches, it sends them your **DM template** as a private reply to that comment.',
                                'It also answers the comment in public with one of your replies, if you filled in **Public comment reply**.',
                            ] },
                            'Create one from **Keyword replies** → **New keyword reply**, or add several at once with **Import CSV**. The **Keyword reply active** switch pauses a keyword reply without deleting it.',
                            '**Target post ID** is optional. Set it (or choose one with **Pick a post**) and the keyword reply only answers comments under that post; leave it empty and it works on all your posts.',
                        ],
                    },
                },
                {
                    id: 'matching',
                    title: { ar: 'كيف تُطابَق الكلمات', en: 'How keywords are matched' },
                    body: {
                        ar: [
                            'قبل المقارنة، يوحّد النظام الكتابة في التعليق وفي كلمتك، لكي لا تضيّع الفروق الصغيرة عليك أحداً:',
                            { ul: [
                                'الهمزات: «أ» و«إ» و«آ» كلها تصبح «ا».',
                                'التاء المربوطة «ة» تصبح «ه»، والألف المقصورة «ى» تصبح «ي».',
                                'يُزال التشكيل، ويُزال التطويل، فـ«تـــم» هي «تم».',
                                'الحروف الإنجليزية الكبيرة والصغيرة سواء.',
                            ] },
                            'أي أن «دورة» و«دوره» الشيء نفسه، و«أريد» و«اريد» الشيء نفسه.',
                            '**كلمة كاملة فقط** (تبدأ بها الردود الجديدة): يعمل الرد التلقائي فقط إذا وردت كلمتك مستقلة، لا داخل كلمة أخرى، فلا تُطابِق «تم» كلمة «تمام». وهي أدق، لكنها أصرم: «كورس» لا تُطابِق «الكورس»، فيقترح المحرّر «أضف أيضاً: الكورس» لإضافة الصيغة الأخرى بنقرة. ولا يقترح جمعاً، لأن جموع التكسير بلا قاعدة ثابتة، فاكتب ما يكتبه متابعوك.',
                            '**في أي موضع من التعليق:** يعمل الرد التلقائي إذا وُجدت كلمتك في أي مكان داخل التعليق، حتى جزءاً من كلمة أطول، فتُطابِق «كورس» كلاً من «الكورس» و«كورسك». لا تبدأ بها الردود الجديدة، لكن اخترها من «طريقة المطابقة» عند الحاجة. تبقى الردود القديمة على الطريقة التي اختيرت لها.',
                        ],
                        en: [
                            'Before comparing, AutoReply Pro normalises both the comment and your keyword, so small spelling differences don’t lose you anyone:',
                            { ul: [
                                'Hamza forms: «أ», «إ» and «آ» all become «ا».',
                                'Teh marbuta «ة» becomes «ه», and alef maksura «ى» becomes «ي».',
                                'Diacritics and tatweel are removed, so «تـــم» is «تم».',
                                'Upper and lower case letters are the same.',
                            ] },
                            'So «دورة» and «دوره» are one word, and so are «أريد» and «اريد».',
                            '**Whole word only** (new keyword replies start here): the keyword reply fires only when your keyword stands on its own, not inside a longer word, so «تم» no longer fires on «تمام». It is precise but strict: «كورس» does not match «الكورس», so the editor offers “Also add: الكورس” to add the other form in one tap. It never suggests plurals, because Arabic broken plurals follow no rule that is always right: add the forms your followers actually type.',
                            '**Anywhere in the comment:** the keyword reply fires when your keyword appears anywhere in the comment, even inside a longer word, so «كورس» matches both «الكورس» and «كورسك». New keyword replies do not start here, but you can pick it under “Match mode”. Existing keyword replies keep the mode they have.',
                        ],
                    },
                },
                {
                    id: 'pitfall',
                    title: { ar: 'فخ «تم» داخل «تمام»', en: 'The «تم» inside «تمام» trap' },
                    body: {
                        ar: [
                            'في طريقة «في أي موضع من التعليق»، الكلمة القصيرة خطر. إن كانت كلمتك «تم» مثلاً، تُطابِق «تمام» و«اهتمام» و«يتم»، ويصل رابطك إلى من لم يطلبه. والأمر نفسه في الإنجليزية: «ai» تُطابِق داخل «email» و«said». لذلك تبدأ الردود الجديدة بـ«كلمة كاملة فقط»، ولا يصيبها هذا الفخ إلا إن غيّرت الطريقة.',
                            'ماذا تفعل؟',
                            { ul: [
                                'اختر كلمة أطول وأوضح: «كورس» أفضل من «تم»، و«رابط الكورس» أفضل من «رابط».',
                                'أو عبارة من كلمتين، لأن العبارات نادراً ما تنطبق بالخطأ.',
                                'راقب مربع **كيف تُطابَق الكلمات** وأنت تكتب: يعرض لك كلمات حقيقية تطابقها كلمتك، وينبّهك إذا كانت قصيرة أو مكررة أو تتقاطع مع كلمة رد تلقائي آخر.',
                            ] },
                            { warn: 'إذا كانت كلمة رد تلقائي داخل كلمة رد آخر (مثل «كورس» و«كورسات»)، فقد يشغّل التعليق الواحد الردّين، ولا تعرف أي رسالة وصلت. اجعل لكل رد كلمة مستقلة.' },
                        ],
                        en: [
                            'In “Anywhere in the comment” mode a short keyword is dangerous. Take «تم»: it matches «تمام», «اهتمام» and «يتم», so your link goes to people who never asked for it. English has the same problem: “ai” matches inside “email” and “said”. That is why new keyword replies start as “Whole word only”, and only fall into this trap if you change the mode.',
                            'What to do instead:',
                            { ul: [
                                'Pick a longer, clearer keyword: «كورس» beats «تم», and “course link” beats “link”.',
                                'Or use a two-word phrase, which rarely matches by accident.',
                                'Watch the **How keywords are matched** box while you type: it shows real words your keyword would also fire on, and warns you when it is too short, listed twice, or overlaps another keyword reply’s keyword.',
                            ] },
                            { warn: 'When one keyword reply’s keyword sits inside another’s (say «كورس» and «كورسات»), a single comment can fire both keyword replies and you cannot tell which DM arrived. Give every keyword reply its own distinct keyword.' },
                        ],
                    },
                },
                {
                    id: 'public-reply',
                    title: { ar: 'الرد العلني على التعليق', en: 'The public reply' },
                    body: {
                        ar: [
                            'اختياري، ويبيّن للناس أن الرسالة وصلت، فيشجّع غيرهم على التعليق.',
                            { ul: [
                                'افصل بين أكثر من صيغة بعلامة `|`، ويختار النظام واحدة عشوائياً كل مرة، كي لا تمتلئ تعليقاتك بالجملة نفسها ولا تُحسب سبام.',
                                '`{username}` يتبدّل باسم صاحب التعليق.',
                                'مثال: `تم الإرسال! شيّك الخاص 📩 | أرسلت لك الرابط يا {username} 🚀`',
                            ] },
                            { note: 'الرد العلني على فيسبوك يحتاج صلاحية `pages_manage_engagement`. فإن كانت ناقصة، تصل الرسالة الخاصة ويفشل الرد العلني.' },
                        ],
                        en: [
                            'Optional, and it shows people the DM went out, which nudges others to comment too.',
                            { ul: [
                                'Separate several versions with `|` and one is picked at random each time, so your comments don’t fill up with the same sentence or look like spam.',
                                '`{username}` is replaced with the commenter’s name.',
                                'Example: `Sent! Check your DMs 📩 | Your link is on its way, {username} 🚀`',
                            ] },
                            { note: 'A public reply on Facebook needs the `pages_manage_engagement` permission. Without it the DM still arrives, but the public reply fails.' },
                        ],
                    },
                },
                {
                    id: 'dm',
                    title: { ar: 'كيف تكتب رسالة خاصة تأتي بنتيجة', en: 'Writing a DM that works' },
                    body: {
                        ar: [
                            { ul: [
                                'ابدأ بالاسم: `هلا {username} 👋` تجعل الرسالة شخصية.',
                                'أعطه ما طلبه في أول سطرين: الرابط أو المعلومة، من دون مقدمات طويلة.',
                                'جملة واحدة تقول له ماذا سيستفيد.',
                                'سؤال في الآخر يفتح محادثة، مثل: «هل لديك سؤال؟ ردّ على هذه الرسالة».',
                                'تريد تقسيمها؟ اكتب `[SPLIT]` بين الأجزاء فتصل رسائل بعضها وراء بعض. الجزء الأول هو الأهم، لأنه هو الذي يفتح المحادثة.',
                            ] },
                            { tip: 'جرّب الرسالة على نفسك من حساب آخر قبل أن تنشر المنشور.' },
                        ],
                        en: [
                            { ul: [
                                'Open with their name: `Hi {username} 👋` makes it personal.',
                                'Give them what they asked for in the first two lines: the link or the answer, no long intro.',
                                'One sentence on what they get out of it.',
                                'End with a question that starts a conversation, such as “Any questions? Just reply here.”',
                                'Want it in parts? Put `[SPLIT]` between them and they arrive as separate messages, one after another. The first part matters most: it is the one that opens the conversation.',
                            ] },
                            { tip: 'Send yourself the DM from a second account before the post goes live.' },
                        ],
                    },
                },
                {
                    id: 'limits',
                    title: { ar: 'حدود يجب أن تعرفها', en: 'Limits worth knowing' },
                    body: {
                        ar: [
                            { ul: [
                                'رسالة واحدة لكل شخص كل 24 ساعة، حتى لو علّق بالكلمة خمس مرات.',
                                'حد أقصى 180 رسالة في الساعة لكل حساب، تحت سقف ميتا بهامش أمان. إن انتشر منشورك، يُسجَّل الزائد في **السجل** بحالة **مقصود** مع السبب.',
                                'تعليقاتك أنت على منشوراتك لا تشغّل الردود التلقائية، لكي لا يرد النظام على نفسه.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'One DM per person every 24 hours, even if they comment the keyword five times.',
                                'At most 180 DMs an hour per account, safely under Meta’s own ceiling. If a post goes viral, the overflow is recorded in the **Log** as **By design**, with the reason.',
                                'Your own comments on your own posts never trigger a keyword reply, so the system doesn’t answer itself.',
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 3b. The DM assistant ────────────────────────────────────────────
        {
            slug: 'dm-assistant',
            group: 'meta',
            icon: 'message-square',
            title: { ar: 'مساعد الرسائل: الرد على الخاص تلقائياً', en: 'The DM assistant: answering your direct messages' },
            summary: {
                ar: 'كيف يردّ المساعد على رسائل متابعيك: تشغيله، والتعليمات وقاعدة المعرفة، ومحرّك الردّ، وردود المبيعات والمتابعة وتجربة الصياغة، وأسئلة البداية في إنستجرام، وتجربته قبل أن تعتمد عليه.',
                en: 'How the assistant answers your followers’ messages: switching it on, its instructions and knowledge base, the reply engine, sales replies, the follow-up and the wording experiment, Instagram ice breakers, and testing it before you rely on it.',
            },
            related: ['campaigns', 'connect-meta', 'ai-usage', 'troubleshooting'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'ماذا يفعل مساعد الرسائل؟', en: 'What the DM assistant does' },
                    body: {
                        ar: [
                            'مساعد الرسائل يردّ على الرسائل الخاصة التي تصلك في إنستجرام وماسنجر. الردود التلقائية ([[campaigns]]) تعمل على التعليقات، وهذا يعمل على رسالة بدأها الشخص بنفسه.',
                            { dl: [
                                ['من يكتب الرد', 'نموذج ذكاء اصطناعي. يقرأ آخر 8 رسائل من المحادثة (و12 في ردود المبيعات)، ويكتب مما كتبته في التعليمات وقاعدة المعرفة: [[dm-assistant#voice]].'],
                                ['ماذا يرى المتابع', 'في أول رد من المحادثة، وبعده كلما مرّ أكثر من 7 أيام على آخر مرة، سطر قصير قبل الرد يقول إنه رد آلي من مساعد الذكاء الاصطناعي.'],
                                ['صورة أو ملاحظة صوتية أو ريل مشارك', 'لا يستطيع فتحها، فيرسل سطراً ثابتاً واحداً يطلب فيه السؤال مكتوباً، ويشكر من ذكرك في ستوري. والملصق لا يردّ عليه بشيء.'],
                                ['عندما تردّ أنت بيدك', 'يتوقف المساعد في تلك المحادثة وحدها: [[dm-assistant#troubleshooting]].'],
                            ] },
                        ],
                        en: [
                            'The DM assistant answers the direct messages people send you on Instagram and Messenger. Keyword replies ([[campaigns]]) work on comments; the assistant works on a message the person started themselves.',
                            { dl: [
                                ['Who writes the reply', 'An AI model. It reads the last 8 messages of the conversation (12 for sales replies) and writes from what you put in your instructions and knowledge base: [[dm-assistant#voice]].'],
                                ['What the follower sees', 'In the first reply of a conversation, and again once the last one is more than 7 days old, a short line in front of the reply saying it is an automated reply from the AI assistant.'],
                                ['A photo, a voice note or a shared reel', 'It cannot open these, so it sends one fixed line asking for the question in words, and thanks anyone who mentions you in a story. A sticker gets no answer.'],
                                ['When you reply by hand', 'The assistant pauses in that conversation only: [[dm-assistant#troubleshooting]].'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'switch',
                    title: { ar: 'تشغيله لأول مرة', en: 'Switching it on' },
                    body: {
                        ar: [
                            'افتح **مساعد الرسائل**، وفعّل **تشغيل الردّ الآلي**، واكتب **الشخصية والتعليمات**، ثم اضغط **احفظ التغييرات**. لا يردّ المساعد على أحد قبل أول حفظ، ولا ما دام المفتاح مطفأً. والمساحة التي ينشئها لك مسؤول المنصة تبدأ ومساعدها مطفأ، وله شخصية مبدئية جاهزة تعدّلها.',
                            { dl: [
                                ['**بضعة تفاصيل أولًا**', 'في مساحة جاءت من رابط دعوة ([[onboarding]]) تظهر هذه النافذة حال تشغيلك المساعد، وتسألك **متى يسلّمك المساعد المحادثة؟** و**ما يقوله عند التسليم**. اكتبهما واضغط **احفظ وتابع**. ولا تسألك عن شيء حفظته من قبل. وإن كنت مشغّلاً لا مالكاً يظهر لك تنبيه بأن مالك مساحة العمل وحده يستطيع أن يملأها.'],
                                ['من يستطيع التغيير؟', 'المالك والمشغّل يغيّران ويجرّبان. ودور «مُطّلع» يقرأ الإعدادات فقط: الصناديق مقفلة والأزرار معطّلة.'],
                                ['**تغييرات غير محفوظة**', 'تظهر بجانب **احفظ التغييرات** ما دام هناك شيء لم يُحفظ، وتسألك الصفحة قبل أن تغادرها.'],
                            ] },
                        ],
                        en: [
                            'Open **DM assistant**, switch on **Turn on auto-replies**, write **Voice and instructions**, and press **Save changes**. The assistant answers nobody before the first save, or while the switch is off. A workspace the platform administrator creates for you starts with the assistant switched off and a starter persona ready for you to edit.',
                            { dl: [
                                ['**A few details first**', 'In a workspace that came from an invite link ([[onboarding]]) this window appears the first time you switch the assistant on. It asks **When should the assistant hand a chat to you?** and **What it says when it hands over**. Fill both in and press **Save and continue**. It never asks again about something you saved. If you are an Operator rather than the owner, you get a notice that only the workspace owner can fill it in.'],
                                ['Who can change it', 'Owners and Operators can change the settings and run tests. A Viewer can read them: the boxes are locked and the buttons are off.'],
                                ['**Unsaved changes**', 'Shown next to **Save changes** while anything is unsaved, and the page asks before you leave it.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'voice',
                    title: { ar: 'الشخصية وقاعدة المعرفة', en: 'Instructions and knowledge base' },
                    body: {
                        ar: [
                            'صندوقان تكتب فيهما، والمساعد يقرأهما قبل كل رد:',
                            { dl: [
                                ['**الشخصية والتعليمات**', 'من هو المساعد، وكيف يتكلم، وبماذا يلتزم. يجب أن تكتب فيه شيئاً لتحفظ، وبجانبه علامة **العربية موصى بها**.'],
                                ['**قاعدة المعرفة والأسئلة الشائعة**', 'الروابط وأسماء المنتجات والأسعار وإجابات الأسئلة المتكررة.'],
                            ] },
                            'يأتي الرد نصاً عادياً، أو أزرار سريعة (عنوان الزر 20 حرفاً على الأكثر)، أو بطاقات (عنوان البطاقة 80 حرفاً). وإذا طلب أحد عروضك أو طرق التواصل معك، يُطلب من المساعد أن يعرضها بأزرار أو بطاقات بدل سرد الروابط.',
                            { tip: 'التعليمات وقاعدة المعرفة نفسها تُرسل إلى النموذج مهما كان **محرّك الردّ**، وفي ردود المبيعات أيضاً. جرّب كل تعديل في **اختبار المساعد** قبل أن تحفظ: [[dm-assistant#sandbox]].' },
                        ],
                        en: [
                            'Two boxes you write in, and the assistant reads both before every reply:',
                            { dl: [
                                ['**Voice and instructions**', 'Who the assistant is, how it speaks and what it must stick to. It cannot be saved empty, and next to it you see **Arabic recommended**.'],
                                ['**Knowledge base and FAQs**', 'Links, product names, pricing and answers to the questions people keep asking.'],
                            ] },
                            'A reply comes as plain text, as quick-reply buttons (a button title is at most 20 characters) or as cards (a card title is at most 80). When someone asks for your offers or how to reach you, the assistant is told to present them as buttons or cards instead of listing links.',
                            { tip: 'The same instructions and knowledge base go to the model whichever **Reply engine** is chosen, and for sales replies too. Try each change in the **Assistant sandbox** before you save: [[dm-assistant#sandbox]].' },
                        ],
                    },
                },
                {
                    id: 'engine',
                    title: { ar: 'محرّك الردّ والنموذج', en: 'The reply engine and the model' },
                    body: {
                        ar: [
                            '**محرّك الردّ** يحدد من يكتب الردود:',
                            { dl: [
                                ['**Gemini (الحالي)**', 'الطريقة المعتادة، بنموذج Gemini الذي تختاره في **النموذج**. و**درجة الإبداع** من 0 (ثابت ومتوقع) إلى 1 (متنوّع).'],
                                ['**مزوّدو الذكاء الاصطناعي**', 'يكتب الرد مزوّد أعدّه مسؤول المنصة في **التشغيل** ← **مزوّدو الذكاء الاصطناعي**، في مسار «الردّ على الرسائل الخاصة»، وحدوده وميزانيته من هناك. وعندها يخصّ **النموذج** و**درجة الإبداع** الرجوع إلى Gemini فقط.'],
                            ] },
                            'إن اخترت المزوّدين يظهر **الرجوع إلى Gemini**، وهو مفعّل من الأصل: إن فشل المزوّد (لا يوجد مفتاح، أو انقطاع، أو انتهت المهلة، أو انتهت الميزانية) يجيب Gemini مرة واحدة بدله. وإن أوقفته، أو فشل Gemini أيضاً، يصل الشخص سطر واحد يقول إن رسالته أصبحت عند شخص يتابعها (سطر التسليم الذي كتبته في **ما يقوله عند التسليم**، أو سطر جاهز إن لم تكتب)، وتظهر المحادثة **بحاجة إليك** في **الرسائل**، ويبقى المساعد يعمل لرسالته القادمة.',
                            { note: 'حدود Gemini، وخصوصية الخطة المجانية، شرحها في [[ai-usage]].' },
                        ],
                        en: [
                            'The **Reply engine** decides who writes the replies:',
                            { dl: [
                                ['**Gemini (current)**', 'The usual way, with the Gemini model you choose in **Model**. **Temperature** runs from 0 (steady and predictable) to 1 (varied).'],
                                ['**AI providers**', 'A provider the platform administrator set up in **Operations** → **AI providers**, on the “Direct-message replies” route, writes the reply, and its limits and budget come from there. **Model** and **Temperature** then apply to the fallback to Gemini only.'],
                            ] },
                            'When you choose AI providers, **Fall back to Gemini** appears, switched on from the start: if the provider fails (no key, an outage, a timeout or a spent budget), Gemini answers once in its place. If you switch it off, or Gemini fails too, the person gets one line saying a person has their message (the hand-over line you wrote in **What it says when it hands over**, or a ready-made one if you did not), the conversation shows **Needs you** in the **Inbox**, and the assistant stays on for their next message.',
                            { note: 'Gemini’s limits, and the privacy of the free plan, are explained in [[ai-usage]].' },
                        ],
                    },
                },
                {
                    id: 'sandbox',
                    title: { ar: 'اختبار المساعد', en: 'Testing before you rely on it' },
                    body: {
                        ar: [
                            'جرّب المساعد قبل أن يردّ على أحد: اكتب رسالة كأنك متابع واقرأ الرد. يعمل الاختبار على ما في الصفحة الآن حتى قبل الحفظ: نص **الشخصية والتعليمات** وقاعدة المعرفة، و**النموذج** و**درجة الإبداع**، و**محرّك الردّ** و**الرجوع إلى Gemini**.',
                            { ul: [
                                'لا يرسل شيئاً إلى إنستجرام، ولا يغيّر شيئاً من إعداداتك المحفوظة.',
                                'يعمل حتى لو كان **تشغيل الردّ الآلي** مطفأً.',
                                'يجرّب الردود العادية فقط. مساعد المبيعات لا يظهر هنا: جرّبه من حساب آخر بوضع **تجريبية (المرسلون أدناه فقط)**: [[dm-assistant#sales]].',
                                'تحت الرد سطر يقول من كتبه: Gemini، أو المزوّدون، أو أن المزوّد فشل (مع السبب) وأجاب Gemini بدله.',
                                'كل رسالة تجريبية طلب حقيقي للنموذج، فتدخل في الحصة: [[ai-usage#save]].',
                                'دور «مُطّلع» لا يستطيع التجربة.',
                            ] },
                        ],
                        en: [
                            'Try the assistant before it answers anyone: type a message as a follower would and read the reply. The test runs what is on the page now, even before you save: the text of **Voice and instructions** and the knowledge base, **Model** and **Temperature**, **Reply engine** and **Fall back to Gemini**. It is the **Assistant sandbox**.',
                            { ul: [
                                'It sends nothing to Instagram and changes none of your saved settings.',
                                'It works even while **Turn on auto-replies** is off.',
                                'It tries the plain replies only. The sales assistant is not shown here: try it from a second account with **Sales replies** on **Test (only the senders below)**: [[dm-assistant#sales]].',
                                'A line under the reply says who wrote it: Gemini, the AI providers, or that the provider failed (with the reason) and Gemini answered in its place.',
                                'Every test message is a real request to the model, so it counts against your quota: [[ai-usage#save]].',
                                'A Viewer cannot run a test.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'sales',
                    title: { ar: 'ردود المبيعات', en: 'Sales replies' },
                    body: {
                        ar: [
                            'طريقة أخرى للرد مبنية على البيع: يسأل المساعد عن هدف الشخص (حتى سؤالين)، ثم يرشّح العرض الذي يناسبه ويرسل رابطه. يكتب من التعليمات وقاعدة المعرفة ومن عروضك المحفوظة في ملفك: الاسم والرابط والسعر وتفاصيل البيع (لمن هو، والأسئلة، والاعتراضات، والإثباتات). والكود هو الذي يقرر مرحلة المحادثة، والنموذج يقترح فقط.',
                            '**ردود المبيعات** لها ثلاث حالات، وكل مساعد يبدأ بالأولى:',
                            { dl: [
                                ['**متوقفة (الردود كما هي اليوم)**', 'لا يتغيّر شيء.'],
                                ['**تجريبية (المرسلون أدناه فقط)**', 'مساعد المبيعات يرد على المكتوبين في **مرسلو الاختبار** وحدهم، وغيرهم يأخذون الردود المعتادة.'],
                                ['**مفعّلة (للجميع)**', 'يرد على الجميع.'],
                            ] },
                            '**مرسلو الاختبار**: معرّفات أرقام فقط (من 5 إلى 32 رقماً)، واحد في كل سطر أو مفصولة بفواصل، وحتى 20. يظهر المعرّف في **الرسائل** داخل المحادثة نفسها بعد «المعرّف:»، فأرسل رسالة إلى حسابك من حساب آخر وانسخه.',
                            { dl: [
                                ['الرابط', 'النموذج لا يكتب روابط. يضيف الخادم رابط العرض بنفسه بعد النص: رابط تتبّع على عنوان منصتك يحوّل إلى صفحة عرضك ويعدّ الضغطات.'],
                                ['السعر', 'لا يذكر سعراً إلا لعرض له سعر مكتوب مع تاريخ **السعر ساري حتى** لم يمضِ، وإلا يقول إن السعر الحالي في الصفحة. وأي خصم أو كوبون أو «مجاني» أو رقم ليس في بياناتك لا يُقال: يُحذف الرد ويُسأل النموذج مرة أخرى، وإن أعاد المخالفة يتحوّل الرد إلى سطر آمن وتتسلّم أنت المحادثة.'],
                                ['متى تتحوّل إليك', 'طلب استرجاع أو شكوى (يُقرآن قبل أن يراهما النموذج)، أو طلب التحدث مع شخص، أو سؤال لا يُجاب من دون اختراع رقم. تظهر المحادثة **بحاجة إليك**، ويستلم الشخص سطر التسليم (الذي كتبته في **ما يقوله عند التسليم**، أو سطر جاهز إن لم تكتب)، ويتوقف المساعد فيها حتى تعيده من مفتاح المحادثة في **الرسائل**.'],
                                ['من يطلب التوقف', 'مثل «لا تراسلني»: يُقال له مرة واحدة ثم يسكت المساعد، ولا يرشّح له شيئاً إلا إذا قال هو إنه يريد الشراء.'],
                                ['الإهانة', 'ترد عليها جملة هادئة واحدة، والثانية توقف المساعد في تلك المحادثة.'],
                                ['حلقة ردود', 'إذا وصلت ردود المساعد على محادثة واحدة 15 رداً في ساعة، يوقف نفسه ويحوّلها لك.'],
                            ] },
                            { note: 'التنبيه على تيليجرام أو البريد عند التسليم يضبطه مسؤول المنصة، ويشمل اليوم محادثات حساب مالك المنصة نفسه. في أي مساحة أخرى الإشارة هي **بحاجة إليك** في **الرسائل**. وعروضك وتفاصيل البيع في ملف مساحتك: يستطيع مسؤول المنصة أن يعبّئها لك من **افتح الملف** في صفحة مساحتك.' },
                            'وتتابع النتيجة في **قمع المبيعات** أعلى **الرسائل**: كم محادثة وصلت إلى كل خطوة.',
                        ],
                        en: [
                            'A second way of replying, built for selling: the assistant asks what the person is after (up to two questions), then recommends the offer that fits and sends its link. It writes from the instructions, the knowledge base and your offers saved in your profile: name, link, price and sales details (who it is for, questions, objections and proof). The code decides which stage a conversation is in; the model only proposes.',
                            '**Sales replies** has three states, and every assistant starts on the first:',
                            { dl: [
                                ['**Off (replies as they are today)**', 'Nothing changes.'],
                                ['**Test (only the senders below)**', 'The sales assistant answers only the people listed in **Test senders**, and everyone else gets the usual replies.'],
                                ['**On (everyone)**', 'It answers everyone.'],
                            ] },
                            '**Test senders** takes IDs, which are numbers only (5 to 32 digits), one per line or separated by commas, up to 20. An ID shows in the **Inbox**, inside the conversation itself, after “ID:”, so message your account from a second account and copy it.',
                            { dl: [
                                ['The link', 'The model never writes a link. The server adds the offer’s link itself after the text: a tracking link on your platform’s address that sends people to your offer’s page and counts the taps.'],
                                ['The price', 'It states a price only for an offer that has a price written down and a date in **The price is valid until** that has not passed; otherwise it says the current price is on the page. Any discount, coupon, “free” or number that is not in your data is not said: the reply is dropped and the model is asked once more, and if it repeats the mistake the reply becomes a safe line and you take over the conversation.'],
                                ['When it comes to you', 'A refund request or a complaint (read before the model sees them), a request to talk to a person, or a question it cannot answer without inventing a number. The conversation shows **Needs you**, the person gets the hand-over line (the one you wrote in **What it says when it hands over**, or a ready-made one if you did not), and the assistant stops there until you switch it back on with the conversation’s switch in the **Inbox**.'],
                                ['Someone asks it to stop', 'Something like “don’t message me”: they are told once and then the assistant goes quiet, and it recommends nothing again unless they say they want to buy.'],
                                ['An insult', 'It gets one calm sentence back, and a second one stops the assistant in that conversation.'],
                                ['A loop of replies', 'Once the assistant has sent 15 replies to one conversation within an hour, it stops itself and hands it to you.'],
                            ] },
                            { note: 'The Telegram or email alert for a hand-over is set up by the platform administrator, and today it covers the conversations of the platform owner’s own account. In any other workspace the signal is **Needs you** in the **Inbox**. Your offers and their sales details live in your workspace’s profile: the platform administrator can fill them in for you from **Open the profile** on your workspace’s page.' },
                            'You follow the results in **Sales funnel**, at the top of the **Inbox**: how many conversations reached each step.',
                        ],
                    },
                },
                {
                    id: 'followup',
                    title: { ar: 'المتابعة بعد الرابط', en: 'The follow-up after the link' },
                    body: {
                        ar: [
                            'بعد أن يرسل مساعد المبيعات رابطاً، تُرسل متابعة واحدة قصيرة وبلا إلحاح بعد 4 ساعات (الافتراضي). وتُرسل بشروط يجب أن تتحقق كلها وقت إرسالها:',
                            { ul: [
                                'الشخص لم يردّ، ولم يفتح الرابط (ضغطة شخص، لا معاينة الرابط)، ولم يطلب التوقف.',
                                'لم يتسلّم أحد المحادثة، والمساعد غير موقوف فيها.',
                                'نافذة الرد في ميتا، وهي 24 ساعة من آخر رسالة منه، ما زالت مفتوحة: المساعد لا يرسل بعد مرور 23 ساعة.',
                                'ولا تُرسل إلا واحدة لكل محادثة، مهما أرسل المساعد من روابط.',
                            ] },
                            'المدة في **المتابعة بعد الرابط (بالدقائق)**: من 0 إلى 1320 دقيقة (22 ساعة)، والافتراضي 240، والصفر يوقف المتابعة. يظهر هذا الحقل لمسؤول المنصة وحده لأنه إعداد واحد لكل المساحات على المنصة، ويظهر عندما لا تكون **ردود المبيعات** متوقفة.',
                        ],
                        en: [
                            'After the sales assistant has sent a link, one short, pressure-free nudge goes out 4 hours later (the default). It is sent only if all of these still hold when it is due:',
                            { ul: [
                                'The person has not replied, has not opened the link (a person’s tap, not a link preview) and has not asked to stop.',
                                'Nobody has taken over the conversation, and the assistant is not paused in it.',
                                'Meta’s reply window, 24 hours from their last message, is still open: the assistant never sends after 23 hours.',
                                'And only one is ever sent per conversation, however many links the assistant sent.',
                            ] },
                            'The delay is **Follow-up after the link (minutes)**: from 0 to 1,320 minutes (22 hours), 240 by default, and 0 turns follow-ups off. Only the platform administrator sees this field, because it is one setting for every workspace on the platform, and it shows while **Sales replies** is not off.',
                        ],
                    },
                },
                {
                    id: 'variants',
                    title: { ar: 'تجربة الصياغة (A/B)', en: 'The wording experiment (A/B)' },
                    body: {
                        ar: [
                            'تجربة تقارن بين طريقتين أو ثلاث في افتتاح المحادثة وفي عرض الرابط. تفعّلها بمفتاح **تشغيل التجربة** تحت **تجربة الصياغة (A/B)**، وتضيف الصيغ بـ **إضافة صيغة**. لكل صيغة:',
                            { dl: [
                                ['**الاسم**', 'يظهر في المقارنة، حتى 40 حرفاً.'],
                                ['**نسبة المحادثات الجديدة**', 'رقم من 0 إلى 100، نسبةً إلى بقية الصيغ. والصفر يوقف إرسال محادثات جديدة إليها.'],
                                ['**كيف يفتتح الردّ الأول**', 'توجيه بكلماتك لأسلوب أول رد، حتى 300 حرف.'],
                                ['**كيف يعرض الرابط**', 'توجيه لصياغة عرض الرابط، حتى 300 حرف.'],
                            ] },
                            { ul: [
                                'كل محادثة جديدة تأخذ صيغة واحدة إلى الأبد، بالصدفة حسب النسب. والمحادثة التي بدأت قبل التجربة، أو ردّ عليها المساعد قبلها، لا تدخل فيها.',
                                'الصياغة فقط: من دون روابط ومن دون أرقام (يرفضها الحفظ)، والمساعد يقول ما تقوله عروضك فقط. وإن تركت خانتي صيغة فارغتين فردودها كما هي اليوم، وتصبح صيغة المقارنة.',
                                'لتشغيلها يلزم صيغتان على الأقل بنسبة فوق الصفر. والصيغة المحفوظة لا تُحذف: توقفها بنسبة 0 وتحتفظ بمحادثاتها.',
                                'لا يشارك إلا ما يجيب عنه مساعد المبيعات.',
                            ] },
                            'النتيجة في **الرسائل** ← **قمع المبيعات** ← **تجربة الصياغة**: أعداد ونسب فقط. والنسب لا تظهر قبل أن تصل الصيغة إلى 30 محادثة، ولا يُجرى اختبار دلالة إحصائية، فالفرق بين صيغتين ليس دليلاً على أن إحداهما أفضل.',
                        ],
                        en: [
                            'An experiment that compares two or three ways of opening the conversation and of offering the link. Switch it on with **Run the experiment** under **Wording experiment (A/B)**, and add the variants with **Add a variant**. Each variant has:',
                            { dl: [
                                ['**Name**', 'Shown in the comparison, up to 40 characters.'],
                                ['**Share of new conversations**', 'A number from 0 to 100, relative to the other variants. 0 stops new conversations from going to it.'],
                                ['**How to open the first reply**', 'Guidance in your own words for the style of the first reply, up to 300 characters.'],
                                ['**How to offer the link**', 'Guidance for how the link is offered, up to 300 characters.'],
                            ] },
                            { ul: [
                                'Each new conversation is given one variant for good, by chance in the shares you set. A conversation that began before the experiment, or that the assistant had already answered, takes no part.',
                                'It is wording only: no links and no numbers (saving refuses them), and the assistant still says only what your offers say. A variant whose two boxes are empty keeps today’s replies, which makes it the comparison.',
                                'To run it you need at least two variants with a share above 0. A saved variant cannot be removed: set it to 0 and it keeps its conversations.',
                                'Only the conversations the sales assistant answers take part.',
                            ] },
                            'The result is in **Inbox** → **Sales funnel** → **Wording experiment**: counts and rates only. Rates do not appear until a variant has 30 conversations, and no significance test is run, so a gap between two variants is not proof that one works better.',
                        ],
                    },
                },
                {
                    id: 'ice-breakers',
                    title: { ar: 'أسئلة البداية في إنستجرام', en: 'Instagram ice breakers' },
                    body: {
                        ar: [
                            'أسئلة البداية أزرار تظهر للشخص عندما يفتح محادثة جديدة معك في إنستجرام: يضغط على سؤال، فيصلك كرسالة منه ويجيب عنها المساعد. ويمكنك أن تضيف معها قائمة ثابتة تبقى في المحادثة. تجدها في **الإعدادات** ← **الرسائل والتنبيهات** ← **أسئلة البداية في إنستجرام**، ولمالك مساحة العمل وحده، وبعد ربط إنستجرام: [[connect-meta]].',
                            { ol: [
                                'اكتب حتى 4 أسئلة، وطول كل سؤال 80 حرفاً على الأكثر. ليست لديك أفكار؟ اضغط **استخدم الأسئلة المقترحة**. وتضيف سؤالاً بـ **أضف سؤالاً**.',
                                'لكل سؤال اختر **ما الذي يسأل عنه** ليعرف المساعد كيف يجيب: **ما الذي يتضمنه**، **لمن يناسب**، **السعر**، **يطلب الرابط**، **دعم أو مشكلة**، **التحدث مع شخص**، أو **شيء آخر**.',
                                'اختياري: **القائمة الثابتة (اختيارية)**، حتى 5 عناصر، وعنوان كل عنصر 30 حرفاً على الأكثر. العنصر إما **زر رد** (يرسل رسالة يجيب عنها المساعد) أو **رابط** يفتح صفحة ويب، ويجب أن يبدأ بـ https. وتضيف عنصراً بـ **أضف عنصراً للقائمة**.',
                                'اضغط **احفظ المسودة**. هذا يحفظها عندنا فقط، ولا يرسل شيئاً إلى إنستجرام.',
                                'اضغط **انشر على إنستجرام** ووافق. يتغيّر في الحال ما يراه كل من يفتح محادثة مع حسابك، وترى تحته ما يحتويه إنستجرام فعلاً. الزر مطفأ ما دامت هناك تغييرات لم تُحفظ.',
                            ] },
                            { dl: [
                                ['**اقرأ من إنستجرام**', 'يعرض ما في حسابك الآن، ولا يغيّر شيئاً.'],
                                ['**احذف من إنستجرام**', 'يحذف الأسئلة والقائمة من حسابك، وتبقى مسودتك هنا.'],
                                ['الحالة', 'فوق الأزرار: **لم يُنشر بعد**، أو **منشور ويطابق هذه المسودة**، أو **عُدّل بعد النشر**.'],
                            ] },
                            'تصل الضغطة كرسالة نصها السؤال نفسه. فإن كانت **ردود المبيعات** متوقفة يجيب المساعد كأن الشخص كتبها، وإن كانت مفعّلة يعرف المساعد من **ما الذي يسأل عنه** ماذا يقصد الشخص. ويجب أن يكون المساعد مفعّلاً ليجيب.',
                            { note: 'إنستجرام يعرضها في تطبيق الجوال لا على الكمبيوتر، والمحادثات المفتوحة قد تحتاج إلى تحديث الصندوق حتى يظهر التغيير. ويسمح بـ 10 تغييرات للملف كل 10 دقائق.' },
                        ],
                        en: [
                            'Ice breakers are buttons a person sees when they open a new chat with you on Instagram: they tap a question, it reaches you as their message, and the assistant answers it. You can add a persistent menu that stays in the chat. Find them in **Settings** → **Messages & alerts** → **Instagram ice breakers**, for the workspace owner only, once Instagram is connected: [[connect-meta]].',
                            { ol: [
                                'Write up to 4 questions, each at most 80 characters. No ideas? Press **Use the suggested questions**. Add one with **Add a question**.',
                                'For each question pick **What it asks**, so the assistant knows how to answer: **What is included**, **Who it is for**, **The price**, **Asks for the link**, **Support or a problem**, **Talk to a person**, or **Something else**.',
                                'Optional: **Persistent menu (optional)**, up to 5 items, each title at most 30 characters. An item is either a **Reply button** (sends a message the assistant answers) or a **Link** that opens a web page, which must start with https. Add one with **Add a menu item**.',
                                'Press **Save draft**. This saves it with us only, and sends nothing to Instagram.',
                                'Press **Publish to Instagram** and confirm. What everyone sees when they open a chat with your account changes at once, and below you see what Instagram now holds. The button stays off while anything is unsaved.',
                            ] },
                            { dl: [
                                ['**Read from Instagram**', 'Shows what your account holds now, and changes nothing.'],
                                ['**Remove from Instagram**', 'Deletes the questions and the menu from your account, and keeps your draft here.'],
                                ['The status', 'Above the buttons: **Not published yet**, **Published, and it matches this draft**, or **Edited since it was published**.'],
                            ] },
                            'A tap arrives as a message whose text is the question itself. With **Sales replies** off the assistant answers it as if the person had typed it; with sales replies on, **What it asks** tells the assistant what the person means. The assistant has to be switched on to answer.',
                            { note: 'Instagram shows them in its mobile app, not on desktop, and chats that are already open may need an inbox refresh to show a change. Instagram allows 10 profile changes every 10 minutes.' },
                        ],
                    },
                },
                {
                    id: 'troubleshooting',
                    title: { ar: 'إن لم يعمل', en: 'When something is not working' },
                    body: {
                        ar: [
                            { dl: [
                                ['المساعد لا يردّ على أحد', ['تأكد أن **تشغيل الردّ الآلي** مفعّل، وأنك ضغطت **احفظ التغييرات** مرة واحدة على الأقل.', 'وتأكد أن المحادثة نفسها ليست موقوفة: **الردّ الآلي متوقف** في **الرسائل**. أي ردّ منك بيدك يوقفه فيها، وتسليم المحادثة لك يوقفه كذلك.', 'وتأكد من ربط إنستجرام وفيسبوك: [[connect-meta]]. وإن انتهت حصة Gemini: [[ai-usage#quotas]].']],
                                ['استلم الشخص سطراً يقول إن رسالته عند شخص يتابعها', ['لم يستطع المساعد كتابة ردّ: فشل المزوّد ولم يكن هناك رجوع إلى Gemini، أو فشل Gemini أيضاً. تظهر المحادثة **بحاجة إليك** في **الرسائل**.', 'ردّ عليها بيدك. ويبقى المساعد يعمل لرسالته القادمة.']],
                                ['مساعد المبيعات لا يردّ على حسابي التجريبي', 'تأكد أن **ردود المبيعات** على **تجريبية (المرسلون أدناه فقط)** أو **مفعّلة (للجميع)**، وأن المعرّف مكتوب في **مرسلو الاختبار** كما هو، أرقاماً فقط. ويجب أن يكون الحساب قد راسلك من قبل ليظهر له محادثة وترى معرّفه: [[dm-assistant#sales]].'],
                                ['لا يذكر السعر', 'يجب أن يكون السعر مكتوباً في العرض مع تاريخ **السعر ساري حتى** لم يمضِ، وإلا يقول إن السعر الحالي في الصفحة: [[dm-assistant#sales]].'],
                                ['صورة أو ملاحظة صوتية لم يُردّ عليها', 'هذا هو المتوقع: يرسل سطراً ثابتاً يطلب السؤال مكتوباً، والملصق لا يردّ عليه: [[dm-assistant#what]].'],
                                ['سؤال البداية لا يظهر في إنستجرام', 'تأكد أن الحالة تقول **منشور ويطابق هذه المسودة**، واضغط **اقرأ من إنستجرام** لترى ما يحتويه حسابك. وتذكّر أنه يظهر في تطبيق الجوال فقط. وإن رفض إنستجرام النشر تظهر رسالته في الصفحة: [[dm-assistant#ice-breakers]].'],
                                ['الاختبار يقول إن Gemini أجاب وأنا اخترت المزوّدين', 'السطر تحت الرد يبيّن لك السبب: المزوّد فشل، وأجاب Gemini بدله لأن **الرجوع إلى Gemini** مفعّل. اطلب من مسؤول المنصة مراجعة المزوّد في **التشغيل**: [[dm-assistant#engine]].'],
                            ] },
                        ],
                        en: [
                            { dl: [
                                ['The assistant is not answering anyone', ['Check that **Turn on auto-replies** is on and that you pressed **Save changes** at least once.', 'Check that the conversation itself is not paused: **AI paused** in the **Inbox**. A manual reply from you pauses it there, and so does handing the conversation to you.', 'Check that Instagram and Facebook are connected: [[connect-meta]]. And if your Gemini quota ran out: [[ai-usage#quotas]].']],
                                ['The person got a line saying a person has their message', ['The assistant could not write a reply: the provider failed and there was no fall back to Gemini, or Gemini failed too. The conversation shows **Needs you** in the **Inbox**.', 'Answer it by hand. The assistant stays on for their next message.']],
                                ['The sales assistant does not answer my test account', 'Check that **Sales replies** is on **Test (only the senders below)** or **On (everyone)**, and that the ID is in **Test senders** exactly as it is, numbers only. The account must have messaged you before, so a conversation exists and you can see its ID: [[dm-assistant#sales]].'],
                                ['It never states the price', 'The price has to be written on the offer, with a date in **The price is valid until** that has not passed; otherwise it says the current price is on the page: [[dm-assistant#sales]].'],
                                ['A photo or a voice note got no answer', 'That is expected: it sends one fixed line asking for the question in words, and a sticker gets nothing: [[dm-assistant#what]].'],
                                ['An ice breaker does not show on Instagram', 'Check that the status says **Published, and it matches this draft**, and press **Read from Instagram** to see what your account holds. Remember it shows in the mobile app only. If Instagram refuses a publish, its message appears on the page: [[dm-assistant#ice-breakers]].'],
                                ['The test says Gemini answered, but I chose AI providers', 'The line under the reply gives the reason: the provider failed, and Gemini answered in its place because **Fall back to Gemini** is on. Ask the platform administrator to check the provider in **Operations**: [[dm-assistant#engine]].'],
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 3b. The Inbox ───────────────────────────────────────────────────
        {
            slug: 'inbox',
            group: 'meta',
            icon: 'inbox',
            title: { ar: 'الرسائل: ما المطلوب منك', en: 'The Inbox: what needs you' },
            summary: {
                ar: 'عروض الرسائل، وحالة واحدة لكل محادثة، ومهلة الردّ، ومتى تضع علامة «تمّ التعامل».',
                en: 'The views, the one status on each conversation, the reply window, and when to mark a conversation handled.',
            },
            related: ['dm-assistant', 'connect-meta', 'troubleshooting'],
            sections: [
                {
                    id: 'views',
                    title: { ar: 'العروض', en: 'The views' },
                    body: {
                        ar: [
                            'تفتح الرسائل على **المطلوب**: كل محادثة يلزم أن يتصرّف فيها شخص، وأقربها انتهاءً لمهلة الردّ في الأعلى. إن كان العدد بجانب الاسم صفراً فلا شيء ينتظرك.',
                            { dl: [
                                ['المطلوب', 'محادثات بانتظار ردّ أو محوَّلة إليك ولم تضع عليها علامة «تمّ التعامل»، مع المحادثات الساخنة غير المنتهية. هذا العدد يشمل كل ما تعدّه الشارة على قائمة الرسائل.'],
                                ['ساخنة', 'من فتح شخص رابطك، أو قال إنه جاهز للشراء، أو وسمه المساعد عميلاً جاهزاً.'],
                                ['الكل', 'كل المحادثات، الأحدث أولاً، وهو المكان الذي تبحث فيه عن شخص بعينه.'],
                            ] },
                            'الزر **المزيد** يفتح صفاً ثانياً: **الردّ الآلي متوقف**، و**من الإعلانات**، و**تمّ التعامل**.',
                            { note: 'البحث يشمل كل المحادثات مهما كان العرض المحدَّد، ويكتب تحت الخانة «البحث في كل المحادثات».' },
                        ],
                        en: [
                            'The Inbox opens on **To do**: every conversation a person has to act on, with the one whose reply window closes soonest at the top. If the number beside the name is zero, nothing is waiting for you.',
                            { dl: [
                                ['To do', 'Conversations waiting for a reply or handed over to you that you have not marked handled, plus hot ones not yet handled. It holds everything the badge on the Inbox menu counts.'],
                                ['Hot', 'Someone opened your link, said they are ready to buy, or the assistant flagged them as a hot lead.'],
                                ['All', 'Every conversation, newest first. This is where you look for one particular person.'],
                            ] },
                            '**More** opens a second row: **AI paused**, **From ads** and **Handled**.',
                            { note: 'A search looks through every conversation, whatever view is selected, and says “Searching all conversations” under the box.' },
                        ],
                    },
                },
                {
                    id: 'chips',
                    title: { ar: 'حالة واحدة لكل محادثة', en: 'One status on each conversation' },
                    body: {
                        ar: [
                            'كل صف يعرض أهمّ شيء عنه فقط، بهذا الترتيب:',
                            { ol: [
                                '**بحاجة إليك**: سلّمها المساعد إليك، مع السبب والوقت المتبقي للردّ.',
                                '**بحاجة إلى ردّ**: الردّ الآلي متوقف والعميل كتب آخراً، مع الوقت المتبقي.',
                                '**ساخنة**: لا ينتظر ردّاً الآن لكنه يستحق نظرك.',
                                '**تمّ التعامل**: وضعتَ عليها العلامة ولم يكتب العميل بعدها.',
                            ] },
                            'السطر الخافت تحت الحالة يذكر ما ليس معتاداً فقط: أن الردّ الآلي متوقف في هذه المحادثة، أو أن المساعد متوقف كلياً، أو الإعلان الذي جاءت منه، أو مرحلتها في المبيعات.',
                        ],
                        en: [
                            'Each row shows only the most important thing about it, in this order:',
                            { ol: [
                                '**Needs you**: the assistant handed it over, with the reason and the time left to reply.',
                                '**Needs reply**: the AI is paused for it and the customer wrote last, with the time left.',
                                '**Hot**: nothing is waiting for a reply, but it is worth a look.',
                                '**Handled**: you marked it, and the customer has not written since.',
                            ] },
                            'The muted line under the status says only what is not the usual: the AI paused for this conversation, the assistant switched off altogether, the ad it came from, or its sales stage.',
                        ],
                    },
                },
                {
                    id: 'window',
                    title: { ar: 'مهلة الردّ (٢٤ ساعة)', en: 'The reply window (24 hours)' },
                    body: {
                        ar: [
                            'تسمح ميتا بالردّ من هنا خلال 24 ساعة من آخر رسالة للعميل. بعدها تظهر «انتهت مهلة الردّ»، ويلزم أن تردّ من تطبيق إنستجرام أو من صندوق صفحتك على فيسبوك، ثم تضغط **تمّ التعامل**.',
                        ],
                        en: [
                            'Meta lets you reply from here for 24 hours after the customer’s last message. After that the row says “Reply window closed”: reply from the Instagram app or your Page inbox on Facebook, then press **Mark handled**.',
                        ],
                    },
                },
                {
                    id: 'handled',
                    title: { ar: 'تمّ التعامل، وإعادة الردّ الآلي', en: 'Mark handled, and handing back to the AI' },
                    body: {
                        ar: [
                            'زرّ العلامة بجانب الصف يُخرج المحادثة من **المطلوب** وفي الحال، ويمكنك التراجع خلال لحظات. إن كتب العميل مرة أخرى عادت إلى قائمتك وحدها.',
                            'الردّ اليدوي من هنا يوقف الردّ الآلي في تلك المحادثة. اضغط **أعد الردّ الآلي** حين تريد أن يتولاها المساعد من جديد.',
                        ],
                        en: [
                            'The check button beside a row takes the conversation out of **To do** at once, and you can undo it for a few seconds. If the customer writes again it comes back to your list by itself.',
                            'A manual reply from here pauses the AI in that conversation. Press **Hand back to AI** when you want the assistant to take it again.',
                        ],
                    },
                },
            ],
        },
        // ─── 4. Scheduling posts and carousels ───────────────────────────────
        {
            slug: 'scheduling',
            group: 'meta',
            icon: 'calendar-days',
            title: { ar: 'جدولة المنشورات والكاروسيل', en: 'Scheduling posts and carousels' },
            summary: {
                ar: 'أنواع المنشورات، وقواعد الكاروسيل، وصورة الغلاف، والنشر على المنصتين، والمواعيد، ومعنى كل حالة.',
                en: 'Post types, carousel rules, cover images, posting to both platforms, timing, and what each status means.',
            },
            related: ['tiktok', 'studio-schedule', 'troubleshooting'],
            sections: [
                {
                    id: 'types',
                    title: { ar: 'أنواع المنشورات', en: 'Post types' },
                    body: {
                        ar: [
                            'من **الجدولة** ← **جدوِل منشوراً**، اختر **المنصة** وبعدها **نوع المنشور**:',
                            { dl: [
                                ['صورة', 'صورة واحدة.'],
                                ['فيديو / ريل', 'فيديو يُنشر ريلاً على إنستجرام وفيديو على فيسبوك.'],
                                ['ستوري (إنستجرام فقط)', 'ستوري تختفي بعد 24 ساعة.'],
                                ['نص أو رابط (فيسبوك فقط)', 'منشور نصي أو رابط على صفحة فيسبوك.'],
                                ['كاروسيل (عدة صور)', 'من صورتين إلى عشر صور في منشور واحد.'],
                            ] },
                            'الأنواع التي لا تصلح للمنصة التي اخترتها لا تظهر في القائمة أصلاً.',
                        ],
                        en: [
                            'In the **Scheduler**, press **Schedule a post**, then choose the **Platform** and the **Post type**:',
                            { dl: [
                                ['Single image', 'One image.'],
                                ['Video / Reel', 'A video: a reel on Instagram, a video on Facebook.'],
                                ['Story (Instagram only)', 'A story that disappears after 24 hours.'],
                                ['Text / link post (Facebook only)', 'A text or link post on your Facebook Page.'],
                                ['Carousel (multiple images)', 'Two to ten images in one post.'],
                            ] },
                            'Types that don’t work on the platform you picked are simply not offered.',
                        ],
                    },
                },
                {
                    id: 'platforms',
                    title: { ar: 'إنستجرام وفيسبوك معاً', en: 'Instagram and Facebook together' },
                    body: {
                        ar: [
                            'اختر **إنستجرام + فيسبوك** فيُنشر المنشور نفسه على المنصتين بالنص نفسه.',
                            { ul: [
                                'يُنشر على فيسبوك أولاً، ثم على إنستجرام.',
                                'إن نجح أحدهما وفشل الآخر، يظهر المنشور **فشلت** ومعه السبب. وعند إعادة النشر يُنشر على ما فشل فقط، دون تكرار على ما نجح.',
                                'تريده على تيك توك أيضاً؟ فعّل **أرسله إلى تيك توك أيضاً**، فيصبح له منشور مستقل في الطابور. التفاصيل في [[tiktok]].',
                            ] },
                        ],
                        en: [
                            'Choose **Instagram + Facebook** and the same post goes to both, with the same caption.',
                            { ul: [
                                'Facebook is published first, then Instagram.',
                                'If one succeeds and the other fails, the post shows **Failed** with the reason. When you publish again, only the one that failed is retried: nothing is posted twice.',
                                'Want it on TikTok as well? Tick **Also send to TikTok** and it gets its own entry in the queue. See [[tiktok]].',
                            ] },
                        ],
                    },
                },
                {
                    id: 'carousels',
                    title: { ar: 'قواعد الكاروسيل', en: 'Carousel rules' },
                    body: {
                        ar: [
                            { ul: [
                                '**من 2 إلى 10 صور** على إنستجرام وفيسبوك. (تيك توك يقبل أكثر، حتى 35 صورة.)',
                                '**JPEG فقط**، لأن إنستجرام لا يقبل غيرها. يمكنك رفع PNG أو WebP، فتحوّلها اللوحة إلى JPEG تلقائياً، وتصغّر أي صورة أعرض من 1440 بكسل قبل الرفع.',
                                '**الصورة الأولى تحدد القصّ:** إنستجرام يقصّ كل الشرائح على مقاس الصورة الأولى. اجعل كل الصور بالمقاس نفسه (مثلاً 4:5 عمودي، 1080×1350) كي لا يُقصّ شيء من أطرافها.',
                                '**الترتيب هنا هو ترتيب الشرائح.** غيّره بأزرار التقديم والتأخير على كل صورة.',
                                'يجب أن يكون حجم كل صورة أقل من 3.2 ميجابايت بعد الضغط.',
                                'الكاروسيل صور فقط حالياً؛ لا يمكن وضع فيديو كشريحة.',
                            ] },
                            'ولتيك توك يمكنك رفع نسخ طولية مختلفة عبر **استخدم صوراً مختلفة لتيك توك (9:16)**، لأن تيك توك يعرض الصور بملء الشاشة.',
                        ],
                        en: [
                            { ul: [
                                '**2 to 10 images** on Instagram and Facebook. (TikTok takes more, up to 35.)',
                                '**JPEG only**, because Instagram accepts nothing else. You can upload PNG or WebP and the dashboard converts them to JPEG, scaling anything wider than 1440px down before it uploads.',
                                '**The first image sets the crop:** Instagram crops every slide to the first image’s shape. Keep all the images the same size (4:5 portrait, 1080×1350, for example) so nothing is cut off at the edges.',
                                '**The order here is the order of the slides.** Change it with the move-earlier and move-later buttons on each image.',
                                'Each image must be under 3.2MB after compression.',
                                'Carousels are images only for now: a video can’t be a slide.',
                            ] },
                            'For TikTok you can upload separate portrait versions with **Use different images for TikTok (9:16)**, because TikTok shows photos full screen.',
                        ],
                    },
                },
                {
                    id: 'cover',
                    title: { ar: 'صورة الغلاف للريل', en: 'Reel cover images' },
                    body: {
                        ar: [
                            'يأخذ إنستجرام أول لقطة من الفيديو صورةً مصغّرة في شبكة البروفايل. فأي فيديو يبدأ من السواد يظهر مربعاً أسود.',
                            'في خطوة **الصورة المصغّرة للريل** اضغط **ارفع صورة الغلاف** (أو الصق رابط صورة)، وسترى قبل النشر كيف سيظهر في الشبكة.',
                        ],
                        en: [
                            'Instagram uses a video’s first frame as its thumbnail in your profile grid, so any video that fades up from black becomes a black tile.',
                            'In the **Reel thumbnail** step, press **Upload a cover image** (or paste an image URL) and you’ll see how it will look in the grid before it goes out.',
                        ],
                    },
                },
                {
                    id: 'timing',
                    title: { ar: 'المواعيد', en: 'Timing' },
                    body: {
                        ar: [
                            { ul: [
                                'اختر **موعد النشر المطلوب** بتوقيت جهازك، واضغط **جدوِل**.',
                                'أو فعّل **انشر الآن بدل الجدولة** فيُنشر الآن.',
                                'يفحص المُجدوِل المنشورات المستحقة كل دقيقة، فيُنشر المنشور خلال دقائق من موعده، وتحت كل منشور ترى متى يُتوقع نشره.',
                                'ولو توقف الفحص المتكرر لأي سبب، يعود المُجدوِل إلى تشغيل واحد في اليوم الساعة 00:00 بتوقيت UTC (3 فجراً بتوقيت الرياض)، وعندها يُحسب اليوم لا الدقيقة.',
                                'يمكنك تعديل المنشور أو حذفه ما دام **بالانتظار**.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'Pick the **Requested publish time**, in your device’s time zone, and press **Schedule**.',
                                'Or tick **Publish now instead of scheduling** and it goes out now.',
                                'The scheduler checks for due posts every minute, so a post goes out within minutes of its time, and each card tells you when it expects to publish.',
                                'If that frequent check ever stops, the scheduler falls back to one run a day at 00:00 UTC (3am in Riyadh), and then the date is what counts, not the minute.',
                                'You can edit or delete a post while it is **Pending**.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'first-comment',
                    title: { ar: 'التعليق الأول', en: 'The first comment' },
                    body: {
                        ar: [
                            'خانة **التعليق الأول** تحت النص في نافذة الجدولة. اكتب فيها المصادر أو رابطاً أو أي شيء تريده أول تعليق تحت منشورك، وينشره التطبيق بنفسه على إنستجرام وفيسبوك.',
                            { ul: [
                                'متى يُضاف: بعد أن يُنشر المنشور فعلاً، وليس قبل ذلك. ريل ما زال إنستجرام يعالجه ينتظر، والتعليق ينتظر معه.',
                                'أين: على إنستجرام وفيسبوك، كلٌّ بتعليقه. منشور على إحداهما فقط يأخذ تعليقاً على تلك المنصة. تيك توك ويوتيوب لا يأخذان تعليقاً أول.',
                                'الطول: حتى 2200 حرف.',
                                'لا يُنشر شيء للمنشورات القديمة: التعليق يخص المنشورات التي تكتبه فيها.',
                            ] },
                            'تحت المنشور في الطابور ترى حال التعليق على كل منصة: «بانتظار النشر»، أو «نُشر»، أو «تعذّر» مع سببه.',
                            { warn: 'إن تعذّر التعليق فالمنشور نفسه لا يتأثر ويبقى **نُشر**. اضغط **أعد المحاولة** تحت المنشور بعد أن تقرأ السبب. ويضيف التطبيق التعليق مرة واحدة فقط ولا يكرر المحاولة تلقائياً إن انقطع الاتصال لحظة النشر، لأن ميتا قد تكون نشرته فعلاً؛ تحقق من المنشور قبل أن تعيد المحاولة.' },
                            { note: 'ميتا لا تتيح للتطبيقات تثبيت التعليق. إن أردت تثبيته فثبّته بنفسك من تطبيق إنستجرام أو فيسبوك. وبعد أن يُنشر التعليق لا يمكن تعديله من هنا؛ احذفه من المنصة نفسها إن احتاج إلى تغيير.' },
                            'في المقاطع التوضيحية يُملأ التعليق الأول تلقائياً بالمصادر التي كتبها الكاتب، وتراجعه قبل الجدولة.',
                        ],
                        en: [
                            'The **First comment** box sits under the caption in the schedule window. Write the sources, a link, or anything you want as the first comment under your post, and the app posts it for you on Instagram and Facebook.',
                            { ul: [
                                'When it goes out: after the post is really live, never before. A reel Instagram is still processing waits, and the comment waits with it.',
                                'Where: on Instagram and on Facebook, each with its own comment. A post for one of them gets the comment on that one. TikTok and YouTube posts take no first comment.',
                                'Length: up to 2,200 characters.',
                                'Nothing is posted for older posts: the comment belongs to the posts you write one for.',
                            ] },
                            'Under the post in the queue you see where the comment stands on each platform: “waiting to post”, “posted”, or “failed” with the reason.',
                            { warn: 'If the comment fails, the post itself is not affected and stays **Published**. Read the reason, then press **Retry** under the post. The app posts a comment only once and never repeats it by itself when the connection drops at the moment of posting, because Meta may already have posted it: check the post before you retry.' },
                            { note: 'Meta does not let an app pin a comment. To pin it, do it yourself in the Instagram or Facebook app. Once the comment is posted it can no longer be edited here; delete it on the platform if it needs to change.' },
                            'For explainers, the first comment is filled in with the sources the writer produced, and you review it before scheduling.',
                        ],
                    },
                },
                {
                    id: 'statuses',
                    title: { ar: 'معنى الحالات', en: 'What each status means' },
                    body: {
                        ar: [
                            'في **طابور الجدولة** كل منشور عليه حالته، وما نُشر تجده في **المنشور فعلياً**:',
                            { dl: [
                                ['بالانتظار', 'مجدول وينتظر موعده.'],
                                ['جارٍ النشر', 'يُرسل الآن إلى ميتا أو تيك توك.'],
                                ['نُشر', 'اكتمل نشره.'],
                                ['فشلت', 'لم يُحذف شيء: المنشور باقٍ في الطابور ومعه سبب الفشل. أصلح الوسائط أو النص وأعد النشر، أو أرشفه إن لم تعد تريده (انظر [[scheduling#clear-failed]]).'],
                                ['تيك توك يعالج الفيديو', 'استلمه تيك توك ويجهّزه، وعادةً يستغرق أقل من دقيقة.'],
                                ['في صندوق تيك توك', 'وصل إلى مسودّاتك في تيك توك، وبقي أن تنشره أنت من التطبيق.'],
                            ] },
                        ],
                        en: [
                            'Every post in the **Scheduled queue** carries its status, and what has gone live is in the **Published feed**:',
                            { dl: [
                                ['Pending', 'Scheduled and waiting for its time.'],
                                ['Publishing', 'Being sent to Meta or TikTok right now.'],
                                ['Published', 'Live.'],
                                ['Failed', 'Nothing was deleted: the post is still in the queue with the reason it failed. Fix the media or caption and publish again, or archive it if you no longer want it (see [[scheduling#clear-failed]]).'],
                                ['TikTok is processing', 'TikTok has it and is preparing it, which usually takes under a minute.'],
                                ['In your TikTok inbox', 'It reached your TikTok drafts, and you post it from the app.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'long-queue',
                    title: { ar: 'طابور طويل: ما يظهر منه وما لا يظهر', en: 'A long queue: what is drawn and what is not' },
                    body: {
                        ar: [
                            'لا ترسم الشاشة كل المنشورات دفعة واحدة، حتى تفتح بسرعة ولا تُحمَّل وسائط لا تحتاج إليها:',
                            { ul: [
                                '**بحاجة إليك** تظهر كاملة ودائمًا في الأعلى. رقمها يعدّ المنشورات لا البطاقات: منشور أُرسل إلى إنستجرام وفيسبوك وله نسخة في تيك توك يُحسب منشورًا واحدًا، كما في شاشة «اليوم»، وإن ظهر في بطاقتين أو ثلاث.',
                                '**القادمة** تعرض منشورات الأيام الأربعة عشر القادمة. ما بعدها يبقى مخفيًا خلف زر «عرض … من المنشورات اللاحقة»، وكل ضغطة تعرض 30 منشورًا إضافيًا. الرقم بجانب العنوان يعدّ الكل، المعروض وغير المعروض.',
                                '**تمّ نشرها** و**المؤرشفة** تعرض أول 30 منشورًا، ثم زر «عرض … أخرى».',
                            ] },
                            'إن حذف النظام ملف منشور بعد نشره (تنظيف الوسائط)، تعرض البطاقة عبارة **الوسائط لم تعد محفوظة** بدل صورة معطوبة. المنشور نفسه ونصه باقيان. أما منشور ينتظر موعده وقد فُقدت وسائطه، فعدّل وسائطه قبل موعده.',
                        ],
                        en: [
                            'The screen does not draw every post at once, so it opens fast and loads no media you do not need:',
                            { ul: [
                                '**Needs you** is always drawn in full, at the top. Its number counts posts, not cards: a post sent to Instagram and Facebook with a TikTok copy is one post, as on **Today**, even when it shows as two or three cards.',
                                '**Upcoming** draws the next 14 days. The rest waits behind a “Show … later” button, and each press shows 30 more. The number beside the title counts all of them, drawn or not.',
                                '**Done** and **Archived** draw the first 30, then a “Show … more” button.',
                            ] },
                            'If the system deleted a post’s file after it went out (media cleanup), the card says **Media no longer stored** instead of showing a broken picture. The post and its caption stay. For a post still waiting for its time whose media is gone, replace the media before it is due.',
                        ],
                    },
                },
                {
                    id: 'clear-failed',
                    title: { ar: 'تنظيف المنشورات الفاشلة والقديمة', en: 'Clearing failed and old posts' },
                    body: {
                        ar: [
                            'المنشور الفاشل يبقى في الطابور ومعه سبب فشله، ويظل محسوبًا على شارة «الجدولة» وفي شاشة «اليوم» حتى تتصرف فيه. للتصرف طريقان:',
                            { ul: [
                                '**أرشفة**: من بطاقة المنشور، أو من شاشة «اليوم» لعدة منشورات معًا. لا يُنشر المنشور بعد ذلك ولا يُحسب ضمن ما هو بحاجة إليك، ويبقى تحت **المؤرشفة** في الجدولة، ومنها تستعيده بزر **إلغاء الأرشفة** كما كان تمامًا.',
                                'من تلقاء النظام: يؤرشف يوميًا ما فشل منذ أكثر من 30 يومًا. لا يحذف شيئًا، ويسجّل ذلك في سجل التدقيق. تغيّر المدة أو توقفه من **الإعدادات** ← **الرسائل والتنبيهات** ← **تنظيف العناصر القديمة تلقائيًا**.',
                            ] },
                            'المحادثات القديمة التي كانت بحاجة إليك ولم يُتعامل معها بعد 30 يومًا تُميَّز بالطريقة نفسها بأنه تم التعامل معها، وتعود إلى قائمتك إن كتب صاحبها مجددًا.',
                        ],
                        en: [
                            'A failed post stays in the queue with the reason it failed, and stays counted on the **Scheduler** badge and on **Today** until you deal with it. There are two ways:',
                            { ul: [
                                '**Archive:** from the post’s card, or from **Today** for several at once. The post is not published after that and no longer counts as needing you. It stays under **Archived** in the Scheduler, and **Unarchive** puts it back exactly as it was.',
                                'By itself: once a day the system archives what failed more than 30 days ago. It deletes nothing, and records it in the audit log. Change the days, or switch it off, in **Settings** → **Messages & alerts** → **Clear old items automatically**.',
                            ] },
                            'Conversations that needed you and were never handled after 30 days are marked handled the same way, and come back to your list if the person writes again.',
                        ],
                    },
                },
            ],
        },
        // ─── 4a. Growth & insights ───────────────────────────────────────────
        {
            slug: 'growth',
            group: 'growth',
            icon: 'trending-up',
            title: { ar: 'النمو والإحصاءات', en: 'Growth & insights' },
            summary: {
                ar: 'ماذا يعني كل رقم في صفحة النمو، وكيف تضيف أذونات الإحصاءات، وكيف تقرأ خطة المدرب.',
                en: 'What each number on the Growth page means, how to add the insights permissions, and how to read the coach’s plan.',
            },
            related: ['seo', 'connect-meta', 'scheduling'],
            sections: [
                {
                    id: 'metrics',
                    title: { ar: 'ماذا يعني كل رقم؟', en: 'What each number means' },
                    body: {
                        ar: [
                            'كل الأرقام في **الأداء** عن الفترة التي تختارها في الأعلى: آخر 7 أيام أو 28 أو 90.',
                            { dl: [
                                ['المتابعون', 'كم حساب يتابعك الآن، والفرق عن بداية الفترة.'],
                                ['الوصول', 'كم حساباً مختلفاً رأى منشوراتك. ومن رأى المنشور ثلاث مرات يُحسب مرة واحدة.'],
                                ['المشاهدات', 'كم مرة عُرض محتواك، وتُحسب كل المشاهدات المتكررة من الشخص نفسه.'],
                                ['معدل التفاعل', 'التفاعلات (إعجاب وتعليق وحفظ ومشاركة) مقسومة على الوصول: من بين من رأوا المنشور، كم شخصاً تفاعل؟'],
                                ['الحفظ', 'كم مرة حفظ الناس منشورك ليرجعوا إليه. من أقوى الإشارات على أن المحتوى مفيد.'],
                                ['المشاركات', 'كم مرة أرسلوا منشورك إلى غيرهم. هكذا يصل محتواك إلى ناس لا يتابعونك.'],
                                ['متوسط المشاهدة', 'كم ثانية يشاهدون ريلزك في المتوسط. أول ثلاث ثوانٍ تقرر هل يكملون أم يمرّون.'],
                                ['من يراك', 'الوصول مقسوم بين متابعيك وأشخاص جدد. إن كان أغلبه أشخاصاً جدداً، فإنستجرام يعرض محتواك خارج دائرتك، والمطلوب أن تجعلهم يكملون المشاهدة.'],
                            ] },
                            { note: 'الشرطة «—» معناها أن الرقم لم يُقَس، لا أنه صفر. بجانبها مكتوب السبب: إذن مفقود، أو لم تتم مزامنة، أو إنستجرام لا يتيح هذا الرقم لحسابك.' },
                        ],
                        en: [
                            'Every number under **Performance** covers the period you pick at the top: the last 7, 28 or 90 days.',
                            { dl: [
                                ['Followers', 'How many accounts follow you now, and the change since the start of the period.'],
                                ['Reach', 'How many different accounts saw your posts. Someone who saw a post three times counts once.'],
                                ['Views', 'How many times your content was shown, counting repeat views by the same person.'],
                                ['Engagement rate', 'Interactions (likes, comments, saves, shares) divided by reach: of the people who saw a post, how many did something?'],
                                ['Saves', 'How often people saved a post to come back to. One of the strongest signs that content is useful.'],
                                ['Shares', 'How often people sent a post to someone else. This is how your content reaches people who do not follow you.'],
                                ['Avg. watch time', 'How many seconds people watch your reels, on average. The first three seconds decide whether they stay.'],
                                ['Who sees you', 'Reach split between your followers and new people. When most of it is new people, Instagram is already showing you beyond your circle, and the job is to keep them watching.'],
                            ] },
                            { note: 'A dash “—” means the number was not measured, not that it is zero. The reason is written beside it: a missing permission, no sync yet, or a number Instagram does not give for your account.' },
                        ],
                    },
                },
                {
                    id: 'permissions',
                    title: { ar: 'كيف تضيف أذونات الإحصاءات', en: 'Adding the insights permissions' },
                    body: {
                        ar: [
                            'أرقام الوصول والمشاهدات والحفظ والمشاركات تحتاج إلى إذنين في رمز ميتا، غير الأذونات التي يحتاجها الرد الآلي:',
                            { dl: [
                                ['`instagram_manage_insights`', 'إحصاءات منشورات إنستجرام وحسابك: الوصول والمشاهدات والحفظ والمشاركات ومتوسط المشاهدة.'],
                                ['`read_insights`', 'إحصاءات صفحة فيسبوك ومنشوراتها.'],
                            ] },
                            'إن كانا مفقودين، يظهر تنبيه فوق صفحة **النمو والتسويق** يسمّيهما. الحل رمز جديد فيه كل الأذونات:',
                            { ol: [
                                'افتح أداة Graph API Explorer في حساب المطوّر عند ميتا، واختر تطبيقك.',
                                'اختر رمز مستخدم، وفعّل الإذنين المذكورين أعلاه **مع كل الأذونات التي لديك الآن**، واضغط إنشاء الرمز.',
                                'حوّله إلى رمز صفحة دائم بالطريقة نفسها التي اتبعتها أول مرة: [[connect-meta#token-health]].',
                                'في **الإعدادات** الصق الرمز الجديد في **تحديث رمز الوصول** واضغط **تحقّق واحفظ**.',
                                'عد إلى صفحة **النمو والتسويق** واضغط **زامن الآن**.',
                            ] },
                            { warn: 'ركّب الرمز الجديد قبل أن تلغي القديم. ميتا لا تلغي الرمز القديم عند إصدار رمز جديد، فيظل الرد الآلي يعمل طوال الوقت.' },
                            { tip: 'مقارنة المنافسين تستخدم ميزة Business Discovery في إنستجرام، وإن كان رمزك لا يسمح بها يظهر لك تنبيه في قسم **المنافسون** نفسه.' },
                        ],
                        en: [
                            'Reach, views, saves and shares need two permissions on the Meta token, on top of the ones the auto-replies use:',
                            { dl: [
                                ['`instagram_manage_insights`', 'Insights for your Instagram posts and account: reach, views, saves, shares and watch time.'],
                                ['`read_insights`', 'Insights for your Facebook Page and its posts.'],
                            ] },
                            'When they are missing, a notice at the top of the **Growth** page names them. The fix is a new token that carries everything:',
                            { ol: [
                                'Open the Graph API Explorer in your Meta developer account and choose your app.',
                                'Pick a User token, tick the two permissions above **together with every permission you have now**, and generate the token.',
                                'Exchange it for a permanent Page token, the same way you did the first time: [[connect-meta#token-health]].',
                                'In **Settings**, paste the new token into **Update access token** and press **Validate & save**.',
                                'Go back to **Growth** and press **Sync**.',
                            ] },
                            { warn: 'Install the new token before you revoke the old one. Meta does not revoke a token when it issues a new one, so the auto-replies keep working throughout.' },
                            { tip: 'Comparing competitors uses Instagram’s Business Discovery. If your token cannot use it, the **Competitors** section says so itself.' },
                        ],
                    },
                },
                {
                    id: 'small-accounts',
                    title: { ar: 'تحت 100 متابع', en: 'Under 100 followers' },
                    body: {
                        ar: [
                            'لا يعطي إنستجرام بعض الأرقام إلا بعد أن يبلغ حسابك 100 متابع: خط المتابعين اليومي، وكم تابعك وكم ألغى المتابعة، وتوزيع جمهورك، وأوقات تواجد متابعيك.',
                            'هذا ليس خطأً ولا إذناً ناقصاً. سترى مكانها ملاحظة هادئة، ويظل عدد متابعيك نفسه ظاهراً، والوصول والمشاهدات متاحان من اليوم الأول.',
                        ],
                        en: [
                            'Instagram holds some numbers back until an account reaches 100 followers: the daily followers line, follows and unfollows, the audience breakdown, and when your followers are online.',
                            'This is not an error or a missing permission. You see a calm note in their place, your follower count still shows, and reach and views are available from day one.',
                        ],
                    },
                },
                {
                    id: 'best-times',
                    title: { ar: 'أفضل أوقات النشر', en: 'Best times to post' },
                    body: {
                        ar: [
                            'الخريطة مبنية على **منشوراتك أنت**: كل منشور يقع في يومه وساعته بتوقيت حسابك، والمربع الأغمق هو الساعة التي حققت منشوراتها أكثر مشاهدات في المتوسط. وإن كانت الإحصاءات مقفلة، تُبنى من الإعجابات والتعليقات بدلاً منها.',
                            { ul: [
                                'التوقيت هو توقيت الجمهور المحفوظ للحساب، وإن لم يكن هناك توقيت محفوظ فتوقيت متصفحك، ومكتوب تحت الخريطة أيهما.',
                                'المربع الفارغ معناه أنك لم تنشر في هذه الساعة، لا أنها ساعة سيئة.',
                                'مع منشورات قليلة، يلوّن منشور واحد ناجح ساعته. انشر في أوقات مختلفة لتتضح الصورة.',
                            ] },
                        ],
                        en: [
                            'The map is built from **your own posts**: each post lands on its weekday and hour in your account’s time zone, and the darkest square is the hour whose posts got the most views on average. When insights are locked, it is built from likes and comments instead.',
                            { ul: [
                                'The time zone is the audience time zone saved for the account, or your browser’s when none is saved, and the line under the map says which.',
                                'An empty square means you have not posted at that hour, not that the hour is bad.',
                                'With few posts, one hit colours its hour. Post at different times and the picture sharpens.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'coach',
                    title: { ar: 'كيف تقرأ خطة المدرب', en: 'Reading the coach’s plan' },
                    body: {
                        ar: [
                            'اضغط **اكتب لي خطة** في **مدرب النمو بالذكاء الاصطناعي**. يقرأ أرقام الفترة ونصوص منشوراتك وإعداداتك، ويكتب بلغة حسابك. تستغرق عادةً أقل من دقيقة، ويمكنك الخروج من الصفحة والعودة لتجدها جاهزة.',
                            { dl: [
                                ['الملخص', 'جملتان عن وضعك الآن.'],
                                ['ما الذي ينجح / ما الذي يعيقك', 'أشياء محددة من منشوراتك، لا نصائح عامة.'],
                                ['افعل هذه أولاً', 'خطوات مرتبة: الأكبر أثراً أولاً، ولو تساوى الأثر فالأقل جهداً. شارة **الأثر** و**الجهد** على كل خطوة.'],
                                ['تجارب تستحق المحاولة', 'فرضية، وكيف تجرّبها، وكيف تقيس النتيجة. جرّب تغييراً واحداً في كل مرة لتعرف ما الذي أثّر.'],
                            ] },
                            { note: 'إن كانت الأرقام مقفلة، يعمل المدرب من تاريخ منشوراتك ونصوصها ويذكر لك ما لا يستطيع رؤيته. وتذكّر أنها مكتوبة بالذكاء الاصطناعي: قارنها بأرقامك قبل أن تعمل بها.' },
                        ],
                        en: [
                            'Press **Write my plan** in the **AI Growth Coach**. It reads the period’s numbers, your captions and your settings, and writes in your account’s language. It usually takes under a minute, and you can leave the page and come back to find it ready.',
                            { dl: [
                                ['Summary', 'Two sentences on where you stand.'],
                                ['What is working / What is holding you back', 'Specific things from your posts, not general advice.'],
                                ['Do these first', 'Ordered steps: biggest impact first, and among equals the least effort first. Each carries an **Impact** and an **Effort** chip.'],
                                ['Experiments worth trying', 'A hypothesis, how to test it, and how to measure it. Change one thing at a time, so you know what made the difference.'],
                            ] },
                            { note: 'When the numbers are locked, the coach works from your post history and captions and tells you what it cannot see. It is written by AI: check it against your own numbers before acting on it.' },
                        ],
                    },
                },
                {
                    id: 'sync',
                    title: { ar: 'المزامنة', en: 'Syncing' },
                    body: {
                        ar: [
                            'تتحدّث الأرقام تلقائياً مرة في اليوم. وإن أردتها الآن فاضغط **زامن الآن**، والمسموح مرة كل عشر دقائق. تحت الزر مكتوب متى كانت آخر مزامنة.',
                            'أرقام تيك توك لا تُقرأ بعد: يحتاج تطبيق تيك توك إلى صلاحيات إضافية أولاً، وتقول الصفحة ذلك بدلاً من عرض أصفار.',
                        ],
                        en: [
                            'The numbers refresh on their own once a day. To fetch them now, press **Sync**, which is allowed once every ten minutes. The time of the last sync is shown beside the button.',
                            'TikTok is not measured yet: the TikTok app needs extra scopes first, and the page says so rather than showing zeros.',
                        ],
                    },
                },
            ],
        },
        // ─── 4b. Instagram & TikTok SEO ──────────────────────────────────────
        {
            slug: 'seo',
            group: 'growth',
            icon: 'search',
            title: { ar: 'السيو في إنستجرام وتيك توك', en: 'Instagram & TikTok SEO' },
            summary: {
                ar: 'كيف يجدك الناس في البحث: الكلمات في أول سطر، والنص على الشاشة، والوسوم، والريلز التجريبية، والمنشورات المشتركة، والاستمرارية. ومعها النص البديل لمن لا يرى الصورة.',
                en: 'How people find you in search: keywords in the first line, on-screen text, hashtags, trial reels, collab posts and posting consistency. Plus alt text, for people who can’t see the image.',
            },
            related: ['growth', 'scheduling', 'create'],
            sections: [
                {
                    id: 'keywords',
                    title: { ar: 'الكلمات في أول سطر', en: 'Keywords in the first line' },
                    body: {
                        ar: [
                            'يقرأ بحث إنستجرام وتيك توك نص المنشور، وأهم جزء فيه أول سطر. ضع كلمة أو كلمتين يكتبها جمهورك فعلاً، بشكل طبيعي في جملة، لا قائمة كلمات.',
                            { ul: [
                                'احفظ كلماتك في **السيو والوصول** ← **الكلمات المفتاحية**. كاتب الاستوديو يستخدمها في أول سطر من نصوص الكاروسيل.',
                                'زر **اقترح** يمنحك أفكاراً من الذكاء الاصطناعي عن موضوع تكتبه. هي أفكار لا أرقام بحث: جرّب كل كلمة في بحث إنستجرام وانظر ما الذي يظهر قبل أن تعتمدها.',
                                'اكتب الكلمة بالطريقة التي يكتبها بها جمهورك: «ذكاء اصطناعي» غير «AI»، وكثيرون يبحثون بالعربية.',
                            ] },
                        ],
                        en: [
                            'Instagram and TikTok search read a post’s caption, and the part that matters most is the first line. Put one or two words your audience really types there, naturally, in a sentence, not as a list.',
                            { ul: [
                                'Save your keywords under **SEO & reach** → **Keywords**. The Studio writer uses them in the first line of carousel captions.',
                                '**Suggest** gives you AI ideas for a topic you type. They are ideas, not search-volume data: try each one in Instagram search and see what comes up before you rely on it.',
                                'Write a keyword the way your audience writes it: an Arabic term and its English version are two different searches, and many people search in Arabic.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'on-screen-text',
                    title: { ar: 'النص على الشاشة', en: 'On-screen text' },
                    body: {
                        ar: [
                            'تقرأ المنصات الكلام المكتوب على الفيديو والصورة، ويسمع تيك توك الكلام المنطوق أيضاً. قل كلمتك في أول ثوانٍ واكتبها على الشاشة، واجعلها في عنوان أول شريحة من الكاروسيل.',
                            { tip: 'النص الكبير في أول ثانية يخدم مرتين: يقرؤه البحث، ومن يمرّ بسرعة يعرف عمّ يدور الفيديو فيتوقف.' },
                        ],
                        en: [
                            'The platforms read the words written on a video or an image, and TikTok listens to what is said as well. Say your keyword in the first seconds, write it on screen, and put it in the title of a carousel’s first slide.',
                            { tip: 'Big text in the first second does two jobs: search reads it, and someone scrolling past sees what the video is about and stops.' },
                        ],
                    },
                },
                {
                    id: 'alt-text',
                    title: { ar: 'النص البديل', en: 'Alt text' },
                    body: {
                        ar: [
                            'النص البديل وصف قصير لما في الصورة، يقرؤه قارئ الشاشة لمن لا يرى الصورة. إنستجرام يقدّمه كميزة وصول، ولا يذكر رسمياً أن له دوراً في البحث.',
                            { ul: [
                                'في **جدولة منشور جديد** يظهر حقل **النص البديل** للصورة، وحقل لكل شريحة في الكاروسيل، بنفس ترتيب الشرائح. الحد 200 حرف.',
                                'صف ما في الصورة فعلاً: «شاشة محادثة مع وكيل ذكاء اصطناعي يكتب خطة من ثلاث خطوات»، لا «أفضل كورس ذكاء اصطناعي».',
                                'ضع كلمتك إن ناسبت الوصف، وبلا وسوم.',
                                'النص البديل للصور والكاروسيل على إنستجرام. الريلز لا تأخذ نصاً بديلاً.',
                            ] },
                            { note: 'يكتب الاستوديو نصاً بديلاً لكل شريحة عند توفره، وترى ذلك تحت معاينة الجوال في محرر الكاروسيل.' },
                        ],
                        en: [
                            'Alt text is a short description of what is in an image, read out by screen readers to people who can’t see it. Instagram presents it as an accessibility feature and doesn’t officially say it affects search.',
                            { ul: [
                                'In **Schedule a post**, the **Alt text** field appears for an image, and one field per slide for a carousel, in slide order. The limit is 200 characters.',
                                'Describe what is really in the picture: “A chat window where an AI agent writes a three-step plan”, not “The best AI course”.',
                                'Include your keyword if it fits the description, and no hashtags.',
                                'Alt text is for Instagram images and carousels. Reels do not take alt text.',
                            ] },
                            { note: 'The Studio writes alt text for each slide when it can, and shows it under the phone preview in the carousel editor.' },
                        ],
                    },
                },
                {
                    id: 'hashtags',
                    title: { ar: 'من 3 إلى 5 وسوم', en: '3 to 5 hashtags' },
                    body: {
                        ar: [
                            'الوسوم الكثيرة لم تعد ترفع الوصول. استخدم من 3 إلى 5 وسوم محددة تصف موضوع المنشور، بدل ثلاثين وسماً عاماً مثل «اكسبلور».',
                            { ul: [
                                'في **مجموعات الوسوم** احفظ مجموعة لكل موضوع تنشر عنه، واضغط **انسخ** وقت الكتابة.',
                                'المجموعة التي فيها أكثر من 5 وسوم تُعلَّم لك لتختصرها.',
                                'الوسم المحدد («برومبتات_للطلاب») يوصلك إلى ناس يبحثون عن موضوعك بالضبط؛ والعام يضيع بين ملايين المنشورات.',
                            ] },
                        ],
                        en: [
                            'Piling on hashtags no longer lifts reach. Use 3 to 5 specific hashtags that describe the post’s topic, instead of thirty generic ones like “explore”.',
                            { ul: [
                                'Under **Hashtag sets**, save one set per topic you post about, and press **Copy** when you write.',
                                'A set with more than 5 hashtags is flagged, so you can trim it.',
                                'A specific hashtag reaches the people looking for exactly your topic; a generic one gets lost among millions of posts.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'trial-reels',
                    title: { ar: 'الريلز التجريبية', en: 'Trial reels' },
                    body: {
                        ar: [
                            'يظهر الريل التجريبي أولاً لناس لا يتابعونك، ولا يظهر لمتابعيك ولا في شبكة حسابك. تعرف منه هل تجذب الفكرة جمهوراً جديداً دون أن تخاطر بمتابعيك.',
                            { dl: [
                                ['أقرر بنفسي متى تظهر للمتابعين', 'ترى أرقامه، وتقرر أنت من إنستجرام هل تشاركه مع متابعيك.'],
                                ['تظهر للمتابعين تلقائياً إذا نجحت', 'يشاركه إنستجرام مع متابعيك بنفسه إن كان أداؤه جيداً.'],
                            ] },
                            'فعّله من **انشره ريلاً تجريبياً** عندما يكون المنشور فيديو على إنستجرام.',
                            { note: 'لا يتيح إنستجرام الريلز التجريبية لكل الحسابات. فإن رفضها لحسابك، يُنشر الريل بشكل عادي وتُكتب الملاحظة على المنشور.' },
                        ],
                        en: [
                            'A trial reel is shown to people who do not follow you first, and not to your followers or on your profile grid. It tells you whether an idea pulls in new people without risking your followers’ attention.',
                            { dl: [
                                ['I decide when my followers see it', 'You watch its numbers and decide in Instagram whether to share it with your followers.'],
                                ['Share it with my followers automatically if it does well', 'Instagram shares it with your followers itself when it performs well.'],
                            ] },
                            'Switch it on with **Post as a trial reel** when the post is a video going to Instagram.',
                            { note: 'Instagram does not offer trial reels to every account. If it refuses one for yours, the reel publishes normally and the post records why.' },
                        ],
                    },
                },
                {
                    id: 'collabs',
                    title: { ar: 'المنشورات المشتركة', en: 'Collab posts' },
                    body: {
                        ar: [
                            'في حقل **المتعاونون** اكتب حتى 3 حسابات. يصل كل حساب طلب، وإن قبل يظهر المنشور في حسابه وحسابك، ولجمهوركما معاً.',
                            { ul: [
                                'أفضل تعاون يكون مع حساب جمهوره قريب من جمهورك، لا بالضرورة الأكبر.',
                                'اكتب اسم المستخدم كما هو، مثل `@partner`. يجب أن تكون الحسابات عامة.',
                            ] },
                        ],
                        en: [
                            'In the **Collaborators** field, name up to 3 accounts. Each one gets an invite, and once they accept, the post appears on their profile and yours, to both audiences.',
                            { ul: [
                                'The best collab is with an account whose audience is close to yours, not necessarily the biggest one.',
                                'Type the username as it is, like `@partner`. The accounts must be public.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'consistency',
                    title: { ar: 'الاستمرارية', en: 'Posting consistency' },
                    body: {
                        ar: [
                            'تكافئ المنصات الحساب الذي ينشر بانتظام. جدول ثابت يناسبك أفضل من دفعة كبيرة ثم غياب.',
                            { ul: [
                                'اختر وقتين أو ثلاثة من **أفضل أوقات النشر** والتزم بها، والاستوديو يقترح مواعيد من جدولك.',
                                'قيّم التغيير على 28 يوماً، لا على منشور واحد.',
                                'غيّر شيئاً واحداً في كل مرة، مثل تجارب المدرب، لتعرف ما الذي أثّر.',
                            ] },
                        ],
                        en: [
                            'The platforms reward an account that posts regularly. A steady schedule you can keep beats a burst followed by silence.',
                            { ul: [
                                'Pick two or three slots from **Best times to post** and stick to them; the Studio suggests slots from your schedule.',
                                'Judge a change over 28 days, not over one post.',
                                'Change one thing at a time, like the coach’s experiments, so you know what made the difference.',
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 5. TikTok ───────────────────────────────────────────────────────
        {
            slug: 'tiktok',
            group: 'tiktok',
            icon: 'music-2',
            title: { ar: 'تيك توك: الربط وقواعد النشر', en: 'TikTok: connecting and posting rules' },
            summary: {
                ar: 'كيف تربط تيك توك، ولماذا تُنشر المنشورات «أنا فقط» حتى يعتمد تيك توك التطبيق، وكيف تجعلها عامة.',
                en: 'How to connect TikTok, why posts go up as “Only me” until TikTok approves the app, and how to make them public.',
            },
            related: ['studio-schedule', 'scheduling', 'youtube', 'troubleshooting', 'whatsapp'],
            sections: [
                {
                    id: 'connect',
                    title: { ar: 'ربط تيك توك', en: 'Connecting TikTok' },
                    body: {
                        ar: [
                            { ol: [
                                'افتح **الإعدادات** ← قسم **تيك توك** واضغط **اربط تيك توك**. (الزر يظهر لمالك مساحة العمل فقط.)',
                                'يفتح لك تيك توك: سجّل دخولك بالحساب الذي تريد النشر عليه، ووافق على الصلاحيات.',
                                'ترجع إلى الإعدادات وترى اسم الحساب وبجانبه **متصل**، وتحته **طريقة النشر** الحالية.',
                            ] },
                            { ul: [
                                'الربط يدوم **سنة واحدة**. قبل أن ينتهي سترى تاريخاً وتنبيهاً، فاضغط **أعد الربط** قبل ذلك اليوم.',
                                'إن رأيت **يحتاج إلى إعادة الربط**، اضغط **أعد الربط** بسرعة. تظل منشوراتك المجدولة في الطابور، لكن أي منشور يحين موعده قبل إعادة الربط يظهر **فشلت**. وبعد عودة الربط اضغط **انشر الآن** على المنشور.',
                                '**فصل تيك توك** يلغي صلاحية التطبيق عند تيك توك ويحذف الربط. تبقى المنشورات المجدولة في الطابور، وما لم يحن موعده منها ينتظر. أما أي منشور يحين موعده وتيك توك مفصول فيظهر **فشلت**، وسبب الفشل أن تيك توك غير متصل. اربط من جديد، وبعدها اضغط **انشر الآن** على المنشور.',
                            ] },
                        ],
                        en: [
                            { ol: [
                                'Open **Settings**, go to the **TikTok** section and press **Connect TikTok**. (Only the workspace owner sees this button.)',
                                'TikTok opens: sign in with the account you want to post to, and approve the permissions.',
                                'Back in Settings you’ll see the account name marked **Connected**, and the current **Posting mode** under it.',
                            ] },
                            { ul: [
                                'A connection lasts **one year**. Before it runs out you’ll see a date and a warning: press **Reconnect** before that day.',
                                'If you see **Needs reconnecting**, press **Reconnect** soon. Your scheduled posts stay in the queue, but a post whose time comes before you reconnect shows **Failed**. Once TikTok is connected again, press **Publish now** on it.',
                                '**Disconnect TikTok** revokes the app’s access with TikTok and deletes the connection. Your scheduled posts stay in the queue, and the ones not due yet wait for their time. A post whose time comes while TikTok is disconnected shows **Failed**, with the reason that TikTok is not connected. Connect again, then press **Publish now** on it.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'before-approval',
                    title: { ar: 'قبل أن يعتمد تيك توك التطبيق', en: 'Until TikTok approves the app' },
                    body: {
                        ar: [
                            'يراجع تيك توك أي تطبيق ينشر نيابة عن الناس. وحتى يعتمد تطبيقنا، تنطبق هذه القواعد على كل منشور:',
                            { ul: [
                                '**النشر المباشر يتم بخصوصية «أنا فقط»:** المنشور يصل إلى حسابك، لكن لا يراه أحد غيرك.',
                                '**يجب أن يكون حسابك خاصاً وقت النشر.** يرفض تيك توك منشورات هذا التطبيق إذا كان الحساب عاماً.',
                                'بعد نشر المنشور، تجعله أنت عاماً من تطبيق تيك توك.',
                            ] },
                            'كيف تجعل المنشور عاماً:',
                            { ol: [
                                'انتظر حتى تُنشر كل منشوراتك، وحسابك ما زال خاصاً.',
                                'أعد حسابك عاماً من إعدادات الخصوصية في تيك توك.',
                                'افتح كل منشور في تطبيق تيك توك، واضغط **⋯** (النقاط الثلاث).',
                                'اختر **الخصوصية** (Privacy)، وبعدها **الجميع** (Everyone).',
                            ] },
                            { tip: 'في الاستوديو، لكل كاروسيل خانة **جُعل عامّاً على تيك توك**: تذكير لك لتؤشّر عليها بعد أن تجعله عاماً. لا يغيّر شيئاً في تيك توك نفسه.' },
                        ],
                        en: [
                            'TikTok reviews every app that posts on people’s behalf. Until it approves this one, these rules apply to every post:',
                            { ul: [
                                '**Direct posts go up as “Only me”:** the post reaches your profile, but nobody else can see it.',
                                '**Your account must be private while posting.** TikTok refuses this app’s posts while the account is public.',
                                'Once a post is up, you make it public yourself in the TikTok app.',
                            ] },
                            'To make a post public:',
                            { ol: [
                                'Wait until all your posts are up, with the account still private.',
                                'Switch the account back to public in TikTok’s privacy settings.',
                                'Open each post in the TikTok app and tap **⋯** (the three dots).',
                                'Choose **Privacy**, then **Everyone**.',
                            ] },
                            { tip: 'In the Studio, every carousel has a **Made public on TikTok** checkbox: a reminder for you to tick once it is public. It changes nothing on TikTok itself.' },
                        ],
                    },
                },
                {
                    id: 'drafts',
                    title: { ar: 'وضع المسودّات (صندوق الوارد)', en: 'Drafts mode (the inbox)' },
                    body: {
                        ar: [
                            'الخيار الثاني في منشئ المنشورات هو **أرسله إلى مسوداتي في تيك توك (صندوق الوارد)**: يصل المنشور إلى مسودّاتك، وتكمله وتنشره أنت من التطبيق.',
                            { warn: 'هذا الوضع لا يُعتمد عليه: الإشعار أحياناً لا يصل، والمسودّة أحياناً لا تظهر، ولا يسمح تيك توك بأكثر من 5 مسودّات معلّقة كل 24 ساعة. ننصحك بالنشر المباشر: **انشره مباشرة في حسابي على تيك توك**.' },
                            'وإن بلغت حد المسودّات، لا يفشل المنشور: يعود إلى **بالانتظار** ومعه السبب، ويُرسل لاحقاً حين تنشر واحدة من مسودّاتك.',
                        ],
                        en: [
                            'The other choice in the post composer is **Send to my TikTok drafts (inbox)**: the post lands in your drafts, and you finish and post it from the app.',
                            { warn: 'This mode is unreliable: the notification sometimes never arrives, the draft sometimes doesn’t show up, and TikTok allows only 5 pending drafts every 24 hours. We recommend direct posting: **Post directly to my profile**.' },
                            'If you hit the drafts limit, the post doesn’t fail: it goes back to **Pending** with the reason, and goes out later, once you post one of your drafts.',
                        ],
                    },
                },
                {
                    id: 'after-approval',
                    title: { ar: 'بعد أن يعتمد تيك توك التطبيق', en: 'Once TikTok approves the app' },
                    body: {
                        ar: [
                            { ul: [
                                'المنشورات التي يجهّزها لك الاستوديو، أي الكاروسيل والريلز من تبويب **الريلز**، تُنشر **عامة تلقائياً**: يضبطها التطبيق على **الجميع**، ولا تحتاج إلى جعل حسابك خاصاً.',
                                'أما المنشور الذي تنشئه بنفسك من **الجدولة** فيبدأ بلا خصوصية مختارة، ولا يُنشر عاماً من تلقاء نفسه. تحت **إعدادات منشور تيك توك** اختر **من يمكنه مشاهدة هذا الفيديو** (أو **من يمكنه مشاهدة هذا المنشور** للصور): **الجميع** يجعله عاماً، و**المتابِعون** و**الأصدقاء (المتابَعون المتبادَلون)** و**أنا فقط** تحصره في ناس أقل. ولا يمكنك جدولة المنشور حتى تختار.',
                                'في الاستوديو يظهر خيار **النشر على تيك توك في الموعد نفسه**، فيُنشر مع منشور إنستجرام دون دفعة يدوية.',
                                'وزر **انشر منشورات الكاروسيل المنتظرة على تيك توك** يختفي، لأنه لم يعد له داعٍ.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'Posts the Studio makes for you, its carousels and the reels from its **Reels** tab, go up **public automatically**: the app sets them to **Everyone**, and your account no longer has to be private.',
                                'A post you make yourself in the **Scheduler** starts with nothing chosen, so it is not public by itself. Under **TikTok post settings**, pick **Who can see this video** (**Who can see this post** for photos): **Everyone** makes it public, while **Followers**, **Friends (followers you follow back)** and **Only me** keep it narrower. The post can’t be scheduled until you pick one.',
                                'The Studio offers **Post to TikTok at the same time**, so TikTok goes out with the Instagram post, with no manual batch.',
                                'The **Post queued TikTok carousels** button disappears, because nothing needs it any more.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'photos',
                    title: { ar: 'كاروسيل الصور على تيك توك', en: 'Photo carousels on TikTok' },
                    body: {
                        ar: [
                            { ul: [
                                'يقبل تيك توك منشور صور (كاروسيل) من صورتين حتى 35 صورة، JPEG أو WebP.',
                                'يعرض الصور بملء الشاشة 9:16، فالأفضل أن ترفع نسخاً طولية من **استخدم صوراً مختلفة لتيك توك (9:16)**. ويرسم الاستوديو لتيك توك نسخة 9:16 خاصة من تلقاء نفسه.',
                                '**عنوان تيك توك** حدّه 90 حرفاً، ويُملأ من أول سطر في النص، ويمكنك تعديله.',
                                '**إضافة موسيقى تلقائياً** مفعّلة افتراضياً، ويختار تيك توك موسيقى تناسب الصور.',
                                'قبل النشر يجب أن تؤشّر على **أوافق على نشر هذا المنشور على حسابي في تيك توك**. هذا شرط من تيك توك نفسه.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'TikTok takes a photo post (a carousel) of 2 to 35 images, JPEG or WebP.',
                                'It shows photos full screen at 9:16, so portrait versions via **Use different images for TikTok (9:16)** look best. The Studio draws a separate 9:16 version for TikTok on its own.',
                                'The **TikTok title** is limited to 90 characters. It is filled in from the caption’s first line, and you can edit it.',
                                '**Auto-add music** is on by default: TikTok picks music that suits the photos.',
                                'Before posting you have to tick **I agree to publish this post to my TikTok account**. TikTok itself requires it.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'bio',
                    title: { ar: 'الرابط في البايو', en: 'The link in your bio' },
                    body: {
                        ar: [
                            'لا يسمح تيك توك برسائل خاصة تلقائية لأصحاب التعليقات، فالردود التلقائية بالكلمات المفتاحية لا تعمل هناك. لذلك توجّه نصوص تيك توك المتابع إلى الرابط في البايو:',
                            { ul: [
                                'يضيف الاستوديو **سطر نص تيك توك** من إعداداته إلى كل وصف، مثل: «الرابط في البايو».',
                                'والشريحة الأخيرة في نسخة تيك توك تقول الكلام نفسه.',
                            ] },
                            { warn: 'تأكد أن الرابط موجود فعلاً في البايو. لا يتيح تيك توك خانة **الموقع الإلكتروني** في الملف الشخصي لكل الحسابات: عادةً لحسابات الأعمال، أو للحسابات التي تجاوزت عدداً من المتابعين (غالباً 1000)، ويختلف الشرط من بلد إلى آخر. افتح **تعديل الملف الشخصي** في تيك توك وتأكد أن الخانة موجودة عندك قبل أن تنشر.' },
                        ],
                        en: [
                            'TikTok doesn’t allow automatic DMs to commenters, so keyword replies can’t run there. That is why TikTok captions point people to the link in your bio:',
                            { ul: [
                                'The Studio adds the **TikTok caption line** from its settings to every description, such as “Link in my bio”.',
                                'The last slide of the TikTok version says the same.',
                            ] },
                            { warn: 'Make sure the link really is in your bio. TikTok doesn’t give every account a **Website** field on the profile: typically business accounts get it, or accounts past a follower count (often 1,000), and the rule varies by country. Open **Edit profile** in TikTok and check you have the field before you post.' },
                        ],
                    },
                },
            ],
        },
        // ─── 5a. YouTube ─────────────────────────────────────────────────────
        {
            slug: 'youtube',
            group: 'youtube',
            icon: 'youtube',
            title: { ar: 'يوتيوب: ربط القناة ورفع الـ Shorts', en: 'YouTube: connecting a channel and uploading Shorts' },
            summary: {
                ar: 'كيف تربط قناتك، وما الذي يُرفع عليها، ومتى يكون الرفع خاصاً أو عاماً، والفحص اليومي، وحد الرفع اليومي، وماذا يحدث لو انفصل الربط.',
                en: 'How to connect your channel, what is uploaded to it, when an upload is private or public, the daily check, the daily upload limit, and what happens if the connection drops.',
            },
            related: ['monteur', 'infographics', 'explainers', 'troubleshooting'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'ما الذي يذهب إلى قناتك؟', en: 'What goes to your channel' },
                    body: {
                        ar: [
                            'عندما تربط قناتك، توجد ثلاثة أشياء يمكنها إرسال فيديو إلى يوتيوب، بالتزامن مع إنستجرام وفيسبوك وغلافه صورة مصغّرة له:',
                            { dl: [
                                ['الريلز', 'عندما يكون **يوتيوب** معلّماً في **انشر على**، يضيف الاعتماد منشوراً إلى يوتيوب: الريل بوصفه Short، بعنوان الريل ونص تيك توك، ومعه نسخة الفيديو التي آخرها «الرابط في البايو»: [[monteur#approve]].'],
                                ['الإنفوجرافيك', 'عندما يكون **يوتيوب** معلّماً في **تنشر الجدولة ملف MP4 على**: يُرفع الـ MP4 مع وصفه، ويكون عنوان الصفحة هو العنوان: [[infographics#schedule]].'],
                                ['الشروحات المصوّرة', 'الفيديو العمودي بوصفه Short إن كانت مدته 3 دقائق أو أقل. وفوق 3 دقائق يُرفع الفيديو الأفقي كفيديو عادي، بدون وسم Shorts: [[explainers#publish]].'],
                            ] },
                            'وكاتب المنشورات في **الجدولة** لا يعرض يوتيوب لمنشور تكتبه بنفسك: هذه الثلاثة فقط تصنع منشورات يوتيوب. ومنشور يوتيوب في **الجدولة** بطاقة عادية، فيها **انشر الآن** وهو ينتظر، و**افتح على يوتيوب** عند رفعه.',
                            { note: 'الـ Short رفع عادي لفيديو عمودي مدته حتى 3 دقائق: لا يوجد مفتاح خاص له عند يوتيوب. فيضيف التطبيق الوسم #Shorts إلى العنوان والوصف. ويصنّف يوتيوب كل رفع في فئة بحسب ما تعمل (إجابتك عن «ماذا تفعل؟» في الإعداد): Education للتعليم، وHowto & Style للتدريب والاستشارات، وPeople & Blogs لغيرهما. ويمكنك تغييرها من YouTube Studio.' },
                        ],
                        en: [
                            'Once your channel is connected, three things can send a video to YouTube, at the same time as Instagram and Facebook and with the cover as its thumbnail:',
                            { dl: [
                                ['Monteur reels', 'When **YouTube** is ticked under **Post to**, Approve adds a YouTube post: the reel as a Short, with the reel’s title and the TikTok caption, in the “link in bio” copy of the video: [[monteur#approve]].'],
                                ['Infographics', 'When **YouTube** is ticked under **Schedule posts the MP4 to**: the MP4, with the caption as its description and the page’s headline as its title: [[infographics#schedule]].'],
                                ['Illustrated explainers', 'The vertical video as a Short when it runs 3 minutes or less. Past 3 minutes the horizontal video goes up as an ordinary video, without the Shorts tag: [[explainers#publish]].'],
                            ] },
                            'The Scheduler’s composer does not offer YouTube for a post you write yourself: only these three make YouTube posts. In the **Scheduler** a YouTube post is a normal card, with **Publish now** while it waits and **Open on YouTube** once it is up.',
                            { note: 'A Short is an ordinary upload of a vertical video of up to 3 minutes: YouTube has no separate switch for it, so the app adds the tag #Shorts to the title and the description. YouTube also files each upload under a category chosen from what you do (your answer to “What do you do?” in the setup): Education for teaching, Howto & Style for coaching and advice, People & Blogs for the rest. You can change it in YouTube Studio.' },
                        ],
                    },
                },
                {
                    id: 'connect',
                    title: { ar: 'ربط القناة', en: 'Connecting your channel' },
                    body: {
                        ar: [
                            { ol: [
                                'يحفظ مسؤول المنصة عميل Google أولاً ([[youtube#operator]]). وقبل ذلك تقول البطاقة «يوتيوب غير جاهز بعد. اطلب من مسؤول المنصة إضافة عميل Google OAuth.»',
                                'مالك المساحة يفتح **الإعدادات** ← **الاتصالات** ← **يوتيوب** ويضغط **اربط يوتيوب**. الزر يظهر للمالك فقط.',
                                'تنفتح Google: اختر الحساب الذي فيه القناة، وعلّم على المربعين اللذين تطلبهما: إدارة فيديوهات يوتيوب (من أجل الرفع)، وعرض اسم القناة وصورتها.',
                                'ترجع إلى الإعدادات وترى اسم القناة وصورتها وبجانبهما **متصل**.',
                            ] },
                            { ul: [
                                'حتى تتحقق Google من التطبيق، تقول صفحة الدخول «Google hasn’t verified this app»: اختر Advanced ثم Go to AutoReply Pro.',
                                'القناة الواحدة تُربط بمساحة واحدة فقط: لتنقلها اضغط **افصل يوتيوب** في المساحة الأولى. ويجب أن يكون لحساب Google قناة يوتيوب: وإن لم يكن له، أنشئ قناة على youtube.com أولاً.',
                                'إن ظهرت لك «لم يُمنح إذن الرفع — أعد الربط وعلّم على «إدارة فيديوهات يوتيوب».»، اضغط **إعادة الربط** وعلّم على المربعين.',
                            ] },
                        ],
                        en: [
                            { ol: [
                                'The platform administrator saves the Google client first ([[youtube#operator]]). Until then the card says “YouTube isn’t set up yet. Ask the platform administrator to add the Google OAuth client.”',
                                'The workspace owner opens **Settings** → **Connections** → **YouTube** and presses **Connect YouTube**. Only the owner sees the button.',
                                'Google opens: choose the account that has the channel, and tick both boxes it asks for: managing your YouTube videos (to upload) and seeing the channel’s name and picture.',
                                'You come back to Settings and see the channel’s name and picture, marked **Connected**.',
                            ] },
                            { ul: [
                                'Until Google verifies the app, its sign-in page warns “Google hasn’t verified this app”: choose Advanced, then Go to AutoReply Pro.',
                                'A channel connects to one workspace only: to move it, press **Disconnect YouTube** in the first one. And the Google account has to have a YouTube channel: if it has none, create one on youtube.com first.',
                                'If you see “Upload permission wasn’t granted — reconnect and tick “Manage your YouTube videos”.”, press **Reconnect** and tick both boxes.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'operator',
                    title: { ar: 'تجهيز عميل Google (مسؤول المنصة)', en: 'Setting up the Google client (platform administrator)' },
                    body: {
                        ar: [
                            'يتم هذا مرة واحدة لكل المنصة، ينفّذه مسؤول المنصة في **الإعدادات** ← **المنصة** ← **عميل Google OAuth (مسؤول المنصة)**:',
                            { ol: [
                                'في Google Cloud ← Google Auth Platform ← Clients أنشئ عميلاً من نوع «Web application».',
                                'سجّل **رابط إعادة التوجيه المعتمد** الذي تعرضه البطاقة بالضبط كما هو. ويُبنى من عنوان الموقع العام، فيجب أن يكون عنوان الموقع محدداً في بطاقة تطبيق تيك توك أولاً، وإلا يقول لك الربط ذلك.',
                                'حمّل ملف JSON للعميل واختره في **ملف JSON للعميل**: فيملأ **Client ID** و**Client secret**. ولا يُرسل شيء حتى تضغط **احفظ تطبيق يوتيوب**.',
                                'وإن أردت الرفع عاماً فعلّم على **ارفع الـ Shorts عامة**: [[youtube#public]].',
                            ] },
                            { note: 'ما دام تطبيق Google في وضع Testing، يدوم الربط 7 أيام فقط. انشره في Google Cloud (Audience ← Publish app) كي يدوم الربط: [[youtube#reconnect]].' },
                        ],
                        en: [
                            'This is done once for the whole platform, by the platform administrator, in **Settings** → **Platform** → **Google OAuth client (platform admin)**:',
                            { ol: [
                                'In Google Cloud, under Google Auth Platform → Clients, create a client of type “Web application”.',
                                'Register the **Authorised redirect URI** the card shows, exactly as written. It is built from the public site address, so the site address has to be set in the TikTok app card first; without it, connecting says so.',
                                'Download the client’s JSON file and choose it in **Client JSON file**: it fills **Client ID** and **Client secret**. Nothing is sent until you press **Save YouTube app**.',
                                'To let uploads be public, tick **Upload Shorts as public**: [[youtube#public]].',
                            ] },
                            { note: 'While the Google app is in Testing, a connection lasts only 7 days. Publish the app in Google Cloud (Audience → Publish app) so connections last: [[youtube#reconnect]].' },
                        ],
                    },
                },
                {
                    id: 'public',
                    title: { ar: 'رفع عام أو خاص', en: 'Public or private uploads' },
                    body: {
                        ar: [
                            'كون الرفع خاصاً أو عاماً مفتاح واحد لكل المنصة:',
                            { ul: [
                                '**ارفع الـ Shorts عامة** (في **الإعدادات** ← **المنصة** ← بطاقة تطبيق يوتيوب، ولمسؤول المنصة فقط). متوقف، وهذا الوضع الافتراضي: كل رفع خاص. ومفعّل: الرفع يطلب أن يكون عاماً.',
                                'بطاقة يوتيوب في إعداداتك تخبرك بأيهما: «تُرفع الـ Shorts خاصة.» أو «تُرفع الـ Shorts عامة.»',
                                'وحتى مع تفعيله، قد يجعل يوتيوب رفعات تطبيق لم يراجعه خاصة. ينجح الرفع، ويقول لك منشوره بجانب **افتح على يوتيوب**: «YouTube kept this upload private — make it public in YouTube Studio.» وتجعله عاماً من YouTube Studio.',
                                'ومع إيقافه يحمل المنشور بعد رفعه ملاحظة تبدأ بـ«Uploaded to YouTube as private».',
                            ] },
                        ],
                        en: [
                            'Whether an upload is private or public is one switch for the whole platform:',
                            { ul: [
                                '**Upload Shorts as public** (in **Settings** → **Platform** → the YouTube app card, for the platform administrator only). Off, which is how it starts: every upload is private. On: uploads ask to be public.',
                                'The YouTube card in your Settings says which: “Shorts are uploaded private.” or “Shorts are uploaded public.”',
                                'Even with it on, YouTube can keep an unaudited app’s uploads private. The upload still succeeds, and its post says so beside **Open on YouTube**: “YouTube kept this upload private — make it public in YouTube Studio.” You then make it public in YouTube Studio.',
                                'With it off, a published post carries a note that starts “Uploaded to YouTube as private”.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'check',
                    title: { ar: 'الفحص اليومي', en: 'The daily check' },
                    body: {
                        ar: [
                            'مرة كل يوم يسأل التطبيق يوتيوب عن الـ Shorts التي نشرها (حتى 500 من الأحدث في مساحتك). أما الـ Short الذي لم يعد كما يجب فتظهر على منشوره في **الجدولة** ملاحظة بجانب **افتح على يوتيوب**، تبدأ بـ«Visibility check» وتاريخ اليوم، وتكون بالإنجليزية:',
                            { ul: [
                                'تقول إن اللقطة لم تعد عامة إن كان **ارفع الـ Shorts عامة** مفعّلاً وصار يوتيوب يعرضها خاصة أو غير مدرجة: «…make it public in YouTube Studio.»',
                                'وتقول إن يوتيوب لم يعد لديه الفيديو (حُذف أو أُزيل)، أو يعرض الرفع مرفوضاً أو فاشلاً.',
                            ] },
                            'وإن كان **ارفع الـ Shorts عامة** متوقفاً فالخاص هو المطلوب، فلا تظهر ملاحظة إلا للفيديو المحذوف أو المُزال أو المرفوض أو الفاشل.',
                            'وبطاقة يوتيوب في الإعدادات تلخّصها في سطر: كل الـ Shorts كما رُفعت، أو كم منها لم يعد عاماً («انظر إليها في المنشورات»)، أو، قبل أول فحص، أن ظهورها يُفحص مرة كل يوم.',
                        ],
                        en: [
                            'Once a day the app asks YouTube about the Shorts it has published (up to the 500 newest in your workspace). A Short that is no longer as it should be gets a note on its post in the **Scheduler**, beside **Open on YouTube**. The note starts with “Visibility check” and the date, and it is written in English:',
                            { ul: [
                                'It says the Short is no longer public when **Upload Shorts as public** is on and YouTube now shows it as private or unlisted: “…make it public in YouTube Studio.”',
                                'It says YouTube no longer has the video (deleted or removed), or shows the upload as rejected or failed.',
                            ] },
                            'With **Upload Shorts as public** off, private is what was asked for, so only a deleted, removed, rejected or failed video gets a note.',
                            'The YouTube card in Settings sums it up in one line: all Shorts are as uploaded, or how many are no longer public (“See them in Posts”), or, before the first check, that visibility is checked once a day.',
                        ],
                    },
                },
                {
                    id: 'quota',
                    title: { ar: 'حد الرفع اليومي', en: 'The daily limit' },
                    body: {
                        ar: [
                            'الحصة الافتراضية لتطبيق عند يوتيوب 10,000 وحدة في اليوم. والرفع الواحد يكلّف 1,600 وحدة، وصورته المصغّرة 50، أي حوالي ست رفعات في اليوم. الحصة للتطبيق لا لكل قناة، فكل المساحات على المنصة تسحب من الحصة نفسها.',
                            'وإذا استُنفدت، يرفض يوتيوب الرفع التالي. يظهر على المنشور **فشلت**، والسبب: «The YouTube API’s daily quota is used up (about six uploads a day) — press Publish now after midnight Pacific time and the upload goes ahead.» ولا شيء يعيد المحاولة من تلقاء نفسه، فالمنشور ينتظرك: اضغط **انشر الآن** على المنشور بعد أن تتجدد الحصة، عند منتصف الليل بتوقيت المحيط الهادئ.',
                            'ولكل قناة حد رفع يومي عند يوتيوب أيضاً («YouTube’s upload limit for this channel is reached for today — retry tomorrow»): والعلاج نفسه في اليوم التالي.',
                            'وإذا كان يوتيوب يحدّ من طلبات التطبيق مؤقتاً (طلبات كثيرة في وقت قصير)، يظهر على المنشور **فشلت** أيضاً، والسبب: «YouTube is rate-limiting this app — wait a minute, then press Publish now and the upload goes ahead.» ولا شيء يعيد المحاولة من تلقاء نفسه هنا كذلك: انتظر دقيقة ثم اضغط **انشر الآن** على المنشور.',
                        ],
                        en: [
                            'YouTube’s default allowance for an app is 10,000 quota units a day. One upload costs 1,600 units and setting its thumbnail 50, so about six uploads a day. The allowance is the app’s, not each channel’s, so every workspace on the platform draws on the same one.',
                            'When it is used up, YouTube refuses the next upload. The post shows **Failed**, with the reason “The YouTube API’s daily quota is used up (about six uploads a day) — press Publish now after midnight Pacific time and the upload goes ahead.” Nothing retries it by itself, so the post waits for you: press **Publish now** on it once the quota has renewed, at midnight Pacific time.',
                            'Each channel also has a daily upload limit at YouTube (“YouTube’s upload limit for this channel is reached for today — retry tomorrow”): the same fix, the next day.',
                            'If YouTube is rate-limiting the app instead (too many requests in a short time), the post also shows **Failed**, with the reason “YouTube is rate-limiting this app — wait a minute, then press Publish now and the upload goes ahead.” Nothing retries it by itself here either: wait a minute, then press **Publish now** on the post.',
                        ],
                    },
                },
                {
                    id: 'reconnect',
                    title: { ar: 'إعادة الربط', en: 'Reconnecting' },
                    body: {
                        ar: [
                            { ul: [
                                'قد يموت الربط: أزلتَ التطبيق من myaccount.google.com/permissions، أو رفضت Google الدخول المحفوظ (سُحب الوصول أو انتهى). تقول البطاقة **يحتاج إعادة ربط** ومعها آخر مشكلة. اضغط **إعادة الربط** (للمالك فقط).',
                                'وعندما يعرف التطبيق أن Google رفضت الدخول (عند الرفع التالي أو الفحص اليومي)، يحذف في الحال الرموز المحفوظة واسم القناة وصورتها، لأن سياسات يوتيوب تطلب حذف بيانات من سُحب وصوله. ويبقى معرّف القناة لتطلب البطاقة إعادة الربط.',
                                'ومع بقاء تطبيق Google في وضع Testing، يدوم الدخول 7 أيام فقط، وتنبّهك البطاقة بالتاريخ: «تطبيق Google ما زال في وضع Testing، فهذا الربط يتوقف يوم …». انشر التطبيق في Google Cloud (Audience ← Publish app) ثم أعد الربط. وبعد النشر لا ينتهي الدخول من تلقاء نفسه: يموت إن سحبت الوصول، أو بعد ستة أشهر دون استخدام.',
                                '**افصل يوتيوب** (للمالك، في آخر البطاقة) يسحب وصول التطبيق من Google ويحذف الربط المحفوظ. وتبقى الـ Shorts التي على قناتك.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'The login can die: you removed the app at myaccount.google.com/permissions, or Google refused the saved login (access removed, or it expired). The card says **Needs reconnecting** with the last problem. Press **Reconnect** (owner only).',
                                'Once the app learns that Google refused the login (at the next upload or the daily check), it deletes the stored tokens, the channel’s name and its picture right away, because YouTube’s policies ask for a person’s data to go when they remove access. The channel id stays so the card can ask for a reconnect.',
                                'While the Google app is still in Testing, the login lasts only 7 days, and the card warns you with the date: “The Google app is still in Testing, so this connection stops on …”. Publish the app in Google Cloud (Audience → Publish app), then reconnect. After that the login does not expire by itself: it dies if access is removed, or after six months without use.',
                                '**Disconnect YouTube** (owner only, at the foot of the card) revokes the app’s access with Google and deletes the stored connection. The Shorts already on your channel stay.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'disconnected',
                    title: { ar: 'منشور يحين موعده ويوتيوب مفصول', en: 'A post that comes due while YouTube is disconnected' },
                    body: {
                        ar: [
                            'منشورات يوتيوب المجدولة تبقى في طابور **الجدولة**، وما لم يحن موعده منها ينتظر. أما المنشور الذي يحين موعده والبطاقة تقول **يحتاج إعادة ربط**، أو بعد أن تضغط **افصل يوتيوب**، فيُؤخذ ويفشل، والسبب مكتوب عليه («YouTube is not connected for this account — connect it in Settings.»، أو آخر سبب من Google إن كان الربط يحتاج إعادة). لا يضيع شيء: اربط من جديد، ثم اضغط **انشر الآن** على المنشور الفاشل. ولا يمنع هذا نشر منشورات إنستجرام وفيسبوك للريل نفسه.',
                            { tip: 'ولهذا الأفضل ألا تفصل يوتيوب وفي طابورك منشورات مجدولة قريبة. وإن اضطررت، فتذكّر أن تضغط **انشر الآن** بعد إعادة الربط.' },
                        ],
                        en: [
                            'Scheduled YouTube posts stay in the **Scheduler** queue, and the ones that are not due yet wait for their time. A post whose time comes while the card shows **Needs reconnecting**, or after you press **Disconnect YouTube**, is picked up and fails, with the reason written on it (“YouTube is not connected for this account — connect it in Settings.”, or Google’s last reason when the connection needs reconnecting). Nothing is lost: connect again, then press **Publish now** on the failed post. It does not hold back the Instagram and Facebook posts of the same reel.',
                            { tip: 'So avoid disconnecting YouTube while posts are scheduled for the next hours. If you must, remember to press **Publish now** after you reconnect.' },
                        ],
                    },
                },
                {
                    id: 'troubleshooting',
                    title: { ar: 'عندما يتوقف شيء', en: 'When something stops' },
                    body: {
                        ar: [
                            { qa: [
                                ['البطاقة تقول إن يوتيوب لم يُجهَّز بعد', 'يجب أن يحفظ مسؤول المنصة عميل Google أولاً: [[youtube#operator]].'],
                                ['الربط انتهى بـ«انتهى رابط الربط أو بدأ من متصفح آخر»', 'ابدأ الربط من جديد من المتصفح نفسه، وأكمله خلال 10 دقائق.'],
                                ['«قناة يوتيوب هذه متصلة بمساحة عمل أخرى»', 'افصلها من تلك المساحة أولاً، ثم اربطها هنا.'],
                                ['«حساب Google هذا ليس لديه قناة يوتيوب»', 'أنشئ قناة على youtube.com ثم اربط.'],
                                ['«لم يمنح Google أذونات يوتيوب»', 'اربط مرة أخرى وعلّم على المربعين.'],
                                ['«رابط إعادة التوجيه غير مسجّل»، أو «رفض Google قيمة Client ID أو السر»', 'هذا لمسؤول المنصة: راجع عميل Google في **الإعدادات** ← **المنصة**، وسجّل الرابط الذي تعرضه البطاقة.'],
                                ['نُشر الـ Short لكنه خاص', 'اقرأ [[youtube#public]].'],
                                ['المنشور يقول إن الصورة المصغّرة لم تُضبط («Thumbnail not set»)', 'نُشر الـ Short، لكن يوتيوب لم يسمح بالصورة المصغّرة المخصصة: تحتاج إلى قناة موثّقة عند يوتيوب. اضبطها من YouTube Studio.'],
                                ['المنشور فشل بسبب الحصة أو حد الرفع أو تقييد الطلبات', 'اقرأ [[youtube#quota]].'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['The card says YouTube isn’t set up yet', 'The platform administrator has to save the Google client first: [[youtube#operator]].'],
                                ['Connecting ended with “The connection link expired or was started in another browser”', 'Start the connection again from the same browser, and finish it within 10 minutes.'],
                                ['“That YouTube channel is connected to another workspace”', 'Disconnect it from that workspace first, then connect it here.'],
                                ['“That Google account has no YouTube channel”', 'Create a channel on youtube.com, then connect again.'],
                                ['“Google didn’t grant the YouTube permissions”', 'Connect again and tick both boxes.'],
                                ['“The redirect URI isn’t registered”, or “Google refused the client ID or secret”', 'These are for the platform administrator: check the Google client in **Settings** → **Platform**, and register the address the card shows.'],
                                ['The Short went up but it is private', 'Read [[youtube#public]].'],
                                ['A post says “Thumbnail not set”', 'The Short is up, but YouTube did not accept the custom thumbnail: it needs a channel YouTube has verified for them. Set it in YouTube Studio.'],
                                ['A post failed because of the quota, the upload limit or a rate limit', 'Read [[youtube#quota]].'],
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 5b. WhatsApp ────────────────────────────────────────────────────
        {
            slug: 'whatsapp',
            group: 'whatsapp',
            icon: 'message-circle',
            title: { ar: 'واتساب: تجهيز ميتا والربط والتكلفة', en: 'WhatsApp: Meta setup, connecting and costs' },
            summary: {
                ar: 'خطوات ميتا لمرة واحدة، وربط الرقم باللوحة، وتجربته على جوالك قبل أن يردّ على أي عميل، والروابط ورموز QR وأسئلة البداية، وكم يكلّف بعد الألف ردّ المجانية.',
                en: 'The one-time Meta steps, connecting the number here, testing it on your own phone before it answers a customer, links and ice breakers, and what it costs past the first 1,000 free replies.',
            },
            related: ['connect-meta', 'troubleshooting', 'faq'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'ماذا يفعل مساعد واتساب؟', en: 'What the WhatsApp assistant does' },
                    body: {
                        ar: [
                            'يردّ مساعد واتساب على الرسائل التي تصل إلى رقم نشاطك، بأسلوبك، وأنت مشغول أو نائم. وهذه حدوده:',
                            { ul: [
                                'يجيب عن نشاطك فقط: منتجاتك وأسعارك وعروضك التي كتبتها أنت في **مساعد الرسائل**. وإذا سألوه عن شيء بعيد، يعيدهم بلطف إلى موضوعك.',
                                'يقول من أول ردّ إنه مساعد آلي، ولا يتخفّى في صورة إنسان.',
                                'إذا طلب العميل أن يكلّم شخصاً، يتوقف المساعد ويؤكد له أن شخصاً سيردّ عليه، وتكمل أنت من **الرسائل**.',
                            ] },
                            { note: 'كل رقم جديد يبدأ **متوقف**: لا يردّ المساعد على أحد حتى تشغّله أنت بنفسك. ويمكنك تجربته على جوالك أولاً: انظر [[whatsapp#test]].' },
                        ],
                        en: [
                            'The WhatsApp assistant answers the messages that reach your business number, in your voice, while you are busy or asleep. These are its limits:',
                            { ul: [
                                'It answers about your business only: the products, prices and offers you wrote in **DM assistant**. Asked about something unrelated, it steers politely back to your topic.',
                                'It says it is an automated assistant from its first reply. It never passes as a person.',
                                'When a customer asks for a person, the assistant stops, confirms that someone will reply, and you carry on from the **Inbox**.',
                            ] },
                            { note: 'Every new number starts **Off**: the assistant answers no one until you switch it on yourself. You can try it on your own phone first: see [[whatsapp#test]].' },
                        ],
                    },
                },
                {
                    id: 'meta-setup',
                    title: { ar: 'تجهيز ميتا (مرة واحدة)', en: 'Setting up Meta (once)' },
                    body: {
                        ar: [
                            'هذه خطوات ميتا. تجريها مرة واحدة، ولا تدفع فيها شيئاً ولا تحتاج إلى بطاقة:',
                            { ol: [
                                'افتح تطبيق ميتا (رقمه `847772258381375`) من developers.facebook.com، وأضف له حالة الاستخدام الخاصة بواتساب: Use cases ثم Add. وإن لم تظهر كخيار متوافق مع التطبيق، فتوقف عندها وبلّغ مسؤول المنصة.',
                                'من واتساب ← API Setup تنشئ لك ميتا رقماً تجريبياً مجانياً. أضف جوالك مستلماً، واكتب الرمز الذي يصلك من واتساب لتأكيده.',
                                'من واتساب ← Configuration ضع رابط الويبهوك (تحت القائمة) في خانة Callback URL. وفي خانة رمز التحقق الصق الرمز الموجود في **الإعدادات** ← **رمز التحقق للويبهوك** في مساحة العمل الافتراضية، واضغط **Verify and save**. بعدها اشترك في الحقول السبعة المكتوبة أدناه.',
                                'من business.facebook.com افتح Business Settings ← Users ← **System users**، وأضف مستخدم نظام بدور مدير (Admin).',
                                'اضغط **Assign assets** وأعطه التطبيق وحساب واتساب للأعمال بتحكم كامل (Full control).',
                                'اضغط **Generate token**، واختر التطبيق، وفعّل الصلاحيات الثلاث المكتوبة أدناه، واجعل الانتهاء «Never».',
                            ] },
                            { code: 'https://msg-response-auto.vercel.app/webhook', caption: 'رابط الويبهوك' },
                            { code: 'messages\naccount_update\naccount_alerts\nphone_number_quality_update\nphone_number_name_update\nbusiness_capability_update\nuser_preferences', caption: 'الحقول السبعة التي تشترك فيها' },
                            { code: 'whatsapp_business_messaging\nwhatsapp_business_management\nbusiness_management', caption: 'صلاحيات الرمز' },
                            { warn: 'يظهر الرمز مرة واحدة فقط، عندما تضغط **Generate token**. انسخه في اللحظة نفسها والصقه في اللوحة مباشرة (انظر [[whatsapp#connect]])، ولا تلصقه في أي محادثة أو بريد أو رسالة لأي أحد، حتى لو كان من فريقك.' },
                        ],
                        en: [
                            'These are the Meta steps. You do them once, they cost nothing, and they need no payment card:',
                            { ol: [
                                'Open the Meta app (ID `847772258381375`) at developers.facebook.com and add the WhatsApp use case: Use cases, then Add. If WhatsApp is not offered as compatible with the app, stop there and tell the platform administrator.',
                                'Under WhatsApp → API Setup, Meta creates a free test number for you. Add your own phone as a recipient and enter the code WhatsApp sends you to confirm it.',
                                'Under WhatsApp → Configuration, put the webhook address (below the list) in Callback URL. For the verify token, paste the one saved under **Settings** → **Webhook verify token** in the Default workspace, and press **Verify and save**. Then subscribe to the seven fields listed below.',
                                'At business.facebook.com open Business Settings → Users → **System users** and add a system user with the Admin role.',
                                'Press **Assign assets** and give it the app and the WhatsApp account with full control.',
                                'Press **Generate token**, pick the app, tick the three permissions listed below, and set the expiry to “Never”.',
                            ] },
                            { code: 'https://msg-response-auto.vercel.app/webhook', caption: 'The webhook address' },
                            { code: 'messages\naccount_update\naccount_alerts\nphone_number_quality_update\nphone_number_name_update\nbusiness_capability_update\nuser_preferences', caption: 'The seven fields to subscribe to' },
                            { code: 'whatsapp_business_messaging\nwhatsapp_business_management\nbusiness_management', caption: 'The token’s permissions' },
                            { warn: 'The token is shown once, when you press **Generate token**. Copy it at that moment and paste it straight into the dashboard (see [[whatsapp#connect]]). Never paste it into a chat, an email or a message to anyone, not even your own team.' },
                        ],
                    },
                },
                {
                    id: 'connect',
                    title: { ar: 'الربط من اللوحة', en: 'Connecting it here' },
                    body: {
                        ar: [
                            'بعد أن تجهّز ميتا، افتح **الإعدادات** وانزل إلى قسم **واتساب** (بعد يوتيوب):',
                            { ol: [
                                'الصق **معرّف حساب واتساب للأعمال**: أرقام فقط، وتجده في ميتا ← واتساب ← API Setup.',
                                'الصق **معرّف رقم الهاتف**: أرقام فقط أيضاً، وهو غير رقم الهاتف نفسه.',
                                'الصق الرمز الدائم في **رمز الوصول**. الحقل مخفي، ويُمسح من الصفحة لحظة ضغط الزر، ولا يظهر لك بعد ذلك ولا لأحد.',
                                'اضغط **اربط الرقم**. اللوحة تفحص الرمز مع ميتا، وتشترك في أحداث الحساب، وتحفظ الرمز مشفّراً.',
                            ] },
                            { note: 'الزر يظهر لمالك مساحة العمل فقط. أما بقية الأعضاء فيرون الحالة دون أن يغيّروا شيئاً.' },
                            'وبعد الربط ترى في القسم:',
                            { dl: [
                                ['متصل', 'الربط يعمل. وإذا رأيت **يحتاج إعادة ربط** فقد رفضت ميتا الرمز المخزَّن: أصدر رمزاً جديداً والصقه في نموذج **أعد الربط**.'],
                                ['رقم اختبار', 'رقم تجريبي من ميتا: يصل إلى الأرقام التي أضفتها مستلمين فقط، ولا يمكن تشغيل المساعد للجميع عليه.'],
                                ['حالة الرقم', 'حالة الرقم عند ميتا، مثل متصل أو مقيَّد.'],
                                ['الجودة', 'تقييم ميتا لجودة رسائلك: عالية أو متوسطة أو منخفضة.'],
                                ['حد المراسلة', 'عدد جهات الاتصال التي يمكنك بدء محادثة معها خلال 24 ساعة. ولا يقيّد ردّك على من يراسلك أولاً.'],
                                ['الردود المجانية هذا الشهر', 'عدّاد من 1,000: كم ردّاً مجانياً استُخدم، مع التكلفة المقدّرة. وإذا ظهرت رسالة بدل الأرقام فالعدّاد غير متاح الآن، وهذا لا يعني أن الردود توقفت.'],
                            ] },
                            'وتحت بطاقة الرقم زران: **حدّث الحالة** يقرأ حالة الرقم من ميتا من جديد، و**افصل واتساب** يحذف الرمز المخزَّن ويعيد المساعد إلى **متوقف**، ويسألك قبل أن ينفّذ.',
                        ],
                        en: [
                            'Once Meta is ready, open **Settings** and scroll to the **WhatsApp** section (after YouTube):',
                            { ol: [
                                'Paste the **WhatsApp Business Account ID**: digits only, found in Meta under WhatsApp → API Setup.',
                                'Paste the **Phone number ID**: digits only too, and not the phone number itself.',
                                'Paste the permanent token into **Access token**. The field is hidden, it is emptied the moment you press the button, and it never comes back to you or to anyone.',
                                'Press **Connect number**. The dashboard checks the token with Meta, subscribes to the account’s events, and stores the token encrypted.',
                            ] },
                            { note: 'The button is shown to the workspace owner only. Other members see the status and can’t change anything.' },
                            'After connecting, the section shows:',
                            { dl: [
                                ['Connected', 'The connection works. If you see **Needs reconnecting**, Meta refused the stored token: issue a new one and paste it into the **Reconnect** form.'],
                                ['Test number', 'A test number from Meta: it reaches only the numbers you added as recipients, and the assistant can’t be switched on for everyone on it.'],
                                ['Number status', 'The number’s state at Meta, such as Connected or Restricted.'],
                                ['Quality', 'Meta’s rating of the quality of your messages: High, Medium or Low.'],
                                ['Messaging limit', 'How many contacts you can start a conversation with in 24 hours. It doesn’t restrict replying to people who write to you first.'],
                                ['Free replies this month', 'A meter out of 1,000: how many free replies are used, with the estimated cost. If a message shows instead of numbers, the meter is unavailable right now, which doesn’t mean replies have stopped.'],
                            ] },
                            'Under the number’s card there are two buttons: **Refresh status** reads the number’s state from Meta again, and **Disconnect WhatsApp** deletes the stored token and puts the assistant back to **Off**, after asking you first.',
                        ],
                    },
                },
                {
                    id: 'test',
                    title: { ar: 'جرّبه على جوالك', en: 'Test it on your own phone' },
                    body: {
                        ar: [
                            'قبل أن يردّ المساعد على أي عميل، تأكد أن الرسائل تصل:',
                            { ol: [
                                'في قسم **المساعد على واتساب** اختر **مرسلو الاختبار فقط**.',
                                'اكتب رقم جوالك في **مرسلو الاختبار**: بالأرقام الدولية مع رمز الدولة، بلا + ولا صفر في أوله (مثل `201001234567` أو `966501234567`)، ورقم في كل سطر.',
                                'اضغط **احفظ**.',
                                'من جوالك أرسل رسالة للرقم التجريبي.',
                                'افتح **الرسائل**: يجب أن تجد رسالتك هناك. لا تنتظر رداً الآن: هذه الخطوة تثبت فقط أن الرسالة تصل.',
                            ] },
                            { tip: 'خيار **الجميع** معطّل حتى تكتمل شروط الإطلاق: صفحات الخصوصية والفحوصات المطلوبة. ويمكنك إيقاف المساعد في أي وقت باختيار **متوقف**.' },
                        ],
                        en: [
                            'Before the assistant answers any customer, make sure messages get through:',
                            { ol: [
                                'In **The assistant on WhatsApp**, choose **Test senders only**.',
                                'Enter your own phone number in **Test senders**: in international digits with the country code, no + and no leading zero (like `201001234567` or `966501234567`), one number per line.',
                                'Press **Save**.',
                                'From your phone, send a message to the test number.',
                                'Open the **Inbox**: your message should be there. Don’t expect a reply yet: this step only proves that the message gets in.',
                            ] },
                            { tip: '**Everyone** stays disabled until the go-live conditions are met: public privacy pages and the required checks. You can switch the assistant off again at any time by choosing **Off**.' },
                        ],
                    },
                },
                {
                    id: 'links',
                    title: { ar: 'الروابط ورموز QR', en: 'Links and QR codes' },
                    body: {
                        ar: [
                            'الرابط القصير ورمز QR يفتحان محادثة واتساب مع رقمك مباشرة، ويجد العميل رسالتك الأولى مكتوبة وجاهزة للإرسال. ضع الرابط في سيرة حسابك، أو اطبع الرمز على ملصق، أو استخدمهما في إعلان. وأنشئ رابطاً لكل مكان، لتعرف أي مكان يجلب لك محادثات:',
                            { ol: [
                                'افتح **الإعدادات** وانزل لقسم **واتساب**، ثم لقسم **الروابط ورموز QR**.',
                                'اكتب في **اسم الرابط** اسماً لك أنت، مثل «سيرة إنستجرام». العميل لا يراه.',
                                'اكتب في **الرسالة الأولى** الجملة التي يبدأ بها العميل المحادثة، حتى 120 حرفاً.',
                                'اضغط **أنشئ الرابط**. يظهر الرابط ورمز QR في القائمة أدناه.',
                            ] },
                            'وفي القائمة، لكل رابط:',
                            { dl: [
                                ['الرابط القصير', 'اضغط **انسخ الرابط** والصقه حيث تريد.'],
                                ['رمز QR', 'اضغط **نزّل الصورة**. قد تنفتح الصورة في تبويب جديد، فاحفظها منه ثم ركّبها في تصميمك أو اطبعها.'],
                                ['رمز التتبّع', 'رمز قصير مثل `#K7M3QA` نضيفه في آخر رسالتك الأولى. يراه العميل داخل الرسالة، فلا تحذفه من الرابط. ولو حذفه العميل نفسه قبل الإرسال لن نعرف من أي رابط جاء.'],
                                ['المحادثات التي بدأت منه', 'يظهر العدد عند توفره. وإن لم ترَ رقماً فالعدّ لم يبدأ بعد، وهذا لا يعني أن الرابط لا يعمل.'],
                            ] },
                            { note: 'المالك وحده ينشئ الروابط ويحذفها، وبقية الأعضاء يرون القائمة فقط. وزر **احذف** يسألك قبل التنفيذ: عند حذف الرابط يُحذف رمزه معه عند ميتا، وتتوقف كل نسخة مطبوعة أو منشورة منهما.' },
                        ],
                        en: [
                            'The short link and the QR code open a WhatsApp chat with your number directly, and the customer finds your first message typed and ready to send. Put the link in your bio, print the code on a poster, or use either in an ad. Make one link for each place, and you can see which place brings you chats:',
                            { ol: [
                                'Open **Settings** and scroll to the **WhatsApp** section, then to **Links and QR codes**.',
                                'In **Link name**, write a name for yourself, like “Instagram bio”. The customer never sees it.',
                                'In **First message**, write the sentence the customer starts the chat with, up to 120 characters.',
                                'Press **Create link**. The link and its QR code appear in the list below.',
                            ] },
                            'In the list, each link has:',
                            { dl: [
                                ['Short link', 'Press **Copy link** and paste it wherever you need it.'],
                                ['QR code', 'Press **Download image**. The image may open in a new tab: save it from there, then place it in your design or print it.'],
                                ['Tracking code', 'A short code like `#K7M3QA` that we add to the end of your first message. The customer sees it inside the message, so don’t remove it from the link. If the customer deletes it before sending, we can’t tell which link they came from.'],
                                ['Chats started through it', 'The number shows once it is available. If you see none, counting hasn’t started yet, which doesn’t mean the link isn’t working.'],
                            ] },
                            { note: 'Only the owner creates and deletes links; other members see the list only. **Delete** asks you first: deleting a link deletes its QR code with it at Meta, and every printed or posted copy of either stops working.' },
                        ],
                    },
                },
                {
                    id: 'ice-breakers',
                    title: { ar: 'أسئلة البداية', en: 'Ice breakers' },
                    body: {
                        ar: [
                            'أسئلة البداية أسئلة قصيرة يضغط عليها العميل عندما يفتح محادثة جديدة مع رقمك، دون أن يكتب. تصلك الضغطة كرسالة عادية منه، ويجيب عنها المساعد. يمكنك وضع حتى 4 أسئلة:',
                            { ol: [
                                'افتح **الإعدادات** ← **واتساب** ← **أسئلة البداية في واتساب**.',
                                'اكتب سؤالاً في كل خانة **السؤال**: حتى 80 حرفاً، وبلا إيموجي. اترك الخانات الزائدة فارغة.',
                                'اضغط **احفظ الأسئلة**. بعد الحفظ تقرأ اللوحة ما عند ميتا وتعرضه، فإن اختلف عمّا كتبته نبّهتك.',
                            ] },
                            { note: 'يخفي واتساب هذه الأسئلة عمّن يفتح المحادثة من رابط فيه رسالة جاهزة، وكل رابط تنشئه من **الروابط ورموز QR** فيه رسالة جاهزة. فتظهر الأسئلة لمن يبدأ المحادثة من رقمك مباشرة. هذه قاعدة ميتا، لا إعداد عندنا.' },
                            { tip: 'اكتب الأسئلة كما يسأل العميل فعلاً، مثل «كم السعر؟» أو «ما المنتجات؟»، لأن الضغطة تصل المساعد نصاً عادياً.' },
                        ],
                        en: [
                            'Ice breakers are short questions a customer can tap when they open a new chat with your number, without typing. A tap reaches you as an ordinary message from them, and the assistant answers it. You can set up to 4:',
                            { ol: [
                                'Open **Settings** → **WhatsApp** → **WhatsApp ice breakers**.',
                                'Write one question in each **Question** field: up to 80 characters, with no emoji. Leave the extra fields empty.',
                                'Press **Save ice breakers**. After saving, the dashboard reads what Meta holds and shows it, and warns you if it differs from what you wrote.',
                            ] },
                            { note: 'WhatsApp hides ice breakers from anyone who opens the chat from a link with a prefilled message, and every link you make in **Links and QR codes** has one. So the questions show for people who start a chat from your number directly. That is Meta’s rule, not a setting of ours.' },
                            { tip: 'Write the questions the way a customer really asks, like “How much is it?” or “What do you sell?”, because a tap reaches the assistant as plain text.' },
                        ],
                    },
                },
                {
                    id: 'customers',
                    title: { ar: 'عندما يكون الرقم لعميل لديك', en: 'When the number belongs to a customer' },
                    body: {
                        ar: [
                            'إذا كنت تدير واتساب لعميل لديك على اللوحة، فقل له من البداية:',
                            { ul: [
                                'يجلب شريحة جديدة لم تُستخدم من قبل على واتساب، وتستطيع استقبال رسالة نصية أو مكالمة واحدة للتحقق. رقمه المسجّل حالياً على واتساب لا يصلح.',
                                'يرى عملاؤه الرقم نفسه لا اسم نشاطه، حتى يوثّق النشاط عند ميتا.',
                                'أي تكلفة بعد الألف ردّ المجانية في الشهر تُرسل له بفاتورة.',
                            ] },
                            { note: 'الخطوات نفسها: [[whatsapp#meta-setup]] ثم [[whatsapp#connect]]، لكن من مساحة عمل العميل.' },
                        ],
                        en: [
                            'If you run WhatsApp for a customer on the dashboard, tell them from the start:',
                            { ul: [
                                'They bring a new SIM that has never been used on WhatsApp and can receive one SMS or call for verification. Their number already registered on WhatsApp won’t work.',
                                'Their own customers see the number, not the business name, until the business is verified with Meta.',
                                'Any cost past the 1,000 free replies a month is invoiced to them.',
                            ] },
                            { note: 'The steps are the same: [[whatsapp#meta-setup]] then [[whatsapp#connect]], but from the customer’s workspace.' },
                        ],
                    },
                },
                {
                    id: 'costs',
                    title: { ar: 'التكلفة', en: 'What it costs' },
                    body: {
                        ar: [
                            { ul: [
                                'أول 1,000 ردّ في الشهر لكل رقم مجانية.',
                                'بعدها يكلّف الردّ تقريباً 0.0036 دولار في مصر و0.0107 دولار في السعودية.',
                                'المحادثات التي تبدأ من إعلان «انقر للمراسلة على واتساب» تكون ردودها مجانية حتى 7 أيام.',
                                'الإرسال المدفوع ممنوع إلا إذا فعّلت خيار **الرسائل المدفوعة** في بطاقة واتساب. هو مغلق افتراضياً، وعند تفعيله تطلب منك اللوحة تأكيداً. وما دام مغلقاً لا يرسل المساعد شيئاً تحاسب عليه ميتا.',
                            ] },
                            { note: 'التكلفة المقدّرة في بطاقة الرقم تقدير. وفاتورة ميتا هي المرجع.' },
                        ],
                        en: [
                            { ul: [
                                'The first 1,000 replies a month for each number are free.',
                                'After that a reply costs about $0.0036 in Egypt and $0.0107 in Saudi Arabia.',
                                'Replies in chats that start from a Click-to-WhatsApp ad are free for up to 7 days.',
                                'Paid sends are blocked unless you switch on **Paid messages** in the WhatsApp card. It is off by default, and the dashboard asks you to confirm when you turn it on. While it is off, the assistant sends nothing Meta would charge for.',
                            ] },
                            { note: 'The estimated cost in the number’s card is an estimate. Meta’s invoice is the reference.' },
                        ],
                    },
                },
                {
                    id: 'troubleshooting',
                    title: { ar: 'حلول المشكلات', en: 'Troubleshooting' },
                    body: {
                        ar: [
                            { qa: [
                                ['**Verify and save** رمادي ولا أستطيع الضغط عليه', 'خانة رمز التحقق فارغة. الصق فيها الرمز الموجود في **الإعدادات** ← **رمز التحقق للويبهوك**، في مساحة العمل الافتراضية.'],
                                ['يظهر «No permissions available» عند إصدار الرمز', 'لم تعيّن التطبيق لمستخدم النظام. افتح **System users**، واضغط **Assign assets** وأعطه التطبيق بتحكم كامل، وبعدها جرّب **Generate token** من جديد.'],
                                ['التطبيق لا يظهر في قائمة الأصول', 'أضف التطبيق `847772258381375` إلى محفظة الأعمال (Business portfolio) من Business Settings، وعد إلى **Assign assets**.'],
                                ['لا يصل شيء وصندوق الرسائل فارغ', { ul: [
                                    'لم تشترك في الحقول السبعة في صفحة Configuration عند ميتا. راجع [[whatsapp#meta-setup]].',
                                    'الرقم غير متصل هنا: افتح **الإعدادات** ← **واتساب** وتأكد أن الحالة **متصل**.',
                                    'الرقم متصل بمساحة عمل أخرى: افصله هناك أولاً.',
                                ] }],
                                ['اللوحة ترفض الربط', ['تكتب اللوحة سبب الرفض بنفسها تحت الحقل المقصود، وتضيف كلام ميتا أسفله. هذه أشهر الرسائل:', { dl: [
                                    ['«رفضت ميتا هذا الرمز»', 'الرمز منتهٍ أو ملغى أو صادر لتطبيق آخر. أصدر رمزاً جديداً.'],
                                    ['«الرمز صالح لكنه لا يحمل الصلاحيتين المطلوبتين»', 'أصدره من جديد وفعّل `whatsapp_business_messaging` و`whatsapp_business_management`.'],
                                    ['«لا يستطيع هذا الرمز قراءة رقم الهاتف»', 'راجع **معرّف رقم الهاتف**، وتأكد أن مستخدم النظام يملك حساب واتساب هذا.'],
                                    ['«لم تؤكد ميتا اشتراك التطبيق في أحداث حساب واتساب للأعمال هذا»', 'راجع **معرّف حساب واتساب للأعمال**.'],
                                    ['«هذا الرقم متصل بمساحة عمل أخرى»', 'افصله من هناك أولاً.'],
                                    ['«تعذّر الوصول إلى ميتا، ولم يُحفظ شيء»', 'مشكلة مؤقتة عند ميتا. أعد المحاولة بعد قليل.'],
                                ] }]],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['**Verify and save** is greyed out', 'The verify token box is empty. Paste into it the token from **Settings** → **Webhook verify token**, in the Default workspace.'],
                                ['“No permissions available” shows while I generate the token', 'The app isn’t assigned to the system user. Open **System users**, press **Assign assets** and give it the app with full control, then try **Generate token** again.'],
                                ['The app isn’t in the list of assets', 'Add the app `847772258381375` to the business portfolio in Business Settings, then go back to **Assign assets**.'],
                                ['Nothing arrives and the inbox is empty', { ul: [
                                    'The seven fields aren’t subscribed on the Configuration page at Meta. See [[whatsapp#meta-setup]].',
                                    'The number isn’t connected here: open **Settings** → **WhatsApp** and check the status says **Connected**.',
                                    'The number is connected in another workspace: disconnect it there first.',
                                ] }],
                                ['The dashboard refuses to connect', ['The dashboard writes the reason itself under the field it is about, and adds Meta’s own words beneath it. These are the common messages:', { dl: [
                                    ['“Meta refused this token: it may be expired, revoked or issued to another app.”', 'Issue a new token.'],
                                    ['“The token is valid but lacks the two permissions required.”', 'Issue it again with `whatsapp_business_messaging` and `whatsapp_business_management` ticked.'],
                                    ['“This token cannot read the phone number.”', 'Check the **Phone number ID**, and that the system user owns this WhatsApp account.'],
                                    ['“Meta did not confirm the app’s subscription to this WhatsApp Business Account’s events.”', 'Check the **WhatsApp Business Account ID**.'],
                                    ['“This number is connected to another workspace.”', 'Disconnect it there first.'],
                                    ['“Meta could not be reached, and nothing was saved.”', 'A temporary problem at Meta. Try again in a moment.'],
                                ] }]],
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 5c. Ads ─────────────────────────────────────────────────────────
        {
            slug: 'ads',
            group: 'ads',
            icon: 'megaphone',
            title: { ar: 'الإعلانات', en: 'Ads' },
            summary: {
                ar: 'ربط حسابك الإعلاني برمز مستخدم النظام، وقاعدة المال التي تحمي ميزانيتك، والتنبيهات، وحالة الحساب، وحلول المشكلات.',
                en: 'Connect your ad account with a system-user token, the money rule that protects your budget, the alerts, account health and fixes.',
            },
            related: ['connect-meta', 'troubleshooting'],
            sections: [
                {
                    id: 'connect',
                    title: { ar: 'اربط حسابك الإعلاني: أنشئ رمز مستخدم النظام', en: 'Connect your ad account: create a system-user token' },
                    body: {
                        ar: [
                            'تعمل الإعلانات في أوتوريبلاي برو برمز وصول خاص بك أنت، من حساب ميتا للأعمال الذي يملك الحساب الإعلاني. والرمز يُنشأ من «مستخدم نظام»، أي حساب تقني داخل ميتا للأعمال لا يرتبط بشخص ولا تنتهي صلاحيته بتغيير كلمة سر. الخطوات نفسها للمالك ولكل عميل يدير حسابه هنا.',
                            { ol: [
                                'افتح **إعدادات الأعمال** في ميتا (Business Settings)، ثم **المستخدمون** ثم **مستخدمو النظام**.',
                                'اضغط **إضافة**، واكتب اسماً (مثلاً «أوتوريبلاي»)، واختر الدور **مسؤول** أو **موظف**، ثم أنشئه.',
                                'اضغط **إسناد الأصول** للمستخدم الجديد، وأسند إليه ثلاثة أصول: **الحساب الإعلاني** مع الصلاحية **إدارة الحملات** (أو التحكم الكامل)، والصفحة، و**حساب إنستجرام**.',
                                'اضغط **إنشاء رمز جديد** (Generate new token)، واختر التطبيق الذي تحدده لك منصة أوتوريبلاي (يذكر مدير المنصة اسمه).',
                                'في **انتهاء صلاحية الرمز** اختر **أبداً** (Never).',
                                'علّم الأذونات الخمسة الآتية ثم أنشئ الرمز وانسخه مباشرة، فلن تعرض ميتا الرمز مرة أخرى.',
                                'في أوتوريبلاي افتح **الإعدادات** ثم **الاتصالات** ثم **إعلانات ميتا (الترويج)**، والصق الرمز في خانة **رمز إعلانات مستخدم النظام**، وأدخل **معرّف الحساب الإعلاني**، ثم اضغط **احفظ**.',
                                'اضغط **اختبر الاتصال**. تقرأ أوتوريبلاي ما يستطيع الرمز الوصول إليه، وتعرض الأذونات الناقصة والأصول المُسندة (الحسابات الإعلانية والصفحات وحسابات إنستجرام). إن ظهر نقص فعالجه في ميتا ثم أعد الاختبار.',
                            ] },
                            { dl: [
                                ['`ads_management`', 'إنشاء الحملات وتعديلها وإيقافها، وهو ما يحتاجه حارس الإنفاق ليوقف الحملات.'],
                                ['`ads_read`', 'قراءة الإنفاق والنتائج.'],
                                ['`business_management`', 'قراءة الأصول المُسندة إلى الرمز، وهي ما يعرضه **اختبر الاتصال**.'],
                                ['`pages_read_engagement`', 'قراءة منشورات الصفحة التي يُروَّج لها.'],
                                ['`pages_manage_ads`', 'استخدام الصفحة داخل الإعلانات.'],
                            ] },
                            'ولمعرفة **معرّف الحساب الإعلاني**: افتح مدير الإعلانات (Ads Manager) وانظر في عنوان الصفحة، فالرقم الذي يلي `act=` هو المعرّف. أو افتح **إعدادات الأعمال** ثم **الحسابات** ثم **الحسابات الإعلانية**، فيظهر المعرّف تحت اسم كل حساب.',
                            { warn: 'الرمز يعمل مثل كلمة السر: من يملكه يستطيع الإنفاق من حسابك الإعلاني. لا ترسله في محادثة ولا بريد ولا لقطة شاشة، ولا تعطه لأحد. يلصقه كل عميل بنفسه في لوحته، وتحفظه أوتوريبلاي مشفّراً ولا تعرضه بعد الحفظ.' },
                            { tip: 'لا حاجة إلى زر «اتصال عبر فيسبوك» لتعمل الإعلانات. هو خيار إضافي للمالك، ورمزه ينتهي بعد نحو 60 يوماً. أما رمز مستخدم النظام فلا ينتهي، ولهذا نوصي به.' },
                        ],
                        en: [
                            'Ads in AutoReply Pro run on an access token that belongs to you, from the Meta business that owns the ad account. The token is made from a “system user”, a technical account inside Meta Business that is not tied to a person and does not stop working when someone changes a password. The steps are the same for the owner and for every workspace that manages its own account here.',
                            { ol: [
                                'Open **Business Settings** in Meta, then **Users**, then **System users**.',
                                'Press **Add**, type a name (for example “AutoReply”), choose the **Admin** or **Employee** role, and create it.',
                                'Press **Assign assets** for the new system user and assign three assets: the ad account with **Manage campaigns** (or full control), the **Page**, and the **Instagram account**.',
                                'Press **Generate new token**, and choose the app that your AutoReply platform names (the platform administrator tells you which).',
                                'For **Token expiration**, choose **Never**.',
                                'Tick the five permissions listed below, generate the token and copy it at once. Meta never shows it a second time.',
                                'In AutoReply open **Settings**, then **Connections**, then **Meta ads (Boost)**, paste the token into **System-user ads token**, enter the **Ad account ID**, and press **Save**.',
                                'Press **Test connection**. AutoReply reads what the token can reach and shows the permissions that are missing and the assets assigned to it (ad accounts, Pages and Instagram accounts). If something is missing, fix it in Meta and test again.',
                            ] },
                            { dl: [
                                ['`ads_management`', 'Create, edit and pause campaigns. The spending guard needs it to pause campaigns.'],
                                ['`ads_read`', 'Read spend and results.'],
                                ['`business_management`', 'Read the assets assigned to the token, which is what **Test connection** lists.'],
                                ['`pages_read_engagement`', 'Read the posts of the Page being promoted.'],
                                ['`pages_manage_ads`', 'Use the Page inside ads.'],
                            ] },
                            'To find the ad account ID: open Ads Manager and look at the address of the page. The number after `act=` is the ID. Or open **Business Settings**, then **Accounts**, then **Ad accounts**, where the ID sits under each account’s name.',
                            { warn: 'The token is like a password: whoever holds it can spend from your ad account. Never send it in a chat, an email or a screenshot, and never hand it to anyone. Each workspace owner pastes it themselves into their own dashboard, and AutoReply stores it encrypted and never shows it again after saving.' },
                            { tip: 'Ads do not need the “Connect with Facebook” button. That is an optional extra for the owner, and its token expires after about 60 days. A system-user token does not expire, which is why we recommend it.' },
                        ],
                    },
                },
                {
                    id: 'limits',
                    title: { ar: 'الحدود وقاعدة المال', en: 'Limits and the money rule' },
                    body: {
                        ar: [
                            'هناك قاعدة واحدة للمال، وكل الشاشات تحسبها بالطريقة نفسها: الإنفاق هذا الشهر + أقصى ما يمكن أن تنفقه الميزانيات الجارية لبقية الشهر + ما توشك أن تفعّله الآن يجب أن يبقى عند سقفك الشهري أو دونه. وبالتفصيل:',
                            { ul: [
                                'الإنفاق هذا الشهر هو إنفاق الحساب الإعلاني كله، بكل حملاته، ومنها ما أُنشئ في مدير إعلانات ميتا لا في أوتوريبلاي.',
                                'أقصى ما يمكن أن تنفقه الميزانيات الجارية يُحسب لكل حملة نشطة. وميتا قد تنفق في يوم واحد حتى 75% فوق الميزانية اليومية، فالميزانية اليومية «متوسط في اليوم، وقد يصل إلى +75% في يوم». لذلك يُحسب اليوم الحالي بنحو 1.75 ضعف الميزانية اليومية، وبقية الأيام بالميزانية نفسها.',
                                'ما توشك أن تفعّله هو الحملة أو الترويج الذي تضغط عليه **فعّل** الآن.',
                            ] },
                            'إن كان المجموع فوق سقفك رُفض التفعيل بالرمز `OVER_MONTHLY_CAP`، وتظهر لك الشاشة المبلغ المتبقي الذي يمكنك إضافته. وإن ضبطت السقف عند الإنفاق الحالي أو دونه، تحذّرك الشاشة عند الحفظ، ويوقف الحارس كل الحملات النشطة في الحال.',
                            { dl: [
                                ['**سقف الإنفاق الشهري**', 'أكبر مبلغ تسمح به لهذا الشهر في الحساب الإعلاني. يبدأ الشهر وينتهي بحسب المنطقة الزمنية للحساب الإعلاني نفسه، لا بتوقيتك.'],
                                ['**أقصى ميزانية يومية**', 'لا يجوز أن تتجاوز ميزانية أي مجموعة إعلانية هذا الحد في اليوم. والميزانية الإجمالية تُقسم على عدد الأيام وتُقارن به.'],
                                ['سقف المنصة', 'إن كنت عميلاً مُدارَ الحساب فلمدير المنصة سقف لا يجوز أن يتجاوزه حداك. وإن حاولت تجاوزه ظهر لك الحد المسموح.'],
                                ['**حدّ إنفاق الحساب (لدى ميتا)**', 'حد تضعه ميتا نفسها على الحساب الإعلاني، وهو شبكة أمان ثانية فوق سقفك. يمكنك ضبطه أو إزالته من **الإعدادات**، بتأكيد منك، وبحد أقصى 10 تغييرات في اليوم. وتعرض الشاشة عدد التغييرات المتبقية اليوم.'],
                            ] },
                            { note: 'كل أرقام الإنفاق بدون ضريبة، وفواتير ميتا هي السجل المحاسبي الرسمي. قد يختلف المبلغ المخصوم في فاتورتك قليلاً عمّا تراه هنا.' },
                        ],
                        en: [
                            'There is one money rule, and every screen works it out the same way: this month’s spend + the most the running budgets can still spend this month + what you are about to switch on must stay at or below your monthly cap. In detail:',
                            { ul: [
                                'This month’s spend is the spend of the whole ad account, every campaign in it, including ones made in Meta Ads Manager and not in AutoReply.',
                                'The most the running budgets can still spend is worked out for each active campaign. Meta may spend up to 75% over a daily budget on one day, so a daily budget is “average per day, may reach +75% on a day”. Today is therefore counted at about 1.75 times the daily budget, and every other remaining day at the budget itself.',
                                'What you are about to switch on is the campaign or boost you are pressing **Activate** on right now.',
                            ] },
                            'If the total is above your cap, activation is refused with the code `OVER_MONTHLY_CAP`, and the screen shows the remaining amount you can still add. If you set the cap at or below the spend so far, the screen warns you when you save, and the guard pauses every active campaign at once.',
                            { dl: [
                                ['**Monthly spend cap**', 'The most you allow for this month in the ad account. The month starts and ends by the time zone of the ad account itself, not yours.'],
                                ['**Max daily budget**', 'No ad set may have a daily budget above this. A lifetime budget is divided by its number of days and compared with it.'],
                                ['Platform ceiling', 'If your account is managed, the platform administrator sets a ceiling that your two limits may not exceed. If you try, the screen tells you the allowed value.'],
                                ['**Account spending limit (at Meta)**', 'A limit Meta itself puts on the ad account, a second safety net above your cap. You can set or remove it in **Settings**, with a confirmation, at most 10 changes a day. The screen shows how many changes are left today.'],
                            ] },
                            { note: 'Every spend figure is excluding tax, and Meta’s invoices are the accounting record. The amount charged on your invoice may differ slightly from what you see here.' },
                        ],
                    },
                },
                {
                    id: 'alerts',
                    title: { ar: 'التنبيهات', en: 'Alerts' },
                    body: {
                        ar: [
                            'ترسل أوتوريبلاي تنبيهاً حين يحدث ما يستحق انتباهك. هذه هي الأنواع بالأسماء التي تعرضها خانات الاختيار في **الإعدادات** ← **إعلانات ميتا (الترويج)** ← **مستلمو التنبيهات**، وما يعنيه كل منها:',
                            { ul: [
                                '**إيقاف الحملات لأن السقف بُلغ:** أوقف الحارس كل الحملات النشطة لأن إنفاق هذا الشهر بلغ سقفك الشهري، أو لأن يوماً آخر من الإنفاق سيتجاوزه. مطلوب: لا يمكن إيقافه.',
                                '**مشكلات الدفع:** على الحساب مبلغ مستحق لم يُدفع، أو هو في مهلة سداد، أو لا توجد فيه وسيلة دفع صالحة.',
                                '**تعطيل الحساب الإعلاني:** عطّلت ميتا الحساب، أو هو قيد الإغلاق أو مغلق.',
                                '**رفض إعلان:** يُرسَل حين يجد التحديث الذي يقرأ حسابك الإعلاني كل ساعة أن حالة أحد إعلاناتك تغيّرت عند ميتا إلى **مرفوض**، مرة واحدة لكل إعلان في اليوم، إلى محادثة تيليجرام و/أو بريدك الإلكتروني كباقي التنبيهات، ومعه سبب ميتا إن ذكرت سبباً. ولا يُعلَن إلا هذا التغيّر: فلا يُرسَل عن إعلان يبقى مرفوضاً أو يُقبل من جديد، ولا عن إعلان كان مرفوضاً أصلاً حين قرأ التطبيق الحساب أول مرة، ولا عن إعلان أُنشئ في مدير إعلانات ميتا (Ads Manager) وكان مرفوضاً حين رآه التطبيق أول مرة. وكل إعلان مرفوض الآن تجده في قائمة **يحتاج إلى انتباه** في شاشة الإعلانات، ويبقى قالب القاعدة **إعلان مرفوض ← نبّهني** بديلاً: [[ads#rule-templates]].',
                                '**وجود مشكلات في إعلان:** يُرسَل بالشروط نفسها حين يجد التحديث الذي يقرأ حسابك الإعلاني كل ساعة أن حالة أحد إعلاناتك تغيّرت عند ميتا إلى **به مشكلات**: مرة واحدة لكل إعلان في اليوم، ومعه سبب ميتا إن ذكرت سبباً، ولا يُعلَن إلا هذا التغيّر، فلا يُرسَل عن إعلان كان على هذه الحال حين رآه التطبيق أول مرة. ويغطيه قالب القاعدة نفسه: [[ads#rule-templates]].',
                                '**توقف وصول الإعلانات عن العمل:** رفضت ميتا الرمز لأنه انتهى أو أُلغي، فلا تستطيع أوتوريبلاي قراءة الحساب ولا إيقاف الحملات. مطلوب: لا يمكن إيقافه.',
                                '**قرب انتهاء وصول الإعلانات:** ينتهي الرمز خلال 14 يوماً. يخص الرموز التي لها تاريخ انتهاء، مثل رمز الاتصال عبر فيسبوك.',
                                '**الإنفاق غير مُراقَب:** لم يستطع الحارس فحص سقفك الشهري ساعتين متتاليتين، فتواصل الحملات النشطة الإنفاق دون أن يوقفها السقف. مطلوب: لا يمكن إيقافه.',
                                '**تغيّر إصدار واجهة ميتا الذي تجيب عليه:** ردّت ميتا بإصدار غير الإصدار الذي نثبّته، فقد تختلف بعض السلوكيات.',
                                '**تولّى ذكاء ميتا للأعمال محادثة (لا يستطيع المساعد الرد):** ذكاء ميتا نفسها يتولى محادثة على إنستجرام ويرفض رسائل المساعد فيها. التفاصيل في [[ads#business-ai]].',
                                '**رفضت ميتا ردًّا خارج النافذة (أُطفئت النافذة الأطول):** رُفض رد في محادثة بدأت من إعلان لأنه خارج نافذة المراسلة، فأطفأ التطبيق النافذة الأطول لتلك المنصة من تلقاء نفسه. التفاصيل في [[ads#reply-window]].',
                                '**اقترح Claude تغييرات على إعلاناتك الجارية (المراجعة اليومية):** أعدّت المراجعة اليومية مقترحات. لا يتغير شيء ولا يُنفَق شيء قبل أن توافق، وتنتهي صلاحيتها بعد 7 أيام. التفاصيل في [[ads#ai-proposals]].',
                                '**نفّذت قاعدة إجراءً: إيقافًا أو خفضًا أو مقترحًا أو تنبيهًا:** طابقت إحدى قواعدك إعلاناً أو مجموعة إعلانية أو حملة، ونفّذت ما ضبطتها عليه. التفاصيل في [[ads#rules]].',
                                '**قاعدة لا تراقب إعلاناتك منذ 24 ساعة:** لم تستطع القاعدة قراءة أرقام حديثة منذ يوم كامل، فلا تتخذ أي إجراء في هذه الأثناء، ويبقى السقف الشهري نافذاً. التفاصيل في [[ads#rules]].',
                            ] },
                            'لا يصلك التنبيه نفسه عن الشيء نفسه أكثر من مرة واحدة في اليوم، حتى لا تُغرَق بالرسائل.',
                            { ul: [
                                'يصل التنبيه إلى محادثة تيليجرام و/أو إلى بريدك الإلكتروني، وتحدّدهما في **الإعدادات** ← **إعلانات ميتا (الترويج)** ← **مستلمو التنبيهات**. ويصل إلى مدير المنصة نسخة منه.',
                                'ولمعرفة معرّف محادثتك في تيليجرام: افتح حساب التنبيهات الذي يعطيك اسمه مدير المنصة واضغط **Start**، ثم أرسل أي رسالة إلى `@userinfobot` فيردّ عليك برقم Id. الصقه في خانة **معرّف محادثة تيليجرام**.',
                                'اضغط **أرسل تنبيهاً تجريبياً** لتتأكد أن التنبيه يصلك. يحفظ الزر ما كتبته، ثم يرسل رسالة تجريبية واحدة، ويعرض بجانب تيليجرام والبريد هل أُرسلت أم فشلت أم أن القناة غير مُعدّة.',
                                'تحت **ما الذي تريد أن تُبلَّغ به** لكل نوع خانته، عدا ثلاثة عليها علامة **(مطلوب)**: لا يمكن إيقافها، لأنها التي تحمي مالك.',
                            ] },
                            { tip: 'ضع الوسيلتين معاً، تيليجرام وبريداً، إن كان الإنفاق كبيراً. فقد تفوتك رسالة واحدة.' },
                        ],
                        en: [
                            'AutoReply sends an alert when something happens that deserves your attention. These are the kinds, with the names the checkboxes under **Settings** → **Meta ads (Boost)** → **Alert recipients** give them, and what each one means:',
                            { ul: [
                                '**Campaigns paused because the cap was reached:** the guard paused every active campaign because this month’s spend reached your monthly cap, or one more day of spending would carry it past. Required: it cannot be switched off.',
                                '**Payment problems:** the account has an unpaid balance or is in a grace period, or it has no valid payment method.',
                                '**The ad account was disabled:** Meta disabled the account, or it is pending closure or closed.',
                                '**An ad was rejected:** sent when the hourly update of your ad account sees an ad change to **Rejected** at Meta, once per ad per day, to your Telegram chat and/or email like the other alerts, with Meta’s reason when Meta gives one. Only that change is announced: not an ad that stays rejected or is approved again, not an ad that was already rejected the first time AutoReply read the account, and not an ad made in Meta Ads Manager that was already rejected when AutoReply first saw it. Whatever is rejected right now is on the **Needs attention** list on the Ads screen, and the rule template **Ad rejected → tell me** stays an alternative: [[ads#rule-templates]].',
                                '**An ad has issues:** sent on the same terms when the hourly update sees an ad change to **With issues** at Meta: once per ad per day, with Meta’s reason when Meta gives one, and only for that change, never for an ad that already had issues when AutoReply first saw it. The same rule template covers it: [[ads#rule-templates]].',
                                '**The ads access stopped working:** Meta refused the token because it expired or was revoked, so AutoReply can neither read the account nor pause campaigns. Required: it cannot be switched off.',
                                '**The ads access is about to expire:** the token ends within 14 days. This applies to tokens with an end date, such as the Facebook Connect one.',
                                '**Spending is not being watched:** the guard could not check your monthly cap for two hours in a row, so active campaigns keep spending with nothing to stop them at the cap. Required: it cannot be switched off.',
                                '**Meta changed the API version it answers on:** Meta answered with a version other than the one we pin, so some behaviour may differ.',
                                '**Meta Business AI took over a conversation (the assistant cannot reply):** Meta’s own assistant holds an Instagram conversation and refuses the AutoReply assistant’s messages in it. See [[ads#business-ai]].',
                                '**Meta refused a reply outside the window (the longer window was switched off):** a reply in a conversation that began from an ad was refused for being outside the messaging window, so the app switched the longer window off for that platform by itself. See [[ads#reply-window]].',
                                '**Claude proposed changes to your running ads (the daily review):** the daily review made proposals. Nothing changes or spends until you approve, and they expire after 7 days. See [[ads#ai-proposals]].',
                                '**A rule paused, lowered, proposed or told you something:** one of your rules matched an ad, an ad set or a campaign and did what you set it to do. See [[ads#rules]].',
                                '**A rule has not watched your ads for 24 hours:** the rule could not read fresh numbers for a day, so it takes no action meanwhile. The monthly cap still applies. See [[ads#rules]].',
                            ] },
                            'You never get the same alert about the same thing more than once a day, so you are not flooded.',
                            { ul: [
                                'An alert goes to your Telegram chat id and/or your email, both set in **Settings** → **Meta ads (Boost)** → **Alert recipients**. The platform administrator gets a copy.',
                                'To find your Telegram chat id: open the alerts account whose name the platform administrator gives you and press **Start**, then send any message to `@userinfobot`, which replies with your Id. Paste it into **Telegram chat ID**.',
                                'Press **Send a test** to be sure the alert reaches you. It saves what you typed, sends one test message, and shows beside Telegram and Email whether it was sent, failed or is not set up.',
                                'Under **What to be told about**, each kind has its own checkbox, except three marked **(required)**: they cannot be switched off, because they are the ones that protect your money.',
                            ] },
                            { tip: 'Set both, Telegram and email, if the spend is large. A single message can be missed.' },
                        ],
                    },
                },
                {
                    id: 'account-health',
                    title: { ar: 'حالة الحساب الإعلاني', en: 'Account health' },
                    body: {
                        ar: [
                            'تفحص أوتوريبلاي الحساب الإعلاني مرة كل يوم، وتعرض حالته في **الإعلانات** و**الإعدادات**. هذه حالات ميتا بكلمات بسيطة، وما تفعله في كل حالة:',
                            { dl: [
                                ['1 نشط', 'كل شيء سليم.'],
                                ['2 معطّل', 'عطّلت ميتا الحساب، ويظهر السبب. افتح **جودة الحساب** في ميتا وقدّم اعتراضاً. لا يمكن إنشاء إعلانات ولا تشغيلها حتى يُعاد تفعيله.'],
                                ['3 غير مسوّى', 'عليك مبلغ مستحق ولم يُدفع. ادفعه من صفحة الفوترة في ميتا.'],
                                ['7 قيد مراجعة المخاطر', 'تراجع ميتا الحساب. انتظر، وتجنّب إنشاء حساب جديد. يصلك الجواب في ميتا.'],
                                ['8 قيد التسوية', 'تُعالج ميتا دفعة قريبة. يعود الحساب نشطاً عادة خلال ساعات.'],
                                ['9 في فترة سماح', 'تأخرت دفعة، وما زال الحساب يعمل مؤقتاً. ادفع قبل أن تنتهي المهلة.'],
                                ['100 قيد الإغلاق', 'سيُغلق الحساب. إن كان ذلك خطأً فاتصل بدعم ميتا قبل أن يكتمل.'],
                                ['101 مغلق', 'الحساب مغلق نهائياً. استخدم حساباً إعلانياً آخر.'],
                                ['201 و202', 'قيمتان تستعملهما ميتا للاستعلام: «أي حساب نشط» و«أي حساب مغلق». لا يظهران لحساب بعينه.'],
                            ] },
                            { ul: [
                                '**لا توجد وسيلة دفع**: لا يُفعَّل أي إعلان. أضفها من ميتا (الفوترة)، فأوتوريبلاي لا تستطيع إضافة وسيلة دفع عنك.',
                                'حساب مسبق الدفع: يُخصم الإنفاق من رصيد دفعته. إن نفد الرصيد توقف الإنفاق حتى تشحنه. تعرض الشاشة ذلك.',
                                'الفحص اليومي: يقرأ حالة الحساب وسبب التعطيل ووسيلة الدفع (موجودة أو لا) وحد الإنفاق والمبلغ المُنفَق وصلاحية الرمز، ولا يقرأ أرقام البطاقات. وإذا وجد مشكلة أرسل لك تنبيهاً.',
                            ] },
                        ],
                        en: [
                            'AutoReply checks the ad account once a day and shows its status in **Ads** and **Settings**. These are Meta’s statuses in plain words, and what to do in each:',
                            { dl: [
                                ['1 Active', 'Everything is fine.'],
                                ['2 Disabled', 'Meta disabled the account, and the reason is shown. Open **Account Quality** in Meta and appeal. No ads can be created or run until it is reactivated.'],
                                ['3 Unsettled', 'An amount is due and has not been paid. Pay it on Meta’s billing page.'],
                                ['7 Pending risk review', 'Meta is reviewing the account. Wait, and avoid opening a new account. The answer arrives in Meta.'],
                                ['8 Pending settlement', 'Meta is processing a recent payment. The account usually returns to active within hours.'],
                                ['9 In grace period', 'A payment is late and the account still runs for now. Pay before the grace period ends.'],
                                ['100 Pending closure', 'The account is about to close. If that is a mistake, contact Meta support before it completes.'],
                                ['101 Closed', 'The account is closed for good. Use another ad account.'],
                                ['201 and 202', 'Two values Meta uses for queries: “any active” and “any closed”. They do not show up for one particular account.'],
                            ] },
                            { ul: [
                                '**No payment method**: no ad can be switched on. Add one in Meta (billing); AutoReply cannot add a payment method for you.',
                                'Prepay account: spend is taken from a balance you paid in. When it runs out, spending stops until you top it up. The screen says so.',
                                'The daily check reads the account status, the disable reason, the payment method (present or not), the spending limit, the amount spent and whether the token works. It does not read card numbers. If it finds a problem, it sends you an alert.',
                            ] },
                        ],
                    },
                },
                // ── A2: the stored copy, the queue and the statuses ──
                {
                    id: 'campaigns',
                    title: { ar: 'تبويب الحملات', en: 'The Campaigns tab' },
                    body: {
                        ar: [
                            'يعرض تبويب **الحملات** كل ما في حسابك الإعلاني: الحملات، وتحت كل حملة مجموعاتها الإعلانية، وتحت كل مجموعة إعلاناتها. ويشمل ذلك ما أنشأته من هنا بزر **ترويج**، وما أنشأته في مدير إعلانات ميتا نفسه.',
                            { ul: [
                                'الأرقام والحالات نسخة محفوظة لدينا، لا قراءة مباشرة من ميتا في كل مرة. تُحدَّث البنية كل ساعة، ونتائج اليوم كل أربع ساعات، ونتائج آخر 28 يوماً مرة في اليوم. ويظهر وقت آخر تحديث أعلى الصفحة.',
                                'زر **تحديث النتائج** يقرأ الآن قائمة الحملات ونتائج اليوم، مرة كل 15 دقيقة على الأكثر.',
                                'نتائج آخر ثلاثة أيام مبدئية: قد تعدّلها ميتا قليلاً حتى تستقر.',
                                'كل مبلغ يُعرض دون الضريبة؛ فواتير ميتا هي السجل المحاسبي.',
                            ] },
                            'في كل صف تجد الحالة بكلمات واضحة، وأسباب المراجعة إن رُفض الإعلان، والميزانية مع عدد التغييرات المتبقية لها في هذه الساعة، ثم الأزرار:',
                            { dl: [
                                ['**إيقاف مؤقت**', 'يوقف الصرف. لا يحتاج تأكيداً.'],
                                ['**استئناف**', 'يعيد الصرف، لذلك يطلب تأكيداً ويتحقق من حدّك الشهري قبل الإرسال.'],
                                ['**تعديل الميزانية**', 'رفع ميزانية حملة تعمل يطلب تأكيداً. ولكل مجموعة إعلانية أربعة تغييرات في الساعة.'],
                                ['**أرشفة**', 'الطريقة المعتادة لإنهاء حملة: تتوقف وتبقى نتائجها محفوظة.'],
                                ['**حذف**', 'إجراء منفصل بتأكيد مستقل، ولا يُتاح والحملة تعمل.'],
                            ] },
                            { note: 'التغيير لا يظهر في ميتا في اللحظة نفسها دائماً؛ انظر [[ads#queued-changes|التغييرات في الانتظار]].' },
                        ],
                        en: [
                            'The **Campaigns** tab shows everything in your ad account: campaigns, their ad sets under each, and the ads under each ad set. That includes what you made here with **Boost** and what you made in Meta Ads Manager itself.',
                            { ul: [
                                'Numbers and statuses are a stored copy, not a live read from Meta on every view. The structure refreshes every hour, today\'s results every four hours, and the last 28 days once a day. The time of the last update is at the top of the page.',
                                '**Refresh results** reads the campaign list and today\'s results now, at most once every 15 minutes.',
                                'Results for the last three days are provisional: Meta may still revise them slightly.',
                                'Every amount is shown excluding tax; Meta\'s invoices are the accounting record.',
                            ] },
                            'Each row shows the status in plain words, the review reasons if an ad was rejected, the budget with how many changes it has left this hour, then the buttons:',
                            { dl: [
                                ['**Pause**', 'Stops spending. No confirmation needed.'],
                                ['**Resume**', 'Starts spending again, so it asks you to confirm and checks your monthly cap before it is sent.'],
                                ['**Edit budget**', 'Raising the budget of a running campaign asks you to confirm. Each ad set allows four budget changes an hour.'],
                                ['**Archive**', 'The normal way to end a campaign: it stops and its results stay.'],
                                ['**Delete**', 'A separate action with its own confirmation, not offered while the campaign is running.'],
                            ] },
                            { note: 'A change does not always reach Meta the same second; see [[ads#queued-changes|Queued changes]].' },
                        ],
                    },
                },
                {
                    id: 'queued-changes',
                    title: { ar: 'التغييرات في الانتظار', en: 'Queued changes' },
                    body: {
                        ar: [
                            'كل تغيير ترسله إلى ميتا (إيقاف، استئناف، ميزانية، أرشفة، حذف) يدخل قائمة انتظار ويُرسل بالترتيب. إن كان ممكناً يُرسل فوراً، وإلا تراه في شريط «تغييرات في الانتظار» مع «الوقت المتوقع».',
                            'لماذا الانتظار؟ لأن ميتا تحدّ عدد الطلبات المسموح بها لكل حساب إعلاني في المستوى المحدود (Limited)، وتوقف الحساب خمس دقائق إن تجاوزها. ولذلك ننظّم الطلبات حتى لا يتوقف شيء، بما فيه حارس الحد الشهري.',
                            { dl: [
                                ['أربعة تغييرات للميزانية في الساعة', 'لكل مجموعة إعلانية. التغيير الخامس ينتظر حتى تمر ساعة على أقدمها.'],
                                ['30 ثانية بين تغييرين', 'على الحملة أو المجموعة أو الإعلان نفسه.'],
                                ['عشرة تغييرات لحد الإنفاق في اليوم', 'لحد إنفاق الحساب في ميتا، بتوقيت الحساب الإعلاني.'],
                            ] },
                            { ul: [
                                '**في الانتظار**: لم يُرسل بعد، وسيُرسل في الوقت المتوقع أو بعده بقليل.',
                                '**قيد الإرسال**: يُرسل الآن.',
                                '**قيد التحقق**: لم تصل إجابة ميتا، فنقرأ الحساب لنتأكد هل تم التغيير. لا نعيد إرسال إنشاء أبداً دون هذا التحقق، حتى لا تتكرر حملة.',
                                '**تم** أو **فشل**: مع سبب الفشل بكلمات واضحة.',
                            ] },
                            { tip: 'لا تكرر الضغط على الزر: الطلب نفسه محفوظ مرة واحدة، والضغط مرة أخرى لا يرسله مرتين.' },
                        ],
                        en: [
                            'Every change you send to Meta (pause, resume, budget, archive, delete) goes into a queue and is sent in order. When it can go now, it goes now; otherwise you see it in the “Queued changes” strip with an **expected at** time.',
                            'Why a queue? On the Limited access tier Meta caps the requests each ad account may make, and blocks the account for five minutes when the cap is passed. The queue paces requests so nothing stops, including the monthly-cap guard.',
                            { dl: [
                                ['Four budget changes an hour', 'Per ad set. The fifth waits until the oldest is an hour old.'],
                                ['30 seconds between two changes', 'On the same campaign, ad set or ad.'],
                                ['Ten spending-limit changes a day', 'For the account spending limit at Meta, in the ad account\'s time zone.'],
                            ] },
                            { ul: [
                                '**Queued**: not sent yet; it goes at the expected time or shortly after.',
                                '**Sending**: being sent now.',
                                '**Checking**: Meta\'s answer did not arrive, so we read the account to see whether the change landed. A create is never sent again without this check, so a campaign is never made twice.',
                                '**Done** or **Failed**: with the reason in plain words.',
                            ] },
                            { tip: 'No need to press the button again: the same request is stored once, and a second press does not send it twice.' },
                        ],
                    },
                },
                {
                    id: 'statuses',
                    title: { ar: 'معاني الحالات', en: 'What the statuses mean' },
                    body: {
                        ar: [
                            'الحالة المعروضة هي حالة التشغيل كما تراها ميتا، وهي التي تحدد هل يُصرف المال الآن:',
                            { dl: [
                                ['يعمل', 'يُعرض ويصرف من ميزانيته.'],
                                ['متوقف مؤقتاً', 'أوقفته أنت أو أوقفه الحارس. لا يصرف.'],
                                ['الحملة متوقفة / المجموعة متوقفة', 'العنصر نفسه سليم، لكن الحملة أو المجموعة التي فوقه متوقفة.'],
                                ['قيد المراجعة', 'ميتا تراجع الإعلان قبل عرضه، وقد يستغرق ذلك حتى 24 ساعة.'],
                                ['مرفوض', 'لم يجتز مراجعة ميتا. السبب يظهر تحت الإعلان؛ عدّل الإعلان ثم أعد المحاولة.'],
                                ['موافق عليه مسبقاً', 'اجتاز المراجعة وسيعمل عند بدء جدوله.'],
                                ['به مشكلات', 'يعمل جزئياً أو لا يعمل بسبب مشكلة تذكرها ميتا تحته.'],
                                ['قيد المعالجة', 'ميتا تطبّق تغييراً للتو.'],
                                ['بانتظار بيانات الدفع', 'لا توجد وسيلة دفع صالحة في الحساب الإعلاني؛ انظر [[ads#account-health]].'],
                                ['مؤرشف', 'انتهى ولا يصرف، ونتائجه محفوظة.'],
                                ['محذوف', 'حُذف من ميتا، أو لم يعد يظهر في الحساب في مزامنتين متتاليتين.'],
                            ] },
                        ],
                        en: [
                            'The status shown is the delivery status as Meta sees it, the one that decides whether money is being spent now:',
                            { dl: [
                                ['Active', 'Delivering and spending from its budget.'],
                                ['Paused', 'Paused by you or by the guard. Not spending.'],
                                ['Campaign paused / Ad set paused', 'This item is fine, but the campaign or ad set above it is paused.'],
                                ['In review', 'Meta is reviewing the ad before it runs; this can take up to 24 hours.'],
                                ['Rejected', 'It did not pass Meta\'s review. The reason is shown under the ad; edit the ad and try again.'],
                                ['Pre-approved', 'It passed review and will run when its schedule starts.'],
                                ['With issues', 'Running partly or not at all because of a problem Meta names under it.'],
                                ['Processing', 'Meta is applying a change right now.'],
                                ['Waiting for billing info', 'The ad account has no working payment method; see [[ads#account-health]].'],
                                ['Archived', 'Ended and not spending; its results are kept.'],
                                ['Deleted', 'Deleted at Meta, or no longer found in the account in two syncs in a row.'],
                            ] },
                        ],
                    },
                },
                // ── A4: message ads and the policy check ──
                {
                    id: 'create-message-ad',
                    title: { ar: 'أنشئ إعلان رسائل من ريلز', en: 'Create a message ad from a reel' },
                    body: {
                        ar: [
                            'إعلان الرسائل زرّه يفتح محادثة في إنستجرام أو ماسنجر أو واتساب بدل أن يفتح موقعاً، ويردّ المساعد على من يراسلك من الإعلان. تبدأ من منشور منشور فعلاً، وكل ما تنشئه هنا يُنشأ متوقفاً، فلا يُنفَق شيء حتى تفعّله أنت.',
                            'قبل أن تبدأ تأكّد من ثلاثة أمور: الحساب الإعلاني متصل وحدّاك مضبوطان ([[ads#connect]] و[[ads#limits]])، والمنشور منشور فعلاً (الأفضل ريلز على إنستجرام)، ووجهتك مستوفية شرطها:',
                            { dl: [
                                ['إنستجرام', 'حساب إنستجرام احترافي متصل بالصفحة.'],
                                ['ماسنجر', 'الصفحة نفسها. ولا يصلح منشور فيسبوك لإعلان ماسنجر حالياً، فاستخدم نسخة إنستجرام من الريلز.'],
                                ['واتساب', 'رقم واتساب للأعمال متصل بالصفحة.'],
                            ] },
                            { ol: [
                                'في **الجدولة** افتح منشوراً ثم اضغط **روّج**.',
                                'في **الهدف** اختر **إرسال رسائل**.',
                                'في **الوجهات** علّم وجهة واحدة أو أكثر.',
                                'اختر **الدول**، ثم **الميزانية اليومية** و**عدد الأيام**. يعرض النموذج الإجمالي (اليومية × الأيام)، وهو الميزانية الكاملة للإعلان ولا يتجاوزها ميتا. ويُفحص هذا الإجمالي أمام سقفك الشهري بالقاعدة نفسها في [[ads#limits]].',
                                'اقرأ نص الإعلان. هو وصف المنشور نفسه ويظهر للقراءة فقط. فإن حجبه فحص السياسة فاختر منشوراً آخر.',
                                'لا تكتب رسالة ترحيب هنا: لا تسمح ميتا بأن يحمل المنشور المروَّج ترحيباً خاصاً به، فتبدأ المحادثة بترحيب ميتا. وتظهر أسئلة البداية التي ضبطتها لإنستجرام في الإعدادات حين يفتح أحدٌ محادثة جديدة.',
                                'اضغط **راجع**. يعرض لك النموذج فحص السياسة ([[ads#policy-check]])، وفحص المال أمام المتبقي من سقف الشهر، وأدنى ميزانية تقبلها ميتا لحسابك، وأي تحذير آخر.',
                                'عدّل ما يحجبه الفحص، وإن بقيت تحذيرات فاقرأها ثم علّم **قرأت التحذيرات**. ثم اضغط **أنشئ متوقفاً**.',
                                'يُنشأ الإعلان متوقفاً ولا يُنفَق شيء. افتح **الإعلانات** واضغط **فعّل** حين تكون جاهزاً. تراجع ميتا الإعلان غالباً خلال 24 ساعة.',
                            ] },
                            { warn: 'يفحص النموذج المساعد في كل وجهة اخترتها. إن كان متوقفاً فلن يردّ أحد على من يراسلك من الإعلان. وإن كان مساعد واتساب في وضع التجربة فلن يردّ إلا على أرقام الاختبار. وإن كان البيع في الرسائل في وضع التجربة فسيردّ المساعد على الجميع لكنه لن يعرض البيع إلا على المختبرين. وإن لم تكن الوجهة متصلة فلا رد كذلك. فعِّل المساعد قبل تفعيل الإعلان: [[whatsapp#connect]] لواتساب، وإعدادات المساعد للرسائل في إنستجرام وماسنجر.' },
                            { note: 'في **راجع** تفحص ميتا الإعلان نفسه دون أن تنشئ شيئاً. فإن رفضت شيئاً ظهر سببها هناك، ولم يُنشأ شيء.' },
                            { tip: 'يردّ المساعد على المحادثات القادمة من الإعلان بقواعده المعتادة، وتُحسب كل محادثة للإعلان الذي بدأت منه، فترى أي إعلان يجلب رسائل أكثر.' },
                        ],
                        en: [
                            'A message ad has a button that opens a chat in Instagram, Messenger or WhatsApp instead of a website, and the assistant answers the people who message you from it. You start from a post that is already published, and everything you make here is created paused, so nothing is spent until you switch it on.',
                            'Before you start, check three things: the ad account is connected and your two limits are set ([[ads#connect]] and [[ads#limits]]), the post is published (a reel on Instagram works best), and the destination has what it needs:',
                            { dl: [
                                ['Instagram', 'An Instagram professional account connected to the Page.'],
                                ['Messenger', 'The Page itself. A Facebook post cannot be used for a Messenger ad yet, so use the Instagram copy of the reel.'],
                                ['WhatsApp', 'A WhatsApp Business number linked to the Page.'],
                            ] },
                            { ol: [
                                'In the **Scheduler**, open a post and press **Boost**.',
                                'Under **Goal**, choose **Send messages**.',
                                'Under **Destinations**, tick one or more.',
                                'Choose the **Countries**, then the **Daily budget** and the number of **Days**. The form shows the total (daily × days). That total is the ad’s whole budget, and Meta does not go over it. It is checked against your monthly cap by the same rule as in [[ads#limits]].',
                                'Read the ad text. It is the post’s own caption and is read-only here. If the policy check blocks it, choose another post.',
                                'There is no greeting to write here: Meta does not let a boosted post carry its own greeting, so the chat opens with Meta’s greeting. The ice breakers you set for Instagram in Settings still show when someone opens a new chat.',
                                'Press **Review**. The form shows the policy check ([[ads#policy-check]]), the money check against what is left of the month’s cap, the lowest budget Meta accepts for your account, and any other warning.',
                                'Fix whatever the check blocks. If warnings remain, read them and tick **I have read the warnings**. Then press **Create paused**.',
                                'The ad is created paused and nothing is spent. Open **Ads** and press **Activate** when you are ready. Meta usually reviews the ad within 24 hours.',
                            ] },
                            { warn: 'The form checks the assistant for each destination you chose. If it is off, nobody answers the people who message you from the ad. If the WhatsApp assistant is in test mode, only the test numbers get an answer. If sales in your DMs are in test mode, the assistant answers everyone but sells only to your testers. If the destination is not connected, there is no answer either. Switch the assistant on before you activate the ad: [[whatsapp#connect]] for WhatsApp, and the message assistant’s settings for Instagram and Messenger.' },
                            { note: 'In **Review**, Meta checks the ad itself without creating anything. If it refuses something, its reason shows there and nothing is created.' },
                            { tip: 'The same assistant rules answer chats that come from the ad, and each chat is counted for the ad it started from, so you can see which ad brings more messages.' },
                        ],
                    },
                },
                {
                    id: 'policy-check',
                    title: { ar: 'فحص السياسة: ما الذي يُحجب ولماذا', en: 'The policy check: what is blocked and why' },
                    body: {
                        ar: [
                            'قبل أي إنشاء يفحص أوتوريبلاي نص إعلانك بقواعد ثابتة تطابق ما ترفضه ميتا غالباً. السبب أن تكرار رفض الإعلانات قد يقيّد حسابك الإعلاني، وقد يمتد التقييد إلى الصفحة نفسها التي يعمل عليها المساعد. فمنع نص مخالف قبل إرساله أهون من تقييد الصفحة.',
                            { dl: [
                                ['حجب', 'تظهر العبارة مظلّلة مع سبب الرفض وبديل مقترح، ويتعطل زر **أنشئ متوقفاً** حتى تعدّل النص.'],
                                ['تحذير', 'يمكنك المتابعة بعد أن تعلّم **قرأت التحذيرات**. لكن اقرأه، فقد يغيّر مصير الإعلان.'],
                            ] },
                            'يفحص النموذج ما تكتبه (الترحيب وأسئلة البداية وردودها) ووصف المنشور، ويعيد الخادم الفحص قبل الإنشاء. لا يتصل الفحص بميتا ولا يكلّف شيئاً. واجتيازه لا يضمن قبول الإعلان: تراجع ميتا كل إعلان، وقد تعيد مراجعته بعد تشغيله.',
                            'القواعد المحجوبة، لكل واحدة نص مرفوض وبديل مقبول:',
                            { dl: [
                                ['أرقام الدخل', 'مرفوض: «اكسب 500$ يومياً». مقبول: «تعلّم بناء وكلاء الذكاء الاصطناعي خطوة بخطوة بمشاريع عملية».'],
                                ['الدخل السلبي والثراء والحرية المالية', 'مرفوض: «دخل سلبي من الإنترنت» و«ثراء سريع» و«حقق الحرية المالية». مقبول: «ابدأ رحلتك في البرمجة اليوم».'],
                                ['الجهد القليل', 'مرفوض: «بدون مجهود» و«اربح وأنت نائم». مقبول: «دورة عملية بخطوات واضحة للمبتدئين».'],
                                ['ترك الوظيفة', 'مرفوض: «اترك وظيفتك» و«بديل لراتبك». مقبول: «طوّر مهاراتك في البرمجة بجانب عملك».'],
                                ['النتائج المضمونة', 'مرفوض: «مضمون 100%» و«نتائج مضمونة». مقبول: «تدريب تطبيقي مع مشاريع كاملة».'],
                                ['وعود التوظيف', 'مرفوض: «احصل على وظيفة» و«وظيفة مضمونة». مقبول: «تعلّم الأدوات التي تعمل بها فرق البرمجة».'],
                                ['صفات الجمهور', 'مرفوض: «هل أنت عاطل عن العمل؟» و«ديونك؟». مقبول: «دورة في البرمجة للمبتدئين». لا تخاطب الجمهور بصفة فيه (دَين أو بطالة أو صحة أو عمر أو ديانة)، بل صِف ما في الدورة.'],
                            ] },
                            'هذه تُعرض تحذيراً لا حجباً:',
                            { dl: [
                                ['سؤال عن الجمهور', 'مثل «هل أنت مبرمج؟». ليست صفة محظورة نصاً، لكن المراجعين يطبّقون قاعدة «أنت + صفة» بسعة. مقبول: «تعلّم لغة Go خطوة بخطوة».'],
                                ['كلمة «معتمدة» عن الشهادة', 'مثل «شهادة معتمدة». قد يعدّها ميتا إعلان توظيف ويضيّق الاستهداف (فئة إعلانات خاصة: التوظيف، بعمر وجنس ثابتين وبلا استبعادات). الأسلم أن تصف ما يتعلمه الطالب، أو تقول «شهادة إتمام الدورة».'],
                                ['«لفترة محدودة» بلا تاريخ', 'مثل «عرض لفترة محدودة». مقبول: «الخصم ساري حتى 30 أكتوبر».'],
                            ] },
                            { note: 'وصف المنشور هو نص الإعلان عند الترويج، فإذا حُجب وصفه فاختر منشوراً آخر. وتراجع ميتا الصفحة التي يفتحها الإعلان أيضاً: لا تضع في صفحة المنتج التي يفتحها الإعلان أرقام دخل ولا وعوداً بالثراء.' },
                            { tip: 'القاعدة الجامعة: بِع المهارة لا المال. صِف ما سيتعلمه الطالب وما سيبنيه بيده، ولا تذكر ما سيربحه.' },
                            { warn: 'لا ترسل مراجعة جديدة في كل مرة يُرفض فيها إعلان. أصلح السبب أولاً ثم اطلب مراجعة واحدة، فكثرة الطلبات تبطّئ الرد وتضر الحساب.' },
                        ],
                        en: [
                            'Before anything is created, AutoReply checks your ad text against fixed rules that match what Meta most often rejects. The reason: repeated rejections can restrict your ad account, and the restriction can reach the same Page the assistant runs on. Stopping a bad text before it is sent costs far less than a restricted Page.',
                            { dl: [
                                ['Block', 'The phrase is highlighted with the reason and a suggested rewrite, and **Create paused** stays disabled until you change the text.'],
                                ['Warning', 'You can go on once you tick **I have read the warnings**. Read it first, because it can change what happens to the ad.'],
                            ] },
                            'The form checks what you write (the greeting, the ice breakers and their answers) and the post’s caption, and the server checks again before it creates anything. The check never calls Meta and costs nothing. Passing it does not guarantee approval: Meta reviews every ad, and may review it again after it is running.',
                            'The blocked patterns. Each one has a rejected example and an accepted rewrite (the Arabic phrases are examples of wording that gets blocked):',
                            { dl: [
                                ['Income figures', 'Rejected: “Earn $500 a day” («اكسب 500$ يومياً»). Accepted: “Learn to build AI agents step by step with hands-on projects”.'],
                                ['Passive income, getting rich, financial freedom', 'Rejected: “passive income”, “get rich quick”, “financial freedom” («دخل سلبي», «ثراء سريع»). Accepted: “Start your programming journey today”.'],
                                ['Minimal effort', 'Rejected: “no effort”, “while you sleep” («بدون مجهود», «وأنت نائم»). Accepted: “A hands-on course with clear steps for beginners”.'],
                                ['Quitting your job', 'Rejected: “quit your job”, “replace your salary” («اترك وظيفتك», «بديل لراتبك»). Accepted: “Grow your programming skills alongside your job”.'],
                                ['Guaranteed results', 'Rejected: “100% guaranteed”, “guaranteed results” («مضمون 100%»). Accepted: “Hands-on training with complete projects”.'],
                                ['Job promises', 'Rejected: “get a job”, “guaranteed job” («احصل على وظيفة»). Accepted: “Learn the tools programming teams work with”.'],
                                ['Attributes of the audience', 'Rejected: “Are you unemployed?”, “Your debts?” («هل أنت عاطل عن العمل؟», «ديونك؟»). Accepted: “A programming course for beginners”. Do not address the audience by an attribute (debt, unemployment, health, age, religion). Describe what is in the course.'],
                            ] },
                            'These show as warnings, not blocks:',
                            { dl: [
                                ['A question about the audience', 'Like “Are you a programmer?” («هل أنت مبرمج؟»). A profession is not a listed attribute, but reviewers apply the “you + attribute” rule widely. Accepted: “Learn Go step by step”.'],
                                ['“Accredited” certificate wording', 'Like “accredited certificate” («شهادة معتمدة»). Meta may treat it as an employment ad, which narrows targeting (a special ad category: Employment, with fixed age and gender and no exclusions). Safer: describe what the student learns, or say “certificate of completion”.'],
                                ['“Limited time” with no date', 'Like “limited-time offer” («عرض لفترة محدودة»). Accepted: “The discount runs until 30 October”.'],
                            ] },
                            { note: 'For a boosted post the caption is the ad text, so if its caption is blocked, choose another post. Meta also reviews the page the ad opens: keep income figures and get-rich promises off the product page the ad opens.' },
                            { tip: 'The rule behind all of them: sell the skill, not the money. Describe what the student will learn and build, and never what they will earn.' },
                            { warn: 'Do not file a new review request every time an ad is rejected. Fix the reason first, then ask for one review. Many requests slow the answer and hurt the account.' },
                        ],
                    },
                },
                {
                    id: 'message-ads-inbox',
                    title: { ar: 'المحادثات القادمة من إعلانات المراسلة', en: 'Conversations that come from message ads' },
                    body: {
                        ar: [
                            'إعلان المراسلة يفتح محادثة بدل أن يفتح موقعًا: يضغط الشخص على الإعلان فتُفتح له رسائل إنستجرام أو ماسنجر أو واتساب مع حسابك. وترسل ميتا مع أول رسالة معلومة صغيرة تقول من أي إعلان جاء، فتحفظها أوتوريبلاي مع المحادثة.',
                            { ul: [
                                'في **الرسائل** تظهر على المحادثة شارة «من إعلان: اسم الإعلان». والاسم هو اسم الإعلان كما تعرفه أوتوريبلاي، أو العنوان الذي أرسلته ميتا مع الضغطة إن لم يُزامَن الإعلان بعد.',
                                'زر التصفية **من الإعلانات** يُبقي المحادثات التي بدأت من إعلان، ومعها المحادثات القديمة التي عاد أصحابها عبر إعلان جديد (تظهر عليها **عاد عبر إعلان**).',
                                'يُحفظ لكل محادثة: معرّف الإعلان، ورمز التتبّع الذي تضعه أوتوريبلاي في إعلاناتها، وعنوان الإعلان وروابط صورته أو فيديوه كما أرسلتها ميتا. أول إعلان يبقى «مصدر» المحادثة ولا يتغيّر، وتُحفظ الضغطات اللاحقة (آخر عشر) دون أن تحلّ محله.',
                                'إن ضغط الشخص سؤالًا جاهزًا في الإعلان (Ice breaker)، يجيب المساعد عن السؤال الذي ضغطه كما لو كتبه بنفسه. وإن فتح المحادثة دون أن يكتب شيئًا، تُسجَّل الضغطة ولا يُرسل المساعد شيئًا.',
                            ] },
                            'وفي شاشة **الإعلانات** يظهر لكل إعلان ما لا تراه ميتا: عدد المحادثات التي بدأها، وكم مرة فتح أصحابها الروابط التي أرسلها المساعد، وكم منها حُوِّل إلى شخص. فتعرف تكلفة المحادثة وتكلفة الضغطة على الرابط لكل إعلان، حتى لو تمّ البيع في موقع آخر.',
                            { tip: 'رسائل ماسنجر من شخص له محادثة سابقة معك لا تصل إلا إن كان حقل `messaging_referrals` مفعّلًا في اشتراك الصفحة. أعد الاتصال بفيسبوك مرة واحدة بعد هذا التحديث ليُضاف.' },
                        ],
                        en: [
                            'A message ad opens a chat instead of a website: the person taps the ad and Instagram, Messenger or WhatsApp opens a conversation with your account. With the first message Meta sends a small note saying which ad it came from, and AutoReply stores it with the conversation.',
                            { ul: [
                                'In the **Inbox** the conversation shows a “From ad: ad name” badge. The name is the ad\'s name as AutoReply knows it, or the title Meta sent with the tap when the ad has not been synced yet.',
                                'The **From ads** filter keeps the conversations that began from an ad, and also older ones whose person came back through a new ad (they show **Came back from an ad**).',
                                'For each conversation it stores: the ad id, the tracking code AutoReply puts on its own ads, and the ad\'s title and image or video links as Meta sent them. The first ad stays the conversation\'s “source” and never changes; later taps (the last ten) are kept beside it.',
                                'If the person tapped a ready-made question on the ad (an ice breaker), the assistant answers that question as if they had typed it. If they opened the chat without writing anything, the tap is recorded and the assistant sends nothing.',
                            ] },
                            'On the **Ads** screen each ad shows what Meta cannot see: how many conversations it started, how often those people opened the links the assistant sent, and how many were handed to a person. So you know the cost per conversation and per link click for every ad, even when the sale happens on another site.',
                            { tip: 'On Messenger, a person who already had a conversation with you is only reported when the Page subscription includes `messaging_referrals`. Reconnect Facebook once after this update so it is added.' },
                        ],
                    },
                },
                {
                    id: 'bot-and-ads',
                    title: { ar: 'المساعد والإعلان: أعطِ المساعد سياق الإعلان', en: 'The assistant and the ad: give the assistant the ad\'s context' },
                    body: {
                        ar: [
                            'المفتاح **أعطِ المساعد سياق الإعلان** في **الإعلانات** داخل الإعدادات مطفأ في البداية. وما دام مطفأً، لا يتغيّر شيء في ما يُرسَل إلى المساعد: التعليمات نفسها حرفًا بحرف.',
                            'وعند تشغيله، وفي المحادثات التي بدأت من إعلان فقط، يُضاف إلى معلومات المحادثة سطر أو ثلاثة: اسم الإعلان والعرض الذي يتناوله، ونصّ الإعلان (حتى 200 حرف)، والسؤال الذي ضغطه الشخص إن ضغط سؤالًا. فيبدأ المساعد من حيث توقّف الإعلان بدل أن يسأل الشخص عمّا جاء من أجله.',
                            { ul: [
                                'يُعرف العرض إن أُنشئ الإعلان من أوتوريبلاي واختير له عرض. أما الإعلان المصنوع في مدير إعلانات ميتا فيعطي المساعد اسمه وعنوانه فقط.',
                                'لا تُعطى للمساعد روابط الصور ولا الفيديو، ولا معرّف الإعلان.',
                                'يعمل هذا في وضع البيع (Sales mode) للمساعد، على إنستجرام وماسنجر.',
                            ] },
                            { tip: 'للتجربة: شغّل المفتاح، ثم افتح معاينة الإعلان في مدير الإعلانات واضغط «إرسال رسالة» من حساب تجربة، واكتب سؤالًا عن السعر. ينبغي أن يذكر الرد الأول عرض الإعلان. ثم أطفئه إن لم يعجبك.' },
                        ],
                        en: [
                            'The **Give the assistant the ad\'s context** switch under **Ads** in Settings starts off. While it is off nothing changes in what the assistant is sent: the same instructions, word for word.',
                            'When it is on, and only in conversations that began from an ad, one to three lines are added to the conversation\'s facts: the ad\'s name and the offer it is about, the ad\'s text (up to 200 characters), and the question the person tapped, if they tapped one. So the assistant picks up where the ad left off instead of asking what they came for.',
                            { ul: [
                                'The offer is known when the ad was made in AutoReply with an offer chosen. An ad made in Meta\'s Ads Manager gives the assistant its name and title only.',
                                'The assistant is never given the image or video links, nor the ad id.',
                                'It works in the assistant\'s Sales mode, on Instagram and Messenger.',
                            ] },
                            { tip: 'To try it: turn the switch on, open the ad\'s preview in Ads Manager, press “Send message” from a test account and ask about the price. The first reply should mention the ad\'s offer. Turn it off again if you do not like it.' },
                        ],
                    },
                },
                {
                    id: 'reply-window',
                    title: { ar: 'نافذة الرد: 24 ساعة، و7 أيام لمحادثات الإعلانات', en: 'The reply window: 24 hours, and 7 days for ad conversations' },
                    body: {
                        ar: [
                            'تسمح ميتا للحساب بأن يكتب إلى الشخص خلال 24 ساعة من آخر رسالة منه. ويلتزم المساعد بثلاث وعشرين ساعة احتياطًا، ومنها رسالة المتابعة التي تُرسل بعد الرابط.',
                            'ومنذ 28 سبتمبر 2026 تعطي ميتا المحادثات التي بدأت من إعلان مراسلة على إنستجرام أو ماسنجر نافذة تصل إلى 7 أيام من الضغطة. ويطبّقها المساعد (7 أيام إلا ساعة) فقط إن شغّلت «استعمل النافذة الأطول على إنستجرام» (أو «على ماسنجر») للمنصة.',
                            { h: 'لماذا هو مفتاح مطفأ؟' },
                            'لأن ميتا ذكرت هذا لإنستجرام ولم يظهر بعد في صفحة ماسنجر، والرسالة التي تُرسل خارج النافذة تُرفض وقد تضرّ بالحساب. فجرّبه أولًا:',
                            { ol: [
                                'افتح محادثة بدأت من إعلان، ومرّ عليها يوم كامل دون رسالة من الشخص.',
                                'في اليوم الثاني، أرسل ردًّا يدويًّا من حسابك.',
                                'إن وصل الرد، شغّل «استعمل النافذة الأطول على إنستجرام» (أو «على ماسنجر») لتلك المنصة. وإن رُفض، فاتركه مطفأً.',
                            ] },
                            { warn: 'إن رفضت ميتا ردًّا في محادثة إعلانية لأنه خارج النافذة (الخطأ 10/2018278 أو 551)، يُطفئ التطبيق المفتاح لتلك المنصة تلقائيًّا ويصلك تنبيه «رفضت ميتا ردًّا خارج النافذة». لا تُعِد تشغيله قبل أن ينجح اختبار اليوم الثاني.' },
                        ],
                        en: [
                            'Meta lets an account write to a person within 24 hours of their last message. The assistant keeps to 23 hours to be safe, the follow-up nudge sent after a link included.',
                            'Since 28 September 2026 Meta gives conversations that began from a message ad on Instagram or Messenger a window of up to 7 days from the tap. The assistant uses it (7 days less an hour) only if you turn on “Use the longer window on Instagram” (or “on Messenger”) for that platform.',
                            { h: 'Why is it a switch, and off?' },
                            'Because Meta announced it for Instagram and it had not yet appeared on the Messenger page, and a message sent outside the window is refused and can hurt the account. So test it first:',
                            { ol: [
                                'Open a conversation that began from an ad and let a full day pass with no message from the person.',
                                'On day 2, send a reply by hand from your account.',
                                'If it goes through, turn on “Use the longer window on Instagram” (or “on Messenger”) for that platform. If it is refused, leave it off.',
                            ] },
                            { warn: 'If Meta refuses a reply in an ad conversation for being outside the window (error 10/2018278 or 551), the app switches that platform off by itself and you get the “Meta refused a reply outside the window” alert. Do not turn it on again before the day-2 test passes.' },
                        ],
                    },
                },
                {
                    id: 'business-ai',
                    title: { ar: 'ذكاء ميتا للأعمال يتولى المحادثة', en: 'Meta Business AI holds the conversation' },
                    body: {
                        ar: [
                            'لدى ميتا مساعد خاص بها اسمه «ذكاء الأعمال» (Business AI) يستطيع أن يجيب في رسائل إنستجرام. وإذا كان يتولى محادثة، ترفض ميتا كل رسالة يرسلها المساعد فيها (الخطأ 100 / 2534037)، فيبدو المساعد صامتًا، وغالبًا في محادثات الإعلانات تحديدًا.',
                            'حين يحدث هذا، لا يعيد التطبيق المحاولة (لن تنجح)، ويضع على المحادثة في **الرسائل** شارة **ذكاء ميتا للأعمال يتولى الرد**، ويرسل إليك تنبيهًا واحدًا. وتزول الشارة وحدها عند أول رسالة يقبلها ميتا من المساعد.',
                            { h: 'كيف تستعيد التحكم' },
                            { ol: [
                                'افتح Meta Business Suite للحساب نفسه.',
                                'ادخل إلى إعدادات «ذكاء الأعمال» (Business AI) في صندوق الوارد.',
                                'فعّل «تولَّ المحادثات من ذكاء الأعمال» (Take control of conversations with your Business AI)، أو أطفئ ذكاء الأعمال كليًّا إن كنت تريد أن يجيب بوت أوتوريبلاي وحده.',
                                'أرسل رسالة تجربة إلى الحساب، وتأكّد أن المساعد أجاب وأن الشارة زالت.',
                            ] },
                        ],
                        en: [
                            'Meta has its own assistant, “Business AI”, which can answer Instagram messages. When it holds a conversation, Meta refuses every message the assistant sends in it (error 100 / 2534037), so the assistant looks silent, very often in ad conversations.',
                            'When this happens the app does not retry (it would not work), marks the conversation in the **Inbox** with **Meta Business AI is answering**, and sends you one alert. The mark clears by itself at the first message Meta accepts from the assistant.',
                            { h: 'How to take control back' },
                            { ol: [
                                'Open Meta Business Suite for the same account.',
                                'Go to the “Business AI” settings in the inbox.',
                                'Turn on “Take control of conversations with your Business AI”, or turn Business AI off altogether if you want the AutoReply assistant to be the only one answering.',
                                'Send a test message to the account and check that the assistant answers and the mark is gone.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'results',
                    title: { ar: 'اقرأ نتائج إعلاناتك', en: 'Read your ad results' },
                    body: {
                        ar: [
                            'تبويب **النتائج** في شاشة الإعلانات يعرض ما فعله المال يوماً بيوم. اختر الفترة (7 أو 28 أو 90 يوماً)، ثم اختر ما تُعرض نتائجه: الحساب الإعلاني كله، أو حملة واحدة، أو إعلاناً واحداً.',
                            { ul: [
                                '**الإنفاق**: ما أنفقته ميتا في كل يوم.',
                                '**النتائج**: ما اشتُري الإعلان من أجله، كما اخترته في الحملة: محادثات، أو نقرات على الرابط، أو عملاء محتملون، أو متابعون. وفي الحملة التي فيها إعلانات بأهداف مختلفة تُعدّ نتيجة كل إعلان بهدفه هو ثم تُجمع.',
                                '**تكلفة النتيجة** و**تكلفة المحادثة** و**تكلفة النقرة المتتبَّعة**: الإنفاق مقسوماً على العدد. وإن كان العدد صفراً تظهر «—»، لا صفر.',
                                '**قارن حسب**: الإعلان، أو الدولة (مصر والسعودية مثلاً)، أو مكان الظهور (الريلز، والقصص، والخلاصة). ومجموع الدول يساوي المجموع الكلي.',
                                '**كل إعلان**: جدول بالإنفاق والمحادثات ونقرات الرابط والنقرات المتتبَّعة والتحويلات إلى شخص والمتابعين الجدد والعملاء المحتملين.',
                            ] },
                            'الأرقام من نسخة محفوظة لدى أوتوريبلاي تُحدَّث من ميتا كل بضع ساعات، وتُعاد قراءة آخر 28 يوماً كل ليلة. لذلك تفتح الشاشة فوراً ولا تستهلك من حصة ميتا المحدودة لحسابك شيئاً. ويظهر في أعلاها وقت **آخر تحديث**، ويستطيع المالك أن يضغط **تحديث النتائج** ليطلب تحديثاً، مرة كل 15 دقيقة على الأكثر. والطلب يدخل الطابور ويُنفَّذ في حدود ميتا، وتعرض الشاشة متى يُتوقَّع.',
                            { ul: [
                                'الأيام أيام منطقة الحساب الإعلاني الزمنية، كما في مدير الإعلانات، لا منطقة جهازك.',
                                'المبالغ دون الضريبة، وفواتير ميتا هي السجل المحاسبي المعتمد.',
                                'إن كان في النتائج عملتان فلا تُجمعان أبداً: لكل عملة مجاميعها، والرسوم بعملة واحدة.',
                            ] },
                            { tip: 'تجد ملخصاً للإعلانات أيضاً في شاشة **النمو والتسويق** (بطاقة «المدفوع (الإعلانات)» تحت الأرقام العضوية)، وفي شاشة **النتائج** (صف لكل إعلان تحت حملات الرسائل، عليه شارة «إعلان»).' },
                        ],
                        en: [
                            'The **Results** tab of the Ads screen shows what the money did, day by day. Pick a period (7, 28 or 90 days), then what to show: the whole ad account, one campaign or one ad.',
                            { ul: [
                                '**Spend**: what Meta spent each day.',
                                '**Results**: what the ad was bought for, as chosen in the campaign: conversations, link clicks, leads or followers. In a campaign whose ads have different goals, each ad is counted by its own goal, then added up.',
                                '**Cost per result**, **Cost per conversation** and **Cost per tracked click**: spend divided by the count. When the count is zero you see “—”, not zero.',
                                '**Compare by**: ad, country (Egypt and Saudi Arabia, for example) or placement (Reels, Stories, Feed). The countries add up to the total.',
                                '**Every ad**: a table of spend, conversations, link clicks, tracked clicks, hand-offs to a person, new followers and leads.',
                            ] },
                            'The numbers come from a copy AutoReply keeps, refreshed from Meta every few hours, and the last 28 days are read again every night. So the screen opens at once and uses none of your account’s limited Meta allowance. **Last updated** is shown at the top, and the owner can press **Refresh results** to ask for a refresh, at most once every 15 minutes. The request joins the queue and runs within Meta’s limits; the screen says when it is expected.',
                            { ul: [
                                'Days are in the ad account’s time zone, as in Ads Manager, not your device’s.',
                                'Amounts exclude tax. Meta’s invoices are the accounting record.',
                                'When results come in two currencies they are never added together: each currency has its own totals, and the charts show one currency.',
                            ] },
                            { tip: 'You also find a summary of your ads on **Growth** (the “Paid (ads)” card under the organic numbers) and on **Results** (one row per ad under the message campaigns, with an “Ad” badge).' },
                        ],
                    },
                },
                {
                    id: 'provisional-numbers',
                    title: { ar: 'لماذا تتغيّر أرقام آخر ثلاثة أيام', en: 'Why the last three days change' },
                    body: {
                        ar: [
                            'لا تثبت أرقام ميتا يوم حدوثها. فالمحادثة أو النقرة قد تُنسب إلى الإعلان بعد أيام، وقد تُستبعد نقرات غير صالحة، ولذلك تعدّل ميتا نتائج اليوم الواحد حتى 28 يوماً بعده. ومعظم التعديل يقع في الأيام الأولى.',
                            { ul: [
                                'تُعاد قراءة آخر 28 يوماً من ميتا كل ليلة، فتُصحَّح الأرقام المحفوظة تلقائياً.',
                                'آخر ثلاثة أيام أولية: مظلّلة في الرسوم، ومعلَّمة بكلمة «أولي» في الجداول، وتذكر الشاشة من أي يوم تبدأ.',
                                'حين تقارن بمدير الإعلانات فقارن الأيام المستقرة. أما الأيام الأولية فقد تختلف قليلاً حتى تُعاد قراءتها.',
                            ] },
                            { tip: 'لا تحكم على إعلان من أرقام يومه الأول. انتظر حتى تستقر الأيام، أو قارن فترات متساوية مستقرة.' },
                        ],
                        en: [
                            'Meta’s numbers are not final on the day they happen. A conversation or a click can be credited to an ad days later, and invalid clicks can be removed, so Meta revises a day’s results for up to 28 days after it. Most of the change happens in the first few days.',
                            { ul: [
                                'The last 28 days are read from Meta again every night, so the stored numbers correct themselves.',
                                'The last three days are provisional: shaded on the charts, marked “provisional” in the tables, and the screen says from which day.',
                                'When you compare with Ads Manager, compare the settled days. Provisional days can differ a little until they are read again.',
                            ] },
                            { tip: 'Do not judge an ad by its first day. Wait for the days to settle, or compare settled periods of the same length.' },
                        ],
                    },
                },
                {
                    id: 'cost-per-conversation',
                    title: { ar: 'تكلفة المحادثة والنقرة المتتبَّعة', en: 'Cost per conversation and per tracked click' },
                    body: {
                        ar: [
                            'تكلفة المحادثة هي الإنفاق مقسوماً على عدد المحادثات التي قالت ميتا إن الإعلان بدأها. وأوتوريبلاي تضيف ما لا تراه ميتا، من سجلاتها هي:',
                            { dl: [
                                ['نقرات رابط الإعلان', 'نقرات الناس على الرابط المتتبَّع الخاص بالإعلان (رابط `/r/` الذي تصنعه أوتوريبلاي لعرضك).'],
                                ['نقرات عبر المحادثة', 'نقرات الناس على الروابط التي أرسلها المساعد في محادثات بدأها هذا الإعلان.'],
                                ['تحويلات إلى شخص', 'محادثات بدأها الإعلان ثم طُلب فيها أن يتولّاها شخص منكم.'],
                            ] },
                            'وتكلفة النقرة المتتبَّعة هي الإنفاق مقسوماً على مجموع النوعين. لا تُعدّ إلا نقرات الناس، فمعاينات الروابط التي تصنعها التطبيقات والبرامج الآلية مستبعدة. والنقرة تُحسب في يوم وقوعها بمنطقة الحساب الإعلاني الزمنية. وليس للنقرة دولة ولا مكان ظهور، فهي في المقارنة حسب الإعلان وحدها.',
                            { warn: 'لا نعرض رقماً يقارن الإنفاق بالمبيعات. فالبيع يتم على موقع آخر (متجر، أو منصة تعليمية، أو صفحة دفع)، ولا تراه ميتا ولا أوتوريبلاي، وأي رقم من هذا النوع سيكون مختلَقاً. أقرب ما نعرفه هو النقرات المتتبَّعة على رابط العرض، والمحادثات التي تحوّلت إلى شخص.' },
                        ],
                        en: [
                            'Cost per conversation is spend divided by the conversations Meta says the ad started. AutoReply adds what Meta cannot see, from its own records:',
                            { dl: [
                                ['Clicks on the ad’s link', 'People’s clicks on the ad’s own tracked link (the `/r/` link AutoReply makes for your offer).'],
                                ['Clicks via the chat', 'People’s clicks on the links the assistant sent in conversations this ad started.'],
                                ['Handed to a person', 'Conversations the ad started in which a person from your team was asked to take over.'],
                            ] },
                            'Cost per tracked click is spend divided by both kinds together. Only people’s clicks count: link previews made by apps and bots are left out. A click counts on the day it happened, in the ad account’s time zone. A click has no country or placement, so it appears in the comparison by ad only.',
                            { warn: 'We show no figure that compares spend with sales. The sale happens on another website (a store, a learning platform or a checkout page), which neither Meta nor AutoReply can see, so any such number would be made up. The closest we know is the tracked clicks on your offer’s link, and the conversations handed to a person.' },
                        ],
                    },
                },
                {
                    id: 'builder',
                    title: { ar: 'إنشاء حملة كاملة خطوة بخطوة', en: 'Build any campaign, step by step' },
                    body: {
                        ar: [
                            'يرشدك المُنشئ في ثماني خطوات، وهي نفسها أيًّا كان الهدف. لا يعرض في كل خطوة إلا الخيارات التي تقبلها ميتا لهذا الهدف، ومع كل خيار جملة تشرحه.',
                            { ol: [
                                '**الهدف:** رسائل، أو وصول، أو تفاعل، أو زيارات لرابط. وهدف **العملاء المحتملون** في القائمة أيضًا، لكنه يظهر **مقفل** حتى يسجّل مدير المنصة اعتمادًا قانونيًا لمساحة عملك: [[ads#lead-ads]]. ويبدأ المُنشئ على **الرسائل** ووجهة إنستجرام، وهي حلقة المنتج نفسها: إعلان ثم رسالة ثم المساعد.',
                                '**الوجهة:** أين تصل الرسائل (إنستجرام أو ماسنجر أو واتساب)، أو الرابط الذي تُفتح عليه الزيارات. رابط العرض يكون رابطًا متتبَّعًا افتراضيًا حتى تُحسب النقرات.',
                                '**التصميم:** منشور منشور من قبل، أو صورة أو فيديو ترفعه من جهازك، ومعه نسخة عمودية 9:16 إن شئت.',
                                '**النص:** النص الأساسي والعنوان وزر الدعوة إلى الإجراء.',
                                '**الجمهور:** الدول والمدن والعمر والجنس واللغات والاهتمامات.',
                                '**المواضع:** تلقائية (موصى بها) أو تختارها بنفسك.',
                                '**الميزانية والجدول:** يومية أو إجمالية، والبداية والنهاية.',
                                '**المراجعة:** معاينة لكل موضع، ونتيجة فحص السياسات، والوصول المتوقع، ومطابقة المبلغ لحدودك.',
                            ] },
                            { note: 'كل ما يُنشئه المُنشئ يُنشأ متوقفًا مؤقتًا. لا يُصرف شيء حتى تشغّله أنت من شاشة الإعلانات، وتؤكد المبلغ.' },
                            'إذا حظر فحص السياسات عبارةً، تظهر العبارة مظلَّلة مع صياغة بديلة مقترحة، ولا يُقبل الإرسال حتى تعدّلها. أما التنبيهات فتحتاج إلى تأكيد منك فقط.',
                        ],
                        en: [
                            'The builder takes you through eight steps, the same whatever the goal. Each step offers only the choices Meta accepts for that goal, each with a one-line explanation.',
                            { ol: [
                                '**Goal:** messages, reach, engagement or traffic to a link. **Leads** is on the list too, but it shows **Locked** until the platform admin records a legal sign-off for your workspace: [[ads#lead-ads]]. The builder starts on **Messages** with an Instagram destination, the product’s own loop: an ad, then a message, then the assistant.',
                                '**Destination:** where messages arrive (Instagram, Messenger or WhatsApp), or the link the traffic opens. An offer link is a tracked link by default, so its clicks are counted.',
                                '**Creative:** a post you already published, or an image or video uploaded from your computer, with an optional 9:16 version.',
                                '**Text:** the primary text, the headline and the call-to-action button.',
                                '**Audience:** countries and cities, age, gender, languages and interests.',
                                '**Placements:** automatic (recommended) or chosen by you.',
                                '**Budget and schedule:** daily or total, the start and the end.',
                                '**Review:** a preview per placement, the policy check, the estimated reach and the money check against your limits.',
                            ] },
                            { note: 'Everything the builder creates is created paused. Nothing is spent until you switch it on from the Ads screen and confirm the amount.' },
                            'When the policy check blocks a phrase, the phrase is highlighted with a suggested rewrite, and the ad cannot be sent until you change it. A warning only needs your tick.',
                        ],
                    },
                },
                {
                    id: 'targeting',
                    title: { ar: 'الجمهور: الدول والمدن والعمر والاهتمامات', en: 'Audience: countries, cities, age and interests' },
                    body: {
                        ar: [
                            { dl: [
                                ['الدول', 'دولة واحدة أو أكثر، مثل مصر والسعودية معًا. دول الاتحاد الأوروبي غير متاحة الآن، لأن ميتا تطلب لها بيانات إضافية عن الممول والمستفيد.'],
                                ['المدن', 'ابحث عن المدينة باسمها، ثم اختر نصف قطر بين 17 و80 كيلومترًا حولها.'],
                                ['العمر', 'من 18 إلى 65.'],
                                ['الجنس', 'الكل، أو الرجال، أو النساء.'],
                                ['اللغات', 'تقصد بها ميتا من يستخدمون لغة غير لغة البلد الشائعة. في مصر والسعودية العربية هي اللغة الشائعة، فلا تحتاج إلى اختيارها عادةً.'],
                                ['الاهتمامات', 'ابحث بكلمة من حرفين فأكثر؛ يظهر بجانب كل اهتمام حجم جمهوره التقريبي.'],
                            ] },
                            'جمهور Advantage من ميتا. عند تشغيله تعامل ميتا الاهتمامات والجنس والحد الأعلى للعمر على أنها اقتراحات تبدأ منها، لا حدود صارمة. أما الموقع والحد الأدنى للعمر واللغة والاستبعادات فتبقى ثابتة.',
                            { warn: 'لهذا يقبل المُنشئ مع جمهور Advantage حدًّا أدنى للعمر بين 18 و25 فقط، ويُخفي الحد الأعلى: ميتا تثبّته على 65 ولا تقبل غيره. إن أردت عمرًا محددًا بدقة، فأطفئ جمهور Advantage.' },
                            'الفئة الخاصة. إذا كان إعلانك عن وظائف أو خدمات مالية أو سكن، فاختر الفئة. عندها تقيّد ميتا الاستهداف: لا اختيار للجنس، والعمر من 18 إلى 65، ولا اهتمامات، ونصف قطر المدن 25 كيلومترًا على الأقل. إعلانات القضايا السياسية غير مدعومة.',
                        ],
                        en: [
                            { dl: [
                                ['Countries', 'One or more, such as Egypt and Saudi Arabia together. EU countries are not available yet: Meta asks for extra details about who pays and who benefits.'],
                                ['Cities', 'Search a city by name, then choose a radius of 17 to 80 km around it.'],
                                ['Age', '18 to 65.'],
                                ['Gender', 'All, men or women.'],
                                ['Languages', 'Meta means people who use a language other than the country\'s common one. In Egypt and Saudi Arabia Arabic is the common language, so you rarely need it.'],
                                ['Interests', 'Search with two or more letters; each interest shows its approximate audience size.'],
                            ] },
                            'Meta\'s Advantage audience. When it is on, Meta treats interests, gender and the maximum age as a starting point, not hard limits. Location, the minimum age, language and exclusions stay fixed.',
                            { warn: 'That is why, with Advantage audience on, the builder accepts a minimum age between 18 and 25 only and hides the maximum: Meta fixes it at 65 and accepts nothing else. For an exact age range, switch Advantage audience off.' },
                            'Special category. If your ad is about jobs, financial services or housing, choose the category. Meta then restricts targeting: no gender choice, ages 18 to 65, no interests, and a city radius of at least 25 km. Political and social-issue ads are not supported.',
                        ],
                    },
                },
                {
                    id: 'creatives',
                    title: { ar: 'التصاميم: المقاسات والنسخة العمودية والغلاف', en: 'Creatives: sizes, the 9:16 version and the cover' },
                    body: {
                        ar: [
                            { dl: [
                                ['الصور', 'JPG أو PNG، حتى 30 ميجابايت.'],
                                ['الفيديو', 'MP4 أو MOV، حتى 50 ميجابايت. يُرفع الملف مباشرة إلى التخزين، ثم تسحبه ميتا من رابطه بنفسها.'],
                                ['الغلاف', 'مطلوب لكل فيديو. بدونه تعرض ميتا أول إطار من الفيديو، وغالبًا ما يكون أسود.'],
                            ] },
                            'النسخة العمودية 9:16. يمكنك أن ترفع نسخة ثانية بمقاس 9:16، فتُعرض في القصص بدل النسخة المربعة. هذه النسخة متاحة للتصاميم المرفوعة فقط، لأن ميتا لا تسمح بها للمنشورات الموجودة.',
                            { note: 'لم تؤكد ميتا بعدُ أن النسخة العمودية تُخصَّص لمواضع الريلز عبر الواجهة البرمجية، لذلك تُستخدم الآن في القصص فقط. الريلز تعرض النسخة الأساسية مع تكييف ميتا للمقاس.' },
                            'لماذا لا يفعّل التطبيق تحسينات ميتا الآلية للتصاميم؟ تستطيع ميتا أن تعيد كتابة النص، وتولّد صورًا أو خلفيات، وتضيف موسيقى. والتطبيق لا يطلب شيئًا من ذلك أبدًا، لثلاثة أسباب: نصّك العربي مكتوب بالفصحى ولا نريد أن يُعاد صوغه، ولا نقبل صورًا مولَّدة قد تُظهر أشخاصًا لم تخترهم، ولكي يبقى الإعلان بأسلوبك. وما تسمح ميتا بإيقافه صراحةً عبر واجهتها البرمجية، وهو الترجمة الآلية والترجمة المكتوبة والتحريك وبطاقة الملف الشخصي، يُرسَل موقوفًا في كل إعلان.',
                            'في المراجعة ترى معاينة لكل موضع. إذا لم تسمح ميتا بالمعاينة لرمز حسابك، يرسم المُنشئ **معاينة تقريبية**: الصورة مقصوصة على إطار الموضع، واسم الصفحة، والنص مقطوعًا عند 125 حرفًا كما تقطعه ميتا في الموجز.',
                        ],
                        en: [
                            { dl: [
                                ['Images', 'JPG or PNG, up to 30 MB.'],
                                ['Video', 'MP4 or MOV, up to 50 MB. The file goes straight to storage, and Meta then fetches it from its link itself.'],
                                ['Cover', 'Required for every video. Without one, Meta shows the video\'s first frame, which is often black.'],
                            ] },
                            'The 9:16 version. You can upload a second, 9:16 version, shown in Stories instead of the square one. It is offered for uploaded creatives only: Meta does not allow it on existing posts.',
                            { note: 'Meta has not yet confirmed that the vertical version can be assigned to Reels through the API, so for now it is used in Stories only. Reels show the main version, which Meta adapts to the frame.' },
                            'Why the app never turns on Meta\'s automatic creative enhancements. Meta can rewrite your text, generate images or backgrounds and add music. The app never asks for any of it, for three reasons: your Arabic copy is written in Modern Standard Arabic and should not be reworded, we do not accept generated images that could show people you did not choose, and the ad should stay in your voice. What Meta\'s API lets an app switch off explicitly (automatic subtitles, overlay translation, animation and the profile card) is sent switched off on every ad.',
                            'The review step shows a preview per placement. When Meta does not allow previews for your account\'s token, the builder draws an approximate preview: the image cropped to the placement\'s frame, the Page name, and the text cut at 125 characters, as Meta cuts it in Feed.',
                        ],
                    },
                },
                {
                    id: 'budgets-and-schedule',
                    title: { ar: 'الميزانية والجدول الزمني', en: 'Budget and schedule' },
                    body: {
                        ar: [
                            { dl: [
                                ['يومية', 'مبلغ لكل يوم. قد تصرف ميتا في يوم ما حتى 75% فوقه، لكنها لا تتجاوز سبعة أضعافه في الأسبوع.'],
                                ['إجمالية', 'مبلغ للمدة كلها، ويلزمها تاريخ نهاية.'],
                                ['على الحملة', 'ميزانية واحدة تتوزع على مجموعات الإعلانات حيث النتائج أفضل.'],
                                ['على كل مجموعة', 'لكل مجموعة إعلانات ميزانيتها الخاصة.'],
                            ] },
                            'المبلغ بعملة حسابك الإعلاني. لا يقبل المُنشئ مبلغًا أقل من الحد الأدنى الذي تحدده ميتا لحسابك ولهذا الهدف، ولا مبلغًا يتجاوز حدك اليومي أو ما تبقّى من حدك الشهري. كل الأرقام دون الضريبة؛ فواتير ميتا هي السجل المحاسبي.',
                            'الجدول الزمني. يمكنك أن تحدد أيامًا وساعات يُعرض فيها الإعلان، مثل المساء فقط. تشترط ميتا لذلك ميزانية إجمالية، وتحسب الساعات بتوقيت المشاهد.',
                        ],
                        en: [
                            { dl: [
                                ['Daily', 'An amount per day. Meta may spend up to 75% over it on a given day, but never more than seven times it in a week.'],
                                ['Total', 'An amount for the whole run; it needs an end date.'],
                                ['On the campaign', 'One budget that Meta spreads across the ad sets where results are better.'],
                                ['Per ad set', 'Each ad set has its own budget.'],
                            ] },
                            'Amounts are in your ad account\'s currency. The builder refuses an amount below Meta\'s minimum for your account and goal, above your daily limit, or above what is left of your monthly limit. Every figure is excluding tax; Meta\'s invoices are the accounting record.',
                            'Schedule. You can choose days and hours when the ad runs, such as evenings only. Meta requires a total budget for this and uses the viewer\'s time zone.',
                        ],
                    },
                },
                {
                    id: 'duplicate-archive',
                    title: { ar: 'النسخ والأرشفة والحذف', en: 'Duplicate, archive and delete' },
                    body: {
                        ar: [
                            'النسخ يُنشئ نسخة من الحملة أو مجموعة الإعلانات أو الإعلان، متوقفة مؤقتًا، ويُضاف إلى اسمها وسم يدل على أنها نسخة. تدخل النسخة مراجعة ميتا من جديد، وتبدأ مرحلة التعلّم من الصفر.',
                            'الأرشفة هي طريقة الإزالة المعتادة: تتوقف الحملة وتختفي من القائمة، ويبقى تاريخها ونتائجها.',
                            { warn: 'الحذف نهائي ولا يمكن التراجع عنه، لذلك يطلب تأكيدًا منفصلًا، ولا يُعرض لحملة تعمل الآن. أوقفها أولًا.' },
                        ],
                        en: [
                            'Duplicate creates a copy of the campaign, ad set or ad, paused, with a tag added to its name that marks it as a copy. The copy goes through Meta\'s review again and starts learning from zero.',
                            'Archive is the usual way to remove something: it stops and leaves the list, and its history and results are kept.',
                            { warn: 'Delete is permanent and cannot be undone, so it asks for a separate confirmation, and it is not offered for a campaign that is running. Pause it first.' },
                        ],
                    },
                },
                {
                    id: 'troubleshooting',
                    title: { ar: 'حلول مشكلات الإعلانات', en: 'Ads troubleshooting' },
                    body: {
                        ar: [
                            { qa: [
                                ['لا يظهر زر «اتصال»', 'هذا طبيعي. الاتصال عبر فيسبوك خيار إضافي، والإعلانات لا تحتاج إليه: ألصق رمز مستخدم النظام كما في [[ads#connect]].'],
                                ['الرمز توقف عن العمل', ['انتهت صلاحيته أو أُلغي أو حُذف مستخدم النظام. أنشئ رمزاً جديداً بالخطوات في [[ads#connect]]، والصقه في **رمز إعلانات مستخدم النظام**، واضغط **احفظ** ثم **اختبر الاتصال**.', 'حتى يُصلَح، لا تستطيع أوتوريبلاي إيقاف الحملات عند السقف. فأصلحه سريعاً.']],
                                ['فشل الدفع', 'أصلح وسيلة الدفع من صفحة الفوترة في ميتا. أوتوريبلاي لا تستطيع إضافة وسيلة دفع عنك. بعد التسوية يعود الحساب إلى «نشط» في الفحص اليومي التالي.'],
                                ['ظهرت رسالة تجاوز حد الطلبات (`RATE_LIMITED`)', 'لميتا حد للطلبات، نحو 60 نقطة كل 5 دقائق في الفئة المحدودة. تنتظر أوتوريبلاي حتى الوقت المكتوب في الرسالة، ولا تعيد المحاولة في حلقة. انتظر ذلك الوقت ثم أعد المحاولة.'],
                                ['شريط **الإنفاق غير مُراقَب**', ['يعني أن الحارس لم يستطع فحص حسابك ساعتين. الأسباب المحتملة: الرمز لا يعمل، أو عطل عند ميتا، أو حد الطلبات.', 'اضغط **اختبر الاتصال**. إن نجح وبقي الشريط، فانتظر ساعة، فالحارس يعمل كل ساعة. وراقب إنفاقك في ميتا مباشرة إلى أن يزول الشريط.']],
                                ['رُفض التفعيل برمز `OVER_MONTHLY_CAP`', 'المجموع سيتجاوز سقفك الشهري. اقرأ المبلغ المتبقي في الشاشة، أو أنقص الميزانية، أو ارفع السقف من **الإعدادات** إن كان ذلك قرارك.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['There is no “Connect” button', 'That is normal. Facebook Connect is an optional extra and ads do not need it: paste a system-user token as in [[ads#connect]].'],
                                ['The token stopped working', ['It expired, was revoked, or the system user was deleted. Generate a new token with the steps in [[ads#connect]], paste it into **System-user ads token**, and press **Save** and then **Test connection**.', 'Until it is fixed, AutoReply cannot pause campaigns at the cap. So fix it quickly.']],
                                ['Payment failed', 'Fix the payment method on Meta’s billing page. AutoReply cannot add a payment method for you. After it settles, the account goes back to “Active” at the next daily check.'],
                                ['A rate limit message appears (`RATE_LIMITED`)', 'Meta limits requests, to about 60 points every 5 minutes on the Limited tier. AutoReply waits until the time shown in the message and never retries in a loop. Wait until then and try again.'],
                                ['The **Spending is not being watched** banner', ['It means the guard could not check your account for two hours. Likely causes: the token does not work, a Meta outage, or throttling.', 'Press **Test connection**. If it succeeds and the banner stays, wait an hour, because the guard runs hourly. Watch your spend in Meta directly until the banner clears.']],
                                ['Activation refused with `OVER_MONTHLY_CAP`', 'The total would pass your monthly cap. Read the remaining amount on the screen, lower the budget, or raise the cap in **Settings** if that is your decision.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'ai-proposals',
                    title: { ar: 'دع Claude يكتب حملتك: المقترحات', en: 'Let Claude draft: proposals' },
                    body: {
                        ar: [
                            'في تبويب **المقترحات** في شاشة الإعلانات يكتب Claude حملات كاملة وتغييرات على إعلاناتك الجارية، ثم ينتظر قرارك. لا يُنشأ شيء ولا يتغيّر شيء ولا يُنفَق شيء قبل أن توافق.',
                            { ol: [
                                'اضغط **اقترح حملة** (في المقترحات أو في النظرة العامة) واكتب بجملة ما تريد الإعلان عنه، أو اضغط الزر نفسه على منشور منشور في **المنشورات** ليبني Claude الحملة على ذلك المنشور.',
                                'تظهر بطاقة **قيد الكتابة**. مسودات حسابك أنت يكتبها Claude على جهازك، وقد تستغرق بضع دقائق؛ يمكنك مغادرة الصفحة، وتتحدّث البطاقة وحدها.',
                                'حين تجهز تعرض البطاقة: الهدف، والميزانية، والدول والأعمار، ونص الإعلان، وسبب الاقتراح، وما افترضه Claude، وما يضيفه إلى أسوأ حالات الإنفاق هذا الشهر.',
                                'اختر: **وافق** فتُنشأ الحملة متوقفة مؤقتاً ولا تنفق حتى تشغّلها من **الحملات**؛ أو **عدّل في المنشئ** لتغيّر أي شيء قبل الإنشاء؛ أو **ارفض** فلا يُنشأ شيء.',
                            ] },
                            'قبل أن تراها تمرّ كل مسودة بالفحوص نفسها التي يمرّ بها ما تكتبه بيدك:',
                            { ul: [
                                'فحص السياسة: إن خالف النص قاعدة تمنعها ميتا طُلب من Claude أن يعيد الكتابة مرة واحدة، فإن بقيت المخالفة لم يُعرض المقترح.',
                                'قاعدة المال: إن زادت الميزانية على حدّك اليومي أو على ما تبقّى من سقفك الشهري خُفِّضت لتتسع، مع ملاحظة تقول ذلك. وإن كان ما يتسع أقل من الحد الأدنى الذي تشترطه ميتا فشل المقترح.',
                                '**الأرقام**: لا يُعرض رقم في «الأرقام التي بُني عليها» إلا إن كان من نتائج حسابك أنت. والتقدير المتوقَّع يأتي من تاريخ حسابك فقط، ولا يخترع Claude متوسطاً للسوق.',
                            ] },
                            'وعند الموافقة يُعاد فحص السياسة وقاعدة المال مرة أخرى، ثم تفحص ميتا الحملة دون إنشائها. فإن رفض أيٌّ منها لم يتغيّر شيء، وظهر السبب في نافذة الموافقة.',
                            { h: 'المراجعة اليومية' },
                            'مرة في اليوم يراجع Claude إعلاناتك الجارية التي لها 3 أيام من النتائج على الأقل، وقد يقترح حتى ثلاثة تغييرات: إيقاف مؤقت، أو خفض ميزانية أو رفعها، أو نقل ميزانية من مجموعة إعلانية أضعف إلى أقوى، أو إعلان جديد من منشور. ويصلك تنبيه «اقترح Claude تغييرات» إن كان مفعَّلاً في الإعدادات ← تنبيهات الإعلانات.',
                            { tip: 'تنتهي صلاحية المقترح بعد 7 أيام إن لم تقرر فيه، لأن الأرقام التي بُني عليها تتغيّر. اطلب مقترحاً جديداً متى شئت.' },
                        ],
                        en: [
                            'In the **Proposals** tab of the Ads screen, Claude drafts whole campaigns and changes to your running ads, then waits for you. Nothing is created, changed or spent until you approve.',
                            { ol: [
                                'Press **Suggest a campaign** (on Proposals or the Overview) and say in a sentence what you want to advertise, or press the same button on a published post in **Posts** to build the campaign on that post.',
                                'A **Drafting** card appears. Drafts for your own account are written by Claude on your Mac and can take a few minutes; you can leave the page, and the card updates by itself.',
                                'When it is ready the card shows the goal, the budget, the countries and ages, the ad text, why Claude proposes it, what it assumed, and what it adds to this month\'s worst case.',
                                'Choose: **Approve** and the campaign is created paused, spending nothing until you switch it on in **Campaigns**; **Edit in builder** to change anything before it is created; or **Reject** and nothing is created.',
                            ] },
                            'Before you see it, every draft goes through the same checks as what you write yourself:',
                            { ul: [
                                'The policy check: if the text breaks a rule Meta enforces, Claude is asked to rewrite it once; if it still does, the proposal is not shown.',
                                'The money rule: a budget over your max daily budget or what is left of your monthly cap is reduced to fit, with a note saying so. If what fits is below Meta\'s minimum, the proposal fails.',
                                'The numbers: a number under "The numbers behind it" is shown only if it comes from your own account\'s results. The expected range comes only from your account\'s history; Claude never invents a market average.',
                            ] },
                            'On **Approve** the policy check and the money rule run again, then Meta checks the campaign without creating it. If any of them refuses, nothing changes and the reason is shown in the approve dialog.',
                            { h: 'The daily review' },
                            'Once a day Claude reviews your running ads that have at least 3 days of results and may propose up to three changes: pause, lower or raise a budget, move budget from a weaker ad set to a stronger one, or a new ad from a post. You get the "Claude proposed changes" alert if it is on in Settings → Ads alerts.',
                            { tip: 'A proposal expires after **7 days** if you do not decide, because the numbers behind it move. Ask for a new one any time.' },
                        ],
                    },
                },
                {
                    id: 'what-ai-sees',
                    title: { ar: 'ما الذي يراه الذكاء الاصطناعي، ومن يكتب', en: 'What the AI sees, and who writes' },
                    body: {
                        ar: [
                            'يُعطى Claude مجاميع فقط، لا بيانات أشخاص:',
                            { ul: [
                                'أسماء حملاتك ومجموعاتك الإعلانية وميزانياتها وحالاتها وملخص استهدافها، ومجاميع آخر 7 أيام لكل منها: الإنفاق، والنتائج، وتكلفة النتيجة، والمحادثات، ونسبة النقر.',
                                'عروضك كما كتبتها في ملفك: الاسم والسعر وملخص قصير، بعد حذف أي بريد أو رقم هاتف منه.',
                                'حدودك (الحد اليومي والسقف الشهري وما تبقّى منه) والحد الأدنى الذي تشترطه ميتا، وأوصاف قواعد السياسة.',
                                'كلماتك أنت في «اقترح حملة»، وعند البدء من منشور: نص المنشور وأرقامه العامة (المشاهدات والوصول والحفظ).',
                            ] },
                            'لا يرى أبداً: رسائل عملائك، ولا أسماءهم، ولا أرقام هواتفهم أو بريدهم، ولا إجابات نماذج العملاء المحتملين، ولا قوائم التواصل.',
                            { h: 'من يكتب' },
                            { ul: [
                                'حساب صاحب المنصة: يكتب Claude المسودات على جهازه (Claude Code على اشتراكه الشخصي)، لا عبر مفتاح API.',
                                'كل نشاط آخر: تُكتب المسودات عبر مزوّد الذكاء الاصطناعي المضبوط له في العمليات ← مزوّدو الذكاء الاصطناعي (الغرضان «مسودات الإعلانات» و«المراجعة اليومية للإعلانات»). وإن لم يُضبط مزوّد ظهرت رسالة بذلك ولم يُكتب شيء.',
                            ] },
                            { tip: 'سياسة الخصوصية تذكر ذلك أيضاً، مع قائمة المزوّدين.' },
                        ],
                        en: [
                            'Claude is given aggregates only, never data about people:',
                            { ul: [
                                'Your campaigns\' and ad sets\' names, budgets, statuses and targeting summary, and each one\'s last-7-day totals: spend, results, cost per result, conversations and click-through rate.',
                                'Your offers as written in your profile: name, price and a short summary, with any email address or phone number taken out.',
                                'Your limits (max daily budget, monthly cap and what is left of it), Meta\'s minimum budget, and the policy rules\' descriptions.',
                                'Your own words in "Suggest a campaign" and, when you start from a post, the post\'s caption and its public counts (views, reach, saves).',
                            ] },
                            'It never sees your customers\' messages, names, phone numbers or emails, lead-form answers, or contact lists.',
                            { h: 'Who writes' },
                            { ul: [
                                'The platform owner\'s account: Claude writes the drafts on the owner\'s Mac (Claude Code on his own plan), not through an API key.',
                                'Every other business: drafts are written by the AI provider set up for it in Operations → AI providers (the purposes "Ad drafts" and "Daily ads review"). With none set up, a message says so and nothing is written.',
                            ] },
                            { tip: 'The privacy policy says this too, with the list of providers.' },
                        ],
                    },
                },
                {
                    id: 'audiences',
                    title: { ar: 'الجماهير: اعرض إعلاناتك على من يعرفونك', en: 'Audiences: show your ads to people who know you' },
                    body: {
                        ar: [
                            'الجمهور مجموعة محفوظة من الأشخاص تبنيها ميتا من نشاطهم على حساباتك أنت، ثم تضمّها إلى حملة أو تستبعدها منها في خطوة **الجمهور** من منشئ الحملات. لا تخرج أي بيانات اتصال من التطبيق لبناء هذه الأنواع: ميتا تعرف من تفاعل مع حسابك.',
                            { dl: [
                                ['المتفاعلون على إنستجرام', 'من أعجبوا أو علّقوا أو حفظوا أو شاركوا أو زاروا حسابك، أو من أرسلوا إليه رسالة. حتى 730 يومًا.'],
                                ['المتفاعلون مع صفحة فيسبوك', 'من تفاعلوا مع الصفحة أو منشوراتها، أو زاروها، أو نقروا زرًا فيها، أو أرسلوا رسالة. حتى 730 يومًا.'],
                                ['من أرسلوا رسالة', 'من راسلوا حسابك على إنستجرام أو صفحتك أو كليهما. حتى 730 يومًا.'],
                                ['مشاهدو الفيديو', 'من شاهدوا نسبة تختارها (3 ثوانٍ، أو ThruPlay، أو 25% إلى 95%) من مقاطع منشورة تختارها. حتى 365 يومًا.'],
                            ] },
                            { ol: [
                                'افتح **الإعلانات** ثم تبويب **الجماهير**، واضغط **جمهور جديد**.',
                                'اختر النوع، ثم من يدخل فيه والمدة بالأيام.',
                                'اكتب اسمًا محايدًا أو اترك الخانة فارغة ليُختار اسم تلقائيًا، ثم اضغط **أنشئ الجمهور**.',
                                'يظهر الجمهور «قيد الإنشاء» حتى تبنيه ميتا، ثم «جاهز» مع حجمه التقريبي. تتحقق الصفحة بنفسها كل بضع ثوانٍ.',
                            ] },
                            { h: 'الحالات' },
                            { dl: [
                                ['جاهز', 'يمكن استخدامه في أي حملة.'],
                                ['صغير جدًا', 'تحتاج ميتا إلى نحو 1,000 شخص لعرض الإعلانات. أطِل المدة أو أضف مصادر. ويمكن أن يكون مصدرًا لجمهور مشابه متى بلغ 100 شخص.'],
                                ['علّمته ميتا', 'رأت ميتا أن الجمهور يوحي بمعلومات حساسة، فلا يمكن استخدامه. احذفه وأنشئ جمهورًا باسم محايد.'],
                            ] },
                            { warn: 'الأسماء محايدة دائمًا. تمنع شروط ميتا أي اسم أو معيار يوحي بالصحة أو الضائقة المالية أو الدين أو التوجه أو السياسة، ويرفض التطبيق هذه الأسماء. ولا تُستخدم تصنيفات الردّ الآلي لمحادثاتك الخاصة (مثل من تردد بسبب السعر) لبناء الجماهير أو تسميتها أبدًا.' },
                            { tip: 'قبل أول جمهور يجب أن يقبل مالك الحساب الإعلاني شروط الجماهير المخصصة من ميتا. لا تسمح ميتا بقبولها من خلال التطبيق، فإن لم تُقبل ظهر في تبويب الجماهير زر يفتح صفحة الشروط في ميتا.' },
                        ],
                        en: [
                            'An audience is a saved group of people that Meta builds from what they did on your own accounts. You then include it in a campaign or leave it out, in the **Audience** step of the campaign builder. No contact data leaves the app to build these kinds: Meta knows who engaged with your account.',
                            { dl: [
                                ['Instagram engagers', 'People who liked, commented, saved, shared, visited your account, or sent it a message. Up to 730 days.'],
                                ['Facebook Page engagers', 'People who engaged with the Page or its posts, visited it, clicked a button on it, or sent a message. Up to 730 days.'],
                                ['People who messaged', 'People who messaged your Instagram account, your Page, or both. Up to 730 days.'],
                                ['Video viewers', 'People who watched a share you choose (3 seconds, ThruPlay, or 25% to 95%) of published videos you choose. Up to 365 days.'],
                            ] },
                            { ol: [
                                'Open **Ads**, then the **Audiences** tab, and press **New audience**.',
                                'Choose the kind, then who is in it and over how many days.',
                                'Type a neutral name, or leave it empty for an automatic one, and press **Create audience**.',
                                'The audience shows “Being created” until Meta has built it, then “Ready” with its approximate size. The page checks again by itself every few seconds.',
                            ] },
                            { h: 'Statuses' },
                            { dl: [
                                ['Ready', 'Can be used in any campaign.'],
                                ['Too small', 'Meta needs about 1,000 people to show ads. Make the window longer or add sources. It can still be the source of a lookalike once it has 100 people.'],
                                ['Flagged by Meta', 'Meta judged that the audience suggests sensitive information, so it cannot be used. Delete it and create one with a neutral name.'],
                            ] },
                            { warn: 'Names are always neutral. Meta’s terms forbid any name or criterion that suggests health, money troubles, religion, orientation or politics, and the app refuses such names. The automated replies’ labels for your private conversations (such as someone who hesitated over the price) are never used to build or name an audience.' },
                            { tip: 'Before the first audience, the ad account’s owner must accept Meta’s Custom Audience Terms. Meta does not let an app accept them, so when they are not accepted the Audiences tab shows a button that opens the terms in Meta.' },
                        ],
                    },
                },
                {
                    id: 'lookalikes',
                    title: { ar: 'الجماهير المشابهة', en: 'Lookalikes' },
                    body: {
                        ar: [
                            'الجمهور المشابه أشخاص جدد في دولة واحدة يشبهون أحد جماهيرك. هو أسهل طريق للوصول إلى من لم يعرفوك بعد لكنهم يشبهون من تفاعلوا معك.',
                            { ol: [
                                'أنشئ أولًا جمهورًا مصدرًا، مثل المتفاعلين على إنستجرام في آخر 90 يومًا، وانتظر حتى يصبح جاهزًا.',
                                'اضغط **جمهور جديد** ثم **جمهور مشابه**.',
                                'اختر الجمهور المصدر والدولة (مصر أو السعودية أو غيرهما) والحجم من 1% إلى 20%.',
                            ] },
                            { ul: [
                                '1% هو الأقرب شبهًا والأصغر عددًا، والنسبة الأكبر تصل إلى عدد أكبر يشبهونهم بدرجة أقل.',
                                'تحتاج ميتا إلى 100 شخص على الأقل من الدولة المختارة في الجمهور المصدر.',
                                'لكل دولة جمهور مشابه خاص بها: لمصر والسعودية أنشئ اثنين.',
                                'تحدّث ميتا الجمهور المشابه كل بضعة أيام، ويصبح غير نشط إن لم يُستخدم 90 يومًا.',
                                'لا يمكن أن يكون جمهور مشابه مصدرًا لجمهور مشابه آخر.',
                            ] },
                        ],
                        en: [
                            'A lookalike is new people in one country who resemble one of your audiences. It is the easiest way to reach people who do not know you yet but resemble those who engaged with you.',
                            { ol: [
                                'First create a source audience, such as Instagram engagers of the last 90 days, and wait until it is ready.',
                                'Press **New audience**, then **Lookalike**.',
                                'Choose the source audience, the country (Egypt, Saudi Arabia or another) and the size, from 1% to 20%.',
                            ] },
                            { ul: [
                                '1% is the closest match and the smallest; a larger percentage reaches more people who resemble them less.',
                                'Meta needs at least 100 people from the chosen country in the source audience.',
                                'Each country has its own lookalike: for Egypt and Saudi Arabia, create two.',
                                'Meta refreshes a lookalike every few days, and it goes inactive when unused for 90 days.',
                                'A lookalike cannot be the source of another lookalike.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'customer-lists',
                    title: { ar: 'قوائم العملاء: مقفلة حتى الاعتماد القانوني', en: 'Customer lists: locked until a legal sign-off' },
                    body: {
                        ar: [
                            'قائمة العملاء جمهور تبنيه من بريد عملائك الإلكتروني أو أرقام هواتفهم. ورفعها معالجةٌ لبيانات شخصية يخضع لقانون حماية البيانات الشخصية في مصر (رقم 151 لسنة 2020، ومهلة الامتثال تنتهي في 1 نوفمبر 2026) ونظام حماية البيانات الشخصية في السعودية، اللذين يشترطان الموافقة وحق الاعتراض وحفظ السجلات.',
                            { h: 'لماذا هي مقفلة' },
                            'تبقى قوائم العملاء مقفلة لكل حساب حتى يسجّل مدير المنصة اعتمادًا قانونيًا لدول ذلك الحساب: من أصدر الرأي القانوني، ومتى، ولأي دول. يظهر الخيار في تبويب الجماهير لكنه مقفل، ومعه ما يلزم لفتحه. وإذا أُلغي الاعتماد أُقفلت القوائم من جديد.',
                            { h: 'بعد فتحها' },
                            { ol: [
                                'الصق القائمة أو اختر ملف ‎.csv أو ‎.txt حتى 3 ميغابايت. يساعد سطر عناوين مثل email, phone, first name.',
                                'اختر دولة الأرقام التي بلا رمز دولة (من الدول المشمولة بالاعتماد فقط).',
                                'أكّد أن هؤلاء الأشخاص وافقوا على تلقي التسويق منك وأن لديك أساسًا قانونيًا، ثم اضغط **موّه وارفع**.',
                                'يعرض التطبيق ما أُرسل وما استُبعد: من طلبوا عدم التواصل، والصفوف غير الصالحة، والصفوف من دول غير مشمولة، والمكرر.',
                            ] },
                            { h: 'ما يحدث للقائمة' },
                            { ul: [
                                'تُموَّه داخل التطبيق: يُوحَّد كل بريد ورقم (أحرف صغيرة، ورمز الدولة) ثم يُحوَّل بدالة SHA-256 إلى رمز لا يُقرأ، قبل أن يُرسل أي شيء إلى ميتا.',
                                'لا تُحفظ: يُقرأ النص في الطلب نفسه ثم يُترك. لا يبقى منه إلا عدد الصفوف المرسلة. وتُمسح الرموز المموّهة من قائمة الانتظار عند انتهاء الرفع.',
                                'يُستبعد من طلبوا عدم التواصل تلقائيًا: من أوقفوا رسائل واتساب أو سحبوا فيها موافقتهم على التسويق، ومن سجّلتَ أنهم طلبوا ألا يكونوا في قوائمك (طلبات عدم الاستهداف).',
                                'تطابق ميتا الرموز مع حساباتها ثم تحذفها بعد المطابقة.',
                            ] },
                            { tip: 'إذا طلب أحد ألا يظهر في إعلاناتك، سجّل رقمه أو بريده في **طلبات عدم الاستهداف** من تبويب الجماهير. يُحفظ مموّهًا فقط، ويُحذف من القوائم المرفوعة لدى ميتا، ويُستبعد من أي رفع لاحق.' },
                        ],
                        en: [
                            'A customer list is an audience built from your customers’ emails or phone numbers. Uploading one is processing personal data under Egypt’s Personal Data Protection Law (No. 151 of 2020; the compliance period ends on 1 November 2026) and Saudi Arabia’s Personal Data Protection Law, which require consent, a right to object and kept records.',
                            { h: 'Why it is locked' },
                            'Customer lists stay locked for each account until the platform admin records a legal sign-off for that account’s countries: who gave the legal opinion, when, and for which countries. The option shows in the Audiences tab, locked, with what is needed to open it. If the sign-off is revoked, lists lock again.',
                            { h: 'Once unlocked' },
                            { ol: [
                                'Paste the list or choose a .csv or .txt file of up to 3 MB. A header row such as email, phone, first name helps.',
                                'Choose the country of numbers that have no country code (only countries the sign-off covers).',
                                'Confirm that these people agreed to receive marketing from you and that you have a legal basis, then press **Scramble and upload**.',
                                'The app shows what was sent and what was left out: people who opted out, invalid rows, rows from countries not covered, and duplicates.',
                            ] },
                            { h: 'What happens to the list' },
                            { ul: [
                                'Scrambled in the app: every email and number is normalised (lowercase, with the country code) and turned by SHA-256 into a code that cannot be read, before anything is sent to Meta.',
                                'Not kept: the text is read within the request and dropped. All that stays is how many rows were sent. The scrambled codes are cleared from the queue as soon as the upload ends.',
                                'Opted-out people are left out automatically: people who stopped WhatsApp messages or withdrew marketing consent there, and people you recorded as asking not to be in your lists (Do-not-target requests).',
                                'Meta matches the codes against its accounts and deletes them after matching.',
                            ] },
                            { tip: 'If someone asks not to see your ads, record their number or email under **Do-not-target requests** in the Audiences tab. It is stored scrambled only, removed from the lists already at Meta, and left out of every later upload.' },
                        ],
                    },
                },
                {
                    id: 'for-clients',
                    title: { ar: 'لعملاء الخدمة المُدارة', en: 'For managed workspaces' },
                    body: {
                        ar: [
                            'إذا كان حسابك مُداراً من أوتوريبلاي برو، فإعلانات ميتا تعمل بحسابك الإعلاني أنت، وبوسيلة الدفع التي تخصك أنت، ولا يمرّ إنفاقك عبر أوتوريبلاي برو. التهيئة تستغرق نحو عشرين دقيقة، وتُنجَز مرة واحدة.',
                            'تأكد مما يلي قبل أن تبدأ. وتجد شرح كل خطوة بالتفصيل في [[ads#connect|اربط حسابك الإعلاني]].',
                            { ul: [
                                'أنت مدير (Admin) في نشاطك التجاري على ميتا، أي في business.facebook.com.',
                                'في نشاطك التجاري حساب إعلاني، وصفحة فيسبوك، وحساب إنستجرام احترافي.',
                                'دورك في هذا الحساب «مالك»، لأن المالك وحده يحفظ رمز الإعلانات والحدود.',
                                'فعّل مدير حسابك الإعلانات لحسابك وحدّد السقف الأعلى المسموح به. إن لم تجد بطاقة «إعلانات ميتا» في **الإعدادات**، فاطلب ذلك منه.',
                            ] },
                            { ol: [
                                'افتح business.facebook.com ← Business Settings ← Users ← **System users**، واضغط Add. اكتب اسماً مثل «AutoReply Ads»، واختر الدور Employee (مستخدم عادي)، ثم أنشئ المستخدم.',
                                'اضغط **Assign assets** وامنحه بتحكم كامل (Full control): حسابك الإعلاني، وصفحة فيسبوك، وحساب إنستجرام، وتطبيق أوتوريبلاي برو (رقمه `847772258381375`). إن لم يظهر التطبيق في القائمة فأضفه أولاً من Business Settings ← Accounts ← Apps ← Add ← Connect an app ID، أو اطلب من مدير حسابك مشاركته معك.',
                                'اضغط **Generate token**، واختر التطبيق، واجعل الانتهاء Never، وفعّل الصلاحيات `ads_management` و`ads_read` و`business_management`، ومعها `pages_read_engagement` و`pages_show_list` و`pages_manage_ads` لتعمل الصفحة وحساب إنستجرام مع الإعلانات.',
                                'انسخ الرمز مباشرة، فهو يظهر مرة واحدة فقط.',
                                'في أوتوريبلاي برو افتح **الإعدادات** ← بطاقة «إعلانات ميتا»، والصق الرمز في خانة **رمز إعلانات مستخدم النظام**، ثم اضغط **اختبر الاتصال**.',
                                'اختر حسابك من **اختر حساباً إعلانياً**، وتأكد أن الاسم والعملة صحيحان وأن الحالة نشطة.',
                                'تأكد من وسيلة الدفع: تعرض شاشة الإعلانات إن كانت مضافة. وإن لم تكن، فأضفها من ميتا نفسها (Billing & payments في مدير الإعلانات)، فلا تتيح ميتا إضافتها من مكان آخر.',
                                'حدّد **أقصى ميزانية يومية** و**سقف الإنفاق الشهري**، ثم اضغط **احفظ**.',
                                'اضغط **افتح شاشة الإعلانات** وتأكد أنها لا تعرض أي خطوة غير مكتملة. كل ما تنشئه يبدأ متوقفاً، ولا يُنفَق شيء قبل أن تضغط «فعّل».',
                            ] },
                            { warn: 'امنح المستخدم أصوله كلها قبل أن تنشئ الرمز. فالرمز يحمل ما كان ممنوحاً وقت إنشائه، وما أضفته بعد ذلك قد يستلزم رمزاً جديداً. ولا تُرسل الرمز لأحد، ولا تلصقه إلا في الإعدادات.' },
                            { dl: [
                                ['أقصى ميزانية يومية', 'أكبر ميزانية يومية يجوز لأي حملة أو مجموعة إعلانية. يرفض النظام أي ميزانية فوقها.'],
                                ['سقف الإنفاق الشهري', 'مجموع ما يجوز إنفاقه في الشهر على كل إعلاناتك. إذا بلغه الإنفاق أوقف النظام الحملات النشطة وأرسل لك تنبيهاً.'],
                                ['الحد الأعلى المسموح به', 'يضعه مدير حسابك لك، ولا يجوز أن تتجاوزه حدودك. تراه في بطاقة «إعلانات ميتا».'],
                            ] },
                            'إذا حفظت حداً أعلى من المسموح به، يرفض النظام الحفظ برسالة «فوق الحد الأعلى» ويعرض لك القيمة المسموح بها. الحل: أدخل قيمة تساويها أو تقلّ عنها. وإن كنت تحتاج إلى أكثر، فاطلب من مدير حسابك رفع الحد، ثم احفظ من جديد.',
                            { note: 'تعرض اللوحة المبالغ بعملة حسابك الإعلاني ودون ضريبة. وقد تُضيف ميتا ضريبة، مثل القيمة المضافة، في فاتورتها، فاترك هامشاً للضريبة عند تحديد سقفك.' },
                            'من يدفع لميتا؟ أنت. وسيلة الدفع مرتبطة بحسابك الإعلاني في نشاطك التجاري، وتصدر ميتا فواتيرها باسمك مباشرة. لا تدفع المنصة لميتا شيئاً عنك، ولا يمرّ إنفاقك الإعلاني عبرها.',
                            'مشاركة الإنفاق: يرى مدير حسابك صحة إعلاناتك، أي هل الرمز يعمل، وحالة الحساب الإعلاني، ووجود وسيلة دفع، والتنبيهات المفتوحة، والنسبة المستهلكة من السقف الشهري. أما المبالغ فلا يراها إلا إذا فعّلت أنت الخيار **شارك إنفاقي الإعلاني مع مدير حسابي** في **الإعدادات** ← بطاقة «إعلانات ميتا».',
                            'عند تفعيله يرى مدير حسابك ما أُنفق هذا الشهر واليوم، وسقفك الشهري وأقصى ميزانية يومية. وهو مطفأ ما لم تفعّله. لإيقاف المشاركة أطفئ الخيار نفسه، ويسري ذلك في الحال. ويسجَّل كل تغيير في سجل التدقيق، ولا يغيّره إلا المالك.',
                        ],
                        en: [
                            'If your account is managed by AutoReply Pro, Meta ads run on your own ad account and your own payment method, and your spend never passes through AutoReply Pro. Setup takes about twenty minutes and you do it once.',
                            'Check these before you start. Each step is explained in detail in [[ads#connect|Connect your ad account]].',
                            { ul: [
                                'You are an Admin of your own business on Meta, at business.facebook.com.',
                                'Your business has an ad account, a Facebook Page and an Instagram professional account.',
                                'You have the Owner role in this account, because only owners can save the ads token and the limits.',
                                'The account manager has switched ads on for your account and set the ceiling. If you do not see the “Meta ads” card in **Settings**, ask for that.',
                            ] },
                            { ol: [
                                'Open business.facebook.com → Business Settings → Users → **System users** and press Add. Name it something like “AutoReply Ads”, pick the Employee role, and create it.',
                                'Press **Assign assets** and give it, with full control: your ad account, your Facebook Page, your Instagram account and the AutoReply Pro app (ID `847772258381375`). If the app is not in the list, add it first under Business Settings → Accounts → Apps → Add → Connect an app ID, or ask the account manager to share it with you.',
                                'Press **Generate token**, choose the app, set the expiry to Never, and turn on `ads_management`, `ads_read` and `business_management`, plus `pages_read_engagement`, `pages_show_list` and `pages_manage_ads` so the Page and the Instagram account work with ads.',
                                'Copy the token right away. It is shown only once.',
                                'In AutoReply Pro open **Settings** → the “Meta ads” card, paste the token into **System-user ads token**, then press **Test connection**.',
                                'Pick your account under **Choose an ad account**, and check that the name and currency are right and the status is active.',
                                'Check the payment method: the Ads screen shows whether one is set. If not, add it in Meta itself (Billing & payments in Ads Manager); Meta does not let you add it anywhere else.',
                                'Set **Max daily budget** and **Monthly spend cap**, then press **Save**.',
                                'Press **Open the Ads screen** and check it shows no missing step. Everything you create starts paused, and nothing is spent until you press Activate.',
                            ] },
                            { warn: 'Give the system user all its assets before you generate the token. A token carries what was assigned when it was made, and anything you add later may need a new token. Never send the token to anyone, and paste it only into Settings.' },
                            { dl: [
                                ['Max daily budget', 'The largest daily budget any campaign or ad set may have. The server refuses any budget above it.'],
                                ['Monthly spend cap', 'The most that can be spent in a month across all your ads. When spending reaches it, the system pauses the active campaigns and sends you an alert.'],
                                ['The ceiling', 'Set by the account manager for your account; your limits cannot exceed it. You see it on the “Meta ads” card.'],
                            ] },
                            'If you save a limit above the ceiling, the save is refused with an “over the ceiling” message that shows the allowed value. Enter that value or less. If you need more, ask the account manager to raise the ceiling, then save again.',
                            { note: 'The dashboard shows amounts in your ad account’s currency and excluding tax. Meta may add tax, such as VAT, on its invoice, so leave room for it when you set your cap.' },
                            'Who pays Meta? You do. The payment method belongs to your ad account in your own business, and Meta invoices you directly. The platform pays Meta nothing on your behalf, and your ad spend never passes through it.',
                            'Share spend: your account manager sees the health of your ads: whether the token works, the ad account’s status, whether a payment method is set, open alerts, and the percentage of the monthly cap used. The amounts stay hidden unless you turn on **Share my ad spend with my account manager** in **Settings** → the “Meta ads” card.',
                            'When it is on, your account manager sees what was spent this month and today, plus your monthly cap and max daily budget. It is off until you turn it on. To stop sharing, switch the same option off and it takes effect immediately. Every change is written to the audit log, and only the owner can change it.',
                        ],
                    },
                },
                {
                    id: 'rules',
                    title: { ar: 'القواعد', en: 'Rules' },
                    body: {
                        ar: [
                            'القاعدة تعليمة دائمة تكتبها مرة واحدة: إذا تحققت هذه الشروط في إعلان أو مجموعة إعلانية أو حملة، فافعل ما يلي. يفحصها أوتوريبلاي برو كل ساعة نيابة عنك.',
                            { dl: [
                                ['الإنفاق', 'ما صُرف من المال.'],
                                ['النتائج', 'عدد النتائج التي حققها الإعلان.'],
                                ['تكلفة النتيجة', 'الإنفاق مقسوماً على عدد النتائج.'],
                                ['تكلفة المحادثة', 'الإنفاق مقسوماً على عدد المحادثات التي بدأها الناس معك.'],
                                ['نسبة النقر', 'نسبة من نقروا على الرابط إلى من شاهدوا الإعلان (CTR).'],
                                ['التكرار', 'كم مرة شاهد الشخص الواحد إعلانك في المتوسط. يُقرأ لليوم فقط وفي الحملات أو الإعلانات، لأن ميتا لا تجمع الوصول عبر عدة أيام.'],
                                ['تكلفة الألف ظهور', 'كم تدفع مقابل كل ألف ظهور (CPM).'],
                                ['وتيرة الإنفاق', 'ما صُرف اليوم من الميزانية اليومية مقارنةً بما مضى من اليوم. الرقم 1 يعني أن الإنفاق على الوتيرة المتوقعة، والرقم 2 يعني ضعف السرعة. هذا الشرط للحملات والمجموعات الإعلانية فقط، لأن الإعلان لا ميزانية له.'],
                                ['إعلان مرفوض', 'رفضته ميتا أو وجدت فيه مشكلة. هذا الشرط لا يقبل إلا التنبيه.'],
                            ] },
                            'لكل شرط نافذة زمنية تختارها: اليوم، أو آخر ثلاثة أيام، أو آخر سبعة أيام (تشمل اليوم). وتُحسب الأيام بتوقيت الحساب الإعلاني نفسه.',
                            'يمكنك وضع خمسة شروط كحدٍّ أقصى، ويجب أن تتحقق كلها معاً حتى تعمل القاعدة. والقاعدة لا تحكم على عنصر قبل أن يتوفر له الحد الأدنى من البيانات الذي حددته (عدد الظهور، أو الإنفاق، أو كليهما). وحتى يتوفر هذا الحد تسجّل «بيانات غير كافية» ولا تفعل شيئاً.',
                            { note: 'إعلان أنفق مالاً ولم يحقق أي محادثة تُعدّ تكلفته مرتفعة جداً. لذلك ضع حداً أدنى للظهور، وإلا قد تعمل القاعدة على أول ظهور للإعلان.' },
                            'تراقب القاعدة العناصر التي تعمل فعلاً. أما المتوقفة والمؤرشفة والمحذوفة فتتركها، إلا قاعدة «استئناف» فتنظر إلى المتوقفة، وقاعدة «الإعلان المرفوض» فتنظر إلى كل العناصر غير المؤرشفة.',
                            { dl: [
                                ['تعمل وحدها بعد الحفظ', 'إيقاف العنصر، وخفض الميزانية بنسبة مئوية (من 5% إلى 90%)، والتنبيه.'],
                                ['تصبح اقتراحاً توافق عليه في كل مرة', 'رفع الميزانية بنسبة مئوية (من 5% إلى 100%)، واستئناف العنصر المتوقف.'],
                            ] },
                            'حفظ القاعدة يعني موافقتك عليها. وإذا عدّل شخص شروطها أو إجراءاتها فتُعدّ موافقة جديدة منه. والقاعدة إما أن تحمي (إيقاف أو خفض) وإما أن ترفع (رفع أو استئناف)، ولا تجمع الاثنين.',
                            'لماذا هذا الفرق؟',
                            { ul: [
                                'أي زيادة في الإنفاق تحتاج موافقتك أنت في كل مرة. القاعدة تقترح ولا تنفّذ.',
                                'السقف الشهري والحد الأقصى اليومي يسريان دائماً، فالاقتراح الذي توافق عليه يمر بالفحص نفسه الذي يمر به أي تعديل تجريه بيدك.',
                                'تسمح ميتا بأربعة تعديلات للميزانية فقط لكل مجموعة إعلانية في الساعة. فإذا استُنفدت هذه التعديلات تتخطى القاعدة الخفض هذه المرة وتسجّل السبب.',
                                'الخفض لا ينزل أبداً دون الحد الأدنى للميزانية اليومية عند ميتا.',
                            ] },
                            { dl: [
                                ['إجراء واحد لكل عنصر', 'في الفحص الواحد لا يُغيَّر العنصر الواحد إلا مرة، حتى لو تحققت فيه شروط عدة قواعد. ومن يسبق من القواعد يأخذ العنصر، وتسجّل الأخرى أنه «مأخوذ». وكذلك تترك القاعدة العنصر الذي يوجد عليه تغيير قيد التنفيذ.'],
                                ['استراحة 24 ساعة', 'بعد أن تغيّر قاعدة عنصراً ما، لا تغيّره القاعدة نفسها مرة أخرى قبل مرور 24 ساعة. فخفض 20% لا يتكرر كل ساعة.'],
                            ] },
                            'السجل: كل فحص تجريه القاعدة يُسجَّل، ولكل سجل إحدى هذه الحالات. وفي كل سجل ترى العناصر التي تحققت فيها الشروط وقيمها، وما نُفّذ، وسبب ما تُرك.',
                            { dl: [
                                ['راقبت ولا شيء يلزم', 'فحصت القاعدة أرقاماً حقيقية، ولم يلزم شيء.'],
                                ['نفّذت', 'أُوقف عنصر أو خُفضت ميزانية أو أُرسل تنبيه.'],
                                ['اقترحت', 'وُضع مقترح برفع أو استئناف ينتظر موافقتك في الإعلانات ← المقترحات.'],
                                ['بيانات غير كافية', 'العناصر المراقَبة كلها دون الحد الأدنى للبيانات.'],
                                ['تعذّر الفحص', 'لم تستطع القاعدة قراءة الحساب في تلك الساعة.'],
                            ] },
                            { warn: 'إذا مرّت 24 ساعة دون فحص حقيقي (أي دون «راقبت ولا شيء يلزم» أو «نفّذت» أو «اقترحت»)، يصلك تنبيه بأن القاعدة لا تراقب. فهي تكون عمياء طوال تلك المدة.' },
                            'أسباب ذلك وما تفعله:',
                            { qa: [
                                ['بيانات غير كافية', 'الإعلان جديد أو إنفاقه قليل. انتظر حتى يجمع بيانات، أو خفّض الحد الأدنى للظهور إن كان مرتفعاً أكثر من اللازم.'],
                                ['رفضت ميتا رمز الإعلانات', 'الصق رمزاً جديداً أو أعد الاتصال. الخطوات في [[ads#connect]].'],
                                ['ميتا مشغولة أو أبطأت الطلبات', 'ينتهي هذا غالباً وحده، فتعود القاعدة في الساعة التالية. وإذا استمر فراجع [[troubleshooting]].'],
                            ] },
                        ],
                        en: [
                            'A rule is a standing instruction you write once: if these conditions hold for an ad, an ad set or a campaign, do this. AutoReply Pro checks it for you every hour.',
                            { dl: [
                                ['Spend', 'How much money has gone out.'],
                                ['Results', 'The number of results the ad has produced.'],
                                ['Cost per result', 'Spend divided by the number of results.'],
                                ['Cost per conversation', 'Spend divided by the number of conversations people started with you.'],
                                ['Click-through rate', 'Link clicks as a share of impressions (CTR).'],
                                ['Frequency', 'How many times one person has seen your ad, on average. Read for today only, on campaigns or ads, because reach does not add up across days.'],
                                ['CPM', 'What you pay per thousand impressions.'],
                                ['Spending pace', 'How much of today’s daily budget is spent, compared with how much of the day has gone. 1 means on pace, 2 means twice as fast. Only for campaigns and ad sets, because an ad has no budget of its own.'],
                                ['Rejected ad', 'Meta has disapproved the ad or found a problem with it. This condition can only notify you.'],
                            ] },
                            'Each condition looks at a window you pick: today, the last 3 days, or the last 7 days (all of them include today). Days are counted in the ad account’s own time zone.',
                            'A rule can have up to five conditions, and all of them must hold before it acts. It also does not judge an item until the item has the minimum data you set (impressions, spend, or both). Until then it records “not enough data” and does nothing.',
                            { note: 'An ad that has spent money and produced no conversations counts as having a very high cost. Set a minimum number of impressions, or the rule may fire on an ad’s first impressions.' },
                            'A rule watches the items that are actually running. Paused, archived and deleted ones are left alone. The exceptions are a rule that resumes, which looks at paused items, and a rejected-ad rule, which looks at every item that is not archived or deleted.',
                            { dl: [
                                ['Runs on its own once you save it', 'Pause the item, lower its budget by a percentage (5% to 90%), or notify you.'],
                                ['Becomes a proposal you approve each time', 'Raise the budget by a percentage (5% to 100%), or resume a paused item.'],
                            ] },
                            'Saving a rule counts as approving it. If someone changes its conditions or actions, that is a new approval by them. A rule either protects (pause, lower) or raises (raise, resume), never both.',
                            'Why the difference?',
                            { ul: [
                                'Any increase in spend needs your yes, every time. The rule proposes; it never carries it out.',
                                'The monthly cap and the daily maximum always apply, so a proposal you approve goes through the same checks as any change you make by hand.',
                                'Meta allows only 4 budget changes per ad set per hour. When they are used up, the rule skips the cut this time and records why.',
                                'A lowered budget never goes below Meta’s minimum daily budget.',
                            ] },
                            { dl: [
                                ['One action per item', 'In one check, an item is changed at most once, even if several rules match it. The first rule to get there takes it, and the others record it as “taken”. A rule also leaves alone an item that has a change in progress.'],
                                ['A 24-hour pause', 'After a rule changes an item, the same rule does not change that item again for 24 hours. So a 20% cut is not repeated every hour.'],
                            ] },
                            'History: every check a rule makes is recorded, with one of these outcomes. Each record shows the items that matched and their values, what was done, and why anything was left alone.',
                            { dl: [
                                ['Watched, nothing to do', 'The rule looked at real numbers and nothing was needed.'],
                                ['Acted', 'An item was paused, a budget was lowered, or a notification was sent.'],
                                ['Proposed', 'A raise or resume proposal is waiting for your approval in Ads → Proposals.'],
                                ['Not enough data', 'Every item the rule watches is below the minimum data.'],
                                ['Could not check', 'The rule could not read the account that hour.'],
                            ] },
                            { warn: 'If 24 hours pass without a real check (no “Watched, nothing to do”, “Acted” or “Proposed”), you get an alert that the rule is not watching. For that whole time it was blind.' },
                            'The causes, and what to do:',
                            { qa: [
                                ['Not enough data', 'The ad is new or has spent little. Wait for it to gather data, or lower the minimum impressions if it is higher than it needs to be.'],
                                ['Meta refused the ads token', 'Paste a new token or reconnect. The steps are in [[ads#connect]].'],
                                ['Meta is busy or slowed the requests down', 'This usually clears by itself and the rule is back in the next hour. If it keeps happening, see [[troubleshooting]].'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'rule-templates',
                    title: { ar: 'قوالب القواعد', en: 'Rule templates' },
                    body: {
                        ar: [
                            'أربعة قوالب جاهزة تبدأ منها بدل أن تكتب القاعدة من الصفر. يمكنك تعديل أرقامها قبل الحفظ.',
                            { dl: [
                                ['**تكلفة المحادثة مرتفعة ← إيقاف**', 'تنظر إلى الإعلانات. إذا زادت تكلفة المحادثة في آخر ثلاثة أيام على الحد الذي تضعه أنت، وبعد أن يبلغ الإعلان 500 ظهور، أوقفته وأرسلت تنبيهاً. استخدمها حين تريد ألا يستمر إعلان في استهلاك المال دون محادثات.'],
                                ['**الإنفاق سريع جدًا ← نبّهني**', 'تنظر إلى المجموعات الإعلانية. إذا تجاوزت وتيرة الإنفاق اليوم 1.5 مرة، أرسلت تنبيهاً ولم تغيّر شيئاً. استخدمها حين تريد أن تعرف فقط أن ميزانية اليوم تنفد مبكراً.'],
                                ['**التكرار فوق 3 ← خفّض الميزانية 20%**', 'تنظر إلى الحملات. إذا زاد التكرار اليوم على 3، وبعد 1000 ظهور، خفضت الميزانية اليومية للحملة بنسبة 20% وأرسلت تنبيهاً. استخدمها حين يملّ الجمهور من رؤية الإعلان نفسه. ولا تعمل إلا على حملة لها ميزانية يومية خاصة بها.'],
                                ['**إعلان مرفوض ← نبّهني**', 'تنظر إلى الإعلانات. إذا رفضت ميتا إعلاناً أو وجدت فيه مشكلة أرسلت تنبيهاً. استخدمها دائماً تقريباً، فهي لا تغيّر شيئاً.'],
                            ] },
                            'أمثلة بأرقام:',
                            { ul: [
                                'أوقف الإعلان إذا زادت تكلفة المحادثة على 15 ريالاً خلال ثلاثة أيام، بعد 500 ظهور. إعلان صرف 60 ريالاً وجاءته 3 محادثات تكلفته 20 ريالاً، فيُوقَف وتصلك رسالة تنبيه.',
                                'نبّهني إذا تجاوزت وتيرة الإنفاق 1.5. مجموعة ميزانيتها 100 ريال صرفت 50 ريالاً عند الساعة السادسة صباحاً (ربع اليوم) وتيرتها 2، فيصلك تنبيه.',
                                'اخفض الميزانية 20% إذا زاد التكرار اليوم على 3، بعد 1000 ظهور. حملة ميزانيتها 50 ريالاً في اليوم تصبح 40 ريالاً، ولا تُخفض مرة أخرى قبل مرور 24 ساعة.',
                                'نبّهني إذا رُفض إعلان. إذا وجدت ميتا مشكلة في أحد إعلاناتك يصلك تنبيه به في الفحص التالي.',
                            ] },
                            { tip: 'ابدأ بقاعدة تنبّه فقط، وراجع السجل أياماً، ثم أضف الإيقاف أو الخفض حين تطمئن إلى أن الأرقام تعمل كما تتوقع.' },
                        ],
                        en: [
                            'Four ready-made templates to start from, instead of writing a rule from scratch. You can change their numbers before you save.',
                            { dl: [
                                ['**Cost per conversation too high → pause**', 'Looks at ads. If the cost per conversation over the last 3 days is above the limit you set, and the ad has reached 500 impressions, it pauses the ad and notifies you. Use it when you do not want an ad to keep spending without conversations.'],
                                ['**Spending too fast → tell me**', 'Looks at ad sets. If today’s spending pace goes above 1.5, it notifies you and changes nothing. Use it when you just want to know that today’s budget is running out early.'],
                                ['**Frequency over 3 → lower the budget 20%**', 'Looks at campaigns. If today’s frequency is above 3, after 1,000 impressions, it lowers the campaign’s daily budget by 20% and notifies you. Use it when your audience is getting tired of seeing the same ad. It only works on a campaign that holds its own daily budget.'],
                                ['**Ad rejected → tell me**', 'Looks at ads. If Meta disapproves an ad or finds a problem with it, it notifies you. Almost always worth having, since it changes nothing.'],
                            ] },
                            'Examples with numbers:',
                            { ul: [
                                'Pause an ad when cost per conversation is over 15 SAR over 3 days, after 500 impressions. An ad that spent 60 SAR and got 3 conversations costs 20 SAR each, so it is paused and you get a notification.',
                                'Notify me when spending pace goes above 1.5. An ad set with a 100 SAR budget that has spent 50 SAR by 6 a.m. (a quarter of the day) has a pace of 2, so you get an alert.',
                                'Lower the budget 20% when today’s frequency is over 3, after 1,000 impressions. A campaign on 50 SAR a day goes to 40 SAR, and is not cut again for 24 hours.',
                                'Notify me when an ad is rejected. If Meta finds a problem with one of your ads, you are told at the next check.',
                            ] },
                            { tip: 'Start with a rule that only notifies. Read its history for a few days, and add the pause or the cut once you trust that the numbers behave the way you expect.' },
                        ],
                    },
                },
                {
                    id: 'lead-ads',
                    title: { ar: 'إعلانات جمع العملاء: نماذج داخل الإعلان', en: 'Lead ads: a form inside the ad' },
                    body: {
                        ar: [
                            'يفتح إعلان جمع العملاء نموذجًا قصيرًا داخل فيسبوك أو إنستجرام: يكتب الشخص اسمه ورقم هاتفه أو بريده دون أن يغادر التطبيق، وتصل إجاباته إلى تبويب **العملاء المحتملون** في قسم الإعلانات.',
                            { h: 'مقفلة حتى الاعتماد القانوني' },
                            'إجابات النموذج بيانات شخصية، لذلك تبقى إعلانات جمع العملاء مقفلة لكل مساحة عمل حتى يسجّل مدير المنصة اعتمادًا قانونيًا يغطيها لدول بعينها. وما دامت مقفلة لا يُجمع شيء: لا يمكن إنشاء نموذج، ويبقى هدف **العملاء المحتملون** في تبويب الإنشاء مقفلًا، ولا تشترك صفحتك في إشعارات العملاء المحتملين. التفاصيل في [[ads#leads-and-privacy]].',
                            { h: 'إنشاء نموذج' },
                            { ol: [
                                'افتح الإعلانات ← **العملاء المحتملون** واضغط **نموذج جديد**.',
                                'سمِّ النموذج واختر لغته: العربية (الافتراضية) أو الإنجليزية.',
                                'اختر الأسئلة: الاسم الكامل، والبريد الإلكتروني، ورقم الهاتف، والمدينة، ثم حتى خمسة أسئلة من عندك.',
                                'فعّل **اسأل هل نتواصل معهم** إن أردت أن تعرف من يقبل أن تراسله؛ فمن دون موافقته لا يجوز لك مراسلته.',
                                'اكتب شاشة الشكر: عنوانًا وجملة ونص زر ورابطًا يبدأ بـ https (صفحة الدورة مثلًا)، ثم اضغط **إنشاء النموذج**.',
                            ] },
                            'يرتبط كل نموذج بسياسة الخصوصية تلقائيًا. وترفض الأداة أنواع الأسئلة التي تقيّدها ميتا، وأي سؤال من عندك يطلب معلومات حساسة كالصحة أو الدين أو أرقام الحسابات أو الهوية أو كلمات المرور.',
                            { h: 'إنشاء الإعلان' },
                            'في تبويب **الإنشاء** اختر هدف **العملاء المحتملون**، ثم النموذج، ثم صورة أو فيديو ترفعه (المنشور المنشور لا يحمل النموذج)، وزر الإعلان مثل **سجّل الآن**. ولا يستهدف الإعلان إلا الدول التي يغطيها الاعتماد. ويُنشأ متوقفًا مثل كل إعلان، ولا يبدأ الإنفاق إلا حين تفعّله.',
                            { h: 'كيف يصل العميل المحتمل' },
                            { ul: [
                                'ترسل ميتا إشعارًا خلال دقائق من إرسال النموذج، فيجلب التطبيق الإجابات ويحفظها مشفّرة.',
                                'وكل ست ساعات يسأل التطبيق ميتا عن أي عميل محتمل لم يصل إشعاره، فلا يضيع أحد إن تأخر إشعار أو فُقد.',
                                'تظهر الإجابات في الجدول مع تاريخها والنموذج و«وافق على التواصل» وتاريخ حذفها.',
                                'زر **تنزيل CSV** ينزّل الجدول بالمرشّحات المختارة، ويُسجَّل كل تنزيل في سجل التدقيق.',
                            ] },
                            { note: 'لا يرى العملاء المحتملين إلا مالك مساحة العمل. ولا يتواصل معهم أوتوريبلاي من تلقاء نفسه.' },
                        ],
                        en: [
                            'A lead ad opens a short form inside Facebook or Instagram: the person types their name and phone number or email without leaving the app, and the answers arrive in the **Leads** tab of Ads.',
                            { h: 'Locked until a legal sign-off' },
                            'Form answers are personal data, so lead ads stay locked for each workspace until the platform admin records a legal sign-off that covers them for given countries. While locked nothing is collected: no form can be made, the **Leads** goal in the Create tab stays locked, and your Page is not subscribed to lead notifications. Details in [[ads#leads-and-privacy]].',
                            { h: 'Make a form' },
                            { ol: [
                                'Open Ads → **Leads** and press **New form**.',
                                'Name the form and choose its language: Arabic (the default) or English.',
                                'Pick the questions: full name, email, phone number and city, then up to five questions of your own.',
                                'Tick **Ask whether we may contact them** if you want to know who agrees to be messaged; without a yes you may not message them.',
                                'Write the thank-you screen: a title, a sentence, a button text and an https link (your course page, say), then press **Create form**.',
                            ] },
                            'Every form links to the privacy policy automatically. The tool refuses the question types Meta restricts, and any question of your own that asks for sensitive information such as health, religion, account or ID numbers, or passwords.',
                            { h: 'Make the ad' },
                            'In the **Create** tab choose the **Leads** goal, then the form, then an image or a video you upload (a published post cannot carry the form) and the ad’s button, such as **Sign up**. The ad can only target the countries the sign-off covers. It is created paused like every ad, and nothing is spent until you switch it on.',
                            { h: 'How a lead arrives' },
                            { ul: [
                                'Meta sends a notification within minutes of the form being sent; the app fetches the answers and stores them encrypted.',
                                'Every six hours the app also asks Meta for any lead whose notification never came, so nobody is lost if a notification is late or missed.',
                                'The answers show in the table with their date, the form, "Agreed to be contacted" and the date they will be deleted.',
                                '**Download CSV** downloads the table with the filters you chose, and every download is recorded in the audit log.',
                            ] },
                            { note: 'Only the workspace owner sees the leads. AutoReply never contacts them by itself.' },
                        ],
                    },
                },
                {
                    id: 'leads-and-privacy',
                    title: { ar: 'العملاء المحتملون والخصوصية', en: 'Leads and privacy' },
                    body: {
                        ar: [
                            'كل إجابة في نموذج جمع العملاء بيانات شخصية لإنسان وثق بك. ولذلك بُنيت هذه الميزة على أن تحفظ الأقل وأطول ما يلزم فقط.',
                            { h: 'ما معنى الاعتماد القانوني' },
                            'يشترط قانون حماية البيانات الشخصية في مصر (رقم 151 لسنة 2020، ومهلة الامتثال تنتهي في 1 نوفمبر 2026) ترخيصًا لمن يعالج البيانات، وترخيصًا منفصلًا للتسويق الإلكتروني المباشر، وموافقة الشخص على نقل بياناته خارج مصر. ويشترط نظام حماية البيانات الشخصية في السعودية الموافقة على التسويق وحق إلغاء الاشتراك وحفظ السجلات. الاعتماد هو أن يسجّل مدير المنصة أن رأيًا قانونيًا يغطي ذلك لدولك: من أصدره، ومتى، ولأي دول. وإذا أُلغي الاعتماد توقف جمع العملاء الجدد في الحال، وبقي من جُمع قبلُ خاضعًا لمدة الحفظ نفسها.',
                            { h: 'ما يُحفظ وكيف' },
                            { ul: [
                                'تُحفظ الإجابات مشفّرة (AES-256-GCM) بمفتاح خارج قاعدة البيانات، ولا تُفك إلا لعرضها لك أو تنزيلها.',
                                'يُحفظ البريد ورقم الهاتف أيضًا في صورة رمز مموّه بمفتاح سري (HMAC)، ليُعثر على الشخص إذا طلب الحذف دون فك إجابات أحد.',
                                'لا تُرسل الإجابات إلى أي مزوّد ذكاء اصطناعي، ولا يقترح Claude إعلانات لجمع العملاء أبدًا.',
                            ] },
                            { h: 'مدة الحفظ' },
                            'تُحذف الإجابات تلقائيًا بعد 90 يومًا افتراضيًا، ويمكنك اختيار مدة من يوم إلى 365 يومًا من الإعدادات ← الإعلانات. ويبقى بعد الحذف سجل للعدد فقط (التاريخ والنموذج والإعلان) دون أي بيانات شخصية. وإذا قصّرت المدة طُبّقت على العملاء المحتملين الحاليين في الفحص التالي.',
                            { h: 'الحذف بطلب صاحب البيانات' },
                            'إذا طلب شخص حذف بياناته، ابحث في أداة حذف البيانات بالبريد أو رقم الهاتف الذي كتبه في النموذج: يظهر عدد إجاباته، ويُحذف السجل كله.',
                            { h: 'الموافقة والتواصل' },
                            'لا يتواصل أوتوريبلاي مع أي عميل محتمل من تلقاء نفسه، ولا يسلّمه إلى مساعد الرسائل أو واتساب. ويبيّن عمود «وافق على التواصل» من قال نعم لسؤال الموافقة. وفي مصر يحتاج التسويق الإلكتروني المباشر ترخيصًا خاصًا وسجلًا للموافقات، وفي السعودية يجب أن تعرّف بنفسك في كل رسالة وأن تتيح إلغاء الاشتراك.',
                            { warn: 'ما يفعله التطبيق لا يغني عن التزاماتك أنت: الترخيص في مصر، وسجل الموافقات، والرد على طلبات الحذف، وإبلاغ الجهة المختصة خلال 72 ساعة عند أي تسرّب.' },
                        ],
                        en: [
                            'Every answer in a lead form is the personal data of someone who trusted you. So this feature is built to keep the least, for no longer than needed.',
                            { h: 'What the legal sign-off means' },
                            'Egypt’s Personal Data Protection Law (No. 151 of 2020; the compliance period ends on 1 November 2026) requires a licence to process personal data, a separate licence for direct electronic marketing, and the person’s consent to their data leaving Egypt. Saudi Arabia’s Personal Data Protection Law requires consent to marketing, a way to unsubscribe and kept records. The sign-off is the platform admin recording that a legal opinion covers this for your countries: who gave it, when, and for which countries. If the sign-off is revoked, new leads stop at once, and the ones already collected keep the same retention period.',
                            { h: 'What is stored, and how' },
                            { ul: [
                                'Answers are stored encrypted (AES-256-GCM) with a key held outside the database, and are decrypted only to show them to you or download them.',
                                'The email and phone number are also stored as a scrambled code under a secret key (HMAC), so a person can be found when they ask for deletion without decrypting anyone’s answers.',
                                'Answers are never sent to any AI provider, and Claude never proposes lead ads.',
                            ] },
                            { h: 'How long it is kept' },
                            'Answers are deleted automatically after 90 days by default; you can choose 1 to 365 days in Settings → Ads. After deletion a count-only record stays (the date, the form, the ad) with no personal data. If you shorten the period, it applies to existing leads at the next check.',
                            { h: 'Deletion when the person asks' },
                            'If someone asks for their data to be deleted, search the data-erasure tool by the email or phone number they typed in the form: their answers are counted, and the whole record is deleted.',
                            { h: 'Consent and contact' },
                            'AutoReply never contacts a lead by itself and never hands one to the messaging or WhatsApp assistant. The "Agreed to be contacted" column shows who said yes to the consent question. In Egypt direct electronic marketing needs its own licence and a consent register; in Saudi Arabia every message must say who you are and offer a way to unsubscribe.',
                            { warn: 'What the app does does not replace your own obligations: the licence in Egypt, the consent register, answering deletion requests, and notifying the authority within 72 hours of any breach.' },
                        ],
                    },
                },
                {
                    id: 'split-tests',
                    title: { ar: 'الاختبار المقسَّم', en: 'Split tests' },
                    body: {
                        ar: [
                            'ما هو؟ اختبار تُجريه ميتا نفسها: نسختان من الإعلان، أو جمهوران، تعملان في الوقت نفسه. تقسّم ميتا الجمهور بينهما قسمة لا تتقاطع، فلا يرى أحدٌ النسختين معاً، وتبقى المقارنة عادلة. وعند نهايته تقول ميتا أيّ النسختين أفضل أداءً، وبأيّ درجة من الثقة.',
                            'كيف تنشئ اختباراً؟',
                            { ol: [
                                'أنشئ النسخ أولاً في أداة البناء وهي متوقفة مؤقتاً: إعلانات في مجموعة إعلانية واحدة لاختبار النسخ، أو مجموعات إعلانية لاختبار الجمهور.',
                                'افتح **الإعلانات**، ثم تبويب الاختبارات، ثم **اختبار جديد**.',
                                'اختر ما تقارنه: **نسختان من الإعلان** أو **جمهوران**، ثم ضع علامة على النسخ المتوقفة التي تريدها.',
                                'أدخل الميزانية اليومية وتاريخي البدء والانتهاء، ثم اضغط **أنشئ الاختبار**.',
                            ] },
                            'الميزانية والتواريخ:',
                            { ul: [
                                'مدة الاختبار من يوم واحد إلى ثلاثين يوماً، ويبدأ من الغد فصاعداً.',
                                'إنشاء الاختبار لا يُنفق شيئاً: تبقى كل النسخ متوقفة مؤقتاً حتى تضغط **ابدأ**، وتسألك الصفحة قبل ذلك وتذكر لك المبلغ.',
                                'أسوأ حالة هي الميزانية اليومية × عدد الأيام. تظهر في النموذج قبل الإنشاء، وتُحتسب من سقفك الشهري، فإن تجاوزها رفضه النظام.',
                                'يظهر التقسيم المتساوي أثناء الاختيار: نسختان 50% و50%، وثلاث نسخ 34% و33% و33%.',
                            ] },
                            'قراءة النتيجة: تعرض الصفحة الفائز الذي حدّدته ميتا ونسبة ثقتها به. إن كانت النسبة منخفضة فالفرق بين النسخ ليس مؤكداً بعد: شغّل الاختبار مدة أطول أو بميزانية أكبر. وإن لم تستطع ميتا التمييز بين النسخ فستقرأ «لا فائز واضحاً»، وهذه نتيجة صحيحة وليست عطلاً.',
                            'إبقاء الفائز: حين تنتهي النتيجة يظهر اقتراح بإيقاف النسخة الأضعف مؤقتاً، يصلك في شاشة الاقتراحات ولا يُنفَّذ إلا إذا وافقتَ عليه أنت. لا يتغيّر شيء من تلقاء نفسه.',
                            'الحدود:',
                            { ul: [
                                'الاختبار يحتاج محفظة أعمال في ميتا؛ إن لم تكن محفوظة بعد ستطلب منك الصفحة اختيار واحدة، وتُحفظ مع إعدادات الإعلانات.',
                                'من نسختين إلى سبع نسخ للإعلان، ومن جمهورين إلى خمسة جماهير.',
                                'غيّر شيئاً واحداً فقط بين النسخ (الصورة، أو النص، أو العنوان)، وإلا لن تعرف أيّ تغيير أحدث الفرق.',
                            ] },
                            { tip: 'ابدأ باختبار قصير بمبلغ صغير لتتأكد أن كل شيء يعمل، ثم كرّره بمدة أطول.' },
                        ],
                        en: [
                            'What is it? A test run by Meta itself: two versions of an ad, or two audiences, running at the same time. Meta splits the audience between them so the groups never overlap and nobody sees both, which keeps the comparison fair. At the end Meta says which version performed better, and how confident it is.',
                            'How do I create one?',
                            { ol: [
                                'Build the versions first in the builder, paused: ads in one ad set to test the ad, or ad sets to test the audience.',
                                'Open **Ads**, then the Tests tab, then **New test**.',
                                'Choose what you compare, **Two versions of the ad** or **Two audiences**, then tick the paused versions you want.',
                                'Enter the daily budget and the start and end dates, then press **Create the test**.',
                            ] },
                            'Budget and dates:',
                            { ul: [
                                'A test runs from 1 to 30 days and starts tomorrow or later.',
                                'Creating a test spends nothing: every version stays paused until you press **Start**, and the page asks first and names the amount.',
                                'The worst case is the daily budget × the number of days. It is shown in the form before you create the test, it counts against your monthly cap, and the system refuses a test that would go over it.',
                                'The equal split is shown as you choose: two versions are 50% and 50%, three are 34%, 33% and 33%.',
                            ] },
                            'Reading the result: the page shows the winner Meta picked and how confident Meta is in it. A low confidence means the difference is not established yet: run the test longer, or with a bigger budget. If Meta cannot separate the versions you will read “No clear winner”, which is a real answer and not a fault.',
                            'Keeping the winner: when a result is in, a proposal to pause the weaker version appears on the Proposals screen. It only happens if you approve it. Nothing changes by itself.',
                            'Limits:',
                            { ul: [
                                'A test needs a Meta business portfolio. If none is saved yet, the page asks you to choose one, and saves it with your ads settings.',
                                'From 2 to 7 versions of an ad, or from 2 to 5 audiences.',
                                'Change one thing at a time between versions (the image, the text or the headline), or you will not know which change made the difference.',
                            ] },
                            { tip: 'Start with a short test on a small budget to check that everything works, then repeat it for longer.' },
                        ],
                    },
                },
            ],
        },
        // ─── 6. Carousel Studio overview ─────────────────────────────────────
        {
            slug: 'studio',
            group: 'studio',
            icon: 'layers',
            title: { ar: 'استوديو الكاروسيل: نظرة عامة', en: 'Carousel Studio overview' },
            summary: {
                ar: 'من درس مصوّر إلى كاروسيل مجدول في ثلاث خطوات، ومن يفعل ماذا.',
                en: 'From a recorded lesson to a scheduled carousel in three steps, and who does what.',
            },
            related: ['worker', 'create', 'studio-schedule', 'monteur', 'infographics'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'ما الاستوديو؟', en: 'What the Studio is' },
                    body: {
                        ar: [
                            'الاستوديو يكتب لك منشورات كاروسيل من دروسك المصوّرة: يقرأ الدرس، ويكتب الشرائح بأسلوبك، ويختار لقطات من الفيديو، ويجهّز نص إنستجرام ووصف تيك توك، والكلمة المفتاحية، والرسالة الخاصة.',
                            'ويرسم كل كاروسيل بمقاسين: **إنستجرام 4:5** و**تيك توك 9:16**. ولا ينشر شيئاً دون أن تراجعه وتضغط **جدوِل** بنفسك.',
                        ],
                        en: [
                            'The Studio writes carousel posts from your recorded lessons: it reads the lesson, writes the slides in your voice, picks screenshots from the video, and prepares the Instagram caption, the TikTok description, the keyword and the DM.',
                            'Every carousel is drawn in two sizes, **Instagram 4:5** and **TikTok 9:16**, and nothing is posted until you review it and press **Schedule** yourself.',
                        ],
                    },
                },
                {
                    id: 'steps',
                    title: { ar: 'الخطوات الثلاث', en: 'The three steps' },
                    body: {
                        ar: [
                            { ol: [
                                '**اختر الموضوع:** في **كاروسيل جديد** اختر **من درس** (حتى ثلاثة دروس مفهرسة) أو **من فكرة** تكتبها بجملة أو جملتين.',
                                '**أنشئ:** اضغط **أنشئ الكاروسيل**. تستغرق الكتابة دقيقة تقريباً (وقد تصل إلى دقيقتين)، وبعدها يرسم العامل الشرائح. يمكنك مغادرة الصفحة، وتنتظرك المسودّة في **المسودات**.',
                                '**راجع وجدوِل:** افتح المسودّة، وتحقّق من الشرائح في المعاينة، وعدّل ما تريد، ثم اضغط **احفظ وحدّث المعاينة**. بعدها **إلى الجدولة**، واختر الموعد، واضغط **جدوِل**.',
                            ] },
                            'التفاصيل في [[create]] و[[studio-schedule]].',
                        ],
                        en: [
                            { ol: [
                                '**Choose a topic:** in **New carousel**, pick **From a lesson** (up to three indexed lessons) or **From an idea** you describe in a sentence or two.',
                                '**Generate:** press **Generate carousel**. Writing takes about a minute (two at most), then the worker draws the slides. You can leave the page: the draft waits for you under **Drafts**.',
                                '**Review & schedule:** open the draft, check the slides in the preview, edit what you like and press **Save & update preview**. Then **Schedule**, pick a time, and press **Schedule** again to confirm.',
                            ] },
                            'The details are in [[create]] and [[studio-schedule]].',
                        ],
                    },
                },
                {
                    id: 'who',
                    title: { ar: 'من يفعل ماذا؟', en: 'Who does what' },
                    body: {
                        ar: [
                            { dl: [
                                ['أوتوريبلاي برو (الخادم)', 'يكتب الشرائح والنصوص بالذكاء الاصطناعي، ويحفظ المسودّات، ويجدول المنشورات.'],
                                ['العامل على جهازك', 'يفحص مجلد الدروس، ويفهرس كل درس، ويرسم الشرائح. اقرأ [[worker]].'],
                                ['أنت', 'تختار الموضوع، وتراجع، وتعتمد.'],
                            ] },
                        ],
                        en: [
                            { dl: [
                                ['AutoReply Pro (the server)', 'Writes the slides and captions with AI, keeps your drafts, and schedules the posts.'],
                                ['The worker on your computer', 'Scans your lesson folder, indexes each lesson, and draws the slides. See [[worker]].'],
                                ['You', 'Choose the topic, review, and approve.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'setup',
                    title: { ar: 'أول مرة؟ جهّز المكتبة', en: 'First time? Get your library ready' },
                    body: {
                        ar: [
                            'عند أول فتح للاستوديو ترى **جهّز مكتبة الدروس**: ثلاث خطوات تُجريها مرة واحدة فقط.',
                            { ol: [
                                '**اختر مجلد فيديوهات الدروس:** مسار المجلد على جهازك، في **الإعدادات** داخل الاستوديو.',
                                '**اربط العامل على جهاز الماك:** أنشئ عاملاً، والصق رمزه في إعدادات العامل على جهازك. الطريقة في [[worker#install]].',
                                '**افحص الدروس وفهرسها:** **افحص المكتبة**، وبعدها فهرسة الدروس. التفاصيل في [[library]].',
                            ] },
                            { tip: 'لا تريد الانتظار؟ يمكنك كتابة **من فكرة** الآن حتى قبل تجهيز المكتبة، ويرسم العامل الشرائح حين يتصل.' },
                        ],
                        en: [
                            'The first time you open the Studio you’ll see **Get your library ready**: three steps you only do once.',
                            { ol: [
                                '**Choose the folder with your lesson videos:** its path on your computer, in the Studio’s **Settings**.',
                                '**Connect the worker on your Mac:** create a worker and paste its token into the worker’s config on your computer. How: [[worker#install]].',
                                '**Scan and index your lessons:** **Scan library**, then index the lessons. The details are in [[library]].',
                            ] },
                            { tip: 'Don’t want to wait? You can write **From an idea** right now, before the library is ready, and the worker draws the slides as soon as it connects.' },
                        ],
                    },
                },
                {
                    id: 'screens',
                    title: { ar: 'شاشات الاستوديو', en: 'The Studio’s screens' },
                    body: {
                        ar: [
                            { dl: [
                                ['الكاروسيل', 'حالة العامل والمكتبة، ونموذج **كاروسيل جديد**، و**خطّط أسبوعي**، و**المسودات**.'],
                                ['الإعدادات', 'الهوية البصرية، والأسلوب، والمنتج والدعوات، والجدول، ومجلد المكتبة، والعمّال. اقرأ [[studio-settings]].'],
                            ] },
                            '**خطّط أسبوعي** يقترح لك عدة كاروسيل للأسبوع مع مواعيدها. استبعد ما لا يعجبك، واضغط **أنشئ الكل**، فيُكتب واحد تلو الآخر.',
                        ],
                        en: [
                            { dl: [
                                ['Carousels', 'The worker and library status, the **New carousel** form, **Plan my week**, and your **Drafts**.'],
                                ['Settings', 'Brand kit, voice, product and calls to action, schedule, library folder and workers. See [[studio-settings]].'],
                            ] },
                            '**Plan my week** proposes several carousels for the week, each with a time slot. Remove the ones you don’t like and press **Generate all**: they are written one after another.',
                        ],
                    },
                },
            ],
        },
        // ─── 7. What is the worker? ──────────────────────────────────────────
        {
            slug: 'worker',
            group: 'studio',
            icon: 'laptop',
            title: { ar: 'ما هو العامل؟', en: 'What is the worker?' },
            summary: {
                ar: 'برنامج صغير على جهازك ينفّذ العمل الثقيل بجانب فيديوهاتك: لماذا هو موجود، وإلى ماذا يصل، وكيف تشغّله وتوقفه، ولماذا هو آمن.',
                en: 'A small helper program on your computer that does the heavy work next to your videos: why it exists, what it can reach, how to start and stop it, and why it is safe.',
            },
            related: ['library', 'studio-settings', 'troubleshooting'],
            sections: [
                {
                    id: 'simple',
                    title: { ar: 'باختصار', en: 'In short' },
                    body: {
                        ar: [
                            'العامل برنامج صغير يعمل على جهازك، بجانب فيديوهات دروسك، وينفّذ العمل الثقيل عن الاستوديو: يبحث عن الدروس في مجلدك، ويشاهد كل درس ويستخرج منه ملاحظات ولقطات، ويرسم شرائح الكاروسيل.',
                            'فكّر فيه كمساعد يقيم عند جهازك: يعطيه الاستوديو المهام، فينفّذها ويعيد النتيجة. ولو أطفأت الجهاز، تنتظره المهام حتى يعود، ولا يضيع شيء.',
                            { note: 'العامل حالياً يعمل على أجهزة **ماك**.' },
                        ],
                        en: [
                            'The worker is a small helper program that runs on your computer, next to your lesson videos, and does the Studio’s heavy lifting: it finds the lessons in your folder, watches each one to take notes and screenshots, and draws the carousel slides.',
                            'Think of it as an assistant sitting at your computer: the Studio hands it jobs, it does them and sends the results back. Switch the computer off and the jobs simply wait for it. Nothing is lost.',
                            { note: 'For now the worker runs on a **Mac**.' },
                        ],
                    },
                },
                {
                    id: 'why',
                    title: { ar: 'لماذا العامل موجود؟', en: 'Why it exists' },
                    body: {
                        ar: [
                            { ul: [
                                '**فيديوهاتك كبيرة:** رفع ساعات من الفيديو إلى أي خادم يستغرق وقتاً طويلاً ويستهلك الإنترنت. يعمل العامل عليها وهي في مكانها.',
                                '**الرسم يحتاج إلى جهاز:** رسم الشرائح بالخطوط والألوان واللقطات يحتاج إلى متصفح وأدوات فيديو، وهذا لا يناسب خوادم الويب الخفيفة.',
                                '**خصوصيتك:** فيديوهاتك الأصلية لا تغادر جهازك أبداً.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                '**Your videos are big:** uploading hours of video to any server is slow and eats your bandwidth. The worker uses them where they already are.',
                                '**Drawing needs a real computer:** rendering slides with your fonts, colours and screenshots needs a browser engine and video tools, which lightweight web servers don’t have.',
                                '**Your privacy:** your original videos never leave your computer.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'jobs',
                    title: { ar: 'ماذا يفعل بالضبط؟', en: 'What it actually does' },
                    body: {
                        ar: [
                            { dl: [
                                ['فحص المكتبة', 'يبحث عن فيديوهات الدروس في المجلد الذي حددته، ويقرأ مدة كل واحد منها.'],
                                ['فهرسة درس', 'يصنع نسخة صغيرة من الدرس، ويجعل ذكاء Google (Gemini) يشاهدها ويكتب ملاحظاتها ويختار من 12 إلى 30 لقطة، ثم يصوّر كل لقطة بصورة مصغّرة. التفاصيل في [[library]].'],
                                ['رسم الكاروسيل', 'يستخرج لقطات الشرائح من الفيديو الأصلي بجودة كاملة، ويرسم كل شريحة بمقاس إنستجرام وتيك توك، ويرفع الصور إلى حسابك.'],
                            ] },
                        ],
                        en: [
                            { dl: [
                                ['Scanning the library', 'Finds the lesson videos in the folder you set, and reads how long each one is.'],
                                ['Indexing a lesson', 'Makes a small copy of the lesson, has Google’s AI (Gemini) watch it to write the lesson’s notes and pick 12 to 30 screenshot moments, then takes a thumbnail of each moment. See [[library]].'],
                                ['Rendering a carousel', 'Takes the slides’ screenshots from the original video at full quality, draws every slide at Instagram and TikTok sizes, and uploads the images to your account.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'access',
                    title: { ar: 'إلى ماذا يصل، وإلى ماذا لا يصل؟', en: 'What it can and can’t access' },
                    body: {
                        ar: [
                            '**يستطيع:**',
                            { ul: [
                                'يقرأ الفيديوهات داخل مجلد الكورس الذي كتبته في ملف إعداداته (`courseRoot`) فقط. ويجب أن يكون مجلد المكتبة في إعدادات الاستوديو داخل هذا المجلد، وأي مسار خارجه يُرفض.',
                                'يكتب ملفات مؤقتة داخل مجلده هو (النسخ الصغيرة واللقطات)، ويمكنك حذفها متى شئت.',
                                'يتصل بأوتوريبلاي برو، ويتصل بـ Google Gemini وقت الفهرسة.',
                            ] },
                            '**لا يستطيع:**',
                            { ul: [
                                'لا يقرأ أي ملف خارج مجلد الكورس: لا صورك ولا مستنداتك ولا غيرها.',
                                'لا يستقبل أي اتصال من الإنترنت، فلا يستطيع أحد دخول جهازك عن طريقه.',
                                'لا ينشر ولا يرسل رسائل بنفسه. النشر والجدولة يجريان من حسابك هنا، وبقرارك أنت.',
                                'لا يرى مهام مساحات العمل الأخرى، بل مهام مساحة عملك فقط.',
                            ] },
                        ],
                        en: [
                            '**It can:**',
                            { ul: [
                                'Read videos inside the course folder named in its config file (`courseRoot`), and nowhere else. The library folder in the Studio settings must sit inside that folder; any path outside it is refused.',
                                'Write temporary files inside its own folder (the small copies and the screenshots), which you can delete whenever you like.',
                                'Talk to AutoReply Pro, and to Google Gemini while indexing.',
                            ] },
                            '**It can’t:**',
                            { ul: [
                                'Read anything outside the course folder: not your photos, your documents or anything else.',
                                'Accept any connection from the internet, so nobody can reach your computer through it.',
                                'Publish or send messages by itself. Publishing and scheduling happen in your account here, when you decide.',
                                'See other accounts’ jobs. It only ever sees yours.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'security',
                    title: { ar: 'الأمان', en: 'Security' },
                    body: {
                        ar: [
                            { ul: [
                                '**يتصل بالخارج فقط:** العامل هو الذي يسأل «هل هناك مهام لي؟» كل بضع ثوانٍ (كل 5 ثوانٍ وهو مشغول، وحتى 30 ثانية وهو فارغ). لا يفتح أي منفذ على جهازك، ولا يظهر شيء على جهازك للإنترنت.',
                                '**رمز خاص لكل عامل:** لكل عامل رمزه، الخاص بمساحة عملك وحدها. يظهر لك الرمز مرة واحدة حين تنشئه، ونحن نحفظ بصمة مشفّرة منه، لا الرمز نفسه.',
                                '**تلغيه بضغطة:** من إعدادات الاستوديو ← **العمّال** ← **ألغِ**، ويُرفض الرمز من اللحظة نفسها.',
                                '**لا يصل إلى Google إلا نسخ صغيرة:** للفهرسة، يصنع العامل نسخة صغيرة وخفيفة من الدرس (عرض 640 بكسل، لقطة واحدة كل ثانية، وصوت أحادي)، ويرفعها إلى Gemini، ويحذفها حين ينتهي. ولو فشل الحذف لأي سبب، تحذفها Google تلقائياً خلال 48 ساعة. الفيديو الأصلي لا يغادر جهازك.',
                                'الذي يصل إلى حسابك في أوتوريبلاي برو: صور مصغّرة للقطات (480 بكسل)، والشرائح المرسومة، لأنها هي التي تُنشر.',
                                'ملف الإعدادات `studio.config.json` يحتوي على رمز العامل ومفتاح Gemini، فاحتفظ به لنفسك ولا تشاركه مع أحد. يقفله سكربت التثبيت على مستخدمك وحده.',
                            ] },
                            { note: 'مفتاح Gemini الموجود في العامل هو مفتاحك أنت، وتنطبق عليه شروط Google. انظر [[ai-usage#billing|لماذا الفوترة مهمة]] قبل أن تفهرس دروساً فيها معلومات خاصة.' },
                        ],
                        en: [
                            { ul: [
                                '**Outbound only:** the worker is the one asking “any jobs for me?” every few seconds (every 5 seconds while busy, up to 30 when idle). It opens no port on your computer, and nothing on your computer is exposed to the internet.',
                                '**A token per worker, per account:** every worker has its own token, tied to your account alone. You see the token once, when you create it; we keep only a hashed fingerprint, never the token itself.',
                                '**Revocable in one click:** Studio settings → **Workers** → **Revoke**, and the token is refused from that moment.',
                                '**Only small, low-resolution previews go to Google:** to index a lesson, the worker makes a small, light copy (640px wide, one frame a second, mono sound), uploads it to Gemini and deletes it as soon as it is done. If the deletion ever fails, Google deletes it on its own within 48 hours. The original video never leaves your computer.',
                                'What reaches your AutoReply Pro account: 480px thumbnails of the moments, and the drawn slides, because those are what gets posted.',
                                'The config file `studio.config.json` holds the worker token and your Gemini key, so keep it to yourself. The install script locks it to your user for you.',
                            ] },
                            { note: 'The Gemini key in the worker is your own, and Google’s terms apply to it. Read [[ai-usage#billing|why billing matters]] before indexing lessons that contain anything private.' },
                        ],
                    },
                },
                {
                    id: 'install',
                    title: { ar: 'التثبيت والتشغيل والإيقاف', en: 'Install, start, stop, uninstall' },
                    body: {
                        ar: [
                            'تحتاج إلى: ماك عليه **Node 22** أو أحدث، و**ffmpeg** (`brew install ffmpeg`)، ومجلد العامل على جهازك وقد شغّلت فيه `npm install`.',
                            { ol: [
                                'من الاستوديو ← **الإعدادات** ← **العمّال**: اكتب اسماً في **عامل جديد** (مثلاً «ماك الاستوديو») واضغط **أنشئ عاملاً**. انسخ الرمز الآن لأنه لا يظهر مرة أخرى، واضغط **نسخته**.',
                                'في مجلد العامل، انسخ ملف المثال واملأه: `cp studio.config.example.json studio.config.json`. اكتب فيه رابط التطبيق (`appUrl`)، والرمز (`token`)، ومفتاح Gemini (`geminiApiKey`)، ومجلد الكورس (`courseRoot`)، واسم العامل (`name`).',
                                'ثبّته ليعمل وحده كلما سجّلت دخولك إلى الماك، بالأمر الموجود أدناه.',
                                'ارجع إلى الاستوديو، وخلال ثوانٍ تقول الشارة في الأعلى «الماك متصل».',
                            ] },
                            { code: 'scripts/install-studio-worker.sh', caption: 'التثبيت والتشغيل (ويعمل مع كل تسجيل دخول)' },
                            'أوامر ستحتاجها لاحقاً، تكتبها في الطرفية (Terminal) من داخل مجلد العامل:',
                            { code: "launchctl print gui/$(id -u)/com.aicourse.studio-worker | grep -E 'state|pid'", caption: 'هل يعمل؟' },
                            { code: 'launchctl kickstart -k gui/$(id -u)/com.aicourse.studio-worker', caption: 'إعادة التشغيل' },
                            { code: 'launchctl bootout gui/$(id -u)/com.aicourse.studio-worker', caption: 'إيقاف مؤقت (يعود مع أول تسجيل دخول، أو شغّل سكربت التثبيت)' },
                            { code: 'scripts/uninstall-studio-worker.sh', caption: 'إلغاء التثبيت نهائياً' },
                            { code: 'tail -f ~/Library/Logs/aicourse-studio-worker.log', caption: 'السجل: ماذا يفعل الآن' },
                            { code: 'node scripts/studio-worker.mjs', caption: 'تشغيل يدوي دون تثبيت (Ctrl‑C يوقفه، وينتظر حتى 15 ثانية لينهي المهمة التي يعمل عليها)' },
                            { tip: 'غيّرت نسخة Node أو نقلت مجلد العامل؟ شغّل سكربت التثبيت مرة أخرى.' },
                        ],
                        en: [
                            'You need: a Mac with **Node 22** or later, **ffmpeg** (`brew install ffmpeg`), and the worker folder on your computer with `npm install` run in it.',
                            { ol: [
                                'In the Studio, open **Settings** → **Workers**: type a name under **New worker** (such as “Studio Mac”) and press **Create worker**. Copy the token now, because it is never shown again, then press **I’ve copied it**.',
                                'In the worker folder, copy the example config and fill it in: `cp studio.config.example.json studio.config.json`. Set the app address (`appUrl`), the token (`token`), your Gemini key (`geminiApiKey`), the course folder (`courseRoot`) and the worker’s name (`name`).',
                                'Install it so it starts on its own whenever you log in to the Mac, with the command below.',
                                'Back in the Studio, within seconds the chip at the top says “Mac online”.',
                            ] },
                            { code: 'scripts/install-studio-worker.sh', caption: 'Install and start (it then starts at every login)' },
                            'Commands you’ll want later, typed in Terminal from inside the worker folder:',
                            { code: "launchctl print gui/$(id -u)/com.aicourse.studio-worker | grep -E 'state|pid'", caption: 'Is it running?' },
                            { code: 'launchctl kickstart -k gui/$(id -u)/com.aicourse.studio-worker', caption: 'Restart it' },
                            { code: 'launchctl bootout gui/$(id -u)/com.aicourse.studio-worker', caption: 'Stop it for now (it starts again at your next login, or run the install script)' },
                            { code: 'scripts/uninstall-studio-worker.sh', caption: 'Uninstall it for good' },
                            { code: 'tail -f ~/Library/Logs/aicourse-studio-worker.log', caption: 'The log: what it is doing right now' },
                            { code: 'node scripts/studio-worker.mjs', caption: 'Run it by hand, without installing (Ctrl-C stops it, after up to 15 seconds to finish the job in hand)' },
                            { tip: 'Switched Node versions or moved the worker folder? Run the install script again.' },
                        ],
                    },
                },
                {
                    id: 'status',
                    title: { ar: 'متصل أو غير متصل', en: 'Online and offline' },
                    body: {
                        ar: [
                            'شارة واحدة تظهر في أعلى كل أقسام الاستوديو (الكاروسيل والمونتور والإنفوجرافيك والشروحات) وفي «اقتراحات الذكاء الاصطناعي» في الإعلانات. لها ثلاث حالات:',
                            { dl: [
                                ['● الماك متصل · Claude مسجّل الدخول', 'تواصل العامل مع الاستوديو خلال آخر 90 ثانية، وClaude على الماك يجيب. يظهر بعدها عدد الأعمال التي بالانتظار. كل شيء يعمل.'],
                                ['▲ Claude على الماك غير مسجّل الدخول', 'العامل متصل لكن Claude الذي يكتب عنه طلب تسجيل الدخول من جديد، فلا يكتب الاستوديو شيئاً. شغّل `claude /login` على الماك (التفاصيل في «تنبيه: Claude على الماك مسجَّل الخروج» أدناه).'],
                                ['○ الماك نائم منذ ٣ س · مهمتان تنتظران', 'لم يتواصل العامل منذ أكثر من 90 ثانية، ويقول لك الرقم منذ متى. أيقظ الماك فتكمل الأعمال وحدها. وإن لم يتصل أبداً فالشارة تقول «الماك لم يتصل بعد»: تأكد من الرمز في ملف الإعدادات.'],
                            ] },
                            'وهو غير متصل يمكنك كتابة كاروسيل عادي، لأن الكتابة تجري على الخادم. وما ينتظره: الفحص والفهرسة ورسم الشرائح، وترى عددها في **بالانتظار**. وحين يعود يكمّلها وحده. وزر **تحقّق مرة أخرى** يفحص الحالة الآن.',
                        ],
                        en: [
                            'One chip sits at the top of every Studio section (Carousels, Monteur, Infographics, Explainers) and on Ads → AI proposals. It has three states:',
                            { dl: [
                                ['● Mac online · Claude signed in', 'The worker checked in within the last 90 seconds and Claude on the Mac answers. The number after it is how many jobs wait. All good.'],
                                ['▲ Claude on the Mac is signed out', 'The worker is online, but the Claude program it writes with asked to be signed in again, so the Studio can write nothing. Run `claude /login` on the Mac (details under “Alarm: Claude on the Mac is signed out” below).'],
                                ['○ Mac asleep since 3h · 2 jobs wait', 'Nothing from the worker for more than 90 seconds; the number says for how long. Wake the Mac and the jobs carry on by themselves. If it never connected, the chip says “Mac not connected yet”: check the token in its config file.'],
                            ] },
                            'While it is offline you can still write carousels, because writing happens on the server. What waits for it is scanning, indexing and drawing the slides, counted under **Waiting**. When it is back, it picks them up on its own. **Check again** refreshes the status right away.',
                        ],
                    },
                },
                {
                    id: 'sleep',
                    title: { ar: 'حين ينام الجهاز', en: 'When the computer sleeps' },
                    body: {
                        ar: [
                            { ul: [
                                'حين ينام الماك (أو تغلق غطاء اللابتوب)، ينام العامل معه، وبعد 90 ثانية تقول الشارة «الماك نائم منذ …». تنتظر المهام في الطابور ولا يضيع شيء.',
                                'وحين يستيقظ الجهاز، يكمّل وحده دون أن تفعل شيئاً.',
                                'لو نام في منتصف مهمة، ولم يصل عنها خبر 15 دقيقة، يعيدها الاستوديو إلى الطابور ويسندها إلى العامل من جديد. تُسنَد المهمة الواحدة 3 مرات كحد أقصى، وبعدها تفشل مع رسالة توجّهك إلى السجل.',
                            ] },
                            { tip: 'لديك فهرسة طويلة؟ أبقِ الماك مستيقظاً: افتح الطرفية واكتب `caffeinate -i` واتركها مفتوحة حتى تنتهي (Ctrl‑C يوقفها). وإن كان لابتوباً، فاتركه على الشاحن ولا تغلق الغطاء.' },
                        ],
                        en: [
                            { ul: [
                                'When the Mac sleeps (or you close the laptop lid), the worker sleeps with it, and after 90 seconds the chip says “Mac asleep since …”. Jobs wait in the queue; nothing is lost.',
                                'When the computer wakes, the worker carries on by itself.',
                                'If it fell asleep in the middle of a job and the job has not reported in for 15 minutes, the Studio puts it back in the queue and hands it out again. A job is handed out 3 times at most, then it fails with a message pointing you to the log.',
                            ] },
                            { tip: 'Long indexing run ahead? Keep the Mac awake: open Terminal, type `caffeinate -i` and leave it open until it finishes (Ctrl-C stops it). On a laptop, keep it plugged in with the lid open.' },
                        ],
                    },
                },
                {
                    id: 'claude-signed-out',
                    title: { ar: 'تنبيه: Claude على الماك مسجَّل الخروج', en: 'Alarm: Claude on the Mac is signed out' },
                    body: {
                        ar: [
                            'ظهر لك في «اليوم» وفي شارة الماك أعلى الاستوديو أن «Claude على جهاز الماك مسجَّل الخروج». ومعنى ذلك أن العامل يعمل ومتصل بالإنترنت، لكن برنامج Claude الذي يكتب نيابة عنه طلب منك تسجيل الدخول من جديد (يحدث عند انتهاء الجلسة). لذلك لا يستطيع الاستوديو الكتابة: لا اختيار المقاطع ولا الكابشن ولا الإنفوجرافيك ولا اقتراحات الإعلانات.',
                            { ul: [
                                'الريلز تنتظر ولا تغيّر النموذج. لا تنتقل إلى Gemini أو أي نموذج آخر، ولا تهدر محاولاتها: تبقى فيديوهاتك في مكانها حتى يعود Claude.',
                                'أول إجابة ناجحة من Claude تزيل التنبيه وحدها، وتعيد الأعمال التي توقفت بسبب الدخول (الإنفوجرافيك والاقتراحات والشروحات التي فشلت قبل أقل من 3 أيام).',
                                'يصلك بريد إلكتروني مرة واحدة في اليوم ما دام التنبيه قائماً.',
                            ] },
                            { h: 'الحل' },
                            { ol: [
                                'على الماك افتح Terminal.',
                                'اكتب الأمر التالي واتبع الصفحة التي تُفتح لتسجيل الدخول بحساب Claude.',
                            ] },
                            { code: 'claude /login', caption: 'تسجيل الدخول من جديد' },
                            { code: 'launchctl kickstart -k gui/$(id -u)/com.aicourse.studio-worker', caption: 'ثم أعد تشغيل العامل إن لم يرجع العمل خلال دقائق' },
                            { note: 'يسأل التطبيق Claude سؤالاً صغيراً كل نصف ساعة وهو مسجَّل الخروج، فيعرف وحده أنك دخلت. لا تحتاج إلى الضغط على شيء.' },
                        ],
                        en: [
                            'Today and the Mac chip at the top of the Studio say “Claude on the Mac is signed out”. That means the worker is running and online, but the Claude program it writes with asked to be signed in again (it happens when the session expires). So the Studio can write nothing: no clip picks, captions, infographics or ad drafts.',
                            { ul: [
                                'The Monteur waits; it never switches models. It does not fall back to Gemini or any other model, and it does not burn its tries: your videos stay where they are until Claude is back.',
                                'The first answer Claude gives clears the alarm by itself, and puts back the work the sign-in stopped (infographics, proposals and explainers that failed in the last 3 days).',
                                'You get one email a day while the alarm stands.',
                            ] },
                            { h: 'How to fix it' },
                            { ol: [
                                'On the Mac open Terminal.',
                                'Run the command below and follow the page it opens to sign in with your Claude account.',
                            ] },
                            { code: 'claude /login', caption: 'Sign in again' },
                            { code: 'launchctl kickstart -k gui/$(id -u)/com.aicourse.studio-worker', caption: 'Then restart the worker if work does not resume within a few minutes' },
                            { note: 'While signed out, the app asks Claude one tiny question every half hour, so it notices by itself that you signed in. There is nothing to press.' },
                        ],
                    },
                },
                {
                    id: 'worker-offline',
                    title: { ar: 'تنبيه: عامل الاستوديو متوقف وهناك أعمال تنتظره', en: 'Alarm: the worker is offline with work waiting' },
                    body: {
                        ar: [
                            'يظهر هذا التنبيه حين لا يتصل العامل لأكثر من 30 دقيقة وتنتظره في الوقت نفسه أعمال أكثر من 30 دقيقة. غالباً يكون الماك نائماً أو العامل متوقفاً.',
                            { ul: [
                                'أيقظ الماك. يكمّل العامل وحده ويأخذ الأعمال المنتظرة (راجع «حين ينام الجهاز» أعلاه).',
                                'إذا كان الماك مستيقظاً وما زال التنبيه موجوداً، أعد تشغيل العامل بالأمر في قسم التثبيت، وانظر السجل: `tail -f ~/Library/Logs/aicourse-studio-worker.log`.',
                                'لا يضيع شيء من الطابور. وترسل لك الخدمة بريداً إلكترونياً مرة واحدة في اليوم ما دام الوضع هكذا.',
                            ] },
                        ],
                        en: [
                            'This alarm shows when the worker has not called in for over 30 minutes **and** jobs have waited for it for over 30 minutes. Usually the Mac is asleep or the worker stopped.',
                            { ul: [
                                'Wake the Mac. The worker carries on by itself and takes the waiting jobs (see “When the computer sleeps” above).',
                                'If the Mac is awake and the alarm stays, restart the worker with the command in the install section, and read the log: `tail -f ~/Library/Logs/aicourse-studio-worker.log`.',
                                'Nothing in the queue is lost. You get one email a day while it lasts.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'several',
                    title: { ar: 'أكثر من عامل', en: 'Several workers' },
                    body: {
                        ar: [
                            { ul: [
                                'يمكنك ربط أكثر من عامل بمساحة العمل نفسها، مثل ماك آخر. أنشئ عاملاً مستقلاً لكل جهاز، فيكون لكل واحد رمزه، ويمكنك إلغاء أي واحد وحده.',
                                'تذهب المهام إلى أول عامل فارغ يطلبها، وتعرض الشارة في الاستوديو آخر عامل تواصل.',
                                'مهم: تُحفظ مسارات الدروس من الجهاز الذي فحص المكتبة. أي أن أي عامل آخر يجب أن تكون عنده الفيديوهات نفسها وبالمسار نفسه، وإلا فستفشل مهامه. الأسهل: عامل واحد للفهرسة والرسم.',
                                'على الجهاز الواحد، عامل واحد فقط لكل ملف إعدادات. فإن شغّلت آخر، يكتب `another studio worker is running` ويخرج.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'You can connect more than one worker to the same account, such as a second Mac. Create a separate worker for each computer, so each one has its own token and can be revoked on its own.',
                                'Jobs go to whichever free worker asks first, and the Studio’s pill shows the worker seen most recently.',
                                'Important: lesson paths are recorded by the computer that scanned the library, so any other worker needs the same videos at the same paths, or its jobs fail. The simplest setup is one worker for indexing and drawing.',
                                'On one computer, one worker per config file. Start a second one and it prints `another studio worker is running` and exits.',
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 8. The library and indexing ─────────────────────────────────────
        {
            slug: 'library',
            group: 'studio',
            icon: 'folder-search',
            title: { ar: 'المكتبة والفهرسة', en: 'The library and indexing' },
            summary: {
                ar: 'كيف يجد العامل دروسك، وماذا يعني «مفهرس»، وما «اللقطة»، وكم تستغرق الفهرسة.',
                en: 'How the worker finds your lessons, what “indexed” means, what a “moment” is, and how long indexing takes.',
            },
            related: ['worker', 'create', 'troubleshooting'],
            sections: [
                {
                    id: 'folder',
                    title: { ar: 'رتّب مجلد الدروس', en: 'Organise your lesson folder' },
                    body: {
                        ar: [
                            'يبحث العامل عن الدروس في **مجلد المكتبة** الذي تحدده في إعدادات الاستوديو. رتّبه هكذا:',
                            { ul: [
                                'مجلد لكل قسم، وفي اسمه رقم مثل «Chapter 1» أو «Module 3 - Basics». أول رقم في الاسم هو رقم القسم.',
                                'رقم الدرس في آخر اسم الملف: `context pyramid 1.2.mp4` هو الدرس 1.2.',
                                'الفيديو الذي بلا رقم يُحتسب مقدمة القسم.',
                                'الصيغ المقبولة: mp4 و mov و m4v.',
                                'الفيديوهات الملقاة مباشرة في المجلد الرئيسي، أو في مجلدي `marketing` و`out`، لا تُحتسب دروساً.',
                            ] },
                        ],
                        en: [
                            'The worker looks for lessons in the **Library folder** you set in the Studio settings. Organise it like this:',
                            { ul: [
                                'One folder per section, with a number in its name, such as “Chapter 1” or “Module 3 - Basics”. The first number in the name is the section number.',
                                'The lesson number goes at the end of the file name: `context pyramid 1.2.mp4` is lesson 1.2.',
                                'A video with no number counts as the section’s introduction.',
                                'Accepted formats: mp4, mov and m4v.',
                                'Videos loose in the top folder, or inside `marketing` or `out` folders, are not treated as lessons.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'scan',
                    title: { ar: 'فحص المكتبة', en: 'Scanning the library' },
                    body: {
                        ar: [
                            'اضغط **افحص المكتبة** في أعلى صفحة **منشورات الكاروسيل**. يبحث العامل عن الفيديوهات ويضيفها دروساً بحالة **غير مفهرس بعد**. الفحص لا يحذف أي درس، ولو أضفت فيديوهات لاحقاً فافحص مرة أخرى.',
                            'ولو كان الزر معطّلاً ومكتوباً عليه **لم يُحدَّد مجلد المكتبة**، فاضغط **حدّده من الإعدادات**.',
                        ],
                        en: [
                            'Press **Scan library** at the top of the **Carousels** screen. The worker finds the videos and adds them as lessons marked **Not indexed yet**. A scan never deletes a lesson; add more videos later and simply scan again.',
                            'If the button is disabled with **No library folder is set**, press **Set it in Settings**.',
                        ],
                    },
                },
                {
                    id: 'indexing',
                    title: { ar: 'ماذا يعني «مفهرس»؟', en: 'What “indexed” means' },
                    body: {
                        ar: [
                            'الفهرسة أن يشاهد الذكاء الاصطناعي الدرس مرة واحدة ويكتب عنه:',
                            { ul: [
                                'ملخصاً قصيراً.',
                                '**ما يعلّمه الدرس**: النقاط الأساسية.',
                                'البرومبتات التي ظهرت على الشاشة، بحروفها.',
                                'الأدوات التي استُخدمت، والنتائج التي عُرضت.',
                                'من 12 إلى 30 **لقطة**.',
                            ] },
                            'يُكتب الكاروسيل من هذه الملاحظات، ولهذا لا يمكنك اختيار إلا الدروس المفهرسة. والملاحظات هي التي تمنع الذكاء الاصطناعي من اختراع ميزات أو أرقام لم تقلها.',
                            'ابدأ الفهرسة بـ**فهرس الناقص** (كل ما لم يُفهرس)، أو **فهرس الباقي**، أو لدرس واحد: افتحه واضغط **فهرس هذا الدرس**.',
                            { dl: [
                                ['مفهرس', 'جاهز لتختاره.'],
                                ['قيد الفهرسة…', 'العامل يعمل عليه الآن.'],
                                ['غير مفهرس بعد', 'أُضيف بالفحص ولم يُفهرس.'],
                                ['فشلت الفهرسة', 'افتح الدرس وانظر السبب، وبعدها **فهرس هذا الدرس** مرة أخرى.'],
                            ] },
                        ],
                        en: [
                            'Indexing means the AI watches the lesson once and writes down:',
                            { ul: [
                                'A short summary.',
                                '**What it teaches**: the key points.',
                                'The prompts shown on screen, word for word.',
                                'The tools used, and the results demonstrated.',
                                '12 to 30 **moments**.',
                            ] },
                            'Carousels are written from these notes, which is why only indexed lessons can be picked. The notes are also what stops the AI inventing features or numbers you never mentioned.',
                            'Start indexing with **Index missing** (everything not indexed yet), **Index the rest**, or for one lesson: open it and press **Index this lesson**.',
                            { dl: [
                                ['Indexed', 'Ready to pick.'],
                                ['Indexing…', 'The worker is on it now.'],
                                ['Not indexed yet', 'Found by a scan, not indexed yet.'],
                                ['Indexing failed', 'Open the lesson to see why, then press **Index this lesson** again.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'moments',
                    title: { ar: 'ما «اللقطة»؟', en: 'What a “moment” is' },
                    body: {
                        ar: [
                            'اللقطة لحظة مهمة في الدرس: ثانية معيّنة فيها شيء يستحق أن يصبح شريحة. ولكل لقطة:',
                            { ul: [
                                'وقتها بالثواني داخل الفيديو.',
                                'وصف قصير لما على الشاشة.',
                                'نوعها: **شريحة** أو **شاشة تطبيق** أو **نتيجة** أو **كود** أو **برومبت** أو **أخرى**.',
                                'هل هي نظيفة: بلا أسهم ولا خربشة ولا شاشة تحميل. والتي فيها تعليقات يُكتب عليها **عليها تعليقات توضيحية**.',
                                'صورة مصغّرة تراها في الاستوديو.',
                            ] },
                            'وحين تُرسم الشريحة، يستخرج العامل اللقطة من الفيديو الأصلي بجودة كاملة، لا من الصورة المصغّرة.',
                        ],
                        en: [
                            'A moment is a key point in a lesson: a particular second with something on screen worth turning into a slide. Each moment has:',
                            { ul: [
                                'Its time, in seconds, in the video.',
                                'A short description of what is on screen.',
                                'A kind: **Slide**, **App screen**, **Result**, **Code**, **Prompt** or **Other**.',
                                'Whether it is clean: no arrows, scribbles or loading screens. Ones with annotations are marked **Has annotations**.',
                                'A thumbnail you see in the Studio.',
                            ] },
                            'When a slide is drawn, the worker takes that moment from the original video at full quality, not from the thumbnail.',
                        ],
                    },
                },
                {
                    id: 'time',
                    title: { ar: 'كم تستغرق الفهرسة؟', en: 'How long indexing takes' },
                    body: {
                        ar: [
                            { ul: [
                                'عادة بضع دقائق للدرس، وتطول مع الدروس الطويلة أو الإنترنت البطيء، لأن أطول خطوة هي رفع النسخة الصغيرة.',
                                'تُفهرس الدروس واحداً تلو الآخر، فقد يستغرق الكورس كاملاً ساعة أو أكثر.',
                                'لا تحتاج إلى انتظارها كلها: يصبح كل درس جاهزاً للاختيار حين يُفهرس، ويتحدّث العدّاد وحده.',
                                'تريد سرعة أكبر؟ `indexConcurrency` في ملف إعدادات العامل يجعله يعمل على حتى 4 دروس معاً، ويظل الرفع واحداً تلو الآخر.',
                                'أبقِ الجهاز مستيقظاً والعامل متصلاً طوال الفهرسة: [[worker#sleep]].',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'Usually a few minutes per lesson, longer for long lessons or a slow connection, because uploading the small copy is the longest step.',
                                'Lessons are indexed one at a time, so a whole course can take an hour or more.',
                                'You don’t have to wait for all of them: each lesson can be picked as soon as it is indexed, and the counter updates by itself.',
                                'Want it faster? `indexConcurrency` in the worker’s config lets it work on up to 4 lessons at once; uploads still go one at a time.',
                                'Keep the computer awake and the worker online while it indexes: [[worker#sleep]].',
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 9. Creating and editing a carousel ──────────────────────────────
        {
            slug: 'create',
            group: 'studio',
            icon: 'sparkles',
            title: { ar: 'إنشاء كاروسيل وتعديله', en: 'Creating and editing a carousel' },
            summary: {
                ar: 'الخيارات الإضافية، وتعديل الشرائح، واللقطات، وإعادة الكتابة بالذكاء الاصطناعي، والحفظ.',
                en: 'More options, editing slides, screenshots, rewriting with AI, and saving.',
            },
            related: ['studio-schedule', 'library', 'studio-settings'],
            sections: [
                {
                    id: 'start',
                    title: { ar: 'ابدأ', en: 'Start' },
                    body: {
                        ar: [
                            { ol: [
                                'في **كاروسيل جديد** اختر **من درس** أو **من فكرة**.',
                                '**من درس:** اختر حتى ثلاثة دروس مفهرسة، ويمكنك البحث عنها من **ابحث في الدروس**. **من فكرة:** اكتب عما تريد أن يتناوله الكاروسيل بجملة أو جملتين، والتزم بالمعلومات التي تتأكد منها، لأنه يُكتب دون ملاحظات دروس.',
                                'اضغط **أنشئ الكاروسيل**. سترى المراحل: قراءة الدرس، كتابة الشرائح، مراجعة القواعد، رسم الشرائح.',
                            ] },
                        ],
                        en: [
                            { ol: [
                                'In **New carousel**, choose **From a lesson** or **From an idea**.',
                                '**From a lesson:** pick up to three indexed lessons; **Search lessons** finds them by name. **From an idea:** describe the carousel in a sentence or two, and stick to facts you are sure of, because it is written without any lesson notes.',
                                'Press **Generate carousel** and watch the stages: reading the lesson, writing the slides, checking the rules, drawing the slides.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'options',
                    title: { ar: 'خيارات أكثر', en: 'More options' },
                    body: {
                        ar: [
                            'اضغط **خيارات أكثر** تحت الدروس. وهي مغلقة، وترى ملخصها في سطر واحد.',
                            { dl: [
                                ['التركيز', 'مع الدروس فقط: قل له على ماذا يركّز، مثل «الجزء الخاص بالتقارير فقط».'],
                                ['الزاوية', 'شكل المنشور: **نصائح**، أو **خطوة بخطوة**، أو **أخطاء شائعة**، أو **قبل وبعد**، أو **قالب برومبت**، أو **نظرة على الكورس**، أو **يختارها الذكاء الاصطناعي**.'],
                                ['عدد الشرائح', 'من 6 إلى 10. الأولى غلاف، والأخيرة دعوة لاتخاذ إجراء.'],
                                ['الكلمة المفتاحية', 'كلمة واحدة يكتبها المتابع في التعليقات ليصله الرابط. اتركها فارغة وسيقترح لك كلمة لا تتعارض مع ردودك التلقائية المفعّلة. وتجنّب الكلمات القصيرة: [[campaigns#pitfall]].'],
                                ['لون التمييز', 'اللون الذي تتلوّن به الكلمات المميزة. **من ألواني** يختار من ألوانك ويتجنب ما استخدمته مؤخراً، أو اختر لوناً بنفسك، أو اكتبه بصيغة `#RRGGBB`.'],
                            ] },
                            'واختياراتك تُحفظ على هذا الجهاز للكاروسيل القادم.',
                        ],
                        en: [
                            'Press **More options** below the lessons. While it is closed, a one-line summary shows what is set.',
                            { dl: [
                                ['Focus', 'With lessons only: tell it what to concentrate on, such as “only the part about reports”.'],
                                ['Angle', 'The shape of the post: **Tips**, **Step by step**, **Common mistakes**, **Before and after**, **Prompt template**, **Course overview**, or **Let the AI choose**.'],
                                ['Slides', '6 to 10. The first is the cover and the last is the call to action.'],
                                ['Keyword', 'One word people comment to get the DM. Leave it empty and one is suggested that doesn’t clash with your active keyword replies. Avoid short words: [[campaigns#pitfall]].'],
                                ['Accent colour', 'The colour of the highlighted words. **From my palette** picks one of your colours, avoiding the ones used recently; or pick a colour yourself, or type it as `#RRGGBB`.'],
                            ] },
                            'Your choices are remembered on this device for the next carousel.',
                        ],
                    },
                },
                {
                    id: 'review',
                    title: { ar: 'المعاينة', en: 'The preview' },
                    body: {
                        ar: [
                            'افتح المسودّة من **المسودات** عندما تصبح **جاهز**. المعاينة تعرض الشرائح المرسومة فعلاً:',
                            { ul: [
                                'بدّل بين **إنستجرام 4:5** و**تيك توك 9:16**.',
                                'تنقّل بين الشرائح بالأسهم، واضغط على شريحة (أو Enter) لتفتح تعديلها.',
                                'شريط الشرائح تحت المعاينة، والشريحة التي فيها مشكلة عليها علامة.',
                            ] },
                        ],
                        en: [
                            'Open the draft from **Drafts** once it is **Ready**. The preview shows the slides as actually drawn:',
                            { ul: [
                                'Switch between **Instagram 4:5** and **TikTok 9:16**.',
                                'Move between slides with the arrow keys, and click a slide (or press Enter) to edit it.',
                                'The strip under the preview shows every slide, and a slide with problems is marked.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'edit',
                    title: { ar: 'تعديل الشرائح', en: 'Editing slides' },
                    body: {
                        ar: [
                            { ul: [
                                'عدّل النص في الحقول بجانب المعاينة: **العنوان**، و**الجزء المميّز** (كلمات من العنوان تتلوّن، ويجب أن تُكتب حرفياً كما هي في العنوان)، و**النص**، والعناصر.',
                                '**نوع الشريحة**: غيّره، ويبقى العنوان والنص المشترك.',
                                'قدّم الشرائح وأخّرها، أو **كرّر** شريحة، أو **أضف شريحة**، أو احذفها. حذفتها بالخطأ؟ **تراجع** يعيدها.',
                                'للكاروسيل غلاف واحد ودعوة واحدة في آخره، وعدد الشرائح من 6 إلى 10.',
                                '**المظهر**: غيّر لون التمييز للكاروسيل كله.',
                                '**النصوص المرافقة**: **نص إنستجرام وفيسبوك**، و**عنوان تيك توك** (90 حرفاً كحد أقصى)، و**وصف تيك توك**. وتحت كل واحد السطر الذي يجب أن يكون فيه: نص إنستجرام فيه جملة التعليق بالكلمة المفتاحية، ووصف تيك توك فيه سطر البايو.',
                                '**أتمتة الكلمة المفتاحية**: الكلمة، والرسالة الخاصة التي تصل كل من يعلّق بها.',
                            ] },
                            'وإن وُجدت أخطاء، تظهر **مشكلات يلزم إصلاحها** مع رابط لكل مشكلة في مكانها.',
                        ],
                        en: [
                            { ul: [
                                'Edit the text in the fields beside the preview: the **Title**, the **Highlight** (words from the title painted in the accent colour, written exactly as they appear in it), the **Body**, and any items.',
                                '**Slide type**: change it and the title and any shared text are kept.',
                                'Move slides earlier or later, **Duplicate** one, **Add slide**, or delete one. Deleted the wrong one? **Undo** brings it back.',
                                'A carousel has one cover and one closing call to action, and 6 to 10 slides.',
                                '**Look**: change the accent colour for the whole carousel.',
                                '**Captions**: the **Instagram & Facebook caption**, the **TikTok title** (90 characters at most) and the **TikTok description**. Under each is the line it must contain: the Instagram caption asks for the keyword comment, and the TikTok description carries the bio line.',
                                '**Keyword automation**: the keyword, and the DM everyone who comments it receives.',
                            ] },
                            'When something is wrong, **Problems to fix** lists it, with a link to each problem where it is.',
                        ],
                    },
                },
                {
                    id: 'shots',
                    title: { ar: 'اللقطات', en: 'Screenshots' },
                    body: {
                        ar: [
                            { ul: [
                                'في شريحة **لقطة شاشة** (وفي الغلاف)، اضغط **غيّر اللقطة** أو **اختر لقطة**.',
                                'ترى لقطات **دروس هذا الكاروسيل**، ويمكنك الاختيار من **دروس أخرى**.',
                                '**اللقطات النظيفة فقط** مفعّل افتراضياً: يخفي اللقطات التي فيها أسهم أو خربشة أو شاشة تحميل. ومرّر المؤشر على لقطة لتراها كبيرة.',
                                '**أزل** يزيل اللقطة من الشريحة.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'On a **Screenshot** slide (and on the cover), press **Change screenshot** or **Pick a screenshot**.',
                                'You see moments from **This carousel’s lessons**, and you can pick from **Other lessons** too.',
                                '**Clean frames only** is on by default: it hides frames with arrows, scribbles or a loading screen. Point at a frame to see it large.',
                                '**Remove** takes the screenshot off the slide.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'rewrite',
                    title: { ar: 'أعد الكتابة بالذكاء الاصطناعي', en: 'Rewrite with AI' },
                    body: {
                        ar: [
                            { ul: [
                                'على أي شريحة اضغط **أعد الكتابة بالذكاء الاصطناعي**، واكتب في **التوجيه** ما تريد، مثل «أقصر» أو «ابدأ بالنتيجة»، ثم اضغط **أعد الكتابة**.',
                                'يعيد كتابة هذه الشريحة فقط، ومن نفس الدروس، وضمن حدودها.',
                                'تعديلاتك التي لم تُحفظ تُحفظ أولاً، ليعيد كتابة النسخة التي أمامك.',
                                'تريد نسخة جديدة كاملة؟ **اكتبه من جديد** يكتب مسودّة أخرى بزاوية تختارها، وتبقى المسودّة الحالية كما هي.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'On any slide, press **Rewrite with AI**, type what you want in **Instruction** (“shorter”, or “lead with the result”) and press **Rewrite**.',
                                'Only that slide is rewritten, from the same lessons, within its limits.',
                                'Unsaved edits are saved first, so the AI rewrites the version you are looking at.',
                                'Want a whole new version? **Write it again** writes a second draft at the angle you pick, and this draft stays as it is.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'save',
                    title: { ar: 'الحفظ', en: 'Saving' },
                    body: {
                        ar: [
                            { ul: [
                                '**احفظ وحدّث المعاينة** (أو ⌘S على الماك وCtrl+S على ويندوز) يحفظ ويرسل الشرائح إلى العامل ليعيد رسمها، وتتحدّث المعاينة عندما ينتهي.',
                                'ما دمت لم تحفظ، ترى **تعديلات غير محفوظة**، وتعرض المعاينة آخر رسم.',
                                '**تجاهل التغييرات** يعيدك إلى آخر نسخة محفوظة.',
                                'أغلقت الصفحة بالخطأ؟ التعديلات محفوظة على هذا الجهاز، وتعود إليك عندما تفتح المسودّة.',
                                'فشل الرسم؟ النص محفوظ، اضغط **أعد الرسم**.',
                                '**احذف المسودة** يحذفها مع شرائحها، ولا يصلح بعد الجدولة.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                '**Save & update preview** (or ⌘S on a Mac, Ctrl+S on Windows) saves and sends the slides to the worker to redraw; the preview updates when it is done.',
                                'Until you save you’ll see **Unsaved changes**, and the preview shows the last render.',
                                '**Discard changes** takes you back to the last saved version.',
                                'Closed the page by mistake? Your edits are kept on this device and come back when you reopen the draft.',
                                'Rendering failed? The text is saved: press **Render again**.',
                                '**Delete draft** deletes it with its slides, and isn’t possible once it is scheduled.',
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 10. Scheduling from the Studio, and the TikTok batch ────────────
        {
            slug: 'studio-schedule',
            group: 'studio',
            icon: 'calendar-clock',
            title: { ar: 'الجدولة من الاستوديو ودفعة تيك توك', en: 'Scheduling from the Studio, and the TikTok batch' },
            summary: {
                ar: 'كيف تختار الموعد، وماذا يحدث لإنستجرام وفيسبوك وتيك توك، وكيف تنشر كاروسيل تيك توك المنتظرة.',
                en: 'Picking the time, what happens on Instagram, Facebook and TikTok, and posting the queued TikTok carousels.',
            },
            related: ['tiktok', 'scheduling', 'create'],
            sections: [
                {
                    id: 'schedule',
                    title: { ar: 'جدوِل الكاروسيل', en: 'Schedule the carousel' },
                    body: {
                        ar: [
                            { ol: [
                                'عندما يصبح الرسم **جاهز** وتكون قد حفظت كل تعديلاتك، اضغط **إلى الجدولة**.',
                                'في **الموعد** ترى أقرب المواعيد الفارغة من جدولك في الإعدادات (منشور واحد لكل موعد)، أو اختر **وقت آخر…** وحدّده بنفسك.',
                                'اختر ما سيحدث مع تيك توك (أدناه).',
                                'اترك **إنشاء أتمتة الكلمة المفتاحية أيضاً** مفعّلاً، لتصل الرسالة كل من يعلّق بالكلمة.',
                                'اقرأ **ما الذي سيحدث**، واضغط زر الجدولة.',
                            ] },
                            { note: 'الأوقات المقترحة بتوقيت المنطقة الزمنية التي في إعدادات الاستوديو، والوقت المخصص بتوقيت جهازك.' },
                        ],
                        en: [
                            { ol: [
                                'Once the render is **Ready** and your edits are saved, press **Schedule**.',
                                'Under **When** you’ll see the next free slots from your schedule in Settings (one post per slot), or choose **Another time…** and set it yourself.',
                                'Choose what happens on TikTok (below).',
                                'Leave **Also create the keyword automation** ticked, so everyone who comments the keyword gets the DM.',
                                'Read **What will happen**, then press the schedule button.',
                            ] },
                            { note: 'Suggested slots are in the time zone from the Studio settings; a custom time uses your device’s time zone.' },
                        ],
                    },
                },
                {
                    id: 'what-happens',
                    title: { ar: 'ماذا يحدث بعد الجدولة؟', en: 'What happens next' },
                    body: {
                        ar: [
                            { ul: [
                                'يُضاف منشور كاروسيل على إنستجرام وفيسبوك معاً في **الجدولة**، بالشرائح المرسومة ونص إنستجرام. حالاته في [[scheduling#statuses]].',
                                'يُنشأ رد تلقائي للكلمة المفتاحية، إلا إذا كان لديك رد تلقائي مفعّل يردّ على الكلمة نفسها من قبل.',
                                'تصبح المسودّة **مجدول** ويُغلق التعديل. تريد تغييرها؟ احذف المنشور من **الجدولة**.',
                                '**افتح في المنشورات** يأخذك إلى المنشور.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'A carousel post for Instagram and Facebook together is added to the **Scheduler**, with the drawn slides and the Instagram caption. Its statuses are in [[scheduling#statuses]].',
                                'A keyword reply is created, unless an active keyword reply already answers that keyword.',
                                'The draft becomes **Scheduled** and editing closes. To change it, delete the post from the **Scheduler**.',
                                '**Open in Posts** takes you to the post.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'tiktok-choice',
                    title: { ar: 'خيارات تيك توك', en: 'The TikTok choices' },
                    body: {
                        ar: [
                            'يبدأ المربع على **بلا نشر على تيك توك** ما لم تفعّل **الإرسال إلى تيك توك افتراضياً** في إعدادات الاستوديو، وعندها يبدأ على الإرسال.',
                            { dl: [
                                ['إضافة إلى طابور تيك توك', 'ما دام تيك توك لم يعتمد التطبيق: ينتظر الكاروسيل، وتنشره لاحقاً مع غيره في دفعة واحدة.'],
                                ['النشر على تيك توك في الموعد نفسه', 'يظهر بعد أن يعتمد تيك توك التطبيق، ويُنشر مع منشور إنستجرام.'],
                                ['بلا نشر على تيك توك', 'إنستجرام وفيسبوك فقط.'],
                            ] },
                        ],
                        en: [
                            'The dialog starts on **Don’t post to TikTok** unless you switch on **Send to TikTok by default** in the Studio settings; then it starts on sending.',
                            { dl: [
                                ['Queue for TikTok', 'While TikTok hasn’t approved the app: the carousel waits, and you post it later in one batch with the others.'],
                                ['Post to TikTok at the same time', 'Offered once TikTok has approved the app; it goes out with the Instagram post.'],
                                ['Don’t post to TikTok', 'Instagram and Facebook only.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'batch',
                    title: { ar: 'دفعة تيك توك', en: 'The TikTok batch' },
                    body: {
                        ar: [
                            'تجد الكاروسيل الذي في الطابور تحت **بانتظار تيك توك** أعلى الاستوديو.',
                            { ol: [
                                'اجعل حسابك في تيك توك **خاصاً**.',
                                'اضغط **انشر منشورات الكاروسيل المنتظرة على تيك توك**، وبعدها **انشر على تيك توك**.',
                                'تُرسل كلها الآن، بفاصل 40 ثانية بين كل منشور، وكل واحد بخصوصية **أنا فقط**.',
                                'عندما تنتهي كلها، أعِد الحساب عاماً، واجعل كل منشور عاماً من **⋯** ← **الخصوصية** ← **الجميع**.',
                                'وفي كل مسودّة أشّر على **جُعل عامّاً على تيك توك**، لتتذكر ما أنهيته.',
                            ] },
                            { warn: 'لا تُعد الحساب عاماً قبل أن تنتهي الدفعة كلها: قبل الاعتماد، يرفض تيك توك منشورات هذا التطبيق من الحساب العام.' },
                            'القواعد كاملة في [[tiktok#before-approval]].',
                        ],
                        en: [
                            'Queued carousels are counted under **Waiting for TikTok** at the top of the Studio.',
                            { ol: [
                                'Set your TikTok account to **private**.',
                                'Press **Post queued TikTok carousels**, then **Post to TikTok**.',
                                'They all go out now, 40 seconds apart, each one as **Only me**.',
                                'Once they have all finished, make the account public again, and make each post public with **⋯** → **Privacy** → **Everyone**.',
                                'In each draft, tick **Made public on TikTok** so you can see what you have done.',
                            ] },
                            { warn: 'Don’t switch the account back to public before the whole batch is done: until the app is approved, TikTok refuses its posts from a public account.' },
                            'The full rules are in [[tiktok#before-approval]].',
                        ],
                    },
                },
            ],
        },
        // ─── 11. Studio settings, field by field ─────────────────────────────
        {
            slug: 'studio-settings',
            group: 'studio',
            icon: 'sliders-horizontal',
            title: { ar: 'إعدادات الاستوديو حقلاً حقلاً', en: 'Studio settings, field by field' },
            summary: {
                ar: 'الهوية البصرية، والأسلوب، والمنتج والدعوات، والجدول، ومجلد المكتبة، والعمّال.',
                en: 'Brand kit, voice, product and calls to action, schedule, library folder and workers.',
            },
            related: ['worker', 'create', 'studio-schedule'],
            sections: [
                {
                    id: 'brand',
                    title: { ar: 'الهوية البصرية', en: 'Brand kit' },
                    body: {
                        ar: [
                            'شكل شرائحك. والشريحة التجريبية بجانبها معاينة تقريبية، والشرائح الحقيقية تُرسم على جهازك.',
                            { dl: [
                                ['اسم العلامة', 'الاسم الذي يناديك به الاستوديو.'],
                                ['التوقيع (بالحروف اللاتينية)', 'التوقيع الذي في أسفل الشرائح، بالإنجليزية، مثل «AGENTIC AI».'],
                                ['التوقيع (بلغتك)', 'نفس التوقيع بلغتك، مثل «علامتي».'],
                                ['ألوان التمييز', 'الألوان التي يتناوب عليها الكاروسيل، ويتجنب أحدث لون استخدمته. **أضف لوناً** يضيف لوناً، ويجب أن يبقى لون واحد على الأقل.'],
                                ['لون الحبر / لون الورق / اللون الخافت', 'لون النص، ولون الخلفية، ولون النص الثانوي.'],
                                ['خط العناوين', 'Cairo أو Tajawal أو IBM Plex Sans Arabic أو Inter.'],
                                ['خط الكود', 'الخط الذي تُكتب به البرومبتات والأكواد.'],
                                ['اتجاه الشرائح', '**من اليمين إلى اليسار** للعربية، و**من اليسار إلى اليمين** للإنجليزية.'],
                            ] },
                        ],
                        en: [
                            'How your slides look. The sample slide beside it is a rough preview; the real slides are drawn on your computer.',
                            { dl: [
                                ['Brand name', 'How the Studio refers to you.'],
                                ['Signature (Latin)', 'The sign-off at the bottom of the slides, in Latin letters, such as “AGENTIC AI”.'],
                                ['Signature (your language)', 'The same sign-off in your language, such as «علامتي».'],
                                ['Accent palette', 'The colours carousels take turns through, avoiding the most recent one. **Add colour** adds one; at least one must stay.'],
                                ['Ink / Paper / Muted', 'The text colour, the background colour, and the secondary text colour.'],
                                ['Display font', 'Cairo, Tajawal, IBM Plex Sans Arabic or Inter.'],
                                ['Code font', 'The font prompts and code are set in.'],
                                ['Slide direction', '**Right to left** for Arabic, **Left to right** for English.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'voice',
                    title: { ar: 'الأسلوب', en: 'Voice' },
                    body: {
                        ar: [
                            { dl: [
                                ['لغة الكاروسيل', 'العربية أو الإنجليزية.'],
                                ['الأرقام', '**هندية (١٢٣)** أو **لاتينية (123)**.'],
                                ['دليل الأسلوب', 'كيف تكتب: النبرة، واللهجة، والكلمات التي تحبها، والتي تتجنبها. يلتزم الكاتب به في كل كاروسيل.'],
                            ] },
                            { tip: 'دليل أسلوب جيد قصير ومحدد، مثل: «فصحى بسيطة، جمل قصيرة، النتيجة أولاً وبعدها الأداة، بدون مبالغة ولا وعود».' },
                        ],
                        en: [
                            { dl: [
                                ['Carousel language', 'Arabic or English.'],
                                ['Digits', '**Arabic-Indic (١٢٣)** or **Latin (123)**.'],
                                ['Voice guide', 'How you write: tone, dialect, words you like and words you avoid. The writer follows it for every carousel.'],
                            ] },
                            { tip: 'A good voice guide is short and specific, for example: “Friendly Gulf Arabic, short lines, the result first and the tool second, no hype and no promises.”' },
                        ],
                    },
                },
                {
                    id: 'product',
                    title: { ar: 'المنتج والدعوات', en: 'Product & calls to action' },
                    body: {
                        ar: [
                            { dl: [
                                ['اسم المنتج', 'الذي تروّج له.'],
                                ['رابط المنتج', 'الرابط الذي ترسله الرسالة الخاصة، ومعه رمز الإحالة. يجب أن يبدأ بـ `https://`.'],
                                ['حقائق', 'حقائق قصيرة وصحيحة يجوز للشرائح ذكرها، مثل «34 درساً». لا يدّعي الكاتب عن منتجك شيئاً غيرها.'],
                                ['نقاط الرسالة الخاصة', 'القائمة التي توضع مكان `{bullets}` في قالب الرسالة.'],
                            ] },
                            '**الدعوات لاتخاذ إجراء:**',
                            { dl: [
                                ['سطر نص إنستجرام', 'يُضاف إلى كل نص إنستجرام. يجب أن يتضمن `{keyword}` مكان الكلمة المفتاحية، ليعرف المتابع ماذا يكتب.'],
                                ['سطر نص تيك توك', 'يُضاف إلى كل وصف تيك توك. لا يرسل تيك توك رسائل خاصة، فوجّه الناس إلى البايو: [[tiktok#bio]].'],
                                ['قالب الرسالة الخاصة', 'الرسالة التي تصل من يعلّق. المتغيرات: `{username}` و`{question}` و`{pitch}` و`{url}` و`{bullets}`. ويكتب الذكاء الاصطناعي السؤال والجملة التعريفية لكل كاروسيل.'],
                            ] },
                            'تحتها معاينات حيّة: **سطر إنستجرام** بكلمة تجريبية، و**سطر تيك توك**، و**الرسالة الخاصة بقيم تجريبية**.',
                        ],
                        en: [
                            { dl: [
                                ['Product name', 'What you promote.'],
                                ['Product link', 'The link the DM sends, referral code included. It must start with `https://`.'],
                                ['Facts', 'Short, true facts a slide may use, such as “34 lessons”. Nothing else is ever claimed about your product.'],
                                ['DM bullets', 'The list the DM template puts where it says `{bullets}`.'],
                            ] },
                            '**Calls to action:**',
                            { dl: [
                                ['Instagram caption line', 'Added to every Instagram caption. It must contain `{keyword}` where the keyword goes, so people know what to comment.'],
                                ['TikTok caption line', 'Added to every TikTok description. TikTok can’t send DMs, so point people to your bio: [[tiktok#bio]].'],
                                ['DM template', 'The message commenters receive. Placeholders: `{username}`, `{question}`, `{pitch}`, `{url}` and `{bullets}`; the question and the pitch are written by the AI for each carousel.'],
                            ] },
                            'Live previews sit underneath: the **Instagram line** with a sample keyword, the **TikTok line**, and the **DM, with sample values**.',
                        ],
                    },
                },
                {
                    id: 'slide-words',
                    title: { ar: 'كلمات الشريحة الأخيرة', en: 'Last slide words' },
                    body: {
                        ar: [
                            'ما تقوله شريحة الدعوة في آخر الكاروسيل، على إنستجرام وعلى تيك توك:',
                            { dl: [
                                ['دعوة إنستجرام', 'مثل «اكتب في التعليقات».'],
                                ['سطر إنستجرام تحتها', 'مثل «ويوصلك الرابط بالخاص».'],
                                ['دعوة الحفظ', 'مثل «احفظ المنشور».'],
                                ['عنوان تيك توك', 'مثل «كل شيء في مكان واحد».'],
                                ['شارة تيك توك', 'مثل «رابطه في البايو».'],
                                ['سطر تيك توك تحتها', 'مثل «ادخل البروفايل واضغط الرابط».'],
                                ['دعوة المتابعة', 'مثل «تابعني للمزيد».'],
                                ['تلميح السحب', 'مثل «اسحب».'],
                            ] },
                        ],
                        en: [
                            'What the call-to-action slide at the end says, on Instagram and on TikTok:',
                            { dl: [
                                ['Instagram ask', 'For example “Comment below”.'],
                                ['Instagram line under it', 'For example “and the link lands in your DMs”.'],
                                ['Save prompt', 'For example “Save this post”.'],
                                ['TikTok headline', 'For example “Everything in one place”.'],
                                ['TikTok pill', 'For example “Link in bio”.'],
                                ['TikTok line under it', 'For example “Open my profile and tap the link”.'],
                                ['Follow prompt', 'For example “Follow for more”.'],
                                ['Swipe hint', 'For example “Swipe”.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'schedule',
                    title: { ar: 'الجدول', en: 'Schedule' },
                    body: {
                        ar: [
                            { dl: [
                                ['المنطقة الزمنية', 'المواعيد اليومية بتوقيت هذه المنطقة، مثل `Europe/London`.'],
                                ['المواعيد اليومية', 'الأوقات التي يُنشر فيها منشور كل يوم، مثل 13:00 و21:00. **أضف موعداً** يضيف وقتاً، ويجب أن يبقى وقت واحد على الأقل. وتقترح الجدولة عليك أقرب موعد فارغ، منشوراً واحداً لكل موعد.'],
                                ['الإرسال إلى تيك توك افتراضياً', 'متوقف في البداية: يبدأ مربع الجدولة على «بلا نشر على تيك توك». فعّله إن كنت تريد أن يبدأ على الإرسال (الطابور، أو الموعد نفسه بعد اعتماد التطبيق). ويمكنك دائماً تغيير الاختيار لكل منشور.'],
                            ] },
                        ],
                        en: [
                            { dl: [
                                ['Time zone', 'The daily slots are times in this zone, such as `Europe/London`.'],
                                ['Daily slots', 'The times a post goes out each day, such as 13:00 and 21:00. **Add slot** adds one; at least one must stay. Scheduling offers you the next free slot, one post per slot.'],
                                ['Send to TikTok by default', 'Off at first: the Schedule dialog starts on “Don’t post to TikTok”. Turn it on if you want it to start on sending (the queue, or the same time once the app is approved). You can always change the choice per post.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'library',
                    title: { ar: 'مجلد المكتبة', en: 'Library folder' },
                    body: {
                        ar: [
                            { dl: [
                                ['المجلد على جهاز الماك', 'المسار الكامل للمجلد الذي يفحصه العامل، مثل `/Users/you/Videos`. يجب أن يكون داخل مجلد الكورس في إعدادات العامل (`courseRoot`). وإذا تركته فارغاً، يتوقف الفحص.'],
                            ] },
                            'ترتيب المجلد والأسماء في [[library#folder]].',
                        ],
                        en: [
                            { dl: [
                                ['Folder on your Mac', 'The full path of the folder the worker scans, such as `/Users/you/Videos`. It must sit inside the course folder in the worker’s config (`courseRoot`). Leave it empty to turn scanning off.'],
                            ] },
                            'How to organise the folder and name the files: [[library#folder]].',
                        ],
                    },
                },
                {
                    id: 'workers',
                    title: { ar: 'العمّال', en: 'Workers' },
                    body: {
                        ar: [
                            { ul: [
                                '**عامل جديد** ← **أنشئ عاملاً**: يظهر لك رمزه مرة واحدة. انسخه والصقه في الحقل `token` داخل `studio.config.json` على جهازك، واضغط **نسخته**.',
                                'ترى بجانب كل عامل **آخر ظهور** أو **لم يتصل بعد**.',
                                '**ألغِ** يوقف العامل في الحال ويرفض رمزه. ولاستخدام الجهاز نفسه مرة أخرى، أنشئ عاملاً جديداً والصق رمزه.',
                            ] },
                            'كل شيء عن العامل في [[worker]].',
                        ],
                        en: [
                            { ul: [
                                '**New worker** → **Create worker**: its token is shown once. Copy it into the `token` field of `studio.config.json` on your computer, then press **I’ve copied it**.',
                                'Each worker shows its **Last seen** time, or **Never connected**.',
                                '**Revoke** stops a worker at once and refuses its token. To use that computer again, create a new worker and paste the new token.',
                            ] },
                            'Everything about the worker is in [[worker]].',
                        ],
                    },
                },
                {
                    id: 'save',
                    title: { ar: 'الحفظ', en: 'Saving' },
                    body: {
                        ar: [
                            'اضغط **احفظ الإعدادات**. وإن وُجد خطأ في حقل، يُعلَّم في مكانه وترى **صحّح الحقول المعلّمة ثم احفظ**. تنطبق الإعدادات على أي كاروسيل تكتبه أو ترسمه بعدها، ولا تتغيّر المنشورات المجدولة.',
                        ],
                        en: [
                            'Press **Save settings**. When a field has a problem it is marked where it is, with **Fix the highlighted fields, then save.** Settings apply to anything you write or redraw afterwards; posts already scheduled don’t change.',
                        ],
                    },
                },
            ],
        },
        // ─── 11a. The Monteur ────────────────────────────────────────────────
        {
            slug: 'monteur',
            group: 'studio',
            icon: 'scissors',
            title: { ar: 'صفحة الريلز: ريلز من فيديوهاتك الطويلة', en: 'The Monteur: reels from your long videos' },
            summary: {
                ar: 'يقصّ أقوى لحظات فيديوهاتك إلى ريلز، وتعتمد كل ريل قبل نشره: كيف تختار المجلد وتشغّله، وكيف تراجع الريل، وماذا يفعل الاعتماد، وكم ريل يخرج من الفيديو.',
                en: 'How it cuts the strongest moments of your own videos into reels: choosing the folder and running it, reviewing a reel, what Approve does, and how many reels one video gives.',
            },
            related: ['worker', 'studio', 'youtube', 'tiktok'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'ماذا تفعل صفحة الريلز؟', en: 'What the Monteur does' },
                    body: {
                        ar: [
                            'تحوّل صفحة الريلز فيديوهاتك الطويلة إلى ريلز قصيرة. تستمع إلى كل فيديو، وتختار اللحظات التي تبدأ بجملة تشدّ، وفيها فكرة واحدة لها نتيجة، وتُفهم دون ما قبلها، وتقصّ كل لحظة ريلاً عمودياً: العنوان على الشاشة من أول لقطة، والكلام مكتوب فوق الصورة، وآخر بطاقة تطلب الكلمة المفتاحية. بعدها تكتب النصوص، وأنت تعتمد كل ريل قبل أن يُنشر أي شيء.',
                            { dl: [
                                ['جهازك الماك (العامل)', 'يقرأ المجلد، ويستمع إلى الفيديو ويكتب كلامه، ويرسم الريلز الجاهزة. يجب أن يكون قيد التشغيل في هذه الخطوات: [[worker]].'],
                                ['الذكاء الاصطناعي', 'يختار اللحظات ويكتب العناوين والنصوص. وأنت تحدد من الإعدادات أي ذكاء اصطناعي يتولى ذلك: [[monteur#settings]].'],
                                ['أنت', 'تختار الفيديوهات، وتراجع كل ريل، وتعتمده أو ترفضه.'],
                            ] },
                            { note: 'صفحة الريلز للمالك والمشغّل. وإذا كان دورك «مُطّلع» فسترى رسالة تقول إنها لا تناسب دورك.' },
                        ],
                        en: [
                            'The Monteur turns the long videos you record into short reels. It listens to each video, picks the moments that open with a hook, hold one idea with a payoff and make sense on their own, and cuts each one into a vertical reel: the title is on screen from the first frame, the words are captioned, and the last card asks for your keyword. Then it writes the captions, and you approve every reel before anything is posted.',
                            { dl: [
                                ['Your Mac (the worker)', 'Reads the folder, listens to the video and writes down what is said, and draws the finished reels. It has to be on for these steps: see [[worker]].'],
                                ['The AI', 'Picks the moments and writes the titles and captions. Which AI does it is a setting: see [[monteur#settings]].'],
                                ['You', 'Choose the videos, review each reel, and approve or reject it.'],
                            ] },
                            { note: 'The Monteur is for owners and operators. With the Viewer role you see a message saying it does not fit your role.' },
                        ],
                    },
                },
                {
                    id: 'start',
                    title: { ar: 'أول مرة: التجهيز', en: 'The first time: set it up' },
                    body: {
                        ar: [
                            'عندما تفتح **الاستوديو** ← **الريلز** تنفتح الصفحة على **جهّز الريلز**: ثلاث خطوات تُحفظ معاً بزر **احفظ وابدأ**، ولا يُحفظ شيء قبل أن تضغطه.',
                            { ol: [
                                '**اختر مصدر الفيديوهات:** **مجلدي** (فيديوهات جديدة تضعها في مجلد على جهازك الماك) أو **مكتبة الكورس** (الدروس التالية من مكتبة الاستوديو بالترتيب، وكل درس يُستخدم مرة واحدة). ومع **مجلدي** اختر المجلد أيضاً: [[monteur#folder]].',
                                '**اختر الأوقات:** **وقت التشغيل** وهو وقت التشغيل اليومي، و**أوقات النشر** وتصل لأربعة أوقات في اليوم.',
                                '**اختر العدد والطول:** **فيديوهات في كل تشغيل**، و**أقصى عدد ريلز من كل فيديو**، و**طول الريل**، و**انشر على**، وبقية الخيارات التي في [[monteur#settings]].',
                            ] },
                            'مفتاح **شغّله كل يوم** يبدأ مفعّلاً في هذا التجهيز. وبعد الحفظ ينطوي التجهيز في سطر واحد تحت **الإعدادات** وبجانبه **عدّل الإعدادات**، وتظهر لك **قائمة المراجعة**.',
                            { note: 'إن لم يعرف ملفك بعد من يظهر في الفيديو، يفتح لك تفعيل الريلز ورقة قصيرة عنوانها «بضعة تفاصيل أولًا»: عبّئها ويكتمل التفعيل. ولو ردّت الصفحة بـ«أكمل ملفك قبل تشغيل هذا» فأساسيات إعدادك ناقصة، أكملها أولاً: [[onboarding#steps]].' },
                        ],
                        en: [
                            'The first time you open **Studio** → **Reels**, the page opens as **Set up Reels**: three steps, saved together with **Save and start**. Nothing is saved until you press it.',
                            { ol: [
                                '**Choose where the videos come from:** **My folder** (new videos you drop into a folder on your Mac) or **The course library** (the next lessons of your Studio library, in order, each used once). With **My folder**, also choose the folder: [[monteur#folder]].',
                                '**Choose the times:** **Run at**, the time of the daily run, and **Post at**, up to 4 posting times a day.',
                                '**Choose how many, and how long:** **Videos per run**, **Most reels per video**, **Reel length**, **Post to**, and the other choices explained in [[monteur#settings]].',
                            ] },
                            'The **Run every day** switch starts on in the setup. After you save, the setup folds into one line under **Settings** with **Edit settings** beside it, and the **Review queue** appears.',
                            { note: 'If your profile does not yet say who is on screen, switching the Monteur on first opens a short sheet titled “A few details first”: fill it in and the switch goes through. If the page answers “Finish your profile before switching this on”, the basics of your setup are missing: finish them first ([[onboarding#steps]]).' },
                        ],
                    },
                },
                {
                    id: 'folder',
                    title: { ar: 'اختيار المجلد', en: 'Choosing the folder' },
                    body: {
                        ar: [
                            'مع **مجلدي** اضغط **اختر المجلد** بجانب **المجلد**. تنفتح نافذة اختيار مجلد على جهازك الماك، الذي يشغّل العامل. اختر المجلد من هناك ويتعبّأ مساره هنا. تنتظرك النافذة 5 دقائق. وإن لم يُختر شيء، اضغط الزر مرة أخرى أو اكتب المسار كاملاً بنفسك، مثل `/Users/you/Videos/Reels`.',
                            { ul: [
                                'إن كان الماك مطفأً أو نائماً، تنفتح النافذة عندما يعود متصلاً، وتخبرك الصفحة بذلك وهي تنتظر. وإن مرّت 10 دقائق قبل أن يعود، تخبرك الصفحة بأن أحداً لم يكن ينتظر النافذة، فاضغط **اختر المجلد** مرة أخرى.',
                                'يُقرأ المستوى الأول من المجلد فقط، فالفيديوهات داخل المجلدات الفرعية لا تُؤخذ. ولا يُؤخذ الملف إلا بعد أن تمر عليه دقيقة في المجلد، لئلا يُقرأ فيديو لا يزال يُنسخ.',
                                'الملفات التي تُؤخذ `.mp4` و`.mov` و`.m4v` و`.mkv` و`.webm`، الأقدم أولاً، حتى **فيديوهات في كل تشغيل** (من 1 إلى 10) في كل تشغيل.',
                                'ومع **مكتبة الكورس** لا يوجد مجلد تختاره: تأخذ الصفحة دروس مكتبة الاستوديو واحداً واحداً بترتيب الدروس، وكل درس مرة واحدة. وحين يصبح لكل الدروس ريلز، يخبرك **شغّل الآن** بذلك ويطلب منك أن تفحص المكتبة في الاستوديو أولاً: [[library]].',
                            ] },
                        ],
                        en: [
                            'With **My folder**, press **Choose folder** next to **Folder**. A folder window opens on your Mac, the one that runs the worker. Pick the folder there and its path fills in here. The window waits for you for 5 minutes. If nothing is chosen in that time, press the button again, or type the full path yourself, for example `/Users/you/Videos/Reels`.',
                            { ul: [
                                'If the Mac is off or asleep, the window opens when it is back online. The page says so while it waits. If 10 minutes pass before it is back, the page tells you nobody was waiting for the window any more, and you press **Choose folder** again.',
                                'Only the top level of the folder is read, so videos inside sub-folders are not taken. A file is taken once it has been in the folder for a minute, so a video that is still being copied is not read half way.',
                                'The files taken are `.mp4`, `.mov`, `.m4v`, `.mkv` and `.webm`, oldest first, up to **Videos per run** (1 to 10) each run.',
                                'With **The course library** there is no folder to choose: the Monteur takes the lessons of your Studio library one by one, in lesson order, each only once. When every lesson already has its reels, **Run now** says so and asks you to scan the library in the Studio first: [[library]].',
                            ] },
                        ],
                    },
                },
                {
                    id: 'run',
                    title: { ar: 'التشغيل والفيديوهات', en: 'Running it, and the videos' },
                    body: {
                        ar: [
                            { dl: [
                                ['**شغّله كل يوم**', 'مفعّل: يعمل وحده في **وقت التشغيل** بتوقيت مساحتك. وإذا كان الماك نائماً وقتها يعمل حين يستيقظ. متوقف: لا يوجد تشغيل يومي، ويبقى **شغّل الآن** يعمل.'],
                                ['**شغّل الآن**', 'يقرأ المجلد في الحال، سواء كان التشغيل اليومي مفعّلاً أو لا. يحتاج إلى مجلد (أو دروساً باقية)، ويتعطّل الزر ما دام هناك تشغيل منتظر بالفعل.'],
                            ] },
                            'يخبرك الشريط تحت التبويبات إن كان التشغيل اليومي مفعّلاً، ومتى التشغيل القادم، وماذا وجد آخر تشغيل (مثل «فيديوهان جديدان»)، وإن كان العامل متصلاً. وإذا كان المصدر **مكتبة الكورس** وصار لكل درس فيها ريلزه، تتحول حالة التشغيل إلى شارة برتقالية **لا جديد لقصّه** بدل «مفعّل»، لأن التشغيل اليومي لن يجد ما يقصّه: أضف فيديوهات، أو انتقل إلى مجلد. ويعرض قسم **الفيديوهات** (تحت قائمة المراجعة) كل فيديو وأين وصل:',
                            { dl: [
                                ['تفريغ الكلام', 'العامل يسمع الفيديو ويكتب كلامه.'],
                                ['بانتظار القص', 'الكلام جاهز وينتظر اختيار اللحظات.'],
                                ['يبحث عن اللحظات', 'الذكاء الاصطناعي يختار اللحظات ويكتب النصوص.'],
                                ['يجهّز الريلز', 'العامل يرسم الريلز، وتظهر في **قيد التجهيز**.'],
                                ['اكتمل', 'جُهِّزت كل ريلزه.'],
                                ['لا لحظة قوية', 'لا يوجد ما تجاوز المعيار: بداية تشدّ في الثواني الأولى، وفكرة واحدة لها نتيجة، وطول ضمن إعداداتك. جرّب فيديو أطول، أو وسّع **طول الريل**.'],
                                ['فشل', 'تحته السبب. اضغط **أعد المحاولة** ليبدأ الفيديو من جديد من حيث توقف.'],
                            ] },
                            { tip: 'الخطوات البطيئة (قراءة المجلد، والاستماع إلى الفيديو، ورسم الريلز) تجري على جهازك الماك. وإن كان العامل غير متصل تنتظر في الطابور ولا يضيع شيء، وتخبرك الصفحة بذلك: [[worker#status]].' },
                        ],
                        en: [
                            { dl: [
                                ['**Run every day**', 'On: it runs by itself at **Run at**, in your workspace’s time zone. If the Mac is asleep then, it runs as soon as it wakes. Off: no daily run, and **Run now** still works.'],
                                ['**Run now**', 'Reads the folder straight away, whether the daily run is on or not. It needs a folder (or lessons left), and the button is off while a run is already waiting.'],
                            ] },
                            'The strip under the tabs says whether the daily run is on, when the next run is, what the last run found (such as “2 new videos”) and whether the worker is online. If the source is **The course library** and every lesson in it already has its reels, the daily-run status turns into an amber **Nothing new to cut** pill instead of “on”, because the daily run will find nothing to cut: add videos, or switch to a folder. The **Videos** section (below the review queue) lists each video and where it has got to:',
                            { dl: [
                                ['Transcribing', 'The worker listens to the video and writes down what is said.'],
                                ['Waiting to be cut', 'The words are ready and wait for the moments to be picked.'],
                                ['Finding the moments', 'The AI picks the moments and writes the texts.'],
                                ['Preparing reels', 'The worker draws the reels, and they appear under **Being prepared**.'],
                                ['Done', 'All its reels are ready.'],
                                ['No strong moment', 'Nothing cleared the bar: a hook in the first seconds, one idea with a payoff, and a length within your settings. Try a longer video, or widen **Reel length**.'],
                                ['Failed', 'The reason is shown under it. Press **Retry** to start the video again from where it stopped.'],
                            ] },
                            { tip: 'The slow steps (reading the folder, listening to the video, drawing the reels) happen on your Mac. While the worker is offline they wait in the queue and nothing is lost, and the page says so: [[worker#status]].' },
                        ],
                    },
                },
                {
                    id: 'count',
                    title: { ar: 'كم ريلاً يخرج من الفيديو؟', en: 'How many reels one video gives' },
                    body: {
                        ar: [
                            'ريل واحد لكل 10 دقائق بدأت من الفيديو، ولا يزيد على **أقصى عدد ريلز من كل فيديو** (من 1 إلى 5)، ومن اللحظات القوية فقط. أي أن فيديو من 5 دقائق ينتج ريلاً واحداً على الأكثر، وفيديو من 11 دقيقة ريلين، وفيديو من 33 دقيقة ثلاثة (إن كان الإعداد 3). والرقم سقف وليس حصة: فيديو ليس فيه لحظة قوية لا ينتج شيئاً، وترى عليه «لا لحظة قوية».',
                            { ul: [
                                'لا يُنشر ريل من فيديو واحد في اليوم نفسه مع ريل آخر منه: إن كان ريل من الفيديو نفسه يُنشر ذلك اليوم، ينتقل الاعتماد إلى أقرب يوم متاح.',
                                'تُستبعد اللحظات الأقصر من **الأقصر (بالثواني)** أو الأطول من **الأطول (بالثواني)**. والافتراضي من 20 إلى 45 ثانية، ويجب أن يكون الأطول أكبر من الأقصر.',
                            ] },
                        ],
                        en: [
                            'One reel for each started 10 minutes of the video, never more than **Most reels per video** (1 to 5), and only for moments strong enough. So a 5-minute video gives one reel at most, an 11-minute one gives two, and a 33-minute one gives three (if the setting is 3). It is a ceiling, not a quota: a video with nothing strong enough gives none, and shows **No strong moment**.',
                            { ul: [
                                'Two reels from the same video never go out on the same day: if a reel from that video already posts on a day, Approve moves this one to the next free day.',
                                'Moments shorter than **Shortest (seconds)** or longer than **Longest (seconds)** are left out. The defaults are 20 and 45 seconds, and the longest has to be more than the shortest.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'review',
                    title: { ar: 'مراجعة الريل وتعديله', en: 'Reviewing and editing a reel' },
                    body: {
                        ar: [
                            'تظهر الريلز في **قائمة المراجعة**، أحدث فيديو أولاً وأفضل ريل منه أولاً. وفي كل بطاقة:',
                            { dl: [
                                ['الفيديو', 'شغّله مع غلافه. وإذا وُجدت نسخة لتيك توك أو يوتيوب يفتحها **شاهد نسخة تيك توك**: آخر بطاقة فيها تقول إن الرابط في البايو بدل أن تطلب تعليقاً.'],
                                ['التقييم', 'مدى احتمال انتشار اللحظة برأي صفحة الريلز من 10، والعلامات الأربع التي خرج منها: البداية والاستقلال والنتيجة وقابلية الإرسال.'],
                                ['يبدأ بـ / لماذا هذه اللحظة', 'أول جملة منطوقة في الريل، وسبب اختيار اللحظة.'],
                                ['**العنوان على الفيديو**', 'حتى 60 حرفاً، ويظهر من أول لقطة، فهو على صورة الريل في شبكة ملفك أيضاً.'],
                                ['**نص إنستجرام وفيسبوك** و**نص تيك توك**', 'كل واحد حتى 2,200 حرف.'],
                                ['**الكلمة المفتاحية للتعليقات**', 'كلمة واحدة من 4 أحرف على الأقل. تظهر على آخر بطاقة في الفيديو، وهي التي يكتبها المتابع في التعليقات لتصله رسالتك.'],
                                ['**الرسالة الخاصة والنص البديل**', 'قسم مطوي فيه الرسالة الخاصة التي تصل من يعلّق بالكلمة، والنص البديل للصورة.'],
                            ] },
                            { ul: [
                                'يجب أن يبقى في نص إنستجرام وفيسبوك السطر الذي يطلب الكلمة المفتاحية، والكلمة بين « » مثل «سعر». تعرض البطاقة علامة صح أو تحذيراً، ويرفض الحفظ نصاً أسقطها: لأن الناس سيعلّقون ولن يردّ عليهم أحد.',
                                'إن غيّرت العنوان أو الكلمة المفتاحية، يُرسم الفيديو من جديد على جهازك الماك لأنهما مطبوعان عليه، وتنبّهك البطاقة قبل الحفظ. أما تغيير النص فقط فلا يعيد الرسم.',
                                'تحلّ الكلمة الجديدة محل القديمة داخل النص، وتمسح الصيغ الأخرى للقديمة.',
                                '**احفظ التعديلات** يحفظ تعديلاتك، و**اعتمد** يتوقف حتى تحفظ أو تتجاهل ("احفظ تعديلاتك أو تجاهلها أولاً").',
                            ] },
                            { tip: 'قبل أن تعتمد شغّل الفيديو كاملاً وأنت تستمع إليه. تختار الصفحة وتقصّ، لكن من يوقّع على الريل هو أنت.' },
                        ],
                        en: [
                            'Reels land in the **Review queue**, newest video first and the Monteur’s best reel of each first. Each card shows:',
                            { dl: [
                                ['The video', 'Play it with its cover. When there is a copy for TikTok or YouTube, **Watch the TikTok version** opens it: its last card says the link is in your bio instead of asking for a comment.'],
                                ['The score', 'How likely the Monteur thinks the moment is to spread, out of 10, and the four marks it comes from: Hook, Alone, Payoff and Send.'],
                                ['It opens with / Why this moment', 'The first spoken line of the reel, and why the moment was picked.'],
                                ['**Title on the video**', 'Up to 60 characters. It is on screen from the first frame, so it is on the reel’s thumbnail in your profile grid too.'],
                                ['**Instagram and Facebook caption** and **TikTok caption**', 'Each up to 2,200 characters.'],
                                ['**Comment keyword**', 'One word of at least 4 letters. It is on the video’s last card, and it is the word people comment to get your DM.'],
                                ['**The DM and the alt text**', 'A folded part with the private message people get when they comment the keyword, and the alt text.'],
                            ] },
                            { ul: [
                                'The Instagram and Facebook caption has to keep the line that asks for the keyword, with the keyword between « » (for example «price»). The card shows a tick or a warning, and a save that drops it is refused: people would comment and nobody would answer.',
                                'Change the title or the keyword and the video is drawn again on your Mac, because both are printed on it; the card tells you before you save. Changing only a caption does not redraw anything.',
                                'A new keyword replaces the old one inside the caption, and clears the other spellings of the old one.',
                                '**Save changes** keeps your edits. **Approve** stays off until you save or discard them.',
                            ] },
                            { tip: 'Play the whole video, with the sound on, before you approve. The Monteur picks and cuts, but you are the one who signs off.' },
                        ],
                    },
                },
                {
                    id: 'approve',
                    title: { ar: 'ماذا يفعل «اعتمد»؟', en: 'What Approve does' },
                    body: {
                        ar: [
                            'اضغط **اعتمد** (وعليه الموعد الذي سيأخذه الريل، مثل «اعتمد لموعد الأحد 28 سبتمبر 19:00»). يُجدول الريل وتنتقل بطاقته إلى **القادمة**. وهذا ما يحدث:',
                            { dl: [
                                ['الموعد', 'أول موعد متاح من **أوقات النشر** بتوقيت مساحتك. **غيّر الموعد** يتيح لك كتابة يوم ووقت آخرين، و**استخدم أقرب موعد متاح** يعيدك إلى الموعد التلقائي. وريلان من فيديو واحد لا يخرجان في يوم واحد: إن كان ريل منه يُنشر ذلك اليوم يصبح الزر **اعتمد لأقرب يوم متاح**.'],
                                ['إنستجرام وفيسبوك', 'منشور واحد للاثنين (أو لواحد منهما حسب **انشر على**): الفيديو وغلافه و**نص إنستجرام وفيسبوك**.'],
                                ['تيك توك', 'منشور خاص به، بنسخة الفيديو لتيك توك و**نص تيك توك**. يجب أن يكون تيك توك متصلاً وإلا فسيرفض الاعتماد: صِل تيك توك من الإعدادات أو أزله من **انشر على**: [[tiktok#connect]]. وقبل أن يعتمد تيك توك التطبيق يُنشر بخصوصية «أنا فقط»: [[tiktok#before-approval]].'],
                                ['يوتيوب', 'منشور Short بنسخة تيك توك من الفيديو، وعنوان الريل، ونص تيك توك (ومعه رابط منتجك إذا حددت واحداً). ويوتيوب غير المتصل لا يمنع نشر الريل في إنستجرام وفيسبوك: يفشل منشوره في **الجدولة** ويذكر السبب: [[youtube#disconnected]].'],
                            ] },
                            'والرد التلقائي بالرسائل: كل ريل له منشور في إنستجرام أو فيسبوك يلزمه رد تلقائي على كلمته. إن كان لديك رد تلقائي مفعّل لكل المنشورات يردّ على الكلمة، يُستخدم هو. وإلا ينشئ الاعتماد رداً تلقائياً مفعّلاً للكلمة (وصيغها الأخرى): يرسل الرسالة التي كُتبت للريل، بدون رد علني، ويطابق الكلمة كاملة. وإذا كانت الكلمة تتعارض مع كلمة مفعّلة لديك يرفض الاعتماد ويخبرك أي كلمة، فغيّر الكلمة.',
                            { ul: [
                                'تصبح منشورات الريل بعدها منشورات جدولة عادية: عدّلها أو احذفها أو انشرها الآن من **الجدولة**. ولا يُعدَّل الريل المجدول من هنا.',
                                'إن حذفت كل منشورات الريل قبل موعدها، يعود الريل إلى **قائمة المراجعة**.',
                                'الريل الذي ترفضه بزر **ارفض** لا يعود: يخرج من القائمة ولا يُنشر. والزر نفسه على ريل فاشل اسمه **أخفِه**.',
                            ] },
                        ],
                        en: [
                            'Press **Approve** (it shows the time the reel will take, such as “Approve for Sun 28 Sep, 19:00”). The reel is scheduled and its card moves to **Coming up**. This is what happens:',
                            { dl: [
                                ['When', 'The first free time among your **Post at** times, in your workspace’s time zone. **Change time** lets you type another day and time, and **Use the next free time** takes you back to the automatic one. Two reels from one video never go out on the same day: if one of them already posts that day, the button reads **Approve for the next free day**.'],
                                ['Instagram and Facebook', 'One post for both (or for one of them, as set under **Post to**): the video, its cover and the **Instagram and Facebook caption**.'],
                                ['TikTok', 'A post of its own, with the TikTok copy of the video and the **TikTok caption**. TikTok has to be connected or Approve is refused: connect it in Settings or take it off **Post to**: [[tiktok#connect]]. Until TikTok approves the app it goes up as “Only me”: [[tiktok#before-approval]].'],
                                ['YouTube', 'A Short with the TikTok copy of the video, the reel’s title and the TikTok caption (with your product link under it, if you set one). A YouTube that is not connected does not stop the reel going to Instagram and Facebook: its post fails in the **Scheduler** and says why: [[youtube#disconnected]].'],
                            ] },
                            'And the comment keyword reply: every reel with an Instagram or Facebook post needs a keyword reply that answers its keyword. If one of your active keyword replies for all posts already answers it, that one is used. If not, Approve creates one, switched on, for the keyword (and its other spellings): it sends the DM written for the reel, with no public reply, and matches the keyword as a whole word. If the keyword would clash with one of your live keywords, Approve is refused and names it: change the keyword.',
                            { ul: [
                                'After that, the reel’s posts are ordinary scheduled posts: edit, delete or publish them from the **Scheduler**. A scheduled reel cannot be edited from here.',
                                'If you delete all of a reel’s posts before their time, the reel comes back to the **Review queue**.',
                                'A reel you **Reject** does not come back: it leaves the queue and is not posted. On a failed reel the same button is called **Dismiss**.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'auto',
                    title: { ar: 'الجدولة التلقائية', en: 'Automatic scheduling' },
                    body: {
                        ar: [
                            'تحت **عندما يجهز الريل** اختر **أراجعه بنفسي** (الافتراضي)، أو **جدوِله تلقائياً**: تعتمد الصفحة نفسها كل ريل بمجرد أن يجهز، بأقرب موعد نشر متاح وبالرد التلقائي، وبفحوصات زر **اعتمد** نفسها.',
                            { ul: [
                                'الريل الذي لا تستطيع الصفحة جدولته (لا يوجد يوم متاح، أو كلمة تتعارض، أو تيك توك غير جاهز) يبقى في **قائمة المراجعة** ومعه السبب: «لم يُجدول تلقائياً». تجرّب الصفحة مرة أخرى لاحقاً، ويمكنك تعديله أو اعتماده بنفسك.',
                                'هذا الإعداد مستقل عن **شغّله كل يوم**: إن كان التشغيل اليومي متوقفاً والجدولة التلقائية مفعّلة، فالريلز التي تجهز تُجدول أيضاً.',
                            ] },
                        ],
                        en: [
                            'Under **When a reel is ready**, choose **I review it** (the default) or **Schedule it automatically**: the Monteur approves each reel itself as soon as it is drawn, with the next free posting time and the comment keyword reply, and the same checks as the **Approve** button.',
                            { ul: [
                                'A reel it cannot schedule (no free day, a keyword that clashes, TikTok not ready) stays in the **Review queue** with the reason: “Not scheduled automatically”. It is tried again later, and you can edit it or approve it yourself.',
                                'This setting is separate from **Run every day**: with the daily run off and automatic scheduling on, the reels that finish drawing are still scheduled.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'settings',
                    title: { ar: 'الإعدادات واحداً واحداً', en: 'The settings, one by one' },
                    body: {
                        ar: [
                            'افتح **الإعدادات** ثم **عدّل الإعدادات**، وبعد التعديل اضغط **احفظ الإعدادات**:',
                            { dl: [
                                ['**الذكاء الاصطناعي لاختيار المقاطع وكتابة النصوص والتعديلات**', 'من يختار اللحظات ويكتب النصوص: **Gemini (داخل التطبيق)**، أو **Claude على الماك** (للمساحات التي سمح لها مسؤول المنصة فقط)، أو **مزوّدو الذكاء الاصطناعي (تعدّهم المنصّة)** وهو ما تبدأ به المساحة الجديدة. وإن لم يوجد مزوّد جاهز يتوقف الفيديو ويقول السبب، وزر **أعد المحاولة** يطلبه من جديد حين يجهز واحد.'],
                                ['**نمط التعديلات**', '**كلاسيكي** أو **ورقي** (بطاقات تنفتح وحروف من ورق وأيقونات تُرسم أمامك ولقطات مساندة بالأبيض والأسود). يسري التغيير على الفيديو التالي الذي يُجهَّز.'],
                                ['«لمسات بشرية»', 'تبديل الكاميرا ورسومات باليد وتظليل الكلمات وانتقالات وتجميد اللقطة، ليبدو الريل كأنه مُحرَّر يدوياً. تبديل الكاميرا وتجميد اللقطة والكلمات التي خلفك لا تكون إلا في الفيديوهات التي تتكلم فيها أمام الكاميرا.'],
                                ['**انشر على**', 'إنستجرام وفيسبوك وتيك توك ويوتيوب، ويجب أن تختار منصة واحدة على الأقل. تيك توك ويوتيوب يأخذان نسخة أخرى من الفيديو، آخر بطاقة فيها تقول إن الرابط في البايو، لأنهما لا يردّان على التعليق برسالة خاصة.'],
                                ['**أوقات النشر**', 'من وقت إلى أربعة أوقات في اليوم بتوقيت مساحتك. يأخذ الاعتماد أول وقت متاح.'],
                            ] },
                            'وتحت كل شيء قسم **ما تعلّمه المحلّل**: قواعد مستخلصة من أداء ريلزك وفيديوهاتك، تتبعها الصفحة وكاتب النصوص. يكتبها المحلّل عندما تتوفر إحصاءات 5 ريلز أو فيديوهات على الأقل، مرة في الأسبوع، أو عندما تضغط **حدّثها الآن**.',
                        ],
                        en: [
                            'Open **Settings**, then **Edit settings**, and press **Save settings** when you are done:',
                            { dl: [
                                ['**AI for picking, captions and edits**', 'Who picks the moments and writes the texts: **Gemini (in the app)**, **Claude on the Mac** (only for workspaces the platform administrator has allowed to use it), or **AI providers (set up by the platform)**, which is what a new workspace starts with. If no AI provider is ready, the video stops with the reason, and **Retry** asks again once one is.'],
                                ['**Edit style**', '**Classic** or **Paper** (unfolding cards, paper letters, drawn icons and black-and-white b-roll). A change applies to the next video prepared.'],
                                ['“Human touches”', 'Camera cuts, doodles, highlighted words, transitions and freeze-frames, so a reel looks edited by hand. Camera cuts, freeze-frames and words behind you are only for videos of you talking to camera.'],
                                ['**Post to**', 'Instagram, Facebook, TikTok and YouTube, with at least one ticked. TikTok and YouTube get a second copy of the video whose last card says the link is in your bio, because they cannot answer a comment with a DM.'],
                                ['**Post at**', 'From one to four times a day, in your workspace’s time zone. Approve takes the first free one.'],
                            ] },
                            'At the bottom, **What the Analyst learned** holds rules drawn from how your reels and videos did, which the Monteur and the captions follow. The Analyst writes them once at least 5 reels or videos have insights, once a week, or when you press **Refresh now**.',
                        ],
                    },
                },
                {
                    id: 'troubleshooting',
                    title: { ar: 'عندما يتوقف شيء', en: 'When something stops' },
                    body: {
                        ar: [
                            { qa: [
                                ['ضغطت **شغّل الآن** ولم يحدث شيء', ['تحقق من العامل: إن كُتب **العامل غير متصل** فالتشغيل ينتظر الماك: [[worker#status]].', 'ومع **مجلدي** يجب أن يكون المجلد موجوداً على ذلك الماك. وإن قال الشريط إنه لم يجد المجلد، اختره من جديد بزر **اختر المجلد**.']],
                                ['نافذة اختيار المجلد لم تنفتح', 'تنفتح على الماك الذي يشغّل العامل، لا على الجهاز الذي تتصفح منه، وتنتظرك 5 دقائق. وإن كان الماك مطفأً تنفتح عندما يعود. ويمكنك كتابة المسار كاملاً بنفسك بدلاً منها.'],
                                ['ريل مكتوب عليه **فشلت**', 'فشل رسمه. اضغط **أعد المحاولة** ليُرسم من جديد على جهازك الماك، أو **أخفِه** ليخرج من القائمة.'],
                                ['الاعتماد يرفض لأن تيك توك غير متصل', 'صِل تيك توك من **الإعدادات** أو أزله من **انشر على**: [[tiktok#connect]].'],
                                ['الاعتماد يقول إن ريلاً من الفيديو نفسه في ذلك اليوم، أو لا يوجد موعد متاح', 'تنفتح لك خانة الموعد مع السبب: اختر يوماً ووقتاً آخرين.'],
                                ['الاعتماد يقول إن الكلمة تتعارض مع كلمة مفعّلة', 'غيّر الكلمة المفتاحية في البطاقة واحفظ، ثم اعتمد.'],
                                ['الحفظ يرفض لأن النص ليس فيه الكلمة', 'أعد سطر الكلمة بين « » في نص إنستجرام وفيسبوك.'],
                                ['لا أستطيع تفعيل الريلز: «أكمل ملفك قبل تشغيل هذا»', 'أساسيات إعدادك ناقصة (الاسم، ومجال عملك، وعرضك الرئيسي، والمنطقة الزمنية، والأسلوب). أكملها: [[onboarding#steps]].'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['I pressed **Run now** and nothing happened', ['Look at the worker: if it says **Worker offline**, the run waits for the Mac: [[worker#status]].', 'With **My folder** the folder has to exist on that Mac. If the strip says the folder was not found, choose it again with **Choose folder**.']],
                                ['The folder window did not open', 'It opens on the Mac that runs the worker, not on the computer you are browsing from, and it waits for you for 5 minutes. If the Mac is off, it opens when it is back. You can also type the full path yourself instead.'],
                                ['A reel says **Failed**', 'Its drawing failed. Press **Retry** to draw it again on your Mac, or **Dismiss** to take it out of the list.'],
                                ['Approve is refused because TikTok is not connected', 'Connect TikTok in **Settings**, or take it off **Post to**: [[tiktok#connect]].'],
                                ['Approve says another reel from this video is already on that day, or there is no free time', 'The time field opens with the reason: pick another day and time.'],
                                ['Approve says the keyword clashes with a live keyword', 'Change the **Comment keyword** in the card, save, then approve.'],
                                ['Saving is refused because the caption lacks the keyword', 'Put the line with the keyword between « » back into the **Instagram and Facebook caption**.'],
                                ['I cannot switch the Monteur on: “Finish your profile before switching this on”', 'The basics of your setup are missing (your name, what you do, your main offer, your time zone and your voice). Finish them: [[onboarding#steps]].'],
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 11a-2. Infographics ─────────────────────────────────────────────
        {
            slug: 'infographics',
            group: 'studio',
            icon: 'images',
            title: { ar: 'الإنفوجرافيك: مقارنة متحركة بهويتك', en: 'Infographics: an animated comparison in your brand' },
            summary: {
                ar: 'من موضوع مقارنة إلى MP4 وGIF وغلاف: من يكتب الصفحة ووصفها، والتصميم الداكن والفاتح، والتعديل، وقاعدة أن الوصف يذكر كل عمود، والجدولة، وهويتك على كل صفحة.',
                en: 'From a comparison topic to an MP4, a GIF and a cover: who writes the page and its caption, the dark and light themes, editing, the rule that the caption names every column, scheduling, and your brand on every page.',
            },
            related: ['worker', 'monteur', 'youtube', 'explainers'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'ما الإنفوجرافيك هنا؟', en: 'What an infographic is here' },
                    body: {
                        ar: [
                            'الإنفوجرافيك هنا مقارنة متحركة بين شيئين أو ثلاثة، مثل «RAG vs CAG vs KAG». يأخذ كل شيء عموداً فيه: اسمه، ونوع المشكلة التي يناسبها، وملاحظة من سطر، وثلاث خطوات بالضبط، لكل خطوة رسم صغير متحرك. ويُرسم بهويتك أنت، ويخرج منه ثلاثة ملفات:',
                            { dl: [
                                ['MP4', 'الفيديو الذي تنشره **جدولة** على إنستجرام وفيسبوك، وعلى يوتيوب إذا اخترته.'],
                                ['GIF', 'لأي مكان يقبل GIF مثل لينكدإن وإكس. لا يُنشر عنك أبداً: حمّله بزر **GIF**.'],
                                ['الغلاف', 'الصورة الثابتة التي مع الـ MP4: غلافه في إنستجرام وفيسبوك، وصورته المصغّرة في يوتيوب.'],
                            ] },
                            'تُكتب الصفحة ووصفها معاً من المحتوى نفسه، فيبقى الوصف مطابقاً للـ GIF دائماً.',
                            { note: 'الإنفوجرافيك للمالك والمشغّل. وإذا كان دورك «مُطّلع» فسترى رسالة تقول إنه لا يناسب دورك.' },
                        ],
                        en: [
                            'An infographic here is an animated comparison of two or three things, such as “RAG vs CAG vs KAG”. Every thing gets a column: its name, the kind of problem it suits, a one-line note and exactly three steps, each with a small animated diagram. It is drawn in your own brand and comes out as three files:',
                            { dl: [
                                ['MP4', 'The video that **Schedule** posts to Instagram and Facebook, and to YouTube when you choose it.'],
                                ['GIF', 'For anywhere that takes a GIF, such as LinkedIn and X. It is never posted for you: download it with **GIF**.'],
                                ['Cover', 'The still image that goes with the MP4: its cover on Instagram and Facebook, and its thumbnail on YouTube.'],
                            ] },
                            'The page and its caption are written together from the same content, so the caption always describes the GIF.',
                            { note: 'Infographics are for owners and operators. With the Viewer role you see a message saying it does not fit your role.' },
                        ],
                    },
                },
                {
                    id: 'create',
                    title: { ar: 'إنشاء إنفوجرافيك', en: 'Making one' },
                    body: {
                        ar: [
                            'افتح **الاستوديو** ← **الإنفوجرافيك** وعبّئ **إنفوجرافيك جديد**:',
                            { dl: [
                                ['**ماذا تقارن**', 'شيئين أو ثلاثة، مثل «RAG vs CAG vs KAG». من 3 أحرف إلى 300.'],
                                ['**أضف ملاحظات للذكاء الاصطناعي**', 'يفتح **ملاحظات**: نقاط تريد ذكرها، أو الدرس الذي جاءت منه، أو الجمهور. حتى 2,000 حرف.'],
                                ['**اللغة**', 'العربية الفصحى أو الإنجليزية. والصفحة العربية تُكتب بالفصحى دائماً، بلا لهجة. وتبدأ بـ**اللغة الافتراضية** من هويتك.'],
                                ['**التصميم**', '**داكن وفاتح** أو **داكن** أو **فاتح**، وتبدأ على «داكن وفاتح». ومع **داكن وفاتح** تُكتب الصفحة مرة واحدة وتُرسم مرتين: إنفوجرافيكان، واحد بكل تصميم.'],
                            ] },
                            'اضغط **أنشئ**. يظهر الإنفوجرافيك تحت **الإنفوجرافيك الخاص بك** وهو يُكتب ويُرسم، ويصبح **جاهز** عندما تنتهي ملفاته، وهذا يستغرق دقيقة أو دقيقتين على جهازك الماك. يمكنك مغادرة الصفحة وهو يكمل.',
                        ],
                        en: [
                            'Open **Studio** → **Infographics** and fill in **New infographic**:',
                            { dl: [
                                ['**What to compare**', 'Two or three things, such as “RAG vs CAG vs KAG”. From 3 to 300 characters.'],
                                ['**Add notes for the AI**', 'Opens **Notes**: points to include, the lesson it comes from, the audience. Up to 2,000 characters.'],
                                ['**Language**', 'Arabic or English. An Arabic page is always written in Modern Standard Arabic (فصحى), never in dialect. It starts as the **Default language** of your brand.'],
                                ['**Theme**', '**Dark and light**, **Dark** or **Light**, starting on “Dark and light”. With **Dark and light** the page is written once and drawn twice, as two infographics, one in each theme.'],
                            ] },
                            'Press **Create**. The infographic appears under **Your infographics** while it is written and drawn, and turns **Ready** when its files are done, which takes a minute or two on your Mac. You can leave the page: it keeps working.',
                        ],
                    },
                },
                {
                    id: 'who',
                    title: { ar: 'من يكتبه؟', en: 'Who writes it' },
                    body: {
                        ar: [
                            { ul: [
                                'في مساحة مالك المنصة، وفي أي مساحة سمح لها مسؤول المنصة، يكتب Claude الصفحة والوصف على جهازك الماك، بحساب Claude المسجَّل فيه. وبعدها يرسم عاملك الملفات.',
                                'وفي كل مساحة أخرى تُكتب الصفحة والوصف على الخادم، بمزوّد الذكاء الاصطناعي الذي أعدّه مسؤول المنصة (نفس المزوّدين الذين يستطيع مساعد الرسائل استخدامهم)، ويرسم الماك الملفات فقط. وإن لم يوجد مزوّد جاهز، أو انتهت ميزانيته، أو كان معطّلاً، يرفض **أنشئ** ويذكر لك السبب ولا يُصنع شيء. ولا يعود إلى الماك بدلاً منه أبداً.',
                                'وفي الحالتين يرسم عاملك على الماك الملفات، فيجب أن يكون متصلاً. وإن لم يكن، تقول البطاقة **بانتظار جهازك الماك** ولا يضيع شيء: [[worker]].',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'In the platform owner’s workspace, and in any workspace the platform administrator has allowed it for, Claude writes the page and the caption on your Mac, with the Claude account signed in there. Then your worker draws the files.',
                                'In every other workspace the page and the caption are written on the server, by the AI provider the platform administrator set up (the same ones the DM assistant can use), and the Mac only draws the files. If no provider is ready, or its budget is used up, or it is down, **Create** is refused with the reason and nothing is made. It never falls back to a Mac.',
                                'Either way your Mac’s worker draws the files, so it has to be online. When it is not, the card says **Waiting for your Mac** and nothing is lost: [[worker]].',
                            ] },
                        ],
                    },
                },
                {
                    id: 'edit',
                    title: { ar: 'التعديل والنسخة الثانية وإعادة الكتابة', en: 'Editing, the other theme and rewriting' },
                    body: {
                        ar: [
                            'على بطاقة الإنفوجرافيك:',
                            { dl: [
                                ['**تعديل**', 'يفتح **الوصف**، وتحت **عدّل نصوص الصفحة** الصفحة نفسها: العنوان الفرعي وكلماته المميّزة، ولكل عمود اسمه وما يناسبه وملاحظته ورسمه الرئيسي وخطواته الثلاث. تعديل الوصف وحده يُحفظ فقط. أما تعديل الصفحة فيُرسم من جديد على جهازك الماك.'],
                                ['**نسخة فاتحة** / **نسخة داكنة**', 'تُنشئ الإنفوجرافيك نفسه بالتصميم الآخر، في بطاقة مستقلة.'],
                                ['**إعادة الكتابة**', 'تطلب صفحة ووصفاً جديدين لنفس الموضوع. تسألك قبلها، وتعديلاتك على هذا الإنفوجرافيك تُستبدل.'],
                                ['**أعد المحاولة**', 'على إنفوجرافيك فشل: يرسمه من جديد.'],
                                ['**احذف الإنفوجرافيك**', 'أيقونة سلة المهملات. تحذفه وتحذف الـ GIF معه، والمنشورات التي جدولتها تبقى في **الجدولة**.'],
                            ] },
                            'وتحت الإنفوجرافيك الجاهز يعرض **تعليقات متوقعة** ما يحتمل أن ينشره خبير تحته، ولكل تعليق ردّ لطيف جاهز تنسخه بزر **انسخ الرد**.',
                            'والإنفوجرافيك بعد جدولته لا يُعدَّل. إن أردت تغيير شيء، أنشئ نسخة بالتصميم الآخر وعدّل النسخة.',
                        ],
                        en: [
                            'On an infographic’s card:',
                            { dl: [
                                ['**Edit**', 'Opens the **Caption** and, under **Edit the page’s text**, the page itself: the subtitle and its highlighted words, and for each column its name, what it suits, its note, its main diagram and its three steps. Changing only the caption just saves it. Changing the page draws it again on your Mac.'],
                                ['**Light version** / **Dark version**', 'Makes the same infographic in the other theme, as a card of its own.'],
                                ['**Rewrite**', 'Asks for a new page and caption for the same topic. It asks you first, and your edits to this one are replaced.'],
                                ['**Try again**', 'On a failed one: draws it again.'],
                                ['**Delete infographic**', 'The bin icon. Removes it and its GIF. Posts you already scheduled stay in the **Scheduler**.'],
                            ] },
                            'Under a ready infographic, **Likely comments** lists the comments an expert is most likely to post under it, each with a friendly reply ready to copy with **Copy reply**.',
                            'Once an infographic is scheduled it can no longer be edited. To change something, make a copy in the other theme and edit the copy.',
                        ],
                    },
                },
                {
                    id: 'caption',
                    title: { ar: 'يجب أن يذكر الوصف كل عمود', en: 'The caption must name every column' },
                    body: {
                        ar: [
                            'الإنفوجرافيك يُنشر مع وصفه، ولذلك يجب أن يكون الوصف عن الـ GIF. والقاعدة: يجب أن يذكر كل عمود يظهر في الـ GIF بالاسم المكتوب في الصفحة. لا فرق في حالة الحرف اللاتيني، ولا في أشكال الحرف العربي مثل أ وإ وا. ولا يجوز أن يكون الوصف فارغاً أو أطول من 2,200 حرف، وهذا حد إنستجرام.',
                            { ul: [
                                'في **تعديل**، خانة **الوصف** تفحصه وأنت تكتب: يظهر كل اسم عمود بعلامة صح إن كان في الوصف، وعلامة خطأ إن لم يكن.',
                                'والإنفوجرافيك الجاهز الذي يخالف القاعدة يعرض **ما يحتاج إلى إصلاح** على بطاقته، ويرفض **جدولة** حتى تصلحه، ويسمّي الرفض الأعمدة الناقصة.',
                                'إن غيّرت اسم عمود في نصوص الصفحة، يتبع الفحص الاسم الجديد: اجعل الوصف مواكباً.',
                            ] },
                        ],
                        en: [
                            'An infographic is posted with its caption, so the caption has to be about the GIF. The rule: it must mention every column the GIF shows, by the name written on the page. Capital letters do not matter, and neither do Arabic letter variants such as أ, إ and ا. It also cannot be empty or longer than 2,200 characters, which is Instagram’s limit.',
                            { ul: [
                                'In **Edit**, the **Caption** box checks it as you type: every column name shows a tick when the caption has it and a cross when it does not.',
                                'A ready infographic that breaks the rule shows **What to fix** on its card, and **Schedule** is refused until you fix it. The refusal names the columns that are missing.',
                                'If you rename a column in the page text, the check follows the new name: keep the caption in step.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'schedule',
                    title: { ar: 'الجدولة', en: 'Scheduling it' },
                    body: {
                        ar: [
                            'على إنفوجرافيك **جاهز** اضغط **جدولة**. يخبرك حوار **جدولة الإنفوجرافيك** أين يذهب الـ MP4 مع وصفه: المنصات التي علّمت عليها في **تنشر الجدولة ملف MP4 على** من هويتك. وتحت **متى** اختر:',
                            { dl: [
                                ['أقرب موعد نشر متاح', 'أول وقت متاح من **أوقات النشر** التي حددتها في صفحة الريلز (الريلز والإنفوجرافيك يتشاركانها) بتوقيت مساحتك. والحوار يسمّي لك الوقت والمدينة.'],
                                ['الآن', 'يجدوله لهذه اللحظة.'],
                                ['في وقت أختاره', 'يوم ووقت يُقرآن بتوقيت مساحتك.'],
                            ] },
                            'وهذا ما يُنشر:',
                            { ul: [
                                'في إنستجرام وفيسبوك: منشور واحد فيه الـ MP4 وغلافه والوصف.',
                                'وفي يوتيوب إذا علّمت عليه: فيديو وصفه هو الوصف، وعنوانه عنوان الصفحة («RAG vs CAG: …»)، وصورته المصغّرة الغلاف. ولا يُفحص يوتيوب وقت الجدولة: إن كان غير متصل يفشل منشوره في **الجدولة** ويذكر السبب، ويُنشر منشور إنستجرام وفيسبوك رغم ذلك: [[youtube#disconnected]].',
                                'لا يُنشر الـ GIF في أي مكان. حمّله بزر **GIF** وانشره بنفسك على لينكدإن وإكس وغيرهما. وتيك توك ليس من الخيارات.',
                            ] },
                            'وبعد الجدولة تقول البطاقة متى يُنشر، وبجانبها رابط **افتح المنشورات**.',
                            { note: 'تحتاج الجدولة إلى منصة واحدة على الأقل معلّم عليها في **تنشر الجدولة ملف MP4 على**، وإلا فستطلب منك تحديد أين يُنشر الإنفوجرافيك أولاً.' },
                        ],
                        en: [
                            'On a **Ready** infographic press **Schedule**. The dialog, **Schedule the infographic**, says where the MP4 and its caption go: the platforms ticked under **Schedule posts the MP4 to** in your brand settings. Under **When**, choose:',
                            { dl: [
                                ['The next free posting time', 'The first free time among the **Post at** times you set in the Monteur (reels and infographics share them), in your workspace’s time zone. The dialog names the time and the city.'],
                                ['Now', 'Schedules it for this moment.'],
                                ['At a time I choose', 'A day and a time, read in your workspace’s time zone.'],
                            ] },
                            'What is posted:',
                            { ul: [
                                'On Instagram and Facebook: one post, with the MP4, its cover and the caption.',
                                'On YouTube, when ticked: a video with the caption as its description, the page’s headline (“RAG vs CAG: …”) as its title and the cover as its thumbnail. YouTube is not checked when you schedule: if it is not connected, its post fails in the **Scheduler** with the reason, and the Instagram and Facebook post still goes out: [[youtube#disconnected]].',
                                'The GIF is not posted anywhere. Download it with **GIF** and post it yourself on LinkedIn, X and the rest. TikTok is not one of the choices.',
                            ] },
                            'After scheduling, the card says when it goes out and has a link, **Open Posts**.',
                            { note: 'Schedule needs at least one platform ticked under **Schedule posts the MP4 to**. Without one it asks you to choose where infographics are posted first.' },
                        ],
                    },
                },
                {
                    id: 'brand',
                    title: { ar: 'هويتك على كل صفحة', en: 'Your brand on every page' },
                    body: {
                        ar: [
                            'في أسفل الصفحة قسم **هويتك على كل إنفوجرافيك** (يكون مفتوحاً من تلقاء نفسه حتى تحفظ اسماً). ما تحدده يُطبع أسفل كل صفحة:',
                            { dl: [
                                ['**الاسم بالعربية** و**الاسم بالإنجليزية**', 'اسمك أو اسم نشاطك بكل لغة.'],
                                ['**الموقع** و**المعرّف**', 'عنوان موقعك (مثل example.dev) ومعرّفك (مثل @you).'],
                                ['**أيقونات الحسابات**', 'إنستجرام ويوتيوب ولينكدإن وإكس وتيك توك وفيسبوك وغيت هب: علّم على ما تريد أن يظهر.'],
                                ['**اللون الأساسي** و**لون التمييز**', 'ألوان الصفحة.'],
                                ['**الصورة الشخصية**', '**ارفع صورة** (JPEG أو PNG أو WebP): تُصغَّر في متصفحك إلى مربع 512 بكسل، وتظهر دائرية وبالأبيض والأسود. وأفضلها صورة مربعة لوجهك. و**إزالة** تزيلها.'],
                                ['**تنشر الجدولة ملف MP4 على**', 'إنستجرام وفيسبوك ويوتيوب، ويجب أن تختار واحدة منها على الأقل. وتيك توك للشروحات المصوّرة فقط: مسودّة في صندوق تيك توك.'],
                                ['**التصميم الافتراضي** و**اللغة الافتراضية**', 'عندما لا تغيّرهما في الإنفوجرافيك الجديد.'],
                            ] },
                            'اضغط **احفظ الهوية**. الإنفوجرافيك الجديد يستخدمها، والقديم يبقى بشكله حتى يُرسم من جديد (بتعديل، أو نسخة بالتصميم الثاني، أو **أعد المحاولة**).',
                        ],
                        en: [
                            'At the bottom of the page, **Your brand on every infographic** (open by itself until you save a name) holds what is printed at the bottom of every page:',
                            { dl: [
                                ['**Name in Arabic** and **Name in English**', 'Your name or your business name, in each language.'],
                                ['**Website address** and **Handle**', 'Your site (such as example.dev) and your handle (such as @you).'],
                                ['**Social icons**', 'Instagram, YouTube, LinkedIn, X, TikTok, Facebook and GitHub: tick the ones to show.'],
                                ['**Main colour** and **Accent colour**', 'The colours of the page.'],
                                ['**Portrait**', '**Upload** a photo (JPEG, PNG or WebP): it is cut to a 512-pixel square in your browser, and shown round and in black and white. A square photo of your face works best. **Remove** takes it off.'],
                                ['**Schedule posts the MP4 to**', 'Instagram, Facebook and YouTube, with at least one ticked. TikTok applies to explainers only, as a draft in your TikTok inbox.'],
                                ['**Default theme** and **Default language**', 'What a new infographic starts with, until you change it there.'],
                            ] },
                            'Press **Save brand**. New infographics use it, and one you already made keeps its look until it is drawn again (by an edit, a copy in the other theme or **Try again**).',
                        ],
                    },
                },
                {
                    id: 'troubleshooting',
                    title: { ar: 'عندما يتوقف شيء', en: 'When something stops' },
                    body: {
                        ar: [
                            { qa: [
                                ['**أنشئ** يقول إنه لا يوجد مزوّد ذكاء اصطناعي جاهز، أو إن ميزانية اليوم انتهت', 'لم يُصنع شيء. مسؤول المنصة هو من يحفظ المفتاح في التشغيل ← مزوّدو الذكاء الاصطناعي، أو ينتظر تجدد الميزانية. تواصل معه وجرّب لاحقاً.'],
                                ['**أنشئ** يقول «أكمل ملفك قبل تشغيل هذا»', 'أساسيات إعدادك ناقصة. أكملها: [[onboarding#steps]].'],
                                ['البطاقة متوقفة عند **بانتظار جهازك الماك**', 'العامل غير متصل، والرسم ينتظره. شغّل الماك والعامل وسيكمل وحده: [[worker#status]].'],
                                ['مكتوب عليه **فشل**', 'تحته السبب. اضغط **أعد المحاولة**، أو **إعادة الكتابة** إن أردت صفحة جديدة.'],
                                ['**جدولة** ترفض لأن الوصف لا يذكر أعمدة', 'ضع أسماء الأعمدة الناقصة في الوصف من **تعديل**: [[infographics#caption]].'],
                                ['**جدولة** تقول اختر أين يُنشر الإنفوجرافيك', 'علّم منصة واحدة على الأقل في **تنشر الجدولة ملف MP4 على** من هويتك.'],
                                ['لا أستطيع تعديل إنفوجرافيك مجدول', 'يُقفل تعديله بعد الجدولة. أنشئ نسخة بالتصميم الآخر وعدّلها.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['**Create** says no AI provider is ready, or today’s budget is used up', 'Nothing was made. The platform administrator saves the key in Operations → AI providers, or waits for the budget to renew. Ask them and try again later.'],
                                ['**Create** says “Finish your profile before switching this on”', 'The basics of your setup are missing. Finish them: [[onboarding#steps]].'],
                                ['A card sits on **Waiting for your Mac**', 'The worker is offline, and the drawing waits for it. Start the Mac and the worker and it carries on by itself: [[worker#status]].'],
                                ['It says **Failed**', 'The reason is under it. Press **Try again**, or **Rewrite** for a new page.'],
                                ['**Schedule** is refused because the caption does not mention some columns', 'Put the missing column names into the caption, in **Edit**: [[infographics#caption]].'],
                                ['**Schedule** says to choose where infographics are posted', 'Tick at least one platform under **Schedule posts the MP4 to** in your brand settings.'],
                                ['I cannot edit a scheduled infographic', 'Editing closes once it is scheduled. Make a copy in the other theme and edit that.'],
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 11b. Illustrated explainers ─────────────────────────────────────
        {
            slug: 'explainers',
            group: 'studio',
            icon: 'lightbulb',
            title: { ar: 'الشروحات المصوّرة', en: 'Illustrated explainers' },
            summary: {
                ar: 'من موضوع إلى فيديو منشور: النص والصوت والصور والفيديو والنشر، والاعتمادان، والحصص المجانية، وقواعد المحتوى، وما يُفعل حين تتوقف خطوة.',
                en: 'From a topic to a posted video: the script, the voice, the pictures, the video and publishing, the two approvals, the free allowances, the content rules and what to do when a step stops.',
            },
            related: ['worker', 'studio-settings', 'troubleshooting'],
            sections: [
                {
                    id: 'flow',
                    title: { ar: 'المراحل والبوابتان', en: 'The flow, and the two gates' },
                    body: {
                        ar: [
                            'الشرح المصوّر فيديو بتعليق صوتي وصور ثابتة، لكل مشهد صورة وتسمية قصيرة عليها. تُدخل الموضوع، فيبحث فيه Claude ويكتب النص، وتعتمده أنت، ثم تُرسم الصور، وتعتمدها، ثم يُجهَّز الفيديو، ثم تجدوله.',
                            { ol: [
                                '**النص:** يبحث Claude على جهازك الماك بالبحث في الويب، ويكتب جملة واحدة لكل مشهد، مع وصف صورة كل مشهد وتسميته، والأوصاف، والتعليق الأول بالمصادر، والردود المتوقعة. تعدّله وتعتمده: هذه البوابة الأولى.',
                                '**الصوت:** يرسل جهازك الماك النص المعتمد إلى Gemini من Google فيقرؤه بصوت مسموع، ثم يضبط جهازك الماك توقيت كل مشهد على التسجيل.',
                                '**الصور:** صورة لكل مشهد بالأسلوب والشخصية المتكررة اللذين اخترتهما. تعيد رسم ما لا يعجبك، ثم تعتمد الصور: هذه البوابة الثانية.',
                                '**الفيديو:** يجهّز جهازك الماك فيديو عموديًا 9:16 وفيديو أفقيًا 16:9 وغلافًا، بموسيقى أو بمؤثرات صوتية فقط.',
                                '**النشر:** تنشره الجدولة، أو تنسخ ما تحتاجه إلى لينكدإن بنفسك.',
                            ] },
                            { note: 'لا يُسجَّل صوت ولا تُرسم صورة قبل أن تعتمد النص، ولا يُجهَّز فيديو قبل أن تعتمد الصور، ولا يُنشر شيء قبل أن تضغط **جدولة**.' },
                            { tip: 'الشروحات المصوّرة لمساحة مالك المنصة، ويشغّلها مسؤول المنصة. إن قالت الصفحة إنها متوقفة ففي [[explainers#troubleshooting]] ما يلزم.' },
                        ],
                        en: [
                            'An illustrated explainer is a narrated video made of still pictures, one per scene, with a short label on each. You give a topic. Claude researches it and writes the script, you approve it, the pictures are drawn, you approve those, the videos are rendered, and then you schedule it.',
                            { ol: [
                                '**Script:** Claude, on your Mac, researches with web search and writes one sentence per scene, with each scene’s picture brief and label, the captions, the first comment with the sources and the likely replies. You edit it and approve it: the first gate.',
                                '**Voice:** your Mac sends the approved script to Google’s Gemini, which reads it aloud, and then your Mac times every scene to the recording.',
                                '**Pictures:** one picture per scene, in the style and with the recurring character you chose. You redraw any you don’t like, then approve them: the second gate.',
                                '**Video:** your Mac renders a vertical 9:16 video, a horizontal 16:9 video and a cover, with music or with sound effects only.',
                                '**Publish:** Schedule posts it, or you copy what you need to LinkedIn yourself.',
                            ] },
                            { note: 'Nothing is voiced or drawn until you approve the script, nothing is rendered until you approve the pictures, and nothing is posted until you press **Schedule**.' },
                            { tip: 'Explainers are for the platform owner’s workspace, and the platform administrator switches them on. If the page says they are switched off, [[explainers#troubleshooting]] has the way out.' },
                        ],
                    },
                },
                {
                    id: 'start',
                    title: { ar: 'بدء شرح جديد', en: 'Starting an explainer' },
                    body: {
                        ar: [
                            'افتح **الاستوديو** ← **الشروحات المصوّرة**، واملأ النموذج في الأعلى:',
                            { dl: [
                                ['الموضوع', 'من 3 إلى 300 حرف. اكتبه كسؤال أو عنوان واضح.'],
                                ['اللغة', 'العربية الفصحى أو الإنجليزية. النص العربي فصحى دائمًا، لا لهجة.'],
                                ['المدة', 'من 60 إلى 90 ثانية (10 إلى 30 مشهدًا)، أو من 3 إلى 5 دقائق (30 إلى 90 مشهدًا)، أو من 10 إلى 15 دقيقة (120 إلى 300 مشهد). الشرح الطويل يستغرق رسمه أيامًا على الحصة المجانية: [[explainers#allowance]].'],
                                ['الصوت', '**موسيقى في الخلفية** (مقطع من مكتبتك تحت الصوت، واختيارها يُظهر قائمة المقاطع) أو **المؤثرات الصوتية فقط** (صوت خافت عند كل قطع وكل تسمية، بلا موسيقى). التفاصيل في [[explainers#music]].'],
                                ['أظهر النص المكتوب على الشاشة', 'مفعّل افتراضيًا، لأن كثيرين يشاهدون بلا صوت.'],
                                ['روابط المصادر', 'حتى 10 روابط، رابط في كل سطر. يقرؤها الكاتب أولًا.'],
                                ['ملاحظات للكاتب', 'ما يجب تغطيته وإلى ماذا يُشار، حتى 2000 حرف.'],
                            ] },
                            'اضغط **ابدأ**، فيظهر الشرح بحالة **قيد الكتابة**.',
                            { tip: 'ابدأ بمدة 60 إلى 90 ثانية: هي أسرع ما يُراجع، وتتسع لها حصة يوم واحد.' },
                        ],
                        en: [
                            'Open **Studio** → **Explainers** and fill in the form at the top:',
                            { dl: [
                                ['Topic', '3 to 300 characters. Write it as a question or a clear title.'],
                                ['Language', 'Arabic or English. Arabic is always Modern Standard Arabic, never dialect.'],
                                ['Length', '60–90 seconds (10 to 30 scenes), 3–5 minutes (30 to 90 scenes) or 10–15 minutes (120 to 300 scenes). A long one takes several days to draw on the free allowance: [[explainers#allowance]].'],
                                ['Sound', '**Background music** (a track from your library under the voice; choosing it shows the track picker) or **Sound effects only** (a soft sound on each cut and each label, and no music). Details in [[explainers#music]].'],
                                ['Show subtitles', 'On by default, because many people watch without sound.'],
                                ['Source links', 'Up to 10 links, one per line. The writer reads them first.'],
                                ['Notes for the writer', 'What to cover and what to point to, up to 2,000 characters.'],
                            ] },
                            'Press **Start**. The explainer appears with the status **Writing**.',
                            { tip: 'Start with 60–90 seconds. It is the quickest to check, and one day’s allowance covers it.' },
                        ],
                    },
                },
                {
                    id: 'script',
                    title: { ar: 'الخطوة 1: النص', en: 'Step 1: the script' },
                    body: {
                        ar: [
                            'الكتابة تستغرق دقائق، وقد تصل إلى 20 دقيقة لأن الكاتب يبحث أولًا. يمكنك مغادرة الصفحة، فالعمل يستمر. يكتب Claude على جهازك الماك افتراضيًا، ويكتب Gemini حين يتعذّر ذلك على الماك أو حين تختاره من الإعدادات. وتعرض الخطوة من كتب هذه المسودة.',
                            'كل مشهد جملة واحدة وصورة واحدة. تُكتب الجملة لتبقى صورتها على الشاشة نحو 3.5 إلى 6.5 ثانية: وقتًا يكفي لرؤية الصورة وقراءة تسميتها، ولا يطول حتى يفقد الجمهور تركيزه. والجملة الأولى أقصر، لتتغيّر الصورة الأولى خلال 4 ثوانٍ تقريبًا. وفي كل مشهد:',
                            { dl: [
                                ['النص المعروض', 'الجملة كما تظهر في الفيديو والنص المكتوب.'],
                                ['النص المنطوق', 'ما يقوله الصوت. تُكتب المصطلحات الإنجليزية كما ينبغي أن ينطقها الصوت.'],
                                ['التسمية', 'بطاقة قصيرة على الصورة: حتى 4 كلمات أو رقم مثل سنة. يرسمها التطبيق، ولا يرسمها نموذج الصور أبدًا.'],
                                ['وصف الصورة (بالإنجليزية)', 'من في الصورة، ووضعيته وحركته، والمكان، وما تشير إليه التسمية.'],
                                ['الشخصيات', 'الشخصيات المتكررة التي تظهر في المشهد، حتى أربع.'],
                                ['الصورة نفسها كالمشهد السابق', 'يستعيد المشهد صورة سابقه بدل رسم صورة جديدة.'],
                            ] },
                            'بأزرار كل مشهد تنقله إلى الأعلى أو الأسفل، وتضيف مشهدًا بعده، وتحذفه، وذلك قبل تسجيل الصوت فقط: بعده يصبح لكل مشهد مكانه وصورته وتوقيته، فتعدّل نصوص المشاهد في أماكنها، أو تطلب إعادة كتابة. وتحت العنوان يظهر تقدير المدة: عدد الكلمات المنطوقة مقسومًا على سرعة المعلّق، مقابل المدة المستهدفة. وإن خرج النص عنها، أو عن العدد المعتاد للمشاهد، أو بقيت صورة أكثر من 7 ثوانٍ أو اختفت في أقل من ثانيتين أو بقيت الصورة الأولى أكثر من 4.5 ثانية، أو لم يذكر مصادر كافية، ظهر تنبيه. ويمكنك الاعتماد رغم التنبيه.',
                            'وتحت المشاهد: عنوان الفيديو (70 حرفًا على الأكثر)، والوصف لكل منصة، والتعليق الأول بالمصادر، وحتى 10 ردود متوقعة (يكتب الكاتب 5 فأكثر)، والمصادر.',
                            { ul: [
                                '**أعد الكتابة بملاحظة:** يكتب الكاتب مسودة جديدة بناءً على ملاحظتك («بداية أقصر، وأضف نتيجة 2020»). تبقى المسودة الحالية ظاهرة حتى تصل الجديدة، وتُستبدل تعديلاتك غير المحفوظة. ويتاح ذلك قبل الاعتماد فقط.',
                                '**اعتمد النص:** يحفظ تعديلاتك أولًا ثم يبدأ تسجيل الصوت. هذه البوابة الأولى. وبعدها يعني تعديل النص المنطوق أو المعروض تسجيل الصوت من جديد.',
                            ] },
                            { note: 'يجب أن ينتهي المشهد الأخير بسؤال حقيقي موجّه إلى المشاهد. أما طلب التعليق بكلمة أو التفاعل بإشارة فيُرفض لأنه استدراج للتفاعل: [[explainers#rules]]. ولا يقبل الحفظ تعديلًا يضيف مشكلة من هذا النوع، بل يسرد لك المشكلات كلها لتصلحها دفعة واحدة، والنص الذي فيه مشكلة لا يُعتمد حتى تُصلح. أما التنبيهات فيمكنك الاعتماد رغمها.' },
                        ],
                        en: [
                            'Writing takes a few minutes, up to 20, because the writer researches first. You can leave the page: the work carries on. Claude on your Mac writes by default, and Gemini writes when the Mac cannot or when you chose it in the settings. The step says who wrote the draft you are looking at.',
                            'Each scene is one sentence and one picture. The sentence is written to keep its picture on screen about 3.5 to 6.5 seconds: long enough to see it and read its label, short enough to keep people focused. The first sentence is shorter, so the first picture changes within about 4 seconds. Each scene holds:',
                            { dl: [
                                ['On-screen text', 'The sentence as it appears in the video and in the subtitles.'],
                                ['Spoken text', 'What the voice says. English terms are spelled the way the voice should say them.'],
                                ['Label', 'A short tag on the picture: up to 4 words, or a number such as a year. The app draws it; the image model never does.'],
                                ['Picture brief (English)', 'Who is in the picture, their pose and action, the setting, and what the label points to.'],
                                ['Characters', 'The recurring characters in the scene, up to four.'],
                                ['Same picture as the previous scene', 'The scene reuses its predecessor’s picture instead of drawing a new one.'],
                            ] },
                            'Each scene has buttons to move it up or down, add a scene after it, and remove it, until the voice is made only: after it a scene keeps its place, its picture and its time, so you edit the text of the scenes where they are, or ask for a rewrite. Above the scenes the length estimate shows the spoken words divided by the narrator’s pace, against the target. If the script falls outside it, or outside the usual number of scenes, or a picture stays more than 7 seconds or goes in under 2, or the first picture stays more than 4.5 seconds, or it cites too few sources, a warning appears. You can still approve over a warning.',
                            'Below the scenes: the video title (at most 70 characters), a caption for each platform, the first comment with the sources, up to 10 likely replies (the writer gives 5 or more), and the sources.',
                            { ul: [
                                '**Rewrite with a note:** the writer writes a new draft from your note (“a shorter hook, and add the 2020 result”). The current draft stays visible until the new one arrives, and your unsaved edits are replaced. It is offered before you approve only.',
                                '**Approve the script:** saves your edits first, then starts the voice. This is the first gate. After it, changing the spoken or on-screen text means voicing again.',
                            ] },
                            { note: 'The last scene must end with a genuine question to the viewer. Asking people to comment a word or to react is refused as engagement bait: [[explainers#rules]]. A save never adds a problem of that kind: it lists every problem so you fix them in one pass, and a script that has one cannot be approved until it is fixed. Warnings you can approve over.' },
                        ],
                    },
                },
                {
                    id: 'voice',
                    title: { ar: 'الخطوة 2: الصوت', en: 'Step 2: the voice' },
                    body: {
                        ar: [
                            'بعد الاعتماد يرسل جهازك الماك النص إلى Gemini من Google، وهو يعمل على خوادم Google لا على جهازك، فيقرؤه بصوت مسموع. يستغرق النص القصير بضع دقائق، والنص الطويل يُسجَّل على أجزاء تُضمّ في تسجيل واحد بصوت واحد. ثم يضبط جهازك الماك توقيت كل مشهد على التسجيل بحيث يقع القطع عند أول كلمة منه.',
                            'في الخطوة مشغّل للتسجيل، وقائمة «وقت كل مشهد» بزر تشغيل لكل مشهد.',
                            { ul: [
                                '**راجع التوقيت:** تظهر حين تعذّرت مطابقة بعض الكلمات مع التسجيل، فتتبع القطعات هناك عدد الكلمات. استمع كاملًا، وإن جاء قطع مبكرًا أو متأخرًا فعدّل ذلك المشهد وسجّل الصوت من جديد.',
                                '**سجّل الصوت من جديد:** يظهر حين تعدّل النص المنطوق أو المعروض بعد التسجيل، لأن التسجيل وتوقيتاته لم يعودا مطابقين. أما التسميات وأوصاف الصور والصور نفسها فلا تحتاج إلى تسجيل جديد.',
                            ] },
                            'إن بلغ مزوّد الصوت حدّه اليومي المجاني فاقرأ [[explainers#troubleshooting]].',
                        ],
                        en: [
                            'After approval, your Mac sends the script to Google’s Gemini, which runs on Google’s servers, not on your Mac, and reads it aloud. A short script takes a few minutes, and a long one is voiced in parts that are joined into one recording in one voice. Then your Mac times every scene to the audio, so the cut lands on its first spoken word.',
                            'The step has a player for the recording, and a list called “Time of each scene” with a play button for each scene.',
                            { ul: [
                                '**Check the timing:** appears when some words could not be matched to the audio, so the cuts there follow word counts instead. Listen through. If a cut lands early or late, edit that scene and voice it again.',
                                '**Voice it again:** appears when you edit the spoken or the on-screen text after the voice was made, because the audio and its timings no longer match. Labels, picture briefs and the pictures themselves never need a new voice.',
                            ] },
                            'If the voice provider’s free daily limit is reached, read [[explainers#troubleshooting]].',
                        ],
                    },
                },
                {
                    id: 'pictures',
                    title: { ar: 'الخطوة 3: الصور', en: 'Step 3: the pictures' },
                    body: {
                        ar: [
                            'بعد الصوت يبدأ الرسم وحده، مشهدًا بعد مشهد، وتقرأ تقدمه: «رُسمت 7 من 20». لكل مشهد صورته ونصه وتسميته.',
                            { ul: [
                                '**أعد الرسم:** مع ملاحظة اختيارية («يحمل كتابًا»). يتغير ذلك المشهد وحده، وتبقى آخر ثلاث صور له: اضغط إحداها لتستخدمها بدل الحالية.',
                                '**ارسم كل الصور** أو **تابع الرسم:** حين يتوقف الرسم، بسبب نفاد الحصة أو أخطاء متتالية، يستأنفه لما بقي.',
                                'المشهد الذي اخترت له **الصورة نفسها كالمشهد السابق** يُنسخ ولا يُرسم.',
                                '**اعتمد الصور:** هذه البوابة الثانية. يُفعَّل الزر حين يكون لكل مشهد صورة والتسجيل مطابقًا للنص، ويبدأ بعده التجهيز.',
                            ] },
                            'تحقق من كل صورة: لا نص داخلها، ولا امرأة ولا فتاة، والشخصية المتكررة تُعرف بسهولة. وكل إعادة رسم تستهلك صورة من حصة اليوم، فأعد رسم القليل الخاطئ فقط. ويمكنك إعادة الرسم منذ ظهور الصور حتى نشر الفيديو، عدا أثناء تجهيز الفيديو.',
                            { tip: 'إن توقف الرسم عند «بانتظار حصة الغد»، فتقدمك محفوظ ويتابع وحده بعد تجدد الحصة. التفاصيل في [[explainers#allowance]].' },
                        ],
                        en: [
                            'After the voice, drawing starts by itself, one scene at a time, and you can read its progress: “7 of 20 drawn”. Each scene shows its picture, its text and its label.',
                            { ul: [
                                '**Redraw:** with an optional note (“he is holding a book”). Only that scene changes, and its last three pictures stay: press one to use it instead of the current one.',
                                '**Draw all pictures** or **Continue drawing:** when drawing has stopped, because the allowance ran out or after repeated failures, this starts it again for what is left.',
                                'A scene set to **Same picture as the previous scene** is copied, never drawn.',
                                '**Approve the pictures:** the second gate. The button is on once every scene has a picture and the audio matches the text, and rendering starts after it.',
                            ] },
                            'Check each picture: no text in it, no woman or girl, and the recurring character easy to recognise. Every redraw spends one picture of today’s allowance, so redraw only the few that are wrong. You can redraw from the moment the pictures exist until the video is posted, except while the video is rendering.',
                            { tip: 'If drawing stops at “Waiting for tomorrow’s allowance”, your progress is kept and it carries on by itself once the allowance renews. Details in [[explainers#allowance]].' },
                        ],
                    },
                },
                {
                    id: 'video',
                    title: { ar: 'الخطوة 4: الفيديو', en: 'Step 4: the video' },
                    body: {
                        ar: [
                            'يجهّز جهازك الماك ثلاثة ملفات، ويستغرق الشرح القصير بضع دقائق:',
                            { ul: [
                                'فيديو **عمودي 9:16**: العنوان في الأعلى، والصورة 16:9 في الوسط، والتسمية على الصورة، والنص المكتوب تحتها إن كان مفعّلًا.',
                                'فيديو **أفقي 16:9**: الصورة بملء الإطار مع التسمية والنص المكتوب.',
                                '**الغلاف**: صورة ثابتة للنشر.',
                            ] },
                            'يقع كل قطع على بداية كلام مشهده. شغّل الفيديوين وراجعهما، و**نزّل** ما تحتاجه.',
                            { dl: [
                                ['الموسيقى', 'يُسمع المقطع تحت الصوت ويخفت حين يتكلم المعلّق، مع تدرّج في أول الفيديو وآخره. وإن كان ترخيصه يشترط الإسناد أُضيف سطر الإسناد إلى كل وصف.'],
                                ['المؤثرات الصوتية فقط', 'صوت خافت عند كل قطع وكل تسمية، أخفض من الصوت، بلا موسيقى.'],
                                ['صُنع الفيديو قبل آخر تعديلاتك', 'يظهر حين تغيّر النص المنطوق أو الصوت بعد التجهيز، ولا تُجدول الجدولة فيديو كهذا. أما تسمية أو صورة جديدة فلا تدخل الفيديو أيضًا إلا بتجهيز جديد.'],
                            ] },
                            'تحت المشغّلين تغيّر الصوت والنص المكتوب ثم تضغط **جهّز الفيديو مجددًا**. تبقى الملفات السابقة حتى ينجح التجهيز الجديد، فلا تضيع نسخة جيدة بسبب محاولة فاشلة.',
                        ],
                        en: [
                            'Your Mac renders three files, and a short explainer takes a few minutes:',
                            { ul: [
                                'A video, **Vertical 9:16**: the title at the top, the 16:9 picture in the middle, the label on the picture, and the subtitles below it when they are on.',
                                'A video, **Horizontal 16:9**: the picture full frame, with the label and the subtitles.',
                                'The **Cover**: a still image for posting.',
                            ] },
                            'Every cut lands on the first word of its scene. Play both videos, review them, and **Download** what you need.',
                            { dl: [
                                ['Music', 'The track plays under the voice and is lowered while the narrator speaks, with a fade at the start and the end. If its licence asks for credit, the credit line is added to every caption.'],
                                ['Sound effects only', 'A soft sound on each cut and each label, quieter than the voice, and no music.'],
                                ['The video was made before your latest edits', 'Appears when you change the narration or the sound after rendering, and Schedule will not post a video like that. A new label or picture also reaches the video only with a new render.'],
                            ] },
                            'Under the players you change the sound and the subtitles and press **Render again**. The previous files stay until the new render succeeds, so a good copy is never lost to a failed attempt.',
                        ],
                    },
                },
                {
                    id: 'publish',
                    title: { ar: 'الخطوة 5: النشر', en: 'Step 5: publish' },
                    body: {
                        ar: [
                            'اضغط **جدولة**، واختر أقرب موعد نشر متاح، أو الآن، أو وقتًا تحدده بتوقيت مساحتك. وهذا ما يُنشر وأين، في مجموعة واحدة. إنستجرام وفيسبوك ويوتيوب وتيك توك تتبع المنصات المحددة في **تنشر الجدولة ملف MP4 على** في إعدادات علامة الإنفوجرافيك:',
                            { dl: [
                                ['إنستجرام وفيسبوك', 'الفيديو العمودي مع غلافه.'],
                                ['يوتيوب', 'الفيديو الأفقي مع عنوان يوتيوب ووصفه إن زادت المدة على 3 دقائق، وإلا فالفيديو العمودي بصيغة Shorts.'],
                                ['تيك توك', 'إن كان معلَّمًا هناك فقط: مسودة في صندوق تيك توك الوارد، تنشرها من تطبيق تيك توك.'],
                                ['لينكدإن', 'ليس تلقائيًا: استخدم [[explainers#linkedin]].'],
                            ] },
                            'لكل منصة وصفها الخاص، وتعدّله في خطوة النص. وإن كان مقطع الموسيقى يشترط الإسناد أُضيف سطره إلى كل وصف تلقائيًا.',
                            'بعد الجدولة تعرض الخطوة حالة كل منشور ورابطه حين يُنشر، وفي صفحة **الجدولة** تجد كل شيء. وحين يُنشر كل منشور منها تصير الحالة **نُشر** مع التاريخ بدل **مجدول**.',
                            { note: 'تُسجَّل الجدولة على الملفات كما هي لحظة الضغط. إن عدّلت بعدها فجهّز فيديو جديدًا قبل الجدولة التالية.' },
                        ],
                        en: [
                            'Press **Schedule** and choose the next free slot, now, or a time you pick in your workspace’s time zone. This is what is posted, and where, as one group. Instagram, Facebook, YouTube and TikTok follow the platforms set under **Schedule posts the MP4 to** in the Infographics brand settings:',
                            { dl: [
                                ['Instagram and Facebook', 'The vertical video with its cover.'],
                                ['YouTube', 'The horizontal video with the YouTube title and description when it runs longer than 3 minutes, otherwise the vertical video as a Short.'],
                                ['TikTok', 'Only when it is ticked there: a draft in your TikTok inbox, which you post from the TikTok app.'],
                                ['LinkedIn', 'Not automatic: use [[explainers#linkedin]].'],
                            ] },
                            'Each platform has its own caption, and you edit it in the script step. If the music track asks for credit, its line is added to every caption automatically.',
                            'After scheduling, the step shows each post’s status and its link once it is published, and the **Scheduler** page holds everything. Once every one of its posts is published, the status reads **Posted** with the date instead of **Scheduled**.',
                            { note: 'Scheduling takes the files as they are when you press the button. If you edit afterwards, render again before you schedule again.' },
                        ],
                    },
                },
                {
                    id: 'linkedin',
                    title: { ar: 'حزمة لينكدإن', en: 'The LinkedIn kit' },
                    body: {
                        ar: [
                            'يحذف لينكدإن الأسطر الفارغة حين تلصق نصًا، فيتلاصق كلامك. تحوّل الحزمة كل سطر فارغ إلى سطر فيه حرف واحد غير مرئي (U+2800)، فيبقى التباعد كما كتبته.',
                            { ol: [
                                'افتح خطوة **النشر**. الحزمة هناك منذ أول مسودة، قبل أن يجهز الفيديو.',
                                'اضغط **انسخ الوصف** والصقه في منشور لينكدإن. وهو وصف إنستجرام وفيسبوك، مع سطر الإسناد إن لزم.',
                                'انشر المنشور، ثم اضغط **انسخ التعليق الأول** والصقه تعليقًا تحته. فهو يذكر المصادر.',
                            ] },
                            'ارفع الفيديو إلى لينكدإن بنفسك: نزّله من خطوة الفيديو.',
                        ],
                        en: [
                            'LinkedIn removes empty lines when you paste text, so your paragraphs run together. The kit turns every blank line into a line holding one invisible character (U+2800), so the spacing stays as you wrote it.',
                            { ol: [
                                'Open the **Publish** step. The kit is there from the first draft, before the video is ready.',
                                'Press **Copy the caption** and paste it into a LinkedIn post. It is the Instagram and Facebook caption, with the credit line when one is needed.',
                                'Publish the post, then press **Copy the first comment** and paste it as a comment under it. It lists the sources.',
                            ] },
                            'Upload the video to LinkedIn yourself: download it from the Video step.',
                        ],
                    },
                },
                {
                    id: 'settings',
                    title: { ar: 'الإعدادات', en: 'Settings' },
                    body: {
                        ar: [
                            'افتح **الاستوديو** ← **الشروحات المصوّرة** ← **المظهر والإعدادات**. تضبطها مرة واحدة فيستخدمها كل شرح جديد.',
                            { dl: [
                                ['الأسلوب الفني', 'بالإنجليزية: يقرؤه نموذج الصور أولًا. صف الطلاء والورق وألوان اللوحة.'],
                                ['المعلّق للعربية وللإنجليزية', 'صوت Gemini لكل لغة، وطريقة إلقائه تُرسل بجانب النص لا داخله.'],
                                ['لون العنوان', 'لون العنوان أعلى الفيديو العمودي.'],
                                ['الحركة', '**صور متحركة (طبقات)** هو الافتراضي: يرفع جهازك الماك العنصر الرئيسي من كل صورة إلى طبقة مستقلة، فتتحرك الخلفية والعنصر حركة مختلفة قليلًا (دفع بطيء للكاميرا وتنفّس خفيف) مع تكبير بين الصور. لا تكلفة إضافية لأنه يجري على جهازك. الحركات صغيرة عمدًا: العنصر مرسوم أيضًا في طبقة الخلفية، فالحركة الكبيرة تُظهر ظلًّا له. و**صور ثابتة** تعيد الشكل القديم.'],
                                ['ما يبدأ به كل شرح جديد', 'اللغة والمدة والصوت والنص المكتوب الافتراضية.'],
                                ['سرعة الإلقاء (متقدم)', 'عدد الكلمات في الثانية لتقدير المدة. لا تغيّره إلا إن كانت التقديرات خاطئة دائمًا.'],
                                ['من يكتب النص', '**Claude على جهازي الماك** أو **Gemini**، مع خيار أن يكتب Gemini إن تعذّرت الكتابة على الماك.'],
                            ] },
                            'في **الشخصيات** تضيف حتى 6 شخصيات، لكل منها اسم ومعرّف ووصف بالإنجليزية. اضغط **ولّد 4** لترى أربعة مرشحين بحجم 448 بكسل، تستهلك نحو أربع صور من حصة اليوم، واعتمد أحدها صورةً مرجعية، أو **ارفع صورة**: تُصغَّر في متصفحك إلى 448 بكسل على الأكثر. ولا امرأة ولا فتاة أبدًا: يُرفض الوصف الذي يذكرهما.',
                            'مكتبة الموسيقى في [[explainers#music]].',
                            'وبطاقة مسؤول المنصة في **الإعدادات** ← **المنصة** ← **الشروحات المصوّرة**: تشغّل الشروحات لمساحتك، وتدخل Account ID ورمز Workers AI (يُحفظ مشفّرًا ولا يُعرض منه إلا آخر أربعة أحرف)، وتضبط الحد اليومي والوحدات لكل صورة، وتضغط **اختبر** لترسم صورة تجريبية. ومن أين تأتي بهذه القيم: في لوحة Cloudflare افتح AI ← Workers AI ← Use REST API وانسخ Account ID، ثم أنشئ رمزًا من «Create a Workers AI API Token».',
                        ],
                        en: [
                            'Open **Studio** → **Explainers** → **Look and settings**. You set these once and every new explainer uses them.',
                            { dl: [
                                ['Art style', 'In English: the image model reads it first. Describe the paint, the paper and the palette.'],
                                ['Narrator for Arabic and for English', 'A Gemini voice for each language. How it speaks is sent beside the text, never in it.'],
                                ['Title colour', 'The colour of the title at the top of the vertical video.'],
                                ['Motion', '**Moving pictures (layers)** is the default: your Mac lifts the subject of each picture into its own layer, so the background and the subject move a little differently (a slow camera push and a light breathing), with a zoom between pictures. It adds no cost, because it runs on your Mac. The moves are small on purpose: the subject is still painted in the background layer too, so a big move would show a ghost. **Still pictures** gives the old look.'],
                                ['What a new explainer starts with', 'The default language, length, sound and subtitles.'],
                                ['Speaking pace (advanced)', 'Words per second, for the length estimate. Change it only if the estimates are always off.'],
                                ['Who writes the script', '**Claude on my Mac** or **Gemini**, with a switch that lets Gemini write when the Mac cannot.'],
                            ] },
                            'In **Characters** you add up to 6, each with a name, a key and a description in English. Press **Generate 4** to see four candidates at 448 px, which use about four pictures of today’s allowance, and approve one as the reference picture, or **Upload a picture**: it is resized in your browser to at most 448 px. No women or girls are drawn: a description that names one is refused.',
                            'The music library is in [[explainers#music]].',
                            'The platform administrator’s card is in **Settings** → **Platform** → **Explainers**: switch Explainers on for your workspace, enter the Cloudflare Account ID and the Workers AI token (stored encrypted, and only its last four characters are ever shown), set the daily cap and the units per picture, and press **Test** to draw a test picture. To find these: in the Cloudflare dashboard open AI → Workers AI → Use REST API and copy the Account ID, then create a token with “Create a Workers AI API Token”.',
                        ],
                    },
                },
                {
                    id: 'allowance',
                    title: { ar: 'الحصص المجانية، والتوقف المؤقت، وقاعدة صفر دولار', en: 'The free allowances, pauses and the $0 rule' },
                    body: {
                        ar: [
                            { dl: [
                                ['الصور', 'تمنح Cloudflare Workers AI نحو 10,000 وحدة مجانية كل يوم، وتكلّف الصورة بمرجع واحد نحو 110 وحدات، فيُرسم نحو 90 صورة في اليوم. والحد اليومي في بطاقة المسؤول (80 افتراضيًا) يوقف الرسم قبل نفاد الحصة.'],
                                ['شرح 60 إلى 90 ثانية', 'نحو 20 صورة، أي يوم واحد.'],
                                ['شرح 10 إلى 15 دقيقة', 'من 150 إلى 250 مشهدًا تقريبًا، أي يومان أو ثلاثة.'],
                                ['الصوت', 'نسخة Gemini المجانية، وحدّها اليومي غير معلن. يُرسل طلب واحد للشرح القصير.'],
                            ] },
                            'إن بلغ الرسم الحصة أو الحد اليومي توقف، وكتبت الصفحة «بانتظار حصة الغد (رُسمت n من m)». يبقى ما رُسم، ويتابع الرسم وحده بعد تجدد الحصة عند منتصف الليل بتوقيت UTC بزيادة 5 دقائق. ولا يُحتسب عليك شيء.',
                            { warn: 'قاعدة صفر دولار: ابقَ على خطة Workers Free. على هذه الخطة يفشل الطلب بعد انتهاء الحصة بدل أن يُحاسَب عليه. وإن نقلت حسابك إلى خطة مدفوعة فقد تحاسبك Cloudflare، والشروحات لا تغيّر الخطة نيابةً عنك.' },
                            { tip: 'كل إعادة رسم، وكل مرشحي الشخصية الأربعة، تُحسب من الحصة. افحص الصور مرة واحدة وأعد رسم القليل منها فقط.' },
                        ],
                        en: [
                            { dl: [
                                ['Pictures', 'Cloudflare Workers AI gives about 10,000 free units a day, and a picture with one reference costs about 110, so about 90 pictures a day. The daily cap on the administrator’s card (80 by default) stops drawing before the allowance runs out.'],
                                ['A 60–90 second explainer', 'About 20 pictures: one day.'],
                                ['A 10–15 minute explainer', 'Roughly 150 to 250 scenes: two or three days.'],
                                ['Voice', 'Gemini’s free tier, whose daily limit is not published. A short explainer sends one request.'],
                            ] },
                            'When drawing reaches the allowance or the daily cap it pauses, and the page says “Waiting for tomorrow’s allowance (n of m drawn)”. What was drawn is kept, and drawing carries on by itself once the allowance renews at midnight UTC plus 5 minutes. Nothing is charged.',
                            { warn: 'The $0 rule: stay on the Workers Free plan. On it, a request past the allowance fails instead of being billed. If you move the account to a paid plan, Cloudflare may charge you, and Explainers never changes the plan for you.' },
                            { tip: 'Every redraw, and the four candidates of a character, count against the allowance. Check the pictures once and redraw only the few that are wrong.' },
                        ],
                    },
                },
                {
                    id: 'rules',
                    title: { ar: 'قواعد المحتوى', en: 'The content rules' },
                    body: {
                        ar: [
                            { dl: [
                                ['مصادر حقيقية', 'يبحث الكاتب قبل أن يكتب، ويفضّل المصادر الأولى: الأوراق العلمية والوثائق الرسمية. يُذكر كل مصدر بعنوانه ومؤلفيه أو ناشره وسنته ورابطه، وتستند كل جملة تذكر معلومة إلى أحدها، ويذكرها التعليق الأول. وإن كان لديك مصدر أفضل فأضف رابطه واطلب إعادة الكتابة.'],
                                ['لا امرأة ولا فتاة في الصور', 'يُطلب هذا من الكاتب، ويُفحص كل وصف صورة ووصف شخصية على قائمة ألفاظ بالعربية والإنجليزية قبل أن يُرسل أي شيء إلى مزوّد الصور، ويُرفض برسالة إن طابقها. واعتمادك للصور هو الفحص الأخير.'],
                                ['نص أصلي', 'كل شرح يُبحث لموضوعه ويمر باعتمادين منك. ويوتيوب لا يموّل المحتوى المنتج بالجملة من قوالب مكررة، فعدّل النص حتى يقول ما تقف خلفه.'],
                                ['سؤال ختامي حقيقي', 'يسأل المشهد الأخير المشاهد سؤالًا صادقًا. أما «علّق بكلمة» أو «اكتب 1» أو «تفاعل بإشارة» فاستدراج للتفاعل، يُرفض ويخفض ميتا ظهوره.'],
                                ['لا نص داخل الصور', 'يضيف التطبيق التسميات والنص المكتوب بلغة الفيديو.'],
                            ] },
                        ],
                        en: [
                            { dl: [
                                ['Real sources', 'The writer researches before it writes, and prefers primary sources: papers and official documentation. Every source is listed with its title, authors or publisher, year and link, each factual sentence rests on one of them, and the first comment lists them. If you have a better source, add its link and ask for a rewrite.'],
                                ['No women or girls in the pictures', 'The writer is told, and every picture brief and character description is checked against a list of terms in Arabic and English before anything is sent to the image provider, and refused with a message if one matches. Your approval of the pictures is the last check.'],
                                ['Original scripts', 'Each explainer is researched for its own topic and passes two approvals from you. YouTube does not monetise mass-produced template content, so edit the script until it says something you would stand behind.'],
                                ['A genuine closing question', 'The last scene asks the viewer a sincere question. “Comment a word”, “type 1” or “react with an emoji” is engagement bait: it is refused, and Meta demotes it.'],
                                ['No text inside pictures', 'The app adds the labels and the subtitles, in the video’s language.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'music',
                    title: { ar: 'تراخيص الموسيقى', en: 'Music licences' },
                    body: {
                        ar: [
                            'مكتبة الموسيقى تبدأ فارغة عمدًا، لأن ترخيص كل مقطع عليك أنت أن تقرره. أضف فقط مقاطع يحق لك استخدامها على كل منصة تنشر عليها. تجدها في **الاستوديو** ← **الشروحات المصوّرة** ← **المظهر والإعدادات** ← **مكتبة الموسيقى**.',
                            'لكل مقطع عنوان وفنان وترخيص وسطر إسناد، وخيار **الترخيص يشترط الإسناد**. إن فعّلته أُضيف سطر الإسناد إلى كل وصف تلقائيًا، ولا يُحفظ مقطع يشترط الإسناد بلا سطر.',
                            { dl: [
                                ['Pixabay Music', 'لا يشترط إسنادًا، لكن تجنّب المقاطع التي عليها أيقونة الدرع الخاصة بـ Content ID.'],
                                ['incompetech (كيفن ماكلاود)', 'ترخيص CC BY 4.0: الإسناد مطلوب، ففعّل الخيار والصق سطر الإسناد.'],
                                ['Free Music Archive', 'استخدم CC BY أو CC0 فقط، ولا تستخدم أبدًا ما فيه NC أو ND أو SA.'],
                                ['مكتبة صوت يوتيوب', 'ليوتيوب وحده، فلا تصلح لفيسبوك ولا إنستجرام ولا تيك توك.'],
                            ] },
                            'أما **المؤثرات الصوتية فقط** فيستخدم المزج صوت «وووش» (whoosh) من إنتاج المشروع نفسه عند كل قطع، وصوت «بوب» (pop) من Kenney في الملكية العامة (CC0) حين تظهر تسمية، ولا تحتاج إلى ترخيص منك.',
                            { warn: 'إن لم تكن متأكدًا من الترخيص فاختر **المؤثرات الصوتية فقط**.' },
                        ],
                        en: [
                            'The music library starts empty on purpose, because the licence of a track is yours to state. Add only tracks you have the right to use on every platform you post to. You find it in **Studio** → **Explainers** → **Look and settings** → **Music library**.',
                            'Each track has a title, an artist, a licence, a credit line and the option **The licence requires credit**. Switch it on and the credit line is added to every caption automatically; a track that requires credit can’t be saved without one.',
                            { dl: [
                                ['Pixabay Music', 'No attribution needed, but avoid tracks marked with the Content ID shield icon.'],
                                ['incompetech (Kevin MacLeod)', 'CC BY 4.0: credit is required, so switch the option on and paste the credit line.'],
                                ['Free Music Archive', 'Use CC BY or CC0 only, and never anything marked NC, ND or SA.'],
                                ['YouTube Audio Library', 'For YouTube only, so it does not suit Facebook, Instagram or TikTok.'],
                            ] },
                            '**Sound effects only** uses the project’s own whoosh at each cut and a public-domain (CC0) pop from Kenney when a label appears, and needs no licence from you.',
                            { warn: 'If you are not sure of a licence, choose **Sound effects only**.' },
                        ],
                    },
                },
                {
                    id: 'troubleshooting',
                    title: { ar: 'حين تتوقف خطوة', en: 'When something stops' },
                    body: {
                        ar: [
                            { qa: [
                                ['تقول الصفحة «بانتظار جهازك الماك»', ['الماك غير متصل أو عامل الاستوديو لا يعمل عليه. تتابع الخطوة وحدها حين يعود، ولا يضيع شيء. اقرأ [[worker]] لتشغيله.']],
                                ['Claude على جهازي الماك مسجَّل الخروج', [
                                    'افتح Terminal على الماك، وشغّل Claude Code، واكتب:',
                                    { code: '/login', caption: 'وسجّل الدخول' },
                                    'وإن كان خيار «إن تعذّرت الكتابة على جهازي الماك فليكتب Gemini» مفعّلًا (وهو الافتراضي) كتب Gemini النص بعد 10 دقائق بلا التقاط للمهمة أو عند خطأ تسجيل الدخول، ويظهر على المسودة «كتبه Gemini». وإن كان موقوفًا بقي الشرح بانتظار الماك.',
                                ]],
                                ['بلغ مزوّد الصوت حدّه اليومي', ['لنسخة Gemini المجانية حدّ يومي غير معلن. تظهر «بلغ مزوّد الصوت حدّه اليومي المجاني». اضغط **أعد المحاولة** غدًا. ولا يُستخدم مزوّد مدفوع.']],
                                ['الرسم متوقف عند «بانتظار حصة الغد»', ['نفدت الحصة المجانية أو بلغت الحد اليومي. يبقى ما رُسم ويتابع الرسم وحده بعد التجدد: [[explainers#allowance]]. ولا شيء عليك فعله.']],
                                ['رُفضت صورة أو وصف', ['يذكر وصف الصورة أو وصف الشخصية امرأة أو فتاة، ولا يُرسل شيء إلى مزوّد الصور حينها. عدّل الوصف في خطوة النص أو في إعدادات الشخصيات، ثم **أعد الرسم**.']],
                                ['ظهرت «راجع التوقيت»', ['تعذّرت مطابقة بعض الكلمات مع التسجيل، فاعتمدت قطعاتها على عدد الكلمات. استمع إلى التسجيل، وعدّل المشهد الذي جاء قطعه مبكرًا أو متأخرًا، ثم **سجّل الصوت من جديد**.']],
                                ['توقف التجهيز وطلب مقطعًا آخر', ['حُذف مقطع الموسيقى الذي اخترته من المكتبة. اختر مقطعًا آخر أو **المؤثرات الصوتية فقط** تحت المشغّلين، ثم **أعد المحاولة**.']],
                                ['تقول الصفحة إن الشروحات متوقفة في هذه المساحة', ['يشغّلها مسؤول المنصة من **الإعدادات** ← **المنصة** ← **الشروحات المصوّرة**. ولا تُشغَّل في هذا الإصدار إلا لمساحة مالك المنصة.']],
                                ['النص بلا مصادر كافية', ['أضف روابط المصادر في صندوق «روابط المصادر» أو في مصادر النص، ثم **أعد الكتابة بملاحظة**.']],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['The page says “Waiting for your Mac”', ['The Mac is offline or the Studio worker isn’t running on it. The step carries on by itself when it is back, and nothing is lost. Read [[worker]] to start it.']],
                                ['Claude on my Mac is signed out', [
                                    'Open Terminal on the Mac, start Claude Code and type:',
                                    { code: '/login', caption: 'and sign in' },
                                    'If the switch “If my Mac can’t write, let Gemini write it” is on (the default), Gemini writes the script after 10 minutes with the job unclaimed, or on a sign-in error, and the draft says “Written by Gemini”. With it off, the explainer waits for the Mac.',
                                ]],
                                ['The voice provider’s daily limit is reached', ['Gemini’s free tier has a daily limit that is not published. The page says “The voice provider’s free daily limit is reached”. Press **Try again** tomorrow. No paid provider is ever used.']],
                                ['Drawing is stopped at “Waiting for tomorrow’s allowance”', ['The free allowance or the daily cap is used up. What was drawn is kept, and drawing carries on by itself after the renewal: [[explainers#allowance]]. There is nothing for you to do.']],
                                ['A picture or a description was refused', ['The picture brief or the character description names a woman or a girl, and nothing is sent to the image provider then. Edit the description in the script step or in the characters settings, then **Redraw**.']],
                                ['“Check the timing” appeared', ['Some words could not be matched to the audio, so their cuts follow word counts. Listen through, edit the scene whose cut is early or late, then **Voice it again**.']],
                                ['The render stopped and asked for another track', ['The music track you chose was removed from the library. Choose another track, or **Sound effects only**, under the players, then **Try again**.']],
                                ['The page says Explainers are switched off for this workspace', ['The platform administrator switches them on, in **Settings** → **Platform** → **Explainers**. In this version they can only be on for the platform owner’s workspace.']],
                                ['The script has too few sources', ['Add source links in “Source links”, or in the script’s sources, then **Rewrite with a note**.']],
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 11a-4. Your brand on every post ─────────────────────────────────
        {
            slug: 'brand',
            group: 'studio',
            icon: 'award',
            title: { ar: 'هويتك على كل منشور', en: 'Your brand on every post' },
            summary: {
                ar: 'شعار واحد على الكاروسيل والإنفوجرافيك والشروح المصوّرة ونهاية الريل، وأين يظهر، ومتى تُضاف خلفية صغيرة خلفه، ومفتاح ألوان هويتك، ومن يملك تعديله.',
                en: 'One logo on carousels, infographics, explainers and the end of each reel: where it sits, when a small plate is added behind it, the brand colours switch, and who can change it.',
            },
            related: ['studio-settings', 'infographics', 'explainers', 'monteur', 'worker'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'ما الذي تفعله صفحة هويتك؟', en: 'What the Brand page does' },
                    body: {
                        ar: [
                            'تضع صفحة هويتك شعارًا واحدًا على ما يصنعه الاستوديو: الكاروسيل، والإنفوجرافيك، والشروح المصوّرة، ونهاية كل ريل، وعلى أغلفة هذه المنشورات.',
                            'لا يتغير شيء في منشوراتك حتى تضيف شعارًا. وغلاف الريل بلا شعار دائمًا: يظهر الشعار في بطاقة النهاية فقط.',
                            { note: 'المنشورات الجاهزة تحتفظ بما صُنعت به. أما ما يُصنع بعد الحفظ فيحمل الشعار الجديد.' },
                        ],
                        en: [
                            'The Brand page puts one logo on what the Studio makes: carousels, infographics, explainers and the end of each reel, plus the covers that come with them.',
                            'Nothing changes on your posts until you add a logo. The cover of a reel never has one: the logo appears only on its end card.',
                            { note: 'Posts that are already made keep what they were made with. What is made after you save carries the new logo.' },
                        ],
                    },
                },
                {
                    id: 'logo',
                    title: { ar: 'إضافة الشعار', en: 'Adding your logo' },
                    body: {
                        ar: [
                            'اضغط **اختر شعارًا** واختر ملف SVG أو PNG أو JPEG أو WebP. يُجهَّز الملف في متصفحك: يُقصّ الهامش الفارغ، ويتحول إلى PNG، ويجب ألا يقل ضلعه الأقصر عن 200 بكسل ولا تزيد نسبة طوله إلى عرضه على 8 إلى 1.',
                            { ul: [
                                'إن كان الشعار على خلفية سادة فاضغط **أزل الخلفية**، وحرّك شريط مدى المطابقة حتى تختفي الخلفية ويبقى الشعار.',
                                'إن كان الشعار شفافًا وتريده أبيض فاضغط **اجعله أبيض**.',
                                'عند الرضا اضغط **احفظ الشعار**. قبل ذلك لا يُحفظ شيء، والتراجع متاح.',
                            ] },
                            { tip: 'أفضل ملف هو PNG بخلفية شفافة.' },
                            'لحذف الشعار اضغط **أزل الشعار**: تُصنع المنشورات الجديدة دونه.',
                        ],
                        en: [
                            'Press **Choose a logo** and pick an SVG, PNG, JPEG or WebP file. It is prepared in your browser: the empty margin is trimmed, it becomes a PNG, its short side must be at least 200 px, and it can be no more than 8 to 1.',
                            { ul: [
                                'If the logo sits on a plain background, press **Remove the background** and move the slider until the background goes and the logo stays.',
                                'If the logo is transparent and you want it white, press **Make it white**.',
                                'When you are happy, press **Save logo**. Nothing is saved before that, and Undo is there.',
                            ] },
                            { tip: 'A PNG with a transparent background works best.' },
                            'To take it away, press **Remove logo**: new posts are made without it.',
                        ],
                    },
                },
                {
                    id: 'where',
                    title: { ar: 'أين يظهر الشعار', en: 'Where the logo goes' },
                    body: {
                        ar: [
                            'تُظهر المعاينة في الصفحة موضعه على كل نوع. الزاوية الأولى تتبع لغة المنشور: اليمين بالعربية واليسار بالإنجليزية. والشعار نفسه لا يُقلب ولا يُمطّ ولا تتغير ألوانه أبدًا.',
                            { dl: [
                                ['الكاروسيل', 'في صف الرأس على كل شريحة، وأكبر قليلًا في شريحة الدعوة الأخيرة.'],
                                ['الإنفوجرافيك', 'في الذيل عند بدايته، قبل الصورة الشخصية.'],
                                ['الشرح المصوّر العمودي', 'في الذيل، في الوسط، مكان الخط القصير.'],
                                ['الشرح المصوّر 16:9', 'في الزاوية العليا من جهة البداية.'],
                                ['الريل', 'في بطاقة النهاية فقط، في أعلى الوسط.'],
                            ] },
                        ],
                        en: [
                            'The preview on the page shows where it lands on each kind. The first corner follows the language of the post: right in Arabic and left in English. The logo itself is never flipped, stretched or recoloured.',
                            { dl: [
                                ['Carousel', 'In the header row of every slide, a little larger on the last call-to-action slide.'],
                                ['Infographic', 'In the footer at its start, before the portrait.'],
                                ['Vertical explainer', 'In the footer, centred, in place of the short bar.'],
                                ['16:9 explainer', 'In the top corner at the start.'],
                                ['Reel', 'On the end card only, at the top centre.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'plate',
                    title: { ar: 'الخلفية الصغيرة خلف الشعار', en: 'The small plate behind it' },
                    body: {
                        ar: [
                            'قد تظهر خلف الشعار خلفية صغيرة مستديرة الزوايا ليبقى واضحًا. تُضاف إذا كان الشعار شفافًا وكان تباين لونه الرئيسي مع الصفحة أقل من 3 إلى 1، وتُضاف دائمًا فوق الصورة أو الفيديو.',
                            'لونها أبيض لشعار داكن، وداكن لشعار فاتح. والشعار المصمت الخلفية يحمل خلفيته معه، فلا تُضاف له خلفية.',
                            'تُظهر المعاينة هذه الخلفية حيث ستظهر.',
                        ],
                        en: [
                            'A small plate with rounded corners can appear behind the logo so it stays visible. It is added when the logo is transparent and its main colour has less than 3 to 1 contrast against the page, and always over a picture or a video.',
                            'It is white for a dark logo and dark for a light one. A logo with a solid background carries its own, so it gets no plate.',
                            'The preview shows the plate where it will appear.',
                        ],
                    },
                },
                {
                    id: 'colours',
                    title: { ar: 'ألوان هويتك', en: 'Brand colours' },
                    body: {
                        ar: [
                            'المفتاح **استخدم ألوان هويتك في الكاروسيل والريلز وعناوين الشروحات** يغيّر ثلاثة أشياء: تُلوَّن صفحات الكاروسيل بلونك الأساسي، ويأخذ كل كاروسيل وريل جديد لونك المميِّز، وتأخذ عناوين الشروحات لونك المميِّز أيضًا.',
                            'ما صُنع من قبل يحتفظ بلونه. والإنفوجرافيك يستخدم ألوانك أصلًا، فلا يتغير بالمفتاح.',
                            'يُضبط لونك الأساسي ولونك المميِّز من صفحة الإنفوجرافيك: [[infographics]].',
                        ],
                        en: [
                            'The switch **Use my brand colours on carousels, reels and explainer titles** changes three things: carousel pages are tinted with your main colour, new carousels and reels take your accent, and explainer titles take it too.',
                            'What was made before keeps its colour. Infographics already use your colours, so the switch does not change them.',
                            'Your main colour and accent are set on the Infographics page: [[infographics]].',
                        ],
                    },
                },
                {
                    id: 'who',
                    title: { ar: 'من يستطيع التعديل', en: 'Who can change it' },
                    body: {
                        ar: [
                            'يستطيع صاحب مساحة العمل وحده تعديل الشعار والمفتاح. المشغّل يرى الصفحة دون أن يستطيع التعديل، ومن دوره «مُطّلع» لا يجد الصفحة في القائمة.',
                        ],
                        en: [
                            'Only the workspace owner can change the logo and the switch. An operator sees the page and cannot change it, and someone with the Viewer role does not find it in the menu.',
                        ],
                    },
                },
                {
                    id: 'troubleshooting',
                    title: { ar: 'إن لم يظهر الشعار', en: 'If the logo does not show' },
                    body: {
                        ar: [
                            { qa: [
                                ['لم يظهر الشعار على ما صُنع بعد الحفظ', 'برنامج العامل على الماك هو الذي يرسم الشعار، وقد يكون قديمًا. حدّثه وأعد تشغيله ثم اصنع المنشور من جديد: [[worker]].'],
                                ['رُفض الملف بأنه ليس PNG أو لم يُعثر عليه', 'اختر الملف مرة أخرى ثم احفظ.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['No logo on something made after you saved it', 'The worker program on the Mac draws the logo, and it may be out of date. Update it, restart it and make the post again: [[worker]].'],
                                ['The file was refused as not a PNG, or as not found', 'Choose the file again, then save.'],
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 11b. Where files are kept (Supabase, Cloudflare R2) ───────────────
        {
            slug: 'media-storage',
            group: 'more',
            icon: 'cloud',
            title: { ar: 'أين تُحفظ الملفات: Supabase وCloudflare R2', en: 'Where files are kept: Supabase and Cloudflare R2' },
            summary: {
                ar: 'أين تذهب الصور والفيديوهات التي ترفعها، وكيف تفعّل Cloudflare R2 (تنزيله مجاني)، وكيف تنسخ ملفاتك القديمة إليه، ولماذا لا يتجاوز التطبيق باقته المجانية أبداً.',
                en: 'Where the pictures and videos you upload go, how to switch on Cloudflare R2 (free downloads), how to copy your existing files to it, and why the app never goes over its free tier.',
            },
            related: ['scheduling', 'troubleshooting', 'faq'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'ما هو R2 ولماذا أضفناه', en: 'What R2 is, and why it was added' },
                    body: {
                        ar: [
                            'كل صورة أو فيديو ترفعه تُحفظ في مكان تخزين، ويبقى رابطه دائماً من عنوان التطبيق نفسه (`/api/uploads/…`): هذا العنوان الذي تسحب منه ميتا وتيك توك ملفاتك، ولا يتغير مهما كان مكان التخزين.',
                            'المكان الأول **Supabase Storage**. لكن باقة Supabase المجانية لها حد على كمية التنزيل، وإذا انتهى يرفض Supabase كل قراءة، فتتوقف الملفات عن الظهور. لهذا أضفنا **Cloudflare R2**: يخزّن الملفات بنفس الطريقة، وتنزيله مجاني، وباقته المجانية 10 جيجابايت.',
                            { note: 'أنت تختار مكان الملفات الجديدة فقط. كل ملف مرفوع من قبل يبقى يُقدَّم من مكانه، ولا ينكسر أي رابط.' },
                        ],
                        en: [
                            'Every picture or video you upload is kept in a storage place, and its link is always on the app’s own address (`/api/uploads/…`): the address Meta and TikTok pull your files from. It never changes, wherever the file is kept.',
                            'The first place is **Supabase Storage**. But Supabase’s free plan limits how much can be downloaded, and when that runs out Supabase refuses every read, so files stop showing. That is why **Cloudflare R2** was added: it stores files the same way, downloads are free, and its free tier is 10 GB.',
                            { note: 'You choose where new files go. Every file already uploaded keeps being served from where it is, and no link breaks.' },
                        ],
                    },
                },
                {
                    id: 'setup',
                    title: { ar: 'كيف تفعّل R2', en: 'How to switch R2 on' },
                    body: {
                        ar: [
                            { ol: [
                                'في Cloudflare افتح R2 ثم Create bucket، وسمّه مثلاً `media`. أنشئه أنت: التطبيق لا ينشئ حاويات.',
                                'من صفحة R2 الرئيسية انسخ Account ID.',
                                'افتح Manage API tokens ثم Create API token، واختر الصلاحية Object Read & Write لهذه الحاوية وحدها. انسخ Access Key ID وSecret Access Key في الحال: Cloudflare يعرض المفتاح السري مرة واحدة.',
                                'في أوتوريبلاي برو افتح **الإعدادات** ← **المنصة** ← **تخزين الوسائط**، وفي قسم **Cloudflare R2** الصق الأربع قيم واضغط **احفظ وتحقق**. لا يُحفظ شيء إلا بعد أن يقبله Cloudflare.',
                                'اختر **Cloudflare R2** تحت **أين تذهب الملفات الجديدة**.',
                            ] },
                            { warn: 'إذا قال التحقق «Create the bucket … in Cloudflare first» فالحاوية غير موجودة أو اسمها خاطئ. أنشئها في Cloudflare ثم احفظ من جديد.' },
                            { h: 'سياسة CORS (لرفع وسائط الإعلانات من المتصفح فقط)' },
                            'تُرفع وسائط الإعلانات من متصفحك مباشرة إلى R2، فيجب أن تسمح الحاوية بعنوان التطبيق. يحاول التطبيق ضبط ذلك بنفسه، لكن مفتاح Object Read & Write لا يستطيع. إذا ظهرت لك رسالة بهذا المعنى تحت القسم، افتح في Cloudflare: R2 ← حاويتك ← Settings ← CORS Policy، والصق السياسة الظاهرة في البطاقة (فيها زر نسخ). أما رفع الملفات من الخادم ومن العامل في جهازك فلا يحتاجها.',
                        ],
                        en: [
                            { ol: [
                                'In Cloudflare, open R2 and choose Create bucket, and name it, for example, `media`. You create it: the app never creates buckets.',
                                'Copy the Account ID from the R2 overview page.',
                                'Open Manage API tokens and Create API token, and give it Object Read & Write for this bucket only. Copy the Access Key ID and the Secret Access Key right away: Cloudflare shows the secret once.',
                                'In AutoReply Pro open Settings → **Platform** → **Media storage**, and in the **Cloudflare R2** section paste the four values and press **Save and check**. Nothing is saved until Cloudflare accepts it.',
                                'Choose **Cloudflare R2** under **Where new uploads go**.',
                            ] },
                            { warn: 'If the check says “Create the bucket … in Cloudflare first”, the bucket doesn’t exist or its name is wrong. Create it in Cloudflare and save again.' },
                            { h: 'The CORS policy (browser uploads of ad media only)' },
                            'Ad media is uploaded from your browser straight to R2, so the bucket has to allow the app’s address. The app tries to set that itself, but an Object Read & Write token can’t. If a message under the section says so, open R2 → your bucket → Settings → CORS Policy in Cloudflare and paste the policy shown on the card (it has a copy button). Uploads from the server and from the worker on your computer don’t need it.',
                        ],
                    },
                },
                {
                    id: 'copy',
                    title: { ar: 'انسخ ملفاتك القديمة إلى R2', en: 'Copy your existing files to R2' },
                    body: {
                        ar: [
                            'زر **انسخ الملفات الموجودة إلى R2** يطلب من التطبيق أن ينقل ملفات Supabase إلى R2 في الخلفية، بضعة ملفات كل دقيقة. كل ملف يُنسخ ويُتحقق من حجمه ثم يتحول رابطه إلى R2، وتبقى نسخة Supabase كما هي.',
                            { ul: [
                                'البطاقة تعرض «N من M ملف في R2» وآخر سبب أوقف النسخ.',
                                'إذا رفض Supabase تسليم الملفات (مثلاً لأن حد التنزيل انتهى) ينتظر النسخ ويعيد المحاولة وحده، ولا يتغير شيء.',
                                'يتوقف النسخ وحده قبل أن يتجاوز باقة R2 المجانية.',
                            ] },
                        ],
                        en: [
                            'The **Copy existing files to R2** button asks the app to move the Supabase files to R2 in the background, a few every minute. Each file is copied, its size is checked, and then its link switches to R2, while the Supabase copy stays as it is.',
                            { ul: [
                                'The card shows “N of M files are in R2” and the last reason the copy stopped.',
                                'If Supabase refuses to hand the files over (for example because its download limit ran out), the copy waits and tries again by itself, and nothing changes.',
                                'It stops by itself before it would pass R2’s free tier.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'direct',
                    title: { ar: 'التنزيل مباشرة من R2', en: 'Downloads straight from R2' },
                    body: {
                        ar: [
                            'رابط كل ملف يبقى عنوان التطبيق نفسه. لكن الملف الذي يمر عبر التطبيق يُحسب من حصة Vercel المجانية للنقل (10 جيجابايت في الشهر)، وإذا انتهت يوقف Vercel المشروع. لذلك يرسل التطبيق من يطلب ملفًا في R2 إلى رابط مؤقت من Cloudflare، صالح بضع ساعات، فيُنزَّل الملف من R2 مجانًا.',
                            'اختر في **الإعدادات** ← **المنصة** ← **تخزين الوسائط**، تحت **من يُنزِّل ملفات R2 مباشرة من Cloudflare**:',
                            { ul: [
                                '**هذه اللوحة والمتصفحات الأخرى وعامل الماك** (الافتراضي): معاينات الفيديو وما ينزّله العامل.',
                                '**الجميع**: ومعهم Meta ويوتيوب حين يجلبون فيديو المنشور، وهو أكبر توفير.',
                                '**لا أحد**: كل ملف يمر عبر التطبيق كما كان.',
                            ] },
                            'تيك توك يأخذ الملف دائمًا من عنوان التطبيق، لأنه لا يقبل إلا العنوان الموثَّق في بوابته. وملفات Supabase القديمة تمر عبر التطبيق كما كانت.',
                        ],
                        en: [
                            'Every file’s link stays the app’s own address. But a file that passes through the app counts toward Vercel’s free transfer allowance (10 GB a month), and when it runs out Vercel pauses the project. So the app sends whoever asks for a file in R2 to a temporary Cloudflare link, valid a few hours, and the file downloads from R2 for free.',
                            'Choose under Settings → **Platform** → **Media storage**, in **Who downloads R2 files straight from Cloudflare**:',
                            { ul: [
                                '**This dashboard, other browsers and the Mac worker** (the default): video previews and what the worker downloads.',
                                '**Everyone**: Meta and YouTube too, when they fetch a post’s video. This saves the most.',
                                '**Nobody**: every file passes through the app, as before.',
                            ] },
                            'TikTok always gets the file from the app’s address, because it accepts only the address verified in its portal. Old Supabase files still pass through the app.',
                        ],
                    },
                },
                {
                    id: 'limits',
                    title: { ar: 'الباقة المجانية وحدودك', en: 'The free tier and your limits' },
                    body: {
                        ar: [
                            'باقة R2 المجانية كل شهر: 10 جيجابايت تخزين، ومليون عملية كتابة (Class A: الرفع والقوائم)، و10 ملايين عملية قراءة (Class B: عرض ملف أو فحصه). التنزيل نفسه مجاني.',
                            'التطبيق لا يتجاوز هذه الباقة أبداً: يعدّ كل طلب يرسله إلى R2 قبل إرساله، ويحتفظ بهامش (9 جيجابايت، و900 ألف كتابة، و9 ملايين قراءة). يمكنك خفض هذه الحدود من البطاقة، لكن لا ترفعها فوق باقة Cloudflare.',
                            { dl: [
                                ['عند 80%', 'تصلك رسالة بريد مرة في اليوم لكل حد، ويظهر تنبيه في **اليوم** وفي بطاقة تخزين الوسائط.'],
                                ['عند 100% من التخزين', 'يُرفض أي رفع جديد إلى R2 برسالة واضحة. حوّل الملفات الجديدة إلى Supabase أو احذف ملفات.'],
                                ['عند 100% من الكتابة أو القراءة', 'يُرفض الرفع، وتتوقف ملفات R2 عن الظهور (الرد 503) حتى يتجدد العدّاد تلقائياً في أول الشهر بتوقيت UTC. ملفات Supabase لا تتأثر.'],
                            ] },
                            { note: 'العدّاد يحسب ما يرسله هذا التطبيق فقط. لوحة Cloudflare نفسها لها الكلمة الأخيرة، فراجعها إن استخدمت الحاوية من أداة أخرى.' },
                        ],
                        en: [
                            'R2’s free tier each month is 10 GB of storage, 1 million write operations (Class A: uploads and listings) and 10 million read operations (Class B: showing or checking a file). The download itself is free.',
                            'The app never goes over this tier: it counts every request it sends to R2 before sending it, and keeps a margin (9 GB, 900,000 writes and 9 million reads). You can lower those limits on the card, but not raise them above Cloudflare’s tier.',
                            { dl: [
                                ['At 80%', 'You get one email a day per limit, and a notice appears on **Today** and on the Media storage card.'],
                                ['At 100% of storage', 'Any new upload to R2 is refused with a clear message. Switch new files to Supabase, or delete files.'],
                                ['At 100% of writes or reads', 'Uploads are refused and R2 files stop showing (the answer is 503) until the count starts again, by itself, on the 1st of the month (UTC). Supabase files are not affected.'],
                            ] },
                            { note: 'The count covers what this app sends. Cloudflare’s own dashboard has the final word, so check it if you use the bucket from another tool.' },
                        ],
                    },
                },
                {
                    id: 'problems',
                    title: { ar: 'إذا ظهرت مشكلة', en: 'If something goes wrong' },
                    body: {
                        ar: [
                            { qa: [
                                ['«Cloudflare R2 refused … AccessDenied» عند الحفظ', 'المفتاح لا يملك صلاحية هذه الحاوية. أنشئ مفتاحاً بصلاحية Object Read & Write على الحاوية نفسها.'],
                                ['«SignatureDoesNotMatch»', 'المفتاح السري أو معرّف الحساب فيه خطأ. انسخهما من جديد (المفتاح السري يظهر مرة واحدة، فأنشئ مفتاحاً جديداً إن ضاع).'],
                                ['رسالة «free allowance is used up» (R2_LIMIT) عند الرفع', 'بلغتَ أحد حدود R2. راجع البطاقة لتعرف أيها، ثم حوّل الملفات الجديدة إلى Supabase أو انتظر أول الشهر.'],
                                ['صور R2 لا تظهر (503)', 'غالباً انتهت قراءات الشهر. تتجدد وحدها في أول الشهر UTC، ويمكنك التأكد من البطاقة.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['“Cloudflare R2 refused … AccessDenied” when saving', 'The key has no access to this bucket. Create a key with Object Read & Write on that bucket.'],
                                ['“SignatureDoesNotMatch”', 'The Secret Access Key or the Account ID has a typo. Copy them again (the secret is shown once, so make a new key if it is lost).'],
                                ['“free allowance is used up” (R2_LIMIT) on an upload', 'You reached one of R2’s limits. The card shows which one: switch new files to Supabase, or wait for the 1st of the month.'],
                                ['R2 pictures don’t show (503)', 'This month’s reads are probably used up. They start again by themselves on the 1st (UTC), and the card confirms it.'],
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 12. AI usage and costs ──────────────────────────────────────────
        {
            slug: 'ai-usage',
            group: 'more',
            icon: 'bot',
            title: { ar: 'استخدام الذكاء الاصطناعي وتكلفته', en: 'AI usage and costs' },
            summary: {
                ar: 'أين يستخدم أوتوريبلاي برو Gemini، وحدود الاستخدام، ولماذا يفرق تفعيل الفوترة، وكم يكلّف Muse من Meta، وكيف تشاهد ذاكرة الفيديو في ريلزك.',
                en: 'Where AutoReply Pro uses Gemini, the usage limits, why turning on billing matters, what Meta’s Muse models cost, and how the video memory watches your reels.',
            },
            related: ['dm-assistant', 'troubleshooting', 'worker', 'create'],
            sections: [
                {
                    id: 'where',
                    title: { ar: 'أين يُستخدم الذكاء الاصطناعي؟', en: 'Where AI is used' },
                    body: {
                        ar: [
                            'الذكاء الاصطناعي الأساسي في المنتج هو **Gemini** من Google، في ثلاثة أماكن:',
                            { dl: [
                                ['ردود الرسائل', 'يردّ المساعد على الرسائل الخاصة بالنموذج الذي تختاره في **مساعد الرسائل** ← **النموذج**.'],
                                ['كتابة الكاروسيل', '**أنشئ الكاروسيل** و**أعد الكتابة بالذكاء الاصطناعي** و**اكتبه من جديد** و**خطّط أسبوعي**، وكلها على الخادم.'],
                                ['فهرسة الدروس', 'على العامل في جهازك، بمفتاح Gemini الموجود في ملف إعداداته.'],
                            ] },
                            { note: 'توجد استثناءات. ردود الرسائل يمكنك كتابتها بمزوّد آخر من **محرّك الردّ**: [[dm-assistant#engine]]. والريلز والإنفوجرافيك ليسا دائماً من Gemini: بحسب مساحتك يكتبهما Claude على الماك، أو مزوّد أعدّه مسؤول المنصة: [[monteur#settings]] و[[infographics#who]]. وحدود Gemini وفوترته في هذه الصفحة تخص ما يكتبه Gemini فقط.' },
                        ],
                        en: [
                            'The product’s main AI is Google’s **Gemini**, used in three places:',
                            { dl: [
                                ['DM replies', 'The AI assistant answers DMs with the model you choose in **DM assistant** → **Model**.'],
                                ['Writing carousels', '**Generate carousel**, **Rewrite with AI**, **Write it again** and **Plan my week**, all on the server.'],
                                ['Indexing lessons', 'On the worker on your computer, with the Gemini key in its config file.'],
                            ] },
                            { note: 'There are exceptions. DM replies can be written by another provider, through **Reply engine**: [[dm-assistant#engine]]. And the Monteur and infographics are not always Gemini: depending on your workspace they are written by Claude on the Mac, or by a provider the platform administrator set up: [[monteur#settings]] and [[infographics#who]]. The Gemini limits and billing on this page apply to what Gemini writes.' },
                        ],
                    },
                },
                {
                    id: 'separate',
                    title: { ar: 'الكاروسيل لا يستهلك من حصة الرسائل', en: 'Carousels don’t eat into your DM quota' },
                    body: {
                        ar: [
                            'يستخدم الاستوديو نماذج غير نموذج الرسائل عن قصد، كي لا تستهلك كتابة كاروسيل الحصة التي يعتمد عليها ردّ على عميل. ولو انتهت حصة نموذج جرّب الاستوديو النموذج التالي من تلقاء نفسه.',
                        ],
                        en: [
                            'The Studio deliberately uses different models from the DM assistant, so a carousel you write never spends the quota a customer’s reply depends on. When one model’s quota runs out, it moves on to the next by itself.',
                        ],
                    },
                },
                {
                    id: 'quotas',
                    title: { ar: 'حدود Gemini', en: 'Gemini limits' },
                    body: {
                        ar: [
                            { ul: [
                                'Google يحدد لكل مفتاح عدد طلبات في الدقيقة وفي اليوم، لكل نموذج على حدة.',
                                '**المفتاح المجاني حدوده ضيقة:** بعض النماذج تسمح بحوالي 20 طلباً في اليوم فقط. والكاروسيل الواحد قد يأخذ أكثر من طلب: الكتابة، ثم حتى جولتي تصحيح إن احتاج.',
                                'عندما تنتهي الحصة يردّ Google بالخطأ 429: ترى في الاستوديو رسالة فيها `HTTP 429`، أو يتوقف المساعد عن الرد على الرسائل.',
                                'تتجدد الحصة اليومية عند منتصف الليل بتوقيت المحيط الهادئ، أي قرابة 10 أو 11 صباحاً بتوقيت الرياض.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'Google limits each key to a number of requests per minute and per day, for each model separately.',
                                '**A free key has tight limits:** some models allow only about 20 requests a day. One carousel can take more than one request: the writing, plus up to two repair rounds when needed.',
                                'When the quota runs out, Google answers with error 429: the Studio shows a message containing `HTTP 429`, or the assistant stops answering DMs.',
                                'Daily quotas reset at midnight Pacific time, which is around 10 or 11 in the morning in Riyadh.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'billing',
                    title: { ar: 'لماذا الفوترة مهمة؟', en: 'Why billing matters' },
                    body: {
                        ar: [
                            { ul: [
                                'فعّل الفوترة (Billing) على مشروع Google Cloud الذي فيه المفتاح، فترتفع الحدود كثيراً، ولا تتوقف الردود ولا الكاروسيل في منتصف اليوم.',
                                '**الخصوصية:** حسب شروط Gemini API، قد يستخدم Google المحتوى الذي يمر عبر الخطة المجانية لتحسين منتجاته، أما الخطة المدفوعة فلا. وهذا يشمل رسائل عملائك ولقطات دروسك.',
                                'التكلفة بحسب الاستخدام: لكل كاروسيل عدة طلبات، ولكل درس فهرسة واحدة. الأرقام الحقيقية تجدها في صفحة الاستخدام في Google AI Studio.',
                                'ضع تنبيه ميزانية (Budget alert) في Google Cloud كي لا تُفاجأ بالفاتورة.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'Turn on billing for the Google Cloud project behind the key and the limits rise a long way, so replies and carousels don’t stop halfway through the day.',
                                '**Privacy:** under the Gemini API terms, content sent through the free tier may be used by Google to improve its products; on the paid tier it isn’t. That includes your customers’ messages and your lesson previews.',
                                'You pay for what you use: each carousel is a few requests, and each lesson is indexed once. Your real numbers are on the usage page in Google AI Studio.',
                                'Set a budget alert in Google Cloud so the bill never surprises you.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'meta-muse',
                    title: { ar: 'نماذج Meta (Muse)', en: 'Meta (Muse)' },
                    body: {
                        ar: [
                            'نماذج Muse من Meta مزوّد إضافي يستطيع مسؤول المنصة إضافته من **التشغيل** ← **مزوّدو الذكاء الاصطناعي**. يستقبل نموذج Muse Spark النص والصور والفيديو والصوت ويجيب نصاً، ولهذا توجد مهام في جدول المسارات لا يجيب عنها غيره: قراءة الصور والفيديو التي تصل في الرسائل، وإيجاد الريل المناسب، وقراءة الريلز، وقراءة التعليقات. ولا يُرسل شيء إلى Meta قبل أن يُحفظ مفتاحها.',
                            { dl: [
                                ['المفتاح', 'يأتي من منصة المطوّرين عند Meta الخاصة بواجهة النماذج (dev.meta.ai). الصقه في **مفتاح جديد** واضغط **افحص واحفظ**: قبل الحفظ تُسأل Meta عن قائمة نماذجها، والمفتاح الذي ترفضه لا يُحفظ. يُخزَّن مشفّراً ولا يظهر مرة أخرى.'],
                                ['النماذج', 'النماذج القياسية فقط. `muse-spark-1.3` هو الافتراضي والنسخة التي توصي بها Meta للعمل الجديد، و`muse-spark-1.2` النسخة السابقة. **حمّل النماذج** يعرض النماذج القياسية ويترك باقي كتالوج Meta. وتبيع Meta نسخة أرخص من Muse Spark مقابل حقها في التدريب على ما يُرسل إليها: لا تُستخدم هنا أبداً، وأي مسار أو نموذج افتراضي يسمّي واحدة منها يُرفض.'],
                                ['الخصوصية', 'حسب شروط Meta للنماذج القياسية، لا تدرّب Meta نماذجها على المحتوى المُرسل.'],
                                ['السعر', 'بحسب الاستخدام، لكل مليون رمز: 1.25 دولار للمُرسل، و4.25 دولار للراجع، و0.15 دولار للجزء المُرسل الذي يتكرر من طلب حديث. يفكّر Muse Spark دائماً قبل أن يجيب، ويُحسب هذا التفكير مع ما يرجع، فحتى الجواب بكلمة واحدة يكلّف مئات الرموز. والصورة نحو 800 رمز مُدخل والفيديو نحو 280 رمزاً في الثانية. وتحاسبك Meta على الحساب الذي يخصّه المفتاح، فحدّد ميزانية في البطاقة وحداً للصرف عند Meta.'],
                            ] },
                            { tip: 'جرّب أي مسار قبل أن تعتمد عليه: **جرّب** يرسل طلباً صغيراً جداً ويعرض النموذج والزمن والتكلفة.' },
                        ],
                        en: [
                            'Meta’s Muse models are one more provider the platform administrator can add in **Operations** → **AI providers**. Muse Spark takes text, pictures, video and audio in and answers in text, so a few jobs in the routing table can be answered only by Meta: reading the photos and videos people send in DMs, finding the right reel, reading reels, and reading comments. Nothing is sent to Meta until its key is saved.',
                            { dl: [
                                ['The key', 'It comes from Meta’s developer platform for its Model API (dev.meta.ai). Paste it in **New key** and press **Check and save**: before it is saved, Meta is asked to list its models, and a key Meta refuses is not saved. It is stored encrypted and never shown again.'],
                                ['The models', 'The Standard models only. `muse-spark-1.3` is the default and the version Meta recommends for new work; `muse-spark-1.2` is the previous one. **Load models** lists the Standard models and leaves out the rest of Meta’s catalogue. Meta also sells a cheaper copy of Muse Spark in exchange for the right to train on what is sent to it; it is never used here, and a route or a default model that names one is refused.'],
                                ['Privacy', 'Under Meta’s terms for the Standard models, what is sent is not used to train Meta’s models.'],
                                ['The price', 'Pay as you go, per million tokens: $1.25 for what is sent, $4.25 for what comes back, and $0.15 for the part of what is sent that repeats a recent request. Muse Spark always thinks before it answers, and that thinking is billed with what comes back, so even a one-word answer costs a few hundred tokens. A picture is about 800 tokens of input and a video about 280 a second. Meta bills the account the key belongs to, so keep a budget in the card and a spending limit in your Meta billing.'],
                            ] },
                            { tip: 'Try a route before you rely on it: **Test** sends one tiny call and shows the model, the time and the cost.' },
                        ],
                    },
                },
                {
                    id: 'meta-vision',
                    title: { ar: 'رؤية ميتا (تجريبية)', en: 'Meta vision (beta)' },
                    body: {
                        ar: [
                            '**رؤية ميتا** تجعل مساعد المبيعات يقرأ ما يرسله لك الناس على إنستجرام، بدل السطر الثابت الواحد الذي يأخذونه اليوم: صورة أو لقطة شاشة، أو ريل أو منشور مُشارَك، أو ردّ على قصتك، أو قصة يشيرون فيها إليك، أو رسالة صوتية. يرى نموذج Muse من ميتا الصورة أو الفيديو ويصفه، ويكتب نموذج الكلام من ميتا الرسالة الصوتية نصاً، ويردّ المساعد من عروضك، وتعرض **الرسائل** تحت الرسالة ما رآه أو سمعه، وتحت الرد ما قرّره ولماذا. هي تجريبية ومتوقفة حتى تشغّلها، من **مساعد الرسائل** ← **رؤية ميتا**.',
                            { dl: [
                                ['المفاتيح', 'كل مفتاح مستقل. **الردّ على الصور والريلز والإشارات في القصص** و**الرسائل الصوتية** و**ذاكرة الفيديو** كلها تعمل اليوم، وشرح ذاكرة الفيديو في [[ai-usage#video-memory]].'],
                                ['الرسائل الصوتية', 'يكتب نموذج الكلام من ميتا الرسالة الصوتية نصاً (عربي وإنجليزي)، ويردّ المساعد على الكلام مثل الرسالة المكتوبة: استرجاع أو شكوى تُقال بالصوت تُقرأ مثل المكتوبة. وتذهب أسماء عروضك وعلامتك مع الصوت كتلميحات، كي تُكتب كما تكتبها أنت. مدة الرسالة تصل إلى 3 دقائق. وإذا لم تُفهم منها كلمات يُطلب من الشخص أن يرسلها مرة أخرى، وإذا لم تُسمع أبداً (طويلة جداً، أو تالفة، أو الخدمة متوقفة) يأخذ السطر المعتاد، وتذكر **الرسائل** السبب. وتنطبق قائمة الأشخاص نفسها والحد اليومي نفسه، لكن المفتاح مستقل. وتكلّف 0.18 دولار لكل ساعة صوت: الدقيقة تقريباً ثلث سنت.'],
                                ['إذا سألوا قبل أن يرسلوا', 'إذا سأل أحدهم هل يستطيع إرسال رسالة صوتية أو صورة، يقول له المساعد نعم، لكن للأشخاص الذين يجيبهم فقط، ما دام المفتاح يعمل وفي الحد اليومي متسع. وبدون هذا تبقى الجملة القديمة «ما أقدر أفتحه هنا» في المحادثة التي بدأت قبل أن تشغّله، وكان المساعد يكررها.'],
                                ['من يُجاب عنهم', 'اختر **هؤلاء الأشخاص فقط** واضغط **أضف شخصاً**: تختار من محادثات إنستجرام الأخيرة بالاسم أو اسم المستخدم الذي تعرضه **الرسائل**، ويبقى أي شخص آخر على الردود المعتادة. واختر **الجميع** حين تطمئن، وبعدها يمكن أن يُقرأ ما يرسله كل من يراسل حسابك على إنستجرام.'],
                                ['الحد اليومي', '**الحد اليومي (بالدولار)** هو أقصى ما تصرفه في اليوم، من 0 إلى 50 (من منتصف الليل إلى منتصفه بتوقيت UTC). وتعرض البطاقة كم صُرف اليوم. إذا بلغ الحد توقفت الميزة حتى اليوم التالي، وتأخذ هذه الرسائل السطر الثابت المعتاد، ويصلك تنبيه مرة واحدة. والصفر يجعلها متوقفة.'],
                                ['ماذا يُحفظ', 'تُرسل الصورة أو الفيديو إلى نموذج Muse من ميتا ليقرأها، وتُرسل الرسالة الصوتية إلى نموذج الكلام من ميتا ليكتبها، ولا نحفظ الملف. الذي يبقى مع الرسالة وصف قصير، أو كلام الرسالة الصوتية، لتقرأه في **الرسائل** ويتذكره المساعد في المحادثة.'],
                                ['إنستجرام فقط', 'يقرأ رسائل إنستجرام. ماسنجر وواتساب لا تُقرأ، والرسالة التي لا يرسل إنستجرام رابط محتواها (صورة تُشاهد مرة واحدة) يأخذ صاحبها السطر المعتاد.'],
                                ['النماذج القياسية فقط', 'تُستخدم نماذج ميتا القياسية فقط، ولا تدرّب ميتا نماذجها على ما يُرسل إليها. وأي نموذج يمكن أن يُدرَّب على المُرسل يُرفض، أينما اختير.'],
                            ] },
                            { tip: 'ابدأ باختيار **هؤلاء الأشخاص فقط** وحساباتك التجريبية: أرسل من واحد منها ريل ولقطة شاشة، واقرأ **الرسائل**، وبعدها اختر **الجميع**. واضغط **احفظ رؤية ميتا** بعد أي تغيير: لها زرها الخاص، غير زر المساعد الذي فوقها.' },
                            'وإذا لم يستطع قراءة شيء بثقة فلا يخمّن: يأخذ الشخص السطر المعتاد، أو يُطلب منه أن يرسله مرة أخرى، وتقول **الرسائل** ما حدث بصراحة: غير مقروء، أو انتهى رابطه، أو كبير جداً، أو تُرك، ولماذا.',
                        ],
                        en: [
                            '**Meta vision** lets the sales assistant read what people send you on Instagram, instead of giving them the one fixed line they get today: a photo or screenshot, a shared reel or post, a reply to your story, a story that mentions you, or a voice note. Meta’s Muse model looks at a picture or video and describes it, Meta’s speech model writes a voice note down, the assistant answers from your offers, and the **Inbox** shows under the message what it saw or heard, and under the reply what it decided and why. It is in beta and off until you switch it on, in **DM assistant** → **Meta vision**.',
                            { dl: [
                                ['The switches', 'Each one is separate. **Answer photos, reels and story mentions**, **Voice notes** and **Video memory** all work today, and how **Video memory** works is in [[ai-usage#video-memory]].'],
                                ['Voice notes', 'Meta’s speech model writes a voice note down (Arabic and English), and the assistant answers the words like a message that was typed: a refund or a complaint said aloud is read like one written. The names of your offers and your brand go with the audio as hints, so they are spelled as you spell them. A note can run up to 3 minutes. When no words can be made out, the person is asked to send it again; when it cannot be heard at all (too long, damaged, or the service is down) they get the usual line, and the **Inbox** says why. The same people list and the same daily cap apply, but the switch is its own. It costs $0.18 per hour of audio: a minute is about a third of a cent.'],
                                ['When they ask first', 'If someone asks whether they can send a voice note or a photo, the assistant says yes, but only to the people it answers, and only while the switch is on and the daily cap has room. Without this, a chat that began before you switched it on still shows the old “I can’t open that here”, and the assistant would repeat it.'],
                                ['Who it answers', 'Choose **Only these people** and press **Add a person**: you pick from your recent Instagram conversations, by the name or username the **Inbox** shows, and anyone else keeps getting today’s replies. Choose **Everyone** when you are happy with it, and every person who messages your Instagram account can have what they send read.'],
                                ['The daily cap', '**Daily cap (USD)** is the most it may spend in a day, from 0 to 50 (UTC midnight to midnight). The card shows what was spent today. When the cap is reached it stops until the next day, those messages get the usual fixed line, and you are told once. 0 keeps it off.'],
                                ['What is kept', 'The photo or video is sent to Meta’s Muse model to be read, and a voice note to Meta’s speech model to be written down; we do not store the file. What stays with the message is a short description, or the words of a voice note, so you can read it in the **Inbox** and the assistant remembers it in the conversation.'],
                                ['Instagram only', 'It reads Instagram messages. Messenger and WhatsApp are not read, and a message Instagram sends with no link to its media (a view-once photo) gets today’s line.'],
                                ['Standard models only', 'Only Meta’s Standard models are used, and Meta does not train its models on what is sent to them. A model that may be trained on what it is sent is refused, wherever it is chosen.'],
                            ] },
                            { tip: 'Start with **Only these people** and your own test accounts: send a reel and a screenshot from one, read the **Inbox**, and only then choose **Everyone**. Press **Save Meta vision** after any change: it has its own button, apart from the assistant’s above it.' },
                            'When it cannot read something with confidence it does not guess: the person gets the usual line, or is asked to send it again, and the **Inbox** says what happened, honestly: unreadable, expired, too large or skipped, and why.',
                        ],
                    },
                },
                {
                    id: 'video-memory',
                    title: { ar: 'ذاكرة الفيديو (تجريبية)', en: 'Video memory (beta)' },
                    body: {
                        ar: [
                            '**ذاكرة الفيديو** تجعل المساعد يردّ على «عندك فيديو عن…؟» بالريل المناسب من ريلزك، وبالثانية التي يبدأ منها المشاهدة. حين تشغّلها يشاهد نموذج Muse Spark من ميتا كل ريل نشرته مرة واحدة، ويدوّن ما رآه وسمعه: ماذا يُقال فيه، وماذا يظهر على الشاشة (نص، كود، شخصيات)، واللحظات المهمة بثوانيها، والمواضيع. هي تجريبية ومتوقفة حتى تشغّلها، من **مساعد الرسائل** ← **رؤية ميتا**.',
                            { dl: [
                                ['ماذا يشاهد', 'ريلزك أنت المنشورة فقط، وهي عامة. ولا يدخل فيها شيء كتبه متابع: يذهب الريل إلى النموذج مع تعليماتنا له، ولا يصحبه رسالة ولا تعليق ولا متابع. ملف الفيديو لا نحتفظ به: تبقى الملاحظات فقط، مع رابط الريل وتاريخه.'],
                                ['من يشاهده', 'Muse Spark من ميتا: النموذج المفتوح الذي يشغّله لنا شريكنا Baseten، أو نموذج ميتا المستضاف عندها، بحسب اختيار مسؤول المنصة. وإذا فشل الأول جُرّب الريل نفسه مرة واحدة على نموذج ميتا المستضاف.'],
                                ['ماذا يفعل الرد فيها', 'حين يطلب شخصٌ مسموحٌ له فيديو (يكتب مثل «عندك فيديو عن دوكر؟») يبحث المساعد في المكتبة: تُرسل ملاحظات المكتبة وكلام الشخص إلى نموذج Muse من ميتا، وهو يختار الريل الوحيد الذي يغطي طلبه. بعدها يرسل له الرد رابط ذلك الريل ويقول من أين يبدأ المشاهدة، مثل «من 0:13»، والريل الذي له نسخة على يوتيوب يربط نسخة يوتيوب عند هذه الثانية. وإذا لم يوجد ريل يغطيه، يقول الرد إنه لا يوجد فيديو عن هذا الموضوع بعد، بدون أي رابط. ولا يرسل أبداً رابطاً ليس في مكتبتك.'],
                                ['افهرس ريلزي', 'اضغط **افهرس ريلزي** ليُشاهَد كل ريل نشرته. يعمل بعد أن تشغّل **ذاكرة الفيديو** وتضغط **احفظ رؤية ميتا**. تُشاهَد الريلز واحداً بعد الآخر، نحو 40 ثانية ونحو 0.02 دولار للريل، أي نحو 1.50 دولار لسبعين ريل، وتُحسب من **الحد اليومي (بالدولار)**. وكل يوم تُضاف تلقائياً الريلز التي نشرتها بعد آخر مرة، ما دامت **ذاكرة الفيديو** مشغّلة.'],
                                ['القائمة', 'تحت **مكتبة الفيديو** في البطاقة نفسها ترى ريلزك: **شوهد** أو **في الانتظار** أو **تعذّرت المشاهدة**، وسببها بالكلمات. **التفاصيل** تفتح ما تتذكره المكتبة عن الريل: عمّ يتحدث، وما يُقال فيه، وما يظهر على الشاشة، واللحظات، والمواضيع، والخطّاف، ووصفاً مقترحاً. **شاهده مرة أخرى** يعيد مشاهدة ريل واحد، و**حدّث** يقرأ القائمة من جديد.'],
                                ['حدود', 'الريل الأكبر من 35 ميغابايت لا يُشاهَد، والقائمة تقول ذلك. وتُقرأ أحدث 300 منشور فقط. وتعمل في رسائل إنستجرام فقط، مثل بقية رؤية ميتا.'],
                            ] },
                            { tip: 'شغّل **ذاكرة الفيديو**، واضغط **احفظ رؤية ميتا**، ثم **افهرس ريلزي** وشاهد القائمة تمتلئ. بعدها اسأل من حسابك التجريبي «عندك فيديو عن …؟» واقرأ **الرسائل**: يظهر تحت الرد «تذكّر: فيديو من مكتبتك».' },
                            'هي تتذكّر ما شاهدته فقط. فموضوع ليس في أي ريل من ريلزك يأخذ جواباً صادقاً بأنه لا يوجد فيديو عنه بعد، ولا يُخمَّن. وإذا بلغ الحد اليومي لا يُشاهَد ريل جديد ولا يُقترح فيديو حتى اليوم التالي.',
                        ],
                        en: [
                            '**Video memory** lets the assistant answer “do you have a video about…?” with the right one of your reels and the second to watch from. Once you switch it on, Meta’s Muse Spark model watches each reel you published, once, and keeps notes on what it saw and heard: what is said, what is shown on screen (text, code, characters), the key moments with their seconds, and the topics. It is in beta and off until you switch it on, in **DM assistant** → **Meta vision**.',
                            { dl: [
                                ['What it watches', 'Only your own published reels, which are public. Nothing a follower wrote is part of it: a reel goes to the model with our instructions for it, and no message, comment or follower goes with it. We do not keep the video file: only the notes, with the reel’s link and date.'],
                                ['Who watches', 'Meta’s Muse Spark: the open-weights model that our partner Baseten runs for us, or Meta’s own hosted one, whichever the platform administrator chose. If the first one fails, the same reel is tried once on Meta’s hosted model.'],
                                ['What a reply does with it', 'When someone you allow asks for a video (they write something like “do you have a video about Docker?”), the assistant looks in the library: the library’s notes and what they wrote are sent to Meta’s Muse model, which picks the one reel that covers it. The reply then gives that reel’s link and says where to watch from, like “from 0:13”; a reel that is also on YouTube links its YouTube copy at that second. If no reel covers it, the reply says there is no video on that yet, with no link. It never sends a link that is not in your library.'],
                                ['Index my reels', 'Press **Index my reels** to have every reel you published watched. It works once **Video memory** is on and saved (press **Save Meta vision**). The reels are watched one after another: about 40 seconds and about $0.02 a reel, so about $1.50 for seventy, counted toward **Daily cap (USD)**. Every day, the reels you published since are added by themselves while **Video memory** is on.'],
                                ['The list', 'Under **Video library** in the same card you see your reels: **Watched**, **Waiting** or **Could not watch**, with the reason in words. **Details** opens what the library remembers of a reel: what it is about, what is said, what is on screen, the moments, the topics, the hook and a suggested caption. **Watch again** watches one reel again, and **Refresh** reads the list again.'],
                                ['Limits', 'A reel larger than 35 MB is not watched, and the list says so. Only your 300 newest posts are looked at. It works in Instagram messages only, like the rest of Meta vision.'],
                            ] },
                            { tip: 'Switch on **Video memory**, press **Save Meta vision**, then **Index my reels** and watch the list fill. Then ask from your test account “do you have a video about …?” and read the **Inbox**: under the reply it shows “Recalled: a video from your library”.' },
                            'It remembers what it watched, and only that: a topic that is in none of your reels gets an honest “no video on that yet”, never a guess. When the daily cap is reached, no new reel is watched and no video is suggested until the next day.',
                        ],
                    },
                },
                {
                    id: 'save',
                    title: { ar: 'نصائح توفّر عليك', en: 'Ways to spend less' },
                    body: {
                        ar: [
                            { ul: [
                                'افهرس الدرس مرة واحدة. إعادة الفهرسة طلب جديد، فلا تعيدها إلا إذا فشلت.',
                                'لتعديل شريحة واحدة استخدم **أعد الكتابة بالذكاء الاصطناعي** بدلاً من **اكتبه من جديد** للكاروسيل كله.',
                                'كل رسالة تجريبية في **اختبار المساعد** طلب حقيقي، فجرّب بأسئلة مدروسة.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'Index each lesson once. Re-indexing is a new request, so only redo it when it failed.',
                                'To fix one slide, use **Rewrite with AI** rather than **Write it again** for the whole carousel.',
                                'Every test message in the **Assistant sandbox** is a real request, so test with purpose.',
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 13. Troubleshooting ─────────────────────────────────────────────
        {
            slug: 'troubleshooting',
            group: 'more',
            icon: 'wrench',
            title: { ar: 'حلول المشكلات', en: 'Troubleshooting' },
            summary: {
                ar: 'المشكلة وحلها: العامل، والفهرسة، والكتابة، والرسم، والنشر، وتيك توك، والرسائل.',
                en: 'Symptom and fix: the worker, indexing, writing, rendering, publishing, TikTok and DMs.',
            },
            related: ['faq', 'worker', 'campaigns', 'dm-assistant'],
            sections: [
                {
                    id: 'worker',
                    title: { ar: 'العامل', en: 'The worker' },
                    body: {
                        ar: [
                            { qa: [
                                ['**العامل غير متصل** والماك يعمل', ['تأكد أن الماك متصل بالإنترنت وليس نائماً.', 'شغّل أمر «هل هو شغّال؟» من [[worker#install]]. وإذا لم يكن يعمل، شغّل سكربت التثبيت مرة أخرى.']],
                                ['**لم يتصل بعد** مع أنني أنشأت العامل', 'غالباً لم يُلصق الرمز بشكل صحيح في `studio.config.json`، أو لُصق رمز عامل آخر. يقرأ العامل الملف من جديد عندما يتغيّر، فلا يحتاج إلى إعادة تشغيل.'],
                                ['السجل يقول `the app rejected the worker token (HTTP 401)`', 'أُلغي الرمز أو هو خاطئ. أنشئ عاملاً جديداً من إعدادات الاستوديو ← **العمّال**، والصق رمزه الجديد.'],
                                ['السجل يقول `another studio worker is running`', 'يوجد عامل آخر يعمل بالإعدادات نفسها. أوقف أحدهما: `scripts/uninstall-studio-worker.sh` أو Ctrl‑C.'],
                                ['السجل يقول `ffmpeg not found on PATH`', 'ثبّت ffmpeg (`brew install ffmpeg`)، وبعدها شغّل سكربت التثبيت مرة أخرى.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['**Worker offline** although the Mac is on', ['Check the Mac is online and not asleep.', 'Run the “Is it running?” command from [[worker#install]]. If it isn’t running, run the install script again.']],
                                ['**Never connected** even though I created the worker', 'Most likely the token wasn’t pasted correctly into `studio.config.json`, or another worker’s token was. The worker re-reads the file when it changes, so no restart is needed.'],
                                ['The log says `the app rejected the worker token (HTTP 401)`', 'The token was revoked or mistyped. Create a new worker in the Studio settings → **Workers** and paste its new token.'],
                                ['The log says `another studio worker is running`', 'A second worker is running with the same config. Stop one of them: `scripts/uninstall-studio-worker.sh`, or Ctrl-C.'],
                                ['The log says `ffmpeg not found on PATH`', 'Install ffmpeg (`brew install ffmpeg`), then run the install script again.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'failures',
                    title: { ar: 'حين يفشل شيء', en: 'When something fails' },
                    body: {
                        ar: [
                            'كل فشل يظهر في الشاشة بثلاثة أجزاء: جملة تقول ما حدث بلغتك، وخطوة واحدة تفعلها، وسطر «حدث في …» يذكر تاريخه حين يكون معروفًا. أما النص التقني كما كتبه الخادم أو ميتا أو جوجل فمطويّ تحت «التفاصيل»: افتحه حين تحتاج إليه، أو انسخه لمن يساعدك.',
                            { qa: [
                                ['الفشل قديم ولا أعرف هل ما زال قائمًا', 'انظر إلى سطر «حدث في …». فشلٌ عمره أسابيع بجوار حالة تعمل الآن غالبًا ما أُصلح؛ جرّب العمل مرة أخرى قبل أن تعالج شيئًا.'],
                                ['Claude على الماك مسجَّل الخروج', 'سجّل الدخول إلى Claude من جديد على الماك. الأعمال المنتظرة تستأنف من تلقاء نفسها، ولا حاجة إلى إعادة تشغيلها واحدًا واحدًا.'],
                                ['نفدت حصة Claude أو Gemini', 'انتظر حتى تتجدد الحصة، وموعد التجدد في «التفاصيل» حين يذكره المزوّد، ثم أعد المحاولة.'],
                                ['تيك توك: النشر المباشر من حساب خاص فقط', 'إلى أن يعتمد تيك توك التطبيق، اجعل الحساب خاصًا أو أرسل المنشور مسودةً إلى صندوق الوارد: [[tiktok]].'],
                                ['تعذّر تحويل الكلام إلى نص', 'جرّب فيديو أقصر، أو أعد المحاولة حين لا يكون الماك مشغولًا. وإن لم يكن في الفيديو كلام واضح فلن يجد النظام لحظة يقتطعها.'],
                                ['رفضت ميتا الطلب', 'الأخطاء الشائعة (الرمز المنتهي، الصلاحية الناقصة، الردّ الخاص المكرر) لها جملة تشرحها. وما عداها يظهر بجملة عامة، فافتح «التفاصيل» لمعرفة ما قالته ميتا.'],
                            ] },
                        ],
                        en: [
                            'Every failure on screen has three parts: a sentence that says what happened in your language, one step to take, and a “Happened …” line with its date when it is known. The technical text as the server, Meta or Google wrote it is folded behind Details: open it when you need it, or copy it for whoever is helping.',
                            { qa: [
                                ['The failure is old and I can’t tell if it still applies', 'Look at the “Happened …” line. A weeks-old failure beside something that works now has most likely been fixed; try the action again before you fix anything.'],
                                ['Claude on the Mac is signed out', 'Sign in to Claude again on the Mac. The work that was waiting resumes by itself; you do not have to restart it one by one.'],
                                ['Claude’s or Gemini’s allowance is used up', 'Wait for it to reset (the time is under Details when the provider gives one), then try again.'],
                                ['TikTok: direct posts only from a private account', 'Until TikTok approves the app, make the account private or send the post as an inbox draft: [[tiktok]].'],
                                ['Turning the speech into text failed', 'Try a shorter video, or try again when the Mac is not busy. If the video has no clear speech, the system has no moment to cut.'],
                                ['Meta refused the request', 'The common errors (an expired token, a missing permission, a second private reply) have a sentence that explains them. Anything else shows a general sentence: open Details to read what Meta said.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'indexing',
                    title: { ar: 'الفحص والفهرسة', en: 'Scanning and indexing' },
                    body: {
                        ar: [
                            { qa: [
                                ['زر **افحص المكتبة** معطّل', 'لم تحدد مجلد المكتبة. اضغط **حدّده من الإعدادات**.'],
                                ['الفحص انتهى ولم تظهر دروس', 'راجع ترتيب المجلد وأسماء الملفات في [[library#folder]]. ويجب أن يكون مسار المجلد داخل `courseRoot` في إعدادات العامل.'],
                                ['درس مكتوب عليه **فشلت الفهرسة**', 'افتح الدرس وانظر السبب، واضغط **فهرس هذا الدرس**. وإن تكرر الفشل فراجع السجل على الماك.'],
                                ['الفهرسة متوقفة على `uploading the … proxy to Gemini`', 'هذا رفع النسخة الصغيرة، والإنترنت البطيء يطيله. يكمل الرفع من حيث انقطع، والمهمة محجوزة للعامل ما دام يرسل تحديثات.'],
                                ['السجل يقول `is outside the course root`', 'مجلد المكتبة في الإعدادات ليس داخل `courseRoot` في ملف العامل. غيّر أحدهما.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['**Scan library** is disabled', 'No library folder is set. Press **Set it in Settings**.'],
                                ['The scan finished but no lessons appeared', 'Check the folder layout and file names in [[library#folder]]. The folder must also sit inside `courseRoot` in the worker’s config.'],
                                ['A lesson says **Indexing failed**', 'Open the lesson to see why, and press **Index this lesson**. If it keeps failing, check the log on the Mac.'],
                                ['Indexing sits on `uploading the … proxy to Gemini`', 'That is the small copy uploading, and a slow connection stretches it. The upload resumes where it stopped, and the job stays with the worker as long as it keeps reporting.'],
                                ['The log says `is outside the course root`', 'The library folder in the settings isn’t inside `courseRoot` in the worker’s config. Change one or the other.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'generation',
                    title: { ar: 'كتابة الكاروسيل', en: 'Writing a carousel' },
                    body: {
                        ar: [
                            { qa: [
                                ['**تعذّرت كتابة الكاروسيل** وفي الرسالة `HTTP 429`', 'انتهت حصة Gemini. انتظر حتى تتجدد، أو فعّل الفوترة: [[ai-usage#quotas]].'],
                                ['زر **أنشئ الكاروسيل** معطّل', 'لا يوجد أي درس مفهرس. افهرس درساً، أو اختر **من فكرة**.'],
                                ['تستغرق الكتابة وقتاً أطول من المعتاد', 'قد تستغرق الدروس الطويلة دقيقتين. ولا يلزمك الانتظار في الصفحة: تظهر المسودّة في **المسودات** حين تجهز.'],
                                ['**الكلمة المفتاحية يجب أن تكون كلمة واحدة بلا مسافات**', 'في **خيارات أكثر**، اجعل الكلمة كلمة واحدة بدون مسافات.'],
                                ['رسالة فيها `still breaks … rule(s)`', 'لم يستطع الذكاء الاصطناعي كتابة مسودّة تلتزم بكل القواعد. جرّب مرة أخرى، أو غيّر **الزاوية** أو **عدد الشرائح**.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['**The carousel couldn’t be written** with `HTTP 429` in the message', 'Your Gemini quota ran out. Wait for it to reset, or turn on billing: [[ai-usage#quotas]].'],
                                ['**Generate carousel** is disabled', 'No lesson is indexed yet. Index one, or switch to **From an idea**.'],
                                ['Writing is taking longer than usual', 'Long lessons can take two minutes. You don’t have to wait on the page: the draft appears under **Drafts** when it is ready.'],
                                ['**The keyword has to be one word, with no spaces.**', 'In **More options**, make the keyword a single word with no spaces.'],
                                ['A message containing `still breaks … rule(s)`', 'The AI couldn’t produce a draft that follows every rule. Try again, or change the **Angle** or the number of **Slides**.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'rendering',
                    title: { ar: 'رسم الشرائح', en: 'Rendering the slides' },
                    body: {
                        ar: [
                            { qa: [
                                ['المسودّة متوقفة على **يرسم الشرائح**', 'العامل غير متصل، والرسم ينتظره في الطابور. شغّل الماك والعامل، ويبدأ الرسم من تلقاء نفسه.'],
                                ['**فشل الرسم**', ['النص محفوظ، فاضغط **أعد الرسم**.', 'وإن تكرر فراجع السجل. مثلاً `ffmpeg found no frame at` يعني أن وقت اللقطة بعد نهاية الفيديو، فاختر لقطة أخرى.']],
                                ['المعاينة لم تتغير بعد التعديل', 'يجب أن تضغط **احفظ وحدّث المعاينة**، وبعدها ينتظر الرسم الجديد.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['The draft is stuck on **Rendering**', 'The worker is offline, and the render is waiting for it in the queue. Start the Mac and the worker, and drawing starts by itself.'],
                                ['**The render failed.**', ['The text is saved, so press **Render again**.', 'If it keeps failing, check the log. For example `ffmpeg found no frame at` means a screenshot’s time is past the end of its video: pick another one.']],
                                ['The preview didn’t change after my edits', 'Press **Save & update preview**, then wait for the new render.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'publishing',
                    title: { ar: 'النشر على إنستجرام وفيسبوك', en: 'Publishing to Instagram and Facebook' },
                    body: {
                        ar: [
                            { qa: [
                                ['منشور عليه **فشلت**', 'اقرأ السبب على المنشور. لم يُحذف شيء: أصلح الوسائط أو النص وأعد النشر.'],
                                ['نُشر على فيسبوك وفشل على إنستجرام', 'أعد النشر، وسيُنشر على إنستجرام فقط.'],
                                ['إنستجرام رفض الكاروسيل', 'تأكد أنها من 2 إلى 10 صور، وبالمقاس نفسه: [[scheduling#carousels]].'],
                                ['شريحة مقصوصة خطأً', 'الصورة الأولى تحدد القصّ للكل. اجعل كل الصور بالمقاس نفسه.'],
                                ['الريل ظهر مربعاً أسود في الشبكة', 'ارفع صورة غلاف: [[scheduling#cover]].'],
                                ['المنشور لم يُنشر في دقيقته بالضبط', 'يُنشر خلال دقائق من موعده. ولو توقف الفحص المتكرر، يُنشر مع التشغيل اليومي الساعة 00:00 بتوقيت UTC.'],
                                ['**رمز الوصول** مكتوب عليه **غير صالح أو منتهٍ**', 'الحل في [[connect-meta#token-health]].'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['A post says **Failed**', 'Read the reason on the post. Nothing was deleted: fix the media or caption and publish again.'],
                                ['It went out on Facebook but failed on Instagram', 'Publish again and only Instagram is retried.'],
                                ['Instagram refused the carousel', 'Check it has 2 to 10 images, all the same size: [[scheduling#carousels]].'],
                                ['A slide is cropped wrongly', 'The first image sets the crop for all of them. Make every image the same size.'],
                                ['The reel is a black tile in the grid', 'Upload a cover image: [[scheduling#cover]].'],
                                ['The post didn’t go out on the exact minute', 'It goes out within minutes of its time. If the frequent check ever stops, it goes out with the daily run at 00:00 UTC.'],
                                ['The **Access token** says **Invalid / expired**', 'The fix is in [[connect-meta#token-health]].'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'tiktok',
                    title: { ar: 'تيك توك', en: 'TikTok' },
                    body: {
                        ar: [
                            { qa: [
                                ['المنشور على تيك توك لا يراه أحد', 'طبيعي قبل الاعتماد: يُنشر **أنا فقط**. اجعله عاماً من **⋯** ← **الخصوصية** ← **الجميع**.'],
                                ['تيك توك رفض المنشور', 'قبل الاعتماد يجب أن يكون حسابك خاصاً وقت النشر. اجعله خاصاً وأعد المحاولة: [[tiktok#before-approval]].'],
                                ['المسودّة لم تصل إلى صندوق تيك توك', 'لا يُعتمد على وضع المسودّات. استخدم **انشره مباشرة في حسابي على تيك توك**: [[tiktok#drafts]].'],
                                ['منشور تيك توك عاد **بالانتظار** ومعه سبب عن المسودّات', 'لديك 5 مسودّات معلّقة في آخر 24 ساعة. انشر واحدة منها من التطبيق، ويُرسل الباقي من تلقاء نفسه.'],
                                ['**يحتاج إلى إعادة الربط**', 'اضغط **أعد الربط** في **الإعدادات** ← **تيك توك**.'],
                                ['**أعد ربط تيك توك للسماح بالنشر المباشر**', 'فُعّل النشر المباشر بعد أن ربطت حسابك. أعد الربط مرة واحدة.'],
                                ['الناس يسألون عن الرابط في تعليقات تيك توك', 'لا يرسل تيك توك رسائل تلقائية. تأكد أن الرابط موجود في البايو: [[tiktok#bio]].'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['Nobody can see my TikTok post', 'Normal before approval: it goes up as **Only me**. Make it public with **⋯** → **Privacy** → **Everyone**.'],
                                ['TikTok refused the post', 'Before approval your account has to be private while posting. Make it private and try again: [[tiktok#before-approval]].'],
                                ['The draft never reached my TikTok inbox', 'Drafts mode is unreliable. Use **Post directly to my profile** instead: [[tiktok#drafts]].'],
                                ['A TikTok post went back to **Pending** with a note about drafts', 'You have 5 pending drafts from the last 24 hours. Post one of them from the app, and the rest follow on their own.'],
                                ['**Needs reconnecting**', 'Press **Reconnect** in **Settings** → **TikTok**.'],
                                ['**Reconnect TikTok to allow direct posting.**', 'Direct Post was switched on after you connected. Reconnect once.'],
                                ['People ask for the link in the TikTok comments', 'TikTok doesn’t send automatic DMs. Check the link is really in your bio: [[tiktok#bio]].'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'dms',
                    title: { ar: 'الرسائل والردود', en: 'DMs and replies' },
                    body: {
                        ar: [
                            { qa: [
                                ['علّقت بالكلمة ولم تصلني رسالة', { ul: [
                                    'هل الرد التلقائي مفعّل؟',
                                    'هل الكلمة موجودة فعلاً في التعليق؟',
                                    'هل علّقت من حساب آخر؟ تعليقاتك أنت لا تشغّل الردود التلقائية.',
                                    'هل وصلتك رسالة من قبل خلال 24 ساعة؟ رسالة واحدة لكل شخص كل 24 ساعة.',
                                    'هل الرد التلقائي مرتبط بمنشور معيّن؟ يجب أن تعلّق على هذا المنشور.',
                                    '**رمز الوصول** مكتوب عليه **صالح**؟',
                                ] }],
                                ['**السجل** فارغ تماماً', 'التعليق الذي لا يطابق أي رد تلقائي لا يُسجَّل أصلاً. جرّب بكلمة رد تلقائي مفعّل.'],
                                ['أشخاص وصلتهم رسالة لم يطلبوها', 'كلمة قصيرة تطابق داخل كلمات أخرى: [[campaigns#pitfall]].'],
                                ['الرسالة وصلت والرد العلني لم يظهر', 'يحتاج الرد على تعليقات فيسبوك إلى صلاحية `pages_manage_engagement`: [[connect-meta#token-health]].'],
                                ['المساعد لا يرد على الرسائل', ['تأكد أن **تشغيل الردّ الآلي** مفعّل في **مساعد الرسائل**.', 'وتأكد أن الرد الآلي ليس موقوفاً في المحادثة (**الردّ الآلي متوقف** في **الرسائل**). أي رد يدوي منك يوقفه في تلك المحادثة.', 'ولو انتهت حصة Gemini: [[ai-usage#quotas]].']],
                                ['بعض الرسائل **فشلت** ومعها سبب عن الحد', 'الحد 180 رسالة في الساعة لكل حساب، ورسالة واحدة لكل شخص كل 24 ساعة.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['I commented the keyword and got no DM', { ul: [
                                    'Is the keyword reply active?',
                                    'Is the keyword really in the comment?',
                                    'Did you comment from another account? Your own comments never trigger a keyword reply.',
                                    'Did you already get a DM in the last 24 hours? It is one per person every 24 hours.',
                                    'Is the keyword reply tied to one post? Then comment on that post.',
                                    'Does the **Access token** say **Valid**?',
                                ] }],
                                ['The **Log** is completely empty', 'A comment that matches no keyword reply is not recorded at all. Test with the keyword of an active keyword reply.'],
                                ['People got a DM they never asked for', 'A short keyword is matching inside other words: [[campaigns#pitfall]].'],
                                ['The DM arrived but the public reply didn’t', 'Replying to Facebook comments needs the `pages_manage_engagement` permission: [[connect-meta#token-health]].'],
                                ['The AI assistant isn’t answering DMs', ['Check **Turn on auto-replies** is on in **DM assistant**.', 'Check the AI isn’t paused in that conversation (**AI paused** in the **Inbox**). Any manual reply from you pauses it there.', 'And if your Gemini quota ran out: [[ai-usage#quotas]].']],
                                ['Some DMs **Failed** with a note about a limit', 'The limits are 180 DMs an hour per account, and one DM per person every 24 hours.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'monitoring',
                    title: { ar: 'تنبيهك لو توقّف التطبيق نفسه', en: 'Being told when the app itself stops' },
                    body: {
                        ar: [
                            'تنبيهات التطبيق تصلك من داخله، فلو توقّف الخادم أو قاعدة البيانات أو عامل الطابور لم يصلك شيء. لهذا يوجد فحصان من الخارج، ومجانيان:',
                            { ul: [
                                'العنوان `/health` يردّ 200 طالما قاعدة البيانات تردّ والطابور يتحرك، و503 إذا توقف عمل الطابور: أقدم مهمة مستحقة صارت أكبر من 10 دقائق ولا يوجد تشغيل للطابور منذ 5 دقائق. ضع عليه فاحصاً مجانياً مثل UptimeRobot أو Better Stack. لا يكشف أي اسم أو رقم تعريف أو عدد.',
                                'في **الإعدادات** ← **المنصة** ← **المراقبة** تحفظ **رابط فحص التوقف (ping)** من خدمة مثل Healthchecks.io. بعد كل تشغيل سليم للطابور يفتحه التطبيق (مرة كل 5 دقائق على الأكثر)، فلو انقطعت النبضات أرسلت لك الخدمة بريداً. هذه البطاقة لمسؤول المنصة، والرابط يُحفظ مشفّراً ولا يظهر مرة أخرى.',
                            ] },
                        ],
                        en: [
                            'AutoReply’s own alerts are sent from inside the app, so if the server, the database or the queue worker stops, nothing reaches you. Two free checks from outside cover that:',
                            { ul: [
                                'The address `/health` answers 200 while the database answers and the queue is moving, and 503 when the queue is stuck: the oldest due job has waited more than 10 minutes and nothing has drained the queue for 5. Put a free monitor such as UptimeRobot or Better Stack on it. It reveals no name, id or count.',
                                'In **Settings** → **Platform** → **Monitoring** you save a **Dead-man ping URL** from a service like Healthchecks.io. After every good queue run the app opens it (at most once every 5 minutes), so when the pings stop the service emails you. The card is for the platform administrator, and the address is kept encrypted and never shown again.',
                            ] },
                        ],
                    },
                },
            ],
        },
        // ─── 14. FAQ ─────────────────────────────────────────────────────────
        {
            slug: 'faq',
            group: 'more',
            icon: 'message-circle',
            title: { ar: 'الأسئلة الشائعة', en: 'FAQ' },
            summary: {
                ar: 'أجوبة قصيرة للأسئلة التي تتكرر.',
                en: 'Short answers to the questions that come up most.',
            },
            related: ['troubleshooting', 'getting-started', 'worker'],
            sections: [
                {
                    id: 'general',
                    title: { ar: 'عامة', en: 'General' },
                    body: {
                        ar: [
                            { qa: [
                                ['هل يجب أن أُبقي جهازي مفتوحاً؟', 'للردود التلقائية والرسائل والجدولة لا، كلها على الخادم وتعمل وجهازك مطفأ. الاستوديو فقط: الفهرسة والرسم يحتاجان إلى العامل على جهازك.'],
                                ['هل يمكن أن يُنشر شيء دون موافقتي؟', 'لا. يُنشر المنشور حين تجدوله أنت، وتصدر الردود من ردودك التلقائية ومساعدك وتعليماتك.'],
                                ['هل يعمل مع حساب إنستجرام شخصي؟', 'لا، يلزم حساب احترافي (أعمال أو صانع محتوى) متصل بصفحة فيسبوك: [[connect-meta#needs]].'],
                                ['هل أستطيع إيقاف الرد الآلي لعميل معيّن؟', 'نعم. في **الرسائل** افتح المحادثة وأطفئ **المساعد في هذه المحادثة**. وأي رد يدوي منك يوقفه تلقائياً في تلك المحادثة.'],
                                ['هل أستطيع تغيير لغة اللوحة؟', 'نعم، من الزر أعلى الصفحة، أو من **الإعدادات** ← **المظهر واللغة**.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['Does my computer have to stay on?', 'Not for keyword replies, DMs or scheduling: they all run on the server, even with your computer off. Only the Studio needs it: indexing and drawing slides need the worker on your computer.'],
                                ['Can anything be posted without my approval?', 'No. A post goes out when you schedule it, and replies come from your own keyword replies and your assistant, following your instructions.'],
                                ['Does it work with a personal Instagram account?', 'No: you need a professional (Business or Creator) account connected to a Facebook Page. See [[connect-meta#needs]].'],
                                ['Can I stop the AI for one customer?', 'Yes. In the **Inbox**, open the conversation and switch off **AI assistant for this conversation**. A manual reply from you pauses it there too.'],
                                ['Can I change the dashboard’s language?', 'Yes, with the button at the top of the page, or in **Settings** → **Appearance & language**.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'studio',
                    title: { ar: 'الاستوديو', en: 'The Studio' },
                    body: {
                        ar: [
                            { qa: [
                                ['هل تخرج فيديوهاتي من جهازي؟', 'لا. للفهرسة تُرسل نسخة صغيرة إلى Gemini وتُحذف بعدها، ويبقى الأصلي عندك: [[worker#security]].'],
                                ['هل أستطيع استخدام الاستوديو بدون دروس؟', 'نعم، اكتب **من فكرة**. لكن رسم الشرائح يحتاج إلى العامل.'],
                                ['هل يعمل العامل على ويندوز؟', 'حالياً على الماك فقط.'],
                                ['هل أستطيع تعديل الكاروسيل بعد جدولته؟', 'لا، يُغلق التعديل بعد الجدولة. احذف المنشور من **الجدولة** وارجع فعدّله.'],
                                ['لماذا الأرقام في الشرائح هندية (١٢٣)؟', 'غيّرها من **الأرقام** في إعدادات الاستوديو: [[studio-settings#voice]].'],
                                ['هل يُكتب الكاروسيل بلهجتي؟', 'يلتزم بـ**دليل الأسلوب** في الإعدادات، فاكتب فيه لهجتك ونبرتك بالتفصيل.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['Do my videos leave my computer?', 'No. For indexing, a small copy goes to Gemini and is deleted afterwards; the original stays with you. See [[worker#security]].'],
                                ['Can I use the Studio without lessons?', 'Yes, write **From an idea**. Drawing the slides still needs the worker.'],
                                ['Does the worker run on Windows?', 'For now, on a Mac only.'],
                                ['Can I edit a carousel after scheduling it?', 'No, editing closes once it is scheduled. Delete the post from the **Scheduler** and edit it again.'],
                                ['Why are the digits on my slides Arabic-Indic (١٢٣)?', 'Change **Digits** in the Studio settings: [[studio-settings#voice]].'],
                                ['Will the carousel sound like me?', 'It follows the **Voice guide** in the settings, so describe your dialect and tone there in detail.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'tiktok',
                    title: { ar: 'تيك توك', en: 'TikTok' },
                    body: {
                        ar: [
                            { qa: [
                                ['لماذا منشوراتي على تيك توك «أنا فقط»؟', 'لأن تيك توك لم يعتمد التطبيق بعد. اجعلها عامة بنفسك: [[tiktok#before-approval]].'],
                                ['هل يرسل تيك توك رسائل خاصة لمن يعلّقون؟', 'لا، ولهذا توجّه نصوص تيك توك الناس إلى الرابط في البايو: [[tiktok#bio]].'],
                                ['كم يدوم ربط تيك توك؟', 'سنة واحدة، وبعدها تعيد الربط من **الإعدادات**.'],
                                ['هل أستطيع نشر كاروسيل صور على تيك توك؟', 'نعم، من 2 إلى 35 صورة: [[tiktok#photos]].'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['Why are my TikTok posts “Only me”?', 'Because TikTok hasn’t approved the app yet. Make them public yourself: [[tiktok#before-approval]].'],
                                ['Does TikTok send DMs to people who comment?', 'No, which is why TikTok captions point people to the link in your bio: [[tiktok#bio]].'],
                                ['How long does a TikTok connection last?', 'One year, then you reconnect from **Settings**.'],
                                ['Can I post a photo carousel to TikTok?', 'Yes, 2 to 35 images: [[tiktok#photos]].'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'ai',
                    title: { ar: 'الذكاء الاصطناعي', en: 'AI' },
                    body: {
                        ar: [
                            { qa: [
                                ['أي ذكاء اصطناعي يستخدم؟', 'Gemini من Google أساساً، للرسائل والكاروسيل والفهرسة. وللرسائل والريلز والإنفوجرافيك خيارات أخرى بحسب مساحتك: [[ai-usage#where]].'],
                                ['هل يمكن أن يخترع معلومات؟', 'يُكتب الكاروسيل من ملاحظات الدرس و**حقائق** المنتج فقط، ويعمل المساعد من تعليماتك وقاعدة المعرفة. ومع هذا، راجع دائماً قبل أن تنشر.'],
                                ['هل يوجد حد للاستخدام؟', 'نعم، حدود Google على مفتاحك: [[ai-usage#quotas]].'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['Which AI does it use?', 'Mostly Google’s Gemini, for DMs, carousels and indexing. DM replies, the Monteur and infographics have other options, depending on your workspace: [[ai-usage#where]].'],
                                ['Can it make things up?', 'Carousels are written only from the lesson notes and your product **Facts**, and the assistant from your instructions and knowledge base. Still, always review before you post.'],
                                ['Is there a usage limit?', 'Yes, Google’s limits on your key: [[ai-usage#quotas]].'],
                            ] },
                        ],
                    },
                },
            ],
        },
    ],
};
