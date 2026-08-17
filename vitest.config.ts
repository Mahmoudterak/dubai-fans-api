import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const r = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    // 120 s to accommodate CLI-spawn tests (schema-drift suite)
    testTimeout: 120_000,
    include: [
      "src/tests/**/*.test.ts",
      "src/routes/__tests__/**/*.test.ts",
    ],
  },
  resolve: {
    // Array form: more-specific prefixes matched first.
    alias: [
      { find: "@workspace/db/migrate", replacement: r("src/vendor/db/migrate.ts") },
      { find: "@workspace/db/schema",  replacement: r("src/vendor/db/schema/index.ts") },
      { find: "@workspace/db",         replacement: r("src/vendor/db/index.ts") },
      {
        find: "@workspace/integrations-openai-ai-server",
        replacement: r("src/vendor/integrations-openai/index.ts"),
      },
      {
        find: "@workspace/api-zod",
        replacement: r("src/vendor/api-zod/index.ts"),
      },
      {
        find: "@workspace/blog-data",
        replacement: r("src/vendor/blog-data/index.ts"),
      },
    ],
  },
});
