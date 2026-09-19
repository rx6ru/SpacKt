# Contributing

Keep changes focused on the software, its tests, and its operating instructions.

## Repository layout

| Location | Content |
|---|---|
| `backend/` | Go application, tests, tools, module files, and backend container configuration |
| `web/` | Next.js application, frontend dependencies, browser tests, and frontend tooling |
| `protocol/fixtures/` | Shared JSON protocol examples |
| `docs/` | Software architecture, public contracts, usage, deployment, and troubleshooting |
| `.github/workflows/` | Continuous integration |
| `.githooks/pre-commit` | Local repository-content checks |

Allowed root files are `README.md`, `CONTRIBUTING.md`, `LICENSE`, `NOTICE`, `.gitignore`, `.dockerignore`, `compose.yaml`, `render.yaml`, and `Makefile`.
New root locations require an explicit policy change and review.

Install frontend packages inside `web/` with npm.
Keep `web/package-lock.json` under version control.
Do not create a root JavaScript workspace or install dependencies at the root.
Use Go modules for the backend.

Do not commit dependencies, build output, caches, coverage output, browser reports, runtime logs, or actual environment files.
Use `.env.example` inside the relevant application directory for public defaults and placeholders.
Do not commit symlinks or local development-tool instructions.

## Documentation

Shipping documentation explains how the software works, how to use it, or how to maintain it.
Keep product planning, task lists, acceptance tracking, execution reports, conversations, and review deliberation outside this repository.
Do not link shipping documentation to private workspace files or absolute workstation paths.

The content gate checks known path and document patterns.
Reviewers must also check meaning: a renamed planning document is still planning material.
Ordinary technical discussion and illustrative code examples are allowed.

## Checks

Install the local hook once per checkout:

```sh
git config core.hooksPath .githooks
```

Check the working repository and the staged tree:

```sh
go -C backend run ./cmd/checkrepo -root .. -mode local
go -C backend run ./cmd/checkrepo -root .. -mode index
```

The hook runs both checks before a commit.
CI checks the committed tree with `-mode head`.
Index mode reads Git's staged content. Unstaged cleanup cannot hide a staged violation.
Local mode also detects forbidden root artifacts that Git ignores.

Run the checks relevant to the change:

```sh
go -C backend test -race ./...
go -C backend vet ./...
npm --prefix web run test:coverage
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web run build
npm --prefix web run test:e2e
```

Write tests from the software contract before changing behaviour.
Review test expectations separately from implementation.
A failing test must demonstrate missing behaviour, rather than a broken runner.
Review the staged diff, verify the repository gate, then commit a coherent change with a short reason.

## Commit messages

Use an imperative Conventional Commit subject of at most 50 characters.
Do not end the subject with a period.
Separate an optional body with a blank line and wrap it at 72 characters.
Explain the reason for the change and its result.
Use concise decision or verification trailers when they add useful context.

```text
chore(repo): Enforce repository boundaries

Keep frontend tooling inside web and reject private planning files.

Tested: Repository policy checks and application tests
```
