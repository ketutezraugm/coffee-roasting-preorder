# B4 demo: change one service, restart only it

Goal (about one minute on the screencast): show that `production` can change and restart while `ordering`
keeps running, and that nothing else needs touching.

The change: add one visible field, `estimatedDelivery`, to the shipment response of `production`
(`GET /shipments/{orderId}`). It is an optional new field, so by the contract policy it is a compatible change.

## Setup (before filming)

Three terminals, Postgres running (see the README).

| Terminal | Command |
|---|---|
| 1 | `cd services/production` then `npm start` |
| 2 | `cd services/ordering` then `HOLD_SECONDS=20 npm start` (PowerShell: `$env:HOLD_SECONDS=20; npm start`) |
| 3 | `cd scripts`, used for `npm run demo` and `curl` |

## Script

1. **Baseline.** In terminal 3 run `npm run demo`. Point at the line near step 8:
   `GET /shipments/... -> {"status":"Delivered","trackingNumber":"TRK-DEMO-1"}`. There is no `estimatedDelivery`.
2. **Show `ordering` is a separate process.** Leave terminal 2 visible. Note its process id
   (`Get-NetTCPConnection -LocalPort 3001 -State Listen | Select OwningProcess`), or just point out it will not restart.
3. **Amend the contract first.** In `contracts/production.openapi.yaml`, under `GET /shipments/{orderId}` → `200` → `properties`, add:
   ```yaml
   estimatedDelivery: { type: string, format: date }
   ```
4. **Change the code.** In `services/production/src/app.ts`, in `GET /shipments/:orderId`, replace the `res.json(...)` line with:
   ```ts
   const estimatedDelivery = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
   res.json({ status, ...(tracking_number && { trackingNumber: tracking_number, estimatedDelivery }) });
   ```
5. **Restart only `production`.** In terminal 1 press Ctrl+C, then `npm start` again.
   While it is down, run `curl localhost:3001/health` in terminal 3: `ordering` still answers `{"status":"ok"}`.
6. **Rerun the demo.** `npm run demo` in terminal 3. Every step still passes, and the shipment line now reads
   `{"status":"Delivered","trackingNumber":"TRK-DEMO-1","estimatedDelivery":"2026-..."}`.
7. **Close.** Terminal 2 shows no restart and no new log lines. `ordering` was never stopped, rebuilt or reconfigured,
   and it did not need to know about the new field.

## Why this works (say this out loud)

- `ordering` only calls `production` at two points (`POST /production-batches`, and receiving `POST /orders/{id}/complete`). Neither
  changed, so `ordering` has nothing to redeploy.
- Consumers ignore fields they do not know (`contracts/README.md`), so the extra field cannot break them.
- Each service has its own database, its own dependencies and its own start command, so restarting one does not touch the others.

## Rehearsal note

This flow was rehearsed once: `ordering` kept the same process id across the `production` restart, and the second demo run
passed with the new field in the output. The change was then reverted. The repo does not contain `estimatedDelivery`, so you can
film it fresh.
