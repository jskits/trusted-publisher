import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";
import pc from "picocolors";

import { applyTrustedPublisherPlans, type ApplyResult } from "./apply.js";
import { discoverWorkspace } from "./discovery.js";
import { createNpmCliClient } from "./npm.js";
import { buildTrustedPublisherPlans, type PermissionMode } from "./planning.js";

export { applyTrustedPublisherPlans, checkTrustedPublisherPlans } from "./apply.js";
export { discoverWorkspace } from "./discovery.js";
export { discoverRepository, findRepoRoot, parseGitHubRepository } from "./git.js";
export { createNpmCliClient, parseTrustList, trustMatchesPlan } from "./npm.js";
export { discoverPackages, readWorkspacePatterns } from "./packages.js";
export { buildTrustedPublisherPlans, renderNpmTrustCommand } from "./planning.js";
export { discoverGitHubWorkflows } from "./workflows.js";

export interface CliIo {
  readonly stderr: NodeJS.WritableStream;
  readonly stdout: NodeJS.WritableStream;
}

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly io?: CliIo;
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
}

const defaultIo: CliIo = {
  stderr: process.stderr,
  stdout: process.stdout,
};

export function createProgram(io: CliIo = defaultIo): Command {
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
    .option("-y, --yes", "skip confirmation prompts for high-confidence changes")
    .option("--publish-only", "allow npm publish only")
    .option("--stage-only", "allow npm stage publish only")
    .option("--both", "allow npm publish and npm stage publish")
    .action(async (options: CliOptions) => {
      const permissionMode = resolvePermissionMode(options);
      const discovery = discoverWorkspace();
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
        io.stdout.write(`\n${pc.bold(name)} [${plan.confidence}]\n`);
        if (plan.workflowFile) {
          io.stdout.write(`  workflow: ${plan.workflowFile}\n`);
        }
        if (plan.command) {
          io.stdout.write(`  command: ${plan.command}\n`);
        }
        for (const reason of plan.reasons) {
          io.stdout.write(`  reason: ${reason}\n`);
        }
      }

      if (options.dryRun) {
        io.stdout.write("\nDry run: no npm changes will be made.\n");
        return;
      }

      if (!shouldApply(options)) {
        io.stdout.write("\nNo npm changes made. Use --yes to apply high-confidence plans.\n");
        return;
      }

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

      const results = await applyTrustedPublisherPlans(
        plans,
        createNpmCliClient(clientOptions),
        applyOptions,
      );
      printApplySummary(results, io);
    });

  return program;
}

interface CliOptions {
  readonly both?: boolean;
  readonly delayMs: number;
  readonly dryRun?: boolean;
  readonly publishOnly?: boolean;
  readonly registry?: string;
  readonly replace?: boolean;
  readonly repo?: string;
  readonly stageOnly?: boolean;
  readonly workflow?: string;
  readonly yes?: boolean;
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

function shouldApply(options: CliOptions): boolean {
  return Boolean(options.yes) || process.env.npm_config_yes === "true";
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed.toString() !== value) {
    throw new Error("Expected a non-negative integer.");
  }

  return parsed;
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
  }
}

export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const program = createProgram(options.io ?? defaultIo);
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
