import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { discoverSourceWorkspace, parseGitHubSource } from "./source.js";

describe("GitHub source discovery", () => {
  it.each([
    ["https://github.com/owner/repo", "owner/repo"],
    ["https://github.com/owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo/tree/main", "owner/repo"],
    ["github:owner/repo", "owner/repo"],
    ["owner/repo", "owner/repo"],
    ["owner/repo.git", "owner/repo"],
  ])("parses %s", (source, expected) => {
    expect(parseGitHubSource(source)).toBe(expected);
  });

  it("rejects unsupported sources", () => {
    expect(() => parseGitHubSource("https://gitlab.com/owner/repo")).toThrow(
      "Unsupported GitHub source",
    );
  });

  it("clones into a temporary directory and discovers the cloned workspace", async () => {
    let clonedTargetDir = "";

    const sourceDiscovery = await discoverSourceWorkspace("https://github.com/owner/repo", {
      async clone(_repository, targetDir) {
        clonedTargetDir = targetDir;
        createFixtureWorkspace(targetDir);
      },
    });

    expect(sourceDiscovery.repository).toBe("owner/repo");
    expect(sourceDiscovery.discovery.repository.githubRepository).toBe("owner/repo");
    expect(sourceDiscovery.discovery.packages.map((pkg) => pkg.name)).toEqual(["@scope/a"]);
    expect(sourceDiscovery.discovery.workflows[0]?.fileName).toBe("release.yml");
    expect(existsSync(clonedTargetDir)).toBe(true);

    sourceDiscovery.cleanup();
    expect(existsSync(clonedTargetDir)).toBe(false);
  });
});

function createFixtureWorkspace(rootDir: string): void {
  mkdirSync(join(rootDir, ".git"), { recursive: true });
  mkdirSync(join(rootDir, ".github", "workflows"), { recursive: true });

  writeFileSync(
    join(rootDir, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/owner/repo.git\n',
  );
  writeFileSync(
    join(rootDir, "package.json"),
    JSON.stringify({ name: "@scope/a", version: "1.0.0" }),
  );
  writeFileSync(
    join(rootDir, ".github", "workflows", "release.yml"),
    [
      "name: Release",
      "permissions:",
      "  id-token: write",
      "jobs:",
      "  release:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm publish",
    ].join("\n"),
  );
}
