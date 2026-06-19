import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";

import { asObject, asStringArray, type JsonObject } from "./json.js";

export interface PackageInfo {
  readonly directory: string;
  readonly name?: string;
  readonly private: boolean;
  readonly publishable: boolean;
  readonly registry?: string;
  readonly relativePath: string;
  readonly skipReasons: readonly string[];
  readonly version?: string;
}

interface NpmRegistryConfig {
  readonly defaultRegistry?: string;
  readonly scopedRegistries: ReadonlyMap<string, string>;
}

const ignoredDirectories = new Set([".git", ".turbo", "coverage", "dist", "node_modules"]);

export function discoverPackages(rootDir: string): PackageInfo[] {
  const registryConfig = readNpmRegistryConfig(rootDir);
  const packageDirs = listPackageDirectories(rootDir);
  const workspacePatterns = readWorkspacePatterns(rootDir);
  const includedDirs = packageDirs.filter((directory) =>
    matchesWorkspacePatterns(rootDir, directory, workspacePatterns),
  );

  return includedDirs.map((directory) => readPackageInfo(rootDir, directory, registryConfig));
}

export function readWorkspacePatterns(rootDir: string): string[] {
  const patterns = new Set<string>(["."]);
  const rootManifest = readJsonFile(`${rootDir}/package.json`);
  const rootObject = asObject(rootManifest);
  const workspaces = rootObject?.workspaces;

  if (Array.isArray(workspaces)) {
    for (const pattern of asStringArray(workspaces)) {
      patterns.add(pattern);
    }
  } else {
    const workspaceObject = asObject(workspaces);
    for (const pattern of asStringArray(workspaceObject?.packages)) {
      patterns.add(pattern);
    }
  }

  const pnpmWorkspace = readYamlFile(`${rootDir}/pnpm-workspace.yaml`);
  for (const pattern of asStringArray(asObject(pnpmWorkspace)?.packages)) {
    patterns.add(pattern);
  }

  const lernaConfig = readJsonFile(`${rootDir}/lerna.json`);
  for (const pattern of asStringArray(asObject(lernaConfig)?.packages)) {
    patterns.add(pattern);
  }

  if (existsSync(`${rootDir}/nx.json`) || existsSync(`${rootDir}/turbo.json`)) {
    patterns.add("apps/*");
    patterns.add("libs/*");
    patterns.add("packages/*");
  }

  return [...patterns];
}

function readPackageInfo(
  rootDir: string,
  directory: string,
  registryConfig: NpmRegistryConfig,
): PackageInfo {
  const manifest = asObject(readJsonFile(`${directory}/package.json`)) ?? {};
  const name = typeof manifest.name === "string" ? manifest.name : undefined;
  const version = typeof manifest.version === "string" ? manifest.version : undefined;
  const isPrivate = manifest.private === true;
  const registry = resolvePackageRegistry(manifest, name, registryConfig);
  const skipReasons = collectSkipReasons(manifest, name, isPrivate, registry);
  const relativePath = toPosixRelative(rootDir, directory);
  const result: {
    directory: string;
    name?: string;
    private: boolean;
    publishable: boolean;
    registry?: string;
    relativePath: string;
    skipReasons: string[];
    version?: string;
  } = {
    directory,
    private: isPrivate,
    publishable: skipReasons.length === 0,
    relativePath,
    skipReasons,
  };

  if (name) {
    result.name = name;
  }

  if (version) {
    result.version = version;
  }

  if (registry) {
    result.registry = registry;
  }

  return result;
}

function collectSkipReasons(
  manifest: JsonObject,
  name: string | undefined,
  isPrivate: boolean,
  registry: string | undefined,
): string[] {
  const skipReasons: string[] = [];

  if (!name) {
    skipReasons.push("missing package name");
  }

  if (isPrivate) {
    skipReasons.push("private package");
  }

  if (registry && !isNpmRegistry(registry)) {
    skipReasons.push(`non-npm registry: ${registry}`);
  }

  const publishConfig = asObject(manifest.publishConfig);
  if (publishConfig?.access === "restricted") {
    skipReasons.push("restricted publishConfig access");
  }

  return skipReasons;
}

function resolvePackageRegistry(
  manifest: JsonObject,
  packageName: string | undefined,
  registryConfig: NpmRegistryConfig,
): string | undefined {
  const publishConfigRegistry = asObject(manifest.publishConfig)?.registry;
  if (typeof publishConfigRegistry === "string") {
    return publishConfigRegistry;
  }

  const scope = packageName?.startsWith("@") ? packageName.split("/")[0] : undefined;
  if (scope) {
    return registryConfig.scopedRegistries.get(scope) ?? registryConfig.defaultRegistry;
  }

  return registryConfig.defaultRegistry;
}

function isNpmRegistry(registry: string): boolean {
  try {
    const url = new URL(registry);
    return url.hostname === "registry.npmjs.org";
  } catch {
    return registry === "https://registry.npmjs.org" || registry === "https://registry.npmjs.org/";
  }
}

function readNpmRegistryConfig(rootDir: string): NpmRegistryConfig {
  const npmrcPath = `${rootDir}/.npmrc`;
  const scopedRegistries = new Map<string, string>();
  let defaultRegistry: string | undefined;

  if (!existsSync(npmrcPath)) {
    return { scopedRegistries };
  }

  for (const rawLine of readFileSync(npmrcPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const [key, ...rest] = line.split("=");
    const value = rest.join("=").trim();
    const trimmedKey = key?.trim();

    if (!trimmedKey || !value) {
      continue;
    }

    if (trimmedKey === "registry") {
      defaultRegistry = value;
      continue;
    }

    const scopedRegistry = /^(@[^:]+):registry$/.exec(trimmedKey);
    if (scopedRegistry?.[1]) {
      scopedRegistries.set(scopedRegistry[1], value);
    }
  }

  const result: { defaultRegistry?: string; scopedRegistries: ReadonlyMap<string, string> } = {
    scopedRegistries,
  };

  if (defaultRegistry) {
    result.defaultRegistry = defaultRegistry;
  }

  return result;
}

function matchesWorkspacePatterns(
  rootDir: string,
  directory: string,
  patterns: readonly string[],
): boolean {
  const relativeDirectory = toPosixRelative(rootDir, directory);
  const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negative = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));

  return (
    positive.some((pattern) => matchesGlob(relativeDirectory, normalizePattern(pattern))) &&
    !negative.some((pattern) => matchesGlob(relativeDirectory, normalizePattern(pattern)))
  );
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\/package\.json$/, "").replace(/\/+$/, "") || ".";
}

function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === ".") {
    return value === ".";
  }

  return globToRegExp(pattern).test(value);
}

function globToRegExp(pattern: string): RegExp {
  let expression = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];

    if (character === "*" && next === "*") {
      expression += ".*";
      index += 1;
      continue;
    }

    if (character === "*") {
      expression += "[^/]*";
      continue;
    }

    expression += escapeRegExp(character ?? "");
  }

  return new RegExp(`^${expression}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function listPackageDirectories(rootDir: string): string[] {
  const result: string[] = [];

  visitDirectory(rootDir, (directory) => {
    if (existsSync(`${directory}/package.json`)) {
      result.push(directory);
    }
  });

  return result.toSorted((left, right) =>
    toPosixRelative(rootDir, left).localeCompare(toPosixRelative(rootDir, right)),
  );
}

function visitDirectory(directory: string, onDirectory: (directory: string) => void): void {
  onDirectory(directory);

  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) {
      continue;
    }

    const child = resolve(directory, entry);
    if (statSync(child).isDirectory()) {
      visitDirectory(child, onDirectory);
    }
  }
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }

  return JSON.parse(readFileSync(path, "utf8"));
}

function readYamlFile(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }

  return parseYaml(readFileSync(path, "utf8"));
}

function toPosixRelative(rootDir: string, directory: string): string {
  const relativeDirectory = relative(rootDir, directory);
  return relativeDirectory ? relativeDirectory.split(sep).join("/") : ".";
}
