/** CLI entry: `pnpm --filter @workspace/db run migrate` */
import { pool } from "./index";
import { runMigrations } from "./migrate";

runMigrations()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[db:migrate] FAILED:", err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
