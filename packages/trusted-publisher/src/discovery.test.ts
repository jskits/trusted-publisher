import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverWorkspace, parseGitHubRepository } from "./index.js";

describe("GitHub repository parsing", () => {
  it.each([
    ["git@github.com:jskits/loggerjs.git", "jskits/loggerjs"],
    ["https://github.com/jskits/loggerjs.git", "jskits/loggerjs"],
    ["git+https://github.com/jskits/loggerjs.git", "jskits/loggerjs"],
    ["github:jskits/loggerjs", "jskits/loggerjs"],
    ["ssh://git@github.com/jskits/loggerjs.git", "jskits/loggerjs"],
  ])("parses %s", (remoteUrl, expected) => {
    expect(parseGitHubRepository(remoteUrl)).toBe(expected);
  });

  it("ignores non-GitHub remotes", () => {
    expect(parseGitHubRepository("https://gitlab.com/jskits/loggerjs.git")).toBeUndefined();
  });
});

describe("workspace discovery", () => {
  it("discovers publishable packages, skipped packages, repository, and workflows", () => {
    const rootDir = createFixtureWorkspace();

    const discovery = discoverWorkspace(rootDir);

    expect(discovery.repository.githubRepository).toBe("jskits/trusted-publisher");
    expect(discovery.packages.map((pkg) => [pkg.name, pkg.relativePath, pkg.publishable])).toEqual([
      ["trusted-publisher-root", ".", false],
      ["@scope/a", "packages/a", true],
      ["@scope/custom", "packages/custom-registry", false],
      ["@scope/private", "packages/private", false],
    ]);
    expect(discovery.workflows).toHaveLength(2);
    expect(discovery.workflows[0]?.signals).toMatchObject({
      changesetsAction: false,
      hasIdTokenWrite: true,
      npmPublish: true,
    });
    expect(discovery.workflows[0]?.signals.environments).toEqual(["npm"]);
  });
});

function createFixtureWorkspace(): string {
  const rootDir = mkdtempSync(join(tmpdir(), "trusted-publisher-"));
  mkdirSync(join(rootDir, ".git"));
  mkdirSync(join(rootDir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(rootDir, "packages", "a"), { recursive: true });
  mkdirSync(join(rootDir, "packages", "private"), { recursive: true });
  mkdirSync(join(rootDir, "packages", "custom-registry"), { recursive: true });

  writeFileSync(
    join(rootDir, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:jskits/trusted-publisher.git\n',
  );
  writeFileSync(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "trusted-publisher-root",
      private: true,
      workspaces: ["packages/*"],
    }),
  );
  writeFileSync(
    join(rootDir, "packages", "a", "package.json"),
    JSON.stringify({ name: "@scope/a", version: "1.0.0" }),
  );
  writeFileSync(
    join(rootDir, "packages", "private", "package.json"),
    JSON.stringify({ name: "@scope/private", private: true }),
  );
  writeFileSync(
    join(rootDir, "packages", "custom-registry", "package.json"),
    JSON.stringify({
      name: "@scope/custom",
      publishConfig: { registry: "https://registry.example.test" },
    }),
  );
  writeFileSync(
    join(rootDir, ".github", "workflows", "release.yml"),
    [
      "name: Release",
      "permissions:",
      "  contents: write",
      "  id-token: write",
      "jobs:",
      "  release:",
      "    runs-on: ubuntu-latest",
      "    environment: npm",
      "    steps:",
      "      - uses: actions/checkout@v6",
      "      - uses: changesets/action@v1",
      "        with:",
      "          publish: npm publish",
      "      - run: npm publish --dry-run",
    ].join("\n"),
  );
  writeFileSync(
    join(rootDir, ".github", "workflows", "test.yaml"),
    ["name: Test", "jobs:", "  test:", "    steps:", "      - run: npm test"].join("\n"),
  );

  return rootDir;
}
