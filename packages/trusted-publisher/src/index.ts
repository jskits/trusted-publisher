import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";
import pc from "picocolors";

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
    .option("-y, --yes", "skip confirmation prompts for high-confidence changes")
    .action((options: { readonly dryRun?: boolean; readonly yes?: boolean }) => {
      const mode = options.dryRun ? "dry run" : "scan";
      io.stdout.write(`${pc.bold("trusted-publisher")} ${mode} is ready.\n`);
      io.stdout.write("Package discovery and workflow planning will be added next.\n");
    });

  return program;
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
