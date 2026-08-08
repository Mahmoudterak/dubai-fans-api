# ── Stage 1: Build ───────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm (compatible with Node 22)
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

# Copy dependency files
COPY package.json pnpm-lock.yaml* ./

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build project
RUN pnpm build

# ── Stage 2: Production ──────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

# Copy dependency files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy compiled application
COPY --from=builder /app/dist ./dist

# Copy required runtime files
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/public ./public

# Security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node","--enable-source-maps","./dist/index.mjs"]
