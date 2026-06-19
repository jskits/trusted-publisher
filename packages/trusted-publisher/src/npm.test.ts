import { parseSearchPackageNames, parseTrustList, trustMatchesPlan } from "./npm.js";
import type { TrustedPublisherPlan } from "./planning.js";

describe("npm trusted publisher parsing", () => {
  it("normalizes array output and matches a planned GitHub publisher", () => {
    const trusts = parseTrustList(
      JSON.stringify([
        {
          actions: ["publish", "stage-publish"],
          environment: "npm",
          file: "release.yml",
          id: "trust-1",
          provider: "github",
          repository: "owner/repo",
        },
      ]),
    );

    expect(trusts).toHaveLength(1);
    expect(trusts[0]).toMatchObject({
      allowPublish: true,
      allowStagePublish: true,
      environment: "npm",
      file: "release.yml",
      id: "trust-1",
      provider: "github",
      repository: "owner/repo",
    });
    expect(trustMatchesPlan(trusts[0]!, createPlan({ allowStagePublish: true }))).toBe(true);
  });

  it("normalizes wrapped output with claims", () => {
    const trusts = parseTrustList(
      JSON.stringify({
        trustedPublishers: [
          {
            allow_publish: true,
            claims: {
              repository: "owner/repo",
              workflow: "release.yml",
            },
            trust_id: "trust-1",
            type: "github",
          },
        ],
      }),
    );

    expect(trusts[0]).toMatchObject({
      allowPublish: true,
      allowStagePublish: false,
      file: "release.yml",
      id: "trust-1",
      provider: "github",
      repository: "owner/repo",
    });
  });

  it("normalizes npm 11 singleton output and trust permission names", () => {
    const trusts = parseTrustList(
      JSON.stringify({
        file: "release.yml",
        id: "trust-1",
        permissions: ["createPackage", "createStagedPackage"],
        repository: "owner/repo",
        type: "github",
      }),
    );

    expect(trusts).toHaveLength(1);
    expect(trusts[0]).toMatchObject({
      allowPublish: true,
      allowStagePublish: true,
      file: "release.yml",
      id: "trust-1",
      provider: "github",
      repository: "owner/repo",
    });
    expect(trustMatchesPlan(trusts[0]!, createPlan({ allowStagePublish: true }, false))).toBe(true);
  });

  it("normalizes npm search results for scoped packages", () => {
    expect(
      parseSearchPackageNames(
        JSON.stringify([
          { name: "@scope/b" },
          { package: { name: "@scope/a" } },
          { package: { name: "@other/c" } },
          { name: "@scope/a" },
        ]),
        "@scope",
      ),
    ).toEqual(["@scope/a", "@scope/b"]);
  });
});

function createPlan(
  permissions: Partial<TrustedPublisherPlan["permissions"]> = {},
  includeEnvironment = true,
): TrustedPublisherPlan {
  const plan: TrustedPublisherPlan = {
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
      ...permissions,
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
  };

  return includeEnvironment ? { ...plan, environment: "npm" } : plan;
}
