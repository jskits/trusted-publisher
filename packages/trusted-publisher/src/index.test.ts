import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import type { WorkspaceDiscovery } from "./discovery.js";
import { createProgram, readPackageVersion, runCli, type CliServices } from "./index.js";
import type { ExistingTrust, NpmClient } from "./npm.js";
import type { SourceDiscovery } from "./source.js";

class MemoryWritable extends Writable {
  public chunks: string[] = [];

  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: () => void,
  ): void {
    this.chunks.push(chunk.toString());
    done();
  }

  public override toString(): string {
    return this.chunks.join("");
  }
}

describe("trusted-publisher CLI", () => {
  it("creates the expected command", () => {
    const program = createProgram();

    expect(program.name()).toBe("trusted-publisher");
  });

  it("reads the package version", () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints the scan summary", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();

    await runCli({
      argv: ["--dry-run"],
      io: { stderr, stdout },
    });

    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toContain("trusted-publisher plan");
    expect(stdout.toString()).toContain("Dry run: no npm changes will be made.");
  });

  it("prints the version without treating Commander exit as a failure", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();

    await runCli({
      argv: ["--version"],
      io: { stderr, stdout },
    });

    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toMatch(/^0\.1\.0\n$/);
  });

  it("applies when npm_config_yes is true", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient();

    await runCli({
      argv: ["--delay-ms", "0"],
      env: { npm_config_yes: "true" },
      io: { stderr, stdout },
      services: createServices(client),
    });

    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toContain("Npm registry check:");
    expect(stdout.toString()).toContain("Apply summary:");
    expect(client.calls).toEqual([
      "getVersion",
      "packageExists:@scope/a",
      "listTrust:@scope/a",
      "create:@scope/a",
    ]);
  });

  it("prompts before applying without --yes", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient();

    await runCli({
      argv: ["--delay-ms", "0"],
      env: {},
      io: {
        stderr,
        stdin: createTtyInput("yes\n"),
        stdout,
      },
      services: createServices(client),
    });

    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toContain("Apply 1 high-confidence npm change? [y/N]");
    expect(client.calls).toContain("create:@scope/a");
  });

  it("does not apply without --yes in non-interactive mode", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient();

    await runCli({
      argv: ["--delay-ms", "0"],
      env: {},
      io: { stderr, stdout },
      services: createServices(client),
    });

    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toContain("No interactive input detected.");
    expect(client.calls).toEqual(["getVersion", "packageExists:@scope/a", "listTrust:@scope/a"]);
  });

  it("prints JSON dry-run reports without npm registry calls", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient();

    await runCli({
      argv: ["--dry-run", "--json"],
      env: {},
      io: { stderr, stdout },
      services: createServices(client),
    });

    const report = JSON.parse(stdout.toString()) as { mode: string; schemaVersion: number };
    expect(stderr.toString()).toBe("");
    expect(report).toMatchObject({ mode: "dry-run", schemaVersion: 1 });
    expect(client.calls).toEqual([]);
  });

  it("prints JSON audit reports and sets an actionable exit code", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient();

    await runCli({
      argv: ["--audit", "--json"],
      env: {},
      io: { stderr, stdout },
      services: createServices(client),
    });

    const report = JSON.parse(stdout.toString()) as {
      mode: string;
      summary: { checkCreate: number };
    };
    expect(stderr.toString()).toBe("");
    expect(report.mode).toBe("audit");
    expect(report.summary.checkCreate).toBe(1);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("prints JSON dry-run claim reports without npm mutations", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient({ packageExists: false });

    await runCli({
      argv: ["--dry-run", "--claim", "--json"],
      env: {},
      io: { stderr, stdout },
      services: createServices(client),
    });

    const report = JSON.parse(stdout.toString()) as {
      claimPlans: Array<{ action: string }>;
      mode: string;
      summary: { claimNeeded: number };
    };
    expect(stderr.toString()).toBe("");
    expect(report.mode).toBe("dry-run");
    expect(report.claimPlans[0]?.action).toBe("claim");
    expect(report.summary.claimNeeded).toBe(1);
    expect(client.calls).toEqual(["packageExists:@scope/a"]);
  });

  it("loads scoped npm packages for dry-run planning", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient({
      scopePackages: ["@scope/b", "@scope/a", "@other/ignored"],
    });

    await runCli({
      argv: ["--scope", "scope", "--workflow", "release.yml", "--dry-run", "--json"],
      env: {},
      io: { stderr, stdout },
      services: createServices(client),
    });

    const report = JSON.parse(stdout.toString()) as {
      discovery: { packages: Array<{ name: string; relativePath: string }> };
      plans: Array<{ package: { name: string } }>;
    };
    expect(stderr.toString()).toBe("");
    expect(report.discovery.packages.map((pkg) => [pkg.name, pkg.relativePath])).toEqual([
      ["@scope/a", "npm:@scope/a"],
      ["@scope/b", "npm:@scope/b"],
    ]);
    expect(report.plans.map((plan) => plan.package.name)).toEqual(["@scope/a", "@scope/b"]);
    expect(client.calls).toEqual(["listScopePackages:@scope:250"]);
  });

  it("scans a GitHub source instead of the current directory", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient();
    const sourceCalls: string[] = [];
    let cleanupCalls = 0;

    await runCli({
      argv: ["--source", "https://github.com/remote/repo", "--dry-run", "--json"],
      env: {},
      io: { stderr, stdout },
      services: createServices(client, {
        async discoverSourceWorkspace(source) {
          sourceCalls.push(source);
          return {
            cleanup: () => {
              cleanupCalls += 1;
            },
            discovery: createDiscovery({
              packageName: "@remote/pkg",
              repository: "remote/repo",
              rootDir: "/tmp/trusted-publisher-source/repo",
            }),
            repository: "remote/repo",
            source,
          };
        },
      }),
    });

    const report = JSON.parse(stdout.toString()) as {
      discovery: { repository: { githubRepository: string; rootDir: string } };
      plans: Array<{ command: string; package: { name: string }; repository: string }>;
    };
    expect(stderr.toString()).toBe("");
    expect(sourceCalls).toEqual(["https://github.com/remote/repo"]);
    expect(cleanupCalls).toBe(1);
    expect(report.discovery.repository).toMatchObject({
      githubRepository: "remote/repo",
      rootDir: "/tmp/trusted-publisher-source/repo",
    });
    expect(report.plans[0]).toMatchObject({
      package: { name: "@remote/pkg" },
      repository: "remote/repo",
    });
    expect(report.plans[0]?.command).toContain('--repo "remote/repo"');
    expect(client.calls).toEqual([]);
  });

  it("claims missing packages before applying trusted publisher plans", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient({ packageExists: false });

    await runCli({
      argv: ["--claim", "--yes", "--delay-ms", "0"],
      env: {},
      io: { stderr, stdout },
      services: createServices(client),
    });

    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toContain("Package claim summary:");
    expect(stdout.toString()).toContain("Apply summary:");
    expect(client.calls).toEqual([
      "getVersion",
      "packageExists:@scope/a",
      "claim:@scope/a:0.0.0",
      "packageExists:@scope/a",
      "listTrust:@scope/a",
      "create:@scope/a",
    ]);
  });

  it("writes markdown migration reports", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient();
    const reportPath = join(mkdtempSync(join(tmpdir(), "trusted-publisher-report-")), "report.md");

    await runCli({
      argv: ["--audit", "--report", reportPath],
      env: {},
      io: { stderr, stdout },
      services: createServices(client),
    });

    const report = readFileSync(reportPath, "utf8");
    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toContain(`Migration report written to ${reportPath}`);
    expect(report).toContain("# trusted-publisher Migration Report");
    expect(report).toContain("@scope/a");
    process.exitCode = undefined;
  });

  it("blocks unsupported npm CLI versions before registry checks", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const client = createClient({ npmVersion: "10.9.0" });

    await runCli({
      argv: ["--yes"],
      env: {},
      io: { stderr, stdout },
      services: createServices(client),
    });

    expect(stderr.toString()).toContain("npm CLI >= 11.15.0 is required; found 10.9.0.");
    expect(client.calls).toEqual(["getVersion"]);
  });

  it("rejects conflicting permission flags", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();

    await runCli({
      argv: ["--publish-only", "--stage-only", "--dry-run"],
      io: { stderr, stdout },
    });

    expect(stderr.toString()).toContain("Choose only one of");
  });
});

function createServices(
  client: NpmClient,
  options: {
    readonly discoverSourceWorkspace?: (source: string) => Promise<SourceDiscovery>;
  } = {},
): Partial<CliServices> {
  return {
    createNpmClient: () => client,
    ...(options.discoverSourceWorkspace
      ? { discoverSourceWorkspace: options.discoverSourceWorkspace }
      : {}),
    discoverWorkspace: () => createDiscovery(),
  };
}

function createClient(
  options: {
    readonly npmVersion?: string;
    readonly packageExists?: boolean;
    readonly scopePackages?: readonly string[];
    readonly trusts?: readonly ExistingTrust[];
  } = {},
): NpmClient & { readonly calls: string[] } {
  const calls: string[] = [];
  const claimed = new Set<string>();

  return {
    calls,
    async claimPackage(packageName, claimOptions) {
      calls.push(`claim:${packageName}:${claimOptions?.version ?? ""}`);
      claimed.add(packageName);
    },
    async createTrust(plan) {
      calls.push(`create:${plan.package.name ?? plan.package.relativePath}`);
    },
    async getVersion() {
      calls.push("getVersion");
      return options.npmVersion ?? "11.15.0";
    },
    async listTrust(packageName) {
      calls.push(`listTrust:${packageName}`);
      return [...(options.trusts ?? [])];
    },
    async listScopePackages(scope, scopeOptions) {
      calls.push(`listScopePackages:${scope}:${scopeOptions?.limit ?? ""}`);
      return [...(options.scopePackages ?? [])];
    },
    async packageExists(packageName) {
      calls.push(`packageExists:${packageName}`);
      return claimed.has(packageName) || (options.packageExists ?? true);
    },
    async revokeTrust(packageName, trustId) {
      calls.push(`revoke:${packageName}:${trustId}`);
    },
  };
}

function createDiscovery(
  options: {
    readonly packageName?: string;
    readonly repository?: string;
    readonly rootDir?: string;
  } = {},
): WorkspaceDiscovery {
  const packageName = options.packageName ?? "@scope/a";
  const repository = options.repository ?? "owner/repo";
  const rootDir = options.rootDir ?? "/repo";

  return {
    packages: [
      {
        directory: `${rootDir}/packages/a`,
        name: packageName,
        private: false,
        publishable: true,
        relativePath: "packages/a",
        skipReasons: [],
        version: "1.0.0",
      },
    ],
    repository: {
      githubRepository: repository,
      remoteUrl: `git@github.com:${repository}.git`,
      rootDir,
    },
    workflows: [
      {
        candidates: [],
        evidence: [],
        fileName: "release.yml",
        path: `${rootDir}/.github/workflows/release.yml`,
        relativePath: ".github/workflows/release.yml",
        signals: {
          changesetsAction: false,
          environments: [],
          hasIdTokenWrite: true,
          lernaPublish: false,
          npmPublish: true,
          npmStagePublish: false,
          nxReleasePublish: false,
          packageManagerPublish: false,
          reusableWorkflow: false,
          semanticRelease: false,
        },
      },
    ],
  };
}

function createTtyInput(text: string): Readable & { readonly isTTY: true } {
  return Object.assign(Readable.from([text]), { isTTY: true as const });
}
