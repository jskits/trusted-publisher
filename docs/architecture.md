# Architecture

`trusted-publisher` turns a repository checkout and npm registry state into a set of
high-confidence `npm trust github` commands. This document describes the pipeline that gets it
there and the module that owns each stage.

## Pipeline

```
                          ┌──────────────────────────────────────────────┐
                          │ source.ts (optional --source)                 │
                          │ shallow-clone a public GitHub repo to a tmpdir │
                          └───────────────────────┬──────────────────────┘
                                                  │
                                                  ▼
  discovery.ts ── discoverWorkspace() ── combines three independent scanners:
        │
        ├── git.ts        → repository root, origin remote, GitHub owner/repo
        ├── packages.ts   → publishable package list (npm/pnpm/Yarn/Lerna/Nx/Turbo)
        └── workflows.ts  → GitHub Actions publish candidates + evidence + signals
                                                  │
                                                  ▼
  topology.ts ── resolvePublishTopology() ── map each package to its publishing workflow
                                                  │
                                                  ▼
  planning.ts ── buildTrustedPublisherPlans() ── per package: select workflow, infer
        permissions + environment, render `npm trust` args, score, assign confidence
                                                  │
                              (--scope replaces the package set first, via scope.ts)
                                                  │
                                                  ▼
  claim.ts ── checkPackageClaimPlans() / applyPackageClaimPlans() ── optional --claim:
        publish a placeholder package for names that do not yet exist on npm
                                                  │
                                                  ▼
  apply.ts ── checkTrustedPublisherPlans() ── compare each plan to live npm state:
        skip / create / replace / blocked  (drift computed by trust-diff.ts)
                                                  │
                                                  ▼
  apply.ts ── applyCheckedTrustedPublisherPlans() ── run npm trust serially, throttled
                                                  │
                                                  ▼
  index.ts ── render human output, JSON report, and/or migration-report.ts markdown
```

Everything above the apply step is read-only. Network calls to npm only happen from `npm.ts`,
and mutations only happen in the apply/claim steps once they are explicitly authorized.

## Modules

| Module                                                                         | Responsibility                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [`index.ts`](../packages/trusted-publisher/src/index.ts)                       | Commander CLI, orchestration, human/JSON output, prompts, exit codes, and the public library exports. |
| [`cli.ts`](../packages/trusted-publisher/src/cli.ts)                           | Thin `bin` entry that calls `runCli()`.                                                               |
| [`discovery.ts`](../packages/trusted-publisher/src/discovery.ts)               | Composes `git`, `packages`, and `workflows` into one `WorkspaceDiscovery`.                            |
| [`git.ts`](../packages/trusted-publisher/src/git.ts)                           | Finds the repo root, reads `remote.origin.url`, and parses a GitHub `owner/repo`.                     |
| [`packages.ts`](../packages/trusted-publisher/src/packages.ts)                 | Discovers packages from workspace globs and decides whether each is publishable.                      |
| [`workflows.ts`](../packages/trusted-publisher/src/workflows.ts)               | Parses `.github/workflows/*.yml` into publish candidates, evidence, and signals.                      |
| [`topology.ts`](../packages/trusted-publisher/src/topology.ts)                 | Maps packages to publish candidates and classifies the repo's publish topology.                       |
| [`planning.ts`](../packages/trusted-publisher/src/planning.ts)                 | Builds the per-package plan, renders the `npm trust` command, scores confidence.                      |
| [`npm.ts`](../packages/trusted-publisher/src/npm.ts)                           | The only module that shells out to `npm` (view, search, trust list/revoke, publish).                  |
| [`apply.ts`](../packages/trusted-publisher/src/apply.ts)                       | Checks plans against live trust state and applies create/replace serially.                            |
| [`claim.ts`](../packages/trusted-publisher/src/claim.ts)                       | Plans and applies placeholder publishes for unpublished package names.                                |
| [`scope.ts`](../packages/trusted-publisher/src/scope.ts)                       | Converts npm scope search results into registry-derived packages.                                     |
| [`source.ts`](../packages/trusted-publisher/src/source.ts)                     | Shallow-clones a public GitHub repo to a temp dir for `--source`.                                     |
| [`trust-diff.ts`](../packages/trusted-publisher/src/trust-diff.ts)             | Field-by-field diff between an existing trust record and a plan.                                      |
| [`migration-report.ts`](../packages/trusted-publisher/src/migration-report.ts) | Renders the Markdown migration report.                                                                |
| [`prerequisites.ts`](../packages/trusted-publisher/src/prerequisites.ts)       | Validates Node.js and npm CLI versions before any mutation.                                           |
| [`json.ts`](../packages/trusted-publisher/src/json.ts)                         | Small `unknown` → object/string-array helpers used by the parsers.                                    |

## Dependency injection and testing

`runCli()` accepts a `RunCliOptions` object that lets tests replace I/O and external services
without touching the network or filesystem:

- `io` — `stdin`, `stdout`, and `stderr` streams (the prompt path checks `stdin.isTTY`).
- `env` — environment lookup, used to honor `npm_config_yes` (set by `npx -y`).
- `services` — `createNpmClient`, `discoverWorkspace`, and `discoverSourceWorkspace`.

The `NpmClient` interface in [`npm.ts`](../packages/trusted-publisher/src/npm.ts) is the seam for
all registry interaction, so the planning, checking, claiming, and applying logic is tested against
an in-memory fake (`src/index.test.ts`) that records the exact npm calls the CLI would make.

## Side-effect boundaries

- **Reads:** repository files, `.npmrc`, `git config`, and npm registry reads (`npm view`,
  `npm search`, `npm trust list`).
- **Writes (only when authorized):** `npm trust github` (create), `npm trust revoke` (replace),
  and `npm publish` of a placeholder (claim).
- **Temporary files:** `--source` clones into an OS temp dir and removes it on exit; `--claim`
  writes a placeholder package into a temp dir and removes it after publishing.

The tool never installs dependencies, runs builds, or executes a repository's release scripts.
