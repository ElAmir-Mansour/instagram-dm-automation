# Carousel Studio: the complete guide

The Carousel Studio turns your course videos into branded carousels for Instagram, Facebook and
TikTok. This guide explains all of it: what each part does, why it is built that way, every
setting, what it costs, and what to do when something goes wrong.

It is written for two readers:

- **The creator**, who uses the Studio. Every section opens in plain words.
- **The operator**, who keeps it running. The parts marked **Operator** carry exact names,
  numbers, file paths and commands.

Button and label names are given as they appear on screen, in English and Arabic, for example
**Scan library** (فحص المكتبة).

**Sources of truth.** The contract is [`STUDIO.md`](../STUDIO.md) (§10 covers the per-account
settings). The behaviour is the code: `src/routes/studio.ts`, `src/services/studio/*.ts`,
`src/config/migration_v21_studio.sql`, `dashboard/js/pages/studio.js`, and the worker in its own
repo on the Mac at `~/Desktop/AI Course/aicourse-captions/` (`scripts/studio-worker.mjs`,
`scripts/studio/*.mjs`). Where STUDIO.md and the code disagree, this guide follows the code and
says so. Checked against `main` at `60f2cae` on 2026-09-25, with the numbers from the first live
rollout on 2026-09-24.

---

## Contents

1. [What the Studio is](#1-what-the-studio-is)
2. [How it works](#2-how-it-works)
3. [What is a worker?](#3-what-is-a-worker)
4. [The library](#4-the-library)
5. [Drafts](#5-drafts)
6. [Scheduling](#6-scheduling)
7. [The Settings reference](#7-the-settings-reference)
8. [Quotas and costs](#8-quotas-and-costs)
9. [Troubleshooting](#9-troubleshooting)
10. [FAQ](#10-faq)
11. [Where things live](#11-where-things-live)

---

## 1. What the Studio is

A carousel is a post made of several slides that people swipe through. Making a good one by hand
takes an hour or more: pick a lesson, find the right screenshots, write short punchy lines that
fit on each slide, design them, write the captions, and set up the comment automation that sends
people the course link.

The Studio does that work for you, from your own lessons:

- **The words come from what the lesson actually teaches.** Each lesson is watched once by
  Gemini, which writes notes on it (what it teaches, the prompts shown on screen, the tools used,
  the results) and picks the frames worth showing. The carousel is then written only from those
  notes, and the writer is told to invent nothing: no features, numbers or results the lesson
  does not show.
- **The screenshots are real frames from your videos**, taken at full resolution.
- **It sounds like you and looks like you.** Your voice guide, language, colours, fonts and
  signature live in the Studio's Settings, and every carousel follows them.
- **It sets up the automation.** Each carousel asks followers to comment one keyword, and the
  Studio creates the campaign that answers that comment with a DM carrying your link.

You find it in the dashboard under **Studio** (الاستوديو), in two tabs: **Carousels**
(الكاروسيل), where you make them, and **Settings** (الإعدادات), where your brand, voice, product,
posting times, library folder and workers live.

### The three steps

The Carousels tab shows a stepper with exactly one main button per step:

| Step | On screen | What you do | How long |
|---|---|---|---|
| 1 | **Choose a topic** (اختر الموضوع) | Pick **From a lesson** (من درس), up to three indexed lessons, or **From an idea** (من فكرة) and describe it. **More options** (خيارات أكثر) holds the angle, slide count, keyword and accent colour; leave them alone and the AI chooses. | Seconds |
| 2 | **Generate** (أنشئ) | Press **Generate carousel** (أنشئ الكاروسيل). The AI writes the slides, then your Mac draws them. You can leave the page meanwhile. | About a minute to write (the first real one took 54 s), then a few minutes to draw (about 170 s on a slow connection) |
| 3 | **Review & schedule** (راجع وجدوِل) | Look at the preview in **Instagram 4:5** (إنستجرام 4:5) and **TikTok 9:16** (تيك توك 9:16), change anything, press **Save & update preview** (احفظ وحدّث المعاينة), then **Schedule** (جدولة). | As long as you like |

Before the very first carousel there is a one-time setup, shown as a checklist called **Get your
library ready** (جهّز مكتبة الدروس): choose the folder with your lesson videos, connect the worker
on your Mac, then scan and index your lessons. Section 3 explains the worker, and section 4 the
scan and the indexing. You can write **From an idea** straight away, without any of that.

### What one carousel gives you

| Output | What it is | Where it goes |
|---|---|---|
| Instagram and Facebook slides | 6 to 10 slides (8 by default), 1080×1350 JPEGs (4:5). The first is the cover, the last is the call to action | One scheduled post for both platforms |
| TikTok slides | The same slides at 1080×1920 (9:16), laid out for TikTok's safe zones | A TikTok photo post, when you choose TikTok |
| Instagram caption | The hook, the value lines, a swipe line, your save line, your keyword line, 4 to 6 hashtags | With the Instagram and Facebook post |
| TikTok title and description | A title of at most 90 characters, and a description that points to your bio instead of the comments | With the TikTok post |
| Keyword and DM | One word followers comment, and the DM they get back, built from your template | A campaign on the Campaigns page |

---

## 2. How it works

Three machines share the work: your browser, the app on the internet, and a small program on your
Mac called the **worker**. Gemini is used twice, once by the worker to watch lessons and once by
the app to write carousels. Remotion, the tool that draws the slides, runs inside the worker.

```
  ┌─────────────────────────────┐
  │ Dashboard (#/studio)        │   you: pick, generate, edit, schedule
  └──────────────┬──────────────┘
                 │ your login session (HTTPS)
                 ▼
  ┌─────────────────────────────┐   "write this carousel"  ┌───────────────────────────┐
  │ App, on Vercel              │ ───────────────────────▶ │ Gemini: the writer        │
  │ /api/studio/*               │ ◀─────────────────────── │ 3.1 Pro, then 3.x Flash   │
  │ Postgres: lessons, moments, │   slides + captions      └───────────────────────────┘
  │ drafts, jobs, settings,     │
  │ workers, uploads            │ ── Schedule ──▶ scheduled_posts ── publish sweep ──▶ Instagram
  │                             │                                                      Facebook
  │                             │ ── campaign ──▶ campaigns ── keyword comment → DM    TikTok
  └──────────────▲──────────────┘
                 │ claim · progress · complete · fail · upload
                 │ HTTPS with the worker token. The Mac calls out; nothing calls in.
  ┌──────────────┴──────────────┐   a small proxy video    ┌───────────────────────────┐
  │ Worker, on your Mac         │ ───────────────────────▶ │ Gemini: the indexer       │
  │ your course videos          │ ◀─────────────────────── │ Files API, then 3.x Flash │
  │ ffmpeg: proxies, frames     │   notes + moments        └───────────────────────────┘
  │ Remotion: draws the slides  │
  └─────────────────────────────┘
```

### One carousel, start to finish

1. **Scan** (once, and again when you add videos). You press **Scan library** (فحص المكتبة). The
   app puts a *scan* job in its queue. The worker, which keeps asking the app for work, picks it
   up, lists the videos in your library folder, measures each one, and sends the list back. The
   app saves one row per lesson.
2. **Index** (once per lesson). An *index* job: the worker makes a small copy of the lesson (a
   *proxy*), sends it to Gemini, gets back the lesson's notes and its best screenshot moments,
   deletes the copy from Gemini, and uploads a small thumbnail of each moment to the app.
3. **Generate.** You press **Generate carousel** (أنشئ الكاروسيل). This part runs in the app,
   not on your Mac: it sends Gemini the lesson's notes, its moments and your settings, checks
   what comes back against the design's rules, saves the draft, and queues a *render* job. The
   draft now says **Rendering** (يرسم الشرائح).
4. **Render.** The worker takes the render job, cuts each screenshot out of the original video at
   full resolution, draws every slide twice (4:5 for Instagram and Facebook, 9:16 for TikTok),
   and uploads the images to the app. The draft becomes **Ready** (جاهز).
5. **Schedule.** You press **Schedule** (جدولة). The app writes the post and the keyword
   campaign. From here the Studio is done: the ordinary scheduler publishes the post at its time,
   and the ordinary comment automation answers the keyword.

Writing (step 3) needs only the app and Gemini, so it works while your Mac is off. Scanning,
indexing and rendering need the worker, so they wait in the queue until it is back.

### Who does what

| Part | Runs on | Does | Never does |
|---|---|---|---|
| Dashboard | Your browser | Shows the library, the drafts and the editor; sends your choices | Hold anything the server doesn't have, except unsaved edits kept in this browser |
| App | Vercel, with the Postgres database | Stores everything, writes the copy with Gemini, checks every carousel against the rules, queues the worker's jobs, schedules posts and campaigns | Open your video files, or draw slides |
| Worker | Your Mac | Scans the library folder, indexes lessons with Gemini, extracts frames with ffmpeg, draws slides with Remotion | Write copy, schedule, or publish anything |
| Gemini, the writer | Google, called by the app | Writes the carousel as JSON from the notes it is given | See your videos: it gets text only, the notes and a one-line description of each moment |
| Gemini, the indexer | Google, called by the worker | Watches the proxy once and returns notes and moments | Keep the proxy: the worker deletes it after the answer |

### The queue (Operator)

- The worker's jobs live in `studio_jobs` (migration v21). This is **not** the webhook queue
  `jobs` (v13): `/api/jobs/drain` never touches it, and nothing on Vercel runs these jobs.
- Kinds: `scan_library`, `index_lesson`, `render_carousel`. States: `pending → claimed → done`,
  or `failed`.
- **Claim order**: renders first, then scans, then indexing, oldest first within each
  (`CLAIM_SQL`, `src/services/studio/jobs.ts:145`). A render asked for while forty lessons wait
  to be indexed still goes next. It does not interrupt a job already running, so at worst it
  waits for the lesson being indexed at that moment.
- The claim is `FOR UPDATE SKIP LOCKED`, so two workers split the queue instead of taking the
  same job.
- **Heartbeat.** Every progress call from the worker (at least every 20 s during a job) refreshes
  `heartbeat_at`. A claim whose heartbeat is more than **15 minutes** old is handed out again. A
  job that has been claimed **3 times** is failed instead, with *"The worker stopped reporting on
  this job 3 times…"*. That check runs just before each claim.
- **Side effects.** A failed index job marks its lesson failed. A failed render marks its draft
  failed, if it was the draft's latest render and the draft isn't scheduled. A failed **scan**
  marks nothing: it shows only in the job row and in the worker's log (see section 9).
- **Results are checked** before they change anything. A result that doesn't validate is a 400,
  the job stays claimed, and the worker reports it as a failure.
- **Pressing a button twice is safe.** A scan already queued for the same folder is returned
  instead of a second one; the same goes for indexing a lesson already queued. A new render of a
  draft fails the draft's older pending renders as *"Superseded by a newer render of the same
  draft."*, and a render result that arrives for anything but the draft's latest render job is
  dropped and its images deleted.

| Timing | Value | Where |
|---|---|---|
| Worker asks for work | Straight after a job, then every 5 s, 10 s, 20 s, and every 30 s while idle | `POLL_S`, `scripts/studio-worker.mjs:34` |
| Worker heartbeat during a job | At least every 20 s | `HEARTBEAT_MS`, `scripts/studio-worker.mjs:36` |
| "Online" | An authenticated worker call within the last 90 s | `WORKER_ONLINE_WINDOW_MS`, `src/services/studio/worker.ts:21` |
| Dashboard refreshes the status | Every 15 s | `STATUS_REFRESH_MS`, `dashboard/js/pages/studio.js` |
| Editor re-reads a writing or rendering draft | Every 4 s | `RENDER_POLL_MS`, `dashboard/js/pages/studio.js` |
| A claim is presumed dead | No heartbeat for 15 min | `STALE_CLAIM_MINUTES`, `src/services/studio/jobs.ts:29` |

---

## 3. What is a worker?

### In plain words

A **worker** is a small program that runs on the Mac where your course videos are. It is the
Studio's pair of hands on that computer.

Think of the app as an office, and the worker as a colleague who works from home. The office
cannot walk into your home, so the colleague phones in every few seconds and asks: *"Anything for
me?"* When there is, they do the job at home, with the files that are there (read a video, cut out
a frame, draw the slides), and send the result back to the office. When there isn't, they wait a
little and ask again.

That is all it is. It has no screen of its own; you see what it is doing in the Studio's status
bar, where it shows as **Worker online** (العامل متصل) or **Worker offline** (العامل غير متصل).

### Why it exists

Three facts make it necessary:

1. **Your videos live on your computer, and moving them is slow.** On the connection this was
   built on, uploads run at about 20 to 30 KB/s: one 13.5 MB lesson took 7 minutes to upload, and
   the whole course would take hours, every time. The app's hosting also refuses anything over
   4.5 MB in one request. So the videos stay where they are, and the work goes to them.
2. **Drawing slides needs real software and real time.** The slides are rendered by Remotion,
   which drives a headless Chrome, and screenshots are cut with ffmpeg. That takes minutes of a
   computer's time. The app runs on Vercel's short-lived serverless functions, which have neither
   Chrome nor ffmpeg and are not meant to run for minutes.
3. **The website cannot reach your computer.** Your Mac sits behind your home router with no
   public address, and you would not want it to have one. So the worker calls out to the app, and
   nothing ever calls in.

### What it does, and what it doesn't

| Job | Started by | What the worker does | What it sends back |
|---|---|---|---|
| `scan_library` | **Scan library** (فحص المكتبة) | Lists the videos one or two folders below your library folder, reads each one's length with ffprobe, and works out lesson numbers and titles from the names (section 4) | The list of lessons |
| `index_lesson` | **Index this lesson** (فهرس هذا الدرس), **Index missing** (فهرسة الناقص), **Index the rest** (فهرس الباقي) | Makes a small proxy of the lesson, uploads it to Gemini, receives the notes and 12 to 30 moments, deletes the upload, cuts a 480px thumbnail of each moment from the original | The notes, and the moments with their thumbnails |
| `render_carousel` | **Generate carousel**, **Save & update preview**, **Rewrite with AI**, **Render again** | Cuts each screenshot out of the original at full resolution, draws every slide in both sizes with your brand, uploads the images in slide order | The image addresses, Instagram set and TikTok set |

It does **not**:

- write any words: the app writes the copy, and the worker only draws what it is given;
- schedule or publish anything;
- read any file outside the folder named in its config (`courseRoot`), even if the app asks;
- listen for connections: there is no server in it and no port to open;
- upload your full videos anywhere;
- see any other account's jobs;
- need to be on while you write: only scanning, indexing and drawing wait for it.

### Its security model

- **Outbound only.** The worker makes HTTPS requests to the app, to Gemini (for indexing) and to
  Google Fonts (for rendering). Nothing on the Mac listens. You open no port and change nothing
  on your router.
- **One token per worker, and it belongs to one account.** You create a worker in **Settings →
  Workers** (الإعدادات ← العمّال) and get its token once. It looks like `sws_` followed by 43
  characters. The app keeps only its SHA-256 hash, so the token cannot be read back from the
  database, and the token decides the account: every job the worker is given, every image it
  uploads and every result it posts belongs to that account and no other
  (`authenticateWorker`, `src/services/studio/worker.ts:53`).
- **It sees only what its jobs carry.** A scan job carries the folder path. An index job carries
  the lesson's id, path, number and title. A render job carries the carousel, its screenshots'
  video paths and times, and your brand kit, last-slide words and product facts. A worker never
  sees your DMs, your campaigns or your lesson list, nor any setting beyond what a render needs.
- **Revocable at once.** **Revoke** (إلغاء) in Settings → Workers stops the token on its next call:
  the worker gets HTTP 401, *"This worker token is not valid, or it was revoked. Create a new
  worker in Studio settings."* The row stays, as the record of who it was and when it last called.
  Creating and revoking workers needs the account's owner role. Deactivating the account stops all
  its tokens too.
- **Kept in a file only you can read.** The token and the Gemini key live in `studio.config.json`
  in the worker folder. The file is gitignored, the install script sets it to mode 600 (`chmod
  600`: readable by you alone), and the worker logs a warning if anyone else can read it.
- **Fenced into the course folder.** Every path the app names is resolved, symbolic links
  included, and must sit inside `courseRoot`. Anything outside is refused (*"… is outside the
  course root"*), and so is a web address (*"remote sources are not supported yet"*).
- **Your full videos never leave the Mac.** This is everything that does:

  | What leaves the Mac | Where to | How long it stays |
  |---|---|---|
  | A proxy of the lesson being indexed: 640px wide, one frame a second, mono audio. Lesson 4.3 is 13.5 MB; its proxy is 0.6 MB | Gemini's Files API | Deleted by the worker as soon as Gemini has answered. If that delete ever fails, Google removes the file after 48 hours anyway |
  | One 480px thumbnail per moment | The app's media store | Until a re-index replaces the moments; the old thumbnails are then removed by the media retention sweep, if `MEDIA_RETENTION_DAYS` is set |
  | The finished slide images, screenshots included | The app's media store | The current render of each draft. An older render's images are deleted when a new one lands, unless a scheduled post uses them |
  | Lesson titles, file paths and lengths | The app's database | As long as the lesson row exists |

  On the Mac itself, proxies are cached in `.studio/proxies/` (safe to delete at any time), and
  the full-resolution frames cut for a render go to `public/studio-shots/<draftId>/` and are
  deleted when that render ends.
- **Uploaded images are public by address.** Like every upload in this app, thumbnails and slides
  are served at `/api/uploads/<id>` without a login, because Instagram and TikTok have to fetch
  them. The id is a random UUID, so the address cannot be guessed.
- **If a token leaks,** whoever has it could take your queued jobs and read what they carry, post
  fake results (including replacing a draft's slides with their own images, which you would see in
  the preview), and upload images into your account's storage. They could not read your lessons,
  DMs or settings, and could not schedule or publish. Revoke the worker and create a new one.

### Install it

**You need:** a Mac with Node 22 or later, `ffmpeg` and `ffprobe` (`brew install ffmpeg`), the
worker's folder with `npm install` done in it, and an internet connection.

1. **Create the worker in the dashboard.** Studio → **Settings** (الإعدادات) → **Workers**
   (العمّال). Type a name under **New worker** (عامل جديد), for example *Studio Mac*, and press
   **Create worker** (إنشاء عامل). The token appears once, under **Worker token** (رمز العامل).
   Copy it, then press **I've copied it** (نسخته). If you lose it, revoke the worker and create a
   new one: the token cannot be shown again.
2. **Write the config file** on the Mac:

   ```bash
   cd ~/Desktop/"AI Course"/aicourse-captions
   cp studio.config.example.json studio.config.json
   chmod 600 studio.config.json
   open -e studio.config.json          # or any editor
   ```

   | Key | Example | What it is |
   |---|---|---|
   | `appUrl` | `https://msg-response-auto.vercel.app` | The app |
   | `token` | `sws_…` | The token from step 1 |
   | `geminiApiKey` | from Google AI Studio | The Gemini key used for indexing. Scans and renders don't need it |
   | `courseRoot` | `/Users/elamir/Desktop/AI Course` | The only folder the worker will read. The library folder in the Studio's Settings must be inside it |
   | `name` | `Mac Studio` | A label for the worker's own log; defaults to the Mac's host name. The dashboard shows the name you typed in step 1, not this one |
   | `indexConcurrency` | `1` | How many jobs it works on at once, 1 to 4. Despite the name it counts every kind of job. At 2, a render can run while a lesson is being indexed, and one lesson's proxy is made while another uploads. Uploads, proxies and renders each still go one at a time |

   The worker re-reads this file whenever it changes, so a new token is picked up at its next
   poll without a restart. `STUDIO_CONFIG=/path/to/other.json` points a worker at another file.
3. **Try it once in the foreground:**

   ```bash
   node scripts/studio-worker.mjs --drain     # works through the queue, then exits
   ```

   The first lines should read `config loaded: app https://…, name "…", course root …`, and
   within 90 s the dashboard's pill turns **Worker online**. With an empty queue it ends with
   `the queue is empty (--drain)`.
4. **Install it so it starts at login:**

   ```bash
   scripts/install-studio-worker.sh            # install (or reinstall) and start it
   scripts/install-studio-worker.sh --print    # only print the plist it would write
   ```

   This writes the launchd agent `~/Library/LaunchAgents/com.aicourse.studio-worker.plist` and
   starts it. It runs at login (`RunAtLoad`), is restarted if it ever exits (`KeepAlive`, at most
   once every 30 s), and appends everything it says to
   `~/Library/Logs/aicourse-studio-worker.log`. The plist records the absolute path of the `node`
   that was on your `PATH` at install time, with ffmpeg's folder on its `PATH`, so run the install
   script again after switching Node versions or moving the folder. It refuses to install without
   `studio.config.json`, ffmpeg, Node 22 or `npm install`.
5. **Set the library folder** in Studio → Settings → **Library folder** (مجلد المكتبة), inside
   `courseRoot`, and press **Save settings** (حفظ الإعدادات). Then **Scan library**.

### Check it, restart it, stop it, uninstall it

```bash
# Is it running? Look for "state = running" and a pid.
launchctl print gui/$(id -u)/com.aicourse.studio-worker | grep -E 'state|pid'

# What is it doing right now?
tail -f ~/Library/Logs/aicourse-studio-worker.log

# Restart it, e.g. after updating the worker's code.
launchctl kickstart -k gui/$(id -u)/com.aicourse.studio-worker

# Stop it until you start it again. The plist stays in place.
launchctl bootout gui/$(id -u)/com.aicourse.studio-worker
# ...and start it again.
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aicourse.studio-worker.plist

# Remove it completely. The log file is kept.
scripts/uninstall-studio-worker.sh
```

When it is told to stop, it finishes the current job for up to 15 s. A job still running after
that stays claimed, and the app hands it out again once its heartbeat is 15 minutes old. Don't
stop it with `kill`: `KeepAlive` starts it again. Only one worker runs per config file, so a
second copy started by hand exits at once with *"another studio worker is running (pid …)"*.

A healthy index, in the log (abridged: every real line starts with a timestamp, and some steps
are left out; `…` stands for the numbers of the day):

```
index_lesson 1a2b3c4d: claimed
index_lesson 1a2b3c4d: making the proxy for Gemini: 40%
index: 13.5 MB original, 0.6 MB proxy (4%), made in …s
index: uploaded the 0.6 MB proxy in 31.0s (… KB/s)
index_lesson 1a2b3c4d: Gemini is watching the lesson (…)
Gemini gemini-3.5-flash: … tokens in, … out
index: … points, … prompts, … moments (… clean)
index_lesson 1a2b3c4d: done in …s
```

### The online/offline pill, and what happens when the Mac sleeps

The status bar at the top of the Carousels tab shows **Worker online** (العامل متصل) or **Worker
offline** (العامل غير متصل), the worker's name, and **Last seen …** (آخر ظهور …) or **Never
connected** (لم يتصل بعد). It is a measurement, not decoration: *online* means the app heard from
a worker of this account in the last 90 seconds. While jobs wait it also shows *Waiting: n ·
Running: n* (بالانتظار · قيد التنفيذ), with *waiting for the worker* (بانتظار العامل) when the worker
is offline.

When it is offline, the card says what the worker is and how to start it, and offers **Check
again** (تحقّق مرة أخرى) and **Manage workers** (إدارة العمّال). Nothing is lost while it is away:
you can still write carousels, and scans, indexing and drawing wait in the queue.

**When the Mac sleeps,** the worker sleeps with it, because macOS pauses every program. Within
90 seconds the pill turns grey. When the Mac wakes, the worker carries on by itself: its next
call turns the pill green, and it works through whatever queued up, renders first. A job that
was halfway through usually just continues. If its connection broke while asleep (a Gemini upload,
say), the job fails with the reason, and you press its button again.

Three things to know:

- **The worker starts when you log in**, not when the Mac boots: a launchd *agent* lives in your
  user session. After a restart, log in (or turn on automatic login).
- **For a long indexing run, keep the Mac awake.** In System Settings, under Energy (or Battery
  on a laptop), turn on the option that stops automatic sleep while the display is off. Or run
  `caffeinate -i` in a Terminal window for as long as the run takes, and press Ctrl-C when it is
  done.
- **A job whose worker goes silent for 15 minutes is handed out again** the next time a worker
  asks, which with one Mac means when it wakes up. After three such hand-outs the job is failed
  rather than retried forever.

### More than one worker

An account can have several workers, up to 10 at a time: two Macs, say, or later a server. Each
has its own name and token. They share the account's queue: whichever asks first gets the next
job, and two workers never get the same one. The pill shows the one seen most recently, and
Settings → Workers lists each with its last-seen time.

**The catch:** any worker can get any job, so every worker must see the same videos at the same
full path. A scan records each lesson's absolute path on the Mac that scanned it, such as
`/Users/elamir/Desktop/AI Course/Chap 1/…mp4`. A second Mac without that file at that exact path
fails the job with *"video_path not found: …"*. Two Macs therefore need the same folder at the same
path (same user name and layout, or a shared drive mounted at the same place), inside each one's
`courseRoot`.

**One Mac serving two accounts** is one config file per account; start the second worker with
`STUDIO_CONFIG=/path/to/second.json node scripts/studio-worker.mjs`. The one-copy lock is per
config file, so the two don't block each other. The install script manages a single launchd
agent, `com.aicourse.studio-worker`, so a second one has to be run by hand or given its own plist
under a different label.

### A hosted worker, later

Today the worker needs a Mac that is switched on. The design already allows one that lives on a
server instead: the app does not care where a worker runs, only that its token is valid, and a
server would simply be one more worker of the account. What is missing is where the videos live.
A server cannot read your Mac, so the videos would have to be in cloud storage, and each lesson's
path would become a web address, which today's worker refuses (*"remote sources are not supported
yet"*). The server would also need Chrome, ffmpeg and a few minutes per render, so it would be a
small always-on machine, not a Vercel function. Until someone builds that, a hosted worker is a
plan, not a feature.

---

## 4. The library

The library is your course as the Studio knows it: one row per lesson video, and for each indexed
lesson its notes and its screenshot moments.

### Scanning

Scanning is how the Studio finds your lessons. You tell it which folder holds the course, in
Settings → **Library folder** (مجلد المكتبة). **Scan library** (فحص المكتبة) then asks the worker
to look inside that folder: it finds each video, reads its length, and works out its lesson
number and title from the folder and file names. The lessons appear in the lesson picker marked
**Not indexed yet** (غير مفهرس بعد).

A scan never deletes anything. Scan again whenever you add videos: new ones are added, and the
ones already there keep their notes. A video you rename or move becomes a *new* lesson; the old
row stays, with its notes, pointing at a file that no longer exists.

The first real scan, on 2026-09-24, found **34 lessons among 35 videos**.

### How file names become lesson numbers (Operator)

The rules are in `scripts/studio/library.mjs` (`parseLibrary`), tested against the real course's
file names in `library.test.mjs`:

| On disk, under the library folder | Becomes |
|---|---|
| `Chap 1/aiCourse-context pyramid . 1.2.mp4` | Lesson **1.2** in section 1: the last `N.M` in the file name |
| `Chap 1/aiCourse-Intr chapter 1.mp4` | Lesson **1.0**: no number, in a numbered section, so the section's intro |
| `Chapter 5 Ai studio /Video editing - 5.4/…mp4` | Lesson **5.4**: a lesson folder. Its numbered videos are lessons by their own numbers; of the rest, the longest is lesson 5.4 and the others are things made in it |
| `Gemini apps/Gemini spark.mp4` | **G.1**, G.2, …: a section with no number is lettered by its first letter |
| `Introduction recording and notes/*.mp4` | **I.1**, I.2, …: a section whose name starts with *Intro* |

- Only `.mp4`, `.mov` and `.m4v`, exactly one or two folders below the library folder. A video
  loose in the library folder itself, or nested deeper, is not a lesson.
- Skipped: anything hidden (a name starting with `.`), `marketing/`, `out/`, `node_modules/`, and
  the worker's own project folder.
- A folder inside a section with no `N.M` in its name is an assets folder, not a lesson.
- A section's number is the first whole number in its folder name (*Chap 1*, *Module 3 - Basics*).
  A lesson number has one or two digits on each side of the dot and is never part of a longer
  number such as `1.2.3` or `2026.09`.
- Titles drop a prefix most file names share (such as `aiCourse-`, when at least three files and
  half of them start with it) and the number, and keep the words before the number:
  `aiCourse-SKITCH to ap - 3.2-` becomes *SKITCH to ap*. A `:` in a name, which is how macOS stores
  a `/` typed in Finder, shows as `/`.
- Lessons sort naturally: 1.2 before 1.10, and numbers before the lettered sections.
- On the app's side a scan result is upserted by the video's path and never deletes
  (`applyScan`, `src/services/studio/jobs.ts:342`). An entry that doesn't validate is skipped and
  listed in the job's `result.skipped` instead of failing the whole scan. The scan payload's folder
  is the Settings value `library.root`; the worker refuses one outside its `courseRoot`.

### Indexing

Indexing is Gemini watching one lesson, once, so the Studio knows what is in it. It produces:

- **Notes:** a two-to-four-sentence summary; the 3 to 10 things the lesson teaches, in order, each
  with the moment it is made; every prompt typed or shown on screen, copied word for word; the
  tools used; and the demos, each with the result the video shows.
- **Moments:** 12 to 30 frames worth putting on a slide, spread through the lesson, each with its
  time, a one-line description, a kind, and a *clean* flag.

Only indexed lessons can be picked for a carousel (*"Only indexed lessons can be picked: a
carousel is written from a lesson's notes and screenshots."*), because the notes are all the writer
is allowed to say.

The buttons:

- **Index this lesson** (فهرس هذا الدرس), in a lesson's details, for a lesson that isn't indexed;
- **Index missing** (فهرسة الناقص) in the status bar, **Index the rest (n)** (فهرس الباقي) in the lesson
  picker, and **Index the lessons (n)** (فهرس الدروس) in the setup checklist, which all queue every
  lesson that is neither indexed nor already queued, failed ones included.

A lesson goes **Not indexed yet** (غير مفهرس بعد) → **Indexing…** (قيد الفهرسة…) → **Indexed**
(مفهرس), or **Indexing failed** (فشلت الفهرسة), with the reason shown in its details.

### Inside an index job (Operator)

1. `ffprobe` reads the lesson's length.
2. **The proxy.** ffmpeg makes a copy at one frame a second, 640 px wide, H.264 at CRF 34, with
   mono 32 kbps audio (`PROXY_ARGS`, `scripts/studio/proxy.mjs:21`). Gemini samples video at one
   frame a second anyway, so it loses nothing it would have used, and `fps=1` picks frames
   without retiming them: a moment Gemini finds at 1:35 in the proxy is at 1:35 in the original.
   A proxy whose length differs from the original's by more than 1.5 s is refused. Proxies are
   cached in `.studio/proxies/` by path and modification time, so indexing a lesson again skips
   this step. The reason for all of it is the uplink: lesson 4.3 is 13.5 MB and its proxy 0.6 MB,
   which took its upload from 7 minutes to 31 seconds.
3. **The upload** goes through Gemini's resumable Files API in 8 MB chunks. A chunk only fails
   after two minutes of complete silence (slow but moving is fine), and a dropped chunk resumes
   from what Google already has, up to four failures in a row. The worker then waits for the file
   to be `ACTIVE`, checking every 5 s for up to 20 minutes.
4. **The watch** is one `generateContent` call with the video and the index prompt (`indexPrompt`,
   `scripts/studio/gemini.mjs:319`): a response schema for `{ notes, moments }`, temperature 0.4,
   and `mediaResolution: MEDIA_RESOLUTION_LOW`, a quarter of the tokens per frame (text on screen
   is read later, from full-resolution frames). Times are asked for as MM:SS, because asked for
   seconds the model drifted past the end of the video. The notes come back in the language the
   lesson is taught in and the moment descriptions in English: the app does not send the
   `language` the worker would accept.
5. **The model chain** is `INDEX_MODELS`: `gemini-3.5-flash` → `gemini-3.6-flash` →
   `gemini-3-flash-preview` (`scripts/studio/gemini.mjs:18`). A model that answers 400, 404, 429,
   500 or 503 hands the lesson to the next one. Within one model, a 500 or a 503 is retried twice
   (after 15 s, then 30 s) before moving on; a 400, 404 or 429 moves on at once. A timeout or a
   dropped connection is retried the same way but then fails the job instead of moving on. It
   never uses `gemini-2.5-flash`, which the DM bot runs on (section 8). Gemini 3 rejects a schema
   carrying `minItems`/`maxItems` with a bare 400, so those bounds are stripped from what is sent
   (`withoutArrayBounds`) and enforced afterwards.
6. **The check** (`normalizeIndex`, `scripts/studio/gemini.mjs:351`): a summary and at least one
   point are required; times outside the video are dropped; moments less than 2 s apart merge,
   keeping the clean one; above 30, unclean moments go first; fewer than 12 usable is a failure.
   An unusable answer is asked for once more, with the reason. A second one fails the job with
   *"Gemini's index was unusable twice: …"*.
7. The upload is **deleted** from Gemini.
8. **Thumbnails.** For each moment, ffmpeg cuts a 480 px JPEG from the *original* video, and the
   worker uploads it to the app.
9. **Complete.** The app replaces the lesson's moments wholesale, stores the notes and marks it
   indexed (`applyIndex`, `src/services/studio/jobs.ts:468`).

### Moments, and the clean flag

A **moment** is a point in a lesson worth showing: its time in seconds, a one-line description of
what is on screen, a kind, the clean flag and a thumbnail. The kinds are **Slide** (شريحة), **App
screen** (شاشة تطبيق), **Result** (نتيجة), **Code** (كود), **Prompt** (برومبت) and **Other** (أخرى).

**Clean** means *you could publish this frame as it is*: fully loaded and sharp, not mid-scroll or
mid-transition, nothing drawn over the screen (no arrows, circles, scribbles or highlighter), and
not a blank or loading page. Gemini decides it while watching, and is told to pick the clean second
of each step when there is one.

What the flag changes:

- The writer only ever puts **clean** moments on slides, and at most three per carousel. An
  unclean moment is still something it may write *about*, never a picture it may use.
- In the screenshot picker, **Clean frames only** (اللقطات النظيفة فقط) is ticked by default. Untick
  it to see every frame; unclean ones carry the badge **Has annotations** (عليها تعليقات توضيحية),
  and you may still pick one yourself.

### Re-indexing

Index a lesson again when its notes look wrong or thin, or after you replaced its video. It
replaces the lesson's notes and every one of its moments. Drafts already written are not affected:
a draft stores each screenshot as *this lesson, at this second*, so its slides stay as they were.
Each re-index costs one Gemini request (section 8); the proxy is reused from the cache.

- For a lesson that **failed** or was **never indexed**: open it in the lesson picker and press
  **Index this lesson**, or use **Index missing** for all of them.
- For a lesson that is **already indexed**, the dashboard has no button. *Operator:* from the
  dashboard's browser console, which acts as your logged-in session:

  ```js
  const { lessons } = await API.getStudioLessons();
  await API.indexStudioLesson(lessons.find((l) => l.lesson_no === '4.3').id);
  ```

  or reset it in SQL and press **Index missing** ([RUNBOOK, *Carousel
  Studio*](../RUNBOOK.md#carousel-studio)).

**The live numbers.** On 2026-09-24, on a free-tier Gemini key, 28 of the 34 lessons were indexed,
with 525 moments between them (about 19 a lesson). The other six failed on the day's free quota.
Nothing re-queues them by itself: press **Index missing** once the quota has reset (section 8).

---

## 5. Drafts

A **draft** is one carousel on its way from an idea to a scheduled post. Drafts are listed under
**Drafts** (المسودات) on the Carousels tab, newest first; clicking one opens the editor, at
`#/studio?draft=<id>`, which is a real link that survives a reload.

### The lifecycle

```
                copy written                  slides drawn
  generating ──────────────────▶ rendering ──────────────────▶ ready ────── Schedule ──────▶ scheduled
 (Writing)                      (Rendering)                   (Ready)                       (Scheduled)
      │                            │    ▲                        │                           read-only
      │ writing failed             │    │                        │
      │                            │    └── Save, Rewrite ───────┘
      ▼            drawing failed  │
   failed ◀────────────────────────┘
  (Failed) ──── Render again, or edit and Save ────▶ rendering
```

*Save* is **Save & update preview** and *Rewrite* is **Rewrite with AI**: both redraw the slides.

| Status | On screen | What it means | What you can do |
|---|---|---|---|
| `generating` | **Writing** (يكتب) | The app is writing it with Gemini, inside your request, for up to two minutes | Wait, or leave the page: the draft appears under Drafts when it is written |
| `rendering` | **Rendering** (يرسم الشرائح) | The copy is saved, and a render is queued or running on the worker | Keep editing (a save queues a newer render). With the worker offline it reads *Waiting for your Mac worker* (بانتظار العامل على الماك) |
| `ready` | **Ready** (جاهز) | The slides are drawn | Edit, rewrite, schedule, delete |
| `scheduled` | **Scheduled** (مجدول) | Its posts and its campaign exist | Nothing: it is read-only, and cannot be deleted, because it is the record of what was posted. Its posts are in **Posts** |
| `failed` | **Failed** (فشل) | Writing or drawing failed; the reason is shown | With its copy kept: **Render again** (أعد الرسم), or edit and save. With no copy (the writing itself failed): delete it and generate again |

*Operator:*

- Writing runs synchronously inside `POST /api/studio/drafts`, with a 120 s budget. If the serverless
  invocation is cut off, the row stays `generating`; once it is ten minutes old the API presents
  it as failed with *"Writing this draft never finished: the request was cut off. Try again."*
  (`STALE_GENERATION_MS`, `src/services/studio/drafts.ts:61`). The row itself is not rewritten.
- `POST /drafts` answers 201 even when the draft came back `failed`: the failure is its content.
- Edits are refused once scheduled (409, *"This draft is scheduled, so it can no longer be changed.
  Its posts are in Posts."*) and while a draft is still being written.
- Deleting a draft fails its pending renders and deletes its rendered images, unless a scheduled
  post uses them.

### Generation

When you press **Generate carousel**, the app hands Gemini three things: the lessons' notes and
moments, which are the only facts it may use; your Settings (voice guide, language, digits,
product facts, the exact lines each caption must carry); and a few example carousels to copy the
shape from. Gemini writes the slides and captions as structured data. The app then checks every
rule, sends any problems back to be fixed, up to twice, and saves the draft. The first real
generation, from lesson 3.1 with 8 slides, took 54 seconds.

**What you can steer.** The lessons, the focus and the idea are on the form itself; the angle, the
slide count, the keyword and the accent sit under **More options** (خيارات أكثر), and are remembered
in this browser for the next carousel.

| Option | On screen | Values | If left alone |
|---|---|---|---|
| Lessons | **Lessons** (الدروس), in **From a lesson** mode | Up to 3 indexed lessons | Required in this mode |
| Focus | **Focus** (التركيز) | What to concentrate on in those lessons, e.g. *only the part about reports*; up to 1000 characters | The most useful, most save-worthy angle in the notes |
| Idea | **What should the carousel be about?** (عن ماذا تريد الكاروسيل؟), in **From an idea** mode | A sentence or two. Written without lesson notes, so stick to what you know is true | Required in this mode |
| Angle | **Angle** (الزاوية) | See the table below | **Let the AI choose** |
| Slides | **Slides** (عدد الشرائح) | 6 to 10 | 8 |
| Keyword | **Keyword** (الكلمة المفتاحية) | One word of up to 30 characters, no spaces or commas | Suggested (see *The keyword* below) |
| Accent | **Accent colour** (لون التمييز) | **From my palette** (من ألواني), or any `#RRGGBB` | The first palette colour not used by your last two scheduled carousels |

| Angle | On screen | The shape it asks for |
|---|---|---|
| `auto` | **Let the AI choose** (يختارها الذكاء الاصطناعي) | The strongest angle the material supports |
| `tips` | **Tips** (نصائح) | Numbered point slides, each with a tip, plus a list and a prompt |
| `steps` | **Step by step** (خطوة بخطوة) | A steps slide at the core, the result as a screenshot, and a prompt |
| `mistakes` | **Common mistakes** (أخطاء شائعة) | Numbered mistakes, each tip giving the fix, plus a compare |
| `compare` | **Before and after** (قبل وبعد) | Old way against new way: an early compare slide, then points proving the new side |
| `prompt` | **Prompt template** (قالب برومبت) | The prompt is the hero: a prompt slide, why each part works, the result as a screenshot |
| `overview` | **Course overview** (نظرة على الكورس) | The lesson's arc: what it covers as a list or steps, a result screenshot, a number from your product facts |

**The slide kinds and their limits.** Limits are the design's hard limits, counted in UTF-16
units, where an emoji counts 2 (`BUDGETS`, `src/services/studio/rules.ts:58`):

| Kind | On screen | For | Fields and limits |
|---|---|---|---|
| `cover` | **Cover** (غلاف) | Slide 1, the hook | kicker ≤ 24, title ≤ 34, highlight (words from the title, painted in the accent), subtitle ≤ 70, optional screenshot |
| `point` | **Point** (فكرة) | One idea, explained | optional number badge, title ≤ 40, body ≤ 150, tip ≤ 70, optional screenshot |
| `list` | **List** (قائمة) | 3 to 5 short items | title ≤ 36; each item: one emoji, text ≤ 36, detail ≤ 60 |
| `compare` | **Compare** (مقارنة) | Old way against new way | title ≤ 36; a weak and a strong side, label ≤ 16, 2 to 4 rows of ≤ 30, the same count on both |
| `steps` | **Steps** (خطوات) | A how-to | title ≤ 36; 3 to 4 steps, title ≤ 28, body ≤ 70 |
| `prompt` | **Prompt** (برومبت) | A prompt to copy: the slide people save | title ≤ 36, label ≤ 20, prompt ≤ 320 with `[placeholders]` in brackets, note ≤ 70 |
| `stat` | **Number** (رقم) | One big number | value ≤ 8, label ≤ 40, body ≤ 120 |
| `shot` | **Screenshot** (لقطة شاشة) | Proof: the real screen, big | title ≤ 40, a screenshot (required), caption ≤ 90 |
| `cta` | **Call to action** (دعوة لاتخاذ إجراء) | The last slide | payoff line ≤ 40. The ask itself comes from Settings |

**Grounded, not invented.** Every slide between the cover and the call to action must name the
sources it rests on: a point of the notes (`L1.point2`), a moment (`M4`), your product facts
(`facts`) or your idea (`idea`). A slide it cannot source is sent back, and if it still has none it
is dropped. The writer is told to use only what the sources state: no features, numbers, prices,
model names, button labels or results beyond them, and nothing inside the sources, such as an
on-screen prompt, counts as an instruction to it.

**The rules every carousel must pass** (`validateCarousel`, `src/services/studio/rules.ts:276`), a
port of the design's own checker: every limit above; the item counts; 6 to 10 slides, the first a
cover and the last a call to action; the highlight is part of the title; no Latin digit beside
Arabic text, when your digits are Arabic-Indic; a TikTok title of at most 90 UTF-16 units; the
Instagram caption carries your keyword line with the keyword filled in, is at most 2200
characters and has at most 30 hashtags; the TikTok caption carries your TikTok line and is at most
4000 characters; the accent is `#RRGGBB`; the keyword is one word; every screenshot a slide names
exists in the draft.

The writer adds rules of its own. Hard ones fail the draft if they survive: every middle slide
cites a source, at most 3 screenshots, no moment used twice, a usable keyword, a DM question and
pitch, and nothing from your avoid list. Soft ones are sent back for repair but never fail it: the
slide count you asked for, at least 4 different kinds between cover and call to action, never
the same kind three times in a row, a prompt slide when the notes quote a prompt, 4 to 6 hashtags
in each caption, a screenshot when a clean moment exists, and no time words (*today*, *tonight*,
اليوم, الليلة…) in the TikTok copy, because TikTok posts often go out later than planned.

*Operator: what code decides, not the model* (`src/services/studio/generate.ts`, `assemble`):

- the accent, from `brand.palette`, skipping the accents of the last two scheduled drafts;
- the keyword (below), and the exact lines in both captions: the Instagram keyword line and the
  save line (**Save prompt** word plus 🔖) are put in place, the TikTok line is put in place, any
  keyword ask is taken out of the TikTok caption, and TikTok's learning hashtags are added
  (`#LearnOnTikTok`, plus `#تعلم_على_تيك_توك` in Arabic);
- the DM, from your template;
- the screenshots: clean moments only, named `m-<momentId>`, framed at zoom 1.3 on the centre.

*Operator: repair and the safe fixes.* After the first answer, up to 2 repair rounds send the list
of problems back, each only if at least 40 s of the 120 s budget remain. The best candidate so far
is kept. Then come fixes that cannot change meaning: unsourced slides dropped (never below 6), more
than 10 cut, screenshots capped at 3, over-long lists shortened, compare sides evened, Latin digits
touching Arabic turned Arabic-Indic, over-long text trimmed at a word or character boundary
without ever splitting an emoji or a `[placeholder]`, and a highlight the trim cut out removed. A
hard problem that survives all that fails the draft with *"Writing the carousel failed: The draft
still breaks N rule(s) after M repair round(s): …"*.

*Operator: the writer's model chain* is `STUDIO_MODELS` (`src/services/studio/generate.ts:153`):
`gemini-3.1-pro-preview` → `gemini-3.7-flash` → `gemini-3.6-flash` → `gemini-3.8-flash`, called
with the app's `GEMINI_API_KEY`. A model answering **400, 404, 429 or 503** hands the call to the
next one. A **500** or a dropped connection stops the chain where it is, and counts as retryable,
as does a 429 or 503 from the last model: the first call is then retried once, from the top of the
chain, if at least 50 s of the budget remain. A timeout is not retried (each call's timeout is what
is left of the budget), and repair calls never are. The error that surfaces is the last model's.
Unlike the indexer, the writer does *not* skip past a 500. Like the indexer, it never uses
`gemini-2.5-flash`, and the schema is sent without `minItems`/`maxItems`. Temperature 0.8 for the
draft and 0.4 for repairs, thinking budgets 2048 and 1024 tokens. Each attempt is logged on Vercel
as `studio.ai_request_failed` (per model) or `studio.ai_usage` (model and tokens), and each draft as
`studio.draft_generated` (repair rounds, problems left, milliseconds).

### The keyword

The keyword is the one word followers comment to get your link by DM. It appears in the Instagram
caption's keyword line, in the pill on the last Instagram slide, and in the campaign that answers
it.

- **If you typed one,** it is used as typed, unless it is one of a live campaign's words: then that
  campaign is reused, under its main word (see below).
- **If you didn't,** the AI suggests a word and two or three alternatives, and the first one that
  works is taken:
  - the same word as a live keyword (after Arabic normalisation) is **reused**;
  - a word that **contains or sits inside** a live keyword is **rejected**, because keyword matching
    finds words inside words (`تم` inside `تمام`) and the wrong campaign would answer;
  - anything else is **new**.
- **A reused keyword is swapped for its campaign's main word,** the first in the campaign's trigger
  list. A campaign triggering on «منديل, رسمة, stitch» may be picked through any of the three, but
  the carousel asks for «منديل», the word the campaign's DM was written around, and the caption's
  keyword line is rewritten to match (`preferPrimaryKeyword`, `src/services/studio/drafts.ts:446`).
- **A new keyword brings up to three variants,** other spellings a follower might type (a common
  misspelling, the word in another script), each at least three letters and none overlapping a
  live keyword. They are shown as **Also matches:** (تطابق أيضاً) and join the new campaign's
  triggers.

A keyword you type yourself is not checked for overlap with live keywords. If it sits inside one,
the older campaign will answer it (section 9, *keyword clash*).

### The DM

The DM a commenter receives is your **DM template** from Settings, filled in:

| Placeholder | Filled with |
|---|---|
| `{question}` | One line the AI writes for this topic, the question that opens the DM |
| `{pitch}` | One sentence the AI writes, naming the part of the course that teaches it |
| `{url}` | **Product link** from Settings |
| `{bullets}` | **DM bullets** from Settings, one per line, each given ✅ unless it already starts with an emoji or a bullet |
| `{username}` | Left as it is: the comment automation replaces it with the commenter's name when it sends |

A line holding only a placeholder whose value is empty is dropped. You can edit the finished DM in
the editor, under **Keyword automation** (أتمتة الكلمة المفتاحية) → **DM** (الرسالة الخاصة). The
creator's seeded template (STUDIO.md §8) produces, for example:

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

### Editing

The editor shows the drawn slides big, under **Preview** (المعاينة), with tabs for **Instagram 4:5**
(إنستجرام 4:5) and **TikTok 9:16** (تيك توك 9:16). The arrow keys move between slides, and Enter or a
click opens that slide's fields. Beside it:

- **Slides** (الشرائح): each slide's fields, with its limits. Change a slide's **Slide type** (نوع
  الشريحة), which keeps the title and any text both types share; move it earlier or later;
  duplicate it (not the cover or the call to action: a carousel has one of each); delete it, with
  **Undo** (تراجع) for 12 seconds; or **Add slide** (إضافة شريحة) of a chosen kind. A carousel holds 6
  to 10 slides.
- **Captions** (النصوص المرافقة): **Instagram & Facebook caption**, **TikTok title** and **TikTok
  description**. Under each, *Includes:* (يتضمن) or *Must include:* (يجب أن يتضمن) shows whether the
  line Settings requires is there.
- **Keyword automation** (أتمتة الكلمة المفتاحية): the keyword, its *Also matches:* variants, the
  **DM**, and **Create the keyword automation** (إنشاء أتمتة الكلمة المفتاحية). Changing the keyword
  here changes the carousel's keyword and the campaign's together.
- **Look** (المظهر): the accent colour.

**Nothing is redrawn while you type.** Your edits stay in a working copy until you press **Save &
update preview** (احفظ وحدّث المعاينة), or ⌘S / Ctrl+S. Then the app checks every rule and, if they
pass, saves and queues a new render; the preview says *"This is the last render. Save to see your
edits."* until then. **Discard changes** (تجاهل التغييرات) goes back to the saved copy.

**If the save is refused,** the editor shows **Problems to fix: n** (مشكلات يلزم إصلاحها) and places
each problem on its slide and field; nothing is saved until they are fixed. The usual ones are a
field over its limit (`slide 3 (point).title: 45 > 40 «…»` means 45 characters where 40 fit), and a
caption missing its required line after you changed the keyword: the Instagram keyword line must
carry the new word, so edit that line too.

**Unsaved edits are kept in this browser.** Leave and come back, and the editor says *"We brought
back the changes you hadn't saved on this device."* If the draft changed on the server
meanwhile, it asks instead: *"You have unsaved changes from an earlier version of this draft."*,
with **Restore them** (استرجعها) or **Discard** (تجاهلها).

### Rewriting a slide

**Rewrite with AI** (أعد الكتابة بالذكاء الاصطناعي) on a slide opens **Rewrite slide n** (إعادة كتابة
الشريحة) with an optional **Instruction** (التوجيه), such as *shorter, or lead with the result*.
Press **Rewrite** (أعد الكتابة). Your unsaved edits are saved first, so the AI rewrites the version
you see. It rewrites only that slide, within its limits, from the same lessons: the cover stays a
cover, the last slide stays a call to action, and a screenshot may only be one the carousel already
shows. The draft is then saved and redrawn.

*Operator:* `POST /api/studio/drafts/:id/rewrite`, one call plus up to two repair rounds, so one to
three Gemini requests. A rewrite that still breaks a rule changes nothing (422, with the
problems). One that lands after the draft changed is refused: *"The draft changed while the slide
was being rewritten. Reload it and try again."*

### Screenshots

A generated carousel carries one to three screenshots, all clean moments, drawn at zoom 1.3 on the
centre of the frame; none if the lessons have no clean moment. On a cover, point or screenshot
slide, **Change screenshot** (تغيير اللقطة) or **Pick a screenshot** (اختيار لقطة) opens the picker:
moments from **This carousel's lessons** (دروس هذا الكاروسيل) and from **Other lessons** (دروس أخرى),
any indexed lesson, with **Clean frames only** ticked. Point at a frame to see it large, pick it,
and save to redraw. **Remove** (إزالة) takes it off (a screenshot slide must keep one). When the
worker draws the slide, it cuts that exact second out of the original video at full resolution.

*Operator:* the editor has no zoom or focus control. A picked moment is framed the generated way.
Other framing can be sent through the API as the draft's `shots` map (`PATCH
/api/studio/drafts/:id`, `zoom` 1 to 4, `focusX`/`focusY` 0 to 1).

### Write it again, render again, delete

- **Write it again** (اكتبه من جديد) opens **Write the carousel again** (اكتب الكاروسيل من جديد): a new
  draft from the same lessons, or the same idea, at the angle and length you pick; press **Write a
  new version** (اكتب نسخة جديدة). The keyword and accent carry over, and this draft stays as it is,
  so delete whichever version you don't use. Not offered on a scheduled draft.
- **Render again** (أعد الرسم) appears on a failed draft that still has its copy (*"The copy is
  saved. Render again, or edit and save."*).
- **Delete draft** (حذف المسودة) deletes the draft and its drawn slides. It cannot be undone, and a
  scheduled draft cannot be deleted.

### Plan my week

**Plan my week** (خطّط أسبوعي) proposes several carousels at once. Choose **How many carousels**
(عدد المنشورات), 3 to 7 (5 by default). The AI proposes that many posts from your indexed lessons, or
from the lessons you picked, varied across lessons, sections and angles and away from what you
posted recently. Each proposal has a working title, a one-line idea, an angle, a slide count, a
sentence on why it will earn saves, its own accent, and the next free posting slot. Nothing is
saved yet: **Keep** (إبقاء) or **Remove** (استبعاد) each, then **Generate all (n)** (إنشاء الكل), which
writes them one after another, up to two minutes each. When you schedule one of those drafts in the
same browser session, its planned slot is selected for you, as long as it is still free.

*Operator:* `POST /api/studio/plan` accepts a count of 1 to 14 and up to 50 lesson ids; the dashboard
sends 3 to 7 and at most the three picked lessons. Slots are assigned by the app, not the model,
which cannot see the calendar. "Recent" means the cover titles of your last 20 drafts and the first
lines of your last 20 carousel captions. A proposal mentioning a term from your avoid list is
dropped.

---

## 6. Scheduling

**Schedule** (جدولة) opens once the draft is **Ready** and saved. Until then it says *"Scheduling
opens when the render is ready."* or *"Save your edits first: the post goes out with the drawn
slides."*

### Slots

**When** (الموعد) offers the next six free posting times from your schedule in Settings, with
*planned* beside one that **Plan my week** chose, and **Another time…** (وقت آخر…) for any date and
time, which uses this device's time zone. The form says which zone the slots are in (*"Times are in
Riyadh time (Asia/Riyadh), from your schedule in Settings."*).

A slot is free when no pending Instagram or Facebook post sits within 30 minutes of it, so two
posts never land ten minutes apart. Slots are wall-clock times in your time zone, worked out day
by day, so daylight saving never shifts them by an hour. The app looks up to 90 days ahead
(`src/services/studio/slots.ts`).

### What Schedule creates

Before you press **Schedule for {time}** (جدوِل: {time}), **What will happen** (ما الذي سيحدث) lists
it: Instagram and Facebook published at that time; what happens on TikTok; and whether anyone who
comments the keyword gets the DM.

*Operator:* in one transaction, with the draft locked and re-checked so a double click schedules
once (`scheduleDraft`, `src/services/studio/schedule.ts:123`):

1. A `scheduled_posts` row: `platform = 'both'`, `post_type = 'carousel'`, the Instagram images as
   `media_urls` (Instagram takes 2 to 10), the Instagram caption, `PENDING`, and a new `group_id`.
   It is the same row the Posts composer writes, and it publishes through the same sweep.
2. With TikTok at the same time, a sibling `tiktok` row: the same time and `group_id`, the TikTok
   images and description, and `platform_options` for a public Direct Post with the TikTok title,
   music added automatically, comments on, organic brand content, and your consent time.
3. With the automation ticked, the campaign (below).
4. The draft becomes `scheduled`, with `schedule = { scheduled_time, meta_row_id, tiktok,
   tiktok_row_id, tiktok_public_done }`. The audit log records `studio.schedule`.

Afterwards the panel reads **Scheduled** (مجدول), *Publishes {when}*, with **Open in Posts** (فتح في
المنشورات). The Studio publishes nothing itself: the post goes out when the publish sweep next runs
after its time, and RUNBOOK §4.1 and §5.1 say what runs the sweep and how often.

### TikTok: queue, or post at the same time

The schedule form's **TikTok** (تيك توك) choice shows two options:

| Option | Offered | What happens |
|---|---|---|
| **Post to TikTok at the same time** (النشر على تيك توك في الموعد نفسه) | Only once TikTok has approved (audited) the app | A public TikTok photo post at the same time as Instagram |
| **Queue for TikTok** (إضافة إلى طابور تيك توك) | While TikTok has not approved the app | Nothing goes to TikTok yet. The carousel joins the TikTok queue, counted under **Waiting for TikTok** (بانتظار تيك توك), until you send the queue |
| **Don't post to TikTok** (بلا نشر على تيك توك) | Always | Instagram and Facebook only |

The first of the two is selected by default.

**Why there is a queue.** Until TikTok audits the app, a direct post can only be private (*Only
me*), and TikTok accepts those only while the account itself is private. If each post went out on
its own at its own time, you would have to keep your account private all week. Instead the Studio
collects them, and you send them together in a few minutes with the account private, then make
them public.

### The TikTok batch

**Post queued TikTok carousels** (انشر كاروسيل تيك توك المنتظرة) sits in the status bar under
**Waiting for TikTok** and its count, and is greyed out while nothing is queued. It asks first:
*"This posts the queued carousels (n) to TikTok now, 40 seconds apart."*, with the warning about
the private account. Confirm with **Post to TikTok** (انشر على تيك توك).

The routine:

1. In the TikTok app, set your account to **private**.
2. Press **Post queued TikTok carousels**, then **Post to TikTok**.
3. Wait until they have all gone out (Posts shows each one; they are 40 seconds apart).
4. In the TikTok app, make each post public, then make the account public again.
5. Back in the Studio, tick **Made public on TikTok** on each of those drafts.

*Operator:* `POST /api/studio/tiktok/batch` (`runTikTokBatch`,
`src/services/studio/schedule.ts:226`) turns every scheduled draft with `schedule.tiktok = 'queue'`
and no TikTok row yet into a `tiktok` row due now, 40 s apart, in scheduled order (TikTok allows a
photo-post start 6 times a minute per token), grouped with its Instagram sibling. The options are
Direct Post, `SELF_ONLY` until audited and public after, the TikTok title, music added, comments
on, organic brand content, and the click as consent. It needs TikTok connected, the `video.publish`
scope granted, and **Direct Post is switched on for this app in the TikTok developer portal**
ticked in Settings → **TikTok app (platform admin)**. A draft that cannot go (its images are not
JPEG or WebP, say, or more than 35) is skipped with its reason and stays queued; the rest go. The
rows then publish through the ordinary sweep, like any post that is due. The audit log records
`studio.tiktok_batch`. TikTok's own side (connecting, Direct Post, the audit, verifying the site
address) is in [`TIKTOK_GUIDE.md`](TIKTOK_GUIDE.md).

### The "Made public on TikTok" checklist

A scheduled draft's **TikTok** panel says where its TikTok post stands:

- queued: *"Queued. Press "Post queued TikTok carousels" at the top when you're ready."*;
- sent: *"Sent to TikTok as "Only me". Make it public in the TikTok app, then tick this off."*,
  with the tick box **Made public on TikTok** (جُعل عامّاً على تيك توك).

The tick is *"A reminder for you. It changes nothing on TikTok."* It becomes available once the
carousel is on TikTok. *Operator:* `POST /api/studio/drafts/:id/tiktok-public { done }`, stored as
`schedule.tiktok_public_done`.

### The keyword campaign

With **Also create the keyword automation** (إنشاء أتمتة الكلمة المفتاحية أيضاً) ticked, scheduling
creates the campaign that answers the keyword: anyone who comments it gets the DM. It is live from
that moment, on all your posts, not only this one, and it is an ordinary campaign on the Campaigns
page, where you can edit, pause or delete it.

If a live campaign already answers the keyword, no new one is made, and the existing campaign
answers with its own DM. The box starts ticked for a new keyword and unticked for a reused one.

*Operator:* the campaign is inserted with the keyword and its variants as a comma-separated
trigger, the draft's DM, no public reply, every post (`post_id` NULL), active, and the default
`substring` match mode. "Already answers" is decided by `matchCampaign` itself, with each
campaign's own match mode, over the campaigns that apply to every post: a substring campaign on a
shorter word inside the keyword counts, because it would answer those comments anyway
(`planCampaign`, `src/services/studio/schedule.ts:100`).

---

## 7. The Settings reference

Everything that makes the Studio *yours* lives in Studio → **Settings** (الإعدادات), per account.
Nothing about any one creator is written into the code or the prompts (STUDIO.md §10).

- **Sections:** **Brand kit** (الهوية البصرية), **Voice** (الأسلوب), **Product & calls to action** (المنتج
  والدعوات), **Schedule** (الجدول), **Library folder** (مجلد المكتبة) and **Workers** (العمّال).
- **Who:** anyone with the operator role can change settings. Creating and revoking workers needs
  the account's owner.
- **Saving:** **Save settings** (حفظ الإعدادات) sends the first five sections whole. The server merges
  them over what is stored and validates the result as a whole; each problem is shown beside its
  field (*"Fix the highlighted fields, then save."*). A key it doesn't know is refused rather than
  kept, so a typo can never be a setting that silently does nothing.
- **Previews:** the tab shows the Instagram line with a sample keyword, the TikTok line, the DM
  with sample values, and a rough sample slide in your colours and signature (the real slides are
  drawn on the Mac).
- **When changes apply:** to the next carousel written and the next render. A draft already drawn
  keeps its look until it is drawn again (save it, or **Render again**). A scheduled one never
  changes.
- **Defaults:** a new account starts neutral: English, generic wording, the dark-grid theme, the
  default palette, no product, no library folder (`defaultStudioSettings()`,
  `src/services/studio/settingsTypes.ts:92`). The creator's own account was seeded once, after
  deploy, by `scripts/seed-studio-settings.mjs`. Those are the *Example* values below.

### Brand kit

| On screen | Key, rule, default | Example | What it affects |
|---|---|---|---|
| **Brand name** (اسم العلامة) | `brand.name`: required, ≤ 80. Default *My Studio* | *Agentic AI بالعربي* | Who the writer is told it writes for (*"You write carousel posts for «…»"*), and how the Studio refers to you. Not drawn on slides |
| **Signature (Latin)** (التوقيع (بالحروف اللاتينية)) | `brand.signature.latin`: ≤ 40. Default *STUDIO* | *AGENTIC AI* | The sign-off on every slide, in the code font. Empty leaves it out |
| **Signature (your language)** (التوقيع (بلغتك)) | `brand.signature.local`: ≤ 40. Default empty | *بالعربي* | Beside the Latin signature, after a `·`, in the display font |
| **Accent palette** (ألوان التمييز) | `brand.palette`: 1 to 24 colours, each `#RRGGBB`. Default 13 colours | 13 colours, starting `#FFD60A`, `#FF8A3D`, `#22C7F0` | Each carousel's accent: the first colour not used by the last two scheduled carousels. The accent paints the highlighted words and the pills |
| **Ink** (لون الحبر) | `brand.colors.ink`: `#RRGGBB`. Default `#08080A` | `#08080A` | The slide background |
| **Paper** (لون الورق) | `brand.colors.paper`: `#RRGGBB`. Default `#FAFAFA` | `#FAFAFA` | The main text |
| **Muted** (اللون الخافت) | `brand.colors.muted`: `#RRGGBB`. Default `#8A8A93` | `#8A8A93` | Secondary text, such as the payoff line and the facts line on the last slide |
| **Display font** (خط العناوين) | `brand.fonts.display`: *Cairo*, *Tajawal*, *IBM Plex Sans Arabic* or *Inter*. Default *Inter* | *Cairo* | Titles and text |
| **Code font** (خط الكود) | `brand.fonts.mono`: *JetBrains Mono* only | *JetBrains Mono* | Prompts and code, and the Latin signature |
| **Slide direction** (اتجاه الشرائح): **Right to left** (من اليمين إلى اليسار) / **Left to right** (من اليسار إلى اليمين) | `brand.direction`: `rtl` or `ltr`. Default `ltr` | `rtl` | The layout's direction, and the numerals the templates draw themselves (the slide counter, a point's number badge, list and step numbers): Arabic-Indic for right to left, Latin for left to right |
| *(not in the form)* | `brand.theme`: `dark-grid`, the only theme in v1 | `dark-grid` | Reserved, so more themes can be added |

### Voice

| On screen | Key, rule, default | Example | What it affects |
|---|---|---|---|
| **Carousel language** (لغة الكاروسيل) | `voice.language`: `ar` or `en`. Default `en` | `ar` | The language of every slide, caption and DM line; which built-in example carousels the writer copies the shape of; TikTok's learning hashtags; the time words kept out of TikTok copy |
| **Digits** (الأرقام): **Arabic-Indic (١٢٣)** (هندية) / **Latin (123)** (لاتينية) | `voice.digits`: `arabic-indic` or `latin`. Default `latin` | `arabic-indic` | The numerals the writer uses. With Arabic-Indic, a Latin digit beside Arabic text breaks a rule (and is converted where it touches Arabic), while one inside a Latin name, *Gemini 2.5*, is fine. It does not reach the templates, whose own numbers follow **Slide direction** |
| **Voice guide** (دليل الأسلوب) | `voice.guide`: ≤ 4000. Default three neutral lines: clear and practical, short sentences, the result before the tool | The creator's guide, below | Given to the writer as the creator's voice guide, to follow closely: where it differs from the built-in craft notes, it wins. It also shapes **Plan my week**'s titles |
| *(not in the form)* | `voice.avoid`: up to 30 terms, each ≤ 80. Default none | `["MCP"]`: the course's MCP section is not published yet | Terms the writer must never use. Generated copy containing one goes back for repair and is refused if it stays; a plan proposal mentioning one is dropped. Your own edits are not checked against it |

The creator's voice guide, as seeded:

```
Write in a light Gulf / white Arabic dialect: warm and direct, the way a Saudi creator talks to followers.
Never formal MSA, never heavy slang.
Use Arabic-Indic digits (٣ not 3) everywhere in Arabic text.
Lead with the result the viewer gets, then name the tool that gets it.
Short lines: one idea per line, one point per slide.
Product and tool names stay in English (NotebookLM, Gemini, Stitch).
No invented features or numbers: every claim comes from the lesson.
TikTok copy points to the link in the bio («رابطه في البايو»), never to the comments.
```

### Product & calls to action

| On screen | Key, rule, default | Example | What it affects |
|---|---|---|---|
| **Product name** (اسم المنتج) | `product.name`: ≤ 200. Default empty | *Agentic AI: الدليل العملي لبناء ما تحتاجه بالذكاء الاصطناعي* | Named to the writer (*"whose course is «…»"*) and as the owner of the facts |
| **Product link** (رابط المنتج) | `product.url`: a full `https://` address, ≤ 1000. Default empty | The Udemy course link with the referral code | `{url}` in the DM |
| **Facts** (حقائق) | `product.facts`: up to 20, each ≤ 60. Default none | `٣٤ درس` · `٥ ساعات و٤٠ دقيقة` · `شهادة إتمام` | The only things a slide may claim about the product. With none, the writer is told to state no numbers about the course at all. Also the facts line on the last slide, which disappears when the list is empty |
| **DM bullets** (نقاط الرسالة الخاصة) | `product.dmBullets`: up to 10, each ≤ 200. Default none | The four ✅ lines of the DM in section 5 | `{bullets}` in the DM, one per line |
| **Instagram caption line** (سطر نص إنستجرام) | `cta.instagramAsk`: required, ≤ 300; must contain `{keyword}` and no other placeholder. Default `Comment "{keyword}" and I'll DM you the link 📩` | `اكتب "{keyword}" بالتعليقات ويوصلك رابط الكورس بالخاص 📩` | Every Instagram caption carries it, word for word, with the keyword filled in. A caption without it is refused, because it is what the comment automation answers |
| **TikTok caption line** (سطر نص تيك توك) | `cta.tiktokLine`: ≤ 200. Default `🔗 The full course is in my bio` | `📚 الكورس كامل بالعربي — رابطه في البايو 🔗` | Every TikTok caption carries it word for word, when it is set. TikTok cannot send DMs, so it points to your bio |
| **DM template** (قالب الرسالة الخاصة) | `cta.dmTemplate`: required, ≤ 4000; placeholders `{username}` `{question}` `{pitch}` `{url}` `{bullets}` only. Default a short neutral English DM | STUDIO.md §8, shown in section 5 | The DM every new keyword campaign sends |

**Last slide words** (كلمات الشريحة الأخيرة), `cta.slide.*`, each ≤ 60. An empty one leaves its line out.

| On screen | Key, default | Example | Where it appears |
|---|---|---|---|
| **Instagram ask** (دعوة إنستجرام) | `igAsk`, *Comment below* | *اكتب في التعليقات* | Last Instagram slide, above the keyword pill |
| **Instagram line under it** (سطر إنستجرام تحتها) | `igSub`, *and I'll DM you the link 📩* | *ويوصلك الرابط بالخاص 📩* | Last Instagram slide, under the pill |
| **Save prompt** (دعوة الحفظ) | `save`, *Save this post* | *احفظ المنشور* | Last Instagram slide, and the caption's save line, with 🔖 |
| **TikTok headline** (عنوان تيك توك) | `ttHeadline`, *The full course* | *الكورس كامل بالعربي* | Last TikTok slide, the headline |
| **TikTok pill** (شارة تيك توك) | `ttPill`, *Link in bio* | *رابطه في البايو* | Last TikTok slide, the pill |
| **TikTok line under it** (سطر تيك توك تحتها) | `ttSub`, *Tap the link on my profile 👆* | *ادخل البروفايل واضغط الرابط 👆* | Last TikTok slide, under the pill |
| **Follow prompt** (دعوة المتابعة) | `follow`, *Follow for more* | *تابعني للمزيد* | Last TikTok slide, the follow button |
| **Swipe hint** (تلميح السحب) | `swipe`, *Swipe* | *اسحب* | Every slide except the last |

### Schedule

| On screen | Key, rule, default | Example | What it affects |
|---|---|---|---|
| **Time zone** (المنطقة الزمنية) | `schedule.timezone`: a zone name such as `Asia/Riyadh` or `Europe/London`. Default `UTC` | `Asia/Riyadh` | The zone the slots are in |
| **Daily slots** (المواعيد اليومية), **Add slot** (إضافة موعد) | `schedule.slots`: 1 to 8 times as `HH:MM`, none twice. Default `12:00`, `18:00` | `13:00`, `21:00` (10:00 and 18:00 UTC) | The times **Schedule** offers, one post per slot |

### Library folder

| On screen | Key, rule, default | Example | What it affects |
|---|---|---|---|
| **Folder on your Mac** (المجلد على جهاز الماك) | `library.root`: a full folder path, ≤ 1000, or empty. Default empty | `/Users/elamir/Desktop/AI Course` | The folder **Scan library** looks in. It must be inside the worker's `courseRoot`. Empty turns scanning off, and the Scan button greys out |

### Workers

| On screen | Rule | What it does |
|---|---|---|
| **New worker** (عامل جديد), **Create worker** (إنشاء عامل) | A name of up to 100 characters. Up to 10 active workers per account. Owner only | Creates the worker and shows its token once |
| **Worker token** (رمز العامل), **I've copied it** (نسخته) | `sws_` plus 43 characters. Only its SHA-256 is stored | Paste it as `"token"` in `studio.config.json` on the Mac |
| **Revoke** (إلغاء) | Owner only | The token is refused from its next call. To use that Mac again, create a new worker |
| *Last seen* / **Never connected** (لم يتصل بعد) / *Created* | | When each worker last called, and when it was made |

### Not in the form (Operator)

- `examples`: up to 5 carousels you approved (100 KB at most in all) that the writer copies the
  density, structure and voice of; it uses the first three. `null`, the default, uses the
  built-in examples for your language.
- `voice.avoid` and `brand.theme`, above.

Set them from the dashboard's browser console, which acts as your session. A section merges key by
key; a list is replaced whole:

```js
await API.saveStudioSettings({ voice: { avoid: ['MCP'] } });
await API.saveStudioSettings({ examples: null });      // back to the built-in examples
```

### Settings the Studio depends on, elsewhere (Operator)

| Where | What | Why the Studio cares |
|---|---|---|
| Vercel environment, `GEMINI_API_KEY` | The app's Gemini key, shared with the DM bot | The writer. The worker has its own key, `geminiApiKey`, in its config |
| Settings → **TikTok app (platform admin)** → **Public site address** (`app.public_base_url`, else `PUBLIC_BASE_URL`, else the request's own host) | The app's public address | Every image a worker uploads is served from it. With none at all, uploads fail: *"No public address for this app: set it in Settings → TikTok app."* |
| Settings → **TikTok app (platform admin)** → Direct Post switches | *Direct Post is switched on…* and *TikTok has approved this app…* | Whether the TikTok batch can run at all, and whether **Post to TikTok at the same time** is offered |
| Vercel environment, `MEDIA_RETENTION_DAYS` | Opt-in sweep of old, unreferenced uploads | It keeps every draft's current render and every moment's thumbnail; unset, nothing is swept |

---

## 8. Quotas and costs

### Gemini's tiers

Gemini is Google's AI. A Gemini API key belongs to a Google Cloud project, and the project is either
on the **free tier** or has **billing** switched on. The limits are counted per project and per
model: each model has its own daily allowance.

On the free tier, as found on 2026-09-24:

- **the Pro models have no quota at all.** The writer's first choice, `gemini-3.1-pro-preview`,
  answers 429 every time, so every carousel is written by a Flash model;
- **each Flash model allows about 20 requests a day;**
- the daily allowance resets at midnight Pacific time, which is 10:00 in Riyadh while the US is on
  summer time and 11:00 otherwise.

### What we hit on 2026-09-24

1. The first indexing run used `gemini-2.5-flash`: the same model, on the same project's quota, that
   the DM bot answers customers with. Indexing spent it, and the bot had nothing left for the day.
2. So the Studio got model chains of its own, and **never uses `gemini-2.5-flash`**:

   | Chain | Models, in order | Moves to the next model on |
   |---|---|---|
   | Writer (the app) | `gemini-3.1-pro-preview` → `gemini-3.7-flash` → `gemini-3.6-flash` → `gemini-3.8-flash` | 400, 404, 429, 503 |
   | Indexer (the worker) | `gemini-3.5-flash` → `gemini-3.6-flash` → `gemini-3-flash-preview` | 400, 404, 429, 500, 503 |

   Each model in a chain is a separate daily allowance, so a chain stretches the free tier.
   `gemini-3.6-flash` is in both chains, so when the app and the worker use keys of the same
   project, writing and indexing share that one's allowance.
3. Indexing asks for `MEDIA_RESOLUTION_LOW`, a quarter of the tokens per video frame.
4. Gemini 3 rejects a response schema that carries `minItems`/`maxItems` with a bare 400, so both
   sides strip them and check the counts themselves.
5. The result: **28 of 34 lessons indexed, 525 moments.** The other six failed on the day's quota.
   Nothing re-queues them by itself: after the reset, press **Index missing**.

### What each action costs

| Action | Gemini requests | Chain |
|---|---|---|
| Index a lesson | 1, or 2 if the first answer was unusable, plus the retries of a 500 or 503 | Indexer |
| Generate a carousel | 1 to 3: the draft, plus up to two repair rounds | Writer |
| Rewrite a slide | 1 to 3 | Writer |
| Plan my week | 1 or 2 | Writer |
| Scan, render, schedule, the TikTok batch | None | |

### Enabling billing

The free tier is enough to try the Studio. It is not enough to index a whole course in a day, or to
write carousels on the same day the DM bot needs its allowance. **Enabling billing on the key is the
real fix.** The limits rise well beyond what this app needs, the Pro model starts answering (the
writer tries it first, so the copy gets better), and the Studio and the DM bot stop competing for
the same few requests. At this volume, a course indexed once and a few carousels a day, it comes to
a few dollars a month. Google charges per token, and indexing (a whole lesson video per request,
even at low resolution) is the largest item; check Google's current prices before relying on the
estimate.

1. Open Google AI Studio (`aistudio.google.com`) with the Google account that owns the key, and go
   to its **API keys** page.
2. Next to the key's project, choose **Set up billing**, or link a billing account to that project
   in the Google Cloud console under **Billing**.
3. Nothing changes in the app or on the Mac: the same keys keep working, with the paid limits. If
   the app's `GEMINI_API_KEY` and the worker's `geminiApiKey` belong to different projects, enable
   billing on both.

A budget alert in Google Cloud Billing (**Budgets & alerts**) is cheap insurance.

### The other costs

| What | Where | Notes |
|---|---|---|
| Storage | The app's Postgres, `media_uploads`, which holds files as bytes inside the database (the Supabase free tier is 500 MB) | A 480px thumbnail per moment, and two images per slide per render (at most 3 MB each, usually far less). A newer render deletes the older one's images unless a scheduled post uses them. The retention sweep is opt-in (`MEDIA_RETENTION_DAYS`) |
| Upload time | Your connection | Per lesson: the proxy (0.6 MB took 31 s) and 12 to 30 thumbnails. Per render: two images per slide. At 20 to 30 KB/s, the uploads are most of a render's 170 s |
| Function time | Vercel | Each generation holds one request open for up to two minutes |
| Your Mac | Electricity | It must be on, awake and logged in for jobs to run |
| TikTok's limits | TikTok | A photo post can be started 6 times a minute per account, which is why the batch spaces posts 40 s apart; TikTok also has daily posting limits. See [`TIKTOK_GUIDE.md`](TIKTOK_GUIDE.md) |

---

## 9. Troubleshooting

Find the symptom, read the cause, apply the fix. Messages in *italics* are what the dashboard, the
API or the worker's log (`~/Library/Logs/aicourse-studio-worker.log`) actually say. For the SQL
behind a diagnosis, see [RUNBOOK.md, *Carousel Studio*](../RUNBOOK.md#carousel-studio). To prove
the whole path works end to end, see [VERIFYING.md, *Verifying the Carousel
Studio*](../VERIFYING.md#verifying-the-carousel-studio).

### The worker

| Symptom | Cause | Fix |
|---|---|---|
| **Worker offline**, *Last seen* some time ago | The Mac is asleep, off, logged out or offline, or the worker stopped | Wake the Mac and log in. Then `launchctl print gui/$(id -u)/com.aicourse.studio-worker \| grep -E 'state\|pid'`; if it isn't running, `launchctl kickstart -k gui/$(id -u)/com.aicourse.studio-worker`, and read the log's last lines |
| **Worker offline**; the log says *the app rejected the worker token (HTTP 401)* | The token was revoked, or mistyped in the config | Settings → Workers → **Create worker**, paste the new token into `studio.config.json`. It is picked up at the next poll, no restart |
| **Never connected** | No worker has been created, or its config is wrong, or it never started | Create one (section 3), then run `node scripts/studio-worker.mjs --drain` in a Terminal and read what it says |
| Log: *config: … doesn't exist*, *… is empty*, *courseRoot doesn't exist* | The config file is missing or incomplete | Fix `studio.config.json`. Under launchd the worker re-reads it every minute |
| Log: *claim failed: fetch failed (ENOTFOUND)* or *(ECONNREFUSED)* | No internet, or `appUrl` is wrong | It keeps retrying, and logs *the app is reachable again* when it is |
| Log: *another studio worker is running (pid …)* | A second copy for the same config | Stop one (`scripts/uninstall-studio-worker.sh`, or Ctrl-C), or delete a stale `.studio/worker-*.pid` |
| Log: *ffmpeg not found on PATH* | ffmpeg is missing, or was installed after the agent | `brew install ffmpeg`, then run `scripts/install-studio-worker.sh` again |
| Log: *config: … holds secrets but other users can read it* | The config file is not mode 600 | `chmod 600 studio.config.json` |
| Any Studio call answers 503: *"The database is missing migration v21…"* | Migration v21 has not been applied | `npm run migrate` |

### The library

| Symptom | Cause | Fix |
|---|---|---|
| **Scan library** is greyed out: *"No library folder is set, so there is nothing to scan."* | Settings → **Library folder** is empty | Settings → **Library folder** → **Folder on your Mac**: the full path, inside the worker's `courseRoot` → **Save settings** |
| Scan answers *"Set your library folder first, in Studio settings: it is where the worker looks for your videos."* | The same, when the settings could not be read and the button stayed on | The same |
| The scan ran, and no new lessons appeared | The scan failed on the Mac: the folder is outside `courseRoot` (*"payload.root is outside the course root"*) or does not exist (*"payload.root not found"*). A failed scan marks nothing in the dashboard | Read the scan job's error (RUNBOOK) or the log, fix the folder or `courseRoot`, scan again |
| Fewer lessons than videos | The naming rules: a video loose in the library folder, nested too deep, in an assets folder, a second video in a lesson folder, or in `marketing/` or `out/` | Section 4's rules. Rename or move, then scan again (34 lessons among 35 videos is the course as it is) |
| A lesson appears twice | The video was renamed or moved, and each path is its own lesson | Use the new one. The old row points at a file that is gone |
| **Index missing** is greyed out: *"Every lesson is indexed or already queued."* | Nothing is left to queue | To index an indexed lesson again, see *Re-indexing* in section 4 |
| **Indexing failed**, and the error contains *HTTP 429* | Every model in the indexer's chain has spent its daily free quota | After the reset (midnight Pacific), **Index missing**. Or enable billing (section 8) |
| **Indexing failed** with *HTTP 503* | Gemini is overloaded. Each model was retried twice, then the next, and all of them were | **Index this lesson** again later |
| **Indexing failed** with *HTTP 500* | An internal error on Google's side, handled like a 503 | Index it again later |
| **Indexing failed** with *HTTP 400* | Every model refused the request, often a schema feature a new model rejects (Gemini 3 and `minItems` was one) | The log has one *trying the next model* line per model with Google's message. A 400 from every model is a code fix, not a retry |
| **Indexing failed**: *Gemini's index was unusable twice: …* | Too few usable moments, or times past the end | Index it again; the message says what came back |
| **Indexing failed**: *the proxy is …s long but the lesson is …s* | ffmpeg made the proxy on a different timeline, so the moments wouldn't line up | Check the original plays to its end, then index again |
| **Indexing failed**: *the upload stalled: nothing moved for 2 minutes* | The connection went away for good, for example while the Mac slept | Index it again once the connection is back |
| **Indexing failed**: *geminiApiKey is empty in …* | The worker's config has no Gemini key | Add it, then index again |
| **Indexing failed**: *The worker stopped reporting on this job 3 times…* | The worker crashed or was stopped during this job three times | The log around those times says why |
| A lesson sits on **Indexing…** | Its job is waiting (the worker is offline, or busy with other jobs), or it is uploading on a slow connection | The status bar's *Waiting / Running*. The log shows the step, e.g. *uploading the 0.6 MB proxy to Gemini: 45%*; the heartbeat keeps the job while it uploads |

### Generating

| Symptom | Cause | Fix |
|---|---|---|
| **Failed**: *Writing the carousel failed: Gemini request failed [HTTP 429]: …* | The writer's chain has spent its daily quota. On the free tier the Pro model always does, then each Flash model | Wait for the reset, or enable billing (section 8) |
| **Failed** with *[HTTP 404]* | The error shown is the last model's, so every model in the chain answered 404: they are gone, or closed to this key | On Vercel, one `studio.ai_request_failed` line per model says which. If they are all gone, the names in `STUDIO_MODELS` (`src/services/studio/generate.ts:153`) need updating: a code change |
| **Failed** with *[HTTP 400]* | Every model refused the request. A 400 that every model gives is the request's fault, not the models' | The per-model message in `studio.ai_request_failed`; a code fix, like stripping `minItems`/`maxItems` was |
| **Failed** with *[HTTP 500]* | Google's side. The writer retries a 500 once but does not skip to the next model | Generate again |
| **Failed**: *The draft still breaks N rule(s) after M repair round(s): …* | The model could not meet the rules in the time allowed, usually a limit or the keyword | Generate again. Or type the keyword yourself, ask for fewer slides, or pick an angle |
| **Failed** with *keyword: no usable candidate (…)* | Every word it suggested overlaps a live keyword | Type a keyword that doesn't, or reuse a live campaign's word |
| Generate answers *"Lesson 4.3 (…) is not indexed yet: index it first so the post has something true to say"* | A picked lesson has no notes | Index it, or write **From an idea** |
| **Failed**: *Writing this draft never finished: the request was cut off. Try again.* | The server's request died before the copy was saved | Delete the draft and generate again |
| *"A carousel is already being written. Wait for it to finish."* | One generation at a time on a page | Wait for the first to finish |

### Rendering

| Symptom | Cause | Fix |
|---|---|---|
| Stuck on **Rendering**, *Waiting for your Mac worker* | The worker is offline, so the render job waits | Start the worker. Drawing starts by itself (*"Nothing is lost: drawing starts by itself when the worker connects."*) |
| Stuck on **Rendering** while the worker is online | The render waits for the job the worker is running now, often a lesson uploading on a slow connection. Renders go next, but never interrupt | Wait for that job to end. With `indexConcurrency: 2` a render can run beside an index |
| Stuck on **Rendering**, and the log shows nothing about it | The job is claimed by a worker that died. It is handed out again once its heartbeat is 15 minutes old, and failed after three claims | The draft's latest render job (RUNBOOK). Once it has failed, **Render again** |
| **Failed**: *ffmpeg found no frame at …s in … (is t past the end?)* | A screenshot's time is past the end of its video, e.g. the video was re-exported shorter | **Change screenshot**, then save |
| **Failed**: *video_path not found: …* or *… is outside the course root* | The video was moved or renamed, or the worker that took the job is on a Mac without that file | Scan again and pick screenshots from the new lesson rows. Keep every worker's folder identical (section 3) |
| **Failed**: *The app rejected the worker's result: …* | The result did not fit the draft, e.g. a different number of images than slides | **Render again** |
| The preview shows old slides | There are unsaved edits, and the preview is the last render | **Save & update preview** |
| Uploads fail: *"No public address for this app: set it in Settings → TikTok app."* | No public address is configured anywhere | Settings → **TikTok app (platform admin)** → **Public site address** |

### Editing

| Symptom | Cause | Fix |
|---|---|---|
| **Problems to fix: n** when saving | The rules refused the edit. Nothing was saved | Each problem sits on its slide and field. `45 > 40` means shorten it. *instagram caption is missing the keyword ask «…»* means the Instagram caption needs your keyword line with the current keyword (you changed the keyword). *Latin digit next to Arabic text* means write ٣, not 3. Also: *highlight not in title*, *first slide must be cover*, *last slide must be cta*, *slides: 11 items, expected 6–10*, *compare sides differ in length* |
| *The campaign answers "X" but the carousel asks for "Y": they must be the same word* | The carousel's keyword and its campaign's differ (only possible through the API; the editor keeps them together) | Make them the same word |
| *"This draft is scheduled, so it can no longer be changed. Its posts are in Posts."* | Scheduled drafts are read-only | Delete its post in Posts, then write a new version from the same lesson |
| *"The draft changed while the slide was being rewritten. Reload it and try again."* | Another save landed during the rewrite | Reload the draft and rewrite again |
| A rewrite fails with problems | The rewritten slide still broke a rule, so nothing changed | Add an instruction and rewrite again, or edit the slide yourself |

### Keyword clash

**Symptom:** comments on the new post get another campaign's DM, or the schedule summary promises
a DM but no campaign was created for this keyword.

**Cause:** keyword matching is substring-based by default, so a live campaign on a shorter word
fires inside a longer one: `تم` inside `تمام`, `عيد` inside `سعيد`. The writer never *suggests* a
keyword that overlaps a live one, but a keyword you type is used as typed. At scheduling, a campaign
that already answers the keyword means no new one is created, and that older campaign's DM is what
commenters get.

**Fix:** on the Campaigns page, find the active campaign whose keyword sits inside yours. Switch it
to **word** matching, so it only fires on its whole word, or pick another keyword. For a draft not
yet scheduled, change its keyword in the editor (and the Instagram caption's keyword line with it),
save, then schedule. For one already scheduled, create the campaign for its keyword by hand on the
Campaigns page once the older one is on word matching.

### Scheduling and TikTok

| Symptom | Cause | Fix |
|---|---|---|
| **Schedule** is greyed out: *"Scheduling opens when the render is ready."* or *"Save your edits first…"* | Not drawn yet, or unsaved edits | Wait for **Ready**, or save |
| *"TikTok has not audited this app yet, so its posts go out private: queue this one for the TikTok batch instead."* | *Post at the same time* was asked for while unaudited (the form doesn't offer it then) | **Queue for TikTok** |
| **Post queued TikTok carousels** is greyed out: *"Nothing is queued for TikTok."* | No scheduled draft is waiting for TikTok | None needed |
| The batch is refused: *"TikTok is not connected. Connect it in Settings first."* | No active TikTok connection | Settings → connect TikTok |
| The batch is refused: *"Direct Post is not available: switch it on in Settings → TikTok app, then reconnect TikTok."* | The Direct Post switch is off, or the connection was made before it was on and lacks `video.publish` | A platform admin ticks *Direct Post is switched on for this app in the TikTok developer portal*; then reconnect TikTok to grant it |
| Fewer carousels sent than were queued | A draft was skipped for a reason of its own (its images, say) and stays in the queue; the rest went | The reason is in the batch's answer (`skipped`) and the audit log's `studio.tiktok_batch` detail. Fix it and press again |
| TikTok posts **Failed** in Posts: *"Until TikTok approves this app, direct posts only work when your TikTok account is set to private…"* | The account was public while they posted | Set the TikTok account to private, then retry them from Posts |
| TikTok posts **Failed**: *"TikTok can only fetch photos from a verified URL prefix…"* | The app's address is not verified in TikTok's developer portal | Verify it under **URL properties** ([`TIKTOK_GUIDE.md`](TIKTOK_GUIDE.md)), then retry |
| TikTok posts **Failed**: *"TikTok's daily posting limit for this account has been reached…"* | TikTok's own daily limit | Retry tomorrow |
| **Made public on TikTok** cannot be ticked | Its TikTok post has not been made yet | Send the batch first |

---

## 10. FAQ

**Does my Mac have to be on?**
Only for scanning, indexing and drawing slides. Writing a carousel, editing its words and scheduling
it all work with the Mac off. Drawing waits in the queue and starts by itself when the Mac is back.

**Can I close the page while it writes?**
Yes. The draft appears under **Drafts** when it is written, usually about a minute later.

**Are my videos uploaded anywhere?**
No. Only a small, low-resolution copy of the lesson being indexed goes to Gemini, and it is deleted
as soon as Gemini has answered. The thumbnails and the finished slides go to the app, because
Instagram and TikTok have to fetch them from somewhere.

**Will it post anything by itself?**
Only what you schedule, at the time you pick. Nothing goes to TikTok until you press **Post queued
TikTok carousels**, unless the app has been audited and you chose **Post to TikTok at the same
time**.

**Why is everything on TikTok "Only me"?**
Until TikTok audits the app, TikTok only allows it to post privately, and only to a private account.
That is what the queue, the batch and the **Made public on TikTok** tick are for (section 6).

**Can it make things up about my course?**
It is built not to. Every slide must rest on the lesson's notes, its moments, your product facts or
your own idea, and the only claims about the product it may make are your **Facts**. Still read a
draft before you schedule it: the notes are Gemini's reading of the lesson, and a reading can be
wrong.

**Why does every Instagram caption carry the same line?**
It is your keyword line from Settings. It tells people exactly which word to comment, and the
automation answers only that word.

**Why is there no "comment the keyword" on TikTok?**
TikTok cannot send an automatic DM, so the TikTok slides and caption point to the link in your bio
instead.

**Can I use a lesson that isn't indexed?**
No, because there is nothing true to write from yet. Index it first, or write **From an idea**.

**Can I choose the screenshots myself?**
Yes: **Change screenshot** on a slide, from any indexed lesson. Untick **Clean frames only** to see
every frame.

**Why did I get fewer slides than I asked for?**
A slide the writer could not back with a source was dropped. It never goes below 6.

**Can I change a carousel after scheduling it?**
No. Delete its post in **Posts**, then write a new version from the same lesson.

**What happens if I rename a video?**
The next scan finds it as a new lesson; index that one. Drafts made from the old name keep their
slides, but cannot be drawn again, because the old file is gone.

**Which languages does it write in?**
Arabic and English, chosen in Settings → **Voice** → **Carousel language**.

**Can two people use the Studio at once?**
Yes, on the same account: the drafts are shared, and each browser keeps its own unsaved edits. The
last save of a draft wins, so agree who edits which one.

**How many carousels can I make in a day?**
On Gemini's free tier, as many as the day's quota allows (section 8). With billing on, as many as
you like.

**Can someone else's worker see my jobs?**
No. A worker's token belongs to one account and sees only that account's jobs.

**Can I undo?**
A deleted slide: **Undo** for 12 seconds. Unsaved edits: **Discard changes**. A deleted draft: no.

---

## 11. Where things live

*Operator.*

| What | Where |
|---|---|
| The contract | [`STUDIO.md`](../STUDIO.md) |
| Routes | `src/routes/studio.ts`: `studioWorkerRouter`, mounted above `requireAuth` and authenticated by the worker token; `studioRouter`, below `resolveTenant`, operator role, owner for workers |
| The queue, and what each result does | `src/services/studio/jobs.ts` |
| The library | `src/services/studio/lessons.ts` |
| Drafts | `src/services/studio/drafts.ts` |
| The writer | `src/services/studio/generate.ts`, `prompts.ts`, `examples.ts` |
| The rules | `src/services/studio/rules.ts` |
| Scheduling and slots | `src/services/studio/schedule.ts`, `slots.ts` |
| Settings | `src/services/studio/settings.ts`, `settingsTypes.ts`; the creator's seed, `scripts/seed-studio-settings.mjs` |
| Workers and tokens | `src/services/studio/worker.ts` |
| The tables | `src/config/migration_v21_studio.sql`: `course_lessons`, `lesson_moments`, `carousel_drafts`, `studio_jobs`, `studio_settings`, `studio_workers` |
| The dashboard page and its words | `dashboard/js/pages/studio.js`, `dashboard/js/i18n.js` |
| A preview with no database, Gemini or worker | `node scripts/studio-harness.mjs`, then `http://localhost:4178/` |
| The worker | `~/Desktop/AI Course/aicourse-captions/scripts/studio-worker.mjs`, with `scripts/studio/`: `app.mjs` (the app's API), `gemini.mjs`, `library.mjs`, `proxy.mjs`, `render.mjs`, `util.mjs` |
| The slide templates | `src/carousel/Studio.tsx` (`Studio-ig`, `Studio-tt`), `brand.tsx`, `slides.tsx` in the worker's repo |
| Install and uninstall | `scripts/install-studio-worker.sh`, `scripts/uninstall-studio-worker.sh` |
| Testing the worker without the app | `node scripts/studio-mock-app.mjs` (the worker README, *Test it without the app*) |
| The worker's config | `studio.config.json` (gitignored, mode 600); `studio.config.example.json` |
| The worker's scratch | `.studio/`: proxies, renders, bundles, the one-copy lock |
| The log | `~/Library/Logs/aicourse-studio-worker.log` |
| The launchd agent | `~/Library/LaunchAgents/com.aicourse.studio-worker.plist` |

### Where the older documents are out of date

The code wins; these are the places the earlier documents disagree with it:

- **STUDIO.md §7** says the writer uses `gemini-2.5-pro`. It uses `STUDIO_MODELS`, section 5.
- **STUDIO.md §9** and the worker's README say indexing uploads the video to `gemini-2.5-flash`.
  It uploads a proxy, to `INDEX_MODELS`, and never uses `gemini-2.5-flash`.
- **STUDIO.md §2 and §4** list global `studio.worker_*` settings and `/api/studio/worker-token`.
  §10 replaced them with `studio_workers` and `/api/studio/workers`.
- **STUDIO.md §4** gives fixed 13:00 and 21:00 Riyadh slots. Slots come from each account's
  Schedule settings.
- The worker's README says the config's `name` is how the worker shows up in the dashboard. The
  app ignores it and shows the name typed when the worker was created.
- The render payload carries no `digits`, so the templates' own numerals follow **Slide
  direction**, not **Digits**.
