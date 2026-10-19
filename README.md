# gateway

Public entry for the Tripsi APIs: `api.tripsi.app` (production) and `qa.tripsi.app` (QA). On Vercel
it is only rewrites (`vercel.json`) that forward each prefix (`/spots`, `/partners`, `/restaurants`,
`/hotels`, `/commercial`, `/users`, `/config`, `/feedback`, `/notifications`, `/file`, `/posts`, …) to
its service origin (`*_ORIGIN` env vars). Requests to `*/internal/*` of the business services are
rejected with 404 before routing. Yarn.

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
