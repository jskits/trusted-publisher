import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";
import pc from "picocolors";

import {
  applyCheckedTrustedPublisherPlans,
  checkTrustedPublisherPlans,
  type ApplyResult,
  type CheckedPlan,
} from "./apply.js";
import {
  applyPackageClaimPlans,
  checkPackageClaimPlans,
  type PackageClaimPlan,
  type PackageClaimResult,
  willApplyPackageClaim,
} from "./claim.js";
import { discoverWorkspace, type WorkspaceDiscovery } from "./discovery.js";
import { generateMigrationReport, type MigrationReportInput } from "./migration-report.js";
import { createNpmCliClient, type NpmClient, type NpmClientOptions } from "./npm.js";
import { buildTrustedPublisherPlans, type PermissionMode } from "./planning.js";
import { checkRuntimePrerequisites, formatRuntimePrerequisiteIssues } from "./prerequisites.js";
import { formatTrustFieldDiff } from "./trust-diff.js";

export {
  applyCheckedTrustedPublisherPlans,
  applyTrustedPublisherPlans,
  checkTrustedPublisherPlans,
} from "./apply.js";
export { applyPackageClaimPlans, checkPackageClaimPlans, willApplyPackageClaim } from "./claim.js";
export { discoverWorkspace } from "./discovery.js";
export { discoverRepository, findRepoRoot, parseGitHubRepository } from "./git.js";
export { generateMigrationReport } from "./migration-report.js";
export { createNpmCliClient, parseTrustList, trustMatchesPlan } from "./npm.js";
export { discoverPackages, readWorkspacePatterns } from "./packages.js";
export { buildTrustedPublisherPlans, renderNpmTrustCommand } from "./planning.js";
export { checkRuntimePrerequisites, formatRuntimePrerequisiteIssues } from "./prerequisites.js";
export { resolvePublishTopology } from "./topology.js";
export { compareTrustToPlan, formatTrustFieldDiff } from "./trust-diff.js";
export { discoverGitHubWorkflows } from "./workflows.js";

export interface CliIo {
  readonly stdin?: CliInput;
  readonly stderr: NodeJS.WritableStream;
  readonly stdout: NodeJS.WritableStream;
}

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly io?: CliIo;
  readonly services?: Partial<CliServices>;
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
}

export interface CliInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

export interface CliServices {
  readonly createNpmClient: (options: NpmClientOptions) => NpmClient;
  readonly discoverWorkspace: () => WorkspaceDiscovery;
}

const defaultIo: CliIo = {
  stdin: process.stdin,
  stderr: process.stderr,
  stdout: process.stdout,
};

export function createProgram(
  io: CliIo = defaultIo,
  services: CliServices = defaultServices,
  env: Record<string, string | undefined> = process.env,
): Command {
  const program = new Command();

  program.configureOutput({
    outputError: (message, write) => {
      write(message);
    },
    writeErr: (message) => {
      io.stderr.write(message);
    },
    writeOut: (message) => {
      io.stdout.write(message);
    },
  });

  program
    .name("trusted-publisher")
    .description("Bulk configure npm trusted publishing for GitHub monorepos.")
    .version(readPackageVersion())
    .option("--dry-run", "print the planned npm trust commands without changing npm")
    .option("--repo <owner/repo>", "override the detected GitHub repository")
    .option("--workflow <file>", "override the detected GitHub Actions workflow filename")
    .option("--registry <url>", "use a custom npm registry for npm package and trust checks")
    .option("--replace", "revoke differing trusted publisher records before recreating them")
    .option("--delay-ms <number>", "delay between npm trust mutations", parseInteger, 2000)
    .option("--json", "write a machine-readable JSON report")
    .option("--audit", "check npm trusted publisher state without applying changes")
    .option("--report <path>", "write a markdown migration report to a path, or '-' for stdout")
    .option("--claim", "publish placeholder packages for missing npm package names")
    .option("-y, --yes", "skip confirmation prompts for high-confidence changes")
    .option("--publish-only", "allow npm publish only")
    .option("--stage-only", "allow npm stage publish only")
    .option("--both", "allow npm publish and npm stage publish")
    .action(async (options: CliOptions) => {
      const permissionMode = resolvePermissionMode(options);
      const discovery = services.discoverWorkspace();
      const planningOptions: {
        permissionMode: PermissionMode;
        repository?: string;
        workflowFile?: string;
      } = { permissionMode };
      if (options.repo) {
        planningOptions.repository = options.repo;
      }
      if (options.workflow) {
        planningOptions.workflowFile = options.workflow;
      }
      const plans = buildTrustedPublisherPlans(discovery, planningOptions);
      if (options.json && options.report === "-") {
        throw new Error("--report - cannot be combined with --json because both write to stdout.");
      }

      if (!options.json) {
        printPlanSummary(discovery, plans, options, io);
      }

      if (options.dryRun && !options.claim) {
        writeMigrationReportIfRequested({ discovery, plans }, options, io);
        if (options.json) {
          printJsonReport({ discovery, mode: "dry-run", plans }, io);
        } else {
          io.stdout.write("\nDry run: no npm changes will be made.\n");
        }
        return;
      }

      let claimPlans: PackageClaimPlan[] = [];
      let claimResults: PackageClaimResult[] = [];
      let claimMutationDeferred = false;

      const clientOptions: { registry?: string } = {};
      if (options.registry) {
        clientOptions.registry = options.registry;
      }

      const applyOptions: { delayMs: number; replace?: boolean } = {
        delayMs: options.delayMs,
      };
      if (options.replace) {
        applyOptions.replace = true;
      }

      const client = services.createNpmClient(clientOptions);
      if (!options.dryRun) {
        const prerequisiteIssues = checkRuntimePrerequisites({
          nodeVersion: process.versions.node,
          npmVersion: await client.getVersion(),
        });
        if (prerequisiteIssues.length > 0) {
          throw new Error(formatRuntimePrerequisiteIssues(prerequisiteIssues));
        }
      }

      if (options.claim) {
        claimPlans = await checkPackageClaimPlans(plans, client, applyOptions);
        if (!options.json) {
          printPackageClaimSummary(claimPlans, io);
        }

        if (options.dryRun) {
          writeMigrationReportIfRequested({ claimPlans, discovery, plans }, options, io);
          if (options.json) {
            printJsonReport({ claimPlans, discovery, mode: "dry-run", plans }, io);
          } else {
            io.stdout.write("\nDry run: no npm changes will be made.\n");
          }
          return;
        }

        const claimMutableCount = claimPlans.filter(willApplyPackageClaim).length;
        if (!options.audit && claimMutableCount > 0) {
          let shouldClaim = shouldApply(options, env);
          if (!shouldClaim) {
            if (options.json) {
              claimMutationDeferred = true;
            } else {
              shouldClaim = await confirmPackageClaims(claimMutableCount, io);
              claimMutationDeferred = !shouldClaim;
              if (!shouldClaim) {
                io.stdout.write("\nNo package claims made.\n");
              }
            }
          }

          if (shouldClaim) {
            claimResults = await applyPackageClaimPlans(claimPlans, client, applyOptions);
            if (!options.json) {
              printPackageClaimApplySummary(claimResults, io);
            }
          }
        }
      }

      const checkedPlans = await checkTrustedPublisherPlans(plans, client, applyOptions);
      if (options.audit) {
        writeMigrationReportIfRequested(
          { checkedPlans, claimPlans, discovery, plans },
          options,
          io,
        );
        if (options.json) {
          printJsonReport({ checkedPlans, claimPlans, discovery, mode: "audit", plans }, io);
        } else {
          printNpmCheckSummary(checkedPlans, io);
        }
        process.exitCode = determineAuditExitCode(checkedPlans, claimPlans);
        return;
      }

      if (!options.json) {
        printNpmCheckSummary(checkedPlans, io);
      }

      const mutableCount = checkedPlans.filter((checkedPlan) => willApply(checkedPlan)).length;
      if (mutableCount === 0) {
        writeMigrationReportIfRequested(
          { checkedPlans, claimPlans, claimResults, discovery, plans, results: [] },
          options,
          io,
        );
        if (options.json) {
          printJsonReport(
            {
              checkedPlans,
              claimPlans,
              claimResults,
              discovery,
              mode: claimMutationDeferred ? "plan" : "apply",
              plans,
              results: [],
            },
            io,
          );
        } else {
          io.stdout.write("\nNo high-confidence npm changes to apply.\n");
        }
        return;
      }

      if (!shouldApply(options, env)) {
        if (options.json) {
          writeMigrationReportIfRequested(
            { checkedPlans, claimPlans, claimResults, discovery, plans },
            options,
            io,
          );
          printJsonReport(
            {
              checkedPlans,
              claimPlans,
              claimResults,
              discovery,
              mode: "plan",
              plans,
            },
            io,
          );
          return;
        }

        const confirmed = await confirmApply(mutableCount, io);
        if (!confirmed) {
          io.stdout.write("\nNo npm changes made.\n");
          writeMigrationReportIfRequested(
            { checkedPlans, claimPlans, claimResults, discovery, plans },
            options,
            io,
          );
          return;
        }
      }

      const results = await applyCheckedTrustedPublisherPlans(checkedPlans, client, applyOptions);
      writeMigrationReportIfRequested(
        { checkedPlans, claimPlans, claimResults, discovery, plans, results },
        options,
        io,
      );
      if (options.json) {
        printJsonReport(
          {
            checkedPlans,
            claimPlans,
            claimResults,
            discovery,
            mode: "apply",
            plans,
            results,
          },
          io,
        );
      } else {
        printApplySummary(results, io);
      }
    });

  return program;
}

interface CliOptions {
  readonly audit?: boolean;
  readonly both?: boolean;
  readonly claim?: boolean;
  readonly delayMs: number;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly publishOnly?: boolean;
  readonly registry?: string;
  readonly report?: string;
  readonly replace?: boolean;
  readonly repo?: string;
  readonly stageOnly?: boolean;
  readonly workflow?: string;
  readonly yes?: boolean;
}

function printPlanSummary(
  discovery: WorkspaceDiscovery,
  plans: ReturnType<typeof buildTrustedPublisherPlans>,
  options: CliOptions,
  io: CliIo,
): void {
  const publishablePackages = discovery.packages.filter((pkg) => pkg.publishable);
  const skippedPackages = discovery.packages.filter((pkg) => !pkg.publishable);

  io.stdout.write(`${pc.bold("trusted-publisher")} plan\n`);
  io.stdout.write(`Repository root: ${discovery.repository.rootDir}\n`);
  io.stdout.write(
    `GitHub repository: ${options.repo ?? discovery.repository.githubRepository ?? "not detected"}\n`,
  );
  io.stdout.write(`Publishable packages: ${publishablePackages.length}\n`);
  io.stdout.write(`Skipped packages: ${skippedPackages.length}\n`);
  io.stdout.write(`GitHub workflows: ${discovery.workflows.length}\n`);

  for (const plan of plans) {
    const name = plan.package.name ?? plan.package.relativePath;
    io.stdout.write(`\n${pc.bold(name)} [${plan.confidence}, score ${plan.score}]\n`);
    if (plan.workflowFile) {
      io.stdout.write(`  workflow: ${plan.workflowFile}\n`);
    }
    if (plan.command) {
      io.stdout.write(`  command: ${plan.command}\n`);
    }
    for (const explanation of plan.explain) {
      io.stdout.write(`  explain: ${explanation}\n`);
    }
    for (const reason of plan.reasons) {
      io.stdout.write(`  reason: ${reason}\n`);
    }
  }
}

function resolvePermissionMode(options: CliOptions): PermissionMode {
  const selected = [options.both, options.publishOnly, options.stageOnly].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("Choose only one of --publish-only, --stage-only, or --both.");
  }

  if (options.both) {
    return "both";
  }

  if (options.publishOnly) {
    return "publish";
  }

  if (options.stageOnly) {
    return "stage";
  }

  return "infer";
}

const defaultServices: CliServices = {
  createNpmClient: createNpmCliClient,
  discoverWorkspace,
};

function shouldApply(options: CliOptions, env: Record<string, string | undefined>): boolean {
  return Boolean(options.yes) || env.npm_config_yes === "true";
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed.toString() !== value) {
    throw new Error("Expected a non-negative integer.");
  }

  return parsed;
}

function printNpmCheckSummary(checkedPlans: readonly CheckedPlan[], io: CliIo): void {
  io.stdout.write("\nNpm registry check:\n");

  for (const checkedPlan of checkedPlans) {
    const name = checkedPlan.plan.package.name ?? checkedPlan.plan.package.relativePath;
    io.stdout.write(`  ${checkedPlan.action}: ${name}\n`);
    io.stdout.write(`    package exists: ${formatPackageExists(checkedPlan)}\n`);
    io.stdout.write(`    existing trusted publishers: ${checkedPlan.existingTrusts.length}\n`);

    for (const reason of checkedPlan.reasons) {
      io.stdout.write(`    reason: ${reason}\n`);
    }
    for (const trustDiff of checkedPlan.trustDiffs) {
      const id = trustDiff.trust.id ?? "<unknown>";
      for (const fieldDiff of trustDiff.fields) {
        io.stdout.write(`    diff(${id}): ${formatTrustFieldDiff(fieldDiff)}\n`);
      }
    }
  }
}

function printPackageClaimSummary(claimPlans: readonly PackageClaimPlan[], io: CliIo): void {
  io.stdout.write("\nPackage claim check:\n");

  for (const claimPlan of claimPlans) {
    const name = claimPlan.packageName ?? claimPlan.package.name ?? claimPlan.package.relativePath;
    io.stdout.write(`  ${claimPlan.action}: ${name}\n`);
    io.stdout.write(`    package exists: ${formatClaimPackageExists(claimPlan)}\n`);
    io.stdout.write(`    placeholder version: ${claimPlan.version}\n`);
    io.stdout.write(`    dist-tag: ${claimPlan.tag}\n`);
    if (claimPlan.action === "claim") {
      io.stdout.write(`    command: ${claimPlan.command}\n`);
    }
    for (const reason of claimPlan.reasons) {
      io.stdout.write(`    reason: ${reason}\n`);
    }
  }
}

function printJsonReport(
  input: {
    readonly checkedPlans?: readonly CheckedPlan[];
    readonly claimPlans?: readonly PackageClaimPlan[];
    readonly claimResults?: readonly PackageClaimResult[];
    readonly discovery: WorkspaceDiscovery;
    readonly mode: "apply" | "audit" | "dry-run" | "plan";
    readonly plans: ReturnType<typeof buildTrustedPublisherPlans>;
    readonly results?: readonly ApplyResult[];
  },
  io: CliIo,
): void {
  io.stdout.write(
    `${JSON.stringify(
      {
        checkedPlans: input.checkedPlans ?? [],
        claimPlans: input.claimPlans ?? [],
        claimResults: input.claimResults ?? [],
        discovery: input.discovery,
        mode: input.mode,
        plans: input.plans,
        results: input.results ?? [],
        schemaVersion: 1,
        summary: createReportSummary(
          input.plans,
          input.checkedPlans,
          input.results,
          input.claimPlans,
          input.claimResults,
        ),
      },
      null,
      2,
    )}\n`,
  );
}

function writeMigrationReportIfRequested(
  input: MigrationReportInput,
  options: CliOptions,
  io: CliIo,
): void {
  if (!options.report) {
    return;
  }

  const report = generateMigrationReport(input);
  if (options.report === "-") {
    io.stdout.write(report);
    return;
  }

  writeFileSync(options.report, report);
  if (!options.json) {
    io.stdout.write(`\nMigration report written to ${options.report}\n`);
  }
}

function createReportSummary(
  plans: ReturnType<typeof buildTrustedPublisherPlans>,
  checkedPlans: readonly CheckedPlan[] | undefined,
  results: readonly ApplyResult[] | undefined,
  claimPlans: readonly PackageClaimPlan[] | undefined,
  claimResults: readonly PackageClaimResult[] | undefined,
): Record<string, number> {
  const summary: Record<string, number> = {
    applyBlocked: 0,
    applyCreated: 0,
    applyFailed: 0,
    applyReplaced: 0,
    applySkipped: 0,
    checkBlocked: 0,
    checkCreate: 0,
    checkReplace: 0,
    checkSkip: 0,
    claimBlocked: 0,
    claimClaimed: 0,
    claimDryRun: 0,
    claimFailed: 0,
    claimNeeded: 0,
    claimSkipped: 0,
    highConfidence: plans.filter((plan) => plan.confidence === "high").length,
    lowConfidence: plans.filter((plan) => plan.confidence === "low").length,
    mediumConfidence: plans.filter((plan) => plan.confidence === "medium").length,
    packages: plans.length,
  };

  for (const checkedPlan of checkedPlans ?? []) {
    summary[`check${capitalize(checkedPlan.action)}`] =
      (summary[`check${capitalize(checkedPlan.action)}`] ?? 0) + 1;
  }

  for (const result of results ?? []) {
    summary[`apply${capitalize(result.status)}`] =
      (summary[`apply${capitalize(result.status)}`] ?? 0) + 1;
  }

  for (const claimPlan of claimPlans ?? []) {
    if (claimPlan.action === "claim") {
      summary.claimNeeded = (summary.claimNeeded ?? 0) + 1;
    } else {
      summary[`claim${capitalize(claimPlan.action)}`] =
        (summary[`claim${capitalize(claimPlan.action)}`] ?? 0) + 1;
    }
  }

  for (const claimResult of claimResults ?? []) {
    summary[`claim${capitalize(claimResult.status)}`] =
      (summary[`claim${capitalize(claimResult.status)}`] ?? 0) + 1;
  }

  return summary;
}

function determineAuditExitCode(
  checkedPlans: readonly CheckedPlan[],
  claimPlans: readonly PackageClaimPlan[] = [],
): number {
  if (
    checkedPlans.some(
      (checkedPlan) =>
        (checkedPlan.action === "blocked" &&
          !hasClaimableMissingPackage(checkedPlan, claimPlans)) ||
        (checkedPlan.action === "skip" && !checkedPlan.matchingTrust),
    )
  ) {
    return 2;
  }

  if (
    claimPlans.some((claimPlan) => claimPlan.action === "claim") ||
    checkedPlans.some(
      (checkedPlan) => checkedPlan.action === "create" || checkedPlan.action === "replace",
    )
  ) {
    return 1;
  }

  return 0;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatPackageExists(checkedPlan: CheckedPlan): string {
  if (checkedPlan.packageExists) {
    return "yes";
  }

  if (checkedPlan.reasons.some(isPreRegistryReason)) {
    return "not checked";
  }

  return "no";
}

function formatClaimPackageExists(claimPlan: PackageClaimPlan): string {
  if (claimPlan.packageExists === undefined) {
    return "not checked";
  }

  return claimPlan.packageExists ? "yes" : "no";
}

function hasClaimableMissingPackage(
  checkedPlan: CheckedPlan,
  claimPlans: readonly PackageClaimPlan[],
): boolean {
  const name = checkedPlan.plan.package.name;
  if (!name || !checkedPlan.reasons.includes("package does not exist on npm")) {
    return false;
  }

  return claimPlans.some(
    (claimPlan) => claimPlan.packageName === name && claimPlan.action === "claim",
  );
}

function isPreRegistryReason(reason: string): boolean {
  return (
    reason === "package name is required" ||
    reason === "npm trust command could not be rendered" ||
    reason.startsWith("plan confidence is ")
  );
}

function printPackageClaimApplySummary(results: readonly PackageClaimResult[], io: CliIo): void {
  io.stdout.write("\nPackage claim summary:\n");

  for (const result of results) {
    const name =
      result.claimPlan.packageName ??
      result.claimPlan.package.name ??
      result.claimPlan.package.relativePath;
    io.stdout.write(`  ${result.status}: ${name}\n`);

    for (const reason of result.claimPlan.reasons) {
      io.stdout.write(`    reason: ${reason}\n`);
    }
    if (result.error) {
      io.stdout.write(`    error: ${result.error}\n`);
    }
  }
}

function printApplySummary(results: readonly ApplyResult[], io: CliIo): void {
  io.stdout.write("\nApply summary:\n");

  for (const result of results) {
    const name =
      result.checkedPlan.plan.package.name ?? result.checkedPlan.plan.package.relativePath;
    io.stdout.write(`  ${result.status}: ${name}\n`);

    for (const reason of result.checkedPlan.reasons) {
      io.stdout.write(`    reason: ${reason}\n`);
    }
    if (result.error) {
      io.stdout.write(`    error: ${result.error}\n`);
    }
  }
}

function willApply(checkedPlan: CheckedPlan): boolean {
  return (
    checkedPlan.plan.confidence === "high" &&
    (checkedPlan.action === "create" || checkedPlan.action === "replace")
  );
}

async function confirmApply(mutableCount: number, io: CliIo): Promise<boolean> {
  const stdin = io.stdin ?? process.stdin;
  if (stdin.isTTY !== true) {
    io.stdout.write("\nNo interactive input detected. Use --yes to apply high-confidence plans.\n");
    return false;
  }

  io.stdout.write(
    `\nApply ${mutableCount} high-confidence npm change${plural(mutableCount)}? [y/N] `,
  );
  const readline = createInterface({ input: stdin, terminal: false });
  const answer = await readline.question("");
  readline.close();

  return /^(?:y|yes)$/i.test(answer.trim());
}

async function confirmPackageClaims(mutableCount: number, io: CliIo): Promise<boolean> {
  const stdin = io.stdin ?? process.stdin;
  if (stdin.isTTY !== true) {
    io.stdout.write("\nNo interactive input detected. Use --yes to claim missing packages.\n");
    return false;
  }

  io.stdout.write(`\nClaim ${mutableCount} missing npm package${plural(mutableCount)}? [y/N] `);
  const readline = createInterface({ input: stdin, terminal: false });
  const answer = await readline.question("");
  readline.close();

  return /^(?:y|yes)$/i.test(answer.trim());
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const program = createProgram(
    options.io ?? defaultIo,
    { ...defaultServices, ...options.services },
    options.env ?? process.env,
  );
  program.exitOverride();

  try {
    await program.parseAsync([...(options.argv ?? process.argv.slice(2))], {
      from: "user",
    });
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return;
    }

    if (error instanceof Error) {
      (options.io ?? defaultIo).stderr.write(`${error.message}\n`);
    }
    process.exitCode = 1;
  }
}

export function readPackageVersion(startUrl: string = import.meta.url): string {
  const manifest = findPackageManifest(startUrl);
  return manifest.version ?? "0.0.0";
}

function findPackageManifest(startUrl: string): PackageManifest {
  let directory = dirname(fileURLToPath(startUrl));

  while (true) {
    const packageJsonPath = join(directory, "package.json");

    if (existsSync(packageJsonPath)) {
      return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageManifest;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return {};
    }

    directory = parent;
  }
}
