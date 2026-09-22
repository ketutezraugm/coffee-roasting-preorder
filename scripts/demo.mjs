// Runs the demo scenario (BUILD_SPEC section 10) against the running services
// (fulfilment, production, ordering — start in that order).
// Start ordering with HOLD_SECONDS=20 so step 5 finishes quickly.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ORDERING, PRODUCTION, FULFILMENT, call, checker, placeOrder, seedBatch, sleep } from "./lib.mjs";

const { check, done } = checker();
// Payment refs are unique per run, so the demo can be run again against the same database.
const run = Date.now().toString(36);
const pay = (orderId, paymentRef, amountIdr = 100000) =>
  call("POST", `${ORDERING}/orders/${orderId}/payments`, { paymentRef: `${paymentRef}-${run}`, amountIdr });
const order = (id) => call("GET", `${ORDERING}/orders/${id}`).then((r) => r.body);

console.log("1. Seed: open a batch with quota 3000 g");
let r = await seedBatch();
if (!check("batch opened", r.status === 201 && r.body.status === "Open", r)) process.exit(1);
const batchId = r.body.batchId;

console.log("\n2. Place three orders of 1000 g");
const orders = [];
for (const who of ["Ayu", "Budi", "Citra"]) {
  r = await placeOrder(batchId, 1000, who);
  check(`order for ${who} accepted`, r.status === 201 && r.body.totalGrams === 1000 && r.body.amountIdr === 100000, r);
  orders.push(r.body);
}

console.log("\n3. Fourth order of 1000 g is rejected (the hard rule)");
r = await placeOrder(batchId, 1000, "Dewi");
check("409 QuotaExceeded", r.status === 409 && r.body?.error === "QuotaExceeded", r);

console.log("\n4. Pay order 1, then send the same payment again");
r = await pay(orders[0].orderId, "PAY-DEMO-1");
check("first payment applied", r.status === 200 && r.body.duplicate === false, r);
r = await pay(orders[0].orderId, "PAY-DEMO-1");
check("same paymentRef returns duplicate:true", r.status === 200 && r.body.duplicate === true, r);
check("order 1 is Paid (once)", (await order(orders[0].orderId)).status === "Paid");

console.log("\n5. Wait for the hold on order 3 to expire, then order again");
// All three holds run out together, so pay order 2 now or it would expire too.
r = await pay(orders[1].orderId, "PAY-DEMO-2");
check("order 2 paid before its hold runs out", r.status === 200 && r.body.duplicate === false, r);
const secondsLeft = (new Date(orders[2].holdExpiresAt) - Date.now()) / 1000;
if (!check("hold is short enough for a demo", secondsLeft <= 120, `hold is ${Math.round(secondsLeft)}s. Restart ordering with HOLD_SECONDS=20`)) {
  process.exit(1);
}
console.log(`      waiting up to ${Math.ceil(secondsLeft) + 30}s ...`);
const deadline = Date.now() + (secondsLeft + 30) * 1000;
let expired = false;
while (Date.now() < deadline && !expired) {
  await sleep(1000);
  expired = (await order(orders[2].orderId)).status === "Expired";
}
check("order 3 expired", expired);
r = await pay(orders[2].orderId, "PAY-DEMO-3");
check("paying the expired order is refused (409 OrderExpired)", r.status === 409 && r.body?.error === "OrderExpired", r);
r = await placeOrder(batchId, 1000, "Dewi");
check("new 1000 g order now succeeds", r.status === 201, r);
const lateOrder = r.body;

console.log("\n6. Close the batch (orders 1 and 2 are paid, the new order is still held)");
r = await call("POST", `${ORDERING}/batches/${batchId}/close`);
check("batch closed, 2 orders sent to production and fulfilment", r.status === 200 && r.body.dispatchedOrders === 2, r);
check("unpaid order expired by the close", (await order(lateOrder.orderId)).status === "Expired");
check("paid orders are InProduction", (await order(orders[0].orderId)).status === "InProduction" && (await order(orders[1].orderId)).status === "InProduction");

console.log("\n7. Production: roast, read the packing list, pack each order (which tells fulfilment)");
r = await call("GET", `${PRODUCTION}/production-batches`);
const pb = r.body?.find((b) => b.batchId === batchId);
if (!check("production has the batch", !!pb, r)) process.exit(1);
r = await call("POST", `${PRODUCTION}/production-batches/${pb.productionBatchId}/roast`, { actualSellableGrams: 2400 });
check("roast recorded", r.status === 200 && r.body.status === "Roasted", r);
r = await call("GET", `${PRODUCTION}/production-batches/${pb.productionBatchId}/packing-list`);
check("packing list has the 2 paid orders", r.status === 200 && r.body.length === 2, r);
for (const o of orders.slice(0, 2)) {
  r = await call("POST", `${PRODUCTION}/production-batches/${pb.productionBatchId}/lines/${o.orderId}/pack`);
  check(`packed ${o.orderId.slice(0, 8)}`, r.status === 200 && r.body.lineStatus === "Packed", r);
}
r = await call("GET", `${PRODUCTION}/production-batches/${pb.productionBatchId}`);
check("production batch is Packed", r.body?.status === "Packed", r);

console.log("\n8. Fulfilment: ship each order with a tracking number, then confirm receipt");
for (const [i, o] of orders.slice(0, 2).entries()) {
  r = await call("GET", `${FULFILMENT}/shipments/${o.orderId}`);
  check(`shipment ${o.orderId.slice(0, 8)} is ReadyToShip`, r.status === 200 && r.body.status === "ReadyToShip", r);
  r = await call("POST", `${FULFILMENT}/shipments/${o.orderId}/ship`, { trackingNumber: `TRK-DEMO-${i + 1}` });
  check(`shipped ${o.orderId.slice(0, 8)}`, r.status === 200 && r.body.status === "Shipped", r);
  r = await call("POST", `${FULFILMENT}/shipments/${o.orderId}/confirm-receipt`);
  check(`receipt confirmed ${o.orderId.slice(0, 8)}`, r.status === 200 && r.body.status === "Delivered", r);
}
r = await call("GET", `${FULFILMENT}/shipments/${orders[0].orderId}`);
console.log(`      GET /shipments/${orders[0].orderId.slice(0, 8)}... -> ${JSON.stringify(r.body)}`);

console.log("\n9. Ordering shows the orders Completed");
for (const o of orders.slice(0, 2)) {
  check(`order ${o.orderId.slice(0, 8)} Completed`, (await order(o.orderId)).status === "Completed");
}

console.log("\n10. Concurrency test and isolation check");
for (const script of ["concurrency-test.mjs", "check-isolation.mjs"]) {
  console.log(`\n--- ${script}`);
  const s = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { stdio: "inherit" });
  check(script, s.status === 0);
}
done();
