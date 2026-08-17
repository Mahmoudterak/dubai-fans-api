import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Include both the schema-drift tests and the general test suite.
    include: ["src/tests/**/*.test.ts", "src/vendor/db/*.test.ts"],
    environment: "node",
    // Individual CLI spawn tests can take up to 90 s; give the suite headroom.
    testTimeout: 120_000,
  },
});
