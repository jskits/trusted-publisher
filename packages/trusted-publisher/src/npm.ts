import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { TrustedPublisherPlan, TrustPermissions } from "./planning.js";

const execFileAsync = promisify(execFile);

export interface NpmClient {
  readonly claimPackage: (packageName: string, options?: NpmPackageClaimOptions) => Promise<void>;
  readonly createTrust: (plan: TrustedPublisherPlan) => Promise<void>;
  readonly getVersion: () => Promise<string>;
  readonly listScopePackages: (
    scope: string,
    options?: NpmScopePackageOptions,
  ) => Promise<string[]>;
  readonly listTrust: (packageName: string) => Promise<ExistingTrust[]>;
  readonly packageExists: (packageName: string) => Promise<boolean>;
  readonly revokeTrust: (packageName: string, trustId: string) => Promise<void>;
}

export interface NpmPackageClaimOptions {
  readonly tag?: string;
  readonly version?: string;
}

export interface NpmScopePackageOptions {
  readonly limit?: number;
}

export interface ExistingTrust {
  readonly allowPublish?: boolean;
  readonly allowStagePublish?: boolean;
  readonly environment?: string;
  readonly file?: string;
  readonly id?: string;
  readonly provider?: string;
  readonly raw: unknown;
  readonly repository?: string;
}

export interface NpmClientOptions {
  readonly interactiveAuth?: boolean;
  readonly registry?: string;
}

interface CommandError extends Error {
  readonly code?: number | string;
  readonly stderr?: string;
  readonly stdout?: string;
}

export function createNpmCliClient(options: NpmClientOptions = {}): NpmClient {
  return {
    async claimPackage(packageName, claimOptions = {}) {
      const placeholderDir = createPlaceholderPackageDirectory(
        packageName,
        claimOptions.version ?? "0.0.0",
      );

      try {
        await runNpm([
          "publish",
          placeholderDir,
          "--access",
          "public",
          "--tag",
          claimOptions.tag ?? "trusted-publisher-claim",
          "--ignore-scripts",
          ...registryArgs(options.registry),
        ]);
      } finally {
        rmSync(placeholderDir, { force: true, recursive: true });
      }
    },

    async createTrust(plan) {
      if (!plan.trustArgs) {
        throw new Error(
          `No npm trust command was planned for ${plan.package.name ?? plan.package.relativePath}`,
        );
      }

      const packageName = plan.package.name ?? plan.package.relativePath;
      await runTrustCommand(
        [...plan.trustArgs.slice(1), ...registryArgs(options.registry)],
        packageName,
        options,
      );
    },

    async getVersion() {
      const { stdout } = await runNpm(["--version"]);
      return stdout.trim();
    },

    async listScopePackages(scope, scopeOptions = {}) {
      const limit = scopeOptions.limit ?? 250;
      const { stdout } = await runNpm([
        "search",
        `scope:${scope}`,
        "--json",
        "--searchlimit",
        String(limit),
        ...registryArgs(options.registry),
      ]);
      return parseSearchPackageNames(stdout, scope);
    },

    async listTrust(packageName) {
      const args = ["trust", "list", packageName, "--json", ...registryArgs(options.registry)];
      const { stdout } = await runTrustCommand(args, packageName, options);

      return parseTrustList(stdout);
    },

    async packageExists(packageName) {
      try {
        await runNpm(["view", packageName, "version", "--json", ...registryArgs(options.registry)]);
        return true;
      } catch (error) {
        if (isNotFoundError(error)) {
          return false;
        }
        throw error;
      }
    },

    async revokeTrust(packageName, trustId) {
      await runTrustCommand(
        ["trust", "revoke", packageName, "--id", trustId, ...registryArgs(options.registry)],
        packageName,
        options,
      );
    },
  };
}

export function parseSearchPackageNames(stdout: string, scope?: string): string[] {
  if (!stdout.trim()) {
    return [];
  }

  const names = extractSearchItems(JSON.parse(stdout))
    .map(readSearchPackageName)
    .filter((name): name is string => Boolean(name));
  const filteredNames = scope ? names.filter((name) => name.startsWith(`${scope}/`)) : names;

  return [...new Set(filteredNames)].toSorted((left, right) => left.localeCompare(right));
}

export function parseTrustList(stdout: string): ExistingTrust[] {
  if (!stdout.trim()) {
    return [];
  }

  return normalizeTrustList(JSON.parse(stdout));
}

export function trustMatchesPlan(trust: ExistingTrust, plan: TrustedPublisherPlan): boolean {
  if (trust.provider && trust.provider.toLowerCase() !== "github") {
    return false;
  }

  return (
    trust.repository === plan.repository &&
    trust.file === plan.workflowFile &&
    normalizeEnvironment(trust.environment) === normalizeEnvironment(plan.environment) &&
    permissionsMatch(trust, plan.permissions)
  );
}

function permissionsMatch(trust: ExistingTrust, permissions: TrustPermissions): boolean {
  return (
    Boolean(trust.allowPublish) === permissions.allowPublish &&
    Boolean(trust.allowStagePublish) === permissions.allowStagePublish
  );
}

function normalizeTrustList(value: unknown): ExistingTrust[] {
  return extractTrustItems(value).map(normalizeTrustItem);
}

function extractSearchItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isRecord(value)) {
    return [];
  }

  const objects = value.objects;
  return Array.isArray(objects) ? objects : [];
}

function readSearchPackageName(value: unknown): string | undefined {
  const record = isRecord(value) ? value : {};
  const packageRecord = isRecord(record.package) ? record.package : {};

  return readString(record.name ?? packageRecord.name);
}

function extractTrustItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isRecord(value)) {
    return [];
  }

  for (const key of ["trustedPublishers", "trusted_publishers", "trust", "publishers", "items"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return isTrustItem(value) ? [value] : [];
}

function isTrustItem(value: Record<string, unknown>): boolean {
  return [
    "id",
    "trustId",
    "trust_id",
    "type",
    "provider",
    "publisher",
    "file",
    "workflow",
    "repository",
    "repo",
    "permissions",
  ].some((key) => key in value);
}

function normalizeTrustItem(value: unknown): ExistingTrust {
  const record = isRecord(value) ? value : {};
  const claims = isRecord(record.claims) ? record.claims : {};
  const allowedActions = readStringArray(
    record.allowedActions ?? record.allowed_actions ?? record.actions ?? record.permissions,
  );
  const allowPublish =
    readBoolean(record.allowPublish ?? record.allow_publish) ??
    (allowedActions.includes("publish") || allowedActions.includes("createPackage"));
  const allowStagePublish =
    readBoolean(record.allowStagePublish ?? record.allow_stage_publish) ??
    (allowedActions.includes("stage-publish") ||
      allowedActions.includes("stage") ||
      allowedActions.includes("createStagedPackage"));

  return compactExistingTrust({
    allowPublish,
    allowStagePublish,
    environment: readString(record.environment ?? record.env ?? claims.environment),
    file: readString(
      record.file ??
        record.workflow ??
        record.workflowFile ??
        record.workflow_filename ??
        claims.workflow,
    ),
    id: readString(record.id ?? record.trustId ?? record.trust_id),
    provider: readString(record.provider ?? record.type ?? record.publisher),
    raw: value,
    repository: readString(
      record.repository ?? record.repo ?? record.project ?? claims.repository ?? claims.repo,
    ),
  });
}

function compactExistingTrust(trust: {
  readonly allowPublish: boolean | undefined;
  readonly allowStagePublish: boolean | undefined;
  readonly environment: string | undefined;
  readonly file: string | undefined;
  readonly id: string | undefined;
  readonly provider: string | undefined;
  readonly raw: unknown;
  readonly repository: string | undefined;
}): ExistingTrust {
  const result: {
    allowPublish?: boolean;
    allowStagePublish?: boolean;
    environment?: string;
    file?: string;
    id?: string;
    provider?: string;
    raw: unknown;
    repository?: string;
  } = { raw: trust.raw };

  if (trust.allowPublish !== undefined) {
    result.allowPublish = trust.allowPublish;
  }
  if (trust.allowStagePublish !== undefined) {
    result.allowStagePublish = trust.allowStagePublish;
  }
  if (trust.environment) {
    result.environment = trust.environment;
  }
  if (trust.file) {
    result.file = trust.file;
  }
  if (trust.id) {
    result.id = trust.id;
  }
  if (trust.provider) {
    result.provider = trust.provider;
  }
  if (trust.repository) {
    result.repository = trust.repository;
  }

  return result;
}

async function runNpm(args: readonly string[]): Promise<{ stdout: string }> {
  return execFileAsync("npm", [...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });
}

async function runTrustCommand(
  args: readonly string[],
  packageName: string,
  options: NpmClientOptions,
): Promise<{ stdout: string }> {
  try {
    return await runNpm(args);
  } catch (error) {
    if (!isWebOtpError(error)) {
      throw error;
    }
  }

  if (options.interactiveAuth === false || !hasInteractiveTerminal()) {
    throw trustAuthenticationError(packageName);
  }

  process.stderr.write(
    "\nnpm trust requires browser authentication. " +
      'Complete it in the browser and select "skip two-factor authentication for the next 5 minutes".\n\n',
  );
  await runNpmInteractively(["trust", "list", packageName, ...registryArgs(options.registry)]);

  try {
    return await runNpm(args);
  } catch (error) {
    if (isWebOtpError(error)) {
      throw trustAuthenticationError(packageName, true);
    }
    throw error;
  }
}

function runNpmInteractively(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", [...args], { stdio: "inherit" });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`Interactive npm trust authentication failed with ${status}.`));
    });
  });
}

function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function isWebOtpError(error: unknown): boolean {
  const commandError = error as CommandError;
  const output = [commandError.message, commandError.stderr, commandError.stdout]
    .filter((value): value is string => typeof value === "string")
    .join("\n");

  return (
    output.includes("EOTP") && output.includes("Open this URL in your browser to authenticate")
  );
}

function trustAuthenticationError(packageName: string, retried = false): Error {
  const retryDetail = retried
    ? " The follow-up registry request was not covered by the five-minute authentication window."
    : "";

  return new Error(
    `npm trust requires interactive browser authentication for ${packageName}.${retryDetail} ` +
      `Run \`npm trust list ${packageName}\` in an interactive terminal, select the five-minute ` +
      "two-factor authentication skip option, then rerun trusted-publisher.",
  );
}

function registryArgs(registry: string | undefined): string[] {
  return registry ? ["--registry", registry] : [];
}

function isNotFoundError(error: unknown): boolean {
  const commandError = error as CommandError;
  return (
    String(commandError.stderr ?? "").includes("E404") ||
    String(commandError.stdout ?? "").includes("E404") ||
    commandError.code === "E404"
  );
}

function normalizeEnvironment(value: string | undefined): string {
  return value ?? "";
}

function createPlaceholderPackageDirectory(packageName: string, version: string): string {
  const directory = mkdtempSync(join(tmpdir(), "trusted-publisher-claim-"));
  const manifest = {
    description: "Placeholder package claimed before configuring npm trusted publishing.",
    files: ["README.md"],
    name: packageName,
    private: false,
    version,
  };

  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(directory, "README.md"),
    `# ${packageName}\n\nThis placeholder package was published to claim the npm package name before configuring trusted publishing.\n`,
  );

  return directory;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
