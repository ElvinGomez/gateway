# gateway

Public entry for the Tripsi APIs: `api.tripsi.app` (production) and `qa.tripsi.app` (QA). On Vercel
it is only rewrites (`vercel.json`) that forward each prefix (`/spots`, `/partners`, `/restaurants`,
`/hotels`, `/commercial`, `/users`, `/config`, `/feedback`, `/notifications`, `/file`, `/posts`,
`/stories`, `/rewards`, …) to
its service origin (`*_ORIGIN` env vars). Requests to `*/internal/*` of the business services, stories and rewards
are rejected with 404 before routing. Yarn.

## Local

`yarn dev` runs `scripts/local-proxy.mjs` on `:3080` with the origins from `.env`
(see `.env.example`). The mobile app points `EXPO_PUBLIC_API_URL` at it.

`node --env-file` does not override variables already exported in your shell: if the app suddenly
reads production flags, check that `CONFIG_ORIGIN` isn't exported in the terminal that started
the proxy.

## Verify

```bash
yarn lint      # tsc --noEmit
yarn test      # node --test tests/*.test.mjs (local proxy)
yarn build
```

A new service needs: a route in `vercel.json`, its `*_ORIGIN` in the Vercel project and in
`.env.example`, and the same mapping in `scripts/local-proxy.mjs`.

## Self-hosted (Docker)

`Dockerfile` runs `scripts/local-proxy.mjs` as the production gateway (plan:
`docs/plans/2026-11-20-vps-self-hosting-migration`). Behaviour that matters there:

- `x-forwarded-for` and `x-real-ip` are **overwritten** with `CF-Connecting-IP` (or the socket
  address). Services read the first XFF value, and Cloudflare only appends to what the client
  sent. Only expose the gateway through Cloudflare, or the header can be forged.
- 502/504 bodies are generic (`Bad gateway` / `Gateway timeout`); the origin variable and cause go
  to the log.
- Timeouts (ms, all optional): `GATEWAY_UPSTREAM_TIMEOUT_MS` (60000, idle upstream; not applied to
  `/config/stream`), `GATEWAY_KEEPALIVE_TIMEOUT_MS` (95000, above Traefik's 90 s idle),
  `GATEWAY_HEADERS_TIMEOUT_MS` (100000), `GATEWAY_REQUEST_TIMEOUT_MS` (120000),
  `GATEWAY_SHUTDOWN_GRACE_MS` (10000, drain on SIGTERM).
- `GATEWAY_ACCESS_LOG=1` logs one JSON line per request (method, path without query, status, ms).
