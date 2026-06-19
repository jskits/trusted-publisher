import { Readable, Writable } from "node:stream";

import type { WorkspaceDiscovery } from "./discovery.js";
import { createProgram, readPackageVersion, runCli, type CliServices } from "./index.js";
import type { ExistingTrust, NpmClient } from "./npm.js";

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

function createServices(client: NpmClient): Partial<CliServices> {
  return {
    createNpmClient: () => client,
    discoverWorkspace: () => createDiscovery(),
  };
}

function createClient(
  options: {
    readonly npmVersion?: string;
    readonly trusts?: readonly ExistingTrust[];
  } = {},
): NpmClient & { readonly calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
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
    async packageExists(packageName) {
      calls.push(`packageExists:${packageName}`);
      return true;
    },
    async revokeTrust(packageName, trustId) {
      calls.push(`revoke:${packageName}:${trustId}`);
    },
  };
}

function createDiscovery(): WorkspaceDiscovery {
  return {
    packages: [
      {
        directory: "/repo/packages/a",
        name: "@scope/a",
        private: false,
        publishable: true,
        relativePath: "packages/a",
        skipReasons: [],
        version: "1.0.0",
      },
    ],
    repository: {
      githubRepository: "owner/repo",
      remoteUrl: "git@github.com:owner/repo.git",
      rootDir: "/repo",
    },
    workflows: [
      {
        fileName: "release.yml",
        path: "/repo/.github/workflows/release.yml",
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
          semanticRelease: false,
        },
      },
    ],
  };
}

function createTtyInput(text: string): Readable & { readonly isTTY: true } {
  return Object.assign(Readable.from([text]), { isTTY: true as const });
}
