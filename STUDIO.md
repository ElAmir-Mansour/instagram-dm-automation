# Carousel Studio: the contract (v1)

Four parts are built in parallel against this document. Each part owns only its own files, and
any deviation has to be reported back.

```
Dashboard (#/studio)  ──session──▶  App API (/api/studio/*)  ◀──worker token──  Mac Studio worker
  inputs, preview, edit,             Postgres: lessons, moments,                  (aicourse-captions)
  schedule                           drafts, studio_jobs                           scans + indexes videos (Gemini),
                                     Gemini: writes the carousel                   extracts shots (ffmpeg),
                                     scheduling: scheduled_posts                   renders slides (Remotion)
```

The worker only ever calls **out** to the app. It polls for jobs and posts results back, so nothing on
the Mac is exposed to the internet. While the Mac is off, jobs simply wait in the queue.

## 1. The carousel JSON

The schema is `~/Desktop/AI Course/aicourse-captions/src/carousel/types.ts`, copied verbatim into the app
at `src/services/studio/carouselTypes.ts`. Its text budgets are the design's hard limits.

In a Studio draft, `ShotRef.name` is a key into the draft's `shots` map (section 3), never the static shot
library. Generated drafts name their shots after the moment they use: `m-<momentId>`.

## 2. Tables: `src/config/migration_v21_studio.sql`

```sql
course_lessons (
  id uuid PK default gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  lesson_no text NOT NULL,          -- "1.2", "8.3"; "I.1" for intro videos, "G.1" for Gemini apps
  section_no int,                   -- 1..9; null for intro/extras
  section_title text,               -- the folder name, e.g. "Chapter 8 - Local RAG lmstudio"
  title text NOT NULL,              -- cleaned from the file name
  video_path text NOT NULL,         -- absolute path on the Mac
  duration_s numeric,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','indexing','indexed','failed')),
  notes jsonb,                      -- LessonNotes
  indexed_at timestamptz, error text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (creator_id, video_path)
)
lesson_moments (
  id uuid PK default gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  t numeric NOT NULL,               -- seconds into the video
  description text NOT NULL,        -- what is on screen
  kind text NOT NULL CHECK (kind IN ('slide','ui','result','code','prompt','other')),
  clean boolean NOT NULL DEFAULT true,  -- no annotation arrows/scribbles, nothing loading or blank
  thumb_url text,                   -- /api/uploads/<id>, a 480px JPEG
  created_at timestamptz DEFAULT now()
)
carousel_drafts (
  id uuid PK default gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('generating','rendering','ready','scheduled','failed')),
  input jsonb NOT NULL,             -- DraftInput
  carousel jsonb,                   -- Carousel
  shots jsonb,                      -- { [name]: ShotSpec }
  campaign jsonb,                   -- { keyword, variants: string[], dm, create: boolean }
  render jsonb,                     -- { ig: string[], tt: string[], rendered_at, job_id }
  schedule jsonb,                   -- { scheduled_time, meta_row_id, tiktok: 'none'|'queue'|'scheduled', tiktok_row_id, tiktok_public_done }
  error text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
)
studio_jobs (
  id uuid PK default gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('scan_library','index_lesson','render_carousel')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed')),
  progress text, claimed_at timestamptz, heartbeat_at timestamptz,
  attempts int NOT NULL DEFAULT 0, result jsonb, error text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
)
```

Enable RLS on all four tables, as migration v11 does. Add indexes on `lesson_moments(lesson_id)`,
`carousel_drafts(creator_id, created_at DESC)` and `studio_jobs(status, created_at)`.

New `app_settings` keys:
- `studio.worker_token` (secret, encrypted like the TikTok client secret)
- `studio.worker_last_seen` (ISO timestamp)
- `studio.worker_name`
- `studio.course_root` (default `/Users/elamir/Desktop/AI Course`)

## 3. Shared types

```ts
type LessonNotes = {
  summary: string;                                   // 2–4 sentences, Arabic
  points: { title: string; detail: string; t?: number }[];   // what it teaches, 3–10
  prompts: { text: string; t?: number }[];           // prompts shown on screen, verbatim
  tools: string[];                                   // products used, e.g. "NotebookLM"
  demos: { title: string; result: string; t?: number }[];
};
type Moment = { id: string; lesson_id: string; t: number; description: string;
                kind: 'slide'|'ui'|'result'|'code'|'prompt'|'other'; clean: boolean; thumb_url: string | null };
type ShotSpec = { lessonId: string; t: number; zoom: number; focusX: number; focusY: number; desc?: string };
type DraftInput = {
  lessonIds: string[];          // 0–3 lessons to ground the post in
  idea?: string;                // free-text topic; required when lessonIds is empty
  angle?: 'auto'|'tips'|'steps'|'mistakes'|'compare'|'prompt'|'overview';
  slides?: number;              // 6–10, default 8
  keyword?: string;             // else suggested
  accent?: string;              // #RRGGBB, else picked from the palette
};
type Draft = {                  // a carousel_drafts row, as JSON
  id, status, input, carousel, shots, campaign, render, schedule, error, created_at, updated_at
};
```

## 4. Operator API

All of these use session auth (`requireAuth` + `canOperate`, tenant-scoped like `/posts/scheduled`).
Errors are `4xx { error: string, problems?: string[] }`.

| Method & path | Body | Response |
|---|---|---|
| GET `/api/studio/status` | | `{ worker: { online, lastSeen, name }, lessons: { total, indexed, indexing, failed }, jobs: { pending, claimed }, tiktok: { audited, queued } }`. `online` means seen within 90s. |
| GET `/api/studio/lessons` | | `{ lessons: (row without notes + { summary: string\|null, moments_count })[] }`, ordered by lesson_no naturally |
| GET `/api/studio/lessons/:id` | | `{ lesson: row with notes, moments: Moment[] }` (by t) |
| POST `/api/studio/scan` | | `{ job }` (enqueues `scan_library` with `{ root: studio.course_root }`) |
| POST `/api/studio/lessons/:id/index` | | `{ job }` (enqueues `index_lesson`; sets lesson status `indexing`) |
| POST `/api/studio/lessons/index-missing` | | `{ count }` (one `index_lesson` job per lesson not `indexed` and not already queued) |
| GET `/api/studio/drafts` | | `{ drafts: Draft[] }`, newest first |
| GET `/api/studio/drafts/:id` | | `{ draft, lessons: { id, lesson_no, title }[] }` |
| POST `/api/studio/drafts` | `DraftInput` | Runs generation synchronously (≤ 120s), saves, and enqueues a render. Returns `{ draft }` with status `rendering`, or `failed` with `error`. |
| PATCH `/api/studio/drafts/:id` | `{ carousel?, shots?, campaign? }` | Validates with `validateCarousel` (400 with `problems`), saves, re-renders. Returns `{ draft }`. Refused once `scheduled`. |
| POST `/api/studio/drafts/:id/rewrite` | `{ index, instruction? }` | Gemini rewrites that one slide within budgets, then saves and re-renders. Returns `{ draft }`. |
| POST `/api/studio/drafts/:id/render` | | `{ job }` |
| POST `/api/studio/drafts/:id/schedule` | `{ scheduled_time, tiktok: 'none'\|'queue'\|'scheduled', create_campaign }` | Needs status `ready`. Creates the `both` + `carousel` row from `render.ig`, with the carousel's instagram caption and a new `group_id`. `tiktok='scheduled'` (only when `tiktok.audited`) adds the TikTok sibling at the same time from `render.tt`. `'queue'` records the intent for the batch. `create_campaign` creates the keyword → DM campaign, unless an active campaign already triggers on the keyword. Returns `{ draft, rows }`. |
| DELETE `/api/studio/drafts/:id` | | 204. Refused once `scheduled`. Also deletes its render uploads. |
| POST `/api/studio/tiktok/batch` | | For every draft with `schedule.tiktok='queue'` and no `tiktok_row_id`, creates a TikTok carousel row due now, 40s apart. Options: direct, SELF_ONLY while unaudited, title = `captions.tiktokTitle`, `auto_add_music` true, `allow_comment` true, `brand_organic` true, consent (the operator's click is the consent). Returns `{ queued }`. |
| POST `/api/studio/drafts/:id/tiktok-public` | `{ done: boolean }` | Ticks the "made public on TikTok" checklist. Returns `{ draft }`. |
| GET `/api/studio/slots?count=n` | | `{ slots: ISO[] }`: the next free 13:00 / 21:00 KSA (10:00Z / 18:00Z) slots not already holding a PENDING Meta post |
| POST `/api/studio/plan` | `{ count, lessonIds? }` | `{ proposals: (DraftInput & { title: string, rationale: string, slot: ISO })[] }`. The dashboard then POSTs `/drafts` for each proposal it keeps. |
| GET `/api/studio/worker-token` | | `{ set, lastSeen, name }` (platform admin) |
| POST `/api/studio/worker-token` | | `{ token }`, shown once; rotating invalidates the old one (platform admin) |

## 5. Worker API

Every call carries `Authorization: Bearer <studio.worker_token>`. There is no session. Every call also
updates `studio.worker_last_seen`.

| Method & path | Body | Response |
|---|---|---|
| POST `/api/studio/worker/claim` | `{ name }` | `200 { job: { id, kind, payload } }` or `204`. Claims the oldest `pending` job, or a `claimed` job whose heartbeat is older than 15 min, using `FOR UPDATE SKIP LOCKED`. Increments `attempts` and fails the job after 3. |
| POST `/api/studio/worker/jobs/:id/progress` | `{ progress }` | 204; also the heartbeat |
| POST `/api/studio/worker/jobs/:id/complete` | `{ result }` | 204, plus the side effects below |
| POST `/api/studio/worker/jobs/:id/fail` | `{ error }` | 204. The job goes `failed`, and its lesson or draft goes `failed` with the error. |
| POST `/api/studio/worker/upload` | `{ filename, mime_type, base64_data }` | `{ id, url }`. JPEG/PNG/WebP, ≤ 3MB decoded, stored through the media store for the token's tenant. `url` is absolute, on `app.public_base_url`. |

Jobs:
- **`scan_library`**
  - Payload: `{ root }`.
  - Result: `{ lessons: [{ lesson_no, section_no, section_title, title, video_path, duration_s }] }`.
  - Server side: upsert by `video_path`. Never delete.
- **`index_lesson`**
  - Payload: `{ lessonId, video_path, lesson_no, title }`.
  - Result: `{ notes: LessonNotes, moments: [{ t, description, kind, clean, thumb_url }] }`, with 12–30 moments.
  - Server side: replace the moments, set `notes`, set status `indexed` and `indexed_at`.
- **`render_carousel`**
  - Payload: `{ draftId, carousel, shots: { [name]: ShotSpec & { video_path } } }`.
  - Result: `{ ig: string[], tt: string[] }`, the upload URLs in slide order.
  - Server side: set `render = { ig, tt, rendered_at, job_id }` and status `ready`. Delete the previous render's uploads unless a `scheduled_posts` row references them.

The server drops a `render_carousel` result whose `job_id` isn't the draft's latest render job (an edit
arrived while it was rendering), and deletes that job's uploads.

## 6. Rules: `src/services/studio/rules.ts`

`validateCarousel(c: Carousel, shotNames: ReadonlySet<string>): string[]` returns one message per problem,
and an empty list when the carousel is valid. It ports every check in
`~/Desktop/AI Course/aicourse-captions/scripts/check-carousels.mts`:
- each budget
- the item counts
- the first slide is `cover` and the last is `cta`
- 6–10 slides
- `highlight` is a substring of `title`
- no Latin digit next to Arabic
- `tiktokTitle` ≤ 90 UTF-16 units
- the instagram caption contains the keyword
- the tiktok caption contains «البايو»
- the accent is `#RRGGBB`
- the keyword is one word
- every `shot.name` is in `shotNames`

## 7. Generation: `src/services/studio/generate.ts`

```ts
generateDraft(input: DraftInput, sources: { lesson: LessonRow; moments: Moment[] }[], ctx: GenContext)
  : Promise<{ carousel: Carousel; shots: Record<string, ShotSpec>; campaign: { keyword; variants; dm; create } }>
rewriteSlide(carousel: Carousel, index: number, instruction: string | undefined, sources, ctx): Promise<Slide>
planWeek(count: number, lessons: LessonRow[], ctx: GenContext): Promise<Proposal[]>
type GenContext = { recentTopics: string[]; recentAccents: string[]; activeKeywords: string[]; palette: string[] };
```

- **Model and call:** Gemini with `GEMINI_API_KEY`, model `gemini-2.5-pro`, `responseSchema`, a 120s timeout.
- **Repair:** up to 2 rounds that send the model `validateCarousel`'s problems to fix.
- **Style:** 3 of ElAmir's approved carousels as few-shot examples (`examples.ts`), plus the voice guide:
  - light Gulf/white dialect
  - Arabic-Indic digits
  - the result first, the tool second
  - short lines
  - TikTok copy points to «رابطه في البايو»
- **Grounding:** every slide except cover and cta comes from the lesson notes or moments, and the model
  returns a `sources` list per slide. A slide with no source is regenerated or dropped. No invented
  features or numbers.
- **Shots:** the model picks `clean` moments. Each becomes a ShotSpec at the moment's `t`, with zoom 1.3 and
  focus at the centre.
- **Keyword:** the input keyword, or a single easy Arabic word that isn't a substring of any
  `activeKeywords`. When an existing active keyword already fits the topic (e.g. متجر), reuse it and set
  `create: false`.
- **DM:** the وكيل DM template from `docs/studio-contract.md` §8, with only its two topical lines changed.
- **Accent:** from `palette`, avoiding `recentAccents`.

## 8. The DM template

```
هلا {username} 👋

<question line about the topic>

<one-sentence pitch naming the course section>

🎬 شوف الكورس كامل من هنا:
https://www.udemy.com/course/agentic-ai-arabic/?referralCode=02A626DDDA3FDAB6AB34

داخل الكورس:
✅ ٣٤ درس · ٥ ساعات و٤٠ دقيقة
✅ ١١ قسم — كل قسم تطبيق عملي من الصفر
✅ شهادة إتمام + وصول مدى الحياة
✅ ضمان استرجاع ٣٠ يوم من Udemy

عندك سؤال؟ رد على هالرسالة — أنا أرد بنفسي ✌️
```

## 9. The worker: `aicourse-captions/scripts/studio-worker.mjs`

- **Config:** `studio.config.json`, gitignored: `{ appUrl, token, geminiApiKey, courseRoot, name }`.
- **Polling:** claim every 5s while jobs keep coming, backing off to 30s when idle. Send progress (the
  heartbeat) at least every 30s during a job.
- **Rendering:** compositions `Studio-ig` and `Studio-tt`, sized by `calculateMetadata` from
  `inputProps { carousel, shots }`. Frames are extracted to `public/studio-shots/<draftId>/<name>.jpg`, and the
  templates read shots from props, not from the static library.
- **Indexing:**
  - Upload the video through Gemini's Files API (resumable) and wait for `ACTIVE`.
  - Call `gemini-2.5-flash` with a `responseSchema` for `{ notes, moments }`.
  - Delete the uploaded file afterwards.
  - Take a 480px thumbnail per moment with ffmpeg and send it through `/worker/upload`.
- **Autostart:** launchd via `scripts/install-studio-worker.sh`, which writes
  `~/Library/LaunchAgents/com.aicourse.studio-worker.plist` (RunAtLoad, KeepAlive, log
  `~/Library/Logs/aicourse-studio-worker.log`). There's an uninstall script too.

## 10. SaaS flexibility (v1.1 — supersedes anything above that hardcodes ElAmir)

The Studio is a product feature for **any tenant**. Nothing about ElAmir — his brand, voice, course, links,
schedule, folder — may be hardcoded in code or prompts. It all lives in per-tenant settings, and his
tenant is simply seeded with today's values.

### 10.1 New tables (add to migration v21; RLS on)
```sql
studio_settings (
  creator_id uuid PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  brand    jsonb NOT NULL,   -- BrandKit
  voice    jsonb NOT NULL,   -- VoiceProfile
  product  jsonb NOT NULL,   -- ProductInfo
  cta      jsonb NOT NULL,   -- CtaConfig
  schedule jsonb NOT NULL,   -- ScheduleConfig
  library  jsonb NOT NULL,   -- LibraryConfig
  examples jsonb,            -- Carousel[] the tenant approved, used as few-shot; null = built-in examples
  updated_at timestamptz DEFAULT now()
)
studio_workers (             -- replaces the global app_settings `studio.worker_*` keys
  id uuid PRIMARY KEY default gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,   -- sha256 hex of the token; the token itself is shown once, never stored
  last_seen_at timestamptz, created_at timestamptz DEFAULT now(), revoked_at timestamptz
)
```
A worker token resolves its **tenant**; `claim` only ever returns that tenant's jobs; every write a worker
makes is scoped to that tenant. A tenant may have several workers (a Mac today, a hosted renderer later).

### 10.2 Settings types (defaults via `defaultStudioSettings()` when a tenant has no row)
```ts
type BrandKit = {
  name: string;                                   // shown in the UI
  signature: { latin: string; local: string };    // "AGENTIC AI" · "بالعربي" — the slide sign-off
  palette: string[];                              // accents to rotate through (#RRGGBB)
  colors: { ink: string; paper: string; muted: string };
  fonts: { display: 'Cairo'|'Tajawal'|'IBM Plex Sans Arabic'|'Inter'; mono: 'JetBrains Mono' };
  direction: 'rtl'|'ltr';
  theme: 'dark-grid';                             // one theme in v1; the field exists so more can be added
};
type VoiceProfile = {
  language: 'ar'|'en';
  guide: string;                                  // free-text voice guide the writer follows
  digits: 'arabic-indic'|'latin';
};
type ProductInfo = {
  name: string;                                   // "Agentic AI: الدليل العملي…"
  url: string;                                    // with referral code
  facts: string[];                                // short facts usable on slides, e.g. "٣٤ درس"
  dmBullets: string[];                            // the ✅ lines in the DM
};
type CtaConfig = {
  instagramAsk: string;       // caption line, with {keyword}: 'اكتب "{keyword}" بالتعليقات ويوصلك رابط الكورس بالخاص 📩'
  tiktokLine: string;         // caption line: '📚 الكورس كامل بالعربي — رابطه في البايو 🔗'
  dmTemplate: string;         // with {username} {question} {pitch} {url} {bullets}
  slide: {                    // the last slide's words, per platform
    igAsk: string;            // 'اكتب في التعليقات'
    igSub: string;            // 'ويوصلك الرابط بالخاص 📩'
    save: string;             // 'احفظ المنشور'
    ttHeadline: string;       // 'الكورس كامل بالعربي'
    ttPill: string;           // 'رابطه في البايو'
    ttSub: string;            // 'ادخل البروفايل واضغط الرابط 👆'
    follow: string;           // 'تابعني للمزيد'
    swipe: string;            // 'اسحب'
  };
};
type ScheduleConfig = { timezone: string; slots: string[] };      // 'Asia/Riyadh', ['13:00','21:00']
type LibraryConfig = { root: string | null };                     // folder the worker scans; null = not set
type StudioSettings = { brand; voice; product; cta; schedule; library; examples: Carousel[] | null };
```
`defaultStudioSettings()` is neutral (English, generic copy, the dark-grid theme, a default palette, no
product). ElAmir's tenant gets today's exact values from a seed script run once after deploy.

### 10.3 Where settings flow
- **Operator API**: `GET /api/studio/settings` → `{ settings }`; `PUT /api/studio/settings` (partial merge,
  validated) → `{ settings }`; `GET /api/studio/workers` → `{ workers }`; `POST /api/studio/workers { name }`
  → `{ worker, token }` (token shown once); `DELETE /api/studio/workers/:id` (revoke). These replace
  `/api/studio/worker-token`.
- **Generation**: `GenContext` gains `settings: StudioSettings`. Prompts are built from `voice.guide`,
  `voice.language`, `voice.digits`, `product`, `cta`, and examples = `settings.examples ?? builtIn(language)`.
  Palette = `brand.palette`. The DM = `cta.dmTemplate` filled in. Rules check the IG caption contains
  `cta.instagramAsk` with the keyword filled, and the TikTok caption contains `cta.tiktokLine`
  (not hardcoded «البايو»); Arabic-digit checks apply only when `voice.digits = 'arabic-indic'`.
- **Slots**: `/slots` uses `schedule.timezone` + `schedule.slots`.
- **Scan**: `scan_library` payload root = `library.root` (400 "set your library folder first" when null).
- **Render**: `render_carousel` payload adds `brand: BrandKit`, `cta: CtaConfig['slide']`, `facts: string[]`.
  The templates read colors, fonts, signature, direction and every CTA word from these (a `BrandContext`
  whose defaults are today's constants), so ElAmir's renders stay pixel-identical.
- **Dashboard**: a Studio **Settings** tab: Brand kit (signature, palette editor, colors, fonts),
  Voice (language, digits, guide), Product & CTAs (all strings above, with live previews of the DM and
  caption lines), Schedule (timezone, slots), Library folder, Workers (create → copy token once, revoke,
  last seen).
