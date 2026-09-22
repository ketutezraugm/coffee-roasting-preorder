# B4 demo: change one service, restart only it

Goal (about one minute on the screencast): show that `fulfilment` can change and restart while `ordering`
and `production` keep running, and that nothing else needs touching.

The change: add one visible field, `estimatedDelivery`, to the shipment response of `fulfilment`
(`GET /shipments/{orderId}`), exactly BUILD_SPEC's own Phase 4 example. It is an optional new field,
so by the contract policy it is a compatible change.

## Setup (before filming)

Four terminals, Postgres running (see the README).

| Terminal | Command |
|---|---|
| 1 | `cd services/fulfilment` then `npm start` |
| 2 | `cd services/production` then `npm start` |
| 3 | `cd services/ordering` then `HOLD_SECONDS=20 npm start` (PowerShell: `$env:HOLD_SECONDS=20; npm start`) |
| 4 | `cd scripts`, used for `npm run demo` and `curl` |

## Script

1. **Baseline.** In terminal 4 run `npm run demo`. Point at the line near step 8:
   `GET /shipments/... -> {"status":"Delivered","trackingNumber":"TRK-DEMO-1"}`. There is no `estimatedDelivery`.
2. **Show `ordering` and `production` are separate processes.** Leave terminals 2 and 3 visible. Note their
   process ids (`Get-NetTCPConnection -LocalPort 3001,3002 -State Listen | Select OwningProcess`), or just
   point out they will not restart.
3. **Amend the contract first.** In `contracts/fulfilment.openapi.yaml`, under `GET /shipments/{orderId}` → `200` → `properties`, add:
   ```yaml
   estimatedDelivery: { type: string, format: date }
   ```
4. **Change the code.** In `services/fulfilment/src/app.ts`, in `GET /shipments/:orderId`, replace the `res.json(...)` line with:
   ```ts
   const estimatedDelivery = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
   res.json({ status, ...(tracking_number && { trackingNumber: tracking_number, estimatedDelivery }) });
   ```
5. **Restart only `fulfilment`.** In terminal 1 press Ctrl+C, then `npm start` again.
   While it is down, run `curl localhost:3001/health` and `curl localhost:3002/health` in terminal 4:
   `ordering` and `production` still answer `{"status":"ok"}`.
6. **Rerun the demo.** `npm run demo` in terminal 4. Every step still passes, and the shipment line now reads
   `{"status":"Delivered","trackingNumber":"TRK-DEMO-1","estimatedDelivery":"2026-..."}`.
7. **Close.** Terminals 2 and 3 show no restart and no new log lines. Neither `ordering` nor `production` was
   stopped, rebuilt or reconfigured, and neither needed to know about the new field.

## Why this works (say this out loud)

- `production` only calls `fulfilment` at one point (`POST /shipments/{orderId}/ready`), and `ordering` only
  calls it at one point (`POST /shipments`). Neither endpoint changed, so neither service has anything to redeploy.
- Consumers ignore fields they do not know (`contracts/README.md`), so the extra field cannot break them.
- Each service has its own database, its own dependencies and its own start command, so restarting one does
  not touch the others.

## Rehearsal note

This flow was rehearsed against the three-service split: `ordering` and `production` kept the same process
ids across the `fulfilment` restart, both answered `/health` while it was down, and the second demo run
passed with `estimatedDelivery` in the output. The change was then reverted. The repo does not contain
`estimatedDelivery`, so you can film it fresh.
