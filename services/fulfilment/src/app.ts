import express, { type ErrorRequestHandler } from "express";
import { pool } from "./db.js";

// An error that maps straight to the contract's {error, message} shape.
class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const notFound = (what: string) => new HttpError(404, "NotFound", `${what} not found`);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Call 2: ordering creates a shipment when it closes a batch. Idempotent on orderId.
app.post("/shipments", async (req, res) => {
  const b = req.body;
  const bad = (m: string) => new HttpError(422, "InvalidShipment", m);
  if (!isStr(b?.orderId) || !isStr(b.recipientName) || !isStr(b.contact) || !isStr(b.address))
    throw bad("orderId, recipientName, contact and address are required");

  const existing = await pool.query('SELECT id AS "shipmentId", status FROM shipments WHERE order_id = $1', [b.orderId]);
  if (existing.rowCount) return res.status(200).json(existing.rows[0]);
  try {
    const r = await pool.query(
      'INSERT INTO shipments (order_id, recipient_name, contact, address) VALUES ($1, $2, $3, $4) RETURNING id AS "shipmentId", status',
      [b.orderId, b.recipientName, b.contact, b.address],
    );
    res.status(201).json(r.rows[0]);
  } catch (e: any) {
    if (e.code !== "23505") throw e;
    const again = await pool.query('SELECT id AS "shipmentId", status FROM shipments WHERE order_id = $1', [b.orderId]);
    res.status(200).json(again.rows[0]);
  }
});

app.get("/shipments/:orderId", async (req, res) => {
  const r = await pool.query("SELECT status, tracking_number FROM shipments WHERE order_id = $1", [req.params.orderId]);
  if (!r.rowCount) throw notFound("shipment");
  const { status, tracking_number } = r.rows[0];
  res.json({ status, ...(tracking_number && { trackingNumber: tracking_number }) });
});

// Call 3: production tells us an order is packed. Idempotent: past AwaitingPacking, changes nothing.
app.post("/shipments/:orderId/ready", async (req, res) => {
  const { orderId } = req.params;
  const r = await pool.query("UPDATE shipments SET status = 'ReadyToShip' WHERE order_id = $1 AND status = 'AwaitingPacking'", [orderId]);
  if (!r.rowCount) {
    const s = await pool.query("SELECT status FROM shipments WHERE order_id = $1", [orderId]);
    if (!s.rowCount) throw notFound("shipment");
    return res.json({ status: s.rows[0].status === "AwaitingPacking" ? "ReadyToShip" : s.rows[0].status });
  }
  res.json({ status: "ReadyToShip" });
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

// Call 4: mark Delivered, then tell ordering. If ordering is down the shipment stays
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
