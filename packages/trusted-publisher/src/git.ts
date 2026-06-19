import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface RepositoryInfo {
  readonly rootDir: string;
  readonly remoteUrl?: string;
  readonly githubRepository?: string;
}

export function findRepoRoot(startDir: string = process.cwd()): string {
  let directory = resolve(startDir);

  while (true) {
    if (existsSync(`${directory}/.git`)) {
      return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return resolve(startDir);
    }

    directory = parent;
  }
}

export function discoverRepository(startDir: string = process.cwd()): RepositoryInfo {
  const rootDir = findRepoRoot(startDir);
  const remoteUrl = readOriginRemoteUrl(rootDir);
  const githubRepository = remoteUrl ? parseGitHubRepository(remoteUrl) : undefined;
  const info: { rootDir: string; remoteUrl?: string; githubRepository?: string } = { rootDir };

  if (remoteUrl) {
    info.remoteUrl = remoteUrl;
  }

  if (githubRepository) {
    info.githubRepository = githubRepository;
  }

  return compactRepositoryInfo(info);
}

export function parseGitHubRepository(remoteUrl: string): string | undefined {
  const normalized = remoteUrl
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");

  const shorthand = /^github:([^/\s]+)\/([^/\s]+)$/.exec(normalized);
  if (shorthand) {
    return `${shorthand[1]}/${shorthand[2]}`;
  }

  const scpLike = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/.exec(normalized);
  if (scpLike) {
    return `${scpLike[1]}/${scpLike[2]}`;
  }

  try {
    const url = new URL(normalized);
    if (url.hostname !== "github.com") {
      return undefined;
    }

    const [owner, repo] = url.pathname.replace(/^\/+/, "").split("/");
    if (!owner || !repo) {
      return undefined;
    }

    return `${owner}/${repo}`;
  } catch {
    return undefined;
  }
}

function readOriginRemoteUrl(rootDir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", rootDir, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return readOriginRemoteUrlFromConfig(rootDir);
  }
}

function readOriginRemoteUrlFromConfig(rootDir: string): string | undefined {
  const configPath = `${rootDir}/.git/config`;
  if (!existsSync(configPath)) {
    return undefined;
  }

  const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
  let inOrigin = false;

  for (const line of lines) {
    const section = /^\s*\[(.+)]\s*$/.exec(line);
    if (section) {
      inOrigin = section[1] === 'remote "origin"';
      continue;
    }

    if (!inOrigin) {
      continue;
    }

    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url) {
      return url[1];
    }
  }

  return undefined;
}

function compactRepositoryInfo(info: {
  readonly rootDir: string;
  readonly remoteUrl?: string;
  readonly githubRepository?: string;
}): RepositoryInfo {
  const result: { rootDir: string; remoteUrl?: string; githubRepository?: string } = {
    rootDir: info.rootDir,
  };

  if (info.remoteUrl) {
    result.remoteUrl = info.remoteUrl;
  }

  if (info.githubRepository) {
    result.githubRepository = info.githubRepository;
  }

  return result;
}
