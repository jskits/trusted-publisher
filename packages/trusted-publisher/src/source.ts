import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { discoverWorkspace, type WorkspaceDiscovery } from "./discovery.js";
import { parseGitHubRepository } from "./git.js";

const execFileAsync = promisify(execFile);

export interface SourceDiscovery {
  readonly cleanup: () => void;
  readonly discovery: WorkspaceDiscovery;
  readonly repository: string;
  readonly source: string;
}

export interface SourceDiscoveryOptions {
  readonly clone?: (repository: string, targetDir: string) => Promise<void>;
}

export async function discoverSourceWorkspace(
  source: string,
  options: SourceDiscoveryOptions = {},
): Promise<SourceDiscovery> {
  const repository = parseGitHubSource(source);
  const tempDir = mkdtempSync(join(tmpdir(), "trusted-publisher-source-"));
  const targetDir = join(tempDir, "repo");

  try {
    await (options.clone ?? cloneGitHubRepository)(repository, targetDir);
    return {
      cleanup: () => rmSync(tempDir, { force: true, recursive: true }),
      discovery: discoverWorkspace(targetDir),
      repository,
      source,
    };
  } catch (error) {
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }
}

export function parseGitHubSource(source: string): string {
  const normalized = source.trim();
  if (!normalized) {
    throw new Error("GitHub source is required.");
  }

  const parsedRepository = parseGitHubRepository(normalized);
  const directRepository = /^[^/\s]+\/[^/\s]+$/.test(normalized)
    ? normalized.replace(/\.git$/, "")
    : undefined;
  const repository = parsedRepository ?? directRepository;
  if (!repository) {
    throw new Error(`Unsupported GitHub source: ${source}`);
  }

  return repository;
}

async function cloneGitHubRepository(repository: string, targetDir: string): Promise<void> {
  await execFileAsync(
    "git",
    ["clone", "--depth=1", "--filter=blob:none", `https://github.com/${repository}.git`, targetDir],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
    },
  );
}
