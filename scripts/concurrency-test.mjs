// Fires many simultaneous orders at a batch with little quota left and checks the hard rule:
// claimed grams never exceed the quota, and the numbers match the orders that were stored.
import { ORDERING, call, checker, placeOrder, seedBatch } from "./lib.mjs";

const { check, done } = checker();
const QUOTA = 3000, PACK = 250, PREFILL = 2000;
const REQUESTS = Number(process.env.REQUESTS ?? 60);
const expected = (QUOTA - PREFILL) / PACK; // orders that fit in the quota that is left

let r = await seedBatch(QUOTA, "Concurrency Test");
if (r.status !== 201) {
  console.error("could not open a batch", r);
  process.exit(1);
}
const batchId = r.body.batchId;

// Use up most of the quota first, so the race is for the last kilo.
for (let i = 0; i < PREFILL / 1000; i++) await placeOrder(batchId, 1000, `Prefill${i}`);
console.log(`${QUOTA - PREFILL} g left, sending ${REQUESTS} simultaneous ${PACK} g orders`);

const results = await Promise.all(Array.from({ length: REQUESTS }, (_, i) => placeOrder(batchId, PACK, `Racer${i}`)));
const accepted = results.filter((x) => x.status === 201);
const rejected = results.filter((x) => x.status === 409 && x.body?.error === "QuotaExceeded");

check(`exactly ${expected} orders accepted`, accepted.length === expected, `accepted ${accepted.length}`);
check("every other request got 409 QuotaExceeded (no errors)", accepted.length + rejected.length === REQUESTS, results.filter((x) => x.status !== 201 && x.status !== 409));

r = await call("GET", `${ORDERING}/batches/${batchId}`);
const claimed = QUOTA - r.body.remainingGrams;
check("claimed grams never exceed the quota", r.body.remainingGrams >= 0, r.body);

// Compare the batch counter with the orders actually stored.
const stored = await Promise.all(accepted.map((x) => call("GET", `${ORDERING}/orders/${x.body.orderId}`)));
const storedGrams = stored.reduce((sum, o) => sum + (o.body?.status === "Held" ? o.body.totalGrams : 0), PREFILL);
check("every accepted order is stored as Held", stored.every((o) => o.status === 200 && o.body.status === "Held"));
check("claimed grams equal the grams of stored orders", claimed === storedGrams, `batch says ${claimed}, orders add up to ${storedGrams}`);
done();
