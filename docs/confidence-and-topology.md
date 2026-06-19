# Confidence and Publish Topology

`trusted-publisher` never blindly mutates npm. Each package gets a **plan** with a numeric score, a
**confidence** tier, and a list of human-readable `explain` and `reason` lines. Only
high-confidence plans are eligible for automatic apply.

## Publish topology

Before scoring, [`topology.ts`](../packages/trusted-publisher/src/topology.ts) maps every
publishable package to the workflow candidates whose `packageSelector` matches it.

A package's mapping status:

| Status      | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `matched`   | exactly one candidate publishes this package — the planner uses it directly      |
| `unmatched` | no candidate matches — fall back to repository-wide workflow selection           |
| `ambiguous` | more than one candidate matches — reported for manual review, never auto-applied |

The repository as a whole is classified into a topology `kind`:

| Kind          | Meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `global`      | every package is published by a single shared candidate (e.g. one Changesets/Lerna job) |
| `per-package` | every package maps to its own specific candidate, with no global publisher              |
| `hybrid`      | a mix of global and per-package publishing                                              |
| `conflict`    | at least one package is `ambiguous`                                                     |
| `unknown`     | no package could be matched to a candidate                                              |

Matching rules per selector: `all` matches everything; `name` matches `package.json#name`; `path`
matches the workspace directory; `filter` matches a name/path or a `*` glob. The topology `kind` is
reported in the migration report and is informational — it does not by itself change a score.

## Workflow selection

For each package the planner picks a workflow:

1. If `--workflow <file>` is passed, that file is used (by basename); a miss is reported.
2. Otherwise, if topology produced a `matched` candidate for the package, that candidate's workflow
   is used.
3. Otherwise the planner falls back to repository-wide selection:
   - exactly one **direct** publishing workflow (npm / pnpm / yarn) → selected;
   - more than one direct workflow → `multiple direct publishing workflows detected`;
   - exactly one **indirect** workflow (Changesets, semantic-release, Lerna, Nx) → selected with
     `publishing workflow uses an indirect release tool`;
   - more than one indirect workflow → `multiple indirect publishing workflows detected`.

## Permission inference

The `--publish-only`, `--stage-only`, and `--both` flags force the permission set. Without them the
mode is `infer`:

- If a candidate was selected, its command decides: `npm stage publish` → `--allow-stage-publish`,
  any other publish command → `--allow-publish`. Reusable-workflow candidates infer nothing.
- Otherwise the workflow signals decide: `npmStagePublish` → stage; any of `npmPublish`,
  `packageManagerPublish`, `changesetsAction`, `semanticRelease`, `lernaPublish`, `nxReleasePublish`
  → publish.

If neither permission can be inferred, the plan records `no trusted publishing action could be
inferred` and is capped at low/medium confidence.

## Scoring

[`planning.ts`](../packages/trusted-publisher/src/planning.ts) computes a score that starts at `0`
and is normalized into `[0, 100]`:

| Signal                                                                 | Delta |
| ---------------------------------------------------------------------- | ----- |
| package is publishable and has an npm name                             | +20   |
| GitHub repository resolved                                             | +15   |
| publishing workflow selected                                           | +15   |
| a workflow candidate was selected (any tool)                           | +15   |
| selected candidate directly runs a publish command (`kind: direct`)    | +15   |
| selected candidate is an indirect release tool                         | +5    |
| selected candidate delegates to a reusable workflow                    | −20   |
| no candidate, but the selected workflow has a direct publish signal    | +20   |
| no candidate, but the selected workflow has an indirect publish signal | +5    |
| publishing job/workflow has `id-token: write`                          | +15   |
| `id-token: write` is missing                                           | −25   |
| a trusted-publisher permission could be inferred                       | +10   |

After the additive signals, several caps are applied:

- subtract `min(40, reasons × 8)` — every plan reason erodes the score;
- any `multiple …` selection reason caps the score at **45**;
- any reason at all caps the score at **80**;
- a non-direct candidate caps the score at **80**;
- a missing prerequisite (not publishable, no name, no repo, no workflow, or no permission) caps the
  score at **45**.

### Confidence tiers

| Score | Confidence | Applied with explicit `--yes`? |
| ----- | ---------- | ------------------------------ |
| ≥ 85  | `high`     | yes                            |
| 50–84 | `medium`   | no — printed with reasons      |
| < 50  | `low`      | no — printed with reasons      |

In practice a `high` plan requires: a publishable, named package; a resolved GitHub repository; a
selected workflow with a **direct** publish command; `id-token: write` present; an inferred
permission; and no outstanding reasons. Anything ambiguous or indirect lands in `medium`/`low` and
is left for a human to review or to force with explicit flags.

## explain vs. reasons

- **explain** — the positive/negative scoring narrative ("GitHub repository resolved as owner/repo",
  "candidate directly runs a publish command"). Always present; useful for understanding _why_ a
  score landed where it did.
- **reasons** — blockers and caveats ("workflow is missing permissions.id-token: write", "multiple
  publishing candidates detected for package"). A non-empty list caps confidence and is the first
  thing to address when a plan is not `high`.
