# Cost of change

Three changes someone could really ask for next semester. For each: which services change, and must they be released together?

## 1. Sell by pack instead of by weight

Quota would count packs, not grams, so a batch says "40 packs" instead of "3000 g".

| Service | Change |
|---|---|
| ordering | Quota unit, the claim statement, `remainingGrams` becomes packs, price per pack. |
| production | None. Lines already carry pack size and quantity. |

**Release together?** No. `POST /production-batches` is unchanged. Ordering's own contract changes, so ordering
clients move to a new version path (`/v2/batches`) while `/batches` stays until they migrate.

## 2. Buyer cancels a paid order and gets a refund

| Service | Change |
|---|---|
| ordering | New `Cancelled` state, a refund record, release the quota, and call production and fulfilment if the order was already dispatched. |
| production | New endpoint to remove a line (or mark it cancelled), refused once packed. |
| fulfilment | New endpoint to cancel a shipment, refused once shipped. |

**Release together?** No, but there is an order: production and fulfilment first (new endpoints, additive),
then ordering (starts calling them). If ordering goes first, cancelling an already-dispatched order fails
with 404, so it must only cancel orders that were never dispatched until the other two have the endpoints.

## 3. Add a second roaster

| Service | Change |
|---|---|
| ordering | Batches belong to a roaster, so add `roasterId` to batches and list filtering. |
| production | Production batches, roast and packing belong to a roaster, so add an optional `roasterId` to `POST /production-batches`. |

**Release together?** No. `roasterId` is an optional new field, so old callers keep working. Deploy production first,
then ordering starts sending it. Sending a field production does not yet know is ignored by design (see
`contracts/README.md`).
