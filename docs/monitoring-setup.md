# Uptime Monitoring Setup

## Architecture

| Layer | Service | Interval | Purpose |
|-------|---------|----------|---------|
| Primary | BetterStack Uptime (free) | 1 min | Fast alerting, status page, incident history |
| Secondary | GitHub Actions (`uptime-monitor.yml`) | 5 min | Independent fallback signal |

---

## BetterStack Uptime — one-time setup

BetterStack free tier: 10 monitors, 3-minute minimum check interval (1-minute on paid).
For 1-minute polling use the **Starter** plan ($24/mo) or UptimeRobot free (see below).

### Steps

1. Sign up at <https://uptime.betterstack.com> (free plan is sufficient for 3-min interval).
2. Click **New monitor**.
3. Fill in:
   - **Name:** `Dubai Fans API`
   - **URL:** `https://mtuaefans.com/api/healthz`
   - **Monitor type:** `HTTPS`
   - **Check frequency:** `1 minute` (requires Starter) or `3 minutes` (free)
   - **Request timeout:** `30 seconds`
   - **Confirm down after:** `1 failure` (alert immediately)
4. Under **Alerts**, add your email and/or a Slack/webhook channel.
5. Save. The monitor starts immediately.

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

---

## Verification

After the monitor is active, verify it works:

```bash
# Confirm the endpoint returns 200
curl -o /dev/null -s -w "%{http_code}\n" https://mtuaefans.com/api/healthz
```

Expected output: `200`

To test alerting, temporarily deploy a version that returns a non-200 status and
confirm BetterStack/UptimeRobot fires an alert within the expected interval.

---

## Secondary check (GitHub Actions)

`dubai-fans-api/.github/workflows/uptime-monitor.yml` runs every 5 minutes as a
backup. It is intentionally kept alongside the primary external monitor to provide
a second independent signal. No changes needed — it will auto-trigger on the
`*/5 * * * *` schedule.
