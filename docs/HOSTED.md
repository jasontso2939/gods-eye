# Hosted profile

`npm run build && npm run start:hosted` serves the built app and the same
providers as the dev server from one Node process, behind sign-in. It is
meant for you and people you invite, not open public access.

## Required settings

| Variable | Meaning |
| --- | --- |
| `GEV_AUTH_MODE` | `tokens` or `supabase`; the server refuses to start without it |
| `GEV_SESSION_SECRET` | 32+ random characters; signs the session cookie |
| `GEV_ACCESS_TOKEN` | tokens mode: one owner token (24+ characters) |
| `GEV_ACCESS_TOKENS` | tokens mode, several users: `alice:<24+ char token>:admin,bob:<token>` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | supabase mode: project URL and publishable key |
| `SUPABASE_JWT_SECRET` | supabase mode, legacy HS256 projects only; newer projects are verified through their JWKS |

## Recommended

| Variable | Meaning |
| --- | --- |
| `GEV_DATABASE_URL` | Postgres (Supabase works: use the pooled connection string with `sslmode=require`) so history survives redeploys |
| `GEV_ALLOWED_USERS` | supabase mode: comma-separated emails or user ids allowed in; sign-up is disabled on the login page either way |
| `GEV_ADMIN_USERS` | emails, user ids or token names that may edit recorder regions |
| `GEV_PUBLIC_ORIGIN` | e.g. `https://eye.example.com`; pins the allowed Origin for writes |
| `GEV_QUOTAS` | per-user limits, e.g. `/api/realtime/token=10/3600,*=900/60` |
| `GEV_TRUST_PROXY=1` | behind Fly/Render/Cloudflare, use forwarded client IP and host |

Browser-visible keys (`GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`) are baked in
at build time and must be referrer-restricted to your domain (SECURITY.md).

## What changes when hosted

- Every page and API call needs a session; unauthenticated API calls get 401.
- Writes must carry your own Origin; cookies are HttpOnly, SameSite=Lax, Secure.
- Each user has their own watchlists, fences, rules, webhooks and alerts.
- Per-user quotas protect the operator's API allowances; 429 with Retry-After.
- Not mounted: in-app key setup (writes `.env`), local receivers (LAN
  devices), realtime debug log, and the alert simulator.
- DelDOT live video defaults off (`CCTV_DELDOT_ENABLED=0`): its terms do not
  clearly allow redistribution.

## Guest (view-only) logins

Any token without `:admin` is a guest. Guests can use the whole map, but:

- voice control is off (`/api/claude/turn`, `/api/realtime/token`,
  `/api/openai/*`), so they cannot spend your AI budget. Set
  `GEV_GUEST_VOICE=1` to let them use it within the same caps;
- they cannot create, change or delete watch rules, webhooks, alerts or
  history jobs (`/api/watch/*`, `/api/history/*` are read-only for them);
- there is nothing in the site that edits code, environment variables or
  keys for anyone; those live only in GitHub and Render.

Example for family and friends, keeping your own `GEV_ACCESS_TOKEN`:

    GEV_ACCESS_TOKENS=family:<a 24+ character passphrase>

Sessions last at most 12 hours and are re-checked on every request. Change
or delete a token and everyone using it is signed out on the next click;
remove `:admin` and that user loses admin at once.

## Claude voice control

Set `ANTHROPIC_API_KEY` and the mic button uses Claude instead of OpenAI
Realtime. The browser turns speech into text (Chrome, Edge or Safari), the
server sends it to Claude with the map actions as tools, and the browser
speaks the reply. The key never reaches the browser.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEV_CLAUDE_MONTHLY_CAP_USD` | `5` | Hard monthly cap enforced by the server |
| `GEV_CLAUDE_DAILY_CAP_USD` | `1` | Hard daily cap enforced by the server |
| `GEV_CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Must have a known price in `server/providers/claude/ledger.js` |
| `GEV_CLAUDE_MAX_TOKENS` | `600` | Reply cap per call |
| `GEV_VOICE_PROVIDER` | auto | `openai` forces the old backend even with a Claude key |

Before each call the server reserves the worst case (all input uncached plus
the full reply cap) and refuses the call if that would cross either cap; after
the call it books the real cost from the response. The ledger lives in the
history store, so on the free Render plan without `GEV_DATABASE_URL` it resets
when the service restarts. Back it with Anthropic's own limits: a workspace
spend limit in the Claude Console, and prepaid credits with auto-reload off.

## Deploy on Render (fastest)

`render.yaml` is a Render Blueprint. Open
`https://render.com/deploy?repo=https://github.com/<you>/<repo>`, approve it,
and leave the optional keys blank. Render generates `GEV_ACCESS_TOKEN` and
`GEV_SESSION_SECRET`; copy the token from the service's Environment tab and
paste it on the site's `/login` page.

The free plan sleeps after idle time and has no persistent disk, so recorded
history and alert rules reset on restart. Add `GEV_DATABASE_URL` (any
Postgres, e.g. Supabase or Render Postgres) to keep them, and use a paid
instance if the recorder should run around the clock.

## Deploy on Fly.io

```bash
fly launch --no-deploy            # uses the included fly.toml and Dockerfile
fly secrets set GEV_AUTH_MODE=tokens \
  GEV_SESSION_SECRET="$(openssl rand -base64 48)" \
  GEV_ACCESS_TOKENS="you:$(openssl rand -hex 24):admin" \
  GEV_DATABASE_URL="postgres://…"
fly deploy
```

Any container host works the same way (Render, Railway, a VPS): run the
image, set the secrets, expose port 8080, health check `GET /healthz`.

## Before inviting anyone else

Check each data source's terms for your use (DATA_SOURCES.md). In
particular: Cesium ion's free plan is for eligible non-commercial use;
OpenSky data is non-commercial; adsb.lol is ODbL, which applies share-alike
to databases derived from it, and the recorded track store counts as one;
CC BY camera providers need their attribution kept.
