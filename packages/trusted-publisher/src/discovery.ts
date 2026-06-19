import { discoverRepository, type RepositoryInfo } from "./git.js";
import { discoverPackages, type PackageInfo } from "./packages.js";
import { discoverGitHubWorkflows, type WorkflowInfo } from "./workflows.js";

export interface WorkspaceDiscovery {
  readonly packages: readonly PackageInfo[];
  readonly repository: RepositoryInfo;
  readonly workflows: readonly WorkflowInfo[];
}

export function discoverWorkspace(startDir: string = process.cwd()): WorkspaceDiscovery {
  const repository = discoverRepository(startDir);

  return {
    packages: discoverPackages(repository.rootDir),
    repository,
    workflows: discoverGitHubWorkflows(repository.rootDir),
  };
}
