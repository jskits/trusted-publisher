import type { WorkspaceDiscovery } from "./discovery.js";
import type { PackageInfo } from "./packages.js";
import { resolvePublishTopology } from "./topology.js";
import type { PackageSelector, PublishCandidate } from "./workflows.js";

describe("publish topology resolver", () => {
  it("classifies one workflow publishing every package as global", () => {
    const topology = resolvePublishTopology(
      createDiscovery([
        candidate({ packageSelector: { kind: "all" }, workflowFile: "release.yml" }),
      ]),
    );

    expect(topology.kind).toBe("global");
    expect(topology.globalCandidates).toHaveLength(1);
    expect(topology.mappings.map((mapping) => mapping.status)).toEqual(["matched", "matched"]);
  });

  it("classifies package-specific candidates as per-package", () => {
    const topology = resolvePublishTopology(
      createDiscovery([
        candidate({
          packageSelector: { kind: "path", value: "packages/a" },
          workflowFile: "a.yml",
        }),
        candidate({
          packageSelector: { kind: "name", value: "@scope/b" },
          workflowFile: "b.yml",
        }),
      ]),
    );

    expect(topology.kind).toBe("per-package");
    expect(topology.mappings.map((mapping) => mapping.selectedCandidate?.workflowFile)).toEqual([
      "a.yml",
      "b.yml",
    ]);
  });

  it("detects conflicts when multiple candidates publish the same package", () => {
    const topology = resolvePublishTopology(
      createDiscovery([
        candidate({ packageSelector: { kind: "all" }, workflowFile: "release.yml" }),
        candidate({
          packageSelector: { kind: "path", value: "packages/a" },
          workflowFile: "a.yml",
        }),
      ]),
    );

    expect(topology.kind).toBe("conflict");
    expect(topology.conflicts.map((mapping) => mapping.package.name)).toEqual(["@scope/a"]);
    expect(topology.mappings.map((mapping) => mapping.status)).toEqual(["ambiguous", "matched"]);
  });

  it("keeps unknown reusable workflow candidates out of package mappings", () => {
    const topology = resolvePublishTopology(
      createDiscovery([
        candidate({
          packageSelector: { kind: "unknown" },
          tool: "reusable-workflow",
          workflowFile: "delegate.yml",
        }),
      ]),
    );

    expect(topology.kind).toBe("unknown");
    expect(topology.unknownCandidates).toHaveLength(1);
    expect(topology.mappings.map((mapping) => mapping.status)).toEqual(["unmatched", "unmatched"]);
  });

  it("matches pnpm filters with package names", () => {
    const topology = resolvePublishTopology(
      createDiscovery([
        candidate({
          packageSelector: { kind: "filter", value: "@scope/*" },
          workflowFile: "release.yml",
        }),
      ]),
    );

    expect(topology.kind).toBe("global");
    expect(topology.mappings.map((mapping) => mapping.status)).toEqual(["matched", "matched"]);
  });
});

function createDiscovery(candidates: readonly PublishCandidate[]): WorkspaceDiscovery {
  return {
    packages: [pkg("@scope/a", "packages/a"), pkg("@scope/b", "packages/b")],
    repository: {
      githubRepository: "owner/repo",
      remoteUrl: "git@github.com:owner/repo.git",
      rootDir: "/repo",
    },
    workflows: [
      {
        candidates,
        evidence: [],
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
          reusableWorkflow: false,
          semanticRelease: false,
        },
      },
    ],
  };
}

function pkg(name: string, relativePath: string): PackageInfo {
  return {
    directory: `/repo/${relativePath}`,
    name,
    private: false,
    publishable: true,
    relativePath,
    skipReasons: [],
    version: "1.0.0",
  };
}

function candidate(options: {
  readonly packageSelector: PackageSelector;
  readonly tool?: PublishCandidate["tool"];
  readonly workflowFile: string;
}): PublishCandidate {
  return {
    evidence: [],
    hasIdTokenWrite: true,
    jobId: "publish",
    kind: options.tool === "reusable-workflow" ? "reusable" : "direct",
    packageSelector: options.packageSelector,
    permissionsSource: "workflow",
    tool: options.tool ?? "npm",
    workflowFile: options.workflowFile,
  };
}
