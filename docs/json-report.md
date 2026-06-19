# JSON Report Reference

`--json` writes a single machine-readable JSON object to stdout. It is available in dry-run, audit,
plan, and apply runs. Because both `--json` and `--report -` write to stdout, they cannot be
combined.

```sh
trusted-publisher --dry-run --json
trusted-publisher --audit --json
trusted-publisher --json --yes        # full apply, machine-readable result
```

## Top-level shape

```jsonc
{
  "schemaVersion": 1,
  "mode": "dry-run" | "audit" | "plan" | "apply",
  "discovery":   { /* WorkspaceDiscovery: repository, packages, workflows */ },
  "plans":       [ /* TrustedPublisherPlan[] */ ],
  "checkedPlans":[ /* CheckedPlan[]  — empty in dry-run */ ],
  "claimPlans":  [ /* PackageClaimPlan[] — only with --claim */ ],
  "claimResults":[ /* PackageClaimResult[] — only when claims were applied */ ],
  "results":     [ /* ApplyResult[] — only after an apply */ ],
  "summary":     { /* flat map of numeric counters */ }
}
```

`schemaVersion` is currently `1`. Treat new keys as additive.

### `mode`

| Mode      | When                                                                              |
| --------- | --------------------------------------------------------------------------------- |
| `dry-run` | `--dry-run`; no npm registry calls were made                                      |
| `audit`   | `--audit`; npm state was checked but nothing was applied (also sets an exit code) |
| `plan`    | high-confidence changes exist but were **not** authorized (no explicit `--yes`)   |
| `apply`   | an apply was attempted (or there was nothing to apply)                            |

## `discovery`

The `WorkspaceDiscovery` object:

- `repository` — `{ rootDir, remoteUrl?, githubRepository? }`.
- `packages` — `PackageInfo[]`: `{ directory, name?, version?, private, publishable, registry?,
relativePath, skipReasons[] }`. In `--scope` mode, `relativePath` is `npm:<name>`.
- `workflows` — `WorkflowInfo[]`: `{ fileName, path, relativePath, candidates[], evidence[],
signals }`. See [detection.md](detection.md) for candidate/evidence/signal shapes.

## `plans`

Each `TrustedPublisherPlan`:

| Field              | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `package`          | the `PackageInfo` this plan is for                                        |
| `confidence`       | `high` / `medium` / `low`                                                 |
| `score`            | normalized `0–100`                                                        |
| `permissions`      | `{ allowPublish, allowStagePublish }`                                     |
| `repository`       | resolved `owner/repo` (omitted if not detected)                           |
| `workflowFile`     | selected workflow filename (omitted if none)                              |
| `workflow`         | the full selected `WorkflowInfo` (omitted if none)                        |
| `publishCandidate` | the selected candidate (omitted if none)                                  |
| `environment`      | inferred deployment environment (omitted if none)                         |
| `trustArgs`        | argv array for the `npm trust` call (omitted when nothing can be applied) |
| `command`          | the rendered, display-quoted command string (omitted with `trustArgs`)    |
| `topologyStatus`   | `matched` / `unmatched` / `ambiguous` (omitted if not mapped)             |
| `explain`          | scoring narrative lines                                                   |
| `reasons`          | blockers/caveats                                                          |
| `evidence`         | the candidate's or workflow's `Evidence[]`                                |

## `checkedPlans`

Each `CheckedPlan` records the comparison against live npm state:

- `action` — `create` / `replace` / `skip` / `blocked`.
- `packageExists` — whether the package exists on npm.
- `existingTrusts` — `ExistingTrust[]` returned by `npm trust list`.
- `matchingTrust` — present when an existing record already matches the plan (→ `skip`).
- `trustDiffs` — field-by-field drift for non-matching records (see below).
- `reasons` — why this action was chosen.

## `claimPlans` / `claimResults`

With `--claim`, `claimPlans` lists one `PackageClaimPlan` per unique package:
`{ action: "claim" | "skip" | "blocked", packageName?, packageExists?, version, tag, command,
reasons[] }`. After a claim is applied, `claimResults` lists `PackageClaimResult`
`{ claimPlan, status, error? }` with `status` one of `claimed` / `skipped` / `blocked` /
`dry-run` / `failed`.

## `results`

After an apply, each `ApplyResult` is `{ checkedPlan, status, error? }` where `status` is one of
`created` / `replaced` / `skipped` / `blocked` / `dry-run` / `failed`. Per-package npm failures are
captured as `failed` rather than aborting the run.

## `trustDiffs`

Drift is a list of `TrustConfigurationDiff` (`{ trust, fields[] }`). Each field diff is
`{ field, current, suggested }` over `provider`, `repository`, `file`, `environment`,
`allowPublish`, and `allowStagePublish`. Unset values render as `<unset>`.

## `summary`

A flat object of numeric counters. Stable baseline keys (always present, default `0`):

```
packages
highConfidence, mediumConfidence, lowConfidence
checkCreate, checkReplace, checkSkip, checkBlocked
applyCreated, applyReplaced, applySkipped, applyBlocked, applyFailed
claimNeeded, claimClaimed, claimSkipped, claimBlocked, claimFailed, claimDryRun
```

Counters are filled in as each phase runs: `check<Action>` from `checkedPlans`, `apply<Status>`
from `results`, and `claim<Action|Status>` from `claimPlans`/`claimResults` (`claimNeeded` counts
plans whose action is `claim`). Phases that did not run leave their counters at `0`.

## Audit exit codes

`--audit` also sets the process exit code so it can gate CI:

| Code | Meaning                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- |
| `0`  | no trusted publisher changes are needed                                                                  |
| `1`  | actionable changes exist (create, replace, or a claimable missing package)                               |
| `2`  | blocked or manual-review work remains (e.g. differing trust without `--replace`, or a non-matching skip) |
