import { applyTrustedPublisherPlans, checkTrustedPublisherPlans } from "./apply.js";
import type { ExistingTrust, NpmClient } from "./npm.js";
import type { TrustedPublisherPlan } from "./planning.js";

describe("trusted publisher apply flow", () => {
  it("blocks packages that do not exist on npm", async () => {
    const client = createClient({ packageExists: false });
    const [checked] = await checkTrustedPublisherPlans([createPlan()], client);

    expect(checked?.action).toBe("blocked");
    expect(checked?.reasons).toContain("package does not exist on npm");
    expect(client.calls).toEqual(["packageExists:@scope/a"]);
  });

  it("skips an already configured trusted publisher", async () => {
    const client = createClient({ trusts: [matchingTrust()] });
    const [checked] = await checkTrustedPublisherPlans([createPlan()], client);

    expect(checked?.action).toBe("skip");
    expect(checked?.matchingTrust).toMatchObject({ id: "trust-1" });
    expect(checked?.reasons).toContain("trusted publisher already configured");
  });

  it("blocks differing existing publishers unless replacement is enabled", async () => {
    const client = createClient({
      trusts: [
        {
          ...matchingTrust(),
          repository: "owner/other",
        },
      ],
    });

    const [blocked] = await checkTrustedPublisherPlans([createPlan()], client);
    const [replacement] = await checkTrustedPublisherPlans([createPlan()], client, {
      replace: true,
    });

    expect(blocked?.action).toBe("blocked");
    expect(blocked?.reasons).toContain(
      "existing trusted publisher differs; rerun with --replace to revoke and recreate",
    );
    expect(replacement?.action).toBe("replace");
  });

  it("creates missing trusted publishers for high-confidence plans", async () => {
    const client = createClient();
    const [result] = await applyTrustedPublisherPlans([createPlan()], client, { delayMs: 0 });

    expect(result?.status).toBe("created");
    expect(client.calls).toEqual([
      "packageExists:@scope/a",
      "listTrust:@scope/a",
      "create:@scope/a",
    ]);
  });

  it("revokes differing publishers before recreating with --replace", async () => {
    const client = createClient({
      trusts: [
        {
          ...matchingTrust(),
          id: "trust-old",
          repository: "owner/other",
        },
      ],
    });

    const [result] = await applyTrustedPublisherPlans([createPlan()], client, {
      delayMs: 0,
      replace: true,
    });

    expect(result?.status).toBe("replaced");
    expect(client.calls).toEqual([
      "packageExists:@scope/a",
      "listTrust:@scope/a",
      "revoke:@scope/a:trust-old",
      "create:@scope/a",
    ]);
  });

  it("skips non-high-confidence plans without npm registry calls", async () => {
    const client = createClient();
    const [result] = await applyTrustedPublisherPlans(
      [
        createPlan({
          confidence: "medium",
          reasons: ["workflow is missing permissions.id-token: write"],
        }),
      ],
      client,
      { delayMs: 0 },
    );

    expect(result?.status).toBe("skipped");
    expect(result?.checkedPlan.action).toBe("skip");
    expect(result?.checkedPlan.reasons).toContain(
      "plan confidence is medium; only high-confidence plans can be applied",
    );
    expect(client.calls).toEqual([]);
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

function matchingTrust(): ExistingTrust {
  return {
    allowPublish: true,
    allowStagePublish: false,
    file: "release.yml",
    id: "trust-1",
    provider: "github",
    raw: {},
    repository: "owner/repo",
  };
}
