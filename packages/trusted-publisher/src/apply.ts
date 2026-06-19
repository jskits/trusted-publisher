import type { ExistingTrust, NpmClient } from "./npm.js";
import { trustMatchesPlan } from "./npm.js";
import type { TrustedPublisherPlan } from "./planning.js";

export type CheckedPlanAction = "blocked" | "create" | "replace" | "skip";
export type ApplyStatus = "blocked" | "created" | "dry-run" | "failed" | "replaced" | "skipped";

export interface CheckOptions {
  readonly replace?: boolean;
}

export interface ApplyOptions extends CheckOptions {
  readonly delayMs?: number;
  readonly dryRun?: boolean;
}

export interface CheckedPlan {
  readonly action: CheckedPlanAction;
  readonly existingTrusts: readonly ExistingTrust[];
  readonly matchingTrust?: ExistingTrust;
  readonly packageExists: boolean;
  readonly plan: TrustedPublisherPlan;
  readonly reasons: readonly string[];
}

export interface ApplyResult {
  readonly checkedPlan: CheckedPlan;
  readonly error?: string;
  readonly status: ApplyStatus;
}

export async function checkTrustedPublisherPlans(
  plans: readonly TrustedPublisherPlan[],
  client: NpmClient,
  options: CheckOptions = {},
): Promise<CheckedPlan[]> {
  return Promise.all(plans.map((plan) => checkTrustedPublisherPlan(plan, client, options)));
}

export async function applyTrustedPublisherPlans(
  plans: readonly TrustedPublisherPlan[],
  client: NpmClient,
  options: ApplyOptions = {},
): Promise<ApplyResult[]> {
  const checkedPlans = await checkTrustedPublisherPlans(plans, client, options);
  return applyCheckedTrustedPublisherPlans(checkedPlans, client, options);
}

export async function applyCheckedTrustedPublisherPlans(
  checkedPlans: readonly CheckedPlan[],
  client: NpmClient,
  options: ApplyOptions = {},
): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  const delayMs = options.delayMs ?? 2000;
  let alreadyMutated = false;

  for (const checkedPlan of checkedPlans) {
    if (alreadyMutated && willMutate(checkedPlan, options) && delayMs > 0) {
      // eslint-disable-next-line no-await-in-loop -- npm recommends throttling trust mutations.
      await delay(delayMs);
    }

    // eslint-disable-next-line no-await-in-loop -- npm trust changes must be applied serially.
    const result = await applyCheckedPlanSafely(checkedPlan, client, options);
    results.push(result);

    if (result.status === "created" || result.status === "failed" || result.status === "replaced") {
      alreadyMutated = true;
    }
  }

  return results;
}

async function applyCheckedPlanSafely(
  checkedPlan: CheckedPlan,
  client: NpmClient,
  options: ApplyOptions,
): Promise<ApplyResult> {
  try {
    return await applyCheckedPlan(checkedPlan, client, options);
  } catch (error) {
    return {
      checkedPlan,
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    };
  }
}

async function checkTrustedPublisherPlan(
  plan: TrustedPublisherPlan,
  client: NpmClient,
  options: CheckOptions,
): Promise<CheckedPlan> {
  const reasons = [...plan.reasons];
  const packageName = plan.package.name;

  if (plan.confidence !== "high") {
    reasons.push(
      `plan confidence is ${plan.confidence}; only high-confidence plans can be applied`,
    );
    return makeCheckedPlan(plan, false, [], undefined, "skip", reasons);
  }

  if (!packageName) {
    reasons.push("package name is required");
    return makeCheckedPlan(plan, false, [], undefined, "blocked", reasons);
  }

  if (!plan.trustArgs) {
    reasons.push("npm trust command could not be rendered");
    return makeCheckedPlan(plan, false, [], undefined, "blocked", reasons);
  }

  const packageExists = await client.packageExists(packageName);
  if (!packageExists) {
    reasons.push("package does not exist on npm");
    return makeCheckedPlan(plan, false, [], undefined, "blocked", reasons);
  }

  const existingTrusts = await client.listTrust(packageName);
  const matchingTrust = existingTrusts.find((trust) => trustMatchesPlan(trust, plan));

  if (matchingTrust) {
    return makeCheckedPlan(plan, true, existingTrusts, matchingTrust, "skip", [
      ...reasons,
      "trusted publisher already configured",
    ]);
  }

  if (existingTrusts.length === 0) {
    return makeCheckedPlan(plan, true, existingTrusts, undefined, "create", reasons);
  }

  if (!options.replace) {
    return makeCheckedPlan(plan, true, existingTrusts, undefined, "blocked", [
      ...reasons,
      "existing trusted publisher differs; rerun with --replace to revoke and recreate",
    ]);
  }

  if (existingTrusts.some((trust) => !trust.id)) {
    return makeCheckedPlan(plan, true, existingTrusts, undefined, "blocked", [
      ...reasons,
      "existing trusted publisher id is missing",
    ]);
  }

  return makeCheckedPlan(plan, true, existingTrusts, undefined, "replace", reasons);
}

async function applyCheckedPlan(
  checkedPlan: CheckedPlan,
  client: NpmClient,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const packageName = checkedPlan.plan.package.name;

  if (checkedPlan.plan.confidence !== "high") {
    return { checkedPlan, status: "skipped" };
  }

  if (checkedPlan.action === "blocked") {
    return { checkedPlan, status: "blocked" };
  }

  if (checkedPlan.action === "skip") {
    return { checkedPlan, status: "skipped" };
  }

  if (options.dryRun) {
    return { checkedPlan, status: "dry-run" };
  }

  if (!packageName) {
    return { checkedPlan, status: "blocked" };
  }

  if (checkedPlan.action === "replace") {
    for (const trust of checkedPlan.existingTrusts) {
      if (!trust.id) {
        return { checkedPlan, status: "blocked" };
      }
      // eslint-disable-next-line no-await-in-loop -- revokes for one package should stay ordered.
      await client.revokeTrust(packageName, trust.id);
    }
    await client.createTrust(checkedPlan.plan);
    return { checkedPlan, status: "replaced" };
  }

  await client.createTrust(checkedPlan.plan);
  return { checkedPlan, status: "created" };
}

function willMutate(checkedPlan: CheckedPlan, options: ApplyOptions): boolean {
  return (
    !options.dryRun &&
    checkedPlan.plan.confidence === "high" &&
    (checkedPlan.action === "create" || checkedPlan.action === "replace")
  );
}

function makeCheckedPlan(
  plan: TrustedPublisherPlan,
  packageExists: boolean,
  existingTrusts: readonly ExistingTrust[],
  matchingTrust: ExistingTrust | undefined,
  action: CheckedPlanAction,
  reasons: readonly string[],
): CheckedPlan {
  const result: {
    action: CheckedPlanAction;
    existingTrusts: readonly ExistingTrust[];
    matchingTrust?: ExistingTrust;
    packageExists: boolean;
    plan: TrustedPublisherPlan;
    reasons: readonly string[];
  } = {
    action,
    existingTrusts,
    packageExists,
    plan,
    reasons,
  };

  if (matchingTrust) {
    result.matchingTrust = matchingTrust;
  }

  return result;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
