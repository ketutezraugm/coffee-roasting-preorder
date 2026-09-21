# Coupling

## Calls between services

| # | Caller | Callee | What is sent | Type |
|---|---|---|---|---|
| 1 | ordering | production | `batchId`, bean, roast level, and per line: `orderId`, pack size, grind, quantity, recipient name, contact, address | Domain |
| 2 | production | ordering | `orderId` (buyer confirmed receipt) | Domain |

The two calls form a runtime cycle (ordering to production and back). It is not a deploy-time cycle:
neither service needs the other to start, and each call is a plain request against a published
contract that can be repeated safely.

- Call 1 is idempotent on `batchId`. `close` can be repeated if production was down.
- Call 2 is idempotent on `orderId`. `confirm-receipt` can be repeated if ordering was down.

## Send nothing the callee does not use

- Production receives no price, no payment data, no buyer id beyond what shipping needs.
- Ordering receives nothing from production except `orderId` on delivery.
- Quota and money never leave ordering.

## Design log (how it actually evolved)

Add an entry whenever the design changes, including anything passed through a service before it was fixed.
The report asks for a bad coupling found in the first draft. Do not invent one.

- **2026-09-22:** Started from three services (ordering, production, fulfilment). Merged fulfilment into
  production for schedule reasons. Effect: the shipping address is now sent to production in call 1
  instead of straight to a separate fulfilment service. Calls "production to fulfilment" and
  "fulfilment to ordering" collapsed into in-process work and call 2 above.
- **Avoided pass-through:** address data goes from ordering directly to the service that ships. It is not
  relayed through a third service.
