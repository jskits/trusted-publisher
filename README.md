# trusted-publisher

Bulk configure npm trusted publishing for GitHub monorepos.

## CLI

```sh
npx -y trusted-publisher
```

The CLI discovers workspace packages and GitHub Actions publishing workflows, checks npm trusted
publisher state, and applies only high-confidence changes. See
[`packages/trusted-publisher/README.md`](packages/trusted-publisher/README.md) for full usage and
safety details.

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
