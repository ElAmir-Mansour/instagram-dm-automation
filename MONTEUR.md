# Monteur: the contract (v1)

Three parts are built in parallel against this document: **A** the app backend, **B** the dashboard and
**C** the worker plus Remotion. Each part owns only its own files and reports any deviation back. The
background is in `docs/MONTEUR_PLAN.md`. This file is the part that binds.

```
Dashboard #/monteur ──session──▶ /api/studio/monteur/*           ◀──worker token── Mac worker (aicourse-captions)
 settings, Choose folder,         Postgres: monteur_sources,                         pick_folder   (native dialog)
 Run now, review queue,           clip_drafts, studio_lessons                        monteur_scan  (list new files)
 lessons                          drain sweep: Monteur + Marketer (Gemini)           monteur_transcribe (whisper.cpp)
                                  Analyst (Gemini, weekly)                           monteur_render (ffmpeg + Remotion
                                  approve → scheduled_posts + campaign                               → Supabase Storage)
```

- **Source statuses:** `transcribing → transcribed → picking → rendering → done`, or `no_clips` or `failed`.
- **Clip statuses:** `rendering → review → scheduled`, or `rejected` or `failed`. A clip being re-rendered goes
  back to `rendering`.

## 1. Settings: a new `monteur` section of `studio_settings`

The section is a JSONB column, merged over the defaults and validated whole, like every other section.

```ts
type MonteurConfig = {
  enabled: boolean;          // default false. Off = no daily run (Run now still works)
  source: 'folder' | 'course';  // default 'folder'. Where a run takes its videos (§7): new files in `folder`,
                             // or the course library's next lessons (`course_lessons`), which needs no folder
  mode: 'review' | 'auto';   // default 'review'. 'auto': the drain approves each rendered reel itself, through
                             // Approve (§6, "Auto mode"); a refused one stays in review with the reason
  folder: string | null;     // absolute path on the worker's machine, ≤ 1024 chars; needed only for 'folder'
  run_at: string;            // 'HH:MM' in schedule.timezone, default '07:00'
  videos_per_run: number;    // 1–10, default 1: new videos taken per run, oldest first
  reels_per_video: number;   // 1–5, default 1
  platforms: ('instagram' | 'facebook' | 'tiktok')[];  // ≥ 1, default all three
  post_at: string[];         // 1–4 'HH:MM' posting slots in schedule.timezone, default ['19:00']
  min_seconds: number;       // 10–60, default 20
  max_seconds: number;       // 15–90 and > min_seconds, default 45
};
```

- **Timezone:** `studio_settings.schedule.timezone`. There is one timezone per tenant.
- **Section list:** `STUDIO_SETTINGS_SECTIONS` gains `'monteur'`.
- **Routes:** GET and PUT `/api/studio/settings` carry the section like any other; there is no separate
  settings route.
- **Transcript language:** `voice.language`.
- **A section saved before `source` and `mode` existed** reads as `'folder'` and `'review'`: sections are merged
  over the defaults. A change of `source` (or of `folder`, in folder mode) fails a pending `monteur_scan` of the
  other kind, so the next run is the new one.
- **`mode` is independent of `enabled`:** `enabled` is only the daily run. A Monteur switched off but in auto mode
  still schedules the reels that finish rendering.

## 2. Migration `src/config/migration_v24_monteur.sql`

Idempotent, with RLS on. It is added to `EXPECTED_MIGRATIONS`.

```sql
ALTER TABLE studio_settings ADD COLUMN IF NOT EXISTS monteur JSONB;
ALTER TABLE studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_kind_check;
ALTER TABLE studio_jobs ADD CONSTRAINT studio_jobs_kind_check CHECK (kind IN
  ('scan_library','index_lesson','render_carousel','pick_folder','monteur_scan','monteur_transcribe','monteur_render'));

monteur_sources (
  id uuid PK default gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  content_key text NOT NULL,        -- from the worker (§3)
  path text NOT NULL, name text NOT NULL,
  size_bytes bigint, duration numeric,
  status text NOT NULL DEFAULT 'transcribing'
    CHECK (status IN ('transcribing','transcribed','picking','rendering','done','no_clips','failed')),
  words jsonb,                      -- [[t0, t1, "word"], ...] seconds, 2 decimals. Never sent to the dashboard
  pick jsonb,                       -- { model, tokens_in, tokens_out, considered } for the record
  attempts int NOT NULL DEFAULT 0,  -- pick attempts; 3 → failed
  claimed_at timestamptz,           -- the pick sweep's claim
  error text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (creator_id, content_key)
)
clip_drafts (
  id uuid PK default gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES monteur_sources(id) ON DELETE CASCADE,
  rank int NOT NULL,                -- 1 = the Monteur's best
  status text NOT NULL CHECK (status IN ('rendering','review','scheduled','rejected','failed')),
  start_s numeric NOT NULL, end_s numeric NOT NULL,
  title text NOT NULL,              -- the on-screen hook, ≤ 60 chars
  hook text NOT NULL,               -- the spoken opening line, from the transcript
  why text, score numeric,
  copy jsonb NOT NULL,              -- ClipCopy (§5)
  render jsonb,                     -- { video_url, cover_url, duration, job_id, rendered_at }
  schedule jsonb,                   -- { scheduled_time, meta_row_id, tiktok_row_id, campaign_id }
  error text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
)
studio_lessons (
  id uuid PK default gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running','done','failed')),
  lessons jsonb,                    -- [{ rule, evidence }], ≤ 10
  summary text,
  basis jsonb,                      -- { posts, from, to, post_ids }
  model text, error text,
  created_at timestamptz DEFAULT now()
)
```

**v27** (`migration_v27_monteur_edits.sql`) adds `clip_drafts.edits jsonb NOT NULL DEFAULT '[]'`: the Editor's
edits (§6.2), written once by the sweep and sent with every render of the clip. Migrate before deploying.

**Media references.** The media in `render` for a clip that is `rendering`, `review` or `scheduled` counts as
referenced. Both the retention sweep (`src/services/retention.ts`) and `deleteUnreferencedUploads` must treat
it that way. A rejected or failed clip's media is not referenced.

## 3. Worker jobs (payload → result)

Every job uses the existing studio_jobs flow: claim, progress as the heartbeat, complete or fail.

**`pick_folder`** `{ prompt: string }` → `{ folder: string }` or `{ cancelled: true }`
- The worker shows the native folder dialog, brought to the front:
  - macOS: `osascript` with `choose folder`
  - Windows: PowerShell `FolderBrowserDialog`
  - Linux: `zenity --file-selection --directory`
- After 5 minutes it gives up and reports `cancelled`.
- The app saves `monteur.folder` through the settings validation.

**`monteur_scan`** `{ folder: string | null, files?: string[], limit, known: string[], extensions: ['.mp4','.mov','.m4v','.mkv','.webm'], min_age_s: 60 }`
→ `{ files: [{ path, name, key, size, mtime, duration }], skipped: [{ name, reason }], missing: boolean }`

Two kinds, one result shape:
- **Folder** (`source: 'folder'`): `folder` is set, and there is no `files`.
- **Course** (`source: 'course'`): `folder` is **null** and `files` lists absolute paths, **in the order to take them**
  (the lesson order). There are up to `limit + 10` of them: the ten past `limit` stand in for any the worker
  skips. The worker then:
  - reads nothing but those paths, one by one in that order, never a folder;
  - skips one that is missing, younger than `min_age_s`, whose `key` is in `known`, or under 10 s, each with its
    reason in `skipped`;
  - reports each file's `path` **exactly as given** in `files` (not resolved or normalised: the app matches on it);
  - stops after the first `limit` new ones.

What the worker does, for a folder scan:
- It reads only the top level of `folder`, skipping names that start with `.` or `~`.
- A file is taken only when it is at least `min_age_s` old, so it isn't still being copied.
- `key` is the sha1 hex of `"<size>:"`, the first MiB and the last MiB.
- Keys in `known` are skipped.
- Files go oldest `mtime` first, at most `limit` of them.
- `duration` comes from ffprobe. A file under 10 s is skipped with a reason.
- `missing` is true when the folder doesn't exist.

What the app does on apply:
- For a course scan, keeps only the files whose `path` is one of `files`, in that order, then at most `limit`. Any
  other file is skipped as "not one of the lessons asked for".
- Inserts `monteur_sources` with `ON CONFLICT DO NOTHING`.
- Enqueues one `monteur_transcribe` for each inserted row.
- Stores `{ added, skipped, missing }` as the job's result.

**`monteur_transcribe`** `{ sourceId, path, language: 'ar' | 'en' }` → `{ duration, words: [[t0, t1, text], ...] }`

What the worker does:
- Transcribes with whisper.cpp through `@remotion/install-whisper-cpp`, using `whisper-models/ggml-medium-q5_0.bin`
  with DTW word timing (as in `scripts/pro/transcribe.mjs`).
- Extracts the audio with ffmpeg first, to a 16 kHz mono WAV in a temp dir that is removed afterwards.
- Times are in seconds, 2 decimals. Text keeps its punctuation, with empty tokens dropped. At most 40 000 words.

What the app does on apply:
- Stores `words` and `duration`, and sets the status to `transcribed`. The drain sweep (§6) takes it from there.

**`monteur_render`**
`{ clipId, sourceId, path, start, end, title, words: [[t0,t1,text]], cta: { line1, line2 }, cta_tiktok: { line1, line2 } | null, brand: { accent, font, direction }, cover_at, edits: ClipEdit[] }`
→ `{ video_url, tiktok_video_url: string | null, cover_url, duration, width: 1080, height: 1920 }`

`cta_tiktok` makes a second MP4 from the same cut, identical except for the CTA text (e.g. «الرابط في البايو»),
because TikTok can't auto-DM, so its copy must not say "comment X". It's null when TikTok is off.
`cta.line1` = `cta.slide.igAsk` + «keyword»; `cta.line2` = `cta.slide.igSub`.

The payload:
- `words` are relative to the clip (0 = `start`).
- `edits` are the Editor's pro edits (§6.2), `t` in seconds relative to the clip, sorted by `t`. Each is
  `{ t, kind, text?, emoji?, query?, sfx? }`:
  - `keyword`: `text`, 2–4 words restating the point. `tool`: `text`, a tool's name in Latin script.
  - `emoji`: `emoji`, one emoji; the worker draws it as a Fluent Emoji picture.
  - `image`: `query`, 2–4 English words (letters, digits and spaces, ≤ 40 characters) naming one concrete object or
    scene. The worker takes the picture from a **free photo library** by that query. Never generated.
  - `punch`: no field; a quick zoom-in.
  - `sfx`, when present: `whoosh | whip | ding | click | switch`. Absent means no sound.
  - `[]` renders the reel without edits. Spacing and the per-kind limits are the renderer's (`cleanEdits`).
- `font` is one of `Cairo | Tajawal | IBM Plex Sans Arabic | Inter`.
- `cover_at` is in seconds, relative to the clip, default 0.5.

The composition is `MonteurClip`, 1080×1920 at 30 fps, and its duration is `end − start`:
- **Framing:** a landscape source is fitted to the width over a blurred, darkened fill of itself. A portrait
  source is cover-cropped to full bleed.
- **Title (the hook):** at the top, **visible from frame 0** (no fade from black). Instagram's grid thumbnail
  is frame 0.
- **Word captions:** in the lower third, in the style of `src/pro/WordCaptions.tsx`.
- **CTA:** a **lower-third overlay** for the last 2.5 s, from `cta.line1` and `cta.line2` (a full-screen card would
  cover the payoff). The video stays visible, and the word captions move up above the band.

The output:
- **Audio:** the source's own voice, normalised in two passes to -16 LUFS / -1.5 dBTP, as in
  `render-carousel-reels.mjs`.
- **Video:** H.264 yuv420p, AAC 48 kHz, faststart, at most 60 MB.
- **Cover:** a JPEG of the frame at `cover_at`.
- **Upload:** both files through §4.

What the app does on apply:
- Sets the clip to `review` and fills `render`.
- When the source has no `rendering` clip left, sets the source to `done`.

**A failed job** marks its row `failed` with the error: the source for scan and transcribe, the clip for
render. A failed `pick_folder` is only a failed job.

## 4. Worker API additions (`studioWorkerRouter`, worker token)

**`POST /api/studio/worker/uploads/sign`** `{ filename, mime_type: 'video/mp4' | 'image/jpeg', size_bytes }`
→ `{ id, url, upload: { method: 'PUT', url, headers } }`

The app:
- Creates the `media_uploads` row: metadata only, `storage_path` set by `objectPathFor`, `size_bytes`.
- Asks Supabase Storage to sign an upload (`POST /storage/v1/object/upload/sign/media/<path>`, valid 2 h).
- Returns `url` as the public `/api/uploads/<id>` URL built on `app.public_base_url`.

The limits:
- **409** when the media store isn't Supabase Storage.
- **400** above 100 MB, or for any other mime type.

The worker PUTs the bytes to `upload.url` with `upload.headers`, then reports `url` in its job result. The app
accepts only upload URLs of its own tenant.

**The daily run.** `enqueueDueMonteurScan(creatorId, now)` runs at the top of `POST /worker/claim` (§7).

## 5. Operator API (session auth, `canOperate`, tenant-scoped)

| Method & path | Body | Response |
|---|---|---|
| GET `/api/studio/monteur` | | `MonteurView` |
| POST `/api/studio/monteur/run` | | `{ job }`: enqueues `monteur_scan` now, or returns the open one. **409** in folder mode with no folder, or in course mode with no lesson left |
| POST `/api/studio/monteur/pick-folder` | | `{ job }`: enqueues `pick_folder`, or returns the open one |
| POST `/api/studio/monteur/sources/:id/retry` | | `SourceView` (below) |
| PATCH `/api/studio/monteur/clips/:id` | `{ title?, copy?: Partial<ClipCopy> }` | `ClipView` (below) |
| POST `/api/studio/monteur/clips/:id/approve` | `{ scheduled_time?: ISO }` | `{ clip: ClipView, scheduled_time, campaign: { id, keyword, trigger_keyword, created } \| null }` (below) |
| POST `/api/studio/monteur/clips/:id/reject` | | `ClipView` |
| POST `/api/studio/monteur/lessons/refresh` | | `LessonsView`: runs the Analyst now |

**Retry** a failed source:
- No words yet: transcribe again.
- Words present: set it back to `transcribed` with `attempts = 0`.

**PATCH:** a change to `title` or `copy.keyword` changes the burned-in video, so it re-queues the render (the
clip goes back to `rendering`). A caption-only change doesn't.

**Approve:**
- The slot is `scheduled_time`, or else the first free slot from `nextFreeSlots(creatorId, { timezone, slots:
  post_at }, 1)`.
- Instagram and Facebook get one Meta row: `both`, `instagram` or `facebook` per `platforms`, `post_type
  'video'`, with `media_url`, `cover_url` and `caption`.
- When `tiktok` is on, a TikTok sibling shares its `group_id`, uses `tiktok_caption`, and gets the same
  Direct Post options the Studio uses.
- Whenever there is a Meta row, a campaign for every post must answer the keyword: an active one that
  already does is reused, otherwise one is created in `word` mode with the keyword, `variants` and `dm`.
  `keyword_create` is informational (the Marketer's guess that one will be created). `campaign` in the
  response says which happened; it is null when no Meta platform is on. A trigger that would really
  collide with a live campaign (by match mode) is a 409.
- Model all of this on `scheduleDraft` in `src/services/studio/schedule.ts`.
- **409** unless the clip is in `review`.
- **Auto mode** (§6) calls this same function with no `scheduled_time`, so an automatic reel gets exactly what the
  button would give it.

```ts
type MonteurView = {
  settings: MonteurConfig; timezone: string;
  next_run: string | null;                       // ISO; null when off, or in folder mode with no folder
  last_scan: { at: string; added: number; skipped: number; missing: boolean } | null;
  worker: { online: boolean; lastSeen: string | null; name: string | null };
  pending: { scan: boolean; folder_pick: boolean };
  next_slot: string | null;                      // what Approve would take now
  sources: SourceView[];                         // latest 30
  clips: ClipView[];                             // review, rendering, failed, scheduled; latest 60
  lessons: LessonsView | null;
};
type SourceView = { id; name; path; duration; status; error; clips: number; created_at; updated_at };
type ClipCopy = {
  caption: string;           // Instagram + Facebook, ready to post: hook line, body, askLine(keyword), hashtags
  tiktok_caption: string;    // ready to post: hook line, body, tiktokLine, hashtags
  hashtags: string[];        // 3–5, without '#', already inside both captions
  keyword: string;           // the comment keyword on the CTA card
  variants: string[];        // other spellings that trigger the same DM
  keyword_create: boolean;   // informational: true = no active campaign answered the keyword when written
  dm: string;                // the full DM, from the tenant's template (buildDm)
  alt_text: string;
};
type ClipView = {
  id; source_id; source_name; rank; status; start; end; duration; title; hook; why; score;
  copy: ClipCopy; edits: ClipEdit[];             // the Editor's edits (§6.2); [] for none
  video_url: string | null; cover_url: string | null;
  scheduled_time: string | null;
  error: string | null;                          // failed: the render's error. review: why auto mode's last
                                                 // approve was refused (cleared by any edit, or by the approve)
  created_at;
};
type LessonsView = {
  lessons: { rule: string; evidence: string }[]; summary: string | null;
  basis: { posts: number; from: string | null; to: string | null };
  created_at: string; model: string | null; status: 'running' | 'done' | 'failed'; error: string | null;
};
```

## 6. The pick sweep: `sweepMonteur()` in `GET /api/jobs/drain`

The sweep is independent of the queue drain: its failure never fails the drain's response. Each call takes at
most **one** source: one that is `transcribed`, or `picking` with `claimed_at` more than 10 minutes old. It
claims the source atomically (`FOR UPDATE SKIP LOCKED`). A source that reaches 3 attempts becomes `failed`.

**Auto mode**, first in every sweep (no model call, so it runs even with no time left for a pick):
- It takes reels in `review` with a render, of active tenants with `mode: 'auto'`: never-refused ones first, then
  oldest first, **at most 4** a drain call. Each is tried once a call.
- Each goes through `approveClip` (§5), with no `scheduled_time`: the next free slot, the per-tenant publishing
  lock, the campaign.
- A refusal (a 409: no free slot, a keyword that would really collide, TikTok not ready, …) leaves the reel in
  review with the reason in `clip_drafts.error`. It is logged as `monteur.auto_refused` (warn the first time, info
  while the reason repeats) and tried again on the next drain. An approval is logged as `monteur.auto_approved`.
- The drain's `monteur` gains `auto: { approved, refused, error? }`. `error` means the step itself failed; the pick
  still runs.

### 1. Monteur (one Gemini call)
The call goes through `callGemini`, the `STUDIO_MODELS` chain and a `responseSchema`, with one repair round.

**What goes in:** the transcript as numbered lines, `L<n> [mm:ss.s] text`:
- Words are grouped into lines, breaking at sentence punctuation, at a pause of 0.6 s or more, or after 12 s.
- Also sent: `reels_per_video`, `min_seconds`/`max_seconds`, the language, the latest lessons and the voice's
  `avoid` terms.

**What comes out:** `{ clips: [{ start_line, end_line, title, why, score }] }`, where the line numbers are
integers and `score` is 0–10. Line numbers are used rather than times because times drift (see
`gemini.mjs`'s comment).

**The rubric:**
- A hook in the first 3 seconds counts triple.
- It stands alone.
- One idea with a payoff.
- Surprise or emotion.
- Never start on a greeting.
- `title` is at most 6 words and may restate the payoff sharper than the speech.

**Code, not the prompt:**
- `start` = the first word's t0 − 0.15. `end` = the last word's t1 + 0.3.
- Drop a clip outside `[min_seconds, max_seconds]`.
- Drop overlaps, keeping the higher score.
- Keep the top `reels_per_video` with a score of at least 5.
- `hook` = the text of `start_line`.
- No clips left → the source becomes `no_clips`.

### 2. Marketer (one Gemini call for all the clips)
**What comes out, per clip:** `{ first_line, body, tiktok_body, hashtags, keyword_candidates, variants, question,
pitch, alt_text }`.

**Normalised into `ClipCopy`** with the existing helpers:
- `chooseKeyword` against `buildGenContext(...).activeKeywords`
- `askLine`, `tiktokLine`, `buildDm`
- `normalizeInstagramCaption` and `normalizeTiktokCaption`
- `toArabicDigits` when the digits are arabic-indic

**Its context:** the voice guide and `avoid` terms, the product name and facts, the latest lessons, and the
clip's lines.

### 3. Editor (one Gemini call for all the clips)
See §6.2. It never holds a reel back.

### 4. Hand-off
- Insert the `clip_drafts` rows (`rendering`), each with its `edits`.
- Enqueue one `monteur_render` each. `cta` is built from the settings:
  - `line1` = the ask with the keyword
  - `line2` = `cta.slide.igSub`
- Pick the accent with `pickAccent`.
- The source becomes `rendering`.
- Log `monteur.pick`, `monteur.copy` and `monteur.edit` with each call's tokens in and out.
- Each render's payload carries the clip's `edits`.

## 6.1 Prompt rules from the research review (they override §6 wherever the two differ)

### Monteur
**Schema:** `{ topic, clips: [{ start_line, end_line, title, hook_type, why, scores: { hook, alone, payoff, send } }] }`.
- Set `propertyOrdering` explicitly, so `why` comes before `scores`.
- Ask for up to `reels_per_video + 2` candidates, best first.

**Prompt:**
- **topic** first: the main idea, in one line.
- **hook** 0–3:
  - 3: the first sentence states the result, number, mistake or contrast.
  - 2: the first line has it, after a lead-in.
  - 1: it comes in line 2.
  - 0: later or never.
- **alone:**
  - The start needs nothing said before it: no greeting, no intro, no «زي ما قلت / وبعدين / فـ».
  - The end leaves nothing hanging.
- **payoff:** the answer or demonstration that proves the claim.
  - The claim is the result promised. Start on it.
  - `end_line` is where the payoff is complete.
- **send:** worth sending to a colleague: a tool, a prompt, a step, a number or a surprise.
  - Motivation alone scores 0.
- **NEVER** a clip where the speaker asks for comments, or one that repeats another clip's idea.
- **START:** of the idea's first 3 lines, take the one that states the claim.
- **LENGTH:** the shortest span that holds the whole payoff, within min–max seconds. Never pad.
- **TITLE:** at most 6 words, on screen from frame 0, read with the sound off.
  - The concrete topic plus the result, problem or mistake, not the method.
  - Not the first spoken sentence.
  - Tech terms in Latin script, and no hype words.
- **hook_type** (of the spoken start line): promise, problem, intent or question.
- **why:** at most 10 words: what the viewer gets.
- **Invent nothing:** use only numbers, tools and results the clip actually says.
- **Examples:** the first lines of the tenant's 2 most-viewed posts in the last 90 days, taken from `post_insights`.

**Code:**
- **Rank:** `rank = 3·hook + alone + payoff + send`.
  - Drop `hook ≤ 1` and `alone ≤ 1`.
  - Keep `rank ≥ 9`.
  - The displayed `score` is `round(rank / 1.8)`.
- **Order:** snap, then the opening guard, then length, then dedupe.
- **Snap:** only the edges made by the 12 s forced line break.
  - Move to the nearest punctuation or 0.3 s pause within 2 s.
  - If there is none, drop the clip.
- **Opening guard (Arabic):** reject a clip whose first 1–3 normalised tokens are one of وبعدين، فبعدين، عشان كذا، زي
  ما قلت، يعني، بس, or ف followed by لما, اذا or هذا.
- **Dedupe:** drop a clip whose text overlaps 0.6 or more with a clip that is rendering, in review or scheduled, or
  one made in the last 90 days.
- **Stored on `clip_drafts`,** as part of v24, which isn't deployed yet: `topic`, `hook_type` and `scores jsonb`.

### Marketer
**Per clip:** `{ first_line, body, ask_line, tiktok_body, hashtags, keyword_candidates, variants, question, pitch,
alt_text }`.
- **first_line:** at most 60 characters: the result or problem, naming the topic once, the way people search it.
  - One language.
  - Not the title.
  - No hype, no ask.
- **body:** 1–3 short lines: the takeaway worth forwarding. Never "share this".
- **ask_line:** a question, then «{keyword}».
  - It fits any of the candidates.
  - The prompt lists the tenant's last 5 asks as "don't reuse".
- **keyword_candidates:** one Arabic word each, 4+ letters, tied to what the DM sends.
- **hashtags:** 3–5 topic tags, mostly Arabic.
- **tiktok_body:** one descriptive sentence with the topic words, and no ask.
- **alt_text:** neutral MSA, at most 2 sentences: «متحدث يشرح …» plus what the transcript says. No hashtags, no ask.
- **Invent nothing:** only numbers, tools and results the clip says.

**Code:**
- **Instagram/Facebook:** first_line, body, then the filled ask_line, then hashtags.
- **TikTok:** first_line, tiktok_body, `tiktokLine`, hashtags.
- **One ask per post:** Monteur clips get no save line.
- **ask_line:** placed exactly as written, and any other ask is stripped.
  - Reject it if it has no `{keyword}`, or overlaps 0.6 or more with the last 5 asks.
  - A rejected ask falls back to a built-in rotating pool of question-style asks. Never fall back to `cta.instagramAsk`.
- **Hashtag blocklist:** #اكسبلور #explore #fyp #foryou.
  - At most 5.
  - At least 1 Arabic tag when the language is `ar`.
- **Keywords:** reject any under 4 letters. Campaigns use `match_mode = 'word'`.
- **Approve:**
  - Never two clips from the same source on the same day.
  - The TikTok sibling uses `render.tiktok_video_url`.
- **Render payload:** `cta_tiktok` = `slide.ttPill` / `slide.ttSub`, but only when TikTok is on.

### Deferred
A separate Facebook first line, the Facebook no-keyword test, Trial Reels, speech-rate stats, and deduping the
Analyst's input by media.

## 6.2 The Editor: `src/services/monteur/editor.ts`

The pro edits on each reel, asked for by the owner: images and edits tied to the topic, with sounds.

**One Gemini call** for all of a video's clips, after the Marketer, for the clips that got copy. `writeEdits` goes
through `ask()` like the Marketer (`EDITOR_SCHEMA`, `maxOutputTokens` 8192, thinking 1024, a 90 s cap inside the
sweep's deadline) and is logged as `monteur.edit` with its tokens. The call is recorded on the source's `pick` as
`edit: { model, tokens_in, tokens_out, error? }`.

**What goes in** (`editorUserPrompt(clipLines(...))`): `C<n>` for each clip in order, then its own lines numbered
from `L1`, each `[mm:ss.s]` on the clip's clock.

**What comes out:** `{ clips: [{ clip, edits: [{ line, word, kind, text?, emoji?, query?, sfx }] }] }`, 6–10 edits a
clip in the prompt's words. The prompt's image line: "image: at most 2 per clip, for a real-world thing the speaker
mentions or compares to. query: 2-4 English words naming one concrete object or scene a free photo library has
(e.g. world map, recipe book)."

**Code, not the prompt** (`editsByClip`, `placeEdits`):
- Answers are matched to clips by `C<n>`, never by position.
- An edit lands on the start of its `word` in its line, else on the line's start, on the clip's clock.
- Dropped: an unknown kind, a missing line, a keyword or tool without `text`, an emoji without `emoji`, an image
  without a usable `query`, a third image.
- `query` keeps Latin letters, digits and single spaces, whole words up to 40 characters.
- At most 12 edits a clip, sorted by `t`. `sfx: 'none'` is sent as no `sfx`.

**A failed call never holds a reel back:** any failure, of the call or of its answer, stores and renders every clip
with `edits: []`, and is logged as `monteur.edit_failed`. The attempt does not fail.

**Stored** in `clip_drafts.edits` (v27) and sent in every `monteur_render` of the clip: the first, `POST /rerender`,
and a PATCH that re-renders. `ClipView.edits` carries them to the page.

## 7. The daily run

`enqueueDueMonteurScan(creatorId, now)` runs at the top of `POST /worker/claim`. It enqueues
`monteur_scan { folder, limit: videos_per_run, known: <every content_key of the tenant>, … }` (or, in course mode,
`{ folder: null, files, … }`, below) only when all of these hold:
- `enabled` is on, and — in folder mode — `folder` is set.
- The latest `run_at` instant at or before `now` in the timezone (today's, or yesterday's if today's hasn't come
  yet) has no `monteur_scan` created at or after it that finished for the source set now: a course scan in course
  mode, a scan of this folder in folder mode. A failed or cancelled scan does not count.

**Course mode** (`source: 'course'`): the videos are the Studio library's lessons (`course_lessons`) whose
`video_path` has no `monteur_sources` row for the tenant, in natural `lesson_no` order ("1.2" before "1.10", both
before "G.1"). `files` is the first `videos_per_run + 10` of them and `limit` is `videos_per_run`, so the run takes
the next `videos_per_run` new ones. With no lesson left nothing is queued, and Run now answers 409.

This gives three behaviours:
- A Mac asleep at 07:00 scans the next time it polls.
- An offline worker never piles up scans: at most one a day.
- A Run now after 07:00 counts as today's run.

`next_run` is the next `run_at` instant after `now`.

## 8. The Analyst: `src/services/monteur/analyst.ts`

**When it runs:**
- From `sweepMonteur()`, when there is no `done` row from the last 7 days, no row at all from the last 6 hours
  (so a failure can't hammer Gemini) and at least 5 reels or videos with insights.
- On `POST /lessons/refresh`.

**The row:** it inserts a `running` row first, then updates it to `done` or `failed`.

**What goes in:**
- The last 20 reels or videos from `post_insights`: first caption line, posted_at, views, reach, skip_rate,
  the non-follower share, likes, comments, shares and saves.
- The current lessons.

**What comes out:** `{ lessons: [{ rule ≤ 140 chars, evidence ≤ 100 chars }] ≤ 10, summary ≤ 280 chars }`, in the
tenant's language.

The latest `done` row feeds both prompts in §6.

## 9. Who owns what

**A: app, in a worktree of this repo.**
- The migration and `src/config/migrations.ts`
- `src/services/monteur/*` (new) and `src/services/studio/{settings,settingsTypes,jobs}.ts`
- `src/routes/studio.ts`; the drain hook in `src/routes/api.ts`
- `src/services/retention.ts`
- `src/services/supabaseStorage.ts` for signing
- Tests next to each file

**B: dashboard, in a worktree of this repo.**
- `dashboard/js/pages/monteur.js` (new), mounted at `#/monteur`: a "Monteur" tab in the Studio tab bar plus a
  sidebar entry
- `dashboard/js/{app,i18n,help-content}.js` and `dashboard/css/*`
- `dashboard/index.html`: cache version **8.1** in both places (CLAUDE.md)
- `src/dashboard/*.test.ts`

What the page has:
- **Settings card:** on/off, the folder with **Choose folder** and a path field, run at, videos per run, reels
  per video, platforms, post at, and min/max seconds.
- **Run now**, plus next run, last run and the worker's status. With the worker offline it says the job waits.
- **Sources list**, with status chips and Retry.
- **Review queue:**
  - `<video>` with the cover as its poster
  - title, hook, why and score
  - editable captions and keyword
  - **Approve**, showing `next_slot` and letting you change the time, and **Reject**
- **Lessons card**, with "Refresh now".
- **English and Arabic.** Every string goes through i18n, and the layout stays RTL-safe.

**C: worker, in `~/Desktop/AI Course/aicourse-captions`, on branch `feat/monteur` in a git worktree.**
- `scripts/monteur/*.mjs` (new) and their tests
- the HANDLERS in `scripts/studio-worker.mjs`, and `scripts/studio/app.mjs` for the sign call
- `src/monteur/MonteurClip.tsx` (new) and its registration in `src/Root.tsx`
- Temp files under `os.tmpdir()/monteur/<jobId>`, removed afterwards

The live launchd worker runs from the main checkout and must not change until the merge.

## 10. Not in v1
- A TikTok-only render (TikTok gets the same video; its caption carries «رابطه في البايو»).
- The cold open and face tracking.
- YouTube.
- Several workers per tenant with different folders. One worker per tenant is assumed, as for the library.
