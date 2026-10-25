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
        { id: 'whatsapp', title: { ar: 'واتساب', en: 'WhatsApp' } },
        { id: 'ads', title: { ar: 'الإعلانات', en: 'Ads' } },
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
                                '**ردود الكلمات المفتاحية:** متابع يكتب كلمة تحددها في التعليقات (مثل «سعر»)، فتوصله رسالة خاصة فيها الرابط، ويشوف رداً علنياً على تعليقه إذا حبيت.',
                                '**وكيل ذكي للرسائل:** أي رسالة توصلك في الخاص يرد عليها وكيل يعرف منتجك ويتكلم بأسلوبك، وتقدر توقفه في أي محادثة.',
                                '**الجدولة:** صورة أو فيديو أو ريل أو كاروسيل، على إنستجرام وفيسبوك معاً، ومعها تيك توك إذا ربطته.',
                                '**استوديو الكاروسيل:** يحوّل دروسك المصوّرة إلى منشورات كاروسيل جاهزة، بالنص والكلمة المفتاحية والرسالة الخاصة.',
                            ] },
                        ],
                        en: [
                            'AutoReply Pro answers your audience on Instagram and Facebook for you, and publishes your content on time, even while you are busy or asleep. It works on your real account through Meta’s own API: no tricks, no browser extensions.',
                            { ul: [
                                '**Keyword replies:** someone comments a word you choose (say, “price”), gets a private DM with your link, and sees a public reply under their comment if you want one.',
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
                                'روح **الردود التلقائية** واضغط **حملة جديدة**: اكتب الكلمة المفتاحية، ونص الرسالة الخاصة، ورداً علنياً قصيراً. وقبل ما تختار الكلمة اقرأ [[campaigns#matching|كيف تشتغل المطابقة]].',
                                'جرّبها بنفسك: من حساب ثاني علّق بالكلمة على أحد منشوراتك، وخلال ثوانٍ توصلك الرسالة في الخاص. وكل اللي صار تلقاه في **سجل النشاط**.',
                                'افتح **مساعد الرسائل**، فعّل **تشغيل الردّ الآلي**، واكتب في **الشخصية والتعليمات** من هو الوكيل وكيف يتكلم. جرّبه في **اختبار الوكيل** قبل ما يرد على أي عميل.',
                                'من **الجدولة** اضغط **جدوِل منشوراً** وجرّب منشوراً بسيطاً. التفاصيل في [[scheduling]].',
                                'اختياري: اربط تيك توك من **الإعدادات** ← **اربط تيك توك**، واقرأ [[tiktok]] قبل أول منشور.',
                                'اختياري: إذا عندك كورس أو دروس مصوّرة، جهّز **الاستوديو**. البداية من [[studio]].',
                            ] },
                            { tip: 'أي علامة استفهام صغيرة جنب زر في اللوحة توديك للشرح اللي يخصه هنا مباشرة.' },
                        ],
                        en: [
                            'Ten minutes is enough to get the account working for you. Go through these in order:',
                            { ol: [
                                'Open **Settings** and check that the **Access token** section says **Valid**. If you see **Missing Meta permissions**, the fix is in [[connect-meta#token-health]].',
                                'Go to **Keyword replies** and press **New campaign**: enter a keyword, the DM text and a short public reply. Before you pick the keyword, read [[campaigns#matching|how matching works]].',
                                'Test it yourself: from another account, comment the keyword on one of your posts. The DM arrives within seconds, and everything that happened shows up in the **Activity Log**.',
                                'Open **DM assistant**, switch on **Turn on auto-replies**, and describe in **Voice and instructions** who the agent is and how it talks. Try it in the **Agent sandbox** before it answers a real customer.',
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
                                ['المساعدة', 'هنا: كل الشروحات، بالعربية والإنجليزية.'],
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
            related: ['campaigns', 'troubleshooting', 'getting-started', 'whatsapp'],
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
                                ['رمز التحقق للويبهوك', 'كلمة سرية تخترعها أنت وتكتبها بنفس الشكل في تطبيق ميتا. ميتا تفحصها بس لما ينشأ اشتراك أو يتغيّر رابطه، والحفظ هنا بـ**احفظ رمز التحقق** يشتغل فوراً.'],
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
                                ['ينتهي: أبداً (رمز طويل الأمد)', 'هذا الأفضل. ولو شفت تاريخ انتهاء بدالها، اضغط **مدّد إلى رمز دائم**. الرمز القديم يظل شغّال، لأن ميتا ما تلغيه لما تصدر الجديد.'],
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
                                'افتح **النتائج** ثم **السجل**: كل تعليق طابق حملة يظهر هنا مع حالته.',
                            ] },
                            { note: 'التعليق اللي ما يطابق أي حملة ما يُسجَّل أصلاً. يعني غيابه من السجل مو دليل أن الربط خربان؛ تأكد من الكلمة أول.' },
                        ],
                        en: [
                            { ol: [
                                'The **Access token** reads **Valid**, with no missing-permissions warning.',
                                'From another account, comment the keyword of an active campaign and check the DM arrives.',
                                'Open **Results**, then **Log**: every comment that matched a campaign is listed with its status.',
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
                            'أنشئ حملة من **الردود التلقائية** ← **حملة جديدة**، أو أضف كذا حملة مرة وحدة من **استورد من CSV**. وتقدر توقف أي حملة بدون ما تحذفها من مفتاح **تفعيل الحملة**.',
                            '**معرّف المنشور المستهدف** اختياري: إذا حددته (أو اخترته من **اختر منشوراً**)، الحملة تشتغل على تعليقات هذا المنشور بس. وإذا تركته فاضي، تشتغل على كل منشوراتك.',
                        ],
                        en: [
                            { ol: [
                                'Someone comments on your post on Instagram or Facebook.',
                                'AutoReply Pro looks through your active campaigns for a keyword that appears in the comment.',
                                'When one matches, it sends them your **DM template** as a private reply to that comment.',
                                'It also answers the comment in public with one of your replies, if you filled in **Public comment reply**.',
                            ] },
                            'Create one from **Keyword replies** → **New campaign**, or add several at once with **Import CSV**. The **Campaign active** switch pauses a campaign without deleting it.',
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
                            '**في أي موضع من التعليق (الافتراضي):** الحملة تشتغل إذا كانت كلمتك موجودة في أي مكان داخل التعليق، حتى لو كانت جزءاً من كلمة أطول. مريحة، لأن «الكورس» و«كورسك» كلها تطابق «كورس».',
                            '**كلمة كاملة فقط:** أدق، لأن الكلمة لازم تجي لحالها مو داخل كلمة ثانية. النظام يدعمها لكل حملة لكنها مو الافتراضية، ونموذج الحملة ما فيه مفتاح لها حالياً؛ إذا احتجتها لحملة معيّنة كلّم مدير المنصة. وانتبه أنها أصرم: «كورس» ما تطابق «الكورس».',
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
                            '**Anywhere in the comment (default):** the campaign fires when your keyword appears anywhere in the comment, even inside a longer word. Convenient, because «الكورس» and «كورسك» both match «كورس».',
                            '**Whole word only:** stricter, because the keyword has to stand on its own. The system supports it per campaign, but it is not the default and the campaign form has no switch for it yet; if you need it for a campaign, ask your platform administrator. Note how strict it is: «كورس» no longer matches «الكورس».',
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
                            'من **الجدولة** ← **جدوِل منشوراً**، اختر **المنصة** وبعدها **نوع المنشور**:',
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
                            'اختر **إنستجرام + فيسبوك** وينزل المنشور نفسه على الاثنين بنفس النص.',
                            { ul: [
                                'ينشر على فيسبوك أول، وبعدين إنستجرام.',
                                'لو نجح واحد وفشل الثاني، المنشور يطلع **فشلت** ومعه السبب. ولما تعيد النشر، ينزل على اللي فشل بس، بدون تكرار على اللي نجح.',
                                'تبيه على تيك توك بعد؟ فعّل **أرسله إلى تيك توك أيضاً**، ويصير له منشور مستقل في الطابور. التفاصيل في [[tiktok]].',
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
                                'اختر **موعد النشر المطلوب** بتوقيت جهازك، واضغط **جدوِل**.',
                                'أو فعّل **انشر الآن بدل الجدولة** وينزل الحين.',
                                'المُجدوِل يفحص المنشورات المستحقة كل دقيقة، فالمنشور ينزل خلال دقائق من موعده، وتحت كل منشور تشوف متى يُتوقع ينزل.',
                                'ولو توقف الفحص المتكرر لأي سبب، يرجع المُجدوِل لتشغيل واحد في اليوم الساعة 00:00 بتوقيت UTC (3 الفجر بتوقيت الرياض)، وساعتها يُحسب اليوم مو الدقيقة.',
                                'تقدر تعدّل المنشور أو تحذفه ما دام **بالانتظار**.',
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
                                'ارجع لصفحة **النمو والتسويق** واضغط **زامن الآن**.',
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
                            'اضغط **اكتب لي خطة** في **مدرب النمو بالذكاء الاصطناعي**. يقرأ أرقام الفترة ونصوص منشوراتك وإعداداتك، ويكتب بلغة حسابك. تأخذ عادةً أقل من دقيقة، وتقدر تطلع من الصفحة وترجع تلقاها جاهزة.',
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
                            'الأرقام تتحدّث تلقائياً مرة في اليوم. لو تبيها الآن اضغط **زامن الآن**، ومسموح مرة كل عشر دقائق. تحت الزر مكتوب متى كانت آخر مزامنة.',
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
                                'اكتب الكلمة بالطريقة اللي يكتبها جمهورك: «ذكاء اصطناعي» غير «AI»، وكثير يبحثون بالعربية.',
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
                                'في **جدولة منشور جديد** يظهر حقل **النص البديل** للصورة، وحقل لكل شريحة في الكاروسيل، بنفس ترتيب الشرائح. الحد 200 حرف.',
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
                            'فعّله من **انشره ريلاً تجريبياً** لما يكون المنشور فيديو على إنستجرام.',
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
            related: ['studio-schedule', 'scheduling', 'troubleshooting', 'whatsapp'],
            sections: [
                {
                    id: 'connect',
                    title: { ar: 'ربط تيك توك', en: 'Connecting TikTok' },
                    body: {
                        ar: [
                            { ol: [
                                'افتح **الإعدادات** ← قسم **تيك توك** واضغط **اربط تيك توك**. (الزر يظهر لمالك الحساب فقط.)',
                                'يفتح لك تيك توك: سجّل دخولك بالحساب اللي تبي تنشر عليه، ووافق على الصلاحيات.',
                                'ترجع للإعدادات وتشوف اسم الحساب وجنبه **متصل**، وتحته **طريقة النشر** الحالية.',
                            ] },
                            { ul: [
                                'الربط يدوم **سنة وحدة**. قبل ما يخلص تشوف تاريخاً وتنبيهاً، فاضغط **أعد الربط** قبل ذاك اليوم.',
                                'لو شفت **يحتاج إلى إعادة الربط**، اضغط **أعد الربط** وبس. منشوراتك المجدولة تظل في الطابور.',
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
                            'الخيار الثاني في منشئ المنشورات هو **أرسله إلى مسوداتي في تيك توك (صندوق الوارد)**: المنشور يوصل مسودّاتك، وتكمله وتنشره أنت من التطبيق.',
                            { warn: 'هذا الوضع ما يُعتمد عليه: الإشعار أحياناً ما يوصل، والمسودّة أحياناً ما تظهر، وتيك توك ما يسمح بأكثر من 5 مسودّات معلّقة كل 24 ساعة. ننصحك بالنشر المباشر: **انشره مباشرة في حسابي على تيك توك**.' },
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
                                'وزر **انشر منشورات الكاروسيل المنتظرة على تيك توك** يختفي، لأنه ما عاد له داعي.',
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
                                'الاستوديو يضيف **سطر نص تيك توك** من إعداداته لكل وصف، مثل: «الرابط في البايو».',
                                'والشريحة الأخيرة في نسخة تيك توك تقول نفس الكلام.',
                            ] },
                            { warn: 'تأكد أن الرابط موجود فعلاً في البايو. تيك توك ما يعطي خانة **الموقع الإلكتروني** في الملف الشخصي لكل الحسابات: عادة لحسابات الأعمال، أو للحسابات اللي تعدّت عدداً من المتابعين (غالباً 1000)، والشرط يختلف من بلد لبلد. افتح **تعديل الملف الشخصي** في تيك توك وتأكد أن الخانة موجودة عندك قبل ما تنشر.' },
                        ],
                        en: [
                            'TikTok doesn’t allow automatic DMs to commenters, so keyword campaigns can’t run there. That is why TikTok captions point people to the link in your bio:',
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
        // ─── 5b. WhatsApp ────────────────────────────────────────────────────
        {
            slug: 'whatsapp',
            group: 'whatsapp',
            icon: 'message-circle',
            title: { ar: 'واتساب: تجهيز ميتا والربط والتكلفة', en: 'WhatsApp: Meta setup, connecting and costs' },
            summary: {
                ar: 'خطوات ميتا لمرة وحدة، وربط الرقم باللوحة، وتجربته على جوالك قبل ما يرد على أي عميل، وروابط الحملات وأسئلة البداية، وكم يكلّف بعد الألف ردّ المجانية.',
                en: 'The one-time Meta steps, connecting the number here, testing it on your own phone before it answers a customer, campaign links and ice breakers, and what it costs past the first 1,000 free replies.',
            },
            related: ['connect-meta', 'troubleshooting', 'faq'],
            sections: [
                {
                    id: 'what',
                    title: { ar: 'وش يسوّي مساعد واتساب؟', en: 'What the WhatsApp assistant does' },
                    body: {
                        ar: [
                            'مساعد واتساب يرد على الرسائل اللي توصل لرقم نشاطك، بأسلوبك، وأنت مشغول أو نايم. وهذي حدوده:',
                            { ul: [
                                'يجاوب عن نشاطك بس: منتجاتك وأسعارك وعروضك اللي كتبتها أنت في **مساعد الرسائل**. وإذا سألوه عن شي بعيد، يرجّعهم بلطف لموضوعك.',
                                'يقول من أول رد إنه مساعد آلي، وما يتخفّى في صورة إنسان.',
                                'إذا العميل طلب يكلّم شخص، المساعد يوقف ويأكد له أن شخصاً بيرد عليه، وتكمل أنت من **الرسائل**.',
                            ] },
                            { note: 'كل رقم جديد يبدأ **متوقف**: ما يرد المساعد على أحد لين تشغّله أنت بنفسك. وتقدر تجرّبه على جوالك أول: شوف [[whatsapp#test]].' },
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
                    title: { ar: 'تجهيز ميتا (مرة وحدة)', en: 'Setting up Meta (once)' },
                    body: {
                        ar: [
                            'هذي خطوات ميتا. تسويها مرة وحدة، وما تدفع فيها شي ولا تحتاج بطاقة:',
                            { ol: [
                                'افتح تطبيق ميتا (رقمه `847772258381375`) من developers.facebook.com، وأضف له حالة الاستخدام الخاصة بواتساب: Use cases ثم Add. وإذا ما ظهرت كخيار متوافق مع التطبيق، وقّف عندك وبلّغ مسؤول المنصة.',
                                'من واتساب ← API Setup تنشئ لك ميتا رقماً تجريبياً مجانياً. أضف جوالك مستلماً، واكتب الرمز اللي يوصلك من واتساب لتأكيده.',
                                'من واتساب ← Configuration ضع رابط الويبهوك (تحت القائمة) في خانة Callback URL. وفي خانة رمز التحقق الصق الرمز اللي في **الإعدادات** ← **رمز التحقق للويبهوك** في مساحة العمل الافتراضية، واضغط **Verify and save**. بعدها اشترك في الحقول السبعة المكتوبة تحت.',
                                'من business.facebook.com افتح Business Settings ← Users ← **System users**، وأضف مستخدم نظام بدور مدير (Admin).',
                                'اضغط **Assign assets** وأعطه التطبيق وحساب واتساب للأعمال بتحكم كامل (Full control).',
                                'اضغط **Generate token**، واختر التطبيق، وفعّل الصلاحيات الثلاث المكتوبة تحت، وخلّ الانتهاء «Never».',
                            ] },
                            { code: 'https://msg-response-auto.vercel.app/webhook', caption: 'رابط الويبهوك' },
                            { code: 'messages\naccount_update\naccount_alerts\nphone_number_quality_update\nphone_number_name_update\nbusiness_capability_update\nuser_preferences', caption: 'الحقول السبعة اللي تشترك فيها' },
                            { code: 'whatsapp_business_messaging\nwhatsapp_business_management\nbusiness_management', caption: 'صلاحيات الرمز' },
                            { warn: 'الرمز يظهر مرة وحدة بس، لما تضغط **Generate token**. انسخه في نفس اللحظة والصقه في اللوحة مباشرة (شوف [[whatsapp#connect]])، ولا تلصقه في أي محادثة أو بريد أو رسالة لأي أحد، حتى لو كان من فريقك.' },
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
                            'بعد ما تجهّز ميتا، افتح **الإعدادات** وانزل لقسم **واتساب** (بعد يوتيوب):',
                            { ol: [
                                'الصق **معرّف حساب واتساب للأعمال**: أرقام فقط، وتلقاه في ميتا ← واتساب ← API Setup.',
                                'الصق **معرّف رقم الهاتف**: أرقام فقط أيضاً، وهو غير رقم الهاتف نفسه.',
                                'الصق الرمز الدائم في **رمز الوصول**. الحقل مخفي، وينمسح من الصفحة لحظة ما تضغط الزر، وما يرجع يظهر لك ولا لأحد.',
                                'اضغط **اربط الرقم**. اللوحة تفحص الرمز مع ميتا، وتشترك في أحداث الحساب، وتحفظ الرمز مشفّراً.',
                            ] },
                            { note: 'الزر يظهر لمالك الحساب فقط. بقية الأعضاء يشوفون الحالة بدون ما يغيّرون شي.' },
                            'وبعد الربط تشوف في القسم:',
                            { dl: [
                                ['متصل', 'الربط شغّال. وإذا شفت **يحتاج إعادة ربط** فميتا رفضت الرمز المخزَّن: أصدر رمزاً جديداً والصقه في نموذج **أعد الربط**.'],
                                ['رقم اختبار', 'رقم تجريبي من ميتا: يوصل للأرقام اللي أضفتها مستلمين بس، ولا يمكن تشغيل المساعد للجميع عليه.'],
                                ['حالة الرقم', 'حالة الرقم عند ميتا، مثل متصل أو مقيَّد.'],
                                ['الجودة', 'تقييم ميتا لجودة رسائلك: عالية أو متوسطة أو منخفضة.'],
                                ['حد المراسلة', 'عدد جهات الاتصال اللي تقدر تبدأ معها محادثة خلال 24 ساعة. وما يقيّد ردّك على اللي يراسلك أولاً.'],
                                ['الردود المجانية هذا الشهر', 'عدّاد من 1,000: كم ردّاً مجانياً استُخدم، مع التكلفة المقدّرة. وإذا ظهرت رسالة بدل الأرقام فالعدّاد غير متاح الحين، وهذا لا يعني أن الردود توقفت.'],
                            ] },
                            'وتحت بطاقة الرقم زران: **حدّث الحالة** يقرأ حالة الرقم من ميتا من جديد، و**افصل واتساب** يحذف الرمز المخزَّن ويرجّع المساعد إلى **متوقف**، ويسألك قبل ما ينفّذ.',
                        ],
                        en: [
                            'Once Meta is ready, open **Settings** and scroll to the **WhatsApp** section (after YouTube):',
                            { ol: [
                                'Paste the **WhatsApp Business Account ID**: digits only, found in Meta under WhatsApp → API Setup.',
                                'Paste the **Phone number ID**: digits only too, and not the phone number itself.',
                                'Paste the permanent token into **Access token**. The field is hidden, it is emptied the moment you press the button, and it never comes back to you or to anyone.',
                                'Press **Connect number**. The dashboard checks the token with Meta, subscribes to the account’s events, and stores the token encrypted.',
                            ] },
                            { note: 'The button is shown to the account owner only. Other members see the status and can’t change anything.' },
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
                            'قبل ما يرد المساعد على أي عميل، تأكد أن الرسائل توصل:',
                            { ol: [
                                'في قسم **المساعد على واتساب** اختر **مرسلو الاختبار فقط**.',
                                'اكتب رقم جوالك في **مرسلو الاختبار**: بالأرقام الدولية مع رمز الدولة، بلا + ولا صفر في أوله (مثل `201001234567` أو `966501234567`)، ورقم في كل سطر.',
                                'اضغط **احفظ**.',
                                'من جوالك أرسل رسالة للرقم التجريبي.',
                                'افتح **الرسائل**: لازم تلقى رسالتك هناك. لا تنتظر رداً الحين: هذه الخطوة تثبت بس أن الرسالة توصل.',
                            ] },
                            { tip: 'خيار **الجميع** معطّل لين تكتمل شروط الإطلاق: صفحات الخصوصية والفحوصات المطلوبة. وتقدر ترجع تطفي المساعد بأي وقت باختيار **متوقف**.' },
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
                    title: { ar: 'روابط الحملات ورموز QR', en: 'Campaign links and QR codes' },
                    body: {
                        ar: [
                            'الرابط القصير ورمز QR يفتحان محادثة واتساب مع رقمك مباشرة، والعميل يلقى رسالتك الأولى مكتوبة وجاهزة للإرسال. حطّ الرابط في سيرة حسابك، أو اطبع الرمز على ملصق، أو استخدمهما في إعلان. وسوّ رابطاً لكل مكان، فتعرف أي مكان يجيب لك محادثات:',
                            { ol: [
                                'افتح **الإعدادات** وانزل لقسم **واتساب**، ثم لقسم **روابط الحملات ورموز QR**.',
                                'اكتب في **اسم الرابط** اسماً لك أنت، مثل «سيرة إنستجرام». العميل ما يشوفه.',
                                'اكتب في **الرسالة الأولى** الجملة اللي يبدأ بها العميل المحادثة، حتى 120 حرفاً.',
                                'اضغط **أنشئ الرابط**. يظهر الرابط ورمز QR في القائمة تحت.',
                            ] },
                            'وفي القائمة، لكل رابط:',
                            { dl: [
                                ['الرابط القصير', 'اضغط **انسخ الرابط** والصقه حيث تبي.'],
                                ['رمز QR', 'اضغط **نزّل الصورة**. قد تنفتح الصورة في تبويب جديد، فاحفظها منه ثم ركّبها في تصميمك أو اطبعها.'],
                                ['رمز التتبّع', 'رمز قصير مثل `#K7M3QA` نضيفه في آخر رسالتك الأولى. يراه العميل داخل الرسالة، فلا تحذفه من الرابط. ولو حذفه العميل نفسه قبل الإرسال ما نعرف من أي رابط جاء.'],
                                ['المحادثات التي بدأت منه', 'يظهر العدد لما يتوفر. إذا ما شفت رقماً فالعدّ ما بدأ بعد، وهذا لا يعني أن الرابط ما يشتغل.'],
                            ] },
                            { note: 'المالك وحده ينشئ الروابط ويحذفها، وبقية الأعضاء يشوفون القائمة بس. وزر **احذف** يسألك قبل التنفيذ: لما يُحذف الرابط يُحذف رمزه معه عند ميتا، وكل نسخة مطبوعة أو منشورة منهما تتوقف.' },
                        ],
                        en: [
                            'The short link and the QR code open a WhatsApp chat with your number directly, and the customer finds your first message typed and ready to send. Put the link in your bio, print the code on a poster, or use either in an ad. Make one link for each place, and you can see which place brings you chats:',
                            { ol: [
                                'Open **Settings** and scroll to the **WhatsApp** section, then to **Campaign links and QR codes**.',
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
                            'أسئلة البداية أسئلة قصيرة يضغط عليها العميل لما يفتح محادثة جديدة مع رقمك، من غير ما يكتب. الضغطة توصلك كرسالة عادية منه، ويجاوب عنها المساعد. تقدر تحط حتى 4 أسئلة:',
                            { ol: [
                                'افتح **الإعدادات** ← **واتساب** ← **أسئلة البداية في واتساب**.',
                                'اكتب سؤالاً في كل خانة **السؤال**: حتى 80 حرفاً، وبلا إيموجي. اترك الخانات الزائدة فاضية.',
                                'اضغط **احفظ الأسئلة**. بعد الحفظ تقرأ اللوحة ما عند ميتا وتعرضه، فإذا اختلف عمّا كتبته تنبّهك.',
                            ] },
                            { note: 'واتساب يخفي هذه الأسئلة عمّن يفتح المحادثة من رابط فيه رسالة جاهزة، وكل رابط تنشئه من **روابط الحملات ورموز QR** فيه رسالة جاهزة. فتظهر الأسئلة لمن يبدأ المحادثة من رقمك مباشرة. هذي قاعدة ميتا، مو إعداد عندنا.' },
                            { tip: 'اكتب الأسئلة كما يسأل العميل فعلاً، مثل «كم السعر؟» أو «وش المنتجات؟»، لأن الضغطة توصل المساعد نصاً عادياً.' },
                        ],
                        en: [
                            'Ice breakers are short questions a customer can tap when they open a new chat with your number, without typing. A tap reaches you as an ordinary message from them, and the assistant answers it. You can set up to 4:',
                            { ol: [
                                'Open **Settings** → **WhatsApp** → **WhatsApp ice breakers**.',
                                'Write one question in each **Question** field: up to 80 characters, with no emoji. Leave the extra fields empty.',
                                'Press **Save ice breakers**. After saving, the dashboard reads what Meta holds and shows it, and warns you if it differs from what you wrote.',
                            ] },
                            { note: 'WhatsApp hides ice breakers from anyone who opens the chat from a link with a prefilled message, and every link you make in **Campaign links and QR codes** has one. So the questions show for people who start a chat from your number directly. That is Meta’s rule, not a setting of ours.' },
                            { tip: 'Write the questions the way a customer really asks, like “How much is it?” or “What do you sell?”, because a tap reaches the assistant as plain text.' },
                        ],
                    },
                },
                {
                    id: 'customers',
                    title: { ar: 'لو الرقم لعميل عندك', en: 'When the number belongs to a customer' },
                    body: {
                        ar: [
                            'إذا تدير واتساب لعميل عندك على اللوحة، قل له من البداية:',
                            { ul: [
                                'يجيب شريحة جديدة ما استُخدمت قبل على واتساب، وتقدر تستقبل رسالة نصية أو مكالمة واحدة للتحقق. رقمه المسجّل حالياً على واتساب ما يصلح.',
                                'عملاؤه يشوفون الرقم نفسه مو اسم نشاطه، لين يوثّق النشاط عند ميتا.',
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
                                'المحادثات اللي تبدأ من إعلان «انقر للمراسلة على واتساب» ردودها مجانية لين 7 أيام.',
                                'الإرسال المدفوع ممنوع إلا إذا فعّلت خيار **الرسائل المدفوعة** في بطاقة واتساب. هو مغلق افتراضياً، ولما تفعّله تطلب منك اللوحة تأكيداً. وما دام مغلقاً ما يرسل المساعد شي تحاسب عليه ميتا.',
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
                    title: { ar: 'حلول المشاكل', en: 'Troubleshooting' },
                    body: {
                        ar: [
                            { qa: [
                                ['**Verify and save** رمادي ولا أقدر أضغطه', 'خانة رمز التحقق فاضية. الصق فيها الرمز اللي في **الإعدادات** ← **رمز التحقق للويبهوك**، في مساحة العمل الافتراضية.'],
                                ['يظهر «No permissions available» وأنا أصدر الرمز', 'ما عيّنت التطبيق لمستخدم النظام. افتح **System users**، واضغط **Assign assets** وأعطه التطبيق بتحكم كامل، وبعدها جرّب **Generate token** من جديد.'],
                                ['التطبيق ما يظهر في قائمة الأصول', 'أضف التطبيق `847772258381375` إلى محفظة الأعمال (Business portfolio) من Business Settings، وارجع لـ **Assign assets**.'],
                                ['ما يوصل شي وصندوق الرسائل فاضي', { ul: [
                                    'ما اشتركت في الحقول السبعة في صفحة Configuration عند ميتا. راجع [[whatsapp#meta-setup]].',
                                    'الرقم مو مربوط هنا: افتح **الإعدادات** ← **واتساب** وتأكد أن الحالة **متصل**.',
                                    'الرقم مربوط في مساحة عمل ثانية: افصله هناك أول.',
                                ] }],
                                ['اللوحة ترفض الربط', ['اللوحة تكتب سبب الرفض بنفسها تحت الحقل المقصود، وتضيف كلام ميتا أسفله. هذي أشهر الرسائل:', { dl: [
                                    ['«رفضت ميتا هذا الرمز»', 'الرمز منتهٍ أو ملغى أو صادر لتطبيق ثاني. أصدر رمزاً جديداً.'],
                                    ['«الرمز صالح لكنه لا يحمل الصلاحيتين المطلوبتين»', 'أصدره من جديد وفعّل `whatsapp_business_messaging` و`whatsapp_business_management`.'],
                                    ['«لا يستطيع هذا الرمز قراءة رقم الهاتف»', 'راجع **معرّف رقم الهاتف**، وتأكد أن مستخدم النظام يملك حساب واتساب هذا.'],
                                    ['«لم تؤكد ميتا اشتراك التطبيق في أحداث حساب واتساب للأعمال هذا»', 'راجع **معرّف حساب واتساب للأعمال**.'],
                                    ['«هذا الرقم مربوط بمساحة عمل أخرى»', 'افصله من هناك أول.'],
                                    ['«تعذّر الوصول إلى ميتا، ولم يُحفظ شيء»', 'مشكلة مؤقتة عند ميتا. أعد المحاولة بعد شوي.'],
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
                            'Ads in AutoReply Pro run on an access token that belongs to you, from the Meta business that owns the ad account. The token is made from a “system user”, a technical account inside Meta Business that is not tied to a person and does not stop working when someone changes a password. The steps are the same for the owner and for every client who manages their own account here.',
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
                            { warn: 'The token is like a password: whoever holds it can spend from your ad account. Never send it in a chat, an email or a screenshot, and never hand it to anyone. Each client pastes it themselves into their own dashboard, and AutoReply stores it encrypted and never shows it again after saving.' },
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
                            'ترسل أوتوريبلاي تنبيهاً حين يحدث ما يستحق انتباهك. هذه هي الأنواع:',
                            { dl: [
                                ['إيقاف الإنفاق عند السقف', 'أوقف الحارس الحملات لأن الإنفاق وصل إلى سقفك الشهري أو كاد.'],
                                ['مشكلة في الدفع', 'فشل الخصم أو لا توجد وسيلة دفع صالحة في الحساب الإعلاني.'],
                                ['تعطيل الحساب الإعلاني', 'عطّلت ميتا الحساب أو قيّدته.'],
                                ['توقف الرمز عن العمل', 'انتهت صلاحية الرمز أو أُلغي، فلا تستطيع أوتوريبلاي قراءة الحساب ولا إيقاف الحملات.'],
                                ['اقتراب انتهاء الرمز', 'ينتهي الرمز قريباً. يخص الرموز التي لها تاريخ انتهاء، مثل رمز الاتصال عبر فيسبوك.'],
                                ['تعذّر فحص الإنفاق', 'لم يستطع الحارس فحص الحساب ساعتين متتاليتين.'],
                                ['تغيّر إصدار الواجهة', 'ردّت ميتا بإصدار غير الإصدار الذي نثبّته، فقد تختلف بعض السلوكيات.'],
                            ] },
                            'لا يصلك التنبيه نفسه عن الشيء نفسه أكثر من مرة واحدة في اليوم، حتى لا تُغرَق بالرسائل.',
                            { ul: [
                                'يصل التنبيه إلى **رقم محادثتك** في تيليجرام و/أو إلى بريدك الإلكتروني، وتحدّدهما في **الإعدادات** ← **إعلانات ميتا (الترويج)** ← **مستلمو التنبيهات**. ويصل إلى مدير المنصة نسخة منه.',
                                'ولمعرفة رقم محادثتك في تيليجرام: افتح حساب التنبيهات الذي يعطيك اسمه مدير المنصة واضغط **Start**، ثم أرسل أي رسالة إلى `@userinfobot` فيردّ عليك برقم Id. الصقه في خانة **رقم محادثتك**.',
                                'اضغط **أرسل رسالة تجريبية** بعد الحفظ، لتتأكد أن التنبيه يصلك.',
                                'يمكنك إطفاء أنواع التنبيه بمفتاح لكل نوع، عدا ثلاثة لا يمكن إطفاؤها: إيقاف الإنفاق عند السقف، وتعذّر فحص الإنفاق، وتوقف الرمز عن العمل. فهي التي تحمي مالك.',
                            ] },
                            { tip: 'ضع الوسيلتين معاً، تيليجرام وبريداً، إن كان الإنفاق كبيراً. فقد تفوتك رسالة واحدة.' },
                        ],
                        en: [
                            'AutoReply sends an alert when something happens that deserves your attention. These are the kinds:',
                            { dl: [
                                ['Spending paused at the cap', 'The guard paused campaigns because spend reached or was about to pass your monthly cap.'],
                                ['Payment problem', 'A charge failed or the ad account has no valid payment method.'],
                                ['Ad account disabled', 'Meta disabled or restricted the account.'],
                                ['Token stopped working', 'The token expired or was revoked, so AutoReply can neither read the account nor pause campaigns.'],
                                ['Token expiring', 'The token ends soon. This applies to tokens with an end date, such as the Facebook Connect one.'],
                                ['Guard can’t check', 'The guard could not check the account for two hours in a row.'],
                                ['API version changed', 'Meta answered with a version other than the one we pin, so some behaviour may differ.'],
                            ] },
                            'You never get the same alert about the same thing more than once a day, so you are not flooded.',
                            { ul: [
                                'An alert goes to your Telegram chat id and/or your email, both set in **Settings** → **Meta ads (Boost)** → **Alert recipients**. The platform administrator gets a copy.',
                                'To find your Telegram chat id: open the alerts account whose name the platform administrator gives you and press **Start**, then send any message to `@userinfobot`, which replies with your Id. Paste it into **Your chat id**.',
                                'Press **Send test message** after saving, to be sure the alert reaches you.',
                                'You can switch each kind off with its own toggle, except three that cannot be switched off: spending paused at the cap, guard can’t check, and token stopped working. Those are the ones that protect your money.',
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
                            { tip: 'لا تكرر الضغط على الزر: الطلب نفسه محفوظ مرة واحدة، والضغط مرة ثانية لا يرسله مرتين.' },
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
                            'قبل أن تبدأ تأكّد من ثلاثة أمور: الحساب الإعلاني مربوط وحدّاك مضبوطان ([[ads#connect]] و[[ads#limits]])، والمنشور منشور فعلاً (الأفضل ريلز على إنستجرام)، ووجهتك مستوفية شرطها:',
                            { dl: [
                                ['إنستجرام', 'حساب إنستجرام احترافي مربوط بالصفحة.'],
                                ['ماسنجر', 'الصفحة نفسها. ولا يصلح منشور فيسبوك لإعلان ماسنجر حالياً، فاستخدم نسخة إنستجرام من الريلز.'],
                                ['واتساب', 'رقم واتساب للأعمال مربوط بالصفحة.'],
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
                            { warn: 'يفحص النموذج المساعد في كل وجهة اخترتها. إن كان متوقفاً فلن يردّ أحد على من يراسلك من الإعلان. وإن كان وكيل واتساب في وضع التجربة فلن يردّ إلا على أرقام الاختبار. وإن كان البيع في الرسائل في وضع التجربة فسيردّ المساعد على الجميع لكنه لن يعرض البيع إلا على المختبرين. وإن لم تكن الوجهة مربوطة فلا رد كذلك. فعِّل المساعد قبل تفعيل الإعلان: [[whatsapp#connect]] لواتساب، وإعدادات المساعد للرسائل في إنستجرام وماسنجر.' },
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
                            { warn: 'The form checks the assistant for each destination you chose. If it is off, nobody answers the people who message you from the ad. If the WhatsApp agent is in test mode, only the test numbers get an answer. If sales in your DMs are in test mode, the assistant answers everyone but sells only to your testers. If the destination is not connected, there is no answer either. Switch the assistant on before you activate the ad: [[whatsapp#connect]] for WhatsApp, and the message assistant’s settings for Instagram and Messenger.' },
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
                            'إعلان المراسلة يفتح محادثة بدل أن يفتح موقعًا: يضغط الشخص على الإعلان فتُفتح له رسائل إنستغرام أو ماسنجر أو واتساب مع حسابك. وترسل ميتا مع أول رسالة معلومة صغيرة تقول من أي إعلان جاء، فتحفظها أوتوريبلاي مع المحادثة.',
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
                                'لا تُعطى للبوت روابط الصور ولا الفيديو، ولا معرّف الإعلان.',
                                'يعمل هذا في وضع البيع (Sales mode) للبوت، على إنستغرام وماسنجر.',
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
                            'ومنذ 28 سبتمبر 2026 تعطي ميتا المحادثات التي بدأت من إعلان مراسلة على إنستغرام أو ماسنجر نافذة تصل إلى 7 أيام من الضغطة. ويطبّقها المساعد (7 أيام إلا ساعة) فقط إن شغّلت «استعمل النافذة الأطول على إنستغرام» (أو «على ماسنجر») للمنصة.',
                            { h: 'لماذا هو مفتاح مطفأ؟' },
                            'لأن ميتا ذكرت هذا لإنستغرام ولم يظهر بعد في صفحة ماسنجر، والرسالة التي تُرسل خارج النافذة تُرفض وقد تضرّ بالحساب. فجرّبه أولًا:',
                            { ol: [
                                'افتح محادثة بدأت من إعلان، ومرّ عليها يوم كامل دون رسالة من الشخص.',
                                'في اليوم الثاني، أرسل ردًّا يدويًّا من حسابك.',
                                'إن وصل الرد، شغّل «استعمل النافذة الأطول على إنستغرام» (أو «على ماسنجر») لتلك المنصة. وإن رُفض، فاتركه مطفأً.',
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
                            'لدى ميتا مساعد خاص بها اسمه «ذكاء الأعمال» (Business AI) يستطيع أن يجيب في رسائل إنستغرام. وإذا كان يتولى محادثة، ترفض ميتا كل رسالة يرسلها المساعد فيها (الخطأ 100 / 2534037)، فيبدو المساعد صامتًا، وغالبًا في محادثات الإعلانات تحديدًا.',
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
                                '**الهدف:** رسائل، أو وصول، أو تفاعل، أو زيارات لرابط. إعلانات العملاء المحتملين تأتي لاحقًا.',
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
                                '**Goal:** messages, reach, engagement or traffic to a link. Lead ads come later.',
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
                                ['المدن', 'ابحث عن المدينة باسمها، ثم اختر نصف قطر بين 10 و80 كيلومترًا حولها.'],
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
                                ['Cities', 'Search a city by name, then choose a radius of 10 to 80 km around it.'],
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
                                ['المتفاعلون على إنستغرام', 'من أعجبوا أو علّقوا أو حفظوا أو شاركوا أو زاروا حسابك، أو من أرسلوا إليه رسالة. حتى 730 يومًا.'],
                                ['المتفاعلون مع صفحة فيسبوك', 'من تفاعلوا مع الصفحة أو منشوراتها، أو زاروها، أو نقروا زرًا فيها، أو أرسلوا رسالة. حتى 730 يومًا.'],
                                ['من أرسلوا رسالة', 'من راسلوا حسابك على إنستغرام أو صفحتك أو كليهما. حتى 730 يومًا.'],
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
                                'أنشئ أولًا جمهورًا مصدرًا، مثل المتفاعلين على إنستغرام في آخر 90 يومًا، وانتظر حتى يصبح جاهزًا.',
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
                                'لا تُحفظ: يُقرأ النص في الطلب نفسه ثم يُترك. لا يبقى منه إلا عدد الصفوف المرسلة. وتُمسح الرموز المموّهة من قائمة الانتظار فور انتهاء الرفع.',
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
                    title: { ar: 'لعملاء الخدمة المُدارة', en: 'For managed clients' },
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
                                'انسخ الرمز فوراً، فهو يظهر مرة واحدة فقط.',
                                'في أوتوريبلاي برو افتح **الإعدادات** ← بطاقة «إعلانات ميتا»، والصق الرمز في خانة **رمز إعلانات مستخدم النظام**، ثم اضغط **اختبر الاتصال**.',
                                'اختر حسابك من **اختر حساباً إعلانياً**، وتأكد أن الاسم والعملة صحيحان وأن الحالة نشطة.',
                                'تأكد من وسيلة الدفع: تعرض شاشة الإعلانات إن كانت مضافة. وإن لم تكن، فأضفها من ميتا نفسها (Billing & payments في مدير الإعلانات)، فلا تتيح ميتا إضافتها من مكان آخر.',
                                'حدّد **أقصى ميزانية يومية** و**سقف الإنفاق الشهري**، ثم اضغط **احفظ**.',
                                'اضغط **افتح شاشة الإعلانات** وتأكد أنها لا تعرض خطوة ناقصة. كل ما تنشئه يبدأ متوقفاً، ولا يُنفَق شيء قبل أن تضغط «فعّل».',
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
                            'عند تفعيله يرى مدير حسابك ما أُنفق هذا الشهر واليوم، وسقفك الشهري وأقصى ميزانية يومية. وهو مطفأ ما لم تفعّله. لإيقاف المشاركة أطفئ الخيار نفسه، ويسري ذلك فوراً. ويسجَّل كل تغيير في سجل التدقيق، ولا يغيّره إلا المالك.',
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
                            'القاعدة تعليمة دائمة تكتبها مرة واحدة: إذا تحققت هذه الشروط في إعلان أو مجموعة إعلانية أو حملة، فافعل كذا. يفحصها أوتوريبلاي برو كل ساعة نيابة عنك.',
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
                                ['استراحة 24 ساعة', 'بعد أن تغيّر قاعدة عنصراً ما، لا تغيّره القاعدة نفسها مرة ثانية قبل مرور 24 ساعة. فخفض 20% لا يتكرر كل ساعة.'],
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
                                ['تكلفة المحادثة مرتفعة: إيقاف', 'تنظر إلى الإعلانات. إذا زادت تكلفة المحادثة في آخر ثلاثة أيام على الحد الذي تضعه أنت، وبعد أن يبلغ الإعلان 500 ظهور، أوقفته وأرسلت تنبيهاً. استخدمها حين تريد ألا يستمر إعلان في استهلاك المال دون محادثات.'],
                                ['الإنفاق سريع: تنبيه', 'تنظر إلى المجموعات الإعلانية. إذا تجاوزت وتيرة الإنفاق اليوم 1.5 مرة، أرسلت تنبيهاً ولم تغيّر شيئاً. استخدمها حين تريد أن تعرف فقط أن ميزانية اليوم تنفد مبكراً.'],
                                ['التكرار فوق 3: خفض الميزانية 20%', 'تنظر إلى الحملات. إذا زاد التكرار اليوم على 3، وبعد 1000 ظهور، خفضت الميزانية اليومية للحملة بنسبة 20% وأرسلت تنبيهاً. استخدمها حين يملّ الجمهور من رؤية الإعلان نفسه. ولا تعمل إلا على حملة لها ميزانية يومية خاصة بها.'],
                                ['إعلان مرفوض: تنبيه', 'تنظر إلى الإعلانات. إذا رفضت ميتا إعلاناً أو وجدت فيه مشكلة أرسلت تنبيهاً. استخدمها دائماً تقريباً، فهي لا تغيّر شيئاً.'],
                            ] },
                            'أمثلة بأرقام:',
                            { ul: [
                                'أوقف الإعلان إذا زادت تكلفة المحادثة على 15 ريالاً خلال ثلاثة أيام، بعد 500 ظهور. إعلان صرف 60 ريالاً وجاءته 3 محادثات تكلفته 20 ريالاً، فيُوقَف وتصلك رسالة تنبيه.',
                                'نبّهني إذا تجاوزت وتيرة الإنفاق 1.5. مجموعة ميزانيتها 100 ريال صرفت 50 ريالاً عند الساعة السادسة صباحاً (ربع اليوم) وتيرتها 2، فيصلك تنبيه.',
                                'اخفض الميزانية 20% إذا زاد التكرار اليوم على 3، بعد 1000 ظهور. حملة ميزانيتها 50 ريالاً في اليوم تصبح 40 ريالاً، ولا تُخفض مرة ثانية قبل مرور 24 ساعة.',
                                'نبّهني إذا رُفض إعلان. إذا وجدت ميتا مشكلة في أحد إعلاناتك يصلك تنبيه به في الفحص التالي.',
                            ] },
                            { tip: 'ابدأ بقاعدة تنبّه فقط، وراجع السجل أياماً، ثم أضف الإيقاف أو الخفض حين تطمئن إلى أن الأرقام تعمل كما تتوقع.' },
                        ],
                        en: [
                            'Four ready-made templates to start from, instead of writing a rule from scratch. You can change their numbers before you save.',
                            { dl: [
                                ['Cost per conversation too high: pause', 'Looks at ads. If the cost per conversation over the last 3 days is above the limit you set, and the ad has reached 500 impressions, it pauses the ad and notifies you. Use it when you do not want an ad to keep spending without conversations.'],
                                ['Spending too fast: notify', 'Looks at ad sets. If today’s spending pace goes above 1.5, it notifies you and changes nothing. Use it when you just want to know that today’s budget is running out early.'],
                                ['Frequency over 3: lower budget 20%', 'Looks at campaigns. If today’s frequency is above 3, after 1,000 impressions, it lowers the campaign’s daily budget by 20% and notifies you. Use it when your audience is getting tired of seeing the same ad. It only works on a campaign that holds its own daily budget.'],
                                ['Ad rejected: notify', 'Looks at ads. If Meta disapproves an ad or finds a problem with it, it notifies you. Almost always worth having, since it changes nothing.'],
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
                            'يشترط قانون حماية البيانات الشخصية في مصر (رقم 151 لسنة 2020، ومهلة الامتثال تنتهي في 1 نوفمبر 2026) ترخيصًا لمن يعالج البيانات، وترخيصًا منفصلًا للتسويق الإلكتروني المباشر، وموافقة الشخص على نقل بياناته خارج مصر. ويشترط نظام حماية البيانات الشخصية في السعودية الموافقة على التسويق وحق إلغاء الاشتراك وحفظ السجلات. الاعتماد هو أن يسجّل مدير المنصة أن رأيًا قانونيًا يغطي ذلك لدولك: من أصدره، ومتى، ولأي دول. وإذا أُلغي الاعتماد توقف جمع العملاء الجدد فورًا، وبقي من جُمع قبلُ خاضعًا لمدة الحفظ نفسها.',
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
                            'لا يتواصل أوتوريبلاي مع أي عميل محتمل من تلقاء نفسه، ولا يسلّمه إلى وكيل الرسائل أو واتساب. ويبيّن عمود «وافق على التواصل» من قال نعم لسؤال الموافقة. وفي مصر يحتاج التسويق الإلكتروني المباشر ترخيصًا خاصًا وسجلًا للموافقات، وفي السعودية يجب أن تعرّف بنفسك في كل رسالة وأن تتيح إلغاء الاشتراك.',
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
                            'AutoReply never contacts a lead by itself and never hands one to the messaging or WhatsApp agent. The "Agreed to be contacted" column shows who said yes to the consent question. In Egypt direct electronic marketing needs its own licence and a consent register; in Saudi Arabia every message must say who you are and offer a way to unsubscribe.',
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
                            'ويرسم كل كاروسيل بمقاسين: **إنستجرام 4:5** و**تيك توك 9:16**. وما ينشر شي بدون ما تراجعه وتضغط **جدوِل** بنفسك.',
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
                                '**راجع وجدوِل:** افتح المسودّة، شيّك الشرائح في المعاينة، عدّل اللي تبي واضغط **احفظ وحدّث المعاينة**. بعدها **إلى الجدولة**، اختر الموعد، واضغط **جدوِل**.',
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
                                '**افحص الدروس وفهرسها:** **افحص المكتبة**، وبعدها فهرسة الدروس. التفاصيل في [[library]].',
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
                            '**خطّط أسبوعي** يقترح لك عدة كاروسيل للأسبوع مع مواعيدها. استبعد اللي ما يعجبك، واضغط **أنشئ الكل**، وتنكتب وحدة ورا الثانية.',
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
                                '**تلغيه بضغطة:** من إعدادات الاستوديو ← **العمّال** ← **ألغِ**، والرمز ينرفض من اللحظة نفسها.',
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
                                'من الاستوديو ← **الإعدادات** ← **العمّال**: اكتب اسماً في **عامل جديد** (مثلاً «ماك الاستوديو») واضغط **أنشئ عاملاً**. انسخ الرمز الحين لأنه ما يظهر مرة ثانية، واضغط **نسخته**.',
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
                            'اضغط **افحص المكتبة** في أعلى صفحة **منشورات الكاروسيل**. العامل يدوّر على الفيديوهات ويضيفها دروساً بحالة **غير مفهرس بعد**. الفحص ما يحذف أي درس، ولو أضفت فيديوهات بعدين افحص مرة ثانية.',
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
                            'ابدأ الفهرسة بـ**فهرس الناقص** (كل اللي ما انفهرس)، أو **فهرس الباقي**، أو لدرس واحد: افتحه واضغط **فهرس هذا الدرس**.',
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
                                'قدّم الشرائح وأخّرها، أو **كرّر** شريحة، أو **أضف شريحة**، أو احذفها. حذفت بالغلط؟ **تراجع** يرجّعها.',
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
                                'في شريحة **لقطة شاشة** (وفي الغلاف)، اضغط **غيّر اللقطة** أو **اختر لقطة**.',
                                'تشوف لقطات **دروس هذا الكاروسيل**، وتقدر تختار من **دروس أخرى**.',
                                '**اللقطات النظيفة فقط** مفعّل افتراضياً: يخفي اللقطات اللي فيها أسهم أو خربشة أو شاشة تحميل. ومرّر المؤشر على لقطة عشان تشوفها كبيرة.',
                                '**أزل** تشيل اللقطة من الشريحة.',
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
                                '**احذف المسودة** يحذفها مع شرائحها، وما ينفع بعد الجدولة.',
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
                                'ينضاف منشور كاروسيل على إنستجرام وفيسبوك معاً في **الجدولة**، بالشرائح المرسومة ونص إنستجرام. حالاته في [[scheduling#statuses]].',
                                'تنشأ حملة للكلمة المفتاحية، إلا إذا عندك حملة مفعّلة ترد على نفس الكلمة من قبل.',
                                'المسودّة تصير **مجدول** ويتسكّر التعديل. تبي تغيّرها؟ احذف المنشور من **الجدولة**.',
                                '**افتح في المنشورات** يوديك للمنشور.',
                            ] },
                        ],
                        en: [
                            { ul: [
                                'A carousel post for Instagram and Facebook together is added to the **Scheduler**, with the drawn slides and the Instagram caption. Its statuses are in [[scheduling#statuses]].',
                                'A keyword campaign is created, unless an active campaign already answers that keyword.',
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
                                'اضغط **انشر منشورات الكاروسيل المنتظرة على تيك توك**، وبعدها **انشر على تيك توك**.',
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
                                ['التوقيع (بلغتك)', 'نفس التوقيع بلغتك، مثل «علامتي».'],
                                ['ألوان التمييز', 'الألوان اللي يتناوب عليها الكاروسيل، ويتجنب أحدث لون استخدمته. **أضف لوناً** يضيف، ولازم يبقى لون واحد على الأقل.'],
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
                                ['المنطقة الزمنية', 'المواعيد اليومية بتوقيت هذي المنطقة، مثل `Europe/London`.'],
                                ['المواعيد اليومية', 'الأوقات اللي ينزل فيها منشور كل يوم، مثل 13:00 و21:00. **أضف موعداً** يضيف وقتاً، ولازم يبقى وقت واحد على الأقل. والجدولة تقترح عليك أقرب موعد فاضي، منشوراً واحداً لكل موعد.'],
                            ] },
                        ],
                        en: [
                            { dl: [
                                ['Time zone', 'The daily slots are times in this zone, such as `Europe/London`.'],
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
                                ['المجلد على جهاز الماك', 'المسار الكامل للمجلد اللي يفحصه العامل، مثل `/Users/you/Videos`. لازم يكون داخل مجلد الكورس في إعدادات العامل (`courseRoot`). وإذا تركته فاضي، يوقف الفحص.'],
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
                                '**عامل جديد** ← **أنشئ عاملاً**: يطلع لك رمزه مرة وحدة. انسخه والصقه في الحقل `token` داخل `studio.config.json` على جهازك، واضغط **نسخته**.',
                                'كل عامل تشوف جنبه **آخر ظهور** أو **لم يتصل بعد**.',
                                '**ألغِ** يوقف العامل فوراً ويرفض رمزه. وعشان تستخدم نفس الجهاز مرة ثانية، أنشئ عاملاً جديداً والصق رمزه.',
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
                            'اضغط **احفظ الإعدادات**. ولو في حقل فيه خطأ، ينعلّم في مكانه وتشوف **صحّح الحقول المعلّمة ثم احفظ**. الإعدادات تنطبق على أي كاروسيل تكتبه أو ترسمه بعدها، والمنشورات المجدولة ما تتغيّر.',
                        ],
                        en: [
                            'Press **Save settings**. When a field has a problem it is marked where it is, with **Fix the highlighted fields, then save.** Settings apply to anything you write or redraw afterwards; posts already scheduled don’t change.',
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
                            'الشرح المصوّر فيديو بتعليق صوتي وصور ثابتة، لكل مشهد صورة وتسمية قصيرة عليها. تعطي الموضوع، فيبحث فيه Claude ويكتب النص، وتعتمده أنت، ثم تُرسم الصور، وتعتمدها، ثم يُجهَّز الفيديو، ثم تجدوله.',
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
                            'كل مشهد جملة واحدة، وفيه:',
                            { dl: [
                                ['النص المعروض', 'الجملة كما تظهر في الفيديو والنص المكتوب.'],
                                ['النص المنطوق', 'ما يقوله الصوت. تُكتب المصطلحات الإنجليزية كما ينبغي أن ينطقها الصوت.'],
                                ['التسمية', 'بطاقة قصيرة على الصورة: حتى 4 كلمات أو رقم مثل سنة. يرسمها التطبيق، ولا يرسمها نموذج الصور أبدًا.'],
                                ['وصف الصورة (بالإنجليزية)', 'من في الصورة، ووضعيته وحركته، والمكان، وما تشير إليه التسمية.'],
                                ['الشخصيات', 'الشخصيات المتكررة التي تظهر في المشهد، حتى أربع.'],
                                ['الصورة نفسها كالمشهد السابق', 'يستعيد المشهد صورة سابقه بدل رسم صورة جديدة.'],
                            ] },
                            'بأزرار كل مشهد تنقله إلى الأعلى أو الأسفل، وتضيف مشهدًا بعده، وتحذفه. وتحت العنوان يظهر تقدير المدة: عدد الكلمات المنطوقة مقسومًا على سرعة المعلّق، مقابل المدة المستهدفة. وإن خرج النص عنها، أو عن العدد المعتاد للمشاهد، أو لم يذكر مصادر كافية، ظهر تنبيه. ويمكنك الاعتماد رغم التنبيه.',
                            'وتحت المشاهد: عنوان الفيديو (70 حرفًا على الأكثر)، والوصف لكل منصة، والتعليق الأول بالمصادر، و5 ردود متوقعة على الأقل، والمصادر.',
                            { ul: [
                                '**أعد الكتابة بملاحظة:** يكتب الكاتب مسودة جديدة بناءً على ملاحظتك («بداية أقصر، وأضف نتيجة 2020»). تبقى المسودة الحالية ظاهرة حتى تصل الجديدة، وتُستبدل تعديلاتك غير المحفوظة.',
                                '**اعتمد النص:** يحفظ تعديلاتك أولًا ثم يبدأ تسجيل الصوت. هذه البوابة الأولى. وبعدها يعني تعديل النص المنطوق أو المعروض تسجيل الصوت من جديد.',
                            ] },
                            { note: 'يجب أن ينتهي المشهد الأخير بسؤال حقيقي موجّه إلى المشاهد. أما طلب التعليق بكلمة أو التفاعل بإشارة فيُرفض لأنه استدراج للتفاعل: [[explainers#rules]].' },
                        ],
                        en: [
                            'Writing takes a few minutes, up to 20, because the writer researches first. You can leave the page: the work carries on. Claude on your Mac writes by default, and Gemini writes when the Mac cannot or when you chose it in the settings. The step says who wrote the draft you are looking at.',
                            'Each scene is one sentence, and it holds:',
                            { dl: [
                                ['On-screen text', 'The sentence as it appears in the video and in the subtitles.'],
                                ['Spoken text', 'What the voice says. English terms are spelled the way the voice should say them.'],
                                ['Label', 'A short tag on the picture: up to 4 words, or a number such as a year. The app draws it; the image model never does.'],
                                ['Picture brief (English)', 'Who is in the picture, their pose and action, the setting, and what the label points to.'],
                                ['Characters', 'The recurring characters in the scene, up to four.'],
                                ['Same picture as the previous scene', 'The scene reuses its predecessor’s picture instead of drawing a new one.'],
                            ] },
                            'Each scene has buttons to move it up or down, add a scene after it, and remove it. Above the scenes the length estimate shows the spoken words divided by the narrator’s pace, against the target. If the script falls outside it, or outside the usual number of scenes, or cites too few sources, a warning appears. You can still approve over a warning.',
                            'Below the scenes: the video title (at most 70 characters), a caption for each platform, the first comment with the sources, at least 5 likely replies, and the sources.',
                            { ul: [
                                '**Rewrite with a note:** the writer writes a new draft from your note (“a shorter hook, and add the 2020 result”). The current draft stays visible until the new one arrives, and your unsaved edits are replaced.',
                                '**Approve the script:** saves your edits first, then starts the voice. This is the first gate. After it, changing the spoken or on-screen text means voicing again.',
                            ] },
                            { note: 'The last scene must end with a genuine question to the viewer. Asking people to comment a word or to react is refused as engagement bait: [[explainers#rules]].' },
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
                                '**ارسم كل الصور** أو **تابع الرسم:** حين يتوقف الرسم، بسبب نفاد الحصة أو أخطاء متتالية، يعيد بدأه لما بقي.',
                                'المشهد الذي اخترت له **الصورة نفسها كالمشهد السابق** يُنسخ ولا يُرسم.',
                                '**اعتمد الصور:** هذه البوابة الثانية. يُفعَّل الزر حين يكون لكل مشهد صورة والتسجيل مطابقًا للنص، ويبدأ بعده التجهيز.',
                            ] },
                            'تحقق من كل صورة: لا نص داخلها، ولا امرأة ولا فتاة، والشخصية المتكررة تُعرف بسهولة. وكل إعادة رسم تستهلك صورة من حصة اليوم، فأعد رسم القليل الخاطئ فقط.',
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
                            'Check each picture: no text in it, no woman or girl, and the recurring character easy to recognise. Every redraw spends one picture of today’s allowance, so redraw only the few that are wrong.',
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
                                ['هذا الفيديو أقدم من تعديلاتك', 'يظهر حين تعدّل بعد التجهيز. التعديل لا يدخل الفيديو إلا بتجهيز جديد.'],
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
                                ['This render is older than your edits', 'Appears when you edit after rendering. An edit reaches the video only with a new render.'],
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
                            'اضغط **جدولة**، واختر أقرب موعد نشر متاح، أو الآن، أو وقتًا تحدده بتوقيت مساحتك. وهذا ما يُنشر وأين، في مجموعة واحدة:',
                            { dl: [
                                ['إنستغرام وفيسبوك', 'الفيديو العمودي مع غلافه.'],
                                ['يوتيوب', 'الفيديو الأفقي مع عنوان يوتيوب ووصفه إن زادت المدة على 3 دقائق، وإلا فالفيديو العمودي بصيغة Shorts.'],
                                ['تيك توك', 'مسودة في صندوق تيك توك الوارد، تنشرها من تطبيق تيك توك.'],
                                ['لينكدإن', 'ليس تلقائيًا: استخدم [[explainers#linkedin]].'],
                            ] },
                            'لكل منصة وصفها الخاص، وتعدّله في خطوة النص. وإن كان مقطع الموسيقى يشترط الإسناد أُضيف سطره إلى كل وصف تلقائيًا.',
                            'بعد الجدولة تعرض الخطوة حالة كل منشور ورابطه حين يُنشر، وفي صفحة **الجدولة** تجد كل شيء.',
                            { note: 'تُسجَّل الجدولة على الملفات كما هي لحظة الضغط. إن عدّلت بعدها فجهّز فيديو جديدًا قبل الجدولة التالية.' },
                        ],
                        en: [
                            'Press **Schedule** and choose the next free slot, now, or a time you pick in your workspace’s time zone. This is what is posted, and where, as one group:',
                            { dl: [
                                ['Instagram and Facebook', 'The vertical video with its cover.'],
                                ['YouTube', 'The horizontal video with the YouTube title and description when it runs longer than 3 minutes, otherwise the vertical video as a Short.'],
                                ['TikTok', 'A draft in your TikTok inbox, which you post from the TikTok app.'],
                                ['LinkedIn', 'Not automatic: use [[explainers#linkedin]].'],
                            ] },
                            'Each platform has its own caption, and you edit it in the script step. If the music track asks for credit, its line is added to every caption automatically.',
                            'After scheduling, the step shows each post’s status and its link once it is published, and the **Scheduler** page holds everything.',
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
                                'اضغط **انسخ الوصف** والصقه في منشور لينكدإن. وهو وصف إنستغرام وفيسبوك، مع سطر الإسناد إن لزم.',
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
                                ['مصادر حقيقية', 'يبحث الكاتب قبل أن يكتب، ويفضّل المصادر الأولى: الأوراق العلمية والوثائق الرسمية. يُذكر كل مصدر بعنوانه ومؤلفيه أو ناشره وسنته ورابطه، وتستند كل جملة تذكر معلومة إلى أحدها، ويذكرها التعليق الأول. وإن عندك مصدر أفضل فأضف رابطه واطلب إعادة الكتابة.'],
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
                                ['مكتبة صوت يوتيوب', 'لليوتيوب وحده، فلا تصلح لفيسبوك ولا إنستغرام ولا تيك توك.'],
                            ] },
                            'أما **المؤثرات الصوتية فقط** فيستخدم المزج صوت «ووش» (whoosh) من إنتاج المشروع نفسه عند كل قطع، وصوت «بوب» (pop) من Kenney في الملكية العامة (CC0) حين تظهر تسمية، ولا تحتاج إلى ترخيص منك.',
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
                                ['تقول الصفحة «بانتظار جهازك الماك»', ['الماك غير متصل أو عامل الاستوديو غير شغّال عليه. تتابع الخطوة وحدها حين يعود، ولا يضيع شيء. اقرأ [[worker]] لتشغيله.']],
                                ['Claude على جهازي الماك مسجَّل الخروج', [
                                    'افتح الطرفية على الماك، وشغّل Claude Code، واكتب:',
                                    { code: '/login', caption: 'وسجّل الدخول' },
                                    'وإن كان خيار «إن تعذّرت الكتابة على جهازي الماك فليكتب Gemini» مفعّلًا (وهو الافتراضي) كتب Gemini النص بعد 10 دقائق بلا التقاط للمهمة أو عند خطأ تسجيل الدخول، ويظهر على المسودة «كتبه Gemini». وإن كان موقوفًا انتظر الشرح الماك.',
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
                                ['ردود الرسائل', 'الوكيل الذكي يرد على الرسائل الخاصة بالنموذج اللي تختاره في **مساعد الرسائل** ← **النموذج**.'],
                                ['كتابة الكاروسيل', '**أنشئ الكاروسيل** و**أعد الكتابة بالذكاء الاصطناعي** و**اكتبه من جديد** و**خطّط أسبوعي**، وكلها على الخادم.'],
                                ['فهرسة الدروس', 'على العامل في جهازك، بمفتاح Gemini اللي في ملف إعداداته.'],
                            ] },
                        ],
                        en: [
                            'All the AI in the product is Google’s **Gemini**, used in three places:',
                            { dl: [
                                ['DM replies', 'The AI agent answers DMs with the model you choose in **DM assistant** → **Model**.'],
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
                                ['زر **افحص المكتبة** معطّل', 'ما حددت مجلد المكتبة. اضغط **حدّده من الإعدادات**.'],
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
                                ['المسودّة ما وصلت صندوق تيك توك', 'وضع المسودّات ما يُعتمد عليه. استخدم **انشره مباشرة في حسابي على تيك توك**: [[tiktok#drafts]].'],
                                ['منشور تيك توك رجع **بالانتظار** ومعه سبب عن المسودّات', 'عندك 5 مسودّات معلّقة في آخر 24 ساعة. انشر وحدة منها من التطبيق، والباقي ينرسل لحاله.'],
                                ['**يحتاج إلى إعادة الربط**', 'اضغط **أعد الربط** في **الإعدادات** ← **تيك توك**.'],
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
                                ['الوكيل ما يرد على الرسائل', ['تأكد أن **تشغيل الردّ الآلي** مفعّل في **مساعد الرسائل**.', 'وتأكد أن الرد الآلي مو موقوف في المحادثة (**الردّ الآلي متوقف** في **الرسائل**). أي رد يدوي منك يوقفه في تلك المحادثة.', 'ولو خلصت حصة Gemini: [[ai-usage#quotas]].']],
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
                                ['The AI agent isn’t answering DMs', ['Check **Turn on auto-replies** is on in **DM assistant**.', 'Check the AI isn’t paused in that conversation (**AI paused** in the **Inbox**). Any manual reply from you pauses it there.', 'And if your Gemini quota ran out: [[ai-usage#quotas]].']],
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
                                ['أقدر أوقف الرد الآلي لعميل معيّن؟', 'إيه. في **الرسائل** افتح المحادثة وطفّ **الردّ الآلي في هذه المحادثة**. وأي رد يدوي منك يوقفه في تلك المحادثة لحاله.'],
                                ['أقدر أغيّر لغة اللوحة؟', 'إيه، من الزر أعلى الصفحة، أو من **الإعدادات** ← **المظهر واللغة**.'],
                            ] },
                        ],
                        en: [
                            { qa: [
                                ['Does my computer have to stay on?', 'Not for campaigns, DMs or scheduling: they all run on the server, even with your computer off. Only the Studio needs it: indexing and drawing slides need the worker on your computer.'],
                                ['Can anything be posted without my approval?', 'No. A post goes out when you schedule it, and replies come from your own campaigns and your agent, following your instructions.'],
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
                                ['فيديوهاتي تطلع من جهازي؟', 'لا. للفهرسة تروح نسخة صغيرة لـ Gemini وتنحذف بعدها، والأصلي يبقى عندك: [[worker#security]].'],
                                ['أقدر أستخدم الاستوديو بدون دروس؟', 'إيه، اكتب **من فكرة**. بس رسم الشرائح يحتاج العامل.'],
                                ['العامل يشتغل على ويندوز؟', 'حالياً على الماك بس.'],
                                ['أقدر أعدّل الكاروسيل بعد ما أجدوله؟', 'لا، التعديل يتسكّر بعد الجدولة. احذف المنشور من **الجدولة** وارجع عدّله.'],
                                ['ليش الأرقام في الشرائح هندية (١٢٣)؟', 'غيّرها من **الأرقام** في إعدادات الاستوديو: [[studio-settings#voice]].'],
                                ['الكاروسيل ينكتب بلهجتي؟', 'يلتزم بـ**دليل الأسلوب** في الإعدادات، فاكتب فيه لهجتك ونبرتك بالتفصيل.'],
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
