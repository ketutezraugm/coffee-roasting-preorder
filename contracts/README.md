# Contracts

One OpenAPI 3 file per service. These are the only thing services may depend on.

- [ordering.openapi.yaml](ordering.openapi.yaml)
- [production.openapi.yaml](production.openapi.yaml)

## Conventions

- Errors: `{ "error": "<Code>", "message": "<text>" }`, everywhere.
- Every service has `GET /health` returning `200 {"status":"ok"}`.
- Weights are integers in grams. Money is integer IDR.

## Change policy

- **Adding** an optional field, a new endpoint, or a new enum value a consumer can ignore is fine. Do it in the same path.
- **Removing or renaming** a field, endpoint, or error code, or changing a type, is a breaking change. It needs a new version path (`/v2/...`) served alongside the old one until every consumer has moved.
- Write the contract change first, then the code. Say in the commit message that the contract was amended.
- Consumers must ignore fields they do not know.

## Who calls whom

| Caller | Callee | Endpoint |
|---|---|---|
| ordering | production | `POST /production-batches` |
| production | ordering | `POST /orders/{orderId}/complete` |
