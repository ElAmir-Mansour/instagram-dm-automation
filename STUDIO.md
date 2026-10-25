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

**Since v21** the `kind` CHECK allows 14 kinds (`STUDIO_JOB_KINDS`, `src/services/studio/jobs.ts`): these three, the Monteur's
five (`pick_folder`, `monteur_scan`, `monteur_transcribe`, `monteur_render`, `monteur_think`; MONTEUR.md), `render_infographic`
(v31, the infographics), `ads_think` (v55, the Ads Manager's AI proposals) and the explainers' four (§11).

**Workers** (as built in v21, not the `studio.worker_*` app settings this contract first proposed): each Mac worker is a row in
`studio_workers` with its own token, stored only as a hash (`token_hash`), a name and when it was last seen
(`src/services/studio/worker.ts`). The operator creates one in Studio → Settings (the token is shown once) and revokes it there.
The folder a worker may read, `courseRoot`, is in the worker's own config (§9), not in the app.

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
| GET `/api/studio/slots?count=n` | | `{ slots: ISO[] }`: the next free posting times from the account's Schedule settings (§10.3; wall-clock times in its timezone, `src/services/studio/slots.ts`) not already holding a PENDING Meta post |
| POST `/api/studio/plan` | `{ count, lessonIds? }` | `{ proposals: (DraftInput & { title: string, rationale: string, slot: ISO })[] }`. The dashboard then POSTs `/drafts` for each proposal it keeps. |
| POST `/api/studio/drafts/:id/unschedule` | | The way back from `scheduled`: its queued posts are removed and the draft reopens. 409 once any of them went out. |
| GET `/api/studio/workers` | | `{ workers }` |
| POST `/api/studio/workers` | `{ name }` | 201 `{ worker, token }`: the token is shown once (admin) |
| DELETE `/api/studio/workers/:id` | | 204: the worker is revoked (admin) |

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

`validateCarousel(c: Carousel, shotNames: ReadonlySet<string>, settings: RuleSettings): string[]` returns one message per problem,
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

- **Model and call:** for the owner, Gemini with the platform's key (saved on Operations, else `GEMINI_API_KEY`); for any other
  tenant, the AI providers layer (purpose `tenant_studio`, `writerOptionsFor` in `src/services/studio/tenantAi.ts`). Gemini goes through the chain `STUDIO_MODELS` in `generate.ts` (`gemini-3.1-pro-preview`, then three flash models; a 400/404/429/500/503 moves to the next). `responseSchema` is sent without `minItems`/`maxItems`, which Gemini 3 refuses. A 120s timeout. Never `gemini-2.5-flash`, which the DM bot runs on.
- **Repair:** up to 2 rounds that send the model `validateCarousel`'s problems to fix.
- **Style:** the tenant's own approved carousels (at most 3 of `studio_settings.examples`) as few-shot examples, none if it has none (P14 removed the built-in fallback; the owner's three are in his own row, marked `reference: true`), plus the voice guide:
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
- **DM:** the وكيل DM template from §8 of this doc, with only its two topical lines changed.
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

- **Config:** `studio.config.json`, gitignored: `{ appUrl, token, geminiApiKey, courseRoot, name, indexConcurrency, claudePath }`
  (`studio.config.example.json` in the worker repo; the worker's README says what each does).
- **Polling:** claim every 5s while jobs keep coming, backing off to 30s when idle. Send progress (the
  heartbeat) at least every 30s during a job.
- **Rendering:** compositions `Studio-ig` and `Studio-tt`, sized by `calculateMetadata` from
  `inputProps { carousel, shots }`. Frames are extracted to `public/studio-shots/<draftId>/<name>.jpg`, and the
  templates read shots from props, not from the static library.
- **Indexing:**
  - Upload the video through Gemini's Files API (resumable) and wait for `ACTIVE`.
  - Call the chain `INDEX_MODELS` (`gemini-3.5-flash`, `3.6-flash`, `3-flash-preview`) at `MEDIA_RESOLUTION_LOW`, with a `responseSchema` for `{ notes, moments }`. The upload is a 640px 1 fps proxy, not the original.
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
  examples jsonb,            -- the tenant's few-shot carousels; `reference: true` marks another creator's; null = none: there are no built-in examples (P14); the owner's three are in his own row
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
type StudioSettings = { brand; voice; product; cta; schedule; library; examples: ExampleCarousel[] | null };
```
`defaultStudioSettings()` is neutral (English, generic copy, the dark-grid theme, a default palette, no
product). ElAmir's tenant gets today's exact values from a seed script run once after deploy.

### 10.3 Where settings flow
- **Operator API**: `GET /api/studio/settings` → `{ settings }`; `PUT /api/studio/settings` (partial merge,
  validated) → `{ settings }`; `GET /api/studio/workers` → `{ workers }`; `POST /api/studio/workers { name }`
  → `{ worker, token }` (token shown once); `DELETE /api/studio/workers/:id` (revoke). These replace
  `/api/studio/worker-token`.
- **Generation**: `GenContext` gains `settings: StudioSettings`. Prompts are built from `voice.guide`,
  `voice.digits`, `product`, `cta`, and the examples = `settings.examples` (a tenant with none gets no "Approved carousels" section: there is no built-in
  fallback, P14; the owner's three are in his own row, marked `reference: true`). Who the writer writes for is the profile's `carousel`
  context (`GenContext.wording`, from `studioWording`): the language and register (the time words a TikTok caption must
  not use, and the DM's fallback question, are that register's, `profile/kits.ts`), the noun for what is sold
  ("whose program is…"; a pitch fallback exists only for a course) and the kind (the learning hashtags are an
  educator's or a coach's). Examples are printed by `exampleJson`, keys in a fixed order, because jsonb reorders them.
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

## 11. Illustrated explainers

Migration v59, `src/services/explainers/`. A narrated video made from a topic: one still picture per sentence, a recurring cartoon character, a label on some pictures. Claude on the
owner's Mac researches the topic on the web and writes the script; the Mac voices it (Gemini text-to-speech, timed with whisper.cpp); the
app draws the pictures (Cloudflare Workers AI, from a free daily allowance); the Mac renders a 9:16 video, a 16:9 video and a cover; Schedule
makes `scheduled_posts` rows. **Owner-only and dark by default**: the switch is `explainers.enabled.<tenant>` (11.4). FLOWS.md §13 walks it hop
by hop with a `file:line` at each step; this section is the contract: the tables, the four jobs, the settings and the routes. The Mac's side is
`aicourse-captions/scripts/studio/explainerWrite.mjs`, `explainerVoice.mjs`, `explainerDraw.mjs` and `explainerRender.mjs`.

Where the design spec (kept outside this repo) and the code differ, this section follows the code.

### 11.1 Tables: `src/config/migration_v59_explainers.sql`

```sql
explainers (
  id uuid PK default gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('writing','draft','voicing','drawing','review','rendering','ready','scheduled','failed')),
  failed_step text CHECK (failed_step IN ('write','voice','draw','render','schedule')),  -- set exactly while status = 'failed' (a CHECK)
  error text,                       -- the reason of the last failure, or the note of a pause, in words the owner reads
  topic text NOT NULL,              -- 3-300 characters
  language text NOT NULL DEFAULT 'ar' CHECK (language IN ('ar','en')),
  length_tier text NOT NULL CHECK (length_tier IN ('short','medium','long')),   -- 60-90 s, 3-5 min, 10-15 min
  sound_mode text NOT NULL CHECK (sound_mode IN ('music','sfx')),
  music_track_id text,              -- a key of studio_settings.explainer.music; needed before a render when sound_mode = 'music'
  subtitles boolean NOT NULL DEFAULT true,
  notes text,                       -- the owner's, at most 2000 characters
  source_links jsonb NOT NULL DEFAULT '[]',   -- [{ url }], at most 10, http or https
  title text,
  draft jsonb,                      -- { writer, captions: { meta, youtube: { title, description }, tiktok }, first_comment, replies: [{ q, a }], sources: [{ title, by, year, url }], est_seconds, warnings }
  draft_version int NOT NULL DEFAULT 0,       -- +1 on every writer result and every save of narration
  rewrite_note text,
  audio jsonb,                      -- { url, media_id, duration, voice, version, words_version, fallback }; out of date when version != draft_version
  words jsonb,                      -- { "<scene position>": [[start, end, word], …] }, for the subtitles
  render jsonb,                     -- { vertical_url, horizontal_url, cover_url, duration, sound_mode, version, job_id }
  schedule jsonb,                   -- { scheduled_time, group_id, row_ids }
  job_id uuid,                      -- the studio job working on it, no foreign key: the result of any other job is dropped
  draw_paused_until timestamptz,    -- set while drawing waits for the image allowance to reset
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
)
explainer_scenes (
  id uuid PK default gen_random_uuid(),
  explainer_id uuid NOT NULL REFERENCES explainers(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,   -- the explainer's tenant, so every query names it
  position int NOT NULL,            -- 0-based, renumbered when the owner saves the list
  narration text NOT NULL,          -- the sentence as shown on screen
  spoken text NOT NULL,             -- what the narrator says: English terms spelled the way an Arabic voice says them
  label text NOT NULL DEFAULT '',   -- at most 4 words and 40 characters, '' for none; drawn by the renderer, never by the image model
  brief text NOT NULL,              -- the picture brief for the image model, in English
  characters text[] NOT NULL DEFAULT '{}',    -- keys of studio_settings.explainer.characters; at most 4 a scene (spec.ts)
  continues boolean NOT NULL DEFAULT false,   -- keeps the previous scene's picture; such a scene is never drawn
  start_s numeric, end_s numeric,   -- seconds into the audio: both set by the voice step or both null; end_s > start_s
  picture jsonb,                    -- the chosen picture { media_id, url, seed, provider, model, prompt_hash, at }
  pictures jsonb NOT NULL DEFAULT '[]',       -- the last three before it, newest first
  draw_status text NOT NULL DEFAULT 'pending' CHECK (draw_status IN ('pending','drawing','done','failed','skipped')),
  draw_error text, draw_note text,  -- draw_note: the owner's redraw note, at most 300 characters
  draw_attempts int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
)
image_allowance (                   -- platform-wide, not per tenant: the provider account is the owner's
  provider text NOT NULL,           -- 'cloudflare'
  day date NOT NULL,                -- the UTC day
  units numeric NOT NULL DEFAULT 0, -- estimated units used, never billed
  pictures int NOT NULL DEFAULT 0,
  exhausted_at timestamptz,         -- when the provider said the free allocation was used up
  PRIMARY KEY (provider, day)
)
```

Indexes `explainers (creator_id, created_at DESC)` and `explainer_scenes (explainer_id, position)`. Row level security on all three, deny-by-default as
migration v11 does; `image_allowance` rows older than 90 days are swept daily. The same migration changes two tables of §2 and §10:

```sql
ALTER TABLE studio_jobs ADD COLUMN not_before timestamptz NOT NULL DEFAULT now();   -- a pending job is claimable only once it has passed (11.3)
-- studio_jobs_kind_check gains 'explainer_write', 'explainer_voice', 'explainer_draw', 'explainer_render' (the list of v55 plus these)
ALTER TABLE studio_settings ADD COLUMN explainer jsonb NOT NULL DEFAULT '{}';       -- the look and sound of explainers (11.4)
```

Rollout: `npm run migrate` BEFORE deploying. The claim reads `not_before` on every poll, and the settings read selects `explainer`.

### 11.2 Statuses: `src/services/explainers/state.ts`

| Status | What is happening | Moves out of it |
|---|---|---|
| `writing` | the script is being written: an `explainer_write` job on the Mac, or Gemini's run on the server | the writer's result → `draft`; its failure → `failed` (`write`) |
| `draft` | the owner reads and edits the script | approve (gate 1) → `voicing`; rewrite → `writing` |
| `voicing` | `explainer_voice` | the voice result → `drawing`; failure → `failed` (`voice`) |
| `drawing` | the pictures are being drawn, or waiting for the image allowance (`draw_paused_until`) | no scene left to draw → `review`; re-voice → `voicing`; failure → `failed` (`draw`) |
| `review` | the owner checks, redraws and picks pictures | approve pictures (gate 2) → `rendering`; re-voice → `voicing` |
| `rendering` | `explainer_render` | the render result → `ready`; failure → `failed` (`render`) |
| `ready` | rendered, waiting for Schedule | schedule → `scheduled`; render again → `rendering`; re-voice → `voicing` |
| `scheduled` | its posts exist | none |
| `failed` | `failed_step` and `error` say what and why | retry → the state that step runs in: `writing`, `voicing`, `drawing`, `rendering`; a failed `schedule` goes back to `ready`, where Schedule is pressed again |

- `transitionExplainer` is the only code that writes `status`. It locks the row, checks the move against the caller's own list of states and the table (`canMove`), and
  answers 409 `EXPLAINER_BAD_STATE` otherwise. A step can fail only from the state it runs in.
- **A job's result is applied only if the job is `explainers.job_id`.** A step queues its job in the transaction of its own move; a result of any other job (replaced
  by a rewrite, a re-voice, a new drawing or render; the explainer deleted) is dropped, logged, and the job ends `done` with `{ dropped }`.
- A change to a scene's `narration` or `spoken` adds one to `draft_version`: the voiced audio is then **stale** (`audio.version != draft_version`). A re-voice is allowed from
  `drawing`, `review` or `ready`, and only while the audio is stale. Labels, briefs, characters and pictures never change the status.

### 11.3 The four jobs

Four new `studio_jobs.kind` values, all queued by the app (`src/services/explainers/payloads.ts`) and answered by the Studio worker (§5, §9). Claim order, oldest first
within a rank: `explainer_write` 1 (with `monteur_think`), `explainer_voice` and `explainer_render` 2, `explainer_draw` 3. **A `pending` job is claimable only once its
`not_before` has passed**; every job that sets none is due when it is queued. A `claimed` job whose heartbeat is older than 15 minutes, with fewer than three attempts, is
reclaimed whatever its `not_before` says. `enqueueJob(…, { notBefore })` is how a job is queued for later.

- **`explainer_write`** (Claude on the owner's Mac, on his plan: Mac-brain work, so `macBrain.ts` refuses it for any tenant the Mac is not for)
  - Payload: `{ explainer_id, language, length_tier, topic, notes, source_links: string[], rewrite_note?, previous_draft?, characters: [{ key, name, description }], style, bounds: { scenes_min, scenes_max, seconds_min, seconds_max, pace }, write: { model, system, user, schema } }`.
    `write` is built by the app (`src/services/explainers/prompt.ts`) and is what Claude is run with; the worker reads `explainer_id` and `write`.
  - Handler: the claude CLI with **WebSearch and WebFetch only**; the answer is checked against the worker's copy of the schema (`scripts/studio/explainerSchema.json`),
    and one that does not fit gets one repair, with no web.
  - Result: `{ written, model, usage?, research_rounds? }`. `written` is the answer of `src/services/explainers/writerSchema.json`: `{ title (5 to 70 characters), scenes: [{ narration, spoken, label, brief, characters, continues, source_ids }] (10 to 300), captions: { meta, youtube: { title, description }, tiktok }, first_comment, replies: [{ q, a }] (5 to 10), sources: [{ title, by, year, url }] (at most 20) }`.
    `research_rounds` is how many rounds of web reading the first call made: **0 means the script was written from memory**; absent means unknown.
  - Server side (`applyWrite`): an answer that does not fit the schema is a 400 and the job stays claimed. The explainer must be `writing` and the job its `job_id`. Character keys the settings do not have are dropped; the scenes replace the explainer's;
    `title` and `draft` are stored with `draft_version + 1` and the status is `draft`. `checkDraft` (11.6) fills `draft.warnings`, with `research_limited` added when `research_rounds` is 0.
  - **Gemini's own write.** When the owner chose `writer: 'gemini'`, or, with `writer_fallback` on, the Mac cannot write (it is signed out, or it has not taken the job in 10 minutes and is off or asleep), the server writes a job
    of this kind itself: inserted `claimed`, with `payload.writer = 'gemini'` and its three attempts spent, so the Mac never takes it. Its run (research with Google Search grounding, then the write from the notes; `writerGemini.ts`) ends in the same `completeJob`, with `{ written, model }`.
    A busy Mac is never replaced. Google Search grounding is not offered on the free tier for Gemini 3 models, so on a free key the run fails saying so.
- **`explainer_voice`**
  - Payload: `{ explainer_id, version, language, voice, style, scenes: [{ position, spoken }], chunk_seconds_max: 180, limit_retries? }`. `version` is the explainer's `draft_version` when it was approved.
  - Handler: Gemini text-to-speech (`gemini-3.8-flash-tts`) in parts of at most `chunk_seconds_max` estimated seconds, cut at scene boundaries, one request a part; the parts joined, loudness-normalised and encoded as an m4a (`audio/mp4`);
    whisper.cpp times every scene and word; the file goes up through `POST /worker/uploads/sign`. A refusal for quota is thrown as `VOICE_LIMIT: …`.
  - Result: `{ audio: { url, duration, voice, fallback }, version, scenes: [{ position, start, end }], words: { "<position>": [[start, end, word], …] } }`. `fallback` is true when a scene could not be aligned and its times were spread by word count.
  - Server side (`applyVoice`): the explainer must be `voicing` and the job its `job_id`. The scenes must be the explainer's own, every one, in order, with `end > start` and no overlap past 0.05 s (a 400 otherwise). A result whose `version` is not the explainer's
    `draft_version` is **not stored**: the explainer goes `failed` (`voice`). Otherwise the audio (an `audio/mp4` upload of the tenant, its URL rebuilt on `app.public_base_url`), the scene times and the words are stored, an `explainer_draw` is queued, and the status is `drawing`.
    A `VOICE_LIMIT:` failure queues the voice again with a `not_before` (the minute's limit after the wait it names, at least a minute; the day's at midnight Pacific plus five minutes), up to three times; the explainer stays `voicing`, with the reason as its note.
- **`explainer_draw`**
  - Payload: `{ explainer_id }`.
  - Handler: the Mac only keeps asking, because the app draws. It calls `POST /api/studio/worker/explainers/:id/draw-next { job_id }` (11.5) until the app answers `done` or `paused`, or three scenes fail in a row; its progress reads `drawn n of m`.
  - Result: `{ state: 'done' } | { state: 'paused', until } | { state: 'failed' }`.
  - Server side (`applyDraw`): `done` → the explainer is `review` already (the route moved it); `paused` → the next `explainer_draw` is queued with `not_before` = `until` (when that is between a minute and two days away, else the next UTC midnight plus five minutes), and the explainer
    stays `drawing` with `draw_paused_until` and a note; `failed` → the explainer stays `drawing` with the last reason and no job, and the owner redraws a scene or restarts the drawing. A `paused` or `failed` result for an explainer that is no longer `drawing` is dropped.
- **`explainer_render`**
  - Payload: `{ explainer_id, version, title, language, subtitles, sound_mode, music?: { url, credit_required }, sfx, audio: { url, duration }, scenes: [{ position, start, end, label, picture_url }], words, brand: { name, handle, site, photo_url? }, title_color, formats: ['vertical', 'horizontal'] }`.
    `brand` is the owner's infographic settings; `sfx` is true for sound effects only. The app builds it only for an explainer a render could run for: voiced audio that is not stale, a track in the library when the sound is music, and a picture for every scene (`renderReadiness`).
  - Handler: Remotion renders `IllustratedVertical` (1080×1920) and `IllustratedHorizontal` (1920×1080) muted, and the `IllustratedCover` still; ffmpeg adds the voice and the sound (the track at −20 dB, faded and ducked by the voice; or a whoosh at every cut and a pop after every label),
    loudness-normalised to −14 LUFS; both videos and the cover go up through signed uploads (each at most 100 MB).
  - Result: `{ vertical_url, horizontal_url, cover_url, duration, version, sound_mode }`.
  - Server side (`applyRender`): the explainer must be `rendering` and the job its `job_id`; a result that is no longer current has its three files deleted. The three URLs must be the tenant's uploads (two `video/mp4`, one `image/jpeg`, there in Storage). `render` is stored (URLs rebuilt on
    `app.public_base_url`), the status is `ready`, and the previous render's files are deleted unless a post names them. A render of an older `version` is still stored, and the view says `render_stale`.

### 11.4 Settings

**`studio_settings.explainer`** (`ExplainerConfig`, `src/services/studio/settingsTypes.ts`): one section of the tenant's Studio settings, and **not one the Creator Profile owns**, so it is read and written as stored. It is edited with
`PUT /api/studio/settings { explainer: … }` like the other sections (§10.3: a partial merge, validated whole by `settingsProblems`, `src/services/studio/settings.ts`).

```ts
type ExplainerConfig = {
  style: string;                      // the art direction every picture starts from; at most 600 characters
  characters: ExplainerCharacter[];   // at most 6
  voices: { ar: string; en: string }; // the narrator per language: 'ar-001-commercial-3' (Arabic only), or Charon, Sadaltager, Schedar, Gacrux, Sulafat, Achernar, Vindemiatrix, Rasalgethi
  voice_style: string;                // sent beside the text, never in it; at most 300 characters
  pace: { ar: number; en: number };   // words a second, 1 to 4: the estimate of a script's length. Defaults 1.8 and 2.5
  writer: 'claude_mac' | 'gemini';    // who writes the script
  writer_fallback: boolean;           // on: when the Mac cannot write, Gemini writes. Off: the explainer waits for the Mac, or fails with its reason
  title_color: string;                // #RRGGBB: the title at the top of the vertical video
  defaults: { sound_mode: 'music' | 'sfx'; subtitles: boolean; language: 'ar' | 'en'; length_tier: 'short' | 'medium' | 'long' };   // what a new explainer starts with
  music: ExplainerTrack[];            // at most 30
};
type ExplainerCharacter = {
  key: string;                        // 1 to 30 lower-case letters, digits, - or _, starting with a letter or a digit; unique; what a scene's brief and `characters` name it by
  name: string;                       // at most 30 characters
  description: string;                // English, for the image model; at most 400 characters
  ref_media_id: string | null;        // the approved reference picture, an upload of ours: these three are all set together or all null
  ref_url: string | null;             // `/api/uploads/<ref_media_id>`
  approved_at: string | null;
};
type ExplainerTrack = {
  key: string;                        // same pattern, unique; an explainer's `music_track_id` names it
  title: string; artist: string;      // at most 120 characters each
  media_id: string; url: string;      // an upload of ours (`/api/uploads/<media_id>`)
  license: string;                    // required; at most 120 characters
  credit: string;                     // the credit line, at most 300 characters; required when credit_required
  credit_required: boolean;           // the credit line goes at the end of every caption of a video that uses the track
};
```

Defaults (`defaultExplainerConfig()`): the style `warm hand-painted gouache illustration, soft paper texture, beige, terracotta and olive palette, thin ink outlines, simple shapes`, no characters, voices `ar-001-commercial-3` and `Sadaltager`,
the voice style `a calm, warm documentary narrator; clear, unhurried, curious`, `writer: 'claude_mac'`, `writer_fallback: true`, `title_color: '#FFD43B'`, `defaults: { sound_mode: 'sfx', subtitles: true, language: 'ar', length_tier: 'short' }`, no music.
A character whose `name` or `description` names a woman or a girl is refused when it is saved (`findFemaleSubject`, `src/services/explainers/spec.ts`): Explainers never draw them, and the same guard runs again before anything is sent to the image provider.

**`app_settings` keys** (platform admin; `src/services/appSettings.ts`):

| Key | Value |
|---|---|
| `explainers.enabled.<tenant id>` | `true`, or absent (off). The per-tenant switch. Only the platform owner can be switched **on** (409 `EXPLAINERS_OWNER_ONLY` for any other tenant, and for everyone when there is no owner); off removes the row. Every `/api/studio/explainers` route answers 404 `EXPLAINERS_DISABLED` without it. Written only by `setExplainersEnabled` (`switch.ts`). |
| `explainers.image_provider` | The image provider, platform-wide, because the provider account is the owner's: `{ provider: 'cloudflare', account_id, token_enc, model: '@cf/black-forest-labs/flux-2-klein-4b', daily_cap: 80, units_per_picture: 110 }`. `daily_cap` is in pictures a UTC day; `units_per_picture` is the estimated cost of one in the provider's units (Cloudflare's neurons: its free allocation is 10,000 a day and it cannot be asked what is left). **The API token is encrypted (`token_enc`, `src/config/crypto.ts`) before the JSON is written, and every answer shows only its last four characters (`token_last4`).** The model cannot be changed from the card. |

### 11.5 Routes

**Operator API.** `/api/studio`, under §4's guards (session, tenant, operator role) and with the switch checked first. Refusals use the shared envelope (`error` the English sentence, with `message`, `code` and `params`; `src/services/errorCodes.ts`) and the status
of their code (11.6); beside them, a refused script carries `findings` and `problems`, a paused drawing `retryAt` (and a `Retry-After` header on its 429), a missing picture `positions`.

| Method & path | Body | Response |
|---|---|---|
| GET `/api/studio/explainers` | | `{ items: ExplainerSummary[] }`, newest first, at most 60 |
| POST `/api/studio/explainers` | `{ topic, language?, length_tier?, sound_mode?, music_track_id?, subtitles?, notes?, source_links? }` | 201 `Explainer`, `writing`, the write queued (Claude's job, or Gemini's run when the owner chose it). Omitted choices take the tenant's `studio_settings.explainer.defaults`. |
| GET `/api/studio/explainers/allowance` | | `{ provider, day, used_units, pictures, cap, est_left, paused_until }`, or `null` when no image provider is set up |
| POST `/api/studio/explainers/characters/candidates` | `{ description }` | `{ candidates: [{ media_id, url }] }`: up to four pictures at 448×448; they count against the allowance |
| POST `/api/studio/explainers/uploads/sign` (owner) | `{ purpose: 'music' \| 'reference', mime, size }` | 201 `{ upload_url, media_id, url }`. `music`: `audio/mpeg`, `audio/mp4`, `audio/wav`; `reference`: `image/png`, `image/jpeg`; at most 25 MB. The browser PUTs the file to `upload_url`. |
| GET `/api/studio/explainers/:id` | | `Explainer`. First looks at a stuck script: a Mac that is signed out, or that has not taken the job in 10 minutes and is off, is replaced by Gemini here |
| PATCH `/api/studio/explainers/:id` | any of `{ title, draft: { captions, first_comment, replies, sources }, scenes, sound_mode, music_track_id, subtitles }` | `Explainer`. `scenes` is the whole ordered list of `{ narration, spoken, label, brief, characters, continues }`; it cannot grow or shrink once the narration is voiced. A save may not add a problem to the script (422 `EXPLAINER_DRAFT_REFUSED`). 409 `EXPLAINER_BAD_STATE` for what the running step reads, and for anything once `scheduled`. Captions: meta ≤ 2,200, YouTube title ≤ 100 and description ≤ 5,000, TikTok ≤ 2,200; first comment ≤ 1,500; ≤ 10 replies; ≤ 20 sources. |
| POST `/api/studio/explainers/:id/rewrite` | `{ note }` | `Explainer` (`writing`), from `draft` only; the note is at most 2,000 characters |
| POST `/api/studio/explainers/:id/approve` | `{ version }` | `Explainer` (`voicing`). **Gate 1.** 409 `CHANGED_MEANWHILE` when `version` is not the `draft_version` the owner read; 422 `EXPLAINER_DRAFT_REFUSED` while the script has a problem or no title |
| POST `/api/studio/explainers/:id/revoice` | | `Explainer` (`voicing`), from `drawing`, `review` or `ready`, only while the audio is stale |
| POST `/api/studio/explainers/:id/draw` | | `Explainer`, from `drawing` only: starts the unattended drawing again (after a pause, or failed scenes); a drawing already running is left alone |
| POST `/api/studio/explainers/:id/scenes/:position/draw` | `{ note? }` | `{ scene, allowance }`: draws or redraws one scene now, synchronously (up to 55 s, `CLOUDFLARE_TIMEOUT_MS`). 429 `EXPLAINER_ALLOWANCE_PAUSED`, 422 `EXPLAINER_PROMPT_REFUSED`, 409 `EXPLAINER_NEEDS_REFERENCE`, 409 `EXPLAINER_NO_PROVIDER` |
| POST `/api/studio/explainers/:id/scenes/:position/pick` | `{ index }` | `{ scene }`: goes back to one of the scene's earlier pictures (`pictures[index]`); nothing is drawn or spent |
| POST `/api/studio/explainers/:id/approve-pictures` | | `Explainer` (`rendering`), from `review` only. **Gate 2.** 409 `EXPLAINER_AUDIO_STALE`, `EXPLAINER_NO_TRACK`, or `EXPLAINER_PICTURES_MISSING` with the `positions` |
| POST `/api/studio/explainers/:id/render` | | `Explainer` (`rendering`), from `ready`; the previous render stays until the new one lands |
| POST `/api/studio/explainers/:id/schedule` | `{ when?: 'next' \| 'now' \| ISO-8601 }` | `Explainer` (`scheduled`, `schedule.row_ids`). The default is the next free posting slot. Instagram, Facebook and YouTube follow `studio_settings.infographic.platforms`; TikTok is always made, as an inbox draft. One `group_id`, a caption of its own for each platform, and the track's credit line at the end of every caption when the track requires it. YouTube gets the vertical video as a Short up to 180 s, and the horizontal video (`shorts: false`, no `#Shorts`) past it. 409 `EXPLAINER_RENDER_STALE`, `EXPLAINER_NO_TRACK` |
| POST `/api/studio/explainers/:id/retry` | | `Explainer`, from `failed` only: the failed step again, from the state it runs in |
| DELETE `/api/studio/explainers/:id` | | 204. Its files are deleted, except any a scheduled post names |

```
ExplainerSummary = { id, status, title, topic, language, length_tier, est_seconds, progress: { done, total } | null, updated_at, thumb_url }   // progress only while drawing; thumb = the first scene's picture
Explainer = ExplainerSummary & { failed_step, error, sound_mode, music_track_id, subtitles, notes, source_links, draft, draft_version, audio, audio_stale, render, render_stale, schedule,
            draw_paused_until, scenes: Scene[], problems: DraftFinding[], job: { status, progress, not_before } | null, worker: { online, lastSeen, name } | null, allowance }
Scene = { position, narration, spoken, label, brief, characters, continues, start_s, end_s, picture, pictures, draw_status, draw_error, draw_note }
DraftFinding = { code, message, scene?, field? }   // `problems` are computed on every read, never stored; `draft.warnings` are stored
```

**Worker API** (bearer worker token, §5). `claim`, `progress`, `complete` and `fail` serve the four kinds as they serve the others, with these differences and additions:

| Method & path | Body | Response |
|---|---|---|
| POST `/api/studio/worker/claim` | `{ name, kinds? }` | `200 { job }` or `204`, with the ranks and the `not_before` rule of 11.3 |
| POST `/api/studio/worker/jobs/:id/fail` | `{ error }` | 204. A failed `explainer_write` is looked at at once: if the Mac is signed out, Gemini takes the writing over |
| POST `/api/studio/worker/uploads/sign` | `{ filename, mime_type, size_bytes }` | as in MONTEUR.md §4; `audio/mp4` (the narration) is now one of the types |
| POST `/api/studio/worker/explainers/:id/draw-next` | `{ job_id }` | `{ state: 'drawn', position, remaining }` or `{ state: 'done' }` or `{ state: 'paused', until }` or `{ state: 'failed', position, error }` |

`draw-next` draws **exactly one scene on the server**, with the explainer's tenant: the pending one with the lowest position (a scene that `continues` the one before takes its picture instead, with no provider and no allowance). It is **refused with 409 `EXPLAINER_BAD_STATE`
unless `job_id` is the explainer's own current `explainer_draw` job, that job is claimed, and the explainer is `drawing`**: a stale loop cannot spend the allowance. When nothing is left to draw it moves the explainer to `review` and answers `done`. `paused` carries `until`, the next 00:05 UTC.
The route is not behind the explainers switch: the worker token and the `job_id` are its guards. A scene's picture is reserved against the allowance before the provider is called, and given back if the call fails (FLOWS.md §13.10).

**Admin API** (`/api/admin/explainers`, platform admin; 404 for anyone else):

| Method & path | Body | Response |
|---|---|---|
| GET `/api/admin/explainers` | | `{ enabled: { <tenant id>: boolean }, provider: { provider, account_id, token_last4, model, daily_cap, units_per_picture } \| null }` |
| PUT `/api/admin/explainers/provider` | `{ account_id, token?, daily_cap?, units_per_picture? }` | the same answer. A field that is null or blank is left as it is, the first save needs the account id and the token, the token is 20 to 200 characters with no spaces, `daily_cap` is a whole number from 0 to 1000, `units_per_picture` is above 0 and at most 10,000. The audit row names the fields that changed, never the token |
| PUT `/api/admin/explainers/enabled` | `{ tenant_id, enabled }` | the same answer; 409 `EXPLAINERS_OWNER_ONLY` for a tenant that is not the platform owner |
| POST `/api/admin/explainers/provider/test` | | `{ ok, ms, error? }`: draws one 256×256 picture; it counts against the allowance. A failed test is a 200 with `ok: false` |

Audit actions: `explainer.created`, `explainer.approved`, `explainer.pictures_approved`, `explainer.scheduled`, `explainer.deleted`, `explainers.provider_updated`, `explainers.enabled_changed`. None holds the topic, a caption or a token.

### 11.6 Rules and refusals

`src/services/explainers/spec.ts`, pure: the same list holds the writer's answer, an owner's save and the check at approval (`checkDraft`).

- **Scenes by tier:** short 10 to 30, medium 30 to 90, long 120 to 300 (never more than 300). **Estimated length** = spoken words ÷ `explainer.pace`; a warning outside short 55 to 95 s, medium 170 to 310 s, long 570 to 930 s.
- **Limits:** title 70 characters; narration 300; spoken 400; brief 500; a label at most 4 words and 40 characters; at most 4 characters a scene.
- **Problems** (the script is not approved, and a save that adds one is refused): an empty narration, spoken line or brief; a field past its limit; a label too long; too many characters in a scene; a `source_ids` entry naming a source that is not listed; **a last scene whose narration is not a question** (ending in `?` or `؟`);
  **engagement bait** (asking viewers to comment a word, type a number, react, share or tag, in English or Arabic) in the last scene, in a caption or in the first comment; **a woman or a girl named in a picture brief**; no scenes, or more than 300.
- **Warnings** (stored with the draft, shown beside it, never blocking): `scene_count`, `duration_short`, `duration_long`, `slow_opening` (the first picture is held over 4.5 s), `scene_long` (a picture is held over 7 s), `scene_short` (a picture goes in under 2 s), `needs_sources` (none listed), `few_sources` (a short explainer cites fewer than 3), `research_limited` (written with no web reading). Each picture's time is its sentence's spoken words over the pace, with the scenes that keep it (`pictureHolds`); the writer is asked for sentences of 3.5 to 6.5 s of speech and a hook under about 4 s (`PICTURE_SECONDS` in `src/services/explainers/spec.ts`).
- **Refusals** (`src/services/explainers/errors.ts`, registered in `src/services/errorCodes.ts`): `EXPLAINERS_DISABLED` 404, `EXPLAINER_NOT_FOUND` 404, `EXPLAINER_BAD_STATE` 409, `EXPLAINER_PROMPT_REFUSED` 422, `EXPLAINER_NO_PROVIDER` 409, `EXPLAINER_ALLOWANCE_PAUSED` 429 (`retryAt`),
  `EXPLAINER_PROVIDER_ERROR` 502, `EXPLAINER_NO_TRACK` 409, `EXPLAINER_NEEDS_REFERENCE` 409, `EXPLAINERS_OWNER_ONLY` 409, `EXPLAINER_DRAFT_REFUSED` 422 (`findings`), `EXPLAINER_AUDIO_STALE` 409, `EXPLAINER_PICTURES_MISSING` 409 (`positions`), `EXPLAINER_RENDER_STALE` 409;
  and `CHANGED_MEANWHILE` 409 from an approval of a script that changed. `EXPLAINER_VOICE_LIMIT` is no route's answer: it names the note an explainer keeps while its voice waits for Gemini's free allowance (a note that starts with `VOICE_LIMIT:`).

**Media.** A picture is a PNG or JPEG the server writes to the media store as the tenant's upload (`/api/uploads/<id>`); the narration, the two videos and the cover are uploaded by the worker through signed uploads; a music track and a character's reference picture by the owner, through
`POST /api/studio/explainers/uploads/sign`. Kept: a scene's pictures while the scene exists, a track and a reference picture while the settings name them, the narration and videos without limit until `scheduled` and then until 30 days after the posting time (FLOWS.md §13.15).
