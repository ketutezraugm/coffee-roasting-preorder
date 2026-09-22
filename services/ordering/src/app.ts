import express, { type ErrorRequestHandler } from "express";
import type pg from "pg";
import { pool, tx } from "./db.js";

// An error that maps straight to the contract's {error, message} shape.
class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const notFound = (what: string) => new HttpError(404, "NotFound", `${what} not found`);

const PACKS = [100, 250, 500, 1000];
const GRINDS = ["wholeBean", "filter", "espresso"];
const ROASTS = ["light", "medium", "dark"];
const HOLD_SECONDS = Number(process.env.HOLD_SECONDS ?? 43200);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const BATCH_COLUMNS = `id AS "batchId", bean_name AS "beanName", roast_level AS "roastLevel", status,
  quota_grams AS "quotaGrams", quota_grams - claimed_grams AS "remainingGrams", price_per_kg_idr AS "pricePerKgIdr"`;

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ---------- batches ----------

app.post("/batches", async (req, res) => {
  const b = req.body;
  const bad = (m: string) => new HttpError(422, "InvalidBatch", m);
  if (!isStr(b?.beanName)) throw bad("beanName is required");
  if (!ROASTS.includes(b.roastLevel)) throw bad("roastLevel must be light, medium or dark");
  if (!Number.isInteger(b.quotaGrams) || b.quotaGrams < 1) throw bad("quotaGrams must be an integer >= 1");
  if (!Number.isInteger(b.pricePerKgIdr) || b.pricePerKgIdr < 1) throw bad("pricePerKgIdr must be an integer >= 1");
  const closesAt = new Date(b.closesAt);
  if (!isStr(b.closesAt) || isNaN(closesAt.getTime()) || closesAt <= new Date())
    throw bad("closesAt must be a date-time in the future");
  const r = await pool.query(
    `INSERT INTO batches (bean_name, roast_level, quota_grams, price_per_kg_idr, closes_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id AS "batchId", status`,
    [b.beanName, b.roastLevel, b.quotaGrams, b.pricePerKgIdr, closesAt],
  );
  res.status(201).json(r.rows[0]);
});

app.get("/batches", async (_req, res) => {
  const r = await pool.query(`SELECT ${BATCH_COLUMNS} FROM batches ORDER BY closes_at`);
  res.json(r.rows);
});

app.get("/batches/:batchId", async (req, res) => {
  const { batchId } = req.params;
  if (!isUuid(batchId)) throw notFound("batch");
  const r = await pool.query(`SELECT ${BATCH_COLUMNS} FROM batches WHERE id = $1`, [batchId]);
  if (!r.rowCount) throw notFound("batch");
  res.json(r.rows[0]);
});

// ---------- orders ----------

// The hard rule: claim the quota with ONE conditional UPDATE, and insert the order in the same
// transaction. Never read the remaining quota and then write it.
app.post("/batches/:batchId/orders", async (req, res) => {
  const { batchId } = req.params;
  const o = req.body;
  const bad = (m: string) => new HttpError(422, "InvalidOrder", m);
  if (!isStr(o?.buyerName) || !isStr(o.buyerContact) || !isStr(o.shippingAddress))
    throw bad("buyerName, buyerContact and shippingAddress are required");
  if (!PACKS.includes(o.packSizeGrams)) throw bad("packSizeGrams must be 100, 250, 500 or 1000");
  if (!GRINDS.includes(o.grind)) throw bad("grind must be wholeBean, filter or espresso");
  if (!Number.isInteger(o.quantity) || o.quantity < 1) throw bad("quantity must be an integer >= 1");
  if (!isUuid(batchId)) throw notFound("batch");

  const totalGrams = o.packSizeGrams * o.quantity;
  const order = await tx(async (c) => {
    const claim = await c.query(
      `UPDATE batches SET claimed_grams = claimed_grams + $2
        WHERE id = $1 AND status = 'Open' AND closes_at > now() AND claimed_grams + $2 <= quota_grams
    RETURNING price_per_kg_idr`,
      [batchId, totalGrams],
    );
    if (!claim.rowCount) {
      const b = await c.query("SELECT status, closes_at > now() AS open_in_time FROM batches WHERE id = $1", [batchId]);
      if (!b.rowCount) throw notFound("batch");
      if (b.rows[0].status !== "Open" || !b.rows[0].open_in_time)
        throw new HttpError(409, "BatchNotOpen", "This batch is not open for orders");
      throw new HttpError(409, "QuotaExceeded", "Not enough quota left in this batch");
    }
    const amountIdr = Math.round((totalGrams * claim.rows[0].price_per_kg_idr) / 1000);
    const r = await c.query(
      `INSERT INTO orders (batch_id, buyer_name, buyer_contact, shipping_address, pack_size_grams, grind,
                           quantity, total_grams, amount_idr, hold_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + $10 * interval '1 second')
       RETURNING id AS "orderId", total_grams AS "totalGrams", amount_idr AS "amountIdr", hold_expires_at AS "holdExpiresAt"`,
      [batchId, o.buyerName, o.buyerContact, o.shippingAddress, o.packSizeGrams, o.grind, o.quantity, totalGrams, amountIdr, HOLD_SECONDS],
    );
    return r.rows[0];
  });
  res.status(201).json(order);
});

app.get("/orders/:orderId", async (req, res) => {
  const { orderId } = req.params;
  if (!isUuid(orderId)) throw notFound("order");
  const r = await pool.query(
    `SELECT id AS "orderId", batch_id AS "batchId", status, total_grams AS "totalGrams",
            amount_idr AS "amountIdr", hold_expires_at AS "holdExpiresAt"
       FROM orders WHERE id = $1`,
    [orderId],
  );
  if (!r.rowCount) throw notFound("order");
  res.json(r.rows[0]);
});

// ---------- payments ----------

// Exactly once: payment_ref is unique, and Held -> Paid is one conditional UPDATE in the same
// transaction as the payment insert.
app.post("/orders/:orderId/payments", async (req, res) => {
  const { orderId } = req.params;
  const { paymentRef, amountIdr } = req.body ?? {};
  if (!isStr(paymentRef) || !Number.isInteger(amountIdr))
    throw new HttpError(422, "InvalidPayment", "paymentRef and an integer amountIdr are required");
  if (!isUuid(orderId)) throw notFound("order");

  try {
    const duplicate = await tx(async (c) => {
      // Returns true if this ref was already recorded for this order.
      const seenBefore = async () => {
        const p = await c.query("SELECT order_id FROM payments WHERE payment_ref = $1", [paymentRef]);
        if (!p.rowCount) return false;
        if (p.rows[0].order_id !== orderId.toLowerCase())
          throw new HttpError(422, "InvalidPayment", "paymentRef was already used for another order");
        return true;
      };
      if (await seenBefore()) return true;

      const o = await c.query("SELECT amount_idr FROM orders WHERE id = $1", [orderId]);
      if (!o.rowCount) throw notFound("order");
      if (o.rows[0].amount_idr !== amountIdr)
        throw new HttpError(422, "AmountMismatch", `Payment must be exactly ${o.rows[0].amount_idr} IDR`);

      const paid = await c.query(
        "UPDATE orders SET status = 'Paid' WHERE id = $1 AND status = 'Held' AND hold_expires_at >= now()",
        [orderId],
      );
      if (!paid.rowCount) {
        // A concurrent request with the same ref may have just paid it: that is a duplicate, not an error.
        if (await seenBefore()) return true;
        const s = await c.query("SELECT status FROM orders WHERE id = $1", [orderId]);
        if (["Paid", "InProduction", "Completed"].includes(s.rows[0].status))
          throw new HttpError(409, "AlreadyPaid", "Order was already paid with another reference");
        throw new HttpError(409, "OrderExpired", "The hold on this order has expired");
      }
      await c.query("INSERT INTO payments (payment_ref, order_id, amount_idr) VALUES ($1, $2, $3)", [paymentRef, orderId, amountIdr]);
      return false;
    });
    res.json({ orderStatus: "Paid", duplicate });
  } catch (e: any) {
    // Same ref hit two different orders at the same moment: the loser lands here.
    if (e.code === "23505") throw new HttpError(422, "InvalidPayment", "paymentRef was already used for another order");
    throw e;
  }
});

// ---------- closing a batch ----------

// Step 1 (transaction): Open -> Closed, expire held orders, Paid -> InProduction.
// Step 2 (outside it): call 1 to production (batch-level, no address) and call 2 to fulfilment
// (per order, with address). Both are attempted independently and best-effort, each tracked by
// its own idempotent flag, so a failure in one never blocks a retry of the other.
app.post("/batches/:batchId/close", async (req, res) => {
  const { batchId } = req.params;
  if (!isUuid(batchId)) throw notFound("batch");

  const batch = await tx(async (c) => {
    const b = await c.query("SELECT status FROM batches WHERE id = $1 FOR UPDATE", [batchId]);
    if (!b.rowCount) throw notFound("batch");
    if (b.rows[0].status === "Open") {
      const paid = await c.query("SELECT 1 FROM orders WHERE batch_id = $1 AND status = 'Paid' LIMIT 1", [batchId]);
      if (!paid.rowCount) throw new HttpError(409, "NoPaidOrders", "There are no paid orders to send to production");
      await releaseHeldOrders(c, batchId);
      await c.query("UPDATE orders SET status = 'InProduction' WHERE batch_id = $1 AND status = 'Paid'", [batchId]);
      await c.query("UPDATE batches SET status = 'Closed' WHERE id = $1", [batchId]);
    }
    const r = await c.query(`SELECT bean_name, roast_level, dispatched FROM batches WHERE id = $1`, [batchId]);
    return r.rows[0];
  });

  const dispatched = await pool.query(
    `SELECT id AS "orderId", pack_size_grams AS "packSizeGrams", grind, quantity
       FROM orders WHERE batch_id = $1 AND status IN ('InProduction', 'Completed') ORDER BY created_at`,
    [batchId],
  );

  let productionFailed = false;
  if (!batch.dispatched) {
    try {
      const r = await fetch(`${process.env.PRODUCTION_URL}/production-batches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId, beanName: batch.bean_name, roastLevel: batch.roast_level, lines: dispatched.rows }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`production answered ${r.status}`);
      await pool.query("UPDATE batches SET dispatched = true WHERE id = $1", [batchId]);
    } catch {
      productionFailed = true;
    }
  }

  const unsent = await pool.query(
    `SELECT id AS "orderId", buyer_name AS "recipientName", buyer_contact AS contact, shipping_address AS address
       FROM orders WHERE batch_id = $1 AND status IN ('InProduction', 'Completed') AND shipment_sent = false`,
    [batchId],
  );
  let fulfilmentFailed = false;
  for (const o of unsent.rows) {
    try {
      const r = await fetch(`${process.env.FULFILMENT_URL}/shipments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(o),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`fulfilment answered ${r.status}`);
      await pool.query("UPDATE orders SET shipment_sent = true WHERE id = $1", [o.orderId]);
    } catch {
      fulfilmentFailed = true;
    }
  }

  if (productionFailed || fulfilmentFailed)
    throw new HttpError(502, "DownstreamUnavailable", "Could not reach production and/or fulfilment for every order. Call close again to retry.");
  res.json({ status: "Closed", dispatchedOrders: dispatched.rowCount });
});

// Call 4: called by fulfilment when the buyer confirmed receipt. Idempotent.
app.post("/orders/:orderId/complete", async (req, res) => {
  const { orderId } = req.params;
  if (!isUuid(orderId)) throw notFound("order");
  const r = await pool.query("UPDATE orders SET status = 'Completed' WHERE id = $1 AND status = 'InProduction'", [orderId]);
  if (!r.rowCount) {
    const s = await pool.query("SELECT status FROM orders WHERE id = $1", [orderId]);
    if (!s.rowCount) throw notFound("order");
    if (s.rows[0].status !== "Completed") throw new HttpError(409, "NotInProduction", "Order is not in production");
  }
  res.json({ status: "Completed" });
});

// ---------- releasing quota ----------

// Expires Held orders and gives their grams back to the batch in ONE statement.
// batchId = only that batch (used by close); otherwise only overdue holds (used by the sweeper).
async function expireHolds(c: pg.Pool | pg.PoolClient, batchId?: string) {
  await c.query(
    `WITH expired AS (
       UPDATE orders SET status = 'Expired'
        WHERE status = 'Held' AND ($1::uuid IS NULL AND hold_expires_at < now() OR batch_id = $1::uuid)
    RETURNING batch_id, total_grams)
     UPDATE batches b SET claimed_grams = b.claimed_grams - s.grams
       FROM (SELECT batch_id, sum(total_grams) AS grams FROM expired GROUP BY batch_id) s
      WHERE b.id = s.batch_id`,
    [batchId ?? null],
  );
}
const releaseHeldOrders = (c: pg.PoolClient, batchId: string) => expireHolds(c, batchId);
export const sweepExpiredHolds = () => expireHolds(pool);

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.code, message: err.message });
  if (err.type === "entity.parse.failed") return void res.status(400).json({ error: "BadRequest", message: "Body is not valid JSON" });
  console.error(err);
  res.status(500).json({ error: "InternalError", message: "Something went wrong" });
};
app.use(onError);
