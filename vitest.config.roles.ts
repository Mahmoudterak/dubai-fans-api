import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    name: "roles",
    include: ["src/tests/role-restrictions.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 10_000,
    env: {
      NODE_ENV: "test",
      SESSION_SECRET: "test-secret-for-role-restrictions",
    },
  },
  resolve: {
    alias: {
      "@workspace/db": resolve(__dirname, "src/vendor/db/index.ts"),
      "@workspace/db/schema": resolve(__dirname, "src/vendor/db/schema/index.ts"),
    },
  },
});
