# ordering service

Taking pre-orders: batches, quota, orders and payments. Contract: [../../contracts/ordering.openapi.yaml](../../contracts/ordering.openapi.yaml).
Owner: [name]. Reviewer: [name].

## Run

Needs Node.js 20+ and the `ordering_db` database from [../../infra/init.sql](../../infra/init.sql).
Start `production` first; `ordering` still starts without it, but `close` will answer 502 until it is up.

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
| `PRODUCTION_URL` | `http://localhost:3002` | Where closed batches are sent |
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
- `close` commits the state change first, then sends the batch to `production`. If `production` is down it returns 502, the batch stays
  `Closed`, and calling `close` again re-sends it. This partial state is visible and expected: there is no broker or automatic retry.
