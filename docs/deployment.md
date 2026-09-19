# Deployment

This guide deploys SpacKt as two services.
The backend is a Render Docker web service.
The frontend is a Render static site.

Do not add secrets to this repository.
The current app does not need private runtime secrets.

## Local Container Check

Run this command from the repository root:

```sh
docker compose up --build --wait
```

The backend publishes `http://localhost:8080`.
The frontend publishes `http://localhost:3000`.

Stop the services after testing:

```sh
docker compose down --remove-orphans
```

## Render Services

`render.yaml` defines these services:

| Service | Type | Runtime | Health check |
| --- | --- | --- | --- |
| `spackt-api` | Web service | Docker | `/readyz` |
| `spackt-web` | Static site | Static export | Render static hosting |

The blueprint uses `autoDeployTrigger: checksPass`.
This setting tells Render to deploy after linked checks pass.
Verify the setting in the Render dashboard after blueprint creation.

## First Render Setup

Create the blueprint from `render.yaml`.
Render creates service URLs during this step.

Set backend environment values:

| Name | Value |
| --- | --- |
| `PORT` | `8080` |
| `SPACKT_ALLOWED_ORIGINS` | Exact frontend origin, for example `https://spackt-web.onrender.com` |

Set frontend environment values:

| Name | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Exact backend origin, for example `https://spackt-api.onrender.com` |

Use origins only.
Do not include a path, query string, or trailing route.

After you set `NEXT_PUBLIC_API_URL`, rebuild the frontend.
The static export stores this value at build time.

## Backend Deployment

The backend image is built from [backend/Dockerfile](../backend/Dockerfile).
The final image runs as a non-root user.
It exposes port `8080`.

The server command is:

```sh
/spackt-server
```

The image healthcheck runs:

```sh
/spackt-server -healthcheck
```

Without `-healthcheck-url`, it checks `http://127.0.0.1:$PORT/readyz`.

## Frontend Deployment

The frontend build runs in the `web` directory:

```sh
npm ci
npm run build
```

The Next.js config uses static export.
The published directory is `web/out`.

The Docker frontend image serves the static export through Nginx.
Render static hosting serves the same generated files without that Nginx image.

## Browser Security Headers

The Nginx container sets these headers:

| Header | Value |
| --- | --- |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |

The static export also adds a CSP meta tag.
The CSP script policy uses hashes for generated inline scripts.
The style policy permits `'unsafe-inline'` because the static frontend uses inline style positions.
The `connect-src` directive allows the configured HTTP origin and its WebSocket origin.

Use the same response headers on Render static hosting.
Configure them in the static host settings or blueprint.

`X-Frame-Options` is a response header.
A CSP meta tag cannot set `frame-ancestors`.
Use the hosting service header feature if you need `frame-ancestors` on a static host.

## CORS And WebSocket Origin

Configure `SPACKT_ALLOWED_ORIGINS` with exact frontend origins.
Separate multiple origins with commas.

The backend uses this list for REST CORS.
It also checks WebSocket upgrade origins.
The app does not use cookies or browser credentials for market data.

## Environment Variables

Backend:

| Name | Default | Bound |
| --- | --- | --- |
| `PORT` | `8080` | `1` to `65535` |
| `SPACKT_SEED` | `7` | signed integer |
| `SPACKT_EPOCH_MS` | `0` | zero for relative epoch, or a fixed safe epoch minus history span |
| `SPACKT_HISTORY_MINUTES` | `360` | `1` to `1440` |
| `SPACKT_ALLOWED_ORIGINS` | local origins | comma-separated HTTP or HTTPS origins |
| `SPACKT_DEBUG_CONTROLS` | `true` | `true` or `false` |
| `SPACKT_MAX_CONNECTIONS` | `100` | `1` to `100` |
| `SPACKT_MARKET_FRAME_BUDGET_BYTES` | `1048576` | `1` to `1048576` |
| `SPACKT_BOOK_CHANGES` | `4096` | `1` to `4096` |

Frontend:

| Name | Default | Bound |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | HTTP or HTTPS origin only |

## Release Verification

Run these checks before publishing a release:

```sh
go -C backend test -race -timeout 300s ./...
go -C backend vet ./...
go -C backend run ./cmd/checkrepo -root .. -mode local
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web run test:coverage
npm --prefix web run test:security
npm --prefix web run build
docker compose config --quiet
docker compose up --build --wait
```

Run browser tests against the running container services:

```sh
WEB_URL=http://localhost:3000 BACKEND_URL=http://localhost:8080 npm --prefix web run test:e2e:container
```

Do not mark the deployed app ready until `/readyz` returns `200`.
Do not share a deployment address until the frontend connects to the deployed backend.
