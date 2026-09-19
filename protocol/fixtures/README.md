# Shared wire fixtures

These JSON files test the HTTP and WebSocket contract.
The Go backend and TypeScript frontend read the same files.
This checks that both validators accept valid messages and reject invalid messages consistently.

`cases.json` lists each file, its message category, and its expected result.
Examples cover metadata, snapshots, candles, trades, controls, errors, and numeric limits.
Some files deliberately contain duplicate JSON keys or invalid values.
Do not parse and reserialize duplicate-key examples. That would remove the case being tested.

This directory is shared because the fixtures belong to both applications.
Runtime market data does not come from these files.

Run the contract tests from the repository root:

```sh
go -C backend test ./internal/transport/wire
npm --prefix web run test:run -- src/net/wire
```
