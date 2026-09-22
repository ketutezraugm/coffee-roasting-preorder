// Each service's database credentials must open its own database and nothing else (B2).
import pg from "pg";
import { checker } from "./lib.mjs";

const { check, done } = checker();
const host = process.env.PGHOST ?? "localhost", port = process.env.PGPORT ?? 5432;
const services = {
  ordering: { user: "ordering_user", password: "ordering_pw", db: "ordering_db" },
  production: { user: "production_user", password: "production_pw", db: "production_db" },
  fulfilment: { user: "fulfilment_user", password: "fulfilment_pw", db: "fulfilment_db" },
};

// Returns "connected" or the Postgres error code (42501 = permission denied).
async function tryConnect(user, password, db) {
  const c = new pg.Client({ host, port, user, password, database: db });
  try {
    await c.connect();
    return "connected";
  } catch (e) {
    return e.code ?? e.message;
  } finally {
    await c.end().catch(() => {});
  }
}

for (const [name, own] of Object.entries(services)) {
  const result = await tryConnect(own.user, own.password, own.db);
  check(`${name} credentials open ${own.db}`, result === "connected", result);

  for (const [otherName, other] of Object.entries(services)) {
    if (otherName === name) continue;
    const denied = await tryConnect(own.user, own.password, other.db);
    check(`${name} credentials are refused by ${other.db}`, denied === "42501", denied);
  }
}
done();
