import express, { type ErrorRequestHandler } from "express";
import { pool, tx } from "./db.js";

// An error that maps straight to the contract's {error, message} shape.
class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const notFound = (what: string) => new HttpError(404, "NotFound", `${what} not found`);

const PACKS = [100, 250, 500, 1000];
const GRINDS = ["coarse", "medium", "fine"];
const ROASTS = ["light", "medium", "dark"];
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function parseBatch(b: any) {
  const bad = (m: string) => new HttpError(422, "InvalidProductionBatch", m);
  if (!isStr(b?.batchId) || !isStr(b.beanName)) throw bad("batchId and beanName are required");
  if (!ROASTS.includes(b.roastLevel)) throw bad("roastLevel must be light, medium or dark");
  if (!Array.isArray(b.lines) || b.lines.length === 0) throw bad("lines must be a non-empty array");
  const seen = new Set<string>();
  for (const l of b.lines) {
    if (!isStr(l?.orderId)) throw bad("every line needs an orderId");
    if (seen.has(l.orderId)) throw bad(`duplicate orderId ${l.orderId}`);
    seen.add(l.orderId);
    if (!PACKS.includes(l.packSizeGrams)) throw bad("packSizeGrams must be 100, 250, 500 or 1000");
    if (!GRINDS.includes(l.grind)) throw bad("grind must be coarse, medium or fine");
    if (!Number.isInteger(l.quantity) || l.quantity < 1) throw bad("quantity must be an integer >= 1");
    if (!isStr(l.recipientName) || !isStr(l.contact) || !isStr(l.address))
      throw bad("every line needs recipientName, contact and address");
  }
  return b;
}

async function findByBatchId(batchId: string) {
  const r = await pool.query(
    "SELECT id AS \"productionBatchId\", status FROM production_batches WHERE batch_id = $1",
    [batchId],
  );
  return r.rows[0];
}

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Call 1: ordering sends a closed batch. Also creates one shipment per line.
app.post("/production-batches", async (req, res) => {
  const b = parseBatch(req.body);
  const existing = await findByBatchId(b.batchId);
  if (existing) return res.status(200).json(existing);
  try {
    const created = await tx(async (c) => {
      const r = await c.query(
        "INSERT INTO production_batches (batch_id, bean_name, roast_level) VALUES ($1, $2, $3) RETURNING id, status",
        [b.batchId, b.beanName, b.roastLevel],
      );
      const id = r.rows[0].id;
      for (const l of b.lines) {
        await c.query(
          "INSERT INTO lines (production_batch_id, order_id, pack_size_grams, grind, quantity) VALUES ($1, $2, $3, $4, $5)",
          [id, l.orderId, l.packSizeGrams, l.grind, l.quantity],
        );
        await c.query(
          "INSERT INTO shipments (order_id, recipient_name, contact, address) VALUES ($1, $2, $3, $4)",
          [l.orderId, l.recipientName, l.contact, l.address],
        );
      }
      return { productionBatchId: id, status: r.rows[0].status };
    });
    res.status(201).json(created);
  } catch (e: any) {
    if (e.code !== "23505") throw e;
    // Unique violation: either an identical request won the race, or an orderId is already used.
    const again = await findByBatchId(b.batchId);
    if (again) return res.status(200).json(again);
    throw new HttpError(422, "InvalidProductionBatch", "an orderId in this batch already belongs to another batch");
  }
});

app.get("/production-batches", async (_req, res) => {
  const r = await pool.query(
    `SELECT id AS "productionBatchId", batch_id AS "batchId", bean_name AS "beanName",
            roast_level AS "roastLevel", status
       FROM production_batches ORDER BY created_at DESC`,
  );
  res.json(r.rows);
});

app.get("/production-batches/:id", async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) throw notFound("production batch");
  const b = await pool.query("SELECT id, status, actual_sellable_grams FROM production_batches WHERE id = $1", [id]);
  if (!b.rowCount) throw notFound("production batch");
  const lines = await pool.query(
    `SELECT order_id AS "orderId", pack_size_grams AS "packSizeGrams", grind, quantity, packed
       FROM lines WHERE production_batch_id = $1 ORDER BY seq`,
    [id],
  );
  const row = b.rows[0];
  res.json({
    productionBatchId: row.id,
    status: row.status,
    ...(row.actual_sellable_grams !== null && { actualSellableGrams: row.actual_sellable_grams }),
    lines: lines.rows,
  });
});

app.post("/production-batches/:id/roast", async (req, res) => {
  const { id } = req.params;
  const grams = req.body?.actualSellableGrams;
  if (!isUuid(id)) throw notFound("production batch");
  if (!Number.isInteger(grams) || grams < 0)
    throw new HttpError(422, "InvalidRoast", "actualSellableGrams must be an integer >= 0");
  // Conditional update: only a Queued batch can be roasted, and only once.
  const r = await pool.query(
    "UPDATE production_batches SET status = 'Roasted', actual_sellable_grams = $2 WHERE id = $1 AND status = 'Queued'",
    [id, grams],
  );
  if (!r.rowCount) {
    const exists = await pool.query("SELECT 1 FROM production_batches WHERE id = $1", [id]);
    if (!exists.rowCount) throw notFound("production batch");
    throw new HttpError(409, "AlreadyRoasted", "This batch has already been roasted");
  }
  res.json({ status: "Roasted" });
});

app.get("/production-batches/:id/packing-list", async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) throw notFound("production batch");
  const b = await pool.query("SELECT 1 FROM production_batches WHERE id = $1", [id]);
  if (!b.rowCount) throw notFound("production batch");
  const lines = await pool.query(
    `SELECT order_id AS "orderId", pack_size_grams AS "packSizeGrams", grind, quantity, packed
       FROM lines WHERE production_batch_id = $1 ORDER BY seq`,
    [id],
  );
  res.json(lines.rows);
});

// Packing a line also makes its shipment ReadyToShip (same transaction).
app.post("/production-batches/:id/lines/:orderId/pack", async (req, res) => {
  const { id, orderId } = req.params;
  if (!isUuid(id)) throw notFound("production batch");
  const batchStatus = await tx(async (c) => {
    // Lock the batch row so two pack calls cannot both decide they were the last one.
    const b = await c.query("SELECT status FROM production_batches WHERE id = $1 FOR UPDATE", [id]);
    if (!b.rowCount) throw notFound("production batch");
    const l = await c.query("SELECT packed FROM lines WHERE production_batch_id = $1 AND order_id = $2", [id, orderId]);
    if (!l.rowCount) throw notFound("line");
    if (b.rows[0].status === "Queued") throw new HttpError(409, "NotRoasted", "Record the roast first");
    if (l.rows[0].packed) throw new HttpError(409, "AlreadyPacked", "Line already packed");
    await c.query("UPDATE lines SET packed = true WHERE production_batch_id = $1 AND order_id = $2", [id, orderId]);
    await c.query("UPDATE shipments SET status = 'ReadyToShip' WHERE order_id = $1 AND status = 'AwaitingPacking'", [orderId]);
    const left = await c.query("SELECT 1 FROM lines WHERE production_batch_id = $1 AND NOT packed LIMIT 1", [id]);
    if (left.rowCount) return "Roasted";
    await c.query("UPDATE production_batches SET status = 'Packed' WHERE id = $1", [id]);
    return "Packed";
  });
  res.json({ lineStatus: "Packed", batchStatus });
});

app.get("/shipments/:orderId", async (req, res) => {
  const r = await pool.query(
    "SELECT status, tracking_number FROM shipments WHERE order_id = $1",
    [req.params.orderId],
  );
  if (!r.rowCount) throw notFound("shipment");
  const { status, tracking_number } = r.rows[0];
  res.json({ status, ...(tracking_number && { trackingNumber: tracking_number }) });
});

app.post("/shipments/:orderId/ship", async (req, res) => {
  const { orderId } = req.params;
  const tracking = req.body?.trackingNumber;
  if (!isStr(tracking)) throw new HttpError(422, "InvalidShipment", "trackingNumber is required");
  const r = await pool.query(
    "UPDATE shipments SET status = 'Shipped', tracking_number = $2 WHERE order_id = $1 AND status = 'ReadyToShip'",
    [orderId, tracking],
  );
  if (!r.rowCount) {
    const exists = await pool.query("SELECT 1 FROM shipments WHERE order_id = $1", [orderId]);
    if (!exists.rowCount) throw notFound("shipment");
    throw new HttpError(409, "NotReady", "Shipment is not ready to ship");
  }
  res.json({ status: "Shipped" });
});

// Call 2: mark Delivered, then tell ordering. If ordering is down the shipment stays
// Delivered with ordering_notified = false, and calling this again re-sends the notice.
app.post("/shipments/:orderId/confirm-receipt", async (req, res) => {
  const { orderId } = req.params;
  const s = await pool.query("SELECT status, ordering_notified FROM shipments WHERE order_id = $1", [orderId]);
  if (!s.rowCount) throw notFound("shipment");
  if (!["Shipped", "Delivered"].includes(s.rows[0].status))
    throw new HttpError(409, "NotShipped", "Shipment has not been shipped yet");
  await pool.query("UPDATE shipments SET status = 'Delivered' WHERE order_id = $1", [orderId]);
  if (!s.rows[0].ordering_notified) {
    try {
      const r = await fetch(`${process.env.ORDERING_URL}/orders/${encodeURIComponent(orderId)}/complete`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`ordering answered ${r.status}`);
    } catch (e: any) {
      throw new HttpError(502, "DownstreamUnavailable", `Could not tell ordering: ${e.message}. Call again to retry.`);
    }
    await pool.query("UPDATE shipments SET ordering_notified = true WHERE order_id = $1", [orderId]);
  }
  res.json({ status: "Delivered" });
});

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.code, message: err.message });
  if (err.type === "entity.parse.failed") return void res.status(400).json({ error: "BadRequest", message: "Body is not valid JSON" });
  console.error(err);
  res.status(500).json({ error: "InternalError", message: "Something went wrong" });
};
app.use(onError);
