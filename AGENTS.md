# Agent guide

SpacKt is a simulated BTC-USD market viewer.
Read README.md, docs/architecture.md, docs/protocol.md, and docs/schemas.md before changing behavior.

## Repository layout

- Keep Go source, tests, and tools in backend/.
- Keep Next.js source, frontend dependencies, and browser tests in web/.
- Keep shared wire examples in protocol/fixtures/.
- Keep shipping software documentation in docs/.
- Keep plans, conversations, local tool state, generated files, and secrets outside version control.
- Use npm inside web/. Do not add root Node tooling.

## Design rules

- Keep market generation, delivery, networking, state, and rendering separate.
- Preserve exact integer prices and quantities. Use the documented decimal strings on the wire.
- Keep UTC timestamps and identifiers unchanged when formatting local display times.
- Process the complete trade stream at every delivery tier.
- Preserve per-connection tier decisions and snapshot/delta recovery.
- Keep seeded generation reproducible and resource use bounded.
- Reuse existing modules and patterns. Avoid unrelated changes and unnecessary dependencies.

## Validation

Inspect the working tree first. Preserve changes made by others.
Write contract-based tests before changing behavior. Review test expectations separately from implementation.
Run the checks relevant to the change from the repository root:

```sh
go -C backend test -race -timeout 300s ./...
go -C backend vet ./...
go -C backend run ./cmd/checkrepo -root .. -mode local
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web run test:coverage
npm --prefix web run test:security
npm --prefix web run build
```

For integration changes, start the containers and run the browser tests described in docs/deployment.md.
Review the staged diff and run the repository gate before committing.
Report what was verified and any remaining gaps. Do not claim an unrun check passed.

## Documentation and publication

Use short, clear sentences. Explain the reason for non-obvious choices.
Update affected software documentation when contracts or behavior change.
Use short, imperative Conventional Commit subjects.
Publish only a complete, reviewed, verified change within the user's authorized scope.
