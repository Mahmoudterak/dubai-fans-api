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

## Status Page — BetterStack hosted (recommended)

BetterStack includes a **free hosted status page** that lives on BetterStack's
infrastructure — it stays up even when your server is down.

### Enabling the status page

1. In the BetterStack dashboard, go to **Status Pages** → **Create status page**.
2. Fill in:
   - **Name:** `Dubai Fans API Status`
   - **Subdomain:** e.g. `dubaifans` → your page will be at `https://dubaifans.betteruptime.com`
   - **Custom domain** *(optional)*: point a CNAME record from `status.mtuaefans.com`
     to `dubaifans.betteruptime.com` and enter `status.mtuaefans.com` here.
3. Under **Monitors on this page**, add the `Dubai Fans API` monitor you created above.
4. Under **History**, enable **Show incident history** (default: on).
5. Optionally set a logo, accent color, and company name.
6. Click **Publish**.

### Linking the status page to the app

After you have the public URL (e.g. `https://dubaifans.betteruptime.com`):

1. Set the `STATUS_PAGE_URL` environment variable in production:
   ```
   STATUS_PAGE_URL=https://dubaifans.betteruptime.com
   ```
2. The app's `/status` route (`mtuaefans.com/status`) will then issue a **301
   redirect** to the BetterStack page automatically.
3. Update `replit.md` with the final URL so the team can find it quickly.

### What the status page shows

- **Current status** — operational / degraded / outage banner
- **Uptime percentage** — rolling 30-day and 90-day windows
- **Response time graph** — P50/P95 latency over time
- **Incident history** — every past incident with start time, duration, and
  any posted updates

---

## UptimeRobot — alternative (free, 5-min interval)

UptimeRobot free tier polls every **5 minutes**, same as GitHub Actions — no improvement.
Use BetterStack or pay for UptimeRobot Pro ($7/mo) if you need sub-5-minute polling.

If you still prefer UptimeRobot free:

1. Sign up at <https://uptimerobot.com>.
2. **Add New Monitor**:
   - **Monitor type:** `HTTP(s)`
   - **Friendly name:** `Dubai Fans API`
   - **URL:** `https://mtuaefans.com/api/healthz`
   - **Monitoring interval:** `5 minutes`
3. Add alert contacts (email, Slack, etc.).
4. Save.
5. Go to **Status Pages** → **Create new** and add the monitor.

---

## Secondary check (GitHub Actions)

`dubai-fans-api/.github/workflows/uptime-monitor.yml` runs every 5 minutes as a
backup. It is intentionally kept alongside the primary CF cron to provide a
second independent signal. No changes needed — it will auto-trigger on the
`*/5 * * * *` schedule.

---

## Verification

```bash
# Confirm the endpoint returns 200
curl -o /dev/null -s -w "%{http_code}\n" https://mtuaefans.com/api/healthz

# Confirm the /status redirect is live
curl -I https://mtuaefans.com/status
```

Expected output for `/healthz`: `200`
Expected output for `/status`: `HTTP/2 301` (with `Location` pointing to the status page URL)

To test alerting, temporarily deploy a version that returns a non-200 status and
confirm the CF cron and/or BetterStack fires an alert within the expected interval.

---
