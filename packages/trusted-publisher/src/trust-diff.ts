import type { ExistingTrust } from "./npm.js";
import type { TrustedPublisherPlan } from "./planning.js";

export type TrustDiffField =
  | "allowPublish"
  | "allowStagePublish"
  | "environment"
  | "file"
  | "provider"
  | "repository";

export interface TrustFieldDiff {
  readonly current: string;
  readonly field: TrustDiffField;
  readonly suggested: string;
}

export interface TrustConfigurationDiff {
  readonly fields: readonly TrustFieldDiff[];
  readonly trust: ExistingTrust;
}

export function compareTrustToPlan(
  trust: ExistingTrust,
  plan: TrustedPublisherPlan,
): TrustConfigurationDiff {
  const fields: TrustFieldDiff[] = [];

  compareField(fields, "provider", trust.provider ?? "github", "github");
  compareField(fields, "repository", trust.repository, plan.repository);
  compareField(fields, "file", trust.file, plan.workflowFile);
  compareField(fields, "environment", trust.environment, plan.environment);
  compareField(fields, "allowPublish", trust.allowPublish, plan.permissions.allowPublish);
  compareField(
    fields,
    "allowStagePublish",
    trust.allowStagePublish,
    plan.permissions.allowStagePublish,
  );

  return { fields, trust };
}

export function formatTrustFieldDiff(diff: TrustFieldDiff): string {
  return `${diff.field}: ${diff.current} -> ${diff.suggested}`;
}

function compareField(
  fields: TrustFieldDiff[],
  field: TrustDiffField,
  current: boolean | string | undefined,
  suggested: boolean | string | undefined,
): void {
  const normalizedCurrent = normalizeValue(current);
  const normalizedSuggested = normalizeValue(suggested);

  if (normalizedCurrent !== normalizedSuggested) {
    fields.push({
      current: normalizedCurrent,
      field,
      suggested: normalizedSuggested,
    });
  }
}

function normalizeValue(value: boolean | string | undefined): string {
  if (value === undefined || value === "") {
    return "<unset>";
  }

  return String(value);
}
