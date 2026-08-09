# Dubai Fans API — Project Overview

Production-ready REST API and website for [Dubai Fans Digital Marketing](https://mtuaefans.com).

## Stack

| Layer | Technology |
|---|---|
| Framework | Express 5 + TypeScript |
| Runtime | Node.js 20 (ESM) |
| Database | PostgreSQL (Neon) via Drizzle ORM |
| Edge Worker | Cloudflare Workers (`src/worker.ts`) |
| Auth | HMAC-signed HttpOnly cookies |
| Email | Nodemailer (SMTP) |
| Storage | Cloudflare R2 |
| AI | OpenAI (GPT-4o) |

## Key URLs

| Resource | URL |
|---|---|
| Production site | <https://mtuaefans.com> |
| Health check | <https://mtuaefans.com/api/healthz> |
| **Public status page** | **<https://mahmoudterak.github.io/dubai-fans-api/>** |
| Status redirect | <https://mtuaefans.com/status> → redirects to GitHub Pages status page |

## Status Page

The status page is hosted on **GitHub Pages** (independent of the production server —
stays up during outages):

**<https://mahmoudterak.github.io/dubai-fans-api/>**

- Live health check polling `/api/healthz` every 60 s
- Uptime history from last 90 GitHub Actions runs (green/red bar chart)
- Source: `gh-pages` branch → `index.html`

`mtuaefans.com/status` issues a 301 redirect to the GitHub Pages URL via a dedicated
Cloudflare Worker route. The `STATUS_PAGE_URL` Worker secret controls the redirect
target; update it with `wrangler secret put` if the URL ever changes.

## Monitoring

| Layer | Service | Interval |
|---|---|---|
| Primary | CF Workers cron (`* * * * *`) | 1 min |
| Secondary | GitHub Actions (`uptime-monitor.yml`) | 5 min |

See [`docs/monitoring-setup.md`](docs/monitoring-setup.md) for full setup details.

## User Preferences

- TypeScript strict mode throughout
- ESM modules (`"type": "module"` in package.json)
- Pino for structured logging (no `console.log` in production code)
- Drizzle ORM for all database access
- No silent error swallowing — always log or rethrow
