import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverGitHubWorkflows } from "./workflows.js";

describe("GitHub workflow analysis", () => {
  it("collects evidence-backed publish candidates for common release tools", () => {
    const rootDir = createWorkflowFixture({
      "release.yml": [
        "name: Release",
        "permissions:",
        "  contents: read",
        "  id-token: write",
        "jobs:",
        "  release:",
        "    runs-on: ubuntu-latest",
        "    environment: npm",
        "    steps:",
        "      - uses: actions/checkout@v6",
        "      - uses: changesets/action@v1",
        "        with:",
        "          publish: changeset publish",
        "      - run: pnpm -r publish --access public",
        "      - run: yarn workspaces foreach npm publish",
        "      - run: npx semantic-release",
        "      - run: lerna publish from-package",
        "      - run: nx release publish",
      ].join("\n"),
    });

    const [workflow] = discoverGitHubWorkflows(rootDir);

    expect(workflow?.signals).toMatchObject({
      changesetsAction: true,
      hasIdTokenWrite: true,
      lernaPublish: true,
      nxReleasePublish: true,
      packageManagerPublish: true,
      semanticRelease: true,
    });
    expect(workflow?.signals.environments).toEqual(["npm"]);
    expect(workflow?.candidates.map((candidate) => candidate.tool)).toEqual([
      "changesets",
      "pnpm",
      "yarn",
      "semantic-release",
      "lerna",
      "nx",
    ]);
    expect(workflow?.evidence.map((item) => item.code)).toContain("workflow.publish.pnpm");
  });

  it("maps matrix working directories to package path selectors", () => {
    const rootDir = createWorkflowFixture({
      "publish.yml": [
        "name: Publish",
        "jobs:",
        "  publish:",
        "    runs-on: ubuntu-latest",
        "    permissions:",
        "      id-token: write",
        "    strategy:",
        "      matrix:",
        "        package:",
        "          - packages/a",
        "          - packages/b",
        "    steps:",
        "      - run: npm publish",
        "        working-directory: ${{ matrix.package }}",
      ].join("\n"),
    });

    const [workflow] = discoverGitHubWorkflows(rootDir);

    expect(workflow?.candidates.map((candidate) => candidate.packageSelector)).toEqual([
      { kind: "path", value: "packages/a" },
      { kind: "path", value: "packages/b" },
    ]);
    expect(workflow?.candidates.every((candidate) => candidate.hasIdTokenWrite)).toBe(true);
  });

  it("expands package manager scripts before inferring publish selectors", () => {
    const rootDir = createWorkflowFixture({
      "publish.yml": [
        "name: Publish",
        "jobs:",
        "  publish:",
        "    runs-on: ubuntu-latest",
        "    permissions:",
        "      id-token: write",
        "    steps:",
        "      - run: pnpm run publish -- --provenance",
      ].join("\n"),
    });
    writeFileSync(
      join(rootDir, "package.json"),
      JSON.stringify({
        scripts: {
          publish: "pnpm -r --filter './packages/*' publish --access=public",
        },
      }),
    );

    const [workflow] = discoverGitHubWorkflows(rootDir);

    expect(workflow?.candidates).toHaveLength(1);
    expect(workflow?.candidates[0]).toMatchObject({
      command: "pnpm -r --filter './packages/*' publish --access=public",
      packageSelector: { kind: "all" },
      tool: "pnpm",
    });
  });

  it("does not treat a non-publishing package script as a publish candidate", () => {
    const rootDir = createWorkflowFixture({
      "publish.yml": [
        "name: Publish",
        "jobs:",
        "  publish:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: pnpm run publish",
      ].join("\n"),
    });
    writeFileSync(
      join(rootDir, "package.json"),
      JSON.stringify({ scripts: { publish: "echo release is disabled" } }),
    );

    const [workflow] = discoverGitHubWorkflows(rootDir);

    expect(workflow?.candidates).toEqual([]);
  });

  it("detects local and external reusable workflow references", () => {
    const rootDir = createWorkflowFixture({
      "delegate.yml": [
        "name: Delegate",
        "jobs:",
        "  local:",
        "    uses: ./.github/workflows/npm-publish.yml",
        "  external:",
        "    uses: owner/repo/.github/workflows/publish.yml@main",
      ].join("\n"),
    });

    const [workflow] = discoverGitHubWorkflows(rootDir);

    expect(workflow?.signals.reusableWorkflow).toBe(true);
    expect(workflow?.candidates.map((candidate) => candidate.reusableWorkflow)).toEqual([
      ".github/workflows/npm-publish.yml",
      "owner/repo/.github/workflows/publish.yml@main",
    ]);
    expect(workflow?.candidates.map((candidate) => candidate.packageSelector.kind)).toEqual([
      "unknown",
      "unknown",
    ]);
  });

  it("does not treat version-only changesets/action usage as publishing", () => {
    const rootDir = createWorkflowFixture({
      "version.yml": [
        "name: Version",
        "jobs:",
        "  version:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: changesets/action@v1",
        "        with:",
        "          version: pnpm run version-packages",
      ].join("\n"),
    });

    const [workflow] = discoverGitHubWorkflows(rootDir);

    expect(workflow?.signals.changesetsAction).toBe(false);
    expect(workflow?.candidates).toEqual([]);
  });

  it("detects npm publish inside local node scripts", () => {
    const rootDir = createWorkflowFixture({
      "publish.yml": [
        "name: Publish",
        "permissions:",
        "  id-token: write",
        "jobs:",
        "  publish:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: pnpm run publish:packages",
      ].join("\n"),
    });
    mkdirSync(join(rootDir, "scripts"), { recursive: true });
    writeFileSync(
      join(rootDir, "package.json"),
      JSON.stringify({
        scripts: {
          "publish:packages": "node scripts/publish-packages.mjs",
        },
      }),
    );
    writeFileSync(
      join(rootDir, "scripts", "publish-packages.mjs"),
      'await run("npm", ["publish", tarball, "--access", "public"]);\n',
    );

    const [workflow] = discoverGitHubWorkflows(rootDir);

    expect(workflow?.signals.npmPublish).toBe(true);
    expect(workflow?.candidates[0]).toMatchObject({
      command: "npm publish (via node scripts/publish-packages.mjs)",
      packageSelector: { kind: "unknown" },
      tool: "npm",
    });
  });
});

function createWorkflowFixture(workflows: Record<string, string>): string {
  const rootDir = mkdtempSync(join(tmpdir(), "trusted-publisher-workflows-"));
  const workflowsDir = join(rootDir, ".github", "workflows");
  mkdirSync(workflowsDir, { recursive: true });

  for (const [fileName, source] of Object.entries(workflows)) {
    writeFileSync(join(workflowsDir, fileName), source);
  }

  return rootDir;
}
