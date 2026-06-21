# Detection Reference

This document describes exactly what `trusted-publisher` looks for when it scans a repository:
which packages it considers publishable, and how it recognizes the GitHub Actions workflow that
publishes them.

## Repository resolution

[`git.ts`](../packages/trusted-publisher/src/git.ts) resolves the GitHub repository in this order:

1. Walk up from the working directory until a directory containing `.git` is found; that is the
   repository root. If none is found, the starting directory is used.
2. Read `remote.origin.url` with `git config --get`. If `git` is not available, fall back to
   parsing `.git/config` directly.
3. Parse the remote into `owner/repo`. Supported remote forms:
   - `https://github.com/owner/repo(.git)`
   - `git@github.com:owner/repo(.git)`
   - `github:owner/repo` shorthand
   - a leading `git+` prefix is stripped first

Non-`github.com` hosts return no repository, which surfaces as the
`GitHub repository not detected` plan reason. Override detection with `--repo owner/repo`.

## Package discovery

[`packages.ts`](../packages/trusted-publisher/src/packages.ts) first builds the set of **workspace
patterns**, then finds every directory containing a `package.json`, then keeps the ones that match a
pattern.

Workspace patterns are collected from (the root `.` is always included):

| Source                            | Field                                        |
| --------------------------------- | -------------------------------------------- |
| `package.json`                    | `workspaces` array, or `workspaces.packages` |
| `pnpm-workspace.yaml`             | `packages`                                   |
| `lerna.json`                      | `packages`                                   |
| `nx.json` or `turbo.json` present | adds `apps/*`, `libs/*`, `packages/*`        |

Globs support `*` (single path segment) and `**` (any depth), plus `!`-prefixed negations. A
trailing `/package.json` in a pattern is normalized away. The walker ignores `.git`, `.turbo`,
`coverage`, `dist`, and `node_modules`.

### Publishable vs. skipped

For each discovered package the scanner records `skipReasons`. A package is **publishable** only
when that list is empty. Skip reasons:

| Reason                            | Trigger                                                |
| --------------------------------- | ------------------------------------------------------ |
| `missing package name`            | `package.json` has no `name`                           |
| `private package`                 | `package.json` has `"private": true`                   |
| `non-npm registry: <url>`         | the resolved registry host is not `registry.npmjs.org` |
| `restricted publishConfig access` | `publishConfig.access` is `"restricted"`               |

The registry for a package is resolved from `publishConfig.registry`, then a scoped registry in
`.npmrc` (`@scope:registry=...`), then the default `.npmrc` `registry=...`. Packages targeting a
private/alternate registry are skipped because npm trusted publishing applies to the public npm
registry.

## Workflow analysis

[`workflows.ts`](../packages/trusted-publisher/src/workflows.ts) parses every
`.github/workflows/*.yml` (and `.yaml`) file. For each job and step it produces **publish
candidates**, each tagged with a `tool`, a `kind`, a `packageSelector`, whether the job has
`id-token: write`, the resolved `environment`, and the `working-directory`.

### Recognized publish commands and actions

| Detected                                            | Tool                            | Kind               | Selector inference                                                               |
| --------------------------------------------------- | ------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `npm publish`                                       | `npm`                           | `direct`           | `--workspaces`/`-ws` → all; `--workspace`/`-w <x>` → name/path; else working dir |
| `npm stage publish`                                 | `npm`                           | `direct`           | same as `npm publish`; sets stage-publish permission                             |
| `pnpm ... publish`                                  | `pnpm`                          | `direct`           | `-r`/`--recursive` → all; `--filter`/`-F <x>` → filter; else working dir         |
| `yarn npm publish` / `yarn workspaces foreach`      | `yarn`                          | `direct`           | `workspaces foreach` → all; else working dir                                     |
| `semantic-release` (or `npx semantic-release`)      | `semantic-release`              | `semantic-release` | unknown                                                                          |
| `lerna publish`                                     | `lerna`                         | `lerna`            | all                                                                              |
| `nx release [publish]`                              | `nx`                            | `nx`               | all                                                                              |
| `changesets/action` with `with.publish:`            | inferred from the publish input | inferred           | inferred from the publish input; unknown inputs fall back to all                 |
| `with.publish:` input on an action                  | inferred from the input command |                    |                                                                                  |
| local `node`/`bun`/`tsx` scripts containing publish | inferred from script contents   | direct             | inferred from script contents; often unknown                                     |
| local `./.github/workflows/x.yml` reusable workflow | `reusable-workflow`             | `reusable`         | unknown (flagged for review)                                                     |
| external `owner/repo/.github/workflows/x.yml@ref`   | `reusable-workflow`             | `reusable`         | unknown (flagged for review)                                                     |

A `changesets/action` step that only versions packages is not treated as publishing. A
`yarn ... npm publish` is intentionally not double-counted as a bare `npm publish`.

### Package selectors

Each candidate carries a `packageSelector` that decides which packages it publishes:

- `all` — publishes every package (recursive/workspace-wide release).
- `name` — a specific package name.
- `path` — a specific workspace directory.
- `filter` — a pnpm-style filter (may include `*`).
- `unknown` — the target could not be determined (e.g. reusable workflows, semantic-release).

### Matrix expansion

When a job declares a `strategy.matrix` whose key is one of the package-ish keys (`dir`,
`directory`, `package`, `packageName`, `package_name`, `packages`, `path`, `pkg`, `workspace`,
`workspacePath`, `workspace_path`), and a step's `working-directory` references that matrix value
(`${{ matrix.<key> }}`), the step is expanded once per matrix value so each published package maps
to a distinct candidate.

### Permissions and environment

- `id-token: write` is detected at both workflow and job level. A candidate inherits the job-level
  permission, falling back to the workflow level; the source (`job` / `workflow` / `missing`) is
  recorded.
- The deployment `environment` (string or `{ name }`) is captured per job and propagated into the
  rendered `--env` argument when exactly one environment is present.

### Evidence and signals

Every candidate emits `Evidence` entries — a `code`, a `level`
(`positive`/`negative`/`warning`/`info`), a human message, a `scoreDelta`, and a `source`
locator (file, job, step, command, or `uses`). Evidence is a transparent log of _why_ a workflow
looked like a publisher; it is surfaced in `--json` output and the migration report.

Each workflow also exposes boolean `signals` (`npmPublish`, `npmStagePublish`,
`packageManagerPublish`, `changesetsAction`, `semanticRelease`, `lernaPublish`, `nxReleasePublish`,
`reusableWorkflow`, `hasIdTokenWrite`, and the list of `environments`) used by workflow selection
and the fallback scorer.

See [confidence-and-topology.md](confidence-and-topology.md) for how these detections turn into a
selected workflow and a confidence score.
