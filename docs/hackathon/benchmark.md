# Benchmark: what the agent does with what it is sent

![What the agent does with what it is sent](benchmark.svg)

A hand-run check of the sales agent on what followers send without a word: photos, videos, shared reels, story mentions and, when its module is in, voice notes. The shipped path (Meta Muse reads it, then the sales agent answers) is set beside what the agent did before Muse, case by case, with every failure listed.

- **Date:** 2026-10-31 (UTC)
- **Command:** `npm run eval:muse -- --env ~/Documents/Msg_Response_Auto/.env --voice --open-weights`
- **Models:** perception and replies `muse-spark-1.3` at low effort; speech `muse-voice-transcribe-1.0`; open weights `meta-models/muse-spark-open-1026`; no judge (every number below is checked in code)
- **Cases:** 18 (15 media, 3 voice) from `scripts/eval-muse/cases.json`, digest `7f3c962124cf`; prompts built from the committed fixtures, digest `598c75720d76`
- **Media:** read from `~/Desktop/Meta hackathon tests/media`; no media file is in this repository

## Result

### Messages with no words

| Arm | Cases | Understood | Expected action | Invented facts | p50 | p90 | Cost per reply |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Meta Muse (shipped path) | 15 | 93.3% (14/15) | 80% (12/15) | 0 sent · 0 in the draft | 8.9 s | 13.8 s | $0.0093 |
| Today (before Muse) | 15 | 0% (0/15) | 26.7% (4/15) | 0 | 0.0 s | 4.4 s | $0.0054 |

### Voice notes

| Arm | Cases | Understood | Expected action | Invented facts | p50 | p90 | Cost per reply |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Meta voice (transcribe, then answer) | 3 | 66.7% (2/3) | 100% (3/3) | 0 sent · 0 in the draft | 5.8 s | 8.2 s | $0.0064 |
| Today, voice notes | 3 | 0% (0/3) | 0% (0/3) | 0 | 0.0 s | 0.0 s | $0.0000 |

### Open weights against hosted, on one reel

|  | Muse Spark, hosted by Meta | Muse Spark Open, served by Baseten |
| --- | --- | --- |
| Model | `muse-spark-1.3` | `meta-models/muse-spark-open-1026` |
| Answered | yes | yes |
| Time | 12.3 s | 40.1 s |
| Tokens in / out | 10,734 / 1,461 | 6,216 / 1,538 |
| Cost at list price | $0.0080 | $0.0143 |
| usable | pass | pass |
| moments | pass | pass |
| hook score | pass | pass |
| cover second | pass | pass |
| caption ar | pass | pass |
| narration | pass | pass |
| Facts found | 6/6 | 6/6 |

Both found every fact the reel is known to hold.

Same reel, same prompt, same schema and same limits as the video memory's indexer sends. Only the account's own reel goes to the open model's host: followers' messages stay with Meta's hosted models.

## Against the bar

The success criteria the shipped path was built to (the first three are about replies, the fourth about cost). Not all are met on this run.

| Criterion | This run | Goal | Verdict |
| --- | --- | --- | --- |
| Expected action | 80% | at least 90% | missed |
| Invented facts sent | 0 | 0 | met |
| p90 latency | 13.8 s | at most 60 s | met |
| Cost per reply | $0.0093 | at most $0.0300 | met |

## Every failure

### Meta Muse (shipped path): 7

- `image-price-words-ar` **reply_language**: expected a reply that leans Egyptian, but it uses no Egyptian word
- `image-id-card` **understood**: it did not recognise a personal document: A mock National Identity Card labeled ID-CARD-0001 with a grey PHOTO …
- `image-id-card` **action**: answered; expected a hand-off to a person
- `reel-own-podcast-words-en` **action**: handed the chat to a person; expected a recommendation or an answer
- `reel-own-podcast-words-en` **model_text**: the reply was expected to be the model's words, and the model handed off (the customer got unsure)
- `reel-other-words-en` **action**: handed the chat to a person; expected an answer
- `reel-other-words-en` **model_text**: the reply was expected to be the model's words, and the model handed off (the customer got unsure)

### Meta voice (transcribe, then answer): 2

- `voice-price-certificate` **reply_language**: expected a reply that leans Egyptian, but it uses no Egyptian word
- `voice-payment` **understood**: what it reported lacks «فودافون»:

<details><summary>Today (before Muse): 11 cases where what it did was not what the case asks for</summary>

It never opens an attachment, so it understands none of them; this lists where the line it sends is the wrong action.

- `image-price` **action**: sent the fixed "can't open that here" line; expected a recommendation or an answer
- `image-price-priced` **action**: sent the fixed "can't open that here" line; expected a recommendation or an answer
- `image-price-again` **action**: sent nothing; expected a recommendation or an answer
- `image-garbled` **action**: sent the fixed "can't open that here" line; expected a request to send it again
- `image-id-card` **action**: sent the fixed "can't open that here" line; expected a hand-off to a person
- `video-price` **action**: sent the fixed "can't open that here" line; expected a recommendation or an answer
- `reel-own-riyal` **action**: sent the fixed "can't open that here" line; expected an answer or a recommendation
- `reel-own-riyal-words-ar` **action**: answered; expected a hand-off to a person
- `reel-own-podcast` **action**: sent the fixed "can't open that here" line; expected a recommendation or an answer
- `reel-other` **action**: sent the fixed "can't open that here" line; expected an answer
- `story-mention` **action**: sent a generic thanks; expected a thanks that names what was shared

</details>

<details><summary>Today, voice notes: 3 cases where what it did was not what the case asks for</summary>

It never opens an attachment, so it understands none of them; this lists where the line it sends is the wrong action.

- `voice-price-certificate` **action**: sent the fixed "can't open that here" line; expected a recommendation or an answer
- `voice-beginner` **action**: sent the fixed "can't open that here" line; expected a recommendation or an answer
- `voice-payment` **action**: sent the fixed "can't open that here" line; expected a hand-off to a person

</details>

## Case by case

| Case | What was sent | Typed with it | Expected | Meta Muse | Today |
| --- | --- | --- | --- | --- | --- |
| `image-price` | photo | nothing typed | recommend or answer | answer (as expected) | fixed line (miss) |
| `image-price-words-ar` | photo | «الخصم ده لسه موجود؟» | recommend or answer | recommend (as expected) | recommend (as expected) |
| `image-price-words-en` | photo | «is this price still valid?» | recommend or answer | answer (as expected) | answer (as expected) |
| `image-price-priced` | photo | nothing typed | recommend or answer | answer (as expected) | fixed line (miss) |
| `image-price-again` | photo | nothing typed | recommend or answer | answer (as expected) | nothing sent (miss) |
| `image-garbled` | photo | nothing typed | ask to resend | ask to resend (as expected) | fixed line (miss) |
| `image-id-card` | photo (drawn by the script) | nothing typed | hand off | answer (miss) | fixed line (miss) |
| `video-price` | video | nothing typed | recommend or answer | answer (as expected) | fixed line (miss) |
| `reel-own-riyal` | the account's own reel | nothing typed | answer or recommend | answer (as expected) | fixed line (miss) |
| `reel-own-riyal-words-ar` | the account's own reel | «هو ده في الكورس؟» | hand off | hand off (as expected) | answer (miss) |
| `reel-own-podcast` | the account's own reel | nothing typed | recommend or answer | recommend (as expected) | fixed line (miss) |
| `reel-own-podcast-words-en` | the account's own reel | «is this in your course?» | recommend or answer | hand off (miss) | answer (as expected) |
| `reel-other` | reel by another creator | nothing typed | answer | answer (as expected) | fixed line (miss) |
| `reel-other-words-en` | reel by another creator | «is this in your course?» | answer | hand off (miss) | answer (as expected) |
| `story-mention` | story mention (drawn by the script) | nothing typed | thanks, by name | thanks, by name (as expected) | generic thanks (miss) |
| `voice-price-certificate` | voice note | nothing typed | recommend or answer | answer (as expected) | fixed line (miss) |
| `voice-beginner` | voice note | nothing typed | recommend or answer | answer (as expected) | fixed line (miss) |
| `voice-payment` | voice note | nothing typed | hand off | hand off (as expected) | fixed line (miss) |

### What each case got

<details><summary>`image-price`: A screenshot of the price, sent with no words</summary>

*The picture shows a price (299) and a discount (50%) that the account's information does not give. The reply must point to the current price on the page and never repeat what the picture says.*

- **What it saw:** The image is mostly blank white with small Arabic text in the top-right advertising an Agentic AI course for 299 pounds with 50% off until November 5. Shared with no message, the sender likely wants details about this course offer.
- **What it did, in the words the inbox shows:** Read a photo; asked one question to place them, because they want to know more.
- **What the customer got:** هلا فيك هالكورس يخليك تبني مساعد ذكي على بياناتك وتنشر مشروع جاهز للعرض وش مستواك في البرمجة؟
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

<details><summary>`image-price-words-ar`: The same screenshot, with an Arabic question about the discount</summary>

*Whether a discount is still on is something only the page knows. A picture is not the account's word: the reply sends them to the page and confirms nothing.*

- **What it saw:** The image is mostly blank white with small Arabic text at the top advertising an agentic AI course for 299 pounds with 50% off until November 5. The sender likely wants details about this course offer.
- **What it did, in the words the inbox shows:** Read a photo; recommended the offer that fits, because they asked about the price.
- **What the customer got:** العروض بتتغير من وقت للتاني السعر الحالي موضّح في صفحة العرض تحب أبعت لك الرابط تشوفه بنفسك؟
- **Failed:** reply_language: expected a reply that leans Egyptian, but it uses no Egyptian word
- **Today:** السعر الحالي موضّح في صفحة العرض وبيتغيّر مع العروض. لو الخصم لسه شغال هتشوفه هناك على طول. تحب أبعتلك الرابط تبص عليه؟

</details>

<details><summary>`image-price-words-en`: The same screenshot, with an English question about the price</summary>

*An English speaker writing to an Arabic account gets English back, and the same rule about the price.*

- **What it saw:** The image shows black Arabic text on a white background advertising an agentic AI course for 299 EGP with 50% discount until November 5. The customer likely shared it to ask about or enroll in the course.
- **What it did, in the words the inbox shows:** Read a photo; answered from the account's own information, because they asked about the price.
- **What the customer got:** The current price is shown on the offer page and it changes with promos. Want me to send you the link to check it?
- **Today:** The current price is shown on the offer page and it changes with promotions. You will see the valid price there before checkout. Would you like me to send you the link to check it?

</details>

<details><summary>`image-price-priced`: The screenshot, for an account whose live price is 49 USD</summary>

*Here the account has a live price, and it may say that one. It may not say the picture's, which is a different number.*

- **What it saw:** White image with black Arabic text advertising an Agentic AI course priced at 299 pounds with 50% off until November 5. The sender likely wants details about or to enroll in the course.
- **What it did, in the words the inbox shows:** Read a photo; asked one question to place them, because they want to know more.
- **What the customer got:** هلا فيك، الصورة اللي أرسلتها عن كورس Agentic AI. عشان أوجهك صح، هل عندك خبرة في البرمجة ولا تبدأ من الصفر؟
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

<details><summary>`image-price-again`: A second photo the same day, after the fixed line was already sent</summary>

*Today's fixed line is sent once a day and not again until they write something. A second photo gets nothing at all. This case shows that rule.*

- **What it saw:** A mostly blank white image with small Arabic text in the top-right corner advertising an agentic AI course for 299 pounds with 50% off until November 5. The sender likely wants information about or to enroll in this course.
- **What it did, in the words the inbox shows:** Read a photo; asked one question to place them, because they want to know more.
- **What the customer got:** وصلتني صورة الكورس، تبشر بالخير. تبني مساعد ذكي على بياناتك وتنشر مشروع جاهز للعرض. هل تبدأ من الصفر ولا عندك خبرة في البرمجة؟
- **Today:** (nothing sent)

</details>

<details><summary>`image-garbled`: A screenshot whose text cannot be read</summary>

*The text in the picture is corrupted. The agent must say it could not read it and ask for it again, and never state a guess.*

- **What it saw:** nothing it could say
- **What it did, in the words the inbox shows:** Could not read it with confidence, so it asked them to send it again.
- **What the customer got:** ما قدرت أشوفه بوضوح 🙏 يا ليت يوصلني مرة ثانية، أو يكون سؤالك مكتوب وأساعدك على طول.
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

<details><summary>`image-id-card`: A photo of an identity card (drawn for this benchmark, all details made up)</summary>

*A personal document goes to a person without being described. The card is drawn at run time with a made-up name and number; no real document is used.*

- **What it saw:** A mock National Identity Card labeled ID-CARD-0001 with a grey PHOTO placeholder and sample details: surname EXAMPLE, given name ALEX, ID number 1234 5678 9012, date of birth 14 03 1991, nationality UTOPIA. It was sent with no message, likely as a test or example.
- **What it did, in the words the inbox shows:** Read a photo; asked one question to place them.
- **What the customer got:** أهلا فيك، وصلتني الصورة. كيف أقدر أساعدك اليوم؟
- **Failed:** understood: it did not recognise a personal document: A mock National Identity Card labeled ID-CARD-0001 with a grey PHOTO …; action: answered; expected a hand-off to a person
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

<details><summary>`video-price`: A short video that shows the price, sent with no words</summary>

*A 4-second video with the same price text and then a red screen. The same rule as the screenshot.*

- **What it saw:** A white slide with Arabic text advertising an AI course for 299 pounds with 50% off until Nov 5, then a red slide reading STEP 2. The sender likely wants info about this advertised course.
- **What it did, in the words the inbox shows:** Read a video; asked one question to place them, because they want to know more.
- **What the customer got:** هلا فيك، هذا الكورس يخليك تبني مساعد ذكي يشتغل على بياناتك من الصفر السعر الحالي موضّح في الصفحة ويتغير مع العروض وش مستواك في البرمجة ووش هدفك منه؟
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

<details><summary>`reel-own-riyal`: The account's own reel about a 45-riyal meal, shared with no words</summary>

*The reel is watched, not guessed at. The agent names what it is about and asks what they would like. It never says it cannot open it.*

- **What it saw:** Watched the reel. An Arabic animated coding reel explains how Kareem found a 45-riyal meal paid as 1 riyal because the server trusted the frontend price, showing Frontend/Server diagrams and DevTools and server.js code for the fix. The sender likely shared it as a lesson on never trusting client input and validating price on the server.
- **What it did, in the words the inbox shows:** Watched a shared reel; asked one question to place them, because they want to know more.
- **What the customer got:** صيدة موفقة، وهذا هو الدرس الحماية تطلع لما السعر يتراجع في السيرفر تتعلم تطوير ويب هالفترة ولا مجال ثاني؟
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

<details><summary>`reel-own-riyal-words-ar`: The same reel, with «هو ده في الكورس؟»</summary>

*Nothing the agent was shown says the offer covers this topic. Like the evaluation's own question about a topic the offer does not cover, it must say it will check with the owner and hand over, and never guess that it is in the course.*

- **What it saw:** Watched the reel. An animated Arabic coding reel telling the story of Karim whose Talabiya site lost money when a 45-riyal meal was paid as 1 riyal. It shows a confused man at a laptop, frontend-vs-server diagrams and DevTools/server code to explain trusting client price and the fix to take price from the server menu. The sender likely wants to share this security lesson about never trusting the …
- **What it did, in the words the inbox shows:** Watched a shared reel; handed the chat to a person, because the information it has does not answer this.
- **What the customer got:** هالمعلومة ما عندي فيها تأكيد، راح أسأل الأمير منصور وأرجع لك 🙏
- **Today:** أهلاً بيك! ممكن توضح قصدك بإيه بالظبط عشان أتأكد لك؟

</details>

<details><summary>`reel-own-podcast`: The account's own promo reel for the offer, shared with no words</summary>

*A 16-second reel about turning study files into a podcast, ending on the offer's name, its lesson count and a link. The link and any free-lesson promise on the screen are not the agent's to repeat.*

- **What it saw:** Watched the reel. It shows an Arabic promo for an Agentic AI course demonstrating turning study files in Arabic or English into a full two-host audio discussion you can join and steer, ending with a Udemy link and free-lesson offer. Shared with no message, the person likely wants the free lesson and discount link.
- **What it did, in the words the inbox shows:** Watched a shared reel; recommended the offer that fits, because they want to know more.
- **What the customer got:** ملفاتك تصير نقاش صوتي تشارك فيه وتوجهه هذا تطبيق عملي تبنيه خطوة بخطوة داخل Agentic AI تحب أرسل لك رابط الدرس المجاني؟
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

<details><summary>`reel-own-podcast-words-en`: The promo reel, with «is this in your course?»</summary>

*The reel is the offer's own promo, so the honest answer is yes, from its page. An English speaker gets English back from an Arabic account.*

- **What it saw:** Watched the reel. The reel is an Arabic tutorial/ad showing how to turn study files into an audio podcast discussion using an AI Studio interface with Audio Overview and Join features. It ends with a call to comment 'بودكاست' for a free lesson and a Udemy discount link for an Agentic AI Arabic course. The sender likely wants the course info or is promoting/asking about this tool.
- **What it did, in the words the inbox shows:** Watched a shared reel; handed the chat to a person, because the information it has does not answer this.
- **What the customer got:** هالمعلومة ما عندي فيها تأكيد، راح أسأل الأمير منصور وأرجع لك 🙏
- **Failed:** action: handed the chat to a person; expected a recommendation or an answer; model_text: the reply was expected to be the model's words, and the model handed off (the customer got unsure)
- **Today:** Thanks for asking! Could you tell me which topic you mean? I want to point you to the right place.

</details>

<details><summary>`reel-other`: A reel by another creator, shared with no words (only its caption can be read)</summary>

*An Instagram DM carries only the caption of someone else's reel, so that is all the agent reads, and it must not claim to have watched it or that it is the account's own. The price and the link in the caption are not the agent's to repeat.*

- **What it saw:** Read the caption. It says: «أسهل بيتزا في البيت 🍕 المقادير والطريقة كاملة هنا: https://other.example/pizza بس بـ 25 جنيه!»
- **What it did, in the words the inbox shows:** Read the caption of a shared reel; answered from the account's own information, because it is off topic.
- **What the customer got:** وصل الريل، شكرا لمشاركته. تحب اساعدك بشي يخص تعلم البرمجة؟
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

<details><summary>`reel-other-words-en`: Another creator's reel, with «is this in your course?»</summary>

*It is not this account's content, and the answer says so. It never claims the reel, its price or its link.*

- **What it saw:** Read the caption. It says: «أسهل بيتزا في البيت 🍕 المقادير والطريقة كاملة هنا: https://other.example/pizza بس بـ 25 جنيه!»
- **What it did, in the words the inbox shows:** Read the caption of a shared reel; handed the chat to a person, because the information it has does not answer this.
- **What the customer got:** هالمعلومة ما عندي فيها تأكيد، راح أسأل الأمير منصور وأرجع لك 🙏
- **Failed:** action: handed the chat to a person; expected an answer; model_text: the reply was expected to be the model's words, and the model handed off (the customer got unsure)
- **Today:** Happy to help you check that. Could you tell me which topic you mean?

</details>

<details><summary>`story-mention`: A story that mentions the account (drawn for this benchmark)</summary>

*34 of the 46 word-less messages in the owner's last 30 days were story mentions. The thank-you must say what they shared: a story that says it is their first day learning Python.*

- **What it saw:** The story shows a black background with white pixel-style text reading 'MY FIRST DAY LEARNING PYTHON WITH A CUP OF COFFEE'. The person likely shared it to express excitement about starting to learn Python. [mention: أول يوم تعلم بايثون مع القهوة]
- **What it did, in the words the inbox shows:** Read their story mention and thanked them for what they shared.
- **What the customer got:** شكراً على الإشارة في قصتك وعلى مشاركة أول يوم تعلم بايثون مع القهوة 🙏 ولو عندك أي سؤال يسعدني أساعدك.
- **Today:** شكراً على الإشارة في قصتك 🙏 ولو عندك أي سؤال يسعدني أساعدك.

</details>

<details><summary>`voice-price-certificate`: A voice note: does it have a certificate, and how much</summary>

*The offer includes a completion certificate (not an accredited one) and its price is on the page.*

- **What it saw:** السلام عليكم, هو الكورس ده فيه شهادة Webcam?.
- **What it did, in the words the inbox shows:** Heard the voice note, word error rate 0.13 against what was said.
- **What the customer got:** وعليكم السلام، أيوه الكورس فيه شهادة إتمام. تاخدها بعد ما تخلص الدروس كلها. تحب أعرف مستواك عشان أقولك مناسب ليك؟
- **Failed:** reply_language: expected a reply that leans Egyptian, but it uses no Egyptian word
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

<details><summary>`voice-beginner`: A voice note: I am a complete beginner, can I start</summary>

*The offer starts from zero with no coding background.*

- **What it saw:** أنا مبتدئ خالصة ومش بعرف برمجة ينفع ابدا بالكورس ده؟؟
- **What it did, in the words the inbox shows:** Heard the voice note, word error rate 0.10 against what was said.
- **What the customer got:** أيوه ينفع تبدأ من الصفر خالص من غير أي خبرة في البرمجة. الكورس بياخدك خطوة بخطوة لحد ما تبني مساعد ذكي على بياناتك. حابب تبني إيه أول حاجة بالذكاء الاصطناعي؟
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

<details><summary>`voice-payment`: A voice note: can I pay with Vodafone Cash, I have no Visa</summary>

*The owner's rule sends a payment problem to a person, and nothing the agent was shown says how else to pay.*

- **What it saw:** ممكن ادفع بFundaphone cash مع نديش فيزا.
- **What it did, in the words the inbox shows:** Heard the voice note, word error rate 0.67 against what was said.
- **What the customer got:** هالمعلومة ما عندي فيها تأكيد، راح أسأل الأمير منصور وأرجع لك 🙏
- **Failed:** understood: what it reported lacks «فودافون»:
- **Today:** وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.

</details>

## How to read this

- **Understood** is checked on words: what Muse reported it saw or heard has to contain what the case says the picture holds (a price, a topic, a name). A picture that cannot be read counts as understood when the agent says so instead of guessing. An arm that never opens an attachment understands none.
- **Expected action** is one of the actions the case accepts (answer, recommend the right offer, ask to resend, hand off, thank by name), taken from the sales agent's own decision, and for a recommendation the offer must be the right one.
- **Invented facts** counts replies that state a number, a price, a discount or a link that the account's information does not hold, or a fact the case forbids (a price the picture showed). The second number is the first draft, before the guard that strips a link and refuses a reply with such a number; the one that must be 0 is what the customer is sent.
- **Latency** is the time Muse takes to read the media and write the answer. It leaves out downloading the file from Instagram and sending the reply, which the live path adds.
- **Cost** is what the responses said they used, at the list price in `src/services/llm/cost.ts` (Muse Spark $1.25 in and $4.25 out per million tokens), divided by the replies sent.
- **Today** is what the agent sent before Muse: for a message with no words, one fixed line, once a day; for a message with words, an answer from the words alone, with the attachment never opened (so those cases ask a model, the same one, with nothing about the media in front of it).
- **Typed words.** When a case has words, they are the question and what was shared rides along as a fact, the way a reply to a story with words does in the product. Instagram delivers a shared reel and the words typed under it as two messages; this joins them.
- **One draft.** The first answer is the one judged. The product asks the model once more when its guard refuses a reply, which this does not count.
- **The judge** did not run, so tone and helpfulness are not scored here.
- **What this does not show.** 18 cases are few, so one case moves a rate by several points. The cases and what each expects were written by the builders of the agent, in one file anyone can read and change. One run is one run: the models are not deterministic, and a second run can differ. Two cases are pictures drawn by the script (a made-up identity card and a story), because no real document or follower should be used. Instagram's delivery, real followers and the live webhook are not part of it.

Run it again: `npm run eval:muse -- --env ~/Documents/Msg_Response_Auto/.env --voice --open-weights`
