import { seedBatch } from "./lib.mjs";

const r = await seedBatch();
if (r.status !== 201) {
  console.error("seed failed:", r.status, r.body);
  process.exit(1);
}
console.log(`Opened batch ${r.body.batchId} (quota 3000 g, 100000 IDR per kg)`);
