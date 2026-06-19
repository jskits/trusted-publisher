import { applyPackageClaimPlans, checkPackageClaimPlans, willApplyPackageClaim } from "./claim.js";
import type { ExistingTrust, NpmClient } from "./npm.js";
import type { TrustedPublisherPlan } from "./planning.js";

describe("package claiming", () => {
  it("plans a placeholder claim for missing high-confidence packages", async () => {
    const client = createClient({ packageExists: false });
    const [claimPlan] = await checkPackageClaimPlans([createPlan()], client);

    expect(claimPlan).toMatchObject({
      action: "claim",
      packageExists: false,
      packageName: "@scope/a",
      tag: "trusted-publisher-claim",
      version: "0.0.0",
    });
    expect(claimPlan?.command).toContain("npm publish <temporary-placeholder-dir>");
    expect(willApplyPackageClaim(claimPlan!)).toBe(true);
    expect(client.calls).toEqual(["packageExists:@scope/a"]);
  });

  it("skips packages that already exist on npm", async () => {
    const client = createClient({ packageExists: true });
    const [claimPlan] = await checkPackageClaimPlans([createPlan()], client);

    expect(claimPlan?.action).toBe("skip");
    expect(claimPlan?.reasons).toContain("package already exists on npm");
  });

  it("does not claim non-high-confidence packages", async () => {
    const client = createClient({ packageExists: false });
    const [claimPlan] = await checkPackageClaimPlans(
      [createPlan({ confidence: "medium", score: 70 })],
      client,
    );

    expect(claimPlan?.action).toBe("skip");
    expect(claimPlan?.reasons).toContain(
      "plan confidence is medium; only high-confidence packages can be claimed",
    );
    expect(client.calls).toEqual([]);
  });

  it("applies package claims serially", async () => {
    const client = createClient({ packageExists: false });
    const claimPlans = await checkPackageClaimPlans([createPlan()], client);
    const [result] = await applyPackageClaimPlans(claimPlans, client, { delayMs: 0 });

    expect(result?.status).toBe("claimed");
    expect(client.calls).toEqual(["packageExists:@scope/a", "claim:@scope/a:0.0.0"]);
  });

  it("supports dry-run claim results without publishing", async () => {
    const client = createClient({ packageExists: false });
    const claimPlans = await checkPackageClaimPlans([createPlan()], client);
    const [result] = await applyPackageClaimPlans(claimPlans, client, { dryRun: true });

    expect(result?.status).toBe("dry-run");
    expect(client.calls).toEqual(["packageExists:@scope/a"]);
  });
});

function createClient(
  options: {
    readonly packageExists?: boolean;
    readonly trusts?: readonly ExistingTrust[];
  } = {},
): NpmClient & { readonly calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    async claimPackage(packageName, claimOptions) {
      calls.push(`claim:${packageName}:${claimOptions?.version ?? ""}`);
    },
    async createTrust(plan) {
      calls.push(`create:${plan.package.name ?? plan.package.relativePath}`);
    },
    async getVersion() {
      calls.push("getVersion");
      return "11.15.0";
    },
    async listTrust(packageName) {
      calls.push(`listTrust:${packageName}`);
      return [...(options.trusts ?? [])];
    },
    async listScopePackages(scope) {
      calls.push(`listScopePackages:${scope}`);
      return [];
    },
    async packageExists(packageName) {
      calls.push(`packageExists:${packageName}`);
      return options.packageExists ?? true;
    },
    async revokeTrust(packageName, trustId) {
      calls.push(`revoke:${packageName}:${trustId}`);
    },
  };
}

function createPlan(overrides: Partial<TrustedPublisherPlan> = {}): TrustedPublisherPlan {
  return {
    confidence: "high",
    evidence: [],
    explain: [],
    package: {
      directory: "/repo/packages/a",
      name: "@scope/a",
      private: false,
      publishable: true,
      relativePath: "packages/a",
      skipReasons: [],
      version: "1.0.0",
    },
    permissions: {
      allowPublish: true,
      allowStagePublish: false,
    },
    reasons: [],
    repository: "owner/repo",
    score: 95,
    trustArgs: [
      "npm",
      "trust",
      "github",
      "@scope/a",
      "--repo",
      "owner/repo",
      "--file",
      "release.yml",
      "--allow-publish",
      "--yes",
    ],
    workflowFile: "release.yml",
    ...overrides,
  };
}
