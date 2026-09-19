# SpacKt

A simulated BTC-USD market with a Go backend and a Next.js frontend.
The market uses integer prices and quantities, deterministic events, and complete candle aggregation.
Each connection has its own adaptive delivery policy.

The project is under development. Live server and trading-screen integration are not complete.

- [`backend/`](backend/) contains Go source and tests.
- [`web/`](web/) contains the frontend, its npm lockfile, and browser tests.
- [`docs/`](docs/README.md) describes the architecture and public protocol.
- [`protocol/fixtures/`](protocol/fixtures/README.md) holds JSON cases shared by both validators.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) explains repository boundaries and verification.

Frontend tooling runs from `web/`:

```sh
cd web
npm ci
npm run dev
```

Run the backend tests from the repository root:

```sh
go -C backend test -race ./...
```
