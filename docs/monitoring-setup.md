# Uptime Monitoring Setup

## Architecture

| Layer | Service | Interval | Purpose |
|-------|---------|----------|---------|
| Primary | CF Workers cron (`* * * * *`) | 1 min | Fast alerting via email, runs on CF edge |
| Secondary | GitHub Actions (`uptime-monitor.yml`) | 5 min | Independent fallback signal |

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

### Verify it is active

```bash
# Confirm the endpoint is healthy right now
curl -o /dev/null -s -w "%{http_code}\n" https://mtuaefans.com/api/healthz
# Expected: 200

# Check CF dashboard → Workers & Pages → dubai-fans-api → Triggers → Cron Triggers
# You should see "* * * * *" listed as active.
```

To see live check logs:

```bash
cd dubai-fans-api
npx wrangler tail --format pretty
# Look for "uptime-monitor: health check OK" every minute
```

### Alert configuration

| Setting | Value |
|---------|-------|
| Endpoint | `https://mtuaefans.com/api/healthz` |
| Interval | 1 minute |
| Timeout | 30 seconds |
| Alert recipient | `ADMIN_EMAIL` (CF Worker secret) |
| Alert sender | Resend API (`RESEND_API_KEY` CF Worker secret) |
| Alert trigger | Any non-200 HTTP status or network error |

---

## Optional: BetterStack Uptime (additional redundancy)

BetterStack free tier: 10 monitors, 3-minute minimum check interval.
For 1-minute polling use the **Starter** plan ($24/mo).

### Steps

1. Sign up at <https://uptime.betterstack.com>.
2. Click **New monitor**.
3. Fill in:
   - **Name:** `Dubai Fans API`
   - **URL:** `https://mtuaefans.com/api/healthz`
   - **Monitor type:** `HTTPS`
   - **Check frequency:** `1 minute` (Starter) or `3 minutes` (free)
   - **Request timeout:** `30 seconds`
   - **Confirm down after:** `1 failure`
4. Under **Alerts**, add your email and/or a Slack/webhook channel.
5. Save. The monitor starts immediately.

---

## Secondary check (GitHub Actions)

`dubai-fans-api/.github/workflows/uptime-monitor.yml` runs every 5 minutes as a
backup. It is intentionally kept alongside the primary CF cron to provide a
second independent signal. No changes needed — it will auto-trigger on the
`*/5 * * * *` schedule.
