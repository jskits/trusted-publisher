import type { WorkspaceDiscovery } from "./discovery.js";
import { generateMigrationReport } from "./migration-report.js";
import type { TrustedPublisherPlan } from "./planning.js";

describe("migration report", () => {
  it("renders package plans, commands, and explanations", () => {
    const report = generateMigrationReport({
      discovery: createDiscovery(),
      plans: [createPlan()],
    });

    expect(report).toContain("# trusted-publisher Migration Report");
    expect(report).toContain("| @scope/a | high | 95 | release.yml | configure |");
    expect(report).toContain("npm trust github");
    expect(report).toContain("candidate directly runs a publish command");
  });
});

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
    workflows: [],
  };
}

function createPlan(): TrustedPublisherPlan {
  return {
    command:
      'npm trust github "@scope/a" --repo "owner/repo" --file "release.yml" --allow-publish --yes',
    confidence: "high",
    evidence: [],
    explain: ["candidate directly runs a publish command"],
    package: createDiscovery().packages[0]!,
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
