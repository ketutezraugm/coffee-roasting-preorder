import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Runs fn inside one transaction; any throw rolls everything back.
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

// Applies migrations/*.sql in name order, once each.
export async function migrate() {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (done.rowCount) continue;
    await tx(async (c) => {
      await c.query(readFileSync(new URL(file, dir), "utf8"));
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    console.log(`applied migration ${file}`);
  }
}
