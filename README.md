# SpacKt

SpacKt, pronounced **Space Cat**, simulates a BTC-USD market with a Go backend and a Next.js frontend.
The market uses integer prices and quantities, deterministic events, and complete candle aggregation.
Each connection has its own adaptive delivery policy.

The backend runs locally and serves REST and WebSocket data.
The trading screen is under development.

- [`backend/`](backend/) contains Go source and tests.
- [`web/`](web/) contains the frontend, its npm lockfile, and browser tests.
- [`docs/`](docs/README.md) describes the architecture and public protocol.
- [`protocol/fixtures/`](protocol/fixtures/README.md) holds JSON cases shared by both validators.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) explains repository boundaries and verification.

## Run locally

Use Go 1.27 and Node.js 22.13 or later within the supported Node.js 22–24 range.
Start the backend from the repository root:

```sh
go -C backend run ./cmd/server
```

The backend listens on `http://localhost:8080`.
Market history takes a few seconds to initialize.
`/healthz` reports process health. `/readyz` returns success after market initialization.
The REST API uses `/api/meta`, `/api/book`, `/api/candles`, and `/api/trades`.
The WebSocket address is `ws://localhost:8080/ws`.
Local browser origins are `http://localhost:3000` and `http://127.0.0.1:3000`.
See the [protocol](docs/protocol.md) for request fields, messages, and debug commands.

Start the frontend development server in a second terminal:

```sh
cd web
npm ci
npm run dev
```

Open `http://localhost:3000`.

## Verify changes

Run these checks from the repository root:

```sh
go -C backend test -race ./...
go -C backend vet ./...
npm --prefix web run test:coverage
npm --prefix web run typecheck
npm --prefix web run lint
```
