import { parseTrustList, trustMatchesPlan } from "./npm.js";
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
});

function createPlan(
  permissions: Partial<TrustedPublisherPlan["permissions"]> = {},
): TrustedPublisherPlan {
  return {
    confidence: "high",
    environment: "npm",
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
}
