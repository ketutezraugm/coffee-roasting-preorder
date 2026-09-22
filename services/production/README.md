# production service

Roasting and packing. Contract: [../../contracts/production.openapi.yaml](../../contracts/production.openapi.yaml).
Owner: [name]. Reviewer: [name].

## Run

Needs Node.js 20+ and the `production_db` database from [../../infra/init.sql](../../infra/init.sql).
Start `fulfilment` before this service (see the repo README's start order); this service does not
block startup on it, but packing an order returns 502 until `fulfilment` is up.

```
cp .env.example .env
npm install
npm start
```

Migrations in `migrations/*.sql` are applied at startup.

## Environment variables

| Variable | Default in `.env.example` | Meaning |
|---|---|---|
| `PORT` | `3002` | Port to listen on |
| `DATABASE_URL` | `postgres://production_user:production_pw@localhost:5432/production_db` | This service's own database and role |
| `FULFILMENT_URL` | `http://localhost:3003` | Where to tell fulfilment an order is ready to ship |

## Files

- `src/index.ts`: runs migrations, starts the server.
- `src/db.ts`: connection pool, transaction helper, migration runner.
- `src/app.ts`: all endpoints, validation and error mapping.
- `migrations/001_init.sql`: tables `production_batches`, `lines`.

## Behaviour worth knowing

- `POST /production-batches` is idempotent on `batchId`, so `ordering` can safely re-send after a failure.
  It never receives buyer name, contact or address; only `fulfilment` does.
- Packing a line marks it packed, then tells `fulfilment` (call 3). If that call fails it returns 502;
  the line's `ready_sent` flag stays false, so calling pack again retries only the notification, not the
  packing itself. Once `fulfilment` has confirmed, packing the same line again returns 409 AlreadyPacked.
