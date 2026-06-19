import type { NpmClient } from "./npm.js";
import type { PackageInfo } from "./packages.js";
import type { TrustedPublisherPlan } from "./planning.js";

export type PackageClaimAction = "blocked" | "claim" | "skip";
export type PackageClaimStatus = "blocked" | "claimed" | "dry-run" | "failed" | "skipped";

export interface PackageClaimOptions {
  readonly delayMs?: number;
  readonly dryRun?: boolean;
  readonly tag?: string;
  readonly version?: string;
}

export interface PackageClaimPlan {
  readonly action: PackageClaimAction;
  readonly command: string;
  readonly package: PackageInfo;
  readonly packageExists?: boolean;
  readonly packageName?: string;
  readonly reasons: readonly string[];
  readonly tag: string;
  readonly version: string;
}

export interface PackageClaimResult {
  readonly claimPlan: PackageClaimPlan;
  readonly error?: string;
  readonly status: PackageClaimStatus;
}

const defaultClaimTag = "trusted-publisher-claim";
const defaultClaimVersion = "0.0.0";

export async function checkPackageClaimPlans(
  plans: readonly TrustedPublisherPlan[],
  client: NpmClient,
  options: PackageClaimOptions = {},
): Promise<PackageClaimPlan[]> {
  const uniquePlans = uniquePackagePlans(plans);
  return Promise.all(uniquePlans.map((plan) => checkPackageClaimPlan(plan, client, options)));
}

export async function applyPackageClaimPlans(
  claimPlans: readonly PackageClaimPlan[],
  client: NpmClient,
  options: PackageClaimOptions = {},
): Promise<PackageClaimResult[]> {
  const results: PackageClaimResult[] = [];
  const delayMs = options.delayMs ?? 2000;
  let alreadyMutated = false;

  for (const claimPlan of claimPlans) {
    if (alreadyMutated && willApplyPackageClaim(claimPlan) && !options.dryRun && delayMs > 0) {
      // eslint-disable-next-line no-await-in-loop -- npm publishes should stay throttled.
      await delay(delayMs);
    }

    // eslint-disable-next-line no-await-in-loop -- npm publishes must be applied serially.
    const result = await applyPackageClaimPlanSafely(claimPlan, client, options);
    results.push(result);

    if (result.status === "claimed" || result.status === "failed") {
      alreadyMutated = true;
    }
  }

  return results;
}

export function willApplyPackageClaim(claimPlan: PackageClaimPlan): boolean {
  return claimPlan.action === "claim";
}

function uniquePackagePlans(plans: readonly TrustedPublisherPlan[]): TrustedPublisherPlan[] {
  const seen = new Set<string>();
  const uniquePlans: TrustedPublisherPlan[] = [];

  for (const plan of plans) {
    const key = plan.package.name ?? plan.package.relativePath;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniquePlans.push(plan);
  }

  return uniquePlans;
}

async function checkPackageClaimPlan(
  plan: TrustedPublisherPlan,
  client: NpmClient,
  options: PackageClaimOptions,
): Promise<PackageClaimPlan> {
  const tag = options.tag ?? defaultClaimTag;
  const version = options.version ?? defaultClaimVersion;
  const packageName = plan.package.name;
  const reasons: string[] = [];

  if (plan.confidence !== "high") {
    reasons.push(
      `plan confidence is ${plan.confidence}; only high-confidence packages can be claimed`,
    );
    return makePackageClaimPlan(plan.package, tag, version, "skip", reasons);
  }

  if (!packageName) {
    reasons.push("package name is required");
    return makePackageClaimPlan(plan.package, tag, version, "blocked", reasons);
  }

  if (!plan.package.publishable) {
    reasons.push(...plan.package.skipReasons);
    return makePackageClaimPlan(plan.package, tag, version, "blocked", reasons, false, packageName);
  }

  const packageExists = await client.packageExists(packageName);
  if (packageExists) {
    reasons.push("package already exists on npm");
    return makePackageClaimPlan(plan.package, tag, version, "skip", reasons, true, packageName);
  }

  reasons.push("package does not currently exist on npm");
  return makePackageClaimPlan(plan.package, tag, version, "claim", reasons, false, packageName);
}

async function applyPackageClaimPlanSafely(
  claimPlan: PackageClaimPlan,
  client: NpmClient,
  options: PackageClaimOptions,
): Promise<PackageClaimResult> {
  try {
    return await applyPackageClaimPlan(claimPlan, client, options);
  } catch (error) {
    return {
      claimPlan,
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    };
  }
}

async function applyPackageClaimPlan(
  claimPlan: PackageClaimPlan,
  client: NpmClient,
  options: PackageClaimOptions,
): Promise<PackageClaimResult> {
  if (claimPlan.action === "blocked") {
    return { claimPlan, status: "blocked" };
  }

  if (claimPlan.action === "skip") {
    return { claimPlan, status: "skipped" };
  }

  if (options.dryRun) {
    return { claimPlan, status: "dry-run" };
  }

  if (!claimPlan.packageName) {
    return { claimPlan, status: "blocked" };
  }

  await client.claimPackage(claimPlan.packageName, {
    tag: claimPlan.tag,
    version: claimPlan.version,
  });

  return { claimPlan, status: "claimed" };
}

function makePackageClaimPlan(
  packageInfo: PackageInfo,
  tag: string,
  version: string,
  action: PackageClaimAction,
  reasons: readonly string[],
  packageExists?: boolean,
  packageName?: string,
): PackageClaimPlan {
  const result: {
    action: PackageClaimAction;
    command: string;
    package: PackageInfo;
    packageExists?: boolean;
    packageName?: string;
    reasons: readonly string[];
    tag: string;
    version: string;
  } = {
    action,
    command: renderNpmClaimCommand(tag),
    package: packageInfo,
    reasons,
    tag,
    version,
  };

  if (packageExists !== undefined) {
    result.packageExists = packageExists;
  }
  if (packageName) {
    result.packageName = packageName;
  }

  return result;
}

function renderNpmClaimCommand(tag: string): string {
  return `npm publish <temporary-placeholder-dir> --access public --tag ${tag}`;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
