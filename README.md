# trusted-publisher

Bulk configure npm trusted publishing for GitHub monorepos.

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
