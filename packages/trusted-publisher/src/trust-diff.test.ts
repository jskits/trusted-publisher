import type { TrustedPublisherPlan } from "./planning.js";
import { compareTrustToPlan, formatTrustFieldDiff } from "./trust-diff.js";

describe("trusted publisher diff", () => {
  it("compares existing trusted publisher fields against the suggested plan", () => {
    const diff = compareTrustToPlan(
      {
        allowPublish: true,
        allowStagePublish: false,
        file: "publish.yml",
        id: "trust-1",
        provider: "github",
        raw: {},
        repository: "owner/old",
      },
      createPlan(),
    );

    expect(diff.fields).toEqual([
      {
        current: "owner/old",
        field: "repository",
        suggested: "owner/repo",
      },
      {
        current: "publish.yml",
        field: "file",
        suggested: "release.yml",
      },
    ]);
    expect(formatTrustFieldDiff(diff.fields[0]!)).toBe("repository: owner/old -> owner/repo");
  });

  it("uses explicit unset markers for missing environment values", () => {
    const diff = compareTrustToPlan(
      {
        allowPublish: true,
        allowStagePublish: false,
        environment: "npm",
        file: "release.yml",
        provider: "github",
        raw: {},
        repository: "owner/repo",
      },
      createPlan(),
    );

    expect(diff.fields).toEqual([
      {
        current: "npm",
        field: "environment",
        suggested: "<unset>",
      },
    ]);
  });
});

function createPlan(): TrustedPublisherPlan {
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
    workflowFile: "release.yml",
  };
}
