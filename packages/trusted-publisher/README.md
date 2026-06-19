# trusted-publisher

Bulk configure npm trusted publishing for GitHub monorepos.

```sh
npx -y trusted-publisher
```

`trusted-publisher` scans a GitHub repository, finds publishable npm packages, detects the GitHub
Actions workflow that publishes them, checks npm trusted publisher state, and applies only
high-confidence changes.

It is designed for ordinary packages and monorepos where npm's native `npm trust` command is the
source of truth, but workspace discovery and workflow selection should be automated.

## Usage

```sh
# scan, check npm state, and ask before applying
trusted-publisher

# npx -y sets npm_config_yes=true, so high-confidence changes are applied
npx -y trusted-publisher

# print planned npm trust commands without npm registry checks or changes
trusted-publisher --dry-run
```

## What It Detects

Package discovery supports:

- Single-package repositories with a root `package.json`.
- npm and Yarn workspaces from `package.json#workspaces`.
- pnpm workspaces from `pnpm-workspace.yaml`.
- Lerna packages from `lerna.json#packages`.
- Nx and Turbo conventional layouts under `apps/*`, `libs/*`, and `packages/*`.

Publishing workflow analysis supports:

- Direct `npm publish` and `npm stage publish`.
- pnpm publish commands, including recursive and filtered publishes.
- Yarn npm publish commands and workspace foreach publishes.
- Changesets, semantic-release, Lerna publish, and Nx release publish.
- Matrix jobs that publish one package per matrix value.
- Reusable workflows, reported conservatively for manual review when the publish target is unclear.

For each package, the planner selects the best publish workflow candidate, assigns a confidence
score, and explains the evidence used for the decision.

## Local Repository Flow

Run the command from the repository you want to migrate:

```sh
cd /path/to/repo
npx -y trusted-publisher
```

The local flow reads only repository files and npm registry state. It does not install dependencies,
run builds, or execute release scripts. The apply phase calls npm's official command shape:

```sh
npm trust github "@scope/pkg" \
  --repo "owner/repo" \
  --file "release.yml" \
  --allow-publish \
  --yes
```

If the GitHub remote cannot be inferred correctly, override only the repository value passed to
`npm trust`:

```sh
trusted-publisher --repo owner/repo
```

`--repo` does not clone or scan a remote repository; it only overrides the trusted publisher repo
field.

## Additional Modes

```sh

# scan a public GitHub repository without cloning it yourself
trusted-publisher --source https://github.com/owner/repo --dry-run

# force repository or workflow detection
trusted-publisher --repo owner/repo --workflow release.yml

# replace an existing trusted publisher that points somewhere else
trusted-publisher --replace --yes

# claim unpublished package names with placeholder packages, then configure trust
trusted-publisher --claim --yes

# configure all public packages currently visible under a scope
trusted-publisher --scope @scope --repo owner/repo --workflow release.yml --yes
```

## Remote Source Mode

Use `--source` when the repository is not already checked out locally:

```sh
npx -y trusted-publisher --source https://github.com/owner/repo
```

The source value may be a GitHub URL, `github:owner/repo`, or `owner/repo`. The CLI performs a
shallow clone with blob filtering into a temporary directory, runs the same package and workflow
analysis used for local repositories, then removes the temporary clone before exiting.

When `--source` is used without `--repo`, the trusted publisher repository defaults to the
`owner/repo` parsed from the source. Use `--repo` only when npm should trust a different GitHub
repository than the source repository being scanned.

Public repositories work without credentials. Private repositories depend on the local `git`
configuration and credentials available to the process.

## Scope Bulk Mode

Use `--scope` when the packages to configure are already published under an npm scope but are not
necessarily present in the current workspace:

```sh
trusted-publisher --scope @scope --repo owner/repo --workflow release.yml --yes
```

Scope mode asks npm for public packages matching the scope, converts them into registry-derived
package entries, and then runs the same plan, check, diff, and apply pipeline. Because these
packages may not exist in the local checkout, explicitly passing `--repo` and `--workflow` is the
most predictable form.

For large scopes, tune the search limit:

```sh
trusted-publisher --scope @scope --scope-limit 500 --repo owner/repo --workflow release.yml
```

## Safety model

- `--yes` and `npx -y` apply only high-confidence plans.
- Medium- and low-confidence plans are skipped with reasons.
- Existing matching trusted publishers are skipped.
- Existing differing trusted publishers are blocked unless `--replace` is set.
- Existing trusted publisher drift is reported field-by-field before replacement.
- Mutations are serial and wait 2 seconds by default between npm trust changes.
- `--source` clones a public GitHub repository into a temporary directory for scanning, then
  removes it before the process exits.
- `--claim` is explicit: it publishes a minimal placeholder package from a temporary directory for
  missing package names before running `npm trust`.
- `--scope` is registry-driven: it loads public packages from npm search and treats them as
  registry packages instead of local workspace packages.
- Per-package npm failures are reported as `failed` in the final summary.
- Private packages, restricted packages, missing package names, and non-npm registries are skipped.
- Re-running is safe: already-matching packages are treated as no-ops.

## Options

| Option                | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `--dry-run`           | Print planned `npm trust github` commands without npm checks or changes. |
| `--source <url>`      | Scan a public GitHub repository instead of the current directory.        |
| `--json`              | Write a machine-readable JSON report.                                    |
| `--audit`             | Check npm trusted publisher state without applying changes.              |
| `--report <path>`     | Write a markdown migration report to a path, or `-` for stdout.          |
| `--claim`             | Publish placeholder packages for missing npm package names.              |
| `--scope <scope>`     | Configure public packages in an npm scope, such as `@acme`.              |
| `--scope-limit <n>`   | Maximum packages to load from npm scope search.                          |
| `--yes`               | Apply high-confidence changes without prompting.                         |
| `--replace`           | Revoke differing trusted publisher records before recreating them.       |
| `--repo <owner/repo>` | Override the GitHub repository passed to `npm trust`.                    |
| `--workflow <file>`   | Override the detected workflow filename, such as `release.yml`.          |
| `--publish-only`      | Configure `--allow-publish` only.                                        |
| `--stage-only`        | Configure `--allow-stage-publish` only.                                  |
| `--both`              | Configure both publish and stage publish permissions.                    |
| `--registry <url>`    | Use a custom npm registry for package and trust checks.                  |
| `--delay-ms <number>` | Override the delay between npm trust mutations.                          |

## Requirements

- Node.js `>=22.14.0`
- npm CLI `>=11.15.0` with `npm trust`
- Existing packages on npm by default. Use `--claim` to publish minimal placeholder packages for
  missing names before configuring trusted publishing.
- GitHub Actions workflows under `.github/workflows/`.

The generated command shape follows npm's trusted publishing CLI:

```sh
npm trust github "@scope/pkg" \
  --repo "owner/repo" \
  --file "release.yml" \
  --allow-publish \
  --yes
```
