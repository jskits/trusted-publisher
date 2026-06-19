# Programmatic API

`trusted-publisher` ships its internals as a typed ESM library in addition to the `bin`. Import from
the package entry point:

```ts
import {
  discoverWorkspace,
  buildTrustedPublisherPlans,
  checkTrustedPublisherPlans,
  applyCheckedTrustedPublisherPlans,
  createNpmCliClient,
} from "trusted-publisher";
```

The package is `"type": "module"` with `exports["."]` pointing at `dist/index.js` and
`dist/index.d.ts`. There is no CommonJS build.

## Running the CLI in-process

```ts
import { runCli } from "trusted-publisher";

await runCli({
  argv: ["--audit", "--json"],
  env: process.env,
  io: { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
  // services: { createNpmClient, discoverWorkspace, discoverSourceWorkspace } // inject fakes
});
```

- `runCli(options?)` — parse args and execute; sets `process.exitCode` on error/audit.
- `createProgram(io?, services?, env?)` — the underlying Commander `Command`, for embedding.
- `readPackageVersion(startUrl?)` — resolves the package version from the nearest `package.json`.

`RunCliOptions.services` (`CliServices`) is the dependency-injection seam:
`createNpmClient`, `discoverWorkspace`, and `discoverSourceWorkspace` can all be replaced.

## Discovery

```ts
const discovery = discoverWorkspace(process.cwd());
// { repository, packages, workflows }
```

- `discoverWorkspace(startDir?)` → `WorkspaceDiscovery`.
- `discoverRepository(startDir?)` → `{ rootDir, remoteUrl?, githubRepository? }`.
- `findRepoRoot(startDir?)` → repository root path.
- `parseGitHubRepository(remoteUrl)` → `"owner/repo"` or `undefined`.
- `discoverPackages(rootDir)` → `PackageInfo[]`.
- `readWorkspacePatterns(rootDir)` → workspace glob patterns.
- `discoverGitHubWorkflows(rootDir)` → `WorkflowInfo[]`.

## Topology and planning

```ts
const topology = resolvePublishTopology(discovery);
const plans = buildTrustedPublisherPlans(discovery, {
  permissionMode: "infer", // "infer" | "publish" | "stage" | "both"
  repository: "owner/repo", // optional override
  workflowFile: "release.yml", // optional override
});
const command = renderNpmTrustCommand(plans[0].trustArgs ?? []);
```

- `resolvePublishTopology(discovery)` → `PublishTopology`.
- `buildTrustedPublisherPlans(discovery, options?)` → `TrustedPublisherPlan[]`.
- `renderNpmTrustCommand(args)` → display-quoted command string.

## npm client

`createNpmCliClient(options?)` returns the real `NpmClient` that shells out to `npm`. Implement the
`NpmClient` interface yourself to test or to target a different backend:

```ts
interface NpmClient {
  packageExists(name: string): Promise<boolean>;
  listTrust(name: string): Promise<ExistingTrust[]>;
  createTrust(plan: TrustedPublisherPlan): Promise<void>;
  revokeTrust(name: string, trustId: string): Promise<void>;
  claimPackage(name: string, options?: NpmPackageClaimOptions): Promise<void>;
  listScopePackages(scope: string, options?: NpmScopePackageOptions): Promise<string[]>;
  getVersion(): Promise<string>;
}
```

Parsing/matching helpers:

- `parseTrustList(stdout)` → `ExistingTrust[]` (tolerant of several npm field-name spellings).
- `trustMatchesPlan(trust, plan)` → whether an existing record already satisfies a plan.

## Check, apply, and claim

```ts
const client = createNpmCliClient();
const checked = await checkTrustedPublisherPlans(plans, client, { replace: false });
const results = await applyCheckedTrustedPublisherPlans(checked, client, { delayMs: 2000 });
```

- `checkTrustedPublisherPlans(plans, client, options?)` → `CheckedPlan[]` (read-only).
- `applyTrustedPublisherPlans(plans, client, options?)` → check then apply, `ApplyResult[]`.
- `applyCheckedTrustedPublisherPlans(checked, client, options?)` → apply pre-checked plans.
- `checkPackageClaimPlans(plans, client, options?)` → `PackageClaimPlan[]`.
- `applyPackageClaimPlans(claimPlans, client, options?)` → `PackageClaimResult[]`.
- `willApplyPackageClaim(claimPlan)` → whether a claim plan will mutate.

`ApplyOptions`/`CheckOptions` carry `{ replace?, delayMs?, dryRun? }`. Mutations are serial and
throttled by `delayMs` (default `2000`).

## Scope, source, drift, and reports

- `normalizeNpmScope(value)` → `"@scope"` (throws on invalid input).
- `createScopePackages(names, scope, rootDir)` / `withScopePackages(discovery, names, scope)`.
- `discoverSourceWorkspace(source, options?)` → `{ discovery, repository, source, cleanup() }`
  (clones a public GitHub repo; call `cleanup()` when done). `parseGitHubSource(source)` →
  `"owner/repo"`.
- `compareTrustToPlan(trust, plan)` → `TrustConfigurationDiff`; `formatTrustFieldDiff(diff)` →
  `"field: current -> suggested"`.
- `generateMigrationReport(input)` → Markdown string.
- `checkRuntimePrerequisites({ nodeVersion, npmVersion })` → `RuntimePrerequisiteIssue[]`;
  `formatRuntimePrerequisiteIssues(issues)` → message string.

## End-to-end example

```ts
import {
  discoverWorkspace,
  buildTrustedPublisherPlans,
  checkTrustedPublisherPlans,
  applyCheckedTrustedPublisherPlans,
  createNpmCliClient,
} from "trusted-publisher";

const discovery = discoverWorkspace();
const plans = buildTrustedPublisherPlans(discovery);
const client = createNpmCliClient();

const checked = await checkTrustedPublisherPlans(plans, client);
const highConfidence = checked.filter(
  (c) => c.plan.confidence === "high" && (c.action === "create" || c.action === "replace"),
);

const results = await applyCheckedTrustedPublisherPlans(highConfidence, client, { delayMs: 2000 });
console.log(results.map((r) => `${r.status}: ${r.checkedPlan.plan.package.name}`));
```
