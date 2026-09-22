# What each contract must NOT reveal

Report question: which internal change would break my consumers, and what stops it?

## ordering

| Hidden decision | Why consumers must not see it |
|---|---|
| Database engine and table shape (`batches`, `orders`, `payments`) | Consumers see only JSON from the API, so we can change schema or engine freely. |
| How quota is counted (a `claimed_grams` counter on the batch, updated atomically) | `remainingGrams` is the only exposed number. We could switch to summing orders without changing the contract. |
| How hold expiry works (background sweeper, its interval, the hold length) | Consumers only see `Expired` and `holdExpiresAt`. |
| Id scheme for `batchId` and `orderId` | Ids are opaque strings. Nobody may parse them. |
| Which of the two downstream calls on `close` (to production, to fulfilment per order) still need retrying | Only `Closed` and `dispatchedOrders` are visible. |

## production

| Hidden decision | Why consumers must not see it |
|---|---|
| Database engine and table shape (production batches, lines) | Ordering only calls `POST /production-batches` and never queries our data. |
| Internal state names beyond the ones in the contract | Consumers see `Queued`/`Roasted`/`Packed`, whatever the storage. |
| That packing tells fulfilment over HTTP (call 3), not a shared table | Fulfilment sees only `POST /shipments/{orderId}/ready`. |
| Id scheme for `productionBatchId` | Opaque string. |

## fulfilment

| Hidden decision | Why consumers must not see it |
|---|---|
| Database engine and table shape (shipments) | Ordering and production only call the endpoints in the contract. |
| Internal state names beyond `AwaitingPacking`/`ReadyToShip`/`Shipped`/`Delivered` | Nothing else is exposed. |
| Id scheme for `shipmentId` | The public key for status lookups is `orderId`, not `shipmentId`. |
| Whether ordering was already told about a delivery (so confirm-receipt can be retried) | Callers only see `Delivered` and a possible 502. |

## What stops a breaking change

- Services never read each other's database (separate roles, checked by `scripts/check-isolation`).
- The only shared thing is the OpenAPI file, and the change policy in `contracts/README.md` requires a new version path for breaking changes.
- `scripts/demo` runs the full flow against the contracts, so a breaking change shows up as a failing step.
