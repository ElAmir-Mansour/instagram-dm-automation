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
 * is written as Arabic, for creators, in a light Gulf register. Section ids are shared, so
 * `#/help/<slug>#<id>` lands on the same section in either language.
 *
 * A block is one of:
 *   'text'                                   a paragraph
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
        { id: 'studio', title: { ar: 'استوديو الكاروسيل', en: 'Carousel Studio' } },
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
                ar: 'وش يسوّي لك أوتوريبلاي برو، وكيف تجهّز حسابك في أول عشر دقائق.',
                en: 'What AutoReply Pro does for you, and how to set up your account in the first ten minutes.',
            },
            related: ['connect-meta', 'campaigns', 'studio'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'وش يسوّي لك؟', en: 'What it does' },
                    body: {
                        ar: [
                            'أوتوريبلاي برو يرد على جمهورك في إنستجرام وفيسبوك بدالك، وينشر محتواك في وقته، حتى وأنت مشغول أو نايم. يشتغل على حسابك الرسمي عن طريق ميتا نفسها، بدون حيل ولا إضافات.',
                            { ul: [
                                '**ردود الكلمات المفتاحية:** متابع يكتب كلمة تحددها في التعليقات (مثل «كورس»)، فتوصله رسالة خاصة فيها الرابط، ويشوف رداً علنياً على تعليقه إذا حبيت.',
                                '**وكيل ذكي للرسائل:** أي رسالة توصلك في الخاص يرد عليها وكيل يعرف منتجك ويتكلم بأسلوبك، وتقدر توقفه في أي محادثة.',
                                '**جدولة المنشورات:** صورة أو فيديو أو ريل أو كاروسيل، على إنستجرام وفيسبوك معاً، ومعها تيك توك إذا ربطته.',
                                '**استوديو الكاروسيل:** يحوّل دروسك المصوّرة إلى منشورات كاروسيل جاهزة، بالنص والكلمة المفتاحية والرسالة الخاصة.',
                            ] },
                        ],
                        en: [
                            'AutoReply Pro answers your audience on Instagram and Facebook for you, and publishes your content on time, even while you are busy or asleep. It works on your real account through Meta’s own API: no tricks, no browser extensions.',
                            { ul: [
                                '**Keyword replies:** someone comments a word you choose (say, “course”), gets a private DM with your link, and sees a public reply under their comment if you want one.',
                                '**An AI agent for DMs:** messages that land in your inbox are answered by an agent that knows your product and writes in your voice. You can pause it in any conversation.',
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
                            'عشر دقائق تكفي عشان يبدأ الحساب يشتغل عنك. امشِ عليها بالترتيب:',
                            { ol: [
                                'افتح **الإعدادات** وتأكد أن قسم **رمز الوصول** مكتوب فيه **صالح**. لو شفت تنبيه **صلاحيات ميتا ناقصة**، الحل في [[connect-meta#token-health]].',
                                'روح **الحملات** واضغط **حملة جديدة**: اكتب الكلمة المفتاحية، ونص الرسالة الخاصة، ورداً علنياً قصيراً. وقبل ما تختار الكلمة اقرأ [[campaigns#matching|كيف تشتغل المطابقة]].',
                                'جرّبها بنفسك: من حساب ثاني علّق بالكلمة على أحد منشوراتك، وخلال ثوانٍ توصلك الرسالة في الخاص. وكل اللي صار تلقاه في **سجل النشاط**.',
                                'افتح **إعدادات الذكاء الاصطناعي**، فعّل **تشغيل الوكيل الذكي**، واكتب في **الشخصية والتعليمات** من هو الوكيل وكيف يتكلم. جرّبه في **اختبار الوكيل** قبل ما يرد على أي عميل.',
                                'من **جدولة المنشورات** اضغط **جدولة منشور** وجرّب منشوراً بسيطاً. التفاصيل في [[scheduling]].',
                                'اختياري: اربط تيك توك من **الإعدادات** ← **ربط تيك توك**، واقرأ [[tiktok]] قبل أول منشور.',
                                'اختياري: إذا عندك كورس أو دروس مصوّرة، جهّز **الاستوديو**. البداية من [[studio]].',
                            ] },
                            { tip: 'أي علامة استفهام صغيرة جنب زر في اللوحة توديك للشرح اللي يخصه هنا مباشرة.' },
                        ],
                        en: [
                            'Ten minutes is enough to get the account working for you. Go through these in order:',
                            { ol: [
                                'Open **Settings** and check that the **Access token** section says **Valid**. If you see **Missing Meta permissions**, the fix is in [[connect-meta#token-health]].',
                                'Go to **Campaigns** and press **New campaign**: enter a keyword, the DM text and a short public reply. Before you pick the keyword, read [[campaigns#matching|how matching works]].',
                                'Test it yourself: from another account, comment the keyword on one of your posts. The DM arrives within seconds, and everything that happened shows up in the **Activity Log**.',
                                'Open **AI Settings**, switch on **Enable the AI sales agent**, and describe in **Voice and instructions** who the agent is and how it talks. Try it in the **Agent sandbox** before it answers a real customer.',
                                'In the **Posts Scheduler**, press **Schedule a post** and try a simple one. The details are in [[scheduling]].',
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
                                ['نظرة عامة', 'ملخص اليوم، وأي شي يحتاج انتباهك.'],
                                ['الحملات', 'الكلمات المفتاحية، ورسائلها الخاصة، وردودها العلنية.'],
                                ['جدولة المنشورات', 'طابور المنشورات المجدولة، والمنشور فعلياً على حساباتك.'],
                                ['الاستوديو', 'كاروسيل من دروسك، من الفكرة إلى الجدولة.'],
                                ['صندوق الرسائل', 'محادثات عملائك. تقدر ترد بنفسك، وأي رد يدوي يوقف الرد الآلي في تلك المحادثة.'],
                                ['إعدادات الذكاء الاصطناعي', 'شخصية الوكيل، ومعلوماته، والنموذج، ومكان تجربته.'],
                                ['التحليلات', 'أداء الأتمتة بالأرقام.'],
                                ['النمو والتسويق', 'أرقام محتواك، وخطة مدرب النمو، وأدوات السيو.'],
                                ['سجل النشاط', 'كل تعليق ورسالة وحالتها، لحظة بلحظة.'],
                                ['الإعدادات', 'رمز الوصول، ورمز التحقق، وتيك توك، والمظهر واللغة.'],
                                ['المساعدة', 'هنا: كل الشروحات، بالعربي والإنجليزي.'],
                            ] },
                        ],
                        en: [
                            { dl: [
                                ['Overview', 'Today at a glance, and anything that needs your attention.'],
                                ['Campaigns', 'Keywords, their DMs and their public replies.'],
                                ['Posts Scheduler', 'The queue of scheduled posts, and what is already live on your accounts.'],
                                ['Studio', 'Carousels made from your lessons, from the idea to the schedule.'],
                                ['DM Inbox', 'Your customer conversations. You can reply yourself, and a manual reply pauses the AI in that conversation.'],
                                ['AI Settings', 'The agent’s voice, what it knows, the model, and a sandbox to try it.'],
                                ['Analytics', 'How the automation is performing, in numbers.'],
                                ['Growth', 'How your content performs, the Growth Coach’s plan, and the SEO tools.'],
                                ['Activity Log', 'Every comment and message and what happened to it, as it happens.'],
                                ['Settings', 'The access token, the webhook verify token, TikTok, appearance and language.'],
                                ['Help', 'You are here: every guide, in Arabic and English.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'roles',
                    title: { ar: 'مين يقدر يسوّي وش؟', en: 'Who can do what' },
                    body: {
                        ar: [
                            'في الحساب ثلاثة أدوار. ولو كان دورك يقيّدك، تشوف شارته أعلى الصفحة، فتعرف ليش زر معيّن ما يشتغل لك:',
                            { dl: [
                                ['مالك', 'كل شي، ومنه ربط ميتا نفسه (رمز وصول الصفحة ورمز التحقق)، وربط تيك توك.'],
                                ['مشغّل', 'الحملات والمنشورات المجدولة والرسائل والوكيل الذكي، بدون لمس رموز ميتا.'],
                                ['مُطّلع', 'قراءة فقط: الإحصاءات والحملات والمنشورات والرسائل، بدون أي تعديل.'],
                            ] },
                            'وتقدر تبدّل لغة اللوحة بين العربي والإنجليزي من الزر أعلى الصفحة، أو من **الإعدادات** ← **المظهر واللغة**.',
                        ],
                        en: [
                            'An account has three roles. When yours limits you, its badge appears at the top of the page, so you know why a button refuses:',
                            { dl: [
                                ['Owner', 'Everything, including the Meta connection itself (the page access token and the webhook verify token) and connecting TikTok.'],
                                ['Operator', 'Campaigns, scheduled posts, the inbox and the AI agent, without touching the Meta tokens.'],
                                ['Viewer', 'Read only: stats, campaigns, posts and messages, with no changes.'],
                            ] },
                            'You can switch the dashboard between Arabic and English with the button at the top of the page, or in **Settings** → **Appearance & language**.',
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
                ar: 'وش يحتاج الربط، ووين تلقاه في الإعدادات، وكيف تتأكد أن رمز الوصول سليم.',
                en: 'What the connection needs, where it lives in Settings, and how to tell the access token is healthy.',
            },
            related: ['campaigns', 'troubleshooting', 'getting-started'],
            sections: [
                {
                    id: 'needs',
                    title: { ar: 'وش تحتاج؟', en: 'What you need' },
                    body: {
                        ar: [
                            { ul: [
                                'حساب إنستجرام **احترافي** (حساب أعمال أو صانع محتوى)، مو حساب شخصي.',
                                'صفحة فيسبوك مربوطة بحساب إنستجرام هذا.',
                                '**رمز وصول للصفحة** (Page Access Token) من ميتا، فيه الصلاحيات المطلوبة. الأفضل يكون رمزاً دائماً ما ينتهي.',
                                'دور **مالك** في الحساب هنا، لأن المالك وحده يقدر يغيّر رموز ميتا.',
                            ] },
                            { note: 'تطبيق ميتا نفسه ورابط الويبهوك يجهّزهم مدير المنصة مرة وحدة للكل. اللي يخصك أنت: رمز صفحتك وصلاحياته.' },
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
                    title: { ar: 'وين ألقاه في الإعدادات؟', en: 'Where it lives in Settings' },
                    body: {
                        ar: [
                            'كل شي في صفحة **الإعدادات**:',
                            { dl: [
                                ['رمز الوصول', 'حالة الرمز، ونوعه، ومتى ينتهي، وصلاحياته. ومنه تلصق رمزاً جديداً في **تحديث رمز الوصول** وتضغط **تحقّق واحفظ**. الرمز يُفحص عند ميتا قبل ما يُحفظ، ويُخزَّن مشفّراً.'],
                                ['رمز التحقق للويبهوك', 'كلمة سرية تخترعها أنت وتكتبها بنفس الشكل في تطبيق ميتا. ميتا تفحصها بس لما ينشأ اشتراك أو يتغيّر رابطه، والحفظ هنا بـ**حفظ رمز التحقق** يشتغل فوراً.'],
                                ['بيانات الحساب', 'معرّف صفحة إنستجرام وفيسبوك، وحالة الحساب، و**عنوان الويبهوك** اللي تحتاجه ميتا.'],
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
                                ['صالح', 'كل شي تمام.'],
                                ['غير صالح أو منتهٍ', 'الردود والنشر بيتوقفون. الصق رمزاً جديداً واضغط **تحقّق واحفظ**.'],
                                ['ينتهي: أبداً (رمز طويل الأمد)', 'هذا الأفضل. ولو شفت تاريخ انتهاء بدالها، اضغط **تمديد إلى رمز دائم**. الرمز القديم يظل شغّال، لأن ميتا ما تلغيه لما تصدر الجديد.'],
                                ['صلاحيات ميتا ناقصة', 'تنبيه فوق الصفحة يسمّي الصلاحية الناقصة. بدونها بعض الردود تفشل بدون ما تنتبه.'],
                            ] },
                            'الصلاحيات الأساسية، ووش فايدة كل وحدة:',
                            { dl: [
                                ['`instagram_manage_comments`', 'قراءة تعليقات إنستجرام والرد عليها.'],
                                ['`instagram_manage_messages`', 'أتمتة رسائل إنستجرام.'],
                                ['`instagram_content_publish`', 'نشر وجدولة منشورات إنستجرام.'],
                                ['`pages_manage_engagement`', 'الرد على تعليقات فيسبوك.'],
                                ['`pages_messaging`', 'رسائل ماسنجر.'],
                            ] },
                            { warn: 'حتى الرمز الدائم له حد: ميتا توقف **الوصول للبيانات** بعد 90 يوماً من آخر مرة أكّدت فيها الصلاحيات، والرمز يظل مكتوباً عليه **صالح**. لو فجأة وقفت الردود بدون سبب واضح، أصدر الرمز من جديد من ميتا والصقه هنا.' },
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
                    title: { ar: 'تأكد أن الربط شغّال', en: 'Check the connection works' },
                    body: {
                        ar: [
                            { ol: [
                                'جنب **رمز الوصول** مكتوب **صالح**، وما في تنبيه صلاحيات ناقصة.',
                                'من حساب ثاني، علّق بكلمة حملة مفعّلة، وتأكد أن الرسالة وصلت.',
                                'افتح **سجل النشاط**: كل تعليق طابق حملة يظهر هنا مع حالته.',
                            ] },
                            { note: 'التعليق اللي ما يطابق أي حملة ما يُسجَّل أصلاً. يعني غيابه من السجل مو دليل أن الربط خربان؛ تأكد من الكلمة أول.' },
                        ],
                        en: [
                            { ol: [
                                'The **Access token** reads **Valid**, with no missing-permissions warning.',
                                'From another account, comment the keyword of an active campaign and check the DM arrives.',
                                'Open the **Activity Log**: every comment that matched a campaign is listed with its status.',
                            ] },
                            { note: 'A comment that matches no campaign is not recorded at all, so its absence from the log does not mean the connection is broken. Check the keyword first.' },
                        ],
                    },
                },
            ],
        },
        // ─── 3. Keyword campaigns and auto-DMs ───────────────────────────────
        {
            slug: 'campaigns',
            group: 'meta',
            icon: 'megaphone',
            title: { ar: 'حملات الكلمات المفتاحية والرسائل التلقائية', en: 'Keyword campaigns and auto-DMs' },
            summary: {
                ar: 'كيف تُطابَق الكلمة، والرد العلني، وكيف تكتب رسالة خاصة تجيب نتيجة.',
                en: 'How keywords are matched, the public reply, and how to write a DM that gets results.',
            },
            related: ['connect-meta', 'troubleshooting', 'create'],
            sections: [
                {
                    id: 'how',
                    title: { ar: 'كيف تشتغل الحملة؟', en: 'How a campaign works' },
                    body: {
                        ar: [
                            { ol: [
                                'متابع يعلّق على منشورك في إنستجرام أو فيسبوك.',
                                'النظام يدوّر في حملاتك المفعّلة عن كلمة موجودة في تعليقه.',
                                'إذا لقى، يرسل له **قالب الرسالة الخاصة** كرد خاص على تعليقه.',
                                'ويرد على التعليق علناً بواحد من ردودك، إذا كتبت **الردّ العلني على التعليق**.',
                            ] },
                            'أنشئ حملة من **الحملات** ← **حملة جديدة**، أو أضف كذا حملة مرة وحدة من **استيراد من CSV**. وتقدر توقف أي حملة بدون ما تحذفها من مفتاح **تفعيل الحملة**.',
                            '**معرّف المنشور المستهدف** اختياري: إذا حددته (أو اخترته من **اختر منشوراً**)، الحملة تشتغل على تعليقات هذا المنشور بس. وإذا تركته فاضي، تشتغل على كل منشوراتك.',
                        ],
                        en: [
                            { ol: [
                                'Someone comments on your post on Instagram or Facebook.',
                                'AutoReply Pro looks through your active campaigns for a keyword that appears in the comment.',
                                'When one matches, it sends them your **DM template** as a private reply to that comment.',
                                'It also answers the comment in public with one of your replies, if you filled in **Public comment reply**.',
                            ] },
                            'Create one from **Campaigns** → **New campaign**, or add several at once with **Import CSV**. The **Campaign active** switch pauses a campaign without deleting it.',
                            '**Target post ID** is optional. Set it (or choose one with **Pick a post**) and the campaign only answers comments under that post; leave it empty and it works on all your posts.',
                        ],
                    },
                },
                {
                    id: 'matching',
                    title: { ar: 'كيف تُطابَق الكلمات', en: 'How keywords are matched' },
                    body: {
                        ar: [
                            'قبل المقارنة، النظام يوحّد الكتابة في التعليق وفي كلمتك، عشان الفروق الصغيرة ما تضيّع عليك أحد:',
                            { ul: [
                                'الهمزات: «أ» و«إ» و«آ» كلها تصير «ا».',
                                'التاء المربوطة «ة» تصير «ه»، والألف المقصورة «ى» تصير «ي».',
                                'التشكيل ينشال، والتطويل ينشال، فـ«تـــم» هي «تم».',
                                'الحروف الإنجليزية الكبيرة والصغيرة وحدة.',
                            ] },
                            'يعني «دورة» و«دوره» نفس الشي، و«أبغى» و«ابغى» نفس الشي.',
                            '**المطابقة بالاحتواء (الافتراضية):** الحملة تشتغل إذا كانت كلمتك موجودة في أي مكان داخل التعليق، حتى لو كانت جزءاً من كلمة أطول. مريحة، لأن «الكورس» و«كورسك» كلها تطابق «كورس».',
                            '**المطابقة بالكلمة الكاملة:** أدق، لأن الكلمة لازم تجي لحالها مو داخل كلمة ثانية. النظام يدعمها لكل حملة لكنها مو الافتراضية، ونموذج الحملة ما فيه مفتاح لها حالياً؛ إذا احتجتها لحملة معيّنة كلّم مدير المنصة. وانتبه أنها أصرم: «كورس» ما تطابق «الكورس».',
                        ],
                        en: [
                            'Before comparing, AutoReply Pro normalises both the comment and your keyword, so small spelling differences don’t lose you anyone:',
                            { ul: [
                                'Hamza forms: «أ», «إ» and «آ» all become «ا».',
                                'Teh marbuta «ة» becomes «ه», and alef maksura «ى» becomes «ي».',
                                'Diacritics and tatweel are removed, so «تـــم» is «تم».',
                                'Upper and lower case letters are the same.',
                            ] },
                            'So «دورة» and «دوره» are one word, and so are «أبغى» and «ابغى».',
                            '**Substring matching (the default):** the campaign fires when your keyword appears anywhere in the comment, even inside a longer word. Convenient, because «الكورس» and «كورسك» both match «كورس».',
                            '**Whole-word matching:** stricter, because the keyword has to stand on its own. The system supports it per campaign, but it is not the default and the campaign form has no switch for it yet; if you need it for a campaign, ask your platform administrator. Note how strict it is: «كورس» no longer matches «الكورس».',
                        ],
                    },
                },
                {
                    id: 'pitfall',
                    title: { ar: 'فخ «تم» داخل «تمام»', en: 'The «تم» inside «تمام» trap' },
                    body: {
                        ar: [
                            'لأن المطابقة الافتراضية بالاحتواء، الكلمة القصيرة خطر. لو كلمتك «تم» مثلاً، بتطابق «تمام» و«اهتمام» و«يتم»، ويوصل رابطك لناس ما طلبوه. ونفس الشي بالإنجليزي: «ai» تطابق داخل «email» و«said».',
                            'وش تسوي؟',
                            { ul: [
                                'اختر كلمة أطول وأوضح: «كورس» أفضل من «تم»، و«رابط الكورس» أفضل من «رابط».',
                                'أو عبارة من كلمتين، لأن العبارات نادراً تنطبق بالغلط.',
                                'راقب مربع **كيف تُطابَق الكلمات** وأنت تكتب: يعرض لك كلمات حقيقية بتطابقها كلمتك، وينبّهك إذا كانت قصيرة أو مكررة أو تتقاطع مع كلمة حملة ثانية.',
                            ] },
                            { warn: 'إذا كانت كلمة حملة داخل كلمة حملة ثانية (مثل «كورس» و«كورسات»)، التعليق الواحد ممكن يشغّل الحملتين، وما تعرف أي رسالة وصلت. خلّ كل حملة بكلمة مستقلة.' },
                        ],
                        en: [
                            'Because the default is substring matching, a short keyword is dangerous. Take «تم»: it matches «تمام», «اهتمام» and «يتم», so your link goes to people who never asked for it. English has the same problem: “ai” matches inside “email” and “said”.',
                            'What to do instead:',
                            { ul: [
                                'Pick a longer, clearer keyword: «كورس» beats «تم», and “course link” beats “link”.',
                                'Or use a two-word phrase, which rarely matches by accident.',
                                'Watch the **How keywords are matched** box while you type: it shows real words your keyword would also fire on, and warns you when it is too short, listed twice, or overlaps another campaign’s keyword.',
                            ] },
                            { warn: 'When one campaign’s keyword sits inside another’s (say «كورس» and «كورسات»), a single comment can fire both campaigns and you cannot tell which DM arrived. Give every campaign its own distinct keyword.' },
                        ],
                    },
                },
                {
                    id: 'public-reply',
                    title: { ar: 'الرد العلني على التعليق', en: 'The public reply' },
                    body: {
                        ar: [
                            'اختياري، ويبيّن للناس أن الرسالة وصلت، فيشجّع غيرهم يعلّقون.',
                            { ul: [
                                'افصل بين أكثر من صيغة بعلامة `|`، والنظام يختار وحدة عشوائياً كل مرة، عشان تعليقاتك ما تمتلي بنفس الجملة وما تنحسب سبام.',
                                '`{username}` يتبدّل باسم صاحب التعليق.',
                                'مثال: `تم الإرسال! شيّك الخاص 📩 | أرسلت لك الرابط يا {username} 🚀`',
                            ] },
                            { note: 'الرد العلني على فيسبوك يحتاج صلاحية `pages_manage_engagement`. لو كانت ناقصة، الرسالة الخاصة توصل والرد العلني يفشل.' },
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
                    title: { ar: 'كيف تكتب رسالة خاصة تجيب نتيجة', en: 'Writing a DM that works' },
                    body: {
                        ar: [
                            { ul: [
                                'ابدأ بالاسم: `هلا {username} 👋` تخلي الرسالة شخصية.',
                                'أعطه اللي طلبه في أول سطرين: الرابط أو المعلومة، بدون مقدمات طويلة.',
                                'جملة وحدة تقول له وش بيستفيد.',
                                'سؤال في الآخر يفتح محادثة، مثل: «عندك سؤال؟ رد على هالرسالة».',
                                'تبي تقسّمها؟ اكتب `[SPLIT]` بين الأجزاء وتوصل رسائل ورا بعض. الجزء الأول هو الأهم، لأنه هو اللي يفتح المحادثة.',
                            ] },
                            { tip: 'جرّب الرسالة على نفسك من حساب ثاني قبل ما تنشر المنشور.' },
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
                    title: { ar: 'حدود لازم تعرفها', en: 'Limits worth knowing' },
                    body: {
                        ar: [
                            { ul: [
                                'رسالة وحدة لكل شخص كل 24 ساعة، حتى لو علّق بالكلمة خمس مرات.',
                                'حد أقصى 180 رسالة في الساعة لكل حساب، تحت سقف ميتا بهامش أمان. لو انتشر منشورك، الزايد يُسجَّل **فشلت** مع السبب في **سجل النشاط**.',
                                'تعليقاتك أنت على منشوراتك ما تشغّل الحملات، عشان ما يرد النظام على نفسه.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'One DM per person every 24 hours, even if they comment the keyword five times.',
                                'At most 180 DMs an hour per account, safely under Meta’s own ceiling. If a post goes viral, the overflow is recorded as **Failed**, with the reason, in the **Activity Log**.',
                                'Your own comments on your own posts never trigger a campaign, so the system doesn’t answer itself.',
                            ] },
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
                            'من **جدولة المنشورات** ← **جدولة منشور**، اختر **المنصة** وبعدها **نوع المنشور**:',
                            { dl: [
                                ['صورة', 'صورة وحدة.'],
                                ['فيديو / ريل', 'فيديو، ينزل ريل على إنستجرام وفيديو على فيسبوك.'],
                                ['ستوري (إنستجرام فقط)', 'ستوري تختفي بعد 24 ساعة.'],
                                ['نص أو رابط (فيسبوك فقط)', 'منشور نصي أو رابط على صفحة فيسبوك.'],
                                ['كاروسيل (عدة صور)', 'من صورتين إلى عشر صور في منشور واحد.'],
                            ] },
                            'الأنواع اللي ما تنفع على المنصة اللي اخترتها ما تطلع لك في القائمة أصلاً.',
                        ],
                        en: [
                            'In the **Posts Scheduler**, press **Schedule a post**, then choose the **Platform** and the **Post type**:',
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
                            'اختر **المنصتان معاً** وينزل المنشور نفسه على الاثنين بنفس النص.',
                            { ul: [
                                'ينشر على فيسبوك أول، وبعدين إنستجرام.',
                                'لو نجح واحد وفشل الثاني، المنشور يطلع **فشلت** ومعه السبب. ولما تعيد النشر، ينزل على اللي فشل بس، بدون تكرار على اللي نجح.',
                                'تبيه على تيك توك بعد؟ فعّل **أرسله إلى تيك توك أيضاً**، ويصير له منشور مستقل في الطابور. التفاصيل في [[tiktok]].',
                            ] },
                        ],
                        en: [
                            'Choose **Both platforms** and the same post goes to both, with the same caption.',
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
                                '**من 2 إلى 10 صور** على إنستجرام وفيسبوك. (تيك توك يقبل أكثر، لين 35 صورة.)',
                                '**JPEG فقط**، لأن إنستجرام ما يقبل غيرها. تقدر ترفع PNG أو WebP، واللوحة تحوّلها JPEG لحالها، وتصغّر أي صورة أعرض من 1440 بكسل قبل الرفع.',
                                '**الصورة الأولى تحدد القصّ:** إنستجرام يقص كل الشرائح على مقاس الصورة الأولى. خلّ كل الصور بنفس المقاس (مثلاً 4:5 عمودي، 1080×1350) عشان ما ينقص شي من أطرافها.',
                                '**الترتيب هنا هو ترتيب الشرائح.** غيّره بأزرار التقديم والتأخير على كل صورة.',
                                'حجم كل صورة لازم يكون أقل من 3.2 ميجابايت بعد الضغط.',
                                'الكاروسيل صور بس حالياً؛ ما ينفع تحط فيديو كشريحة.',
                            ] },
                            'ولتيك توك تقدر ترفع نسخاً طولية غير من **استخدم صوراً مختلفة لتيك توك (9:16)**، لأن تيك توك يعرض الصور بملء الشاشة.',
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
                            'إنستجرام ياخذ أول لقطة من الفيديو كصورة مصغّرة في شبكة البروفايل. يعني أي فيديو يبدأ من السواد يطلع مربّع أسود.',
                            'في خطوة **الصورة المصغّرة للريل** اضغط **ارفع صورة الغلاف** (أو الصق رابط صورة)، وتشوف قبل النشر كيف بيطلع في الشبكة.',
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
                                'اختر **موعد النشر المطلوب** بتوقيت جهازك، واضغط **جدولة**.',
                                'أو فعّل **انشر فوراً بدل الجدولة** وينزل الحين.',
                                'المُجدوِل يفحص المنشورات المستحقة كل دقيقة، فالمنشور ينزل خلال دقائق من موعده، وتحت كل منشور تشوف متى يُتوقع ينزل.',
                                'ولو توقف الفحص المتكرر لأي سبب، يرجع المُجدوِل لتشغيل واحد في اليوم الساعة 00:00 بتوقيت UTC (3 الفجر بتوقيت الرياض)، وساعتها يُحسب اليوم مو الدقيقة.',
                                'تقدر تعدّل المنشور أو تحذفه ما دام **بالانتظار**.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'Pick the **Requested publish time**, in your device’s time zone, and press **Schedule**.',
                                'Or tick **Publish immediately instead of scheduling** and it goes out now.',
                                'The scheduler checks for due posts every minute, so a post goes out within minutes of its time, and each card tells you when it expects to publish.',
                                'If that frequent check ever stops, the scheduler falls back to one run a day at 00:00 UTC (3am in Riyadh), and then the date is what counts, not the minute.',
                                'You can edit or delete a post while it is **Pending**.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'statuses',
                    title: { ar: 'معنى الحالات', en: 'What each status means' },
                    body: {
                        ar: [
                            'في **طابور الجدولة** كل منشور عليه حالته، واللي نزل تلقاه في **المنشور فعلياً**:',
                            { dl: [
                                ['بالانتظار', 'مجدول وينتظر موعده.'],
                                ['جارٍ النشر', 'قاعد ينرسل الحين لميتا أو تيك توك.'],
                                ['نُشر', 'نزل خلاص.'],
                                ['فشلت', 'ما انحذف شي: المنشور باقي في الطابور ومعه سبب الفشل. أصلح الوسائط أو النص وأعد النشر.'],
                                ['تيك توك يعالج الفيديو', 'تيك توك استلمه ويجهّزه، وعادة ياخذ أقل من دقيقة.'],
                                ['في صندوق تيك توك', 'وصل مسودّاتك في تيك توك، وباقي تنشره أنت من التطبيق.'],
                            ] },
                        ],
                        en: [
                            'Every post in the **Scheduled queue** carries its status, and what has gone live is in the **Published feed**:',
                            { dl: [
                                ['Pending', 'Scheduled and waiting for its time.'],
                                ['Publishing', 'Being sent to Meta or TikTok right now.'],
                                ['Published', 'Live.'],
                                ['Failed', 'Nothing was deleted: the post is still in the queue with the reason it failed. Fix the media or caption and publish again.'],
                                ['TikTok is processing', 'TikTok has it and is preparing it, which usually takes under a minute.'],
                                ['In your TikTok inbox', 'It reached your TikTok drafts, and you post it from the app.'],
                            ] },
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
                ar: 'وش يعني كل رقم في صفحة النمو، وكيف تضيف أذونات الإحصاءات، وكيف تقرأ خطة المدرب.',
                en: 'What each number on the Growth page means, how to add the insights permissions, and how to read the coach’s plan.',
            },
            related: ['seo', 'connect-meta', 'scheduling'],
            sections: [
                {
                    id: 'metrics',
                    title: { ar: 'وش يعني كل رقم؟', en: 'What each number means' },
                    body: {
                        ar: [
                            'كل الأرقام في **الأداء** عن الفترة اللي تختارها فوق: آخر 7 أيام أو 28 أو 90.',
                            { dl: [
                                ['المتابعون', 'كم حساب يتابعك الآن، والفرق عن بداية الفترة.'],
                                ['الوصول', 'كم حساب مختلف شاف منشوراتك. اللي شاف المنشور ثلاث مرات ينحسب مرة وحدة.'],
                                ['المشاهدات', 'كم مرة انعرض محتواك، والمشاهدات المتكررة من نفس الشخص كلها تنحسب.'],
                                ['معدل التفاعل', 'التفاعلات (إعجاب وتعليق وحفظ ومشاركة) مقسومة على الوصول: من اللي شافوا المنشور، كم واحد تفاعل؟'],
                                ['الحفظ', 'كم مرة حفظ الناس منشورك يرجعون له. من أقوى الإشارات أن المحتوى مفيد.'],
                                ['المشاركات', 'كم مرة أرسلوا منشورك لغيرهم. هكذا يوصل محتواك لناس ما يتابعونك.'],
                                ['متوسط المشاهدة', 'كم ثانية يشاهدون ريلزك في المتوسط. أول ثلاث ثوانٍ تقرر يكملون أو يمرّون.'],
                                ['من يراك', 'الوصول مقسوم بين متابعيك وأشخاص جدد. لو أغلبه أشخاص جدد، فإنستجرام يعرض محتواك خارج دائرتك، والمطلوب تخليهم يكملون المشاهدة.'],
                            ] },
                            { note: 'الشرطة «—» معناها أن الرقم ما انقاس، مو أنه صفر. جنبها مكتوب السبب: إذن ناقص، أو ما صارت مزامنة، أو إنستجرام ما يعطي هذا الرقم لحسابك.' },
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
                            'أرقام الوصول والمشاهدات والحفظ والمشاركات تحتاج إذنين في رمز ميتا، غير الأذونات اللي يحتاجها الرد الآلي:',
                            { dl: [
                                ['`instagram_manage_insights`', 'إحصاءات منشورات إنستجرام وحسابك: الوصول والمشاهدات والحفظ والمشاركات ومتوسط المشاهدة.'],
                                ['`read_insights`', 'إحصاءات صفحة فيسبوك ومنشوراتها.'],
                            ] },
                            'لو ناقصين، يظهر تنبيه فوق صفحة **النمو والتسويق** يسمّيهم. الحل رمز جديد فيه كل الأذونات:',
                            { ol: [
                                'افتح أداة Graph API Explorer في حساب المطوّر عند ميتا، واختر تطبيقك.',
                                'اختر رمز مستخدم، وفعّل الإذنين فوق **مع كل الأذونات اللي عندك الآن**، واضغط إنشاء الرمز.',
                                'حوّله إلى رمز صفحة دائم بنفس الطريقة اللي سويتها أول مرة: [[connect-meta#token-health]].',
                                'في **الإعدادات** الصق الرمز الجديد في **تحديث رمز الوصول** واضغط **تحقّق واحفظ**.',
                                'ارجع لصفحة **النمو والتسويق** واضغط **مزامنة**.',
                            ] },
                            { warn: 'ركّب الرمز الجديد قبل ما تلغي القديم. ميتا ما تلغي الرمز القديم لما تصدر جديد، فالرد الآلي يظل شغّال طول الوقت.' },
                            { tip: 'مقارنة المنافسين تستخدم ميزة Business Discovery في إنستجرام، ولو رمزك ما يسمح بها يظهر لك تنبيه في قسم **المنافسون** نفسه.' },
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
                            'إنستجرام ما يعطي بعض الأرقام إلا بعد ما يوصل حسابك 100 متابع: خط المتابعين اليومي، وكم تابعك وكم ألغى، وتوزيع جمهورك، وأوقات تواجد متابعيك.',
                            'هذا مو خطأ ولا إذن ناقص. تشوف مكانها ملاحظة هادئة، وعدد متابعيك نفسه يظل ظاهراً، والوصول والمشاهدات متاحة من أول يوم.',
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
                            'الخريطة مبنية على **منشوراتك أنت**: كل منشور يقع في يومه وساعته بتوقيت حسابك، والمربع الأغمق هو الساعة اللي أعطت منشوراتها أكثر مشاهدات في المتوسط. لو الإحصاءات مقفلة، تُبنى من الإعجابات والتعليقات بدالها.',
                            { ul: [
                                'التوقيت هو توقيت الجمهور المحفوظ للحساب، ولو ما فيه توقيت محفوظ فتوقيت متصفحك، ومكتوب تحت الخريطة أيهما.',
                                'المربع الفاضي معناه أنك ما نشرت في هذه الساعة، مو أنها ساعة سيئة.',
                                'مع منشورات قليلة، منشور واحد ناجح يلوّن ساعته. انشر في أوقات مختلفة وتتضح الصورة.',
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
                            'اضغط **اكتب لي خطة** في **مدرب النمو الذكي**. يقرأ أرقام الفترة ونصوص منشوراتك وإعداداتك، ويكتب بلغة حسابك. تأخذ عادةً أقل من دقيقة، وتقدر تطلع من الصفحة وترجع تلقاها جاهزة.',
                            { dl: [
                                ['الملخص', 'جملتين عن وضعك الآن.'],
                                ['ما الذي ينجح / ما الذي يعيقك', 'أشياء محددة من منشوراتك، مو نصائح عامة.'],
                                ['افعل هذه أولاً', 'خطوات مرتبة: الأكبر أثراً أولاً، ولو تساوى الأثر فالأقل جهداً. شارة **الأثر** و**الجهد** على كل خطوة.'],
                                ['تجارب تستحق المحاولة', 'فرضية، وكيف تجرّبها، وكيف تقيس النتيجة. جرّب تغييراً واحداً كل مرة عشان تعرف وش اللي أثّر.'],
                            ] },
                            { note: 'لو الأرقام مقفلة، المدرب يشتغل من تاريخ منشوراتك ونصوصها ويقول لك وش ما يقدر يشوفه. وتذكّر أنها مكتوبة بالذكاء الاصطناعي: قارنها بأرقامك قبل ما تعمل بها.' },
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
                            'الأرقام تتحدّث تلقائياً مرة في اليوم. لو تبيها الآن اضغط **مزامنة**، ومسموح مرة كل عشر دقائق. تحت الزر مكتوب متى كانت آخر مزامنة.',
                            'تيك توك ما تُقرأ أرقامه بعد: تطبيق تيك توك يحتاج صلاحيات إضافية أولاً، والصفحة تقول ذلك بدل ما تعرض أصفاراً.',
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
                ar: 'كيف يلقاك الناس في البحث: الكلمات في أول سطر، والنص على الشاشة، والوسوم، والريلز التجريبية، والمنشورات المشتركة، والاستمرارية. ومعها النص البديل لمن لا يرى الصورة.',
                en: 'How people find you in search: keywords in the first line, on-screen text, hashtags, trial reels, collab posts and posting consistency. Plus alt text, for people who can’t see the image.',
            },
            related: ['growth', 'scheduling', 'create'],
            sections: [
                {
                    id: 'keywords',
                    title: { ar: 'الكلمات في أول سطر', en: 'Keywords in the first line' },
                    body: {
                        ar: [
                            'بحث إنستجرام وتيك توك يقرأ نص المنشور، وأهم جزء فيه أول سطر. حط كلمة أو كلمتين يكتبها جمهورك فعلاً، بشكل طبيعي في جملة، مو قائمة كلمات.',
                            { ul: [
                                'احفظ كلماتك في **السيو والوصول** ← **الكلمات المفتاحية**. كاتب الاستوديو يستخدمها في أول سطر من نصوص الكاروسيل.',
                                'زر **اقترح** يعطيك أفكاراً من الذكاء الاصطناعي عن موضوع تكتبه. هي أفكار، مو أرقام بحث: جرّب كل كلمة في بحث إنستجرام وشوف وش يطلع قبل ما تعتمدها.',
                                'اكتب الكلمة بالطريقة اللي يكتبها جمهورك: «ذكاء اصطناعي» غير «AI»، وكثير يبحثون بالعربي.',
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
                            'المنصات تقرأ الكلام المكتوب على الفيديو والصورة، وتيك توك يسمع الكلام المنطوق بعد. قل كلمتك في أول ثوانٍ واكتبها على الشاشة، وخلّها في عنوان أول شريحة من الكاروسيل.',
                            { tip: 'النص الكبير في أول ثانية يخدم مرتين: البحث يقرأه، واللي يمرّ بسرعة يعرف عن وش الفيديو فيوقف.' },
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
                                'في **جدولة منشور** يظهر حقل **النص البديل** للصورة، وحقل لكل شريحة في الكاروسيل، بنفس ترتيب الشرائح. الحد 200 حرف.',
                                'صف اللي فعلاً في الصورة: «شاشة محادثة مع وكيل ذكي يكتب خطة من ثلاث خطوات»، مو «أفضل كورس ذكاء اصطناعي».',
                                'حط كلمتك لو تناسب الوصف، وبدون وسوم.',
                                'النص البديل للصور والكاروسيل على إنستجرام. الريلز ما تأخذ نصاً بديلاً.',
                            ] },
                            { note: 'الاستوديو يكتب نصاً بديلاً لكل شريحة لما يتوفر، وتشوفه تحت معاينة الجوال في محرر الكاروسيل.' },
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
                            'الوسوم الكثيرة ما عادت ترفع الوصول. استخدم من 3 إلى 5 وسوم محددة تصف موضوع المنشور، بدل ثلاثين وسماً عاماً مثل «اكسبلور».',
                            { ul: [
                                'في **مجموعات الوسوم** احفظ مجموعة لكل موضوع تنشر عنه، واضغط **انسخ** وقت الكتابة.',
                                'المجموعة اللي فيها أكثر من 5 وسوم تنعلّم لك عشان تختصرها.',
                                'الوسم المحدد («برومبتات_للطلاب») يوصلك لناس يدورون موضوعك بالضبط؛ العام يضيع بين ملايين المنشورات.',
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
                            'الريل التجريبي يظهر أولاً لناس ما يتابعونك، وما يظهر لمتابعيك ولا في شبكة حسابك. تعرف منه هل الفكرة تجذب جمهوراً جديداً بدون ما تخاطر بمتابعيك.',
                            { dl: [
                                ['أقرر بنفسي متى تظهر للمتابعين', 'تشوف أرقامه، وتقرر أنت من إنستجرام هل تشاركه مع متابعيك.'],
                                ['تظهر للمتابعين تلقائياً إذا نجحت', 'إنستجرام يشاركه مع متابعيك بنفسه لو أداؤه كان جيداً.'],
                            ] },
                            'فعّله من **انشرها ريلز تجريبية** لما يكون المنشور فيديو على إنستجرام.',
                            { note: 'إنستجرام ما يتيح الريلز التجريبية لكل الحسابات. لو رفضها لحسابك، الريل ينشر بشكل عادي وتنكتب الملاحظة على المنشور.' },
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
                            'في حقل **المتعاونون** اكتب حتى 3 حسابات. كل حساب يوصله طلب، ولو قبل يظهر المنشور في حسابه وحسابك، ولجمهوركما معاً.',
                            { ul: [
                                'أفضل تعاون مع حساب جمهوره قريب من جمهورك، مو بالضرورة الأكبر.',
                                'اكتب اسم المستخدم كما هو، مثل `@partner`. الحسابات لازم تكون عامة.',
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
                            'المنصات تكافئ الحساب اللي ينشر بانتظام. جدول ثابت يناسبك أفضل من دفعة كبيرة ثم غياب.',
                            { ul: [
                                'اختر وقتين أو ثلاثة من **أفضل أوقات النشر** والتزم بها، والاستوديو يقترح مواعيد من جدولك.',
                                'قيّم التغيير على 28 يوماً، مو على منشور واحد.',
                                'غيّر شيئاً واحداً كل مرة، مثل تجارب المدرب، عشان تعرف وش اللي أثّر.',
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
                ar: 'كيف تربط تيك توك، وليش المنشورات تنزل «أنا فقط» لين يعتمد تيك توك التطبيق، وكيف تخليها عامة.',
                en: 'How to connect TikTok, why posts go up as “Only me” until TikTok approves the app, and how to make them public.',
            },
            related: ['studio-schedule', 'scheduling', 'troubleshooting'],
            sections: [
                {
                    id: 'connect',
                    title: { ar: 'ربط تيك توك', en: 'Connecting TikTok' },
                    body: {
                        ar: [
                            { ol: [
                                'افتح **الإعدادات** ← قسم **تيك توك** واضغط **ربط تيك توك**. (الزر يظهر لمالك الحساب فقط.)',
                                'يفتح لك تيك توك: سجّل دخولك بالحساب اللي تبي تنشر عليه، ووافق على الصلاحيات.',
                                'ترجع للإعدادات وتشوف اسم الحساب وجنبه **متصل**، وتحته **طريقة النشر** الحالية.',
                            ] },
                            { ul: [
                                'الربط يدوم **سنة وحدة**. قبل ما يخلص تشوف تاريخاً وتنبيهاً، فاضغط **إعادة الربط** قبل ذاك اليوم.',
                                'لو شفت **يحتاج إلى إعادة الربط**، اضغط **إعادة الربط** وبس. منشوراتك المجدولة تظل في الطابور.',
                                '**فصل تيك توك** يلغي صلاحية التطبيق عند تيك توك ويحذف الربط. المنشورات المجدولة تبقى، لكنها ما تنرسل لين تربط من جديد.',
                            ] },
                        ],
                        en: [
                            { ol: [
                                'Open **Settings**, go to the **TikTok** section and press **Connect TikTok**. (Only the account owner sees this button.)',
                                'TikTok opens: sign in with the account you want to post to, and approve the permissions.',
                                'Back in Settings you’ll see the account name marked **Connected**, and the current **Posting mode** under it.',
                            ] },
                            { ul: [
                                'A connection lasts **one year**. Before it runs out you’ll see a date and a warning: press **Reconnect** before that day.',
                                'If you see **Needs reconnecting**, just press **Reconnect**. Your scheduled posts stay in the queue.',
                                '**Disconnect TikTok** revokes the app’s access with TikTok and deletes the connection. Scheduled posts stay, but nothing is sent until you connect again.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'before-approval',
                    title: { ar: 'قبل ما يعتمد تيك توك التطبيق', en: 'Until TikTok approves the app' },
                    body: {
                        ar: [
                            'تيك توك يراجع أي تطبيق ينشر نيابة عن الناس. ولين ما يعتمد تطبيقنا، هذي القواعد تنطبق على كل منشور:',
                            { ul: [
                                '**النشر المباشر ينزل بخصوصية «أنا فقط»:** المنشور يوصل حسابك، بس محد يشوفه غيرك.',
                                '**حسابك لازم يكون خاصاً وقت النشر.** تيك توك يرفض منشورات هالتطبيق إذا كان الحساب عاماً.',
                                'بعد ما ينزل المنشور، أنت اللي تخليه عاماً من تطبيق تيك توك.',
                            ] },
                            'كيف تخلي المنشور عاماً:',
                            { ol: [
                                'انتظر لين تنزل كل منشوراتك، وحسابك باقي خاص.',
                                'رجّع حسابك عاماً من إعدادات الخصوصية في تيك توك.',
                                'افتح كل منشور في تطبيق تيك توك، واضغط **⋯** (النقاط الثلاث).',
                                'اختر **الخصوصية** (Privacy)، وبعدها **الجميع** (Everyone).',
                            ] },
                            { tip: 'في الاستوديو، كل كاروسيل فيه خانة **جُعل عامّاً على تيك توك**: تذكير لك تأشّر عليه بعد ما تخليه عاماً. ما يغيّر شي في تيك توك نفسه.' },
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
                            'الخيار الثاني في منشئ المنشورات هو **أرسله إلى مسودّاتي في تيك توك (صندوق الوارد)**: المنشور يوصل مسودّاتك، وتكمله وتنشره أنت من التطبيق.',
                            { warn: 'هذا الوضع ما يُعتمد عليه: الإشعار أحياناً ما يوصل، والمسودّة أحياناً ما تظهر، وتيك توك ما يسمح بأكثر من 5 مسودّات معلّقة كل 24 ساعة. ننصحك بالنشر المباشر: **انشره مباشرة في حسابي**.' },
                            'ولو وصلت حد المسودّات، المنشور ما يفشل: يرجع **بالانتظار** ومعه السبب، وينرسل بعدين لما تنشر وحدة من مسودّاتك.',
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
                    title: { ar: 'بعد ما يعتمد تيك توك التطبيق', en: 'Once TikTok approves the app' },
                    body: {
                        ar: [
                            { ul: [
                                'المنشورات تنزل **عامة تلقائياً**، بالخصوصية اللي تختارها، وما تحتاج تخلي حسابك خاصاً.',
                                'في الاستوديو يظهر خيار **النشر على تيك توك في الموعد نفسه**، فينزل مع منشور إنستجرام بدون دفعة يدوية.',
                                'وزر **انشر كاروسيل تيك توك المنتظرة** يختفي، لأنه ما عاد له داعي.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'Posts go up **public automatically**, with the privacy you choose, and your account no longer has to be private.',
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
                                'تيك توك يقبل منشور صور (كاروسيل) من صورتين لين 35 صورة، JPEG أو WebP.',
                                'يعرض الصور بملء الشاشة 9:16، فالأفضل ترفع نسخاً طولية من **استخدم صوراً مختلفة لتيك توك (9:16)**. والاستوديو يرسم لتيك توك نسخة 9:16 خاصة لحاله.',
                                '**عنوان تيك توك** حده 90 حرفاً، ويتعبّى من أول سطر في النص، وتقدر تعدّله.',
                                '**إضافة موسيقى تلقائياً** مفعّلة افتراضياً، وتيك توك يختار موسيقى تناسب الصور.',
                                'قبل النشر لازم تأشّر على **أوافق على نشر هذا المنشور على حسابي في تيك توك**. هذا شرط من تيك توك نفسه.',
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
                            'تيك توك ما يسمح برسائل خاصة تلقائية لأصحاب التعليقات، فحملات الكلمات المفتاحية ما تشتغل هناك. عشان كذا نصوص تيك توك توجّه المتابع للرابط في البايو:',
                            { ul: [
                                'الاستوديو يضيف **سطر نص تيك توك** من إعداداته لكل وصف، مثل: «الكورس كامل بالعربي، رابطه في البايو».',
                                'والشريحة الأخيرة في نسخة تيك توك تقول نفس الكلام.',
                            ] },
                            { warn: 'تأكد أن الرابط موجود فعلاً في البايو. تيك توك ما يعطي خانة **الموقع الإلكتروني** في الملف الشخصي لكل الحسابات: عادة لحسابات الأعمال، أو للحسابات اللي تعدّت عدداً من المتابعين (غالباً 1000)، والشرط يختلف من بلد لبلد. افتح **تعديل الملف الشخصي** في تيك توك وتأكد أن الخانة موجودة عندك قبل ما تنشر.' },
                        ],
                        en: [
                            'TikTok doesn’t allow automatic DMs to commenters, so keyword campaigns can’t run there. That is why TikTok captions point people to the link in your bio:',
                            { ul: [
                                'The Studio adds the **TikTok caption line** from its settings to every description, such as “The full course, link in bio”.',
                                'The last slide of the TikTok version says the same.',
                            ] },
                            { warn: 'Make sure the link really is in your bio. TikTok doesn’t give every account a **Website** field on the profile: typically business accounts get it, or accounts past a follower count (often 1,000), and the rule varies by country. Open **Edit profile** in TikTok and check you have the field before you post.' },
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
                ar: 'من درس مصوّر إلى كاروسيل مجدول في ثلاث خطوات، ومين يسوّي وش.',
                en: 'From a recorded lesson to a scheduled carousel in three steps, and who does what.',
            },
            related: ['worker', 'create', 'studio-schedule'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'وش هو الاستوديو؟', en: 'What the Studio is' },
                    body: {
                        ar: [
                            'الاستوديو يكتب لك منشورات كاروسيل من دروسك المصوّرة: يقرأ الدرس، ويكتب الشرائح بأسلوبك، ويختار لقطات من الفيديو، ويجهّز نص إنستجرام ووصف تيك توك، والكلمة المفتاحية، والرسالة الخاصة.',
                            'ويرسم كل كاروسيل بمقاسين: **إنستجرام 4:5** و**تيك توك 9:16**. وما ينشر شي بدون ما تراجعه وتضغط **جدولة** بنفسك.',
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
                                '**اختر الموضوع:** في **كاروسيل جديد** اختر **من درس** (لين ثلاثة دروس مفهرسة) أو **من فكرة** تكتبها بجملة أو جملتين.',
                                '**أنشئ:** اضغط **أنشئ الكاروسيل**. الكتابة تاخذ دقيقة تقريباً (ولين دقيقتين)، وبعدها العامل يرسم الشرائح. تقدر تطلع من الصفحة، والمسودّة تنتظرك في **المسودات**.',
                                '**راجع وجدوِل:** افتح المسودّة، شيّك الشرائح في المعاينة، عدّل اللي تبي واضغط **احفظ وحدّث المعاينة**. بعدها **إلى الجدولة**، اختر الموعد، واضغط **جدولة**.',
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
                    title: { ar: 'مين يسوّي وش؟', en: 'Who does what' },
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
                            'أول ما تفتح الاستوديو تشوف **جهّز مكتبة الدروس**: ثلاث خطوات تسويها مرة وحدة بس.',
                            { ol: [
                                '**اختر مجلد فيديوهات الدروس:** مسار المجلد على جهازك، في **الإعدادات** داخل الاستوديو.',
                                '**اربط العامل على جهاز الماك:** أنشئ عاملاً، والصق رمزه في إعدادات العامل على جهازك. الطريقة في [[worker#install]].',
                                '**افحص الدروس وفهرسها:** **فحص المكتبة**، وبعدها فهرسة الدروس. التفاصيل في [[library]].',
                            ] },
                            { tip: 'ما تبي تنتظر؟ تقدر تكتب **من فكرة** الحين حتى قبل ما تجهز المكتبة، والعامل يرسم الشرائح أول ما يتصل.' },
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
                            '**خطّط أسبوعي** يقترح لك عدة كاروسيل للأسبوع مع مواعيدها. استبعد اللي ما يعجبك، واضغط **إنشاء الكل**، وتنكتب وحدة ورا الثانية.',
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
                ar: 'برنامج صغير على جهازك يسوّي الشغل الثقيل جنب فيديوهاتك: ليش موجود، ووش يوصل له، وكيف تشغّله وتوقفه، وليش هو آمن.',
                en: 'A small helper program on your computer that does the heavy work next to your videos: why it exists, what it can reach, how to start and stop it, and why it is safe.',
            },
            related: ['library', 'studio-settings', 'troubleshooting'],
            sections: [
                {
                    id: 'simple',
                    title: { ar: 'باختصار', en: 'In short' },
                    body: {
                        ar: [
                            'العامل برنامج صغير يشتغل على جهازك، جنب فيديوهات دروسك، ويسوّي الشغل الثقيل عن الاستوديو: يدوّر على الدروس في مجلدك، ويتفرّج على كل درس ويطلع منه ملاحظات ولقطات، ويرسم شرائح الكاروسيل.',
                            'فكّر فيه كمساعد قاعد عند جهازك: الاستوديو يعطيه المهام، وهو ينفّذها ويرجّع النتيجة. ولو طفّيت الجهاز، المهام تنتظره لين يرجع، وما يضيع شي.',
                            { note: 'العامل حالياً يشتغل على أجهزة **ماك**.' },
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
                    title: { ar: 'ليش العامل موجود؟', en: 'Why it exists' },
                    body: {
                        ar: [
                            { ul: [
                                '**فيديوهاتك كبيرة:** رفع ساعات فيديو لأي خادم ياخذ وقتاً طويلاً ويستهلك الإنترنت. العامل يشتغل عليها وهي في مكانها.',
                                '**الرسم يحتاج جهازاً:** رسم الشرائح بالخطوط والألوان واللقطات يحتاج متصفحاً وأدوات فيديو، وهذا ما ينفع على خوادم الويب الخفيفة.',
                                '**خصوصيتك:** فيديوهاتك الأصلية ما تطلع من جهازك أبداً.',
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
                    title: { ar: 'وش يسوّي بالضبط؟', en: 'What it actually does' },
                    body: {
                        ar: [
                            { dl: [
                                ['فحص المكتبة', 'يدوّر على فيديوهات الدروس في المجلد اللي حددته، ويقرأ مدة كل واحد.'],
                                ['فهرسة درس', 'يسوّي نسخة صغيرة من الدرس، ويخلي ذكاء Google (Gemini) يتفرّج عليها ويكتب ملاحظاتها ويختار من 12 إلى 30 لقطة، وبعدين يصوّر كل لقطة بصورة مصغّرة. التفاصيل في [[library]].'],
                                ['رسم الكاروسيل', 'يطلّع لقطات الشرائح من الفيديو الأصلي بجودة كاملة، ويرسم كل شريحة بمقاس إنستجرام وتيك توك، ويرفع الصور لحسابك.'],
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
                    title: { ar: 'وش يقدر يوصل له، ووش ما يقدر؟', en: 'What it can and can’t access' },
                    body: {
                        ar: [
                            '**يقدر:**',
                            { ul: [
                                'يقرأ الفيديوهات داخل مجلد الكورس اللي كتبته في ملف إعداداته (`courseRoot`) بس. ومجلد المكتبة في إعدادات الاستوديو لازم يكون داخل هذا المجلد، وأي مسار برّاه ينرفض.',
                                'يكتب ملفات مؤقتة داخل مجلده هو (النسخ الصغيرة واللقطات)، وتقدر تحذفها متى ما حبيت.',
                                'يكلّم أوتوريبلاي برو، ويكلّم Google Gemini وقت الفهرسة.',
                            ] },
                            '**ما يقدر:**',
                            { ul: [
                                'ما يقرأ أي ملف برّا مجلد الكورس: لا صورك ولا مستنداتك ولا غيرها.',
                                'ما يستقبل أي اتصال من الإنترنت، فمحد يقدر يدخل جهازك عن طريقه.',
                                'ما ينشر ولا يرسل رسائل بنفسه. النشر والجدولة في حسابك هنا، وبقرارك أنت.',
                                'ما يشوف مهام الحسابات الثانية، يشوف مهام حسابك بس.',
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
                                '**يتصل للخارج بس:** العامل هو اللي يسأل «فيه مهام لي؟» كل كم ثانية (كل 5 ثوانٍ وهو مشغول، ولين 30 ثانية وهو فاضي). ما يفتح أي منفذ على جهازك، وما في شي على جهازك ظاهر للإنترنت.',
                                '**رمز خاص لكل عامل:** كل عامل له رمزه، مربوط بحسابك أنت بس. الرمز يظهر لك مرة وحدة لما تنشئه، وإحنا نحفظ بصمة مشفّرة منه، مو الرمز نفسه.',
                                '**تلغيه بضغطة:** من إعدادات الاستوديو ← **العمّال** ← **إلغاء**، والرمز ينرفض من اللحظة نفسها.',
                                '**بس نسخ صغيرة تروح لـ Google:** للفهرسة، العامل يسوّي نسخة صغيرة وخفيفة من الدرس (عرض 640 بكسل، لقطة وحدة كل ثانية، وصوت أحادي)، ويرفعها لـ Gemini، ويحذفها أول ما يخلص. ولو فشل الحذف لأي سبب، Google يحذفها لحاله خلال 48 ساعة. الفيديو الأصلي ما يطلع من جهازك.',
                                'اللي يوصل حسابك في أوتوريبلاي برو: صور مصغّرة للقطات (480 بكسل)، والشرائح المرسومة، لأنها هي اللي تنشر.',
                                'ملف الإعدادات `studio.config.json` فيه رمز العامل ومفتاح Gemini، فخلّه لك ولا تشاركه مع أحد. سكربت التثبيت يقفله على مستخدمك لحاله.',
                            ] },
                            { note: 'مفتاح Gemini اللي في العامل مفتاحك أنت، وتنطبق عليه شروط Google. شوف [[ai-usage#billing|ليش الفوترة مهمة]] قبل ما تفهرس دروساً فيها معلومات خاصة.' },
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
                            'تحتاج: ماك فيه **Node 22** أو أحدث، و**ffmpeg** (`brew install ffmpeg`)، ومجلد العامل على جهازك وفيه تشغيل `npm install`.',
                            { ol: [
                                'من الاستوديو ← **الإعدادات** ← **العمّال**: اكتب اسماً في **عامل جديد** (مثلاً «ماك الاستوديو») واضغط **إنشاء عامل**. انسخ الرمز الحين لأنه ما يظهر مرة ثانية، واضغط **نسخته**.',
                                'في مجلد العامل، انسخ ملف المثال وعبّه: `cp studio.config.example.json studio.config.json`. اكتب فيه رابط التطبيق (`appUrl`)، والرمز (`token`)، ومفتاح Gemini (`geminiApiKey`)، ومجلد الكورس (`courseRoot`)، واسم العامل (`name`).',
                                'ثبّته عشان يشتغل لحاله كل ما تسجّل دخولك للماك، بالأمر اللي تحت.',
                                'ارجع للاستوديو، وخلال ثوانٍ تشوف **العامل متصل**.',
                            ] },
                            { code: 'scripts/install-studio-worker.sh', caption: 'التثبيت والتشغيل (ويشتغل مع كل تسجيل دخول)' },
                            'أوامر تحتاجها بعدين، تكتبها في الطرفية (Terminal) من داخل مجلد العامل:',
                            { code: "launchctl print gui/$(id -u)/com.aicourse.studio-worker | grep -E 'state|pid'", caption: 'هل هو شغّال؟' },
                            { code: 'launchctl kickstart -k gui/$(id -u)/com.aicourse.studio-worker', caption: 'إعادة التشغيل' },
                            { code: 'launchctl bootout gui/$(id -u)/com.aicourse.studio-worker', caption: 'إيقاف مؤقت (يرجع مع أول تسجيل دخول، أو شغّل سكربت التثبيت)' },
                            { code: 'scripts/uninstall-studio-worker.sh', caption: 'إلغاء التثبيت نهائياً' },
                            { code: 'tail -f ~/Library/Logs/aicourse-studio-worker.log', caption: 'السجل: وش قاعد يسوّي الحين' },
                            { code: 'node scripts/studio-worker.mjs', caption: 'تشغيل يدوي بدون تثبيت (Ctrl‑C يوقفه، وينتظر لين 15 ثانية يخلص المهمة اللي بيده)' },
                            { tip: 'غيّرت نسخة Node أو نقلت مجلد العامل؟ شغّل سكربت التثبيت مرة ثانية.' },
                        ],
                        en: [
                            'You need: a Mac with **Node 22** or later, **ffmpeg** (`brew install ffmpeg`), and the worker folder on your computer with `npm install` run in it.',
                            { ol: [
                                'In the Studio, open **Settings** → **Workers**: type a name under **New worker** (such as “Studio Mac”) and press **Create worker**. Copy the token now, because it is never shown again, then press **I’ve copied it**.',
                                'In the worker folder, copy the example config and fill it in: `cp studio.config.example.json studio.config.json`. Set the app address (`appUrl`), the token (`token`), your Gemini key (`geminiApiKey`), the course folder (`courseRoot`) and the worker’s name (`name`).',
                                'Install it so it starts on its own whenever you log in to the Mac, with the command below.',
                                'Back in the Studio, within seconds you’ll see **Worker online**.',
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
                            { dl: [
                                ['العامل متصل', 'تواصل مع الاستوديو خلال آخر 90 ثانية. كل شي يمشي.'],
                                ['العامل غير متصل', 'ما تواصل من أكثر من 90 ثانية، وتحتها **آخر ظهور** يقول لك متى كانت آخر مرة.'],
                                ['لم يتصل بعد', 'أنشأت العامل بس ما اشتغل ولا مرة. تأكد من الرمز في ملف الإعدادات.'],
                            ] },
                            'وهو غير متصل تقدر تكتب كاروسيل عادي، لأن الكتابة تصير على الخادم. اللي ينتظره: الفحص والفهرسة ورسم الشرائح، وتشوف عددها في **بالانتظار**. ولما يرجع، يكمّلها لحاله. وزر **تحقّق مرة أخرى** يفحص الحالة الحين.',
                        ],
                        en: [
                            { dl: [
                                ['Worker online', 'It checked in with the Studio within the last 90 seconds. All good.'],
                                ['Worker offline', 'Nothing from it for more than 90 seconds. **Last seen** underneath says when it last checked in.'],
                                ['Never connected', 'The worker exists but has never run. Check the token in its config file.'],
                            ] },
                            'While it is offline you can still write carousels, because writing happens on the server. What waits for it is scanning, indexing and drawing the slides, counted under **Waiting**. When it is back, it picks them up on its own. **Check again** refreshes the status right away.',
                        ],
                    },
                },
                {
                    id: 'sleep',
                    title: { ar: 'لما ينام الجهاز', en: 'When the computer sleeps' },
                    body: {
                        ar: [
                            { ul: [
                                'لما ينام الماك (أو تسكّر غطاء اللابتوب)، العامل ينام معه، وبعد 90 ثانية يطلع **العامل غير متصل**. المهام تنتظر في الطابور وما يضيع شي.',
                                'ولما يصحى الجهاز، يكمّل لحاله بدون ما تسوي شي.',
                                'لو نام في نص مهمة، وما وصل منها خبر 15 دقيقة، الاستوديو يرجّعها للطابور ويعطيها للعامل من جديد. المهمة الوحدة تنعطى 3 مرات كحد أقصى، وبعدها تفشل مع رسالة توجّهك للسجل.',
                            ] },
                            { tip: 'عندك فهرسة طويلة؟ خلّ الماك صاحياً: افتح الطرفية واكتب `caffeinate -i` واتركها مفتوحة لين تخلص (Ctrl‑C يوقفها). وإذا لابتوب، خلّه على الشاحن ولا تسكّر الغطاء.' },
                        ],
                        en: [
                            { ul: [
                                'When the Mac sleeps (or you close the laptop lid), the worker sleeps with it, and after 90 seconds the Studio shows **Worker offline**. Jobs wait in the queue; nothing is lost.',
                                'When the computer wakes, the worker carries on by itself.',
                                'If it fell asleep in the middle of a job and the job has not reported in for 15 minutes, the Studio puts it back in the queue and hands it out again. A job is handed out 3 times at most, then it fails with a message pointing you to the log.',
                            ] },
                            { tip: 'Long indexing run ahead? Keep the Mac awake: open Terminal, type `caffeinate -i` and leave it open until it finishes (Ctrl-C stops it). On a laptop, keep it plugged in with the lid open.' },
                        ],
                    },
                },
                {
                    id: 'several',
                    title: { ar: 'أكثر من عامل', en: 'Several workers' },
                    body: {
                        ar: [
                            { ul: [
                                'تقدر تربط أكثر من عامل بنفس الحساب، مثل ماك ثاني. أنشئ عاملاً مستقلاً لكل جهاز، فيصير لكل واحد رمزه، وتقدر تلغي أي واحد لحاله.',
                                'المهام تروح لأول عامل فاضي يطلبها، والشارة في الاستوديو تعرض آخر عامل تواصل.',
                                'مهم: مسارات الدروس تنحفظ من الجهاز اللي فحص المكتبة. يعني أي عامل ثاني لازم تكون عنده نفس الفيديوهات وبنفس المسار، وإلا بتفشل مهامه. الأسهل: عامل واحد للفهرسة والرسم.',
                                'على الجهاز الواحد، عامل واحد بس لكل ملف إعدادات. لو شغّلت ثاني، يكتب `another studio worker is running` ويطلع.',
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
                ar: 'كيف يلقى العامل دروسك، ووش معنى «مفهرس»، ووش هي «اللقطة»، وكم تاخذ الفهرسة.',
                en: 'How the worker finds your lessons, what “indexed” means, what a “moment” is, and how long indexing takes.',
            },
            related: ['worker', 'create', 'troubleshooting'],
            sections: [
                {
                    id: 'folder',
                    title: { ar: 'رتّب مجلد الدروس', en: 'Organise your lesson folder' },
                    body: {
                        ar: [
                            'العامل يدوّر على الدروس في **مجلد المكتبة** اللي تحدده في إعدادات الاستوديو. رتّبه كذا:',
                            { ul: [
                                'مجلد لكل قسم، واسمه فيه رقم مثل «Chapter 1» أو «Module 3 - Basics». أول رقم في الاسم هو رقم القسم.',
                                'رقم الدرس في آخر اسم الملف: `context pyramid 1.2.mp4` هو الدرس 1.2.',
                                'فيديو بدون رقم ينحسب مقدمة القسم.',
                                'الصيغ المقبولة: mp4 و mov و m4v.',
                                'الفيديوهات اللي مرمية مباشرة في المجلد الرئيسي، أو في مجلدات `marketing` و`out`، ما تنحسب دروساً.',
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
                            'اضغط **فحص المكتبة** في أعلى صفحة **الكاروسيل**. العامل يدوّر على الفيديوهات ويضيفها دروساً بحالة **غير مفهرس بعد**. الفحص ما يحذف أي درس، ولو أضفت فيديوهات بعدين افحص مرة ثانية.',
                            'ولو الزر معطّل ومكتوب **لم يُحدَّد مجلد المكتبة**، اضغط **حدّده من الإعدادات**.',
                        ],
                        en: [
                            'Press **Scan library** at the top of the **Carousels** screen. The worker finds the videos and adds them as lessons marked **Not indexed yet**. A scan never deletes a lesson; add more videos later and simply scan again.',
                            'If the button is disabled with **No library folder is set**, press **Set it in Settings**.',
                        ],
                    },
                },
                {
                    id: 'indexing',
                    title: { ar: 'وش يعني «مفهرس»؟', en: 'What “indexed” means' },
                    body: {
                        ar: [
                            'الفهرسة إن الذكاء الاصطناعي يتفرّج على الدرس مرة وحدة ويكتب عنه:',
                            { ul: [
                                'ملخصاً قصيراً.',
                                '**ما يعلّمه الدرس**: النقاط الأساسية.',
                                'البرومبتات اللي ظهرت على الشاشة، بحروفها.',
                                'الأدوات اللي استُخدمت، والنتائج اللي انعرضت.',
                                'من 12 إلى 30 **لقطة**.',
                            ] },
                            'الكاروسيل ينكتب من هذي الملاحظات، عشان كذا ما تقدر تختار إلا الدروس المفهرسة. والملاحظات هي اللي تمنع الذكاء من اختراع ميزات أو أرقام ما قلتها.',
                            'ابدأ الفهرسة بـ**فهرسة الناقص** (كل اللي ما انفهرس)، أو **فهرس الباقي**، أو لدرس واحد: افتحه واضغط **فهرس هذا الدرس**.',
                            { dl: [
                                ['مفهرس', 'جاهز تختاره.'],
                                ['قيد الفهرسة…', 'العامل شغّال عليه الحين.'],
                                ['غير مفهرس بعد', 'انضاف بالفحص وما انفهرس.'],
                                ['فشلت الفهرسة', 'افتح الدرس وشوف السبب، وبعدها **فهرس هذا الدرس** مرة ثانية.'],
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
                    title: { ar: 'وش هي «اللقطة»؟', en: 'What a “moment” is' },
                    body: {
                        ar: [
                            'اللقطة لحظة مهمة في الدرس: ثانية معيّنة فيها شي يستاهل يصير شريحة. ولكل لقطة:',
                            { ul: [
                                'وقتها بالثواني داخل الفيديو.',
                                'وصف قصير للي على الشاشة.',
                                'نوعها: **شريحة** أو **شاشة تطبيق** أو **نتيجة** أو **كود** أو **برومبت** أو **أخرى**.',
                                'هل هي نظيفة: بدون أسهم ولا خربشة ولا شاشة تحميل. واللي فيها تعليقات مكتوب عليها **عليها تعليقات توضيحية**.',
                                'صورة مصغّرة تشوفها في الاستوديو.',
                            ] },
                            'ولما تنرسم الشريحة، العامل يطلّع اللقطة من الفيديو الأصلي بجودة كاملة، مو من الصورة المصغّرة.',
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
                    title: { ar: 'كم تاخذ الفهرسة؟', en: 'How long indexing takes' },
                    body: {
                        ar: [
                            { ul: [
                                'عادة كم دقيقة للدرس، وتطول مع الدروس الطويلة أو الإنترنت البطيء، لأن أطول خطوة هي رفع النسخة الصغيرة.',
                                'الدروس تنفهرس وحدة وحدة، فالكورس كامل ممكن ياخذ ساعة أو أكثر.',
                                'ما تحتاج تنتظر الكل: كل درس يصير جاهزاً للاختيار أول ما ينفهرس، والعدّاد يتحدّث لحاله.',
                                'تبي أسرع؟ `indexConcurrency` في ملف إعدادات العامل يخليه يشتغل على لين 4 دروس مع بعض، والرفع يظل واحد واحد.',
                                'خلّ الجهاز صاحياً والعامل متصلاً طول الفهرسة: [[worker#sleep]].',
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
                                '**من درس:** اختر لين ثلاثة دروس مفهرسة، وتقدر تدوّر عليها من **ابحث في الدروس**. **من فكرة:** اكتب عن وش تبي الكاروسيل بجملة أو جملتين، والتزم بالمعلومات اللي متأكد منها، لأنه ينكتب بدون ملاحظات دروس.',
                                'اضغط **أنشئ الكاروسيل**. تشوف المراحل: قراءة الدرس، كتابة الشرائح، مراجعة القواعد، رسم الشرائح.',
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
                            'اضغط **خيارات أكثر** تحت الدروس. وهي مسكّرة، تشوف ملخصها في سطر واحد.',
                            { dl: [
                                ['التركيز', 'مع الدروس بس: قل له على وش يركّز، مثل «الجزء الخاص بالتقارير فقط».'],
                                ['الزاوية', 'شكل المنشور: **نصائح**، أو **خطوة بخطوة**، أو **أخطاء شائعة**، أو **قبل وبعد**، أو **قالب برومبت**، أو **نظرة على الكورس**، أو **يختارها الذكاء الاصطناعي**.'],
                                ['عدد الشرائح', 'من 6 إلى 10. الأولى غلاف، والأخيرة دعوة لاتخاذ إجراء.'],
                                ['الكلمة المفتاحية', 'كلمة وحدة يكتبها المتابع في التعليقات عشان يوصله الرابط. اتركها فاضية ويقترح لك كلمة ما تتعارض مع حملاتك المفعّلة. وتجنّب الكلمات القصيرة: [[campaigns#pitfall]].'],
                                ['لون التمييز', 'اللون اللي تتلوّن فيه الكلمات المميزة. **من ألواني** يختار من ألوانك ويتجنب اللي استخدمتها مؤخراً، أو اختر لوناً بنفسك، أو اكتبه بصيغة `#RRGGBB`.'],
                            ] },
                            'واختياراتك تنحفظ على هذا الجهاز للكاروسيل الجاي.',
                        ],
                        en: [
                            'Press **More options** below the lessons. While it is closed, a one-line summary shows what is set.',
                            { dl: [
                                ['Focus', 'With lessons only: tell it what to concentrate on, such as “only the part about reports”.'],
                                ['Angle', 'The shape of the post: **Tips**, **Step by step**, **Common mistakes**, **Before and after**, **Prompt template**, **Course overview**, or **Let the AI choose**.'],
                                ['Slides', '6 to 10. The first is the cover and the last is the call to action.'],
                                ['Keyword', 'One word people comment to get the DM. Leave it empty and one is suggested that doesn’t clash with your active campaigns. Avoid short words: [[campaigns#pitfall]].'],
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
                            'افتح المسودّة من **المسودات** لما تصير **جاهز**. المعاينة تعرض الشرائح المرسومة فعلاً:',
                            { ul: [
                                'بدّل بين **إنستجرام 4:5** و**تيك توك 9:16**.',
                                'تنقّل بين الشرائح بالأسهم، واضغط على شريحة (أو Enter) عشان تفتح تعديلها.',
                                'شريط الشرائح تحت المعاينة، والشريحة اللي فيها مشكلة عليها علامة.',
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
                                'عدّل النص في الحقول جنب المعاينة: **العنوان**، و**الجزء المميّز** (كلمات من العنوان تتلوّن، ولازم تنكتب حرفياً مثل ما هي في العنوان)، و**النص**، والعناصر.',
                                '**نوع الشريحة**: غيّره، والعنوان والنص المشترك يبقون.',
                                'قدّم الشرائح وأخّرها، أو **كرّر** شريحة، أو **إضافة شريحة**، أو احذفها. حذفت بالغلط؟ **تراجع** يرجّعها.',
                                'للكاروسيل غلاف واحد ودعوة وحدة في آخره، وعدد الشرائح من 6 إلى 10.',
                                '**المظهر**: غيّر لون التمييز للكاروسيل كله.',
                                '**النصوص المرافقة**: **نص إنستجرام وفيسبوك**، و**عنوان تيك توك** (90 حرفاً كحد أقصى)، و**وصف تيك توك**. وتحت كل واحد السطر اللي لازم يكون فيه: نص إنستجرام فيه جملة التعليق بالكلمة المفتاحية، ووصف تيك توك فيه سطر البايو.',
                                '**أتمتة الكلمة المفتاحية**: الكلمة، والرسالة الخاصة اللي توصل كل من يعلّق بها.',
                            ] },
                            'ولو فيه أخطاء، يطلع **مشكلات يلزم إصلاحها** مع رابط لكل مشكلة في مكانها.',
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
                                'في شريحة **لقطة شاشة** (وفي الغلاف)، اضغط **تغيير اللقطة** أو **اختيار لقطة**.',
                                'تشوف لقطات **دروس هذا الكاروسيل**، وتقدر تختار من **دروس أخرى**.',
                                '**اللقطات النظيفة فقط** مفعّل افتراضياً: يخفي اللقطات اللي فيها أسهم أو خربشة أو شاشة تحميل. ومرّر المؤشر على لقطة عشان تشوفها كبيرة.',
                                '**إزالة** تشيل اللقطة من الشريحة.',
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
                                'على أي شريحة اضغط **أعد الكتابة بالذكاء الاصطناعي**، واكتب في **التوجيه** وش تبي، مثل «أقصر» أو «ابدأ بالنتيجة»، واضغط **أعد الكتابة**.',
                                'يعيد كتابة هذي الشريحة بس، ومن نفس الدروس، وضمن حدودها.',
                                'تعديلاتك اللي ما انحفظت تنحفظ أول، عشان يعيد كتابة النسخة اللي قدامك.',
                                'تبي نسخة جديدة كاملة؟ **اكتبه من جديد** يكتب مسودّة ثانية بزاوية تختارها، والمسودّة الحالية تبقى مثل ما هي.',
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
                                '**احفظ وحدّث المعاينة** (أو ⌘S على الماك وCtrl+S على ويندوز) يحفظ ويرسل الشرائح للعامل يعيد رسمها، والمعاينة تتحدّث لما يخلص.',
                                'لين ما تحفظ، تشوف **تعديلات غير محفوظة**، والمعاينة تعرض آخر رسم.',
                                '**تجاهل التغييرات** يرجّعك لآخر نسخة محفوظة.',
                                'سكّرت الصفحة بالغلط؟ التعديلات محفوظة على هذا الجهاز، وترجع لك لما تفتح المسودّة.',
                                'فشل الرسم؟ النص محفوظ، اضغط **أعد الرسم**.',
                                '**حذف المسودة** يحذفها مع شرائحها، وما ينفع بعد الجدولة.',
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
                ar: 'كيف تختار الموعد، ووش يصير لإنستجرام وفيسبوك وتيك توك، وكيف تنشر كاروسيل تيك توك المنتظرة.',
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
                                'لما يصير الرسم **جاهز** وتكون حافظ كل تعديلاتك، اضغط **إلى الجدولة**.',
                                'في **الموعد** تشوف أقرب المواعيد الفاضية من جدولك في الإعدادات (منشور واحد لكل موعد)، أو اختر **وقت آخر…** وحدّده بنفسك.',
                                'اختر وش يصير مع تيك توك (تحت).',
                                'خلّ **إنشاء أتمتة الكلمة المفتاحية أيضاً** مفعّلاً، عشان كل من يعلّق بالكلمة توصله الرسالة.',
                                'اقرأ **ما الذي سيحدث**، واضغط زر الجدولة.',
                            ] },
                            { note: 'الأوقات المقترحة بتوقيت المنطقة الزمنية اللي في إعدادات الاستوديو، والوقت المخصص بتوقيت جهازك.' },
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
                    title: { ar: 'وش يصير بعد الجدولة؟', en: 'What happens next' },
                    body: {
                        ar: [
                            { ul: [
                                'ينضاف منشور كاروسيل على إنستجرام وفيسبوك معاً في **جدولة المنشورات**، بالشرائح المرسومة ونص إنستجرام. حالاته في [[scheduling#statuses]].',
                                'تنشأ حملة للكلمة المفتاحية، إلا إذا عندك حملة مفعّلة ترد على نفس الكلمة من قبل.',
                                'المسودّة تصير **مجدول** ويتسكّر التعديل. تبي تغيّرها؟ احذف المنشور من **جدولة المنشورات**.',
                                '**فتح في المنشورات** يوديك للمنشور.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'A carousel post for Instagram and Facebook together is added to the **Posts Scheduler**, with the drawn slides and the Instagram caption. Its statuses are in [[scheduling#statuses]].',
                                'A keyword campaign is created, unless an active campaign already answers that keyword.',
                                'The draft becomes **Scheduled** and editing closes. To change it, delete the post from the **Posts Scheduler**.',
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
                            { dl: [
                                ['إضافة إلى طابور تيك توك', 'ما دام تيك توك ما اعتمد التطبيق: الكاروسيل ينتظر، وتنشره بعدين مع غيره بدفعة وحدة.'],
                                ['النشر على تيك توك في الموعد نفسه', 'يظهر بعد ما يعتمد تيك توك التطبيق، وينزل مع منشور إنستجرام.'],
                                ['بلا نشر على تيك توك', 'إنستجرام وفيسبوك فقط.'],
                            ] },
                        ],
                        en: [
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
                            'الكاروسيل اللي في الطابور تلقاها تحت **بانتظار تيك توك** أعلى الاستوديو.',
                            { ol: [
                                'خلّ حسابك في تيك توك **خاصاً**.',
                                'اضغط **انشر كاروسيل تيك توك المنتظرة**، وبعدها **انشر على تيك توك**.',
                                'تنرسل كلها الحين، بفاصل 40 ثانية بين كل منشور، وكل واحد بخصوصية **أنا فقط**.',
                                'لما تخلص كلها، رجّع الحساب عاماً، وخلّ كل منشور عاماً من **⋯** ← **الخصوصية** ← **الجميع**.',
                                'وفي كل مسودّة أشّر على **جُعل عامّاً على تيك توك**، عشان تتذكر وش خلّصت.',
                            ] },
                            { warn: 'لا ترجّع الحساب عاماً قبل ما تخلص الدفعة كلها: قبل الاعتماد، تيك توك يرفض منشورات هالتطبيق من الحساب العام.' },
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
                            'شكل شرائحك. والشريحة التجريبية جنبها معاينة تقريبية، والشرائح الحقيقية تنرسم على جهازك.',
                            { dl: [
                                ['اسم العلامة', 'الاسم اللي يناديك فيه الاستوديو.'],
                                ['التوقيع (بالحروف اللاتينية)', 'التوقيع اللي في أسفل الشرائح، بالإنجليزي، مثل «AGENTIC AI».'],
                                ['التوقيع (بلغتك)', 'نفس التوقيع بلغتك، مثل «بالعربي».'],
                                ['ألوان التمييز', 'الألوان اللي يتناوب عليها الكاروسيل، ويتجنب أحدث لون استخدمته. **إضافة لون** يضيف، ولازم يبقى لون واحد على الأقل.'],
                                ['لون الحبر / لون الورق / اللون الخافت', 'لون النص، ولون الخلفية، ولون النص الثانوي.'],
                                ['خط العناوين', 'Cairo أو Tajawal أو IBM Plex Sans Arabic أو Inter.'],
                                ['خط الكود', 'الخط اللي تنكتب فيه البرومبتات والأكواد.'],
                                ['اتجاه الشرائح', '**من اليمين إلى اليسار** للعربي، و**من اليسار إلى اليمين** للإنجليزي.'],
                            ] },
                        ],
                        en: [
                            'How your slides look. The sample slide beside it is a rough preview; the real slides are drawn on your computer.',
                            { dl: [
                                ['Brand name', 'How the Studio refers to you.'],
                                ['Signature (Latin)', 'The sign-off at the bottom of the slides, in Latin letters, such as “AGENTIC AI”.'],
                                ['Signature (your language)', 'The same sign-off in your language, such as «بالعربي».'],
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
                                ['دليل الأسلوب', 'كيف تكتب: النبرة، واللهجة، والكلمات اللي تحبها، واللي تتجنبها. الكاتب يلتزم فيه في كل كاروسيل.'],
                            ] },
                            { tip: 'دليل أسلوب جيد قصير ومحدد، مثل: «لهجة خليجية بيضاء، جمل قصيرة، النتيجة أول وبعدها الأداة، بدون مبالغة ولا وعود».' },
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
                                ['اسم المنتج', 'اللي تروّج له.'],
                                ['رابط المنتج', 'الرابط اللي ترسله الرسالة الخاصة، ومعه رمز الإحالة. لازم يبدأ بـ `https://`.'],
                                ['حقائق', 'حقائق قصيرة وصحيحة يجوز للشرائح تذكرها، مثل «34 درساً». الكاتب ما يدّعي عن منتجك شي غيرها.'],
                                ['نقاط الرسالة الخاصة', 'القائمة اللي تنحط مكان `{bullets}` في قالب الرسالة.'],
                            ] },
                            '**الدعوات لاتخاذ إجراء:**',
                            { dl: [
                                ['سطر نص إنستجرام', 'ينضاف لكل نص إنستجرام. لازم يكون فيه `{keyword}` مكان الكلمة المفتاحية، عشان المتابع يعرف وش يكتب.'],
                                ['سطر نص تيك توك', 'ينضاف لكل وصف تيك توك. تيك توك ما يرسل رسائل خاصة، فوجّه الناس للبايو: [[tiktok#bio]].'],
                                ['قالب الرسالة الخاصة', 'الرسالة اللي توصل من يعلّق. المتغيرات: `{username}` و`{question}` و`{pitch}` و`{url}` و`{bullets}`. والسؤال والجملة التعريفية يكتبها الذكاء لكل كاروسيل.'],
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
                            'اللي تقوله شريحة الدعوة في آخر الكاروسيل، على إنستجرام وعلى تيك توك:',
                            { dl: [
                                ['دعوة إنستجرام', 'مثل «اكتب في التعليقات».'],
                                ['سطر إنستجرام تحتها', 'مثل «ويوصلك الرابط بالخاص».'],
                                ['دعوة الحفظ', 'مثل «احفظ المنشور».'],
                                ['عنوان تيك توك', 'مثل «الكورس كامل بالعربي».'],
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
                                ['TikTok headline', 'For example “The full course”.'],
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
                                ['المنطقة الزمنية', 'المواعيد اليومية بتوقيت هذي المنطقة، مثل `Asia/Riyadh`.'],
                                ['المواعيد اليومية', 'الأوقات اللي ينزل فيها منشور كل يوم، مثل 13:00 و21:00. **إضافة موعد** يضيف وقتاً، ولازم يبقى وقت واحد على الأقل. والجدولة تقترح عليك أقرب موعد فاضي، منشوراً واحداً لكل موعد.'],
                            ] },
                        ],
                        en: [
                            { dl: [
                                ['Time zone', 'The daily slots are times in this zone, such as `Asia/Riyadh`.'],
                                ['Daily slots', 'The times a post goes out each day, such as 13:00 and 21:00. **Add slot** adds one; at least one must stay. Scheduling offers you the next free slot, one post per slot.'],
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
                                ['المجلد على جهاز الماك', 'المسار الكامل للمجلد اللي يفحصه العامل، مثل `/Users/you/Videos/Course`. لازم يكون داخل مجلد الكورس في إعدادات العامل (`courseRoot`). وإذا تركته فاضي، يوقف الفحص.'],
                            ] },
                            'ترتيب المجلد والأسماء في [[library#folder]].',
                        ],
                        en: [
                            { dl: [
                                ['Folder on your Mac', 'The full path of the folder the worker scans, such as `/Users/you/Videos/Course`. It must sit inside the course folder in the worker’s config (`courseRoot`). Leave it empty to turn scanning off.'],
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
                                '**عامل جديد** ← **إنشاء عامل**: يطلع لك رمزه مرة وحدة. انسخه والصقه في الحقل `token` داخل `studio.config.json` على جهازك، واضغط **نسخته**.',
                                'كل عامل تشوف جنبه **آخر ظهور** أو **لم يتصل بعد**.',
                                '**إلغاء** يوقف العامل فوراً ويرفض رمزه. وعشان تستخدم نفس الجهاز مرة ثانية، أنشئ عاملاً جديداً والصق رمزه.',
                            ] },
                            'كل شي عن العامل في [[worker]].',
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
                            'اضغط **حفظ الإعدادات**. ولو في حقل فيه خطأ، ينعلّم في مكانه وتشوف **صحّح الحقول المعلّمة ثم احفظ**. الإعدادات تنطبق على أي كاروسيل تكتبه أو ترسمه بعدها، والمنشورات المجدولة ما تتغيّر.',
                        ],
                        en: [
                            'Press **Save settings**. When a field has a problem it is marked where it is, with **Fix the highlighted fields, then save.** Settings apply to anything you write or redraw afterwards; posts already scheduled don’t change.',
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
                ar: 'وين يستخدم أوتوريبلاي برو Gemini، وحدود الاستخدام، وليش تفعيل الفوترة يفرق.',
                en: 'Where AutoReply Pro uses Gemini, the usage limits, and why turning on billing matters.',
            },
            related: ['troubleshooting', 'worker', 'create'],
            sections: [
                {
                    id: 'where',
                    title: { ar: 'وين يُستخدم الذكاء الاصطناعي؟', en: 'Where AI is used' },
                    body: {
                        ar: [
                            'كل الذكاء الاصطناعي في المنتج من **Gemini** من Google، في ثلاثة أماكن:',
                            { dl: [
                                ['ردود الرسائل', 'الوكيل الذكي يرد على الرسائل الخاصة بالنموذج اللي تختاره في **إعدادات الذكاء الاصطناعي** ← **النموذج**.'],
                                ['كتابة الكاروسيل', '**أنشئ الكاروسيل** و**أعد الكتابة بالذكاء الاصطناعي** و**اكتبه من جديد** و**خطّط أسبوعي**، وكلها على الخادم.'],
                                ['فهرسة الدروس', 'على العامل في جهازك، بمفتاح Gemini اللي في ملف إعداداته.'],
                            ] },
                        ],
                        en: [
                            'All the AI in the product is Google’s **Gemini**, used in three places:',
                            { dl: [
                                ['DM replies', 'The AI agent answers DMs with the model you choose in **AI Settings** → **Model**.'],
                                ['Writing carousels', '**Generate carousel**, **Rewrite with AI**, **Write it again** and **Plan my week**, all on the server.'],
                                ['Indexing lessons', 'On the worker on your computer, with the Gemini key in its config file.'],
                            ] },
                        ],
                    },
                },
                {
                    id: 'separate',
                    title: { ar: 'الكاروسيل ما ياكل من حصة الرسائل', en: 'Carousels don’t eat into your DM quota' },
                    body: {
                        ar: [
                            'الاستوديو يستخدم نماذج غير نموذج الرسائل عن قصد، عشان كاروسيل تكتبه ما يستهلك الحصة اللي يعتمد عليها رد عميل. ولو خلصت حصة نموذج، يجرّب اللي بعده لحاله.',
                        ],
                        en: [
                            'The Studio deliberately uses different models from the DM agent, so a carousel you write never spends the quota a customer’s reply depends on. When one model’s quota runs out, it moves on to the next by itself.',
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
                                '**المفتاح المجاني حدوده ضيقة:** بعض النماذج تسمح بحوالي 20 طلباً في اليوم بس. والكاروسيل الواحد ممكن ياخذ أكثر من طلب: الكتابة، ولين جولتين تصحيح إذا احتاج.',
                                'لما تخلص الحصة، Google يرد بالخطأ 429: تشوف في الاستوديو رسالة فيها `HTTP 429`، أو يوقف الوكيل عن الرد على الرسائل.',
                                'الحصة اليومية تتجدد عند منتصف الليل بتوقيت المحيط الهادئ، يعني قرابة 10 أو 11 الصبح بتوقيت الرياض.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'Google limits each key to a number of requests per minute and per day, for each model separately.',
                                '**A free key has tight limits:** some models allow only about 20 requests a day. One carousel can take more than one request: the writing, plus up to two repair rounds when needed.',
                                'When the quota runs out, Google answers with error 429: the Studio shows a message containing `HTTP 429`, or the agent stops answering DMs.',
                                'Daily quotas reset at midnight Pacific time, which is around 10 or 11 in the morning in Riyadh.',
                            ] },
                        ],
                    },
                },
                {
                    id: 'billing',
                    title: { ar: 'ليش الفوترة مهمة؟', en: 'Why billing matters' },
                    body: {
                        ar: [
                            { ul: [
                                'فعّل الفوترة (Billing) على مشروع Google Cloud اللي فيه المفتاح، والحدود ترتفع كثير، فما توقف الردود ولا الكاروسيل في نص اليوم.',
                                '**الخصوصية:** حسب شروط Gemini API، المحتوى اللي يمر عن طريق الخطة المجانية ممكن يستخدمه Google لتحسين منتجاته، والخطة المدفوعة لا. وهذا يشمل رسائل عملائك ولقطات دروسك.',
                                'التكلفة بالاستخدام: كل كاروسيل عدة طلبات، وكل درس فهرسة وحدة. الأرقام الحقيقية تلقاها في صفحة الاستخدام في Google AI Studio.',
                                'حط تنبيه ميزانية (Budget alert) في Google Cloud عشان ما تتفاجأ بالفاتورة.',
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
                    id: 'save',
                    title: { ar: 'نصائح توفّر عليك', en: 'Ways to spend less' },
                    body: {
                        ar: [
                            { ul: [
                                'افهرس الدرس مرة وحدة. إعادة الفهرسة طلب جديد، فلا تعيدها إلا إذا فشلت.',
                                'لتعديل شريحة وحدة استخدم **أعد الكتابة بالذكاء الاصطناعي**، بدال **اكتبه من جديد** للكاروسيل كله.',
                                'كل رسالة تجريبية في **اختبار الوكيل** طلب حقيقي، فجرّب بأسئلة مدروسة.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'Index each lesson once. Re-indexing is a new request, so only redo it when it failed.',
                                'To fix one slide, use **Rewrite with AI** rather than **Write it again** for the whole carousel.',
                                'Every test message in the **Agent sandbox** is a real request, so test with purpose.',
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
            related: ['faq', 'worker', 'campaigns'],
            sections: [
                {
                    id: 'worker',
                    title: { ar: 'العامل', en: 'The worker' },
                    body: {
                        ar: [
                            { qa: [
                                ['**العامل غير متصل** والماك شغّال', ['تأكد أن الماك متصل بالإنترنت، وما هو نايم.', 'شغّل أمر «هل هو شغّال؟» من [[worker#install]]. وإذا ما كان شغّال، شغّل سكربت التثبيت مرة ثانية.']],
                                ['**لم يتصل بعد** مع أني أنشأت العامل', 'غالباً الرمز ما انلصق صح في `studio.config.json`، أو انلصق رمز عامل ثاني. العامل يقرأ الملف من جديد لما يتغيّر، فما يحتاج إعادة تشغيل.'],
                                ['السجل يقول `the app rejected the worker token (HTTP 401)`', 'الرمز انلغى أو فيه غلط. أنشئ عاملاً جديداً من إعدادات الاستوديو ← **العمّال**، والصق رمزه الجديد.'],
                                ['السجل يقول `another studio worker is running`', 'فيه عامل ثاني شغّال بنفس الإعدادات. أوقف واحد منهم: `scripts/uninstall-studio-worker.sh` أو Ctrl‑C.'],
                                ['السجل يقول `ffmpeg not found on PATH`', 'ثبّت ffmpeg (`brew install ffmpeg`)، وبعدها شغّل سكربت التثبيت مرة ثانية.'],
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
                    id: 'indexing',
                    title: { ar: 'الفحص والفهرسة', en: 'Scanning and indexing' },
                    body: {
                        ar: [
                            { qa: [
                                ['زر **فحص المكتبة** معطّل', 'ما حددت مجلد المكتبة. اضغط **حدّده من الإعدادات**.'],
                                ['الفحص خلص وما طلعت دروس', 'راجع ترتيب المجلد وأسماء الملفات في [[library#folder]]. ومسار المجلد لازم يكون داخل `courseRoot` في إعدادات العامل.'],
                                ['درس مكتوب عليه **فشلت الفهرسة**', 'افتح الدرس وشوف السبب، واضغط **فهرس هذا الدرس**. ولو تكرر، شوف السجل على الماك.'],
                                ['الفهرسة واقفة على `uploading the … proxy to Gemini`', 'هذا رفع النسخة الصغيرة، والإنترنت البطيء يطوّله. الرفع يكمّل من حيث انقطع، والمهمة محجوزة للعامل ما دام يرسل تحديثات.'],
                                ['السجل يقول `is outside the course root`', 'مجلد المكتبة في الإعدادات مو داخل `courseRoot` في ملف العامل. غيّر واحداً منهم.'],
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
                                ['**تعذّرت كتابة الكاروسيل** وفي الرسالة `HTTP 429`', 'حصة Gemini خلصت. انتظر لين تتجدد، أو فعّل الفوترة: [[ai-usage#quotas]].'],
                                ['زر **أنشئ الكاروسيل** معطّل', 'ما في ولا درس مفهرس. افهرس درساً، أو اختر **من فكرة**.'],
                                ['تاخذ الكتابة وقتاً أطول من العادة', 'الدروس الطويلة ممكن تاخذ دقيقتين. وما يلزمك تنتظر في الصفحة: المسودّة تظهر في **المسودات** لما تجهز.'],
                                ['**الكلمة المفتاحية يجب أن تكون كلمة واحدة بلا مسافات**', 'في **خيارات أكثر**، خلّ الكلمة كلمة وحدة بدون مسافات.'],
                                ['رسالة فيها `still breaks … rule(s)`', 'الذكاء ما قدر يكتب مسودّة تلتزم بكل القواعد. جرّب مرة ثانية، أو غيّر **الزاوية** أو **عدد الشرائح**.'],
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
                                ['المسودّة واقفة على **يرسم الشرائح**', 'العامل غير متصل، والرسم ينتظره في الطابور. شغّل الماك والعامل، ويبدأ الرسم لحاله.'],
                                ['**فشل الرسم**', ['النص محفوظ، فاضغط **أعد الرسم**.', 'ولو تكرر، شوف السجل. مثلاً `ffmpeg found no frame at` يعني أن وقت لقطة بعد نهاية الفيديو، فاختر لقطة غيرها.']],
                                ['المعاينة ما تغيّرت بعد التعديل', 'لازم تضغط **احفظ وحدّث المعاينة**، وبعدها ينتظر الرسم الجديد.'],
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
                                ['منشور عليه **فشلت**', 'اقرأ السبب على المنشور. ما انحذف شي: أصلح الوسائط أو النص وأعد النشر.'],
                                ['نزل على فيسبوك وفشل على إنستجرام', 'أعد النشر، وينزل على إنستجرام بس.'],
                                ['إنستجرام رفض الكاروسيل', 'تأكد أنها من 2 إلى 10 صور، وبنفس المقاس: [[scheduling#carousels]].'],
                                ['شريحة مقصوصة غلط', 'الصورة الأولى تحدد القصّ للكل. خلّ كل الصور بنفس المقاس.'],
                                ['الريل طالع مربّع أسود في الشبكة', 'ارفع صورة غلاف: [[scheduling#cover]].'],
                                ['المنشور ما نزل في دقيقته بالضبط', 'ينزل خلال دقائق من موعده. ولو توقف الفحص المتكرر، ينزل مع التشغيل اليومي الساعة 00:00 بتوقيت UTC.'],
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
                                ['المنشور على تيك توك محد يشوفه', 'طبيعي قبل الاعتماد: ينزل **أنا فقط**. خلّه عاماً من **⋯** ← **الخصوصية** ← **الجميع**.'],
                                ['تيك توك رفض المنشور', 'قبل الاعتماد لازم حسابك يكون خاصاً وقت النشر. خلّه خاصاً وأعد المحاولة: [[tiktok#before-approval]].'],
                                ['المسودّة ما وصلت صندوق تيك توك', 'وضع المسودّات ما يُعتمد عليه. استخدم **انشره مباشرة في حسابي**: [[tiktok#drafts]].'],
                                ['منشور تيك توك رجع **بالانتظار** ومعه سبب عن المسودّات', 'عندك 5 مسودّات معلّقة في آخر 24 ساعة. انشر وحدة منها من التطبيق، والباقي ينرسل لحاله.'],
                                ['**يحتاج إلى إعادة الربط**', 'اضغط **إعادة الربط** في **الإعدادات** ← **تيك توك**.'],
                                ['**أعد ربط تيك توك للسماح بالنشر المباشر**', 'النشر المباشر انفعّل بعد ما ربطت حسابك. أعد الربط مرة وحدة.'],
                                ['الناس يسألون عن الرابط في تعليقات تيك توك', 'تيك توك ما يرسل رسائل تلقائية. تأكد أن الرابط موجود في البايو: [[tiktok#bio]].'],
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
                                ['علّقت بالكلمة وما وصلتني رسالة', { ul: [
                                    'الحملة مفعّلة؟',
                                    'الكلمة موجودة فعلاً في التعليق؟',
                                    'علّقت من حساب ثاني؟ تعليقاتك أنت ما تشغّل الحملات.',
                                    'وصلتك رسالة من قبل خلال 24 ساعة؟ رسالة وحدة لكل شخص كل 24 ساعة.',
                                    'الحملة مربوطة بمنشور معيّن؟ لازم تعلّق على هذا المنشور.',
                                    '**رمز الوصول** مكتوب عليه **صالح**؟',
                                ] }],
                                ['**سجل النشاط** فاضي تماماً', 'التعليق اللي ما يطابق أي حملة ما يُسجَّل أصلاً. جرّب بكلمة حملة مفعّلة.'],
                                ['ناس وصلتهم رسالة ما طلبوها', 'كلمة قصيرة قاعدة تطابق داخل كلمات ثانية: [[campaigns#pitfall]].'],
                                ['الرسالة وصلت والرد العلني ما ظهر', 'الرد على تعليقات فيسبوك يحتاج صلاحية `pages_manage_engagement`: [[connect-meta#token-health]].'],
                                ['الوكيل ما يرد على الرسائل', ['تأكد أن **تشغيل الوكيل الذكي** مفعّل في **إعدادات الذكاء الاصطناعي**.', 'وتأكد أن الرد الآلي مو موقوف في المحادثة (**الردّ الآلي متوقف** في **صندوق الرسائل**). أي رد يدوي منك يوقفه في تلك المحادثة.', 'ولو خلصت حصة Gemini: [[ai-usage#quotas]].']],
                                ['بعض الرسائل **فشلت** ومعها سبب عن الحد', 'الحد 180 رسالة في الساعة لكل حساب، ورسالة وحدة لكل شخص كل 24 ساعة.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['I commented the keyword and got no DM', { ul: [
                                    'Is the campaign active?',
                                    'Is the keyword really in the comment?',
                                    'Did you comment from another account? Your own comments never trigger a campaign.',
                                    'Did you already get a DM in the last 24 hours? It is one per person every 24 hours.',
                                    'Is the campaign tied to one post? Then comment on that post.',
                                    'Does the **Access token** say **Valid**?',
                                ] }],
                                ['The **Activity Log** is completely empty', 'A comment that matches no campaign is not recorded at all. Test with the keyword of an active campaign.'],
                                ['People got a DM they never asked for', 'A short keyword is matching inside other words: [[campaigns#pitfall]].'],
                                ['The DM arrived but the public reply didn’t', 'Replying to Facebook comments needs the `pages_manage_engagement` permission: [[connect-meta#token-health]].'],
                                ['The AI agent isn’t answering DMs', ['Check **Enable the AI sales agent** is on in **AI Settings**.', 'Check the AI isn’t paused in that conversation (**AI paused** in the **DM Inbox**). Any manual reply from you pauses it there.', 'And if your Gemini quota ran out: [[ai-usage#quotas]].']],
                                ['Some DMs **Failed** with a note about a limit', 'The limits are 180 DMs an hour per account, and one DM per person every 24 hours.'],
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
                ar: 'أجوبة قصيرة للأسئلة اللي تتكرر.',
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
                                ['لازم أخلي جهازي شغّالاً؟', 'للحملات والرسائل والجدولة لا، كلها على الخادم وتشتغل وجهازك مطفّي. الاستوديو بس: الفهرسة والرسم يحتاجون العامل على جهازك.'],
                                ['ممكن ينشر شي بدون موافقتي؟', 'لا. المنشور ينزل لما تجدوله أنت، والردود تطلع من حملاتك ووكيلك وبتعليماتك.'],
                                ['يشتغل مع حساب إنستجرام شخصي؟', 'لا، لازم حساب احترافي (أعمال أو صانع محتوى) مربوط بصفحة فيسبوك: [[connect-meta#needs]].'],
                                ['أقدر أوقف الرد الآلي لعميل معيّن؟', 'إيه. في **صندوق الرسائل** افتح المحادثة وطفّ **الردّ الآلي في هذه المحادثة**. وأي رد يدوي منك يوقفه في تلك المحادثة لحاله.'],
                                ['أقدر أغيّر لغة اللوحة؟', 'إيه، من الزر أعلى الصفحة، أو من **الإعدادات** ← **المظهر واللغة**.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['Does my computer have to stay on?', 'Not for campaigns, DMs or scheduling: they all run on the server, even with your computer off. Only the Studio needs it: indexing and drawing slides need the worker on your computer.'],
                                ['Can anything be posted without my approval?', 'No. A post goes out when you schedule it, and replies come from your own campaigns and your agent, following your instructions.'],
                                ['Does it work with a personal Instagram account?', 'No: you need a professional (Business or Creator) account connected to a Facebook Page. See [[connect-meta#needs]].'],
                                ['Can I stop the AI for one customer?', 'Yes. In the **DM Inbox**, open the conversation and switch off **AI assistant for this conversation**. A manual reply from you pauses it there too.'],
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
                                ['فيديوهاتي تطلع من جهازي؟', 'لا. للفهرسة تروح نسخة صغيرة لـ Gemini وتنحذف بعدها، والأصلي يبقى عندك: [[worker#security]].'],
                                ['أقدر أستخدم الاستوديو بدون دروس؟', 'إيه، اكتب **من فكرة**. بس رسم الشرائح يحتاج العامل.'],
                                ['العامل يشتغل على ويندوز؟', 'حالياً على الماك بس.'],
                                ['أقدر أعدّل الكاروسيل بعد ما أجدوله؟', 'لا، التعديل يتسكّر بعد الجدولة. احذف المنشور من **جدولة المنشورات** وارجع عدّله.'],
                                ['ليش الأرقام في الشرائح هندية (١٢٣)؟', 'غيّرها من **الأرقام** في إعدادات الاستوديو: [[studio-settings#voice]].'],
                                ['الكاروسيل ينكتب بلهجتي؟', 'يلتزم بـ**دليل الأسلوب** في الإعدادات، فاكتب فيه لهجتك ونبرتك بالتفصيل.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['Do my videos leave my computer?', 'No. For indexing, a small copy goes to Gemini and is deleted afterwards; the original stays with you. See [[worker#security]].'],
                                ['Can I use the Studio without lessons?', 'Yes, write **From an idea**. Drawing the slides still needs the worker.'],
                                ['Does the worker run on Windows?', 'For now, on a Mac only.'],
                                ['Can I edit a carousel after scheduling it?', 'No, editing closes once it is scheduled. Delete the post from the **Posts Scheduler** and edit it again.'],
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
                                ['ليش منشوراتي على تيك توك «أنا فقط»؟', 'لأن تيك توك ما اعتمد التطبيق بعد. خلّها عامة بنفسك: [[tiktok#before-approval]].'],
                                ['تيك توك يرسل رسائل خاصة للي يعلّقون؟', 'لا، ولهذا نصوص تيك توك توجّه الناس للرابط في البايو: [[tiktok#bio]].'],
                                ['كم يدوم ربط تيك توك؟', 'سنة وحدة، وبعدها تعيد الربط من **الإعدادات**.'],
                                ['أقدر أنشر كاروسيل صور على تيك توك؟', 'إيه، من 2 لين 35 صورة: [[tiktok#photos]].'],
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
                                ['وش الذكاء اللي يستخدمه؟', 'Gemini من Google، للرسائل والكاروسيل والفهرسة: [[ai-usage#where]].'],
                                ['ممكن يخترع معلومات؟', 'الكاروسيل ينكتب من ملاحظات الدرس و**حقائق** المنتج بس، والوكيل من تعليماتك وقاعدة المعرفة. ومع هذا، راجع دائماً قبل ما تنشر.'],
                                ['فيه حد للاستخدام؟', 'إيه، حدود Google على مفتاحك: [[ai-usage#quotas]].'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['Which AI does it use?', 'Google’s Gemini, for DMs, carousels and indexing: [[ai-usage#where]].'],
                                ['Can it make things up?', 'Carousels are written only from the lesson notes and your product **Facts**, and the agent from your instructions and knowledge base. Still, always review before you post.'],
                                ['Is there a usage limit?', 'Yes, Google’s limits on your key: [[ai-usage#quotas]].'],
                            ] },
                        ],
                    },
                },
            ],
        },
    ],
};
