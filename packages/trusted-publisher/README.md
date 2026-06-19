# trusted-publisher

Bulk configure npm trusted publishing for GitHub monorepos.

```sh
npx -y trusted-publisher
```

`trusted-publisher` scans a GitHub repository, finds publishable npm workspace packages, detects
the GitHub Actions workflow that publishes them, checks npm trusted publisher state, and applies
only high-confidence changes.

## Usage

```sh
# scan, check npm state, and ask before applying
trusted-publisher

# npx -y sets npm_config_yes=true, so high-confidence changes are applied
npx -y trusted-publisher

# print planned npm trust commands without npm registry checks or changes
trusted-publisher --dry-run

# force repository or workflow detection
trusted-publisher --repo owner/repo --workflow release.yml

# replace an existing trusted publisher that points somewhere else
trusted-publisher --replace --yes
```

## Safety model

- `--yes` and `npx -y` apply only high-confidence plans.
- Medium- and low-confidence plans are skipped with reasons.
- Existing matching trusted publishers are skipped.
- Existing differing trusted publishers are blocked unless `--replace` is set.
- Mutations are serial and wait 2 seconds by default between npm trust changes.
- Private packages, restricted packages, missing package names, and non-npm registries are skipped.

## Options

| Option                | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `--dry-run`           | Print planned `npm trust github` commands without npm checks or changes. |
| `--yes`               | Apply high-confidence changes without prompting.                         |
| `--replace`           | Revoke differing trusted publisher records before recreating them.       |
| `--repo <owner/repo>` | Override the detected GitHub repository.                                 |
| `--workflow <file>`   | Override the detected workflow filename, such as `release.yml`.          |
| `--publish-only`      | Configure `--allow-publish` only.                                        |
| `--stage-only`        | Configure `--allow-stage-publish` only.                                  |
| `--both`              | Configure both publish and stage publish permissions.                    |
| `--registry <url>`    | Use a custom npm registry for package and trust checks.                  |
| `--delay-ms <number>` | Override the delay between npm trust mutations.                          |

## Requirements

- Node.js `>=22.14.0`
- npm CLI with `npm trust`
- Existing packages on npm; npm trusted publishing cannot be configured for packages that have
  never been published.
- GitHub Actions workflows under `.github/workflows/`.

The generated command shape follows npm's trusted publishing CLI:

```sh
npm trust github "@scope/pkg" \
  --repo "owner/repo" \
  --file "release.yml" \
  --allow-publish \
  --yes
```
