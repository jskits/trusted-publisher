import type { WorkspaceDiscovery } from "./discovery.js";
import type { PackageInfo } from "./packages.js";

export function normalizeNpmScope(value: string): string {
  const trimmed = value.trim();
  const scope = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;

  if (!/^@[^/\s]+$/.test(scope)) {
    throw new Error(`Invalid npm scope: ${value}`);
  }

  return scope;
}

export function createScopePackages(
  packageNames: readonly string[],
  scope: string,
  rootDir: string,
): PackageInfo[] {
  return packageNames
    .filter((packageName) => packageName.startsWith(`${scope}/`))
    .toSorted((left, right) => left.localeCompare(right))
    .map((packageName) => ({
      directory: rootDir,
      name: packageName,
      private: false,
      publishable: true,
      relativePath: `npm:${packageName}`,
      skipReasons: [],
    }));
}

export function withScopePackages(
  discovery: WorkspaceDiscovery,
  packageNames: readonly string[],
  scope: string,
): WorkspaceDiscovery {
  return {
    ...discovery,
    packages: createScopePackages(packageNames, scope, discovery.repository.rootDir),
  };
}
