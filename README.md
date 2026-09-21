# Coffee Roasting Pre-Order App (thin version)

A pre-order system for a small coffee roaster who sells ground coffee in roasting batches.
The roaster opens a batch with a fixed quota (in grams), buyers order and pay, the roaster closes the batch,
it is roasted, packed and shipped, and the buyer confirms receipt.

Scalable Software Engineering, Assignment 1. Full spec: [BUILD_SPEC.md](BUILD_SPEC.md).

Two rules the design is built around:

- **Quota:** the total weight of active orders in a batch never exceeds its quota, even when many buyers order the last kilos at once.
- **Payment:** a payment is applied to an order exactly once, even if the same payment arrives twice.

## Services (provisional)

| Service | Business area | Port | Database / role |
|---|---|---|---|
| `ordering` | Taking pre-orders: batches, quota, orders, payments | 3001 | `ordering_db` / `ordering_user` |
| `production` | Roasting, packing and shipping | 3002 | `production_db` / `production_user` |

Each service has its own database and credentials and never touches the other's data. They talk only over HTTP,
following the OpenAPI files in [contracts/](contracts/). The client is a set of Node scripts in [scripts/](scripts/).

## Ownership

| Area | Owner | Reviewer |
|---|---|---|
| `ordering` | [name] | [name] |
| `production` (incl. shipping module) | [name] | [name] |
| Client and scripts (`seed`, `demo`, `check-isolation`, `concurrency-test`), contracts, README | [name] | Reviews both services |

We run two services with three members, so the third member owns the client and test harness.
Each owner runs Claude Code on their own service and commits under their own git identity.

## Prerequisites

- **Node.js 20.6 or newer** (the services use `node --env-file`) and npm.
- **PostgreSQL 13 or newer**, either through Docker (easiest) or a local install.
- Ports `3001`, `3002` and `5432` free.

## Run it

All commands are run from the repository root unless a `cd` is shown. Examples use bash;
PowerShell differences are noted.

### 1. Start Postgres and create the databases

Option A, Docker (creates both databases and roles automatically on first start):

```
docker compose -f infra/docker-compose.yml up -d
```

Wait a few seconds for Postgres to accept connections. `infra/init.sql` only runs when the data volume is new;
to start over, run `docker compose -f infra/docker-compose.yml down -v` and repeat.

Option B, a local Postgres:

```
psql -U postgres -f infra/init.sql
```

Either way this creates `ordering_db` and `production_db`, each owned by its own role (dev passwords are in `infra/init.sql`),
and each role can connect to its own database only.

### 2. Install dependencies and create env files

Run this once in each of `services/production`, `services/ordering` and `scripts`:

```
cd services/production && npm install && cp .env.example .env && cd ../..
cd services/ordering   && npm install && cp .env.example .env && cd ../..
cd scripts             && npm install && cd ..
```

Notes: `npm` may warn that esbuild's install script is blocked. That is fine, everything runs without it.
On PowerShell use `;` instead of `&&` (or run the commands one by one).

### 3. Start the services (in this order)

Use two terminals. **Start order: `production`, then `ordering`.** (`ordering` starts without `production`, but closing a batch
answers 502 until `production` is up.)

Terminal 1:

```
cd services/production
npm start
```

Terminal 2. For the demo, shorten the payment hold to 20 seconds (the real default is 12 hours, see below):

```
cd services/ordering
HOLD_SECONDS=20 npm start
```

PowerShell: `$env:HOLD_SECONDS=20; npm start`

Each service applies its own database migrations at startup and exposes `GET /health`. Per-service details and environment
variables: [services/ordering/README.md](services/ordering/README.md), [services/production/README.md](services/production/README.md).

**Why 12 hours in real use:** buyers pay by manual bank transfer, so a hold measured in minutes would expire before they finish paying.

### 4. Seed and run the demo

In a third terminal:

```
cd scripts
npm run seed     # opens a batch (3000 g quota, 100000 IDR per kg) through the ordering API
npm run demo     # runs the whole scenario and prints PASS/FAIL per step
```

`demo` takes about 30 seconds (step 5 waits for a hold to expire) and ends with `ALL PASSED`.
It opens its own batch, so seeding first is optional, and it can be run repeatedly.

Step 10 of the demo runs the two checks below. They can also be run on their own:

```
npm run concurrency-test   # many simultaneous orders on the last kilo: quota is never exceeded
npm run check-isolation    # each service's DB credentials are refused by the other service's database
```

## Demonstrate independent deployability (B4)

Change one service, restart only it, and the other keeps running: see [docs/b4-demo.md](docs/b4-demo.md).

## Stop and reset

Stop each service with Ctrl+C. To remove the Docker database and start fresh:
`docker compose -f infra/docker-compose.yml down -v`.

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | One OpenAPI file per service and the change policy. Written before any service code. |
| `docs/` | Coupling table, hidden decisions, cost of change, B4 script |
| `infra/` | `init.sql` (databases and roles), `docker-compose.yml` (optional Postgres) |
| `services/ordering/` | Ordering service: own dependencies, migrations, env file |
| `services/production/` | Production service: same |
| `scripts/` | `seed`, `demo`, `check-isolation`, `concurrency-test` |

## Troubleshooting

- **`ECONNREFUSED` on port 5432:** Postgres is not running or is still starting. Wait a few seconds.
- **`password authentication failed` or `database ... does not exist`:** `init.sql` has not run. Repeat step 1.
- **Demo stops at step 5 with "Restart ordering with HOLD_SECONDS=20":** `ordering` was started without the short hold.
- **`EADDRINUSE`:** another process uses port 3001 or 3002. Stop it, or change `PORT` in the service's `.env` (and the matching `*_URL` in the other service and in the scripts via `ORDERING_URL` / `PRODUCTION_URL`).
