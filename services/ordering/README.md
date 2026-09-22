# ordering service

Taking pre-orders: batches, quota, orders and payments. Contract: [../../contracts/ordering.openapi.yaml](../../contracts/ordering.openapi.yaml).
Owner: [name]. Reviewer: [name].

## Run

Needs Node.js 20+ and the `ordering_db` database from [../../infra/init.sql](../../infra/init.sql).
Start `fulfilment` and `production` first (see the repo README's start order); `ordering` still starts
without them, but `close` will answer 502 until both are up.

```
cp .env.example .env
npm install
npm start
```

Migrations in `migrations/*.sql` are applied at startup.

## Environment variables

| Variable | Default in `.env.example` | Meaning |
|---|---|---|
| `PORT` | `3001` | Port to listen on |
| `DATABASE_URL` | `postgres://ordering_user:ordering_pw@localhost:5432/ordering_db` | This service's own database and role |
| `PRODUCTION_URL` | `http://localhost:3002` | Where closed batches are sent (call 1) |
| `FULFILMENT_URL` | `http://localhost:3003` | Where each paid order's shipment is created (call 2) |
| `HOLD_SECONDS` | `43200` | How long an unpaid order holds its quota (12 h: buyers pay by manual bank transfer). Use `20` for the demo. |
| `SWEEP_INTERVAL_SECONDS` | `5` | How often overdue holds are expired |

Demo mode: `HOLD_SECONDS=20 npm start` (PowerShell: `$env:HOLD_SECONDS=20; npm start`). Variables set in the shell win over `.env`.

## Files

- `src/index.ts`: runs migrations, starts the server and the hold sweeper.
- `src/db.ts`: connection pool, transaction helper, migration runner.
- `src/app.ts`: all endpoints, validation and error mapping.
- `migrations/001_init.sql`: tables `batches`, `orders`, `payments`.

## The two rules

- **Quota (hard rule):** placing an order runs one `UPDATE batches SET claimed_grams = claimed_grams + $grams WHERE ... AND claimed_grams + $grams <= quota_grams`
  and inserts the order in the same transaction. Zero rows updated means `QuotaExceeded` or `BatchNotOpen`. A `CHECK` constraint on the table backs it up.
- **Payment exactly once:** `payments.payment_ref` is unique, and `Held -> Paid` is a conditional update in the same transaction as the insert.
  The same `paymentRef` again returns `duplicate: true` and changes nothing.

## Behaviour worth knowing

- The sweeper and `close` both expire `Held` orders and give the grams back in one SQL statement.
- Payment only succeeds while `hold_expires_at >= now()`, and the sweeper only expires `hold_expires_at < now()`, so they cannot race.
- `close` commits the state change first, then makes two kinds of downstream call, each tracked by its own
  idempotent flag so one failing never blocks a retry of the other: call 1 to `production` (batch-level,
  `batches.dispatched`) and call 2 to `fulfilment` (per order, `orders.shipment_sent`, with the buyer's
  address — `production` never sees it). If either is down, `close` returns 502 and the batch stays
  `Closed`; calling `close` again retries only what has not yet succeeded. This partial state is visible
  and expected: there is no broker or automatic retry.
