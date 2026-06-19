import type { WorkspaceDiscovery } from "./discovery.js";
import { normalizeNpmScope, withScopePackages } from "./scope.js";

describe("npm scope package discovery", () => {
  it("normalizes npm scope names", () => {
    expect(normalizeNpmScope("scope")).toBe("@scope");
    expect(normalizeNpmScope("@scope")).toBe("@scope");
    expect(() => normalizeNpmScope("@scope/pkg")).toThrow("Invalid npm scope");
  });

  it("replaces local packages with npm scope packages", () => {
    const discovery = withScopePackages(
      createDiscovery(),
      ["@scope/b", "@other/c", "@scope/a"],
      "@scope",
    );

    expect(discovery.packages.map((pkg) => [pkg.name, pkg.relativePath, pkg.publishable])).toEqual([
      ["@scope/a", "npm:@scope/a", true],
      ["@scope/b", "npm:@scope/b", true],
    ]);
  });
});

function createDiscovery(): WorkspaceDiscovery {
  return {
    packages: [
      {
        directory: "/repo/packages/local",
        name: "@scope/local",
        private: false,
        publishable: true,
        relativePath: "packages/local",
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
