# Build Spec: Coffee Roasting Pre-Order App (Thin Version)

Course: Scalable Software Engineering, Assignment 1, Step 4 (build a thin version).
Audience: Claude Code, working with a team of three students.

## 0. How to work

1. Read this whole file before writing anything.
2. Work **phase by phase** (Section 9). At the end of each phase, stop, summarise what changed, and wait for the human to review and commit.
3. **Contracts come before code.** The graders check the git history. Phase 1 must end with a commit that contains only `/contracts` (and docs), made before any file exists under `/services`.
4. The service boundaries here are **provisional**. They come from the team's modelling so far, and event storming with a real domain expert may move them. If the human says the boundaries changed, update this file and the contracts first, then the code.
5. Do not fabricate authorship. Never set a commit author other than the person running you. Each team member owns one service and commits their own work under their own git identity. If asked to work on a service, tell the human which member owns it.
6. Keep the code simple enough that a student can explain every file in a live demo. Prefer plain SQL and plain HTTP over frameworks and abstractions.

## 1. What we are building

A pre-order system for a small coffee roaster who sells ground coffee in roasting batches.

- The **roaster** opens a pre-order batch with a fixed quota (in sellable grams).
- **Buyers** place orders (pack size, grind, quantity). The quota is held for each order.
- Unpaid orders release their quota after a hold time.
- Buyers pay (simulated bank transfer). Each payment is applied exactly once.
- The roaster closes the batch. It goes to production, where it is roasted, the actual sellable weight is recorded, and each order is ground and packed.
- Each order is shipped with a tracking number. The buyer confirms receipt.

**Hard rule:** the total weight of active orders (held or paid) in a batch never exceeds that batch's quota, even when many buyers order the last kilos at the same moment.

**Second rule (inside the same service):** a payment is applied to an order exactly once, even if the same payment callback arrives twice.

## 2. Non-negotiable constraints (from the handout)

| # | Requirement |
|---|---|
| B1 | Exactly **three** services plus a thin client. Not four. |
| B2 | Each service owns its data: **own database, own credentials**. No shared tables, no cross-service SQL, no shared entity classes. Graders will try to read another service's data using your service's credentials. It must fail. |
| B3 | Services talk **only through the published contract** (HTTP). Shared libraries are allowed for plumbing only (logging, HTTP helpers), never for domain objects. Prefer no shared library at all. |
| B4 | Change one service, restart only it, and everything else keeps running. |
| B5 | One owner per service. Each member owns one and reviews another. README and commit history must show this. |
| B6 | Anyone can run it from the README on a clean clone, with seed data. |

Also out of scope, and to be **left out on purpose**: login and accounts, styling, admin panel, real payment gateway, real courier API, shipping cost calculation, discounts, wholesale pricing, buying on credit, green-bean inventory, multiple roasters, mobile app, message broker.

Deductions to avoid: shared database or cross-service table access (-10), services that must deploy together (-10), services named after layers or tables (-5), more than three services (-5), contracts written after code (-5).

## 3. Stack decisions (defaults, the team may override before Phase 1)

| Decision | Default | Reason |
|---|---|---|
| Language | Node.js 20+ with TypeScript | The team can change this to whatever all three know |
| HTTP | Express or Fastify | Minimal |
| Database | PostgreSQL, one **database** per service, one **role** per service | Gives real separate credentials (B2) |
| DB access | `pg` with plain SQL, migrations as `.sql` files applied by the service at startup | No ORM, easy to explain |
| Service-to-service | Synchronous HTTP + JSON, base URLs from env vars | Communication styles come in a later assignment |
| Contracts | OpenAPI 3 YAML, one file per service | Readable and checkable |
| Infra | `infra/init.sql` creates the databases and roles. `infra/docker-compose.yml` runs Postgres (optional). The README also explains using a local Postgres. | Docker is optional in this course |
| Client | Node CLI scripts in `/scripts` (`seed`, `demo`) | Portable, no UI needed |

If the team picks a different language or database, keep every rule in this file the same.

## 4. Services (provisional)

> **Decide before Phase 1: two services or three?** The handout says start coarse, because splitting later is easy and merging back is not. Two services (`ordering`, plus a merged `production` that also ships) satisfy B1 and the "crossing at least two bounded contexts" requirement, and are noticeably less work in three weeks. Three give richer material for the report. If the team is unsure, build two and keep shipping as a module. Every rule below applies either way; if you merge, drop `fulfilment` from the tables and treat calls 2, 3 and 4 as in-process.
>
> **Decision (2026-09-22): two services, then reversed.** Built as `ordering` + `production` (shipping merged in) for schedule reasons. The team's event storming and bounded-context analysis (Step 2) then found **three** separate contexts — Ordering (which folds payment into its `Order` aggregate, not a fourth "Payment" service), Production, Fulfilment — with separate aggregates, separate identity schemes, and a cohesion check that routes their changes independently. That matches this table below, not the two-service merge, so the build reverts to three services: `ordering`, `production`, `fulfilment`. See `docs/coupling.md`'s design log for the full before/after.
>
> **Service names must come from the glossary** (Step 2). If the domain expert calls these areas something else, rename the services and the contracts to match before Phase 1. Names taken from layers or tables lose 5 marks.

| Service | Business area | Aggregates inside | Owns | Port |
|---|---|---|---|---|
| `ordering` | Taking pre-orders | **Batch** (quota, open/closed), **Order**, **Payment** (as a module) | The hard rule and the exactly-once payment rule | 3001 |
| `production` | Roasting and packing | **ProductionBatch** with its packing lines | Roast result and packing state | 3002 |
| `fulfilment` | Delivering | **Shipment** | Recipient details, tracking number, delivery state | 3003 |

Why payment is not its own service: the roaster only confirms a transfer, so payment has almost no rules of its own, and keeping it next to the quota keeps both rules in one transaction. Why `fulfilment` is separate: it is a different part of the business with a different owner of the data (recipient address, tracking). If event storming shows it is too thin, it can become a module inside `production`. Merging is allowed, splitting later is easy.

### Calls between services (this is the coupling table)

| # | Caller | Callee | What is sent | Type |
|---|---|---|---|---|
| 1 | ordering | production | Create production batch: `batchId`, bean, roast level, lines (`orderId`, pack size, grind, quantity) | Domain |
| 2 | ordering | fulfilment | Create shipment: `orderId`, recipient name, contact, address | Domain |
| 3 | production | fulfilment | Order packed: `orderId` | Domain |
| 4 | fulfilment | ordering | Order delivered: `orderId` | Domain |

**Send nothing the callee does not use.** `fulfilment` never needs `batchId`, so do not send it. Likewise `production` receives pack size, grind and quantity, never buyer or address data.

**Design choice that avoids pass-through coupling:** the shipping address goes from `ordering` straight to `fulfilment` (call 2). `production` never receives or forwards address data.

**Note on calls 2 and 4:** `ordering` calls `fulfilment` and `fulfilment` calls back into `ordering`. This is a dependency cycle at runtime, but not at deploy time: each call is fire-and-retry against a published contract, and either service starts and serves its other endpoints with the other one down. Be ready to defend this at the demo, and be sure neither service blocks startup on the other.

**For the report:** section 4.2 asks for a bad coupling found in your *first draft* and fixed, with before and after. Do not invent one. Record the design as it actually evolves while you build (`docs/coupling.md`), including anything you passed through a service before changing your mind. If nothing bad appears by the end, say so honestly and show the pass-through you avoided and why.

### Data ownership

- `ordering` → database `ordering_db`, role `ordering_user`
- `production` → database `production_db`, role `production_user`
- `fulfilment` → database `fulfilment_db`, role `fulfilment_user`

Each role can connect to **its own database only**. `infra/init.sql` must revoke public connect and must not grant any role access to another database. No service imports another service's code or types.

## 5. Contracts (write these first)

Write one OpenAPI file per service: `contracts/ordering.openapi.yaml`, `contracts/production.openapi.yaml`, `contracts/fulfilment.openapi.yaml`. Also add `contracts/README.md` explaining the change policy: adding fields is fine, removing or renaming a field needs a new version path.

Errors use one shape everywhere: `{ "error": "<Code>", "message": "<text>" }`.
Every service also exposes `GET /health` → `200 {"status":"ok"}`.
Weights are integers in **grams**. Money is integer IDR.

### 5.1 ordering

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /batches` `{beanName, roastLevel, quotaGrams, pricePerKgIdr, closesAt}` | Roaster opens a batch | `201 {batchId, status:"Open"}` | `422 InvalidBatch` |
| `GET /batches` | List batches | `200 [{batchId, beanName, roastLevel, status, quotaGrams, remainingGrams, pricePerKgIdr}]` | |
| `GET /batches/{batchId}` | One batch | `200` same fields | `404` |
| `POST /batches/{batchId}/orders` `{buyerName, buyerContact, shippingAddress, packSizeGrams, grind, quantity}` | Place an order and hold quota | `201 {orderId, totalGrams, amountIdr, holdExpiresAt}` | `409 QuotaExceeded`, `409 BatchNotOpen`, `422 InvalidOrder` |
| `GET /orders/{orderId}` | One order | `200 {orderId, batchId, status, totalGrams, amountIdr, holdExpiresAt}` | `404` |
| `POST /orders/{orderId}/payments` `{paymentRef, amountIdr}` | Apply a payment | `200 {orderStatus:"Paid", duplicate:false}` (a repeated `paymentRef` returns `200 {duplicate:true}` and changes nothing) | `409 OrderExpired`, `409 AlreadyPaid`, `422 AmountMismatch`, `404` |
| `POST /batches/{batchId}/close` | Close the batch and send it to production | `200 {status:"Closed", dispatchedOrders:n}` (safe to call again, it re-sends idempotently) | `409 NoPaidOrders`, `502 DownstreamUnavailable` |
| `POST /orders/{orderId}/complete` | Called by `fulfilment` on delivery | `200 {status:"Completed"}` (idempotent) | `409 NotInProduction`, `404` |

Allowed values: `packSizeGrams` ∈ {100, 250, 500, 1000}; `grind` ∈ {wholeBean, filter, espresso} (per the domain glossary, superseding this file's earlier coarse/medium/fine placeholder); `roastLevel` ∈ {light, medium, dark}; `quantity` ≥ 1.
`totalGrams = packSizeGrams × quantity`. `amountIdr = round(totalGrams × pricePerKgIdr / 1000)`, computed by `ordering` and stored on the order, so a later price change never alters an existing order's amount. Payment must match the stored amount exactly.
Order states: `Held → Paid → InProduction → Completed`, and `Held → Expired`.
Batch states: `Open → Closed`.

### 5.2 production

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /production-batches` `{batchId, beanName, roastLevel, lines:[{orderId, packSizeGrams, grind, quantity}]}` | Receive a closed batch | `201 {productionBatchId, status:"Queued"}` (same `batchId` again returns `200` with the existing one) | `422` |
| `GET /production-batches/{id}` | Status and lines | `200` | `404` |
| `POST /production-batches/{id}/roast` `{actualSellableGrams}` | Record the roast result | `200 {status:"Roasted"}` | `409 AlreadyRoasted` |
| `GET /production-batches/{id}/packing-list` | What to grind and pack per order | `200 [{orderId, packSizeGrams, grind, quantity, packed}]` | `404` |
| `POST /production-batches/{id}/lines/{orderId}/pack` | Mark one order packed, tell `fulfilment` | `200 {lineStatus:"Packed", batchStatus}` (batch becomes `Packed` when all lines are packed) | `409 NotRoasted`, `409 AlreadyPacked`, `404` |

States: `Queued → Roasted → Packed`.

### 5.3 fulfilment

| Endpoint | Purpose | Success | Errors |
|---|---|---|---|
| `POST /shipments` `{orderId, recipientName, contact, address}` | Create a shipment | `201 {shipmentId, status:"AwaitingPacking"}` (same `orderId` again returns `200`) | `422` |
| `POST /shipments/{orderId}/ready` | Called by `production` | `200 {status:"ReadyToShip"}` | `404`, `409` |
| `POST /shipments/{orderId}/ship` `{trackingNumber}` | Roaster ships it | `200 {status:"Shipped"}` | `409 NotReady`, `404` |
| `POST /shipments/{orderId}/confirm-receipt` | Buyer confirms, then calls `ordering` | `200 {status:"Delivered"}` | `409 NotShipped`, `404`, `502` |
| `GET /shipments/{orderId}` | Status | `200 {status, trackingNumber?}` | `404` |

States: `AwaitingPacking → ReadyToShip → Shipped → Delivered`.

### 5.4 What each contract must NOT reveal (document in `docs/`)

For each service list three internal decisions hidden from consumers, for example: database engine, table shape, internal state names, id scheme, how the hold-expiry sweep works, how quota is counted. The report asks: "which internal change would break my consumers, and what stops it?"

## 6. Behaviour that must be true

### 6.1 Quota claim (the hard rule)

The claim must be **one atomic conditional statement**, not read-then-write:

```sql
UPDATE batches
   SET claimed_grams = claimed_grams + $grams
 WHERE id = $batchId
   AND status = 'Open'
   AND closes_at > now()
   AND claimed_grams + $grams <= quota_grams;
```

If zero rows are updated, return `409 QuotaExceeded` (or `BatchNotOpen` if the batch is not open). Insert the order in the **same transaction**. Never check quota in application code and then update.

### 6.2 Hold and expiry

- An order starts `Held` with `holdExpiresAt = now + HOLD_SECONDS`.
- **Pick a hold length the domain justifies, and say why in the report.** Buyers pay by manual bank transfer, so hours, not minutes: 12 hours (`43200`) is the default here. Do not use 10 minutes; that is the handout's running example, and it makes no sense for this domain. For the demo and tests, override with a short value (see Section 10).
- A background sweeper (every `SWEEP_INTERVAL_SECONDS`) expires overdue `Held` orders and releases their grams in one transaction:
  `UPDATE orders SET status='Expired' WHERE status='Held' AND hold_expires_at < now() RETURNING ...` then decrease `claimed_grams`.
- Payment uses a conditional update too: `WHERE status='Held' AND hold_expires_at >= now()`. This keeps payment and expiry from racing.

### 6.3 Payment exactly once

- Table `payments` has a **unique** constraint on `payment_ref`.
- Applying a payment inserts the payment and moves the order `Held → Paid` in one transaction.
- The same `paymentRef` again returns `200 {duplicate:true}` and changes nothing. A different `paymentRef` for an already paid order returns `409 AlreadyPaid`.

### 6.4 Closing a batch

In one transaction: mark the batch `Closed`, expire all remaining `Held` orders (release their grams), and move `Paid` orders to `InProduction`. Then call `production` (call 1) and `fulfilment` (call 2, once per paid order), recording per order whether the dispatch succeeded.

Calling `close` on an already-closed batch must **not** error: it re-attempts only the dispatches still marked unsent and returns `200`. This is what makes the operation safe to retry when a downstream service is down, and it is why the downstream endpoints in Sections 5.2 and 5.3 return the existing record instead of a conflict when called twice.

No broker, no retry queues, no automatic background retry. A partial close (batch closed, some dispatches unsent) is a visible, acceptable state that the operator resolves by calling `close` again. **Write down the first time this bites you**, because Reflection 5.a asks which cost from Chapter 1 hit you first, and this is almost certainly it.

### 6.5 Other rules

- `production` cannot pack before the roast is recorded, and a roast is recorded once.
- `fulfilment` cannot ship before the order is ready, and cannot confirm receipt before shipping.
- Delivery triggers call 4, which moves the order to `Completed`.

## 7. Repo layout

```
/README.md            what it is, how to run it, who owns what
/BUILD_SPEC.md        this file
/docs/                report.pdf, glossary, aggregates, contexts, diagram, hidden-decisions notes
/contracts/           one OpenAPI file per service, committed before the code
/infra/               init.sql, docker-compose.yml (Postgres, optional)
/services/ordering/   own README, own package/dependency file, own migrations
/services/production/ same
/services/fulfilment/ same
/scripts/             seed, demo, check-isolation
```

Each service is fully self-contained: its own dependency file, its own `.env.example`, its own start command. No root-level build that couples them.

Environment variables per service (document all in each service README):

| Service | Variables |
|---|---|
| ordering | `PORT=3001`, `DATABASE_URL`, `PRODUCTION_URL`, `FULFILMENT_URL`, `HOLD_SECONDS=43200`, `SWEEP_INTERVAL_SECONDS=5` |
| production | `PORT=3002`, `DATABASE_URL`, `FULFILMENT_URL` |
| fulfilment | `PORT=3003`, `DATABASE_URL`, `ORDERING_URL` |

## 8. Scripts

- `seed`: creates a demo batch through the `ordering` API (quota 3000 g, 100000 IDR per kg). It uses the contract, not SQL.
- `demo`: runs the full scenario in Section 10 against the running services and prints PASS/FAIL per step.
- `check-isolation`: tries to connect to each database using the **other** services' credentials and must fail every time. Also confirms no service reads another's tables.
- `concurrency-test`: fires many simultaneous order requests at a batch with little quota left and asserts that the total claimed grams never exceeds the quota and that the counts match the orders stored.

## 9. Phases

**Phase 0: scaffold.** Repo layout, `.gitignore`, README skeleton with an ownership table (`[Member 1]`, `[Member 2]`, `[Member 3]` as placeholders), `infra/init.sql`. Stop for review.

**Phase 1: contracts.** Write the three OpenAPI files and `contracts/README.md`, plus `docs/hidden-decisions.md` (Section 5.4), `docs/coupling.md` (Section 4 table) and `docs/cost-of-change.md` (report section 4.3: pick three changes someone could really ask for next semester, for example "sell by pack rather than by weight", "let a buyer cancel a paid order and refund", "add a second roaster"; for each, say which services must change and whether they must be released together). **Stop. The human commits `/contracts` and `/docs` before any service code exists** — the graders check `git log` for this.

**Phase 2: services, one at a time.** In this order: `fulfilment`, `production`, `ordering` (leaf services first so calls have somewhere to land). Each service: migrations, endpoints exactly as in the contract, its own README, `GET /health`. After each, verify with curl and stop for review. If implementation reveals a needed contract change, stop and tell the human. Update the contract first and note that the contract was amended.

**Phase 3: scripts and isolation.** `seed`, `demo`, `check-isolation`, `concurrency-test`.

**Phase 4: independent deployability (B4).** Write `docs/b4-demo.md`: a short script for the screencast. Example: add one visible field to the `fulfilment` shipment response (for example `estimatedDelivery`), restart only `fulfilment`, rerun `demo`, and show the new field while `ordering` and `production` keep running.

**Phase 5: README.** Follow Section 11, then test it from a fresh clone in an empty directory, following the README exactly.

## 10. Demo scenario

Run the whole of this in the `demo` script. The **screencast is only three minutes**, so film steps 1 to 4 and 6 to 9 (about two minutes), then spend the last minute on B4 (Section 9, Phase 4). Steps 5, 10 and the two test scripts are run live at the Week 5 lab, not on video.

Run the demo with `HOLD_SECONDS=20` so step 5 finishes in seconds; the production default stays 43200.

1. Seed: open a batch with quota **3000 g**.
2. Place three orders of 1000 g each (three buyers), each gets `201`.
3. Place a fourth order of 1000 g. It is rejected with `409 QuotaExceeded`. **This is the hard rule.**
4. Pay for order 1. Send the same payment again with the same `paymentRef`. It returns `duplicate:true` and the order is still `Paid` once.
5. Wait for the hold on order 3 to expire. Its grams are released, and a new order for 1000 g now succeeds.
6. Pay for orders 1 and 2. Close the batch (remaining held orders expire, paid orders go to production).
7. In `production`: roast (record actual sellable grams), read the packing list, pack each paid order.
8. In `fulfilment`: ship each order with a tracking number, then confirm receipt.
9. Check that `ordering` shows the orders `Completed`.
10. Run `concurrency-test` and `check-isolation`, both must pass.

## 11. README requirements

The README must let a stranger run everything from a clean clone:

- Prerequisites and versions.
- How to start Postgres and create databases/roles (`infra/init.sql`).
- For each service: what to run, which port, which environment variables. State the **start order** (`fulfilment`, `production`, `ordering`).
- How to seed and how to run `demo`.
- An ownership table: service → owner → reviewer (placeholders for the human to fill).
- How to demonstrate B4.

## 12. What this spec does and does not cover

This spec covers Step 4 (the build) and the parts of Step 3 that must exist as files (contracts, coupling table, cost-of-change, hidden decisions). It does **not** produce, and the team must write by hand:

- Step 2 in full: event storming photo and 20+ events, the 12-term glossary with two context-dependent terms, four aggregate cards, three to five bounded contexts. These come from the interview, and they are worth 30 of the 100 marks.
- The service boundary diagram.
- The report (max 8 pages) and the reflection.

The repo layout in Section 7 adds `/infra`, `/scripts` and `BUILD_SPEC.md` to the four paths the handout names. That is fine; the named paths must all exist with the contents the handout lists.

## 13. Definition of done

- [ ] Exactly three services, each with its own database and credentials.
- [ ] `check-isolation` passes. No cross-service SQL anywhere.
- [ ] Contracts committed **before** any service code (verify in `git log`).
- [ ] Hard rule holds under `concurrency-test`.
- [ ] Duplicate payment applied once.
- [ ] `demo` passes end to end on a clean clone following only the README.
- [ ] One service can be changed and restarted alone while the others keep running.
- [ ] No shared domain classes or shared domain library.
- [ ] Ownership and reviewer per service documented.
