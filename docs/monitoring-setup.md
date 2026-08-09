# Uptime Monitoring Setup

## Architecture

| Layer | Service | Interval | Purpose |
|-------|---------|----------|---------|
| Primary | CF Workers cron (`* * * * *`) | 1 min | Fast alerting via email, runs on CF edge |
| Secondary | GitHub Actions (`uptime-monitor.yml`) | 5 min | Independent fallback signal |

---

## Public Status Page

The live status page is hosted on **GitHub Pages** — completely independent of the
production server, so it remains reachable even during full outages:

**<https://mahmoudterak.github.io/dubai-fans-api/>**

`mtuaefans.com/status` redirects there automatically (via the CF Worker route).

The page shows:
- **Live health check** — polls `/api/healthz` every 60 seconds in-browser
- **Uptime history** — last 90 GitHub Actions uptime-monitor runs shown as a colour-coded bar chart
- **Incident indicators** — red bars for failed checks, green for passing

Source: `gh-pages` branch → `index.html`

---

## Primary monitor — Cloudflare Workers cron (active)

The primary monitor is built directly into the deployed Worker.

### How it works

A `* * * * *` cron trigger runs `runUptimeCheck()` every minute on Cloudflare's
edge network (`src/lib/uptime-monitor.ts`). It:

1. Fetches `https://mtuaefans.com/api/healthz` with a 30-second timeout.
2. If the status is not 200 (or the fetch throws / times out), sends an alert
   email to `ADMIN_EMAIL` via the Resend API (`RESEND_API_KEY`).
3. Logs every check result to Cloudflare Workers observability.

Because cron triggers run on CF's infrastructure independently from
request-handling, this provides true external monitoring: even a cold-start
failure or a non-200 response will be detected within 60 seconds.

### Alert configuration

| Setting | Value |
|---------|-------|
| Endpoint | `https://mtuaefans.com/api/healthz` |
| Interval | 1 minute |
| Timeout | 30 seconds |
| Alert recipient | `ADMIN_EMAIL` (CF Worker secret) |
| Alert sender | Resend API (`RESEND_API_KEY` CF Worker secret) |
| Alert trigger | Any non-200 HTTP status or network error |

### Verify it is active

```bash
# Confirm the endpoint is healthy
curl -o /dev/null -s -w "%{http_code}\n" https://mtuaefans.com/api/healthz
# Expected: 200

# Confirm /status redirect works
curl -sI https://mtuaefans.com/status | head -5

# Live cron logs
cd dubai-fans-api && npx wrangler tail --format pretty
```

---

## Secondary check (GitHub Actions)

`dubai-fans-api/.github/workflows/uptime-monitor.yml` runs every 5 minutes as a
backup. Results appear as green/red bars on the status page automatically — no
extra configuration needed.

---

## Optional: BetterStack Uptime (additional redundancy)

BetterStack free tier: 10 monitors, 3-minute minimum check interval.
For 1-minute polling use the **Starter** plan ($24/mo).

1. Sign up at <https://uptime.betterstack.com> → **New monitor**.
2. URL: `https://mtuaefans.com/api/healthz` · type: HTTPS · timeout: 30 s
3. To replace the GitHub Pages status page with BetterStack's hosted page,
   update the `STATUS_PAGE_URL` Worker secret:
   ```bash
   echo "https://<your-slug>.betteruptime.com" | npx wrangler secret put STATUS_PAGE_URL --name dubai-fans-api
   ```
