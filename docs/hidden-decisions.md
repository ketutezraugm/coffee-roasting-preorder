# What each contract must NOT reveal

Report question: which internal change would break my consumers, and what stops it?

## ordering

| Hidden decision | Why consumers must not see it |
|---|---|
| Database engine and table shape (`batches`, `orders`, `payments`) | Consumers see only JSON from the API, so we can change schema or engine freely. |
| How quota is counted (a `claimed_grams` counter on the batch, updated atomically) | `remainingGrams` is the only exposed number. We could switch to summing orders without changing the contract. |
| How hold expiry works (background sweeper, its interval, the hold length) | Consumers only see `Expired` and `holdExpiresAt`. |
| Id scheme for `batchId` and `orderId` | Ids are opaque strings. Nobody may parse them. |
| Dispatch bookkeeping for `close` (which batches production has already received) | Only `Closed` and `dispatchedOrders` are visible. |

## production

| Hidden decision | Why consumers must not see it |
|---|---|
| Database engine and table shape (production batches, lines, shipments) | Ordering only calls `POST /production-batches` and never queries our data. |
| Internal state names beyond the ones in the contract (for example how "Delivered but ordering not yet told" is stored) | Consumers see `Delivered`, and a retry works whatever the storage. |
| That shipping is a module inside production, not its own service | We can split it out later. Callers of `/shipments/...` are the roaster and buyer, not ordering. |
| Id scheme for `productionBatchId` | Opaque string. |
| How the pack step updates the shipment (same transaction) | Callers see one `pack` call, not two steps. |

## What stops a breaking change

- Services never read each other's database (separate roles, checked by `scripts/check-isolation`).
- The only shared thing is the OpenAPI file, and the change policy in `contracts/README.md` requires a new version path for breaking changes.
- `scripts/demo` runs the full flow against the contracts, so a breaking change shows up as a failing step.
