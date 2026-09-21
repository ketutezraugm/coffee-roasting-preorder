import { app, sweepExpiredHolds } from "./app.js";
import { migrate } from "./db.js";

const port = Number(process.env.PORT ?? 3001);
const sweepSeconds = Number(process.env.SWEEP_INTERVAL_SECONDS ?? 5);

await migrate();
app.listen(port, () => console.log(`ordering listening on ${port}`));

// Background sweeper: expires overdue holds and gives their grams back.
setInterval(() => {
  sweepExpiredHolds().catch((e) => console.error("sweep failed", e));
}, sweepSeconds * 1000);
