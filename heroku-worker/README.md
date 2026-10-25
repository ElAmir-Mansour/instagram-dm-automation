# heroku-worker: the 60-second drain

One file, `worker.mjs`, with no dependencies (Node 22, native `fetch`). It runs as a Heroku **worker** dyno on the app
`autoreply-pro-worker` and runs two loops of its own:

| Loop | Calls | Every | Why |
|---|---|---|---|
| drain | `GET /api/jobs/drain` | 60 s after the last one finished (`POLL_INTERVAL_MS`) | processes queued comment/DM jobs, publishes due posts, and runs the drain's sweeps (ads guard and rules, the Monteur, …) |
| draft sweep | `POST /api/onboarding/drafts/sweep` | 60 s after the last one finished (`DRAFT_SWEEP_INTERVAL_MS`) | advances tenant profile drafts nobody is working on. **Nothing else calls this route**: scale the worker to zero and it stops |

Both send `Authorization: Bearer $CRON_SECRET` and wait up to 290 s (`REQUEST_TIMEOUT_MS`), just under Vercel's 300 s limit.
It never touches the database and needs no Meta or AI credentials. Why it exists, and the other drain callers (the webhook
itself, `.github/workflows/drain.yml`, Vercel's daily cron), are in the header of `worker.mjs` and in `RUNBOOK.md`.

## Is it on?

On 2026-10-25 it was: Vercel's logs showed `GET /api/jobs/drain` and the draft sweep once a minute. To check:

```bash
heroku ps -a autoreply-pro-worker            # needs `heroku login`; "worker.1: up" means on
```

or look for `/api/jobs/drain` once a minute in the Vercel logs.

## On and off

```bash
heroku ps:scale worker=1 -a autoreply-pro-worker   # on: one worker dyno, about $7 a month (Heroku has no free dyno)
heroku ps:scale worker=0 -a autoreply-pro-worker   # off: $0
```

Turning it off has two side effects: set `FREQUENT_SWEEP` to `false` in `dashboard/js/pages/posts.js` (otherwise the Posts screen
promises minutes that the daily cron cannot keep), and know that onboarding drafts then advance only when the setup wizard or the
Tenants screen asks for them.

## Settings (Heroku config vars)

| Var | Needed | Default | What |
|---|---|---|---|
| `CRON_SECRET` | yes | none: the worker exits | must equal the app's (Vercel) and the GitHub repository secret; a rotation changes all three |
| `DRAIN_BASE_URL` | no | `https://msg-response-auto.vercel.app` | the app's address (note: `drain.yml` calls its own variable `BASE_URL`) |
| `POLL_INTERVAL_MS` | no | `60000` | pause between drains |
| `DRAFT_SWEEP_INTERVAL_MS` | no | `60000` | pause between draft sweeps |
| `REQUEST_TIMEOUT_MS` | no | `290000` | how long one call may take |

## Logs

```bash
heroku logs --tail -a autoreply-pro-worker
```

One JSON line per event: `worker.started`, `worker.drain_ok`, `worker.drain_bad_status` (the app answered, not 200),
`worker.drain_failed` (no answer, or the timeout), `worker.sweep_started`, `worker.sweep_ok`, `worker.sweep_bad_status`,
`worker.sweep_failed`, `worker.sigterm`.

## Deploy a change

Heroku runs what the `Procfile` says (`worker: node worker.mjs`). Push this folder on its own over HTTPS (SSH to Heroku timed
out from this setup):

```bash
cd heroku-worker && git init -q && git add -A && git commit -q -m "worker"
git push https://heroku:$HEROKU_API_KEY@git.heroku.com/autoreply-pro-worker.git HEAD:main
```

A change to comments only needs no deploy.
