# Coupling

## Calls between services

| # | Caller | Callee | What is sent | Type |
|---|---|---|---|---|
| 1 | ordering | production | `batchId`, bean, roast level, lines (`orderId`, pack size, grind, quantity) | Domain |
| 2 | ordering | fulfilment | `orderId`, recipient name, contact, address | Domain |
| 3 | production | fulfilment | `orderId` (order packed) | Domain |
| 4 | fulfilment | ordering | `orderId` (order delivered) | Domain |

Calls 2 and 4 form a runtime cycle (ordering to fulfilment and back). It is not a deploy-time cycle:
neither service needs the other to start, and each call is a plain request against a published
contract that can be repeated safely.

- Call 1 is idempotent on `batchId`.
- Call 2 is idempotent on `orderId`.
- Call 3 is idempotent: calling `ready` on a shipment already past `AwaitingPacking` returns 200 and changes nothing.
- Call 4 is idempotent on `orderId` (`complete` on an already-`Completed` order returns 200).

## Send nothing the callee does not use

- `production` never receives buyer name, contact or address. Only `fulfilment` does (call 2).
- `fulfilment` never receives `batchId` or price. It only needs enough to ship: recipient, address, tracking.
- Quota and money never leave `ordering`.

## Design log (how it actually evolved)

The report asks for a bad coupling found in the first draft and fixed. This is ours, and it is real,
not invented for the report.

- **2026-09-22, first draft:** started from three services (ordering, production, fulfilment) as in
  section 4 of BUILD_SPEC.md.
- **2026-09-22, merged to two:** for schedule reasons, merged fulfilment into production as a shipping
  module. Effect: `production` started receiving the shipping address in call 1, a pass-through it never
  uses for roasting or packing — exactly the "send nothing the callee does not use" rule it was supposed
  to follow. Calls "production to fulfilment" and "fulfilment to ordering" collapsed into in-process work.
- **2026-09-22, split back to three:** the team's event storming (BUILD_SPEC Step 2) independently found
  three bounded contexts, not two — Ordering (which itself folds payment into the `Order` aggregate,
  not a fourth "Payment" service), Production, and Fulfilment, each with its own aggregate, identity
  scheme and rules. The cohesion check (who needs to change for "add a shipping carrier" vs "change the
  roast process") routes to different services. That is a stronger signal than the schedule reasons for
  merging, so the build reverted: fulfilment split back out, address data now goes from ordering straight
  to fulfilment again (call 2), and production is back to receiving only pack size, grind and quantity.
- **Avoided pass-through:** the address never touches `production`, in either version of the design.
