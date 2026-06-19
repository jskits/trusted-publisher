# trusted-publisher

Plan, audit, and safely apply [npm trusted publisher](https://docs.npmjs.com/trusted-publishers)
configuration for GitHub packages and monorepos.

npm's native `npm trust` command is the source of truth for configuring OIDC trusted publishing, but
it is not workspace-aware: you have to know each package name, the GitHub repository, and the exact
workflow file, and run the command once per package with manual throttling. `trusted-publisher`
automates that discovery and bookkeeping for one package or hundreds — without ever guessing.

## Quick start

```sh
# scan the current repository, check npm state, and apply only high-confidence changes
npx -y trusted-publisher

# scan a public GitHub repository you have not checked out
npx -y trusted-publisher --source https://github.com/owner/repo

# CI-friendly audit with no mutations
npx trusted-publisher --audit --json
```

The CLI discovers publishable npm packages, analyzes GitHub Actions release workflows, checks
existing npm trusted publisher state, explains drift, and applies only high-confidence changes.

See [`packages/trusted-publisher/README.md`](packages/trusted-publisher/README.md) for the complete
CLI reference and safety details.

## How it works

`trusted-publisher` runs a read-only analysis pipeline and only mutates npm once changes are
authorized:

1. **Discover** — resolve the GitHub `owner/repo` from git, find publishable packages across
   npm/pnpm/Yarn/Lerna/Nx/Turbo layouts, and parse `.github/workflows/*.yml` into publish
   candidates with evidence.
2. **Map** — build the publish topology that links each package to the workflow that releases it
   (global, per-package, hybrid, or conflicting).
3. **Plan & score** — select the right workflow per package, infer publish/stage permissions and
   environment, render the exact `npm trust github` command, and assign a confidence tier.
4. **Check** — compare each plan against live npm state: already configured, needs creating, drifts
   from an existing record, or is blocked.
5. **Apply** — run `npm trust` serially and throttled, only for high-confidence plans, only when
   authorized.

The full pipeline is documented in [docs/architecture.md](docs/architecture.md).

## Feature summary

- Local repo and monorepo scanning for npm, Yarn, pnpm, Lerna, Nx, and Turbo layouts.
- Workflow analysis for npm, pnpm, Yarn, Changesets, semantic-release, Lerna, Nx, matrix jobs, and
  reusable workflows.
- Confidence scoring with a human-readable `explain` and `reasons` trail.
- Trusted publisher drift diffing, field by field, before any replacement.
- JSON and CI audit modes with Markdown migration reports.
- Explicit package claiming for unpublished package names.
- npm scope bulk configuration (`--scope @acme`).
- Public GitHub source scanning via `--source`, without cloning it yourself.
- A typed library API in addition to the CLI.

## Common commands

```sh
# local repository, high-confidence auto-apply
npx -y trusted-publisher

# remote public GitHub repository
npx -y trusted-publisher --source https://github.com/owner/repo

# CI audit without mutation (exit code reflects drift)
npx trusted-publisher --audit --json

# migration report for humans
npx trusted-publisher --dry-run --report trusted-publisher-report.md
```

## Documentation

| Document                                                           | What it covers                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------- |
| [Package README](packages/trusted-publisher/README.md)             | Full CLI usage, options, modes, and safety model.    |
| [docs/architecture.md](docs/architecture.md)                       | Pipeline and module overview.                        |
| [docs/detection.md](docs/detection.md)                             | Package discovery and workflow analysis details.     |
| [docs/confidence-and-topology.md](docs/confidence-and-topology.md) | Topology, workflow selection, and the scoring model. |
| [docs/json-report.md](docs/json-report.md)                         | `--json` schema and audit exit codes.                |
| [docs/api.md](docs/api.md)                                         | Programmatic API reference.                          |
| [docs/positioning.md](docs/positioning.md)                         | Why this tool exists alongside `npm trust`.          |

## Requirements

- Node.js `>=22.14.0`
- npm CLI `>=11.15.0` (the version that ships `npm trust`)
- GitHub Actions workflows under `.github/workflows/`
- Packages that already exist on npm — or use `--claim` to publish placeholder names first

## Development

This repository uses pnpm workspaces, Turborepo, TypeScript, Oxlint, Oxfmt, Vitest,
tsdown/Rolldown, Changesets, and Commitizen.

```sh
corepack enable
pnpm install
pnpm check
```

Useful scripts:

- `pnpm build` builds all packages.
- `pnpm test` runs Vitest.
- `pnpm lint` runs Oxlint.
- `pnpm format` runs Oxfmt.
- `pnpm changeset` creates a release changeset.
- `pnpm commit` starts the Commitizen prompt.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development and release workflow.

## Release

The npm package is published from [`.github/workflows/release.yml`](.github/workflows/release.yml)
when a matching tag is pushed:

- `v<version>`
- `trusted-publisher@<version>`

The release workflow uses npm trusted publishing with GitHub OIDC:

- GitHub Actions permissions include `id-token: write`.
- `actions/setup-node` is configured for `registry-url: https://registry.npmjs.org`.
- The publish step runs `npm publish --access public --provenance`.
- `packages/trusted-publisher/package.json` also sets `publishConfig.provenance: true`.

Before tagging, make sure npm has a trusted publisher entry for this repository and
`.github/workflows/release.yml`. `trusted-publisher` can configure that entry for its own repo.

## License

[MIT](LICENSE)
