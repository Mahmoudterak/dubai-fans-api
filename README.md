# Dubai Fans API Server

Production-ready Express 5 REST API for [Dubai Fans Digital Marketing](https://mtuaefans.com).

> Extracted from the original pnpm monorepo into a fully independent repository.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Express 5 + TypeScript |
| Runtime | Node.js 20 (ESM) |
| Database | PostgreSQL via Drizzle ORM |
| Auth | HMAC-signed HttpOnly cookies (admin / student / company) |
| Email | Nodemailer |
| Storage | Google Cloud Storage |
| AI | OpenAI (GPT-4o) |
| Build | esbuild (single bundled file) |
| Migrations | Drizzle migrator (auto-runs at boot) |

---

## Quick Start

```bash
cp .env.example .env
# Fill in all required values

pnpm install
pnpm dev        # tsx watch — runs from source
```

---

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Run from source with hot-reload (tsx) |
| `pnpm build` | Bundle with esbuild → `dist/index.mjs` |
| `pnpm start` | Start the production bundle |
| `pnpm typecheck` | TypeScript check (no emit) |
| `pnpm migrate` | Run pending migrations manually |
| `pnpm db:generate` | Generate Drizzle migration from schema changes |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values.

### Required

| Variable | Description |
|---|---|
| `PORT` | Server port (Railway sets this automatically) |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | 64-byte random hex — signs all session cookies |
| `ADMIN_PASSWORD` | Password for the admin panel |
| `APP_URL` | `https://api.mtuaefans.com` (used in emails + OAuth) |

### Optional

| Variable | Description |
|---|---|
| `ADMIN_EMAIL` | Email to receive new-demo / new-order notifications |
| `GOOGLE_CLIENT_ID` | Google OAuth (student login) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth (student login) |
| `SMTP_HOST / PORT / USER / PASS` | Transactional email |
| `OPENAI_API_KEY` | AI tools (analyze, tools, AI Business OS) |
| `EXTRA_CORS_ORIGIN` | One extra allowed CORS origin (e.g. Pages branch preview) |

---

## Allowed CORS Origins

| Origin | Always allowed? |
|---|---|
| `https://mtuaefans.com` | ✅ |
| `https://www.mtuaefans.com` | ✅ |
| `https://dubai-fans-website.pages.dev` | ✅ |
| `http://localhost:5173` | ✅ (dev only) |
| `http://localhost:4173` | ✅ (dev only) |
| `EXTRA_CORS_ORIGIN` env var | ✅ (when set) |

---

## Deployment — Railway

### One-click deploy

1. Create a new Railway project
2. Add a **PostgreSQL** database service
3. Connect this repository
4. Railway auto-detects `railway.json` — no extra config needed
5. Set environment variables in the Railway dashboard
6. The server boots, runs migrations automatically, then starts serving

### Health check

`GET /healthz` → `200 OK` — used by Railway for readiness checks.

---

## Deployment — Docker

```bash
docker build -t dubai-fans-api .
docker run -p 3000:3000 --env-file .env dubai-fans-api
```

---

## Connecting to the Frontend

The standalone frontend (`dubai-fans-website`) calls `/api/*` routes. In production:

1. Deploy this API to Railway → get URL e.g. `https://dubai-fans-api.up.railway.app`
2. In Cloudflare Pages, add a **redirect rule** (or Workers proxy):
   ```
   /api/* → https://dubai-fans-api.up.railway.app/api/:splat  [proxy 200]
   ```
3. Or set `VITE_API_BASE_URL=https://dubai-fans-api.up.railway.app` in the frontend build

---

## API Routes

| Prefix | Description |
|---|---|
| `GET /healthz` | Health check |
| `GET/POST /api/blog/*` | Blog posts (public + admin CRUD) |
| `POST /api/analyze` | AI business analysis |
| `GET/POST /api/tools/*` | Free marketing tools (keywords, hashtags, SEO) |
| `POST /api/course-register` | Course enrollment |
| `POST /api/website-orders` | Website order requests |
| `POST /api/demo-requests` | Product demo requests |
| `POST /api/seo-report` | SEO report generation |
| `GET/POST /api/student/*` | Student auth + dashboard + certificates |
| `GET/POST /api/company/*` | Company portal auth + reports |
| `GET/POST /api/ai-business-os/*` | AI Business OS (audits, chat, plans) |
| `POST /api/business-audit` | Business audit requests |
| `GET/POST /api/admin/*` | Admin panel (clients, orders, leads) |
| `GET /api/storage/*` | Object storage proxy |
| `POST /api/sitemap/rebuild` | Rebuild sitemap cache (internal) |

---

## Database

Migrations live in `migrations/` and are applied automatically at server boot via Drizzle's programmatic migrator. No TTY or manual steps needed.

To generate a new migration after schema changes:
```bash
pnpm db:generate
# then commit the generated .sql file
```

---

## License

MIT © Dubai Fans Digital Marketing
