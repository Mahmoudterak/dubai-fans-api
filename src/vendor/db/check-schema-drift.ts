/**
 * Schema drift detector.
 *
 * Compares the current Drizzle schema against the latest migration snapshot.
 * If drizzle-kit would generate new SQL, the schema has drifted — someone
 * edited a schema file without adding a migration.
 *
 * Exit codes (CLI):
 *   0 — schema matches the latest migration (no drift)
 *   1 — drift detected OR generator failure; details printed to stderr
 *
 * Usage:
 *   pnpm run check-drift
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DriftResult =
  | { ok: true }
  | { ok: false; reason: "drift"; pendingSQL: string[] }
  | { ok: false; reason: "generator_error"; stdout: string; stderr: string };

/**
 * Check whether the Drizzle schema at `dbRoot` has drifted ahead of the
 * migrations stored in `<dbRoot>/migrations`.
 *
 * @param dbRoot  Absolute path to the project root.
 *                Defaults to the project root derived from this file's location.
 */
export async function checkSchemaDrift(dbRoot: string): Promise<DriftResult> {
  const migrationsDir = join(dbRoot, "migrations");

  // drizzle-kit binary resolved from dbRoot so callers don't need it on PATH.
  // In test scenarios dbRoot may be a temp dir with a node_modules symlink —
  // that also works because the symlink points to the real installation.
  const dkBin = join(dbRoot, "node_modules/.bin/drizzle-kit");

  const tempDir = mkdtempSync(join(tmpdir(), "drizzle-drift-"));

  try {
    // 1. Copy migrations (with meta snapshots) so drizzle-kit diffs from the
    //    last known state rather than generating everything from scratch.
    cpSync(migrationsDir, join(tempDir, "migrations"), { recursive: true });

    const sqlBefore = new Set(
      readdirSync(join(tempDir, "migrations")).filter((f) =>
        f.endsWith(".sql"),
      ),
    );

    // 2. Write a minimal drizzle config.
    //
    //    IMPORTANT: drizzle-kit 0.31.x prepends "./" to the `out` value via
    //    string concatenation rather than path.resolve, so an absolute path
    //    produces ".//tmp/…" and silently fails with exit 0.  Using a
    //    relative `out` (resolved against cwd=tempDir below) avoids this bug.
    const schemaPath = join(dbRoot, "src/vendor/db/schema/index.ts");
    const tempConfig = join(tempDir, "drizzle.drift.config.mjs");
    writeFileSync(
      tempConfig,
      [
        `import { defineConfig } from "drizzle-kit";`,
        `export default defineConfig({`,
        `  schema: ${JSON.stringify(schemaPath)},`,
        `  out: "./migrations",`,
        `  dialect: "postgresql",`,
        `  dbCredentials: { url: "postgresql://localhost/drift_check" },`,
        `});`,
      ].join("\n"),
    );

    // 3. Run drizzle-kit generate.
    //
    //    cwd=tempDir so the relative `out: "./migrations"` resolves correctly.
    //    Any non-zero exit is a hard failure — a broken schema, corrupt
    //    snapshot, or any other generator error.  We must NOT claim "no drift"
    //    in that case.
    let genStdout = "";
    let genStderr = "";
    try {
      const out = execFileSync(
        dkBin,
        ["generate", "--config", tempConfig, "--name", "schema_drift_check"],
        { cwd: tempDir, stdio: "pipe" },
      );
      genStdout = out?.toString() ?? "";
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      genStdout = e.stdout?.toString() ?? "";
      genStderr = e.stderr?.toString() ?? "";
      return {
        ok: false,
        reason: "generator_error",
        stdout: genStdout,
        stderr: genStderr,
      };
    }

    // 4. Inspect new SQL files produced by drizzle-kit.
    const newFiles = readdirSync(join(tempDir, "migrations")).filter(
      (f) => f.endsWith(".sql") && !sqlBefore.has(f),
    );

    const pendingSQL: string[] = [];
    for (const f of newFiles) {
      const content = readFileSync(
        join(tempDir, "migrations", f),
        "utf8",
      ).trim();
      // drizzle-kit writes this placeholder when nothing actually changed.
      if (
        content &&
        !content.startsWith(
          "-- Current sql file does not contain any statements",
        )
      ) {
        pendingSQL.push(content);
      }
    }

    if (pendingSQL.length > 0) {
      return { ok: false, reason: "drift", pendingSQL };
    }

    return { ok: true };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));

  // Optional --db-root=<path> flag (used by integration tests to point the CLI
  // at a synthetic temp directory instead of the real project root).
  const dbRootFlag = process.argv
    .slice(2)
    .find((a) => a.startsWith("--db-root="));
  const dbRoot = dbRootFlag
    ? resolve(dbRootFlag.slice("--db-root=".length))
    : resolve(__dirname, "../../..");  // src/vendor/db/ → src/vendor/ → src/ → project root

  checkSchemaDrift(dbRoot).then((result) => {
    if (result.ok) {
      console.log(
        "✅  Schema is in sync with the latest migration. No drift found.",
      );
      return;
    }

    if (result.reason === "generator_error") {
      console.error(
        "\n❌  drizzle-kit generate failed — cannot verify schema sync.\n",
      );
      if (result.stdout) process.stderr.write(result.stdout + "\n");
      if (result.stderr) process.stderr.write(result.stderr + "\n");
      console.error(
        "Fix the error above, then re-run: pnpm run check-drift\n",
      );
    } else {
      console.error(
        "\n❌  Schema drift detected!\n\n" +
          "One or more schema files were changed without a matching migration.\n" +
          "Fix: run `pnpm run db:generate` and commit the result.\n",
      );
      console.error("Pending SQL that is missing from migrations:\n");
      result.pendingSQL.forEach((sql) => console.error(sql + "\n"));
    }

    process.exit(1);
  });
}
