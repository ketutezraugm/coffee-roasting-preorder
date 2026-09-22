# fulfilment service

Delivering. Owns shipments: recipient details, tracking number, delivery state.
Contract: [../../contracts/fulfilment.openapi.yaml](../../contracts/fulfilment.openapi.yaml).
Owner: [name]. Reviewer: [name].

## Run

Needs Node.js 20+ and the `fulfilment_db` database from [../../infra/init.sql](../../infra/init.sql).
Start this service first (see the repo README's start order); `production` and `ordering` both call it,
and neither needs to block startup on the other.

```
cp .env.example .env
npm install
npm start
```

Migrations in `migrations/*.sql` are applied at startup.

## Environment variables

| Variable | Default in `.env.example` | Meaning |
|---|---|---|
| `PORT` | `3003` | Port to listen on |
| `DATABASE_URL` | `postgres://fulfilment_user:fulfilment_pw@localhost:5432/fulfilment_db` | This service's own database and role |
| `ORDERING_URL` | `http://localhost:3001` | Where to tell `ordering` an order was delivered |

## Files

- `src/index.ts`: runs migrations, starts the server.
- `src/db.ts`: connection pool, transaction helper, migration runner.
- `src/app.ts`: all endpoints, validation and error mapping.
- `migrations/001_init.sql`: table `shipments`.

## Behaviour worth knowing

- `POST /shipments` is idempotent on `orderId` (call 2, from `ordering`).
- `POST /shipments/{orderId}/ready` is idempotent (call 3, from `production`): once a shipment is past
  `AwaitingPacking`, calling it again changes nothing.
- `confirm-receipt` marks the shipment `Delivered` first, then tells `ordering` (call 4). If `ordering` is
  down it returns 502 and remembers `ordering` was not told; calling it again re-sends only that notification.
