# Contributing

Thanks for contributing to `trusted-publisher`. This repository is a pnpm + Turborepo monorepo with
a single published package, [`packages/trusted-publisher`](packages/trusted-publisher).

## Prerequisites

- Node.js `>=22.14.0` (see `engines`).
- pnpm `11.8.0`, pinned via `packageManager`. Enable it with Corepack:

```sh
corepack enable
pnpm install
```

`.npmrc` sets `engine-strict` and `package-manager-strict`, so a mismatched Node or package manager
will fail fast.

## Project layout

```
.
├── packages/trusted-publisher/   # the published CLI + library
│   └── src/                      # one module per pipeline stage (+ *.test.ts)
├── docs/                         # architecture, detection, scoring, JSON, API docs
├── .github/workflows/            # ci.yml (checks) and release.yml (trusted publish)
├── turbo.json                    # task graph
├── pnpm-workspace.yaml           # workspace globs + dependency catalog
└── tsconfig.base.json            # shared strict TypeScript config
```

Dependencies are pinned through the pnpm **catalog** in `pnpm-workspace.yaml`; reference them as
`"catalog:"` in `package.json` rather than hard-coding versions.

## Common scripts

Run from the repository root (Turborepo fans them out across packages):

| Script                              | Purpose                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `pnpm build`                        | Build all packages with tsdown (ESM + `.d.ts`).                           |
| `pnpm test`                         | Run the Vitest suite (depends on `build`).                                |
| `pnpm test:watch`                   | Watch-mode tests.                                                         |
| `pnpm typecheck`                    | `tsc --noEmit` against the strict base config.                            |
| `pnpm lint`                         | Oxlint.                                                                   |
| `pnpm format` / `pnpm format:check` | Oxfmt write / check.                                                      |
| `pnpm check`                        | The full gate: build, typecheck, test, `publint`, lint, and format check. |
| `pnpm clean`                        | Remove build output and `node_modules`.                                   |

Run `pnpm check` before opening a pull request — it is exactly what CI runs in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Coding conventions

- TypeScript, strict mode, ESM (`NodeNext`), with `isolatedDeclarations` and
  `exactOptionalPropertyTypes` enabled — keep public types explicitly annotated.
- Formatting is enforced by Oxfmt (100-column width, double quotes, trailing commas, sorted
  imports). Linting is enforced by Oxlint.
- Keep new logic behind the existing seams: the only module that shells out to `npm` is
  [`npm.ts`](packages/trusted-publisher/src/npm.ts), so new registry behavior belongs there and
  should be testable via the `NpmClient` interface.
- Every source module has a colocated `*.test.ts`; add or extend tests with your change. The CLI is
  tested end-to-end with in-memory I/O and a fake npm client in
  [`src/index.test.ts`](packages/trusted-publisher/src/index.test.ts).

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitlint via a `commit-msg` git hook. You can author a compliant message interactively:

```sh
pnpm commit   # Commitizen / cz-git prompt
```

A `pre-commit` hook runs `lint-staged` (Oxfmt + Oxlint on staged files). Hooks are installed by
`simple-git-hooks` during `pnpm install`.

## Changesets and releases

Version bumps and changelogs are managed with [Changesets](https://github.com/changesets/changesets).

1. Add a changeset describing your change:

   ```sh
   pnpm changeset
   ```

2. When releasing, apply pending changesets to bump versions:

   ```sh
   pnpm changeset:version
   ```

3. Push a release tag. The [`release.yml`](.github/workflows/release.yml) workflow publishes to npm
   when a tag matching `v<version>` or `trusted-publisher@<version>` is pushed. It:
   - verifies the tag matches the package version,
   - skips publishing if that version already exists on npm,
   - runs `pnpm check`,
   - publishes with `npm publish --access public --provenance` using GitHub OIDC trusted publishing
     (`id-token: write`).

The npm trusted publisher entry for this repository must already exist (it points at
`.github/workflows/release.yml`). `trusted-publisher` can configure that entry for its own repo.
