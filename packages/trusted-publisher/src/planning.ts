import { basename } from "node:path";

import type { WorkspaceDiscovery } from "./discovery.js";
import type { PackageInfo } from "./packages.js";
import type { WorkflowInfo, WorkflowSignals } from "./workflows.js";

export type Confidence = "high" | "medium" | "low";
export type PermissionMode = "both" | "infer" | "publish" | "stage";

export interface PlanningOptions {
  readonly permissionMode?: PermissionMode;
  readonly repository?: string;
  readonly workflowFile?: string;
}

export interface TrustedPublisherPlan {
  readonly command?: string;
  readonly confidence: Confidence;
  readonly environment?: string;
  readonly package: PackageInfo;
  readonly permissions: TrustPermissions;
  readonly reasons: readonly string[];
  readonly repository?: string;
  readonly trustArgs?: readonly string[];
  readonly workflow?: WorkflowInfo;
  readonly workflowFile?: string;
}

export interface TrustPermissions {
  readonly allowPublish: boolean;
  readonly allowStagePublish: boolean;
}

interface WorkflowSelection {
  readonly reasons: readonly string[];
  readonly workflow?: WorkflowInfo;
}

export function buildTrustedPublisherPlans(
  discovery: WorkspaceDiscovery,
  options: PlanningOptions = {},
): TrustedPublisherPlan[] {
  const repository = options.repository ?? discovery.repository.githubRepository;
  const workflowSelection = selectWorkflow(discovery.workflows, options.workflowFile);

  return discovery.packages.map((pkg) =>
    buildPackagePlan(pkg, repository, workflowSelection, options.permissionMode ?? "infer"),
  );
}

export function renderNpmTrustCommand(args: readonly string[]): string {
  return args.map((arg, index) => (index === 0 ? arg : quoteForDisplay(arg))).join(" ");
}

function buildPackagePlan(
  pkg: PackageInfo,
  repository: string | undefined,
  workflowSelection: WorkflowSelection,
  permissionMode: PermissionMode,
): TrustedPublisherPlan {
  const reasons: string[] = [];
  const workflow = workflowSelection.workflow;

  reasons.push(...pkg.skipReasons);
  reasons.push(...workflowSelection.reasons);

  if (!repository) {
    reasons.push("GitHub repository not detected");
  }

  const workflowFile = workflow?.fileName;
  if (!workflowFile) {
    reasons.push("publishing workflow not detected");
  }

  if (workflow && !workflow.signals.hasIdTokenWrite) {
    reasons.push("workflow is missing permissions.id-token: write");
  }

  const environment = inferEnvironment(workflow, reasons);
  const permissions = inferPermissions(workflow?.signals, permissionMode);

  if (!permissions.allowPublish && !permissions.allowStagePublish) {
    reasons.push("no trusted publishing action could be inferred");
  }

  const trustArgs =
    pkg.name &&
    pkg.publishable &&
    repository &&
    workflowFile &&
    (permissions.allowPublish || permissions.allowStagePublish)
      ? buildNpmTrustArgs(pkg.name, repository, workflowFile, environment, permissions)
      : undefined;
  const command = trustArgs ? renderNpmTrustCommand(trustArgs) : undefined;
  const confidence = determineConfidence(
    pkg,
    workflow,
    workflowSelection,
    repository,
    permissions,
    reasons,
  );

  return compactPlan({
    command,
    confidence,
    environment,
    package: pkg,
    permissions,
    reasons,
    repository,
    trustArgs,
    workflow,
    workflowFile,
  });
}

function selectWorkflow(
  workflows: readonly WorkflowInfo[],
  requestedWorkflowFile: string | undefined,
): WorkflowSelection {
  if (requestedWorkflowFile) {
    const fileName = basename(requestedWorkflowFile);
    const workflow = workflows.find((candidate) => candidate.fileName === fileName);
    if (workflow) {
      return { reasons: [], workflow };
    }
    return { reasons: [`workflow ${fileName} was not found`] };
  }

  const publishingWorkflows = workflows.filter((workflow) => hasPublishingSignal(workflow.signals));
  const directPublishWorkflows = publishingWorkflows.filter(
    (workflow) =>
      workflow.signals.npmPublish ||
      workflow.signals.npmStagePublish ||
      workflow.signals.packageManagerPublish,
  );

  if (directPublishWorkflows.length === 1 && directPublishWorkflows[0]) {
    return { reasons: [], workflow: directPublishWorkflows[0] };
  }

  if (directPublishWorkflows.length > 1) {
    return { reasons: ["multiple direct publishing workflows detected"] };
  }

  if (publishingWorkflows.length === 1 && publishingWorkflows[0]) {
    return {
      reasons: ["publishing workflow uses an indirect release tool"],
      workflow: publishingWorkflows[0],
    };
  }

  if (publishingWorkflows.length > 1) {
    return { reasons: ["multiple indirect publishing workflows detected"] };
  }

  return { reasons: [] };
}

function hasPublishingSignal(signals: WorkflowSignals): boolean {
  return (
    signals.npmPublish ||
    signals.npmStagePublish ||
    signals.packageManagerPublish ||
    signals.changesetsAction ||
    signals.semanticRelease ||
    signals.lernaPublish ||
    signals.nxReleasePublish
  );
}

function inferPermissions(
  signals: WorkflowSignals | undefined,
  permissionMode: PermissionMode,
): TrustPermissions {
  if (permissionMode === "both") {
    return { allowPublish: true, allowStagePublish: true };
  }

  if (permissionMode === "publish") {
    return { allowPublish: true, allowStagePublish: false };
  }

  if (permissionMode === "stage") {
    return { allowPublish: false, allowStagePublish: true };
  }

  if (!signals) {
    return { allowPublish: false, allowStagePublish: false };
  }

  const allowStagePublish = signals.npmStagePublish;
  const allowPublish =
    signals.npmPublish ||
    signals.packageManagerPublish ||
    signals.changesetsAction ||
    signals.semanticRelease ||
    signals.lernaPublish ||
    signals.nxReleasePublish;

  return { allowPublish, allowStagePublish };
}

function inferEnvironment(
  workflow: WorkflowInfo | undefined,
  reasons: string[],
): string | undefined {
  if (!workflow) {
    return undefined;
  }

  if (workflow.signals.environments.length > 1) {
    reasons.push("multiple workflow environments detected");
    return undefined;
  }

  return workflow.signals.environments[0];
}

function buildNpmTrustArgs(
  packageName: string,
  repository: string,
  workflowFile: string,
  environment: string | undefined,
  permissions: TrustPermissions,
): string[] {
  const args = [
    "npm",
    "trust",
    "github",
    packageName,
    "--repo",
    repository,
    "--file",
    workflowFile,
  ];

  if (environment) {
    args.push("--env", environment);
  }

  if (permissions.allowPublish) {
    args.push("--allow-publish");
  }

  if (permissions.allowStagePublish) {
    args.push("--allow-stage-publish");
  }

  args.push("--yes");
  return args;
}

function determineConfidence(
  pkg: PackageInfo,
  workflow: WorkflowInfo | undefined,
  workflowSelection: WorkflowSelection,
  repository: string | undefined,
  permissions: TrustPermissions,
  reasons: readonly string[],
): Confidence {
  if (
    !pkg.publishable ||
    !pkg.name ||
    !repository ||
    !workflow ||
    workflowSelection.reasons.some((reason) => reason.startsWith("multiple")) ||
    (!permissions.allowPublish && !permissions.allowStagePublish)
  ) {
    return "low";
  }

  if (
    reasons.length > 0 ||
    !workflow.signals.hasIdTokenWrite ||
    !isDirectPublishingWorkflow(workflow.signals)
  ) {
    return "medium";
  }

  return "high";
}

function isDirectPublishingWorkflow(signals: WorkflowSignals): boolean {
  return signals.npmPublish || signals.npmStagePublish || signals.packageManagerPublish;
}

function compactPlan(plan: {
  readonly command: string | undefined;
  readonly confidence: Confidence;
  readonly environment: string | undefined;
  readonly package: PackageInfo;
  readonly permissions: TrustPermissions;
  readonly reasons: readonly string[];
  readonly repository: string | undefined;
  readonly trustArgs: readonly string[] | undefined;
  readonly workflow: WorkflowInfo | undefined;
  readonly workflowFile: string | undefined;
}): TrustedPublisherPlan {
  const result: {
    command?: string;
    confidence: Confidence;
    environment?: string;
    package: PackageInfo;
    permissions: TrustPermissions;
    reasons: readonly string[];
    repository?: string;
    trustArgs?: readonly string[];
    workflow?: WorkflowInfo;
    workflowFile?: string;
  } = {
    confidence: plan.confidence,
    package: plan.package,
    permissions: plan.permissions,
    reasons: plan.reasons,
  };

  if (plan.command) {
    result.command = plan.command;
  }

  if (plan.environment) {
    result.environment = plan.environment;
  }

  if (plan.repository) {
    result.repository = plan.repository;
  }

  if (plan.trustArgs) {
    result.trustArgs = plan.trustArgs;
  }

  if (plan.workflow) {
    result.workflow = plan.workflow;
  }

  if (plan.workflowFile) {
    result.workflowFile = plan.workflowFile;
  }

  return result;
}

function quoteForDisplay(value: string): string {
  if (/^[a-z0-9-]+$/i.test(value)) {
    return value;
  }

  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
