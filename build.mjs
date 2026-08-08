import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, cp } from "node:fs/promises";

globalThis.require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWorker  = process.argv[2] === "worker";

/** Workspace package aliases — shared by both builds. */
const ALIASES = {
  "@workspace/db":                                  path.resolve(__dirname, "src/vendor/db/index.ts"),
  "@workspace/db/migrate":                          path.resolve(__dirname, "src/vendor/db/migrate.ts"),
  "@workspace/db/schema":                           path.resolve(__dirname, "src/vendor/db/schema/index.ts"),
  "@workspace/api-zod":                             path.resolve(__dirname, "src/vendor/api-zod/index.ts"),
  "@workspace/blog-data":                           path.resolve(__dirname, "src/vendor/blog-data/index.ts"),
  "@workspace/integrations-openai-ai-server":       path.resolve(__dirname, "src/vendor/integrations-openai/index.ts"),
  "@workspace/integrations-openai-ai-server/batch": path.resolve(__dirname, "src/vendor/integrations-openai/batch/index.ts"),
  "@workspace/integrations-openai-ai-server/image": path.resolve(__dirname, "src/vendor/integrations-openai/image/index.ts"),
  "@workspace/integrations-openai-ai-server/audio": path.resolve(__dirname, "src/vendor/integrations-openai/audio/index.ts"),
};

async function buildAll() {
  const distDir = path.resolve(__dirname, "dist");
  await rm(distDir, { recursive: true, force: true });

  if (isWorker) {
    await buildWorker(distDir);
  } else {
    await buildNode(distDir);
  }
}

// ── Node.js build (pnpm build) ─────────────────────────────────────────────────

async function buildNode(distDir) {
  await esbuild({
    entryPoints: [path.resolve(__dirname, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    alias: ALIASES,
    external: [
      "*.node", "sharp", "better-sqlite3", "sqlite3", "canvas",
      "bcrypt", "argon2", "fsevents", "re2", "farmhash", "xxhash-addon",
      "bufferutil", "utf-8-validate", "ssh2", "cpu-features",
      "dtrace-provider", "isolated-vm", "lightningcss", "pg-native",
      "oracledb", "mongodb-client-encryption", "nodemailer", "handlebars",
      "knex", "typeorm", "protobufjs", "onnxruntime-node",
      "@tensorflow/*", "@prisma/client", "@mikro-orm/*", "@grpc/*",
      "@swc/*", "@aws-sdk/*", "@azure/*", "@opentelemetry/*",
      "@google-cloud/*", "@google/*", "googleapis", "firebase-admin",
      "@parcel/watcher", "@sentry/profiling-node", "aws-sdk",
      "classic-level", "dd-trace", "ffi-napi", "grpc", "hiredis",
      "kerberos", "leveldown", "miniflare", "mysql2", "newrelic",
      "odbc", "piscina", "realm", "ref-napi", "rocksdb", "sass-embedded",
      "sequelize", "serialport", "snappy", "tinypool", "usb", "workerd",
      "wrangler", "zeromq", "zeromq-prebuilt", "playwright", "puppeteer",
      "puppeteer-core", "electron",
    ],
    sourcemap: "linked",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';
globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
`,
    },
  });

  // Copy migrations alongside the bundle so the migrate CLI finds them
  await cp(
    path.resolve(__dirname, "migrations"),
    path.resolve(distDir, "migrations"),
    { recursive: true },
  );

  console.log("✅ Node.js build complete → dist/index.mjs");
}

// ── CF Workers build (pnpm build:worker) ──────────────────────────────────────

async function buildWorker(distDir) {
  await esbuild({
    entryPoints: [path.resolve(__dirname, "src/worker.ts")],
    // CF Workers is browser-like (no Node.js built-ins except via nodejs_compat)
    platform: "browser",
    bundle: true,
    format: "esm",
    outfile: path.join(distDir, "worker.mjs"),
    logLevel: "info",
    target: "es2022",
    alias: {
      ...ALIASES,
    },
    // Redirect GCS backend to a no-op stub — GCS uses Node.js APIs / Replit
    // sidecar that are never available in CF Workers (R2 is used instead).
    plugins: [
      {
        name: "gcs-stub",
        setup(build) {
          build.onResolve({ filter: /gcs-backend[^-]/ }, (args) => ({
            path: path.resolve(__dirname, "src/lib/storage/gcs-backend-stub.ts"),
          }));
        },
      },
    ],
    external: [
      // Node.js built-ins — provided by CF Workers nodejs_compat at runtime.
      // Must list both "node:*" forms and bare forms since npm packages use both.
      "node:async_hooks", "node:buffer", "node:child_process", "node:crypto",
      "node:dns", "node:domain", "node:events", "node:fs", "node:fs/promises",
      "node:http", "node:https", "node:net", "node:os", "node:path",
      "node:process", "node:querystring", "node:readline", "node:stream",
      "node:stream/promises", "node:stream/web", "node:string_decoder",
      "node:timers", "node:timers/promises", "node:tls", "node:url",
      "node:util", "node:util/types", "node:worker_threads", "node:zlib",
      "assert", "async_hooks", "buffer", "child_process", "constants",
      "crypto", "dns", "domain", "events", "fs", "http", "https",
      "module", "net", "os", "path", "perf_hooks", "process",
      "punycode", "querystring", "readline", "stream", "string_decoder",
      "timers", "tls", "trace_events", "tty", "url", "util",
      "v8", "vm", "wasi", "worker_threads", "zlib",
      // Should never appear in the worker bundle
      "*.node", "@google-cloud/*", "pino", "pino-pretty", "pino-http",
      "compression", "nodemailer",
    ],
    // No banner / no __dirname shim needed for CF Workers
  });

  console.log("✅ CF Workers build complete → dist/worker.mjs");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
