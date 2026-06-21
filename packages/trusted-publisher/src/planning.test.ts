import type { WorkspaceDiscovery } from "./discovery.js";
import { buildTrustedPublisherPlans, renderNpmTrustCommand } from "./planning.js";

const publishablePackage = {
  directory: "/repo/packages/a",
  name: "@scope/a",
  private: false,
  publishable: true,
  relativePath: "packages/a",
  skipReasons: [],
  version: "1.0.0",
};

const privatePackage = {
  directory: "/repo/packages/private",
  name: "@scope/private",
  private: true,
  publishable: false,
  relativePath: "packages/private",
  skipReasons: ["private package"],
};

const releaseWorkflow = {
  candidates: [],
  evidence: [],
  fileName: "release.yml",
  path: "/repo/.github/workflows/release.yml",
  relativePath: ".github/workflows/release.yml",
  signals: {
    changesetsAction: false,
    environments: ["npm"],
    hasIdTokenWrite: true,
    lernaPublish: false,
    npmPublish: true,
    npmStagePublish: false,
    nxReleasePublish: false,
    packageManagerPublish: false,
    reusableWorkflow: false,
    semanticRelease: false,
  },
};

describe("trusted publisher planning", () => {
  it("builds a high-confidence npm trust command for a direct GitHub publish workflow", () => {
    const plans = buildTrustedPublisherPlans({
      packages: [publishablePackage],
      repository: {
        githubRepository: "jskits/loggerjs",
        remoteUrl: "git@github.com:jskits/loggerjs.git",
        rootDir: "/repo",
      },
      workflows: [releaseWorkflow],
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      command:
        'npm trust github "@scope/a" --repo "jskits/loggerjs" --file "release.yml" --env npm --allow-publish --allow-stage-publish --yes',
      confidence: "high",
      environment: "npm",
      permissions: {
        allowPublish: true,
        allowStagePublish: true,
      },
      repository: "jskits/loggerjs",
      score: 95,
      workflowFile: "release.yml",
    });
    expect(plans[0]?.explain).toContain(
      "workflow-level fallback detected a direct publish command",
    );
  });

  it("marks skipped packages as low confidence", () => {
    const plans = buildTrustedPublisherPlans(createDiscovery([privatePackage]));

    expect(plans[0]?.confidence).toBe("low");
    expect(plans[0]?.reasons).toContain("private package");
  });

  it("supports explicit stage-only permissions", () => {
    const plans = buildTrustedPublisherPlans(createDiscovery([publishablePackage]), {
      permissionMode: "stage",
    });

    expect(plans[0]?.permissions).toEqual({
      allowPublish: false,
      allowStagePublish: true,
    });
    expect(plans[0]?.command).toContain("--allow-stage-publish");
  });

  it("supports explicit publish-only permissions", () => {
    const plans = buildTrustedPublisherPlans(createDiscovery([publishablePackage]), {
      permissionMode: "publish",
    });

    expect(plans[0]?.permissions).toEqual({
      allowPublish: true,
      allowStagePublish: false,
    });
    expect(plans[0]?.command).toContain("--allow-publish");
    expect(plans[0]?.command).not.toContain("--allow-stage-publish");
  });

  it("marks ambiguous publishing workflows as low confidence", () => {
    const plans = buildTrustedPublisherPlans({
      ...createDiscovery([publishablePackage]),
      workflows: [
        releaseWorkflow,
        {
          ...releaseWorkflow,
          fileName: "publish.yml",
          path: "/repo/.github/workflows/publish.yml",
          relativePath: ".github/workflows/publish.yml",
        },
      ],
    });

    expect(plans[0]?.confidence).toBe("low");
    expect(plans[0]?.reasons).toContain("multiple direct publishing workflows detected");
    expect(plans[0]?.command).toBeUndefined();
  });

  it("falls back to the workflow when direct publish candidates have unknown package targets", () => {
    const plans = buildTrustedPublisherPlans({
      ...createDiscovery([publishablePackage]),
      workflows: [
        {
          ...releaseWorkflow,
          candidates: [
            {
              evidence: [],
              hasIdTokenWrite: true,
              jobId: "publish",
              kind: "direct",
              packageSelector: { kind: "unknown" },
              permissionsSource: "workflow",
              tool: "npm",
              workflowFile: "release.yml",
            },
          ],
        },
      ],
    });

    expect(plans[0]).toMatchObject({
      confidence: "high",
      score: 95,
      workflowFile: "release.yml",
    });
    expect(plans[0]?.reasons).toEqual([]);
    expect(plans[0]?.publishCandidate).toBeUndefined();
  });

  it("renders shell-safe commands", () => {
    expect(
      renderNpmTrustCommand([
        "npm",
        "trust",
        "github",
        "@scope/pkg",
        "--repo",
        "owner/repo",
        "--file",
        "release.yml",
      ]),
    ).toBe('npm trust github "@scope/pkg" --repo "owner/repo" --file "release.yml"');
  });
});

function createDiscovery(packages: WorkspaceDiscovery["packages"]): WorkspaceDiscovery {
  return {
    packages,
    repository: {
      githubRepository: "jskits/loggerjs",
      remoteUrl: "git@github.com:jskits/loggerjs.git",
      rootDir: "/repo",
    },
    workflows: [releaseWorkflow],
  };
}
