# trusted-publisher

Plan, audit, and safely apply npm trusted publisher configuration for GitHub packages and
monorepos.

## CLI

```sh
npx -y trusted-publisher
npx -y trusted-publisher --source https://github.com/owner/repo
```

The CLI discovers publishable npm packages, analyzes GitHub Actions release workflows, checks
existing npm trusted publisher state, explains drift, and applies only high-confidence changes.

See [`packages/trusted-publisher/README.md`](packages/trusted-publisher/README.md) for complete CLI
usage and safety details.

## Feature Summary

- Local repo and monorepo scanning for npm, Yarn, pnpm, Lerna, Nx, and Turbo layouts.
- Workflow analysis for npm, pnpm, Yarn, Changesets, semantic-release, Lerna, Nx, matrix jobs, and
  reusable workflows.
- Confidence scoring with human-readable explain output.
- Trusted publisher drift diffing before replacement.
- JSON and CI audit modes with migration reports.
- Explicit package claiming for unpublished package names.
- npm scope bulk configuration.
- Public GitHub source scanning via `--source`.

## Common Commands

```sh
# local repository, high-confidence auto-apply
npx -y trusted-publisher

# remote public GitHub repository
npx -y trusted-publisher --source https://github.com/owner/repo

# CI audit without mutation
npx trusted-publisher --audit --json

# migration report
npx trusted-publisher --dry-run --report trusted-publisher-report.md
```

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

## Release

The npm package is published from `.github/workflows/release.yml` when a matching tag is pushed:

- `v<version>`
- `trusted-publisher@<version>`

The release workflow uses npm trusted publishing with GitHub OIDC:

- GitHub Actions permissions include `id-token: write`.
- `actions/setup-node` is configured for `registry-url: https://registry.npmjs.org`.
- The publish step runs `npm publish --access public --provenance`.
- `packages/trusted-publisher/package.json` also sets `publishConfig.provenance: true`.

Before tagging, make sure npm has a trusted publisher entry for this repository and
`.github/workflows/release.yml`.
