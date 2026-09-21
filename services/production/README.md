# production service

Roasting, packing and shipping. Contract: [../../contracts/production.openapi.yaml](../../contracts/production.openapi.yaml).
Owner: [name]. Reviewer: [name].

## Run

Needs Node.js 20+ and the `production_db` database from [../../infra/init.sql](../../infra/init.sql).

```
cp .env.example .env
npm install
npm start
```

Migrations in `migrations/*.sql` are applied at startup. The service does not call `ordering` at startup,
so it starts fine while `ordering` is down.

## Environment variables

| Variable | Default in `.env.example` | Meaning |
|---|---|---|
| `PORT` | `3002` | Port to listen on |
| `DATABASE_URL` | `postgres://production_user:production_pw@localhost:5432/production_db` | This service's own database and role |
| `ORDERING_URL` | `http://localhost:3001` | Where to tell `ordering` an order was delivered |

## Files

- `src/index.ts`: runs migrations, starts the server.
- `src/db.ts`: connection pool, transaction helper, migration runner.
- `src/app.ts`: all endpoints, validation and error mapping.
- `migrations/001_init.sql`: tables `production_batches`, `lines`, `shipments`.

## Behaviour worth knowing

- `POST /production-batches` is idempotent on `batchId`, so `ordering` can safely re-send after a failure.
- Packing a line moves its shipment to `ReadyToShip` in the same transaction.
- `confirm-receipt` marks the shipment `Delivered` first, then tells `ordering`. If `ordering` is down it
  returns 502 and remembers that `ordering` was not told. Calling it again re-sends only that notification.
