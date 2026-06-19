import { basename } from "node:path";

import type { WorkspaceDiscovery } from "./discovery.js";
import type { PackageInfo } from "./packages.js";
import { resolvePublishTopology, type PackagePublishMapping } from "./topology.js";
import type { Evidence, PublishCandidate, WorkflowInfo, WorkflowSignals } from "./workflows.js";

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
  readonly evidence: readonly Evidence[];
  readonly explain: readonly string[];
  readonly package: PackageInfo;
  readonly permissions: TrustPermissions;
  readonly publishCandidate?: PublishCandidate;
  readonly reasons: readonly string[];
  readonly repository?: string;
  readonly score: number;
  readonly topologyStatus?: PackagePublishMapping["status"];
  readonly trustArgs?: readonly string[];
  readonly workflow?: WorkflowInfo;
  readonly workflowFile?: string;
}

export interface TrustPermissions {
  readonly allowPublish: boolean;
  readonly allowStagePublish: boolean;
}

interface WorkflowSelection {
  readonly candidate?: PublishCandidate;
  readonly reasons: readonly string[];
  readonly topologyStatus?: PackagePublishMapping["status"];
  readonly workflow?: WorkflowInfo;
}

export function buildTrustedPublisherPlans(
  discovery: WorkspaceDiscovery,
  options: PlanningOptions = {},
): TrustedPublisherPlan[] {
  const repository = options.repository ?? discovery.repository.githubRepository;
  const topology = resolvePublishTopology(discovery);

  return discovery.packages.map((pkg) => {
    const workflowSelection = options.workflowFile
      ? selectWorkflow(discovery.workflows, options.workflowFile)
      : selectPackageWorkflow(discovery.workflows, topology.mappings, pkg);

    return buildPackagePlan(pkg, repository, workflowSelection, options.permissionMode ?? "both");
  });
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
  const candidate = workflowSelection.candidate;

  reasons.push(...pkg.skipReasons);
  reasons.push(...workflowSelection.reasons);

  if (!repository) {
    reasons.push("GitHub repository not detected");
  }

  const workflowFile = workflow?.fileName;
  if (!workflowFile) {
    reasons.push("publishing workflow not detected");
  }

  if (candidate && !candidate.hasIdTokenWrite) {
    reasons.push("publishing job is missing permissions.id-token: write");
  } else if (workflow && !workflow.signals.hasIdTokenWrite) {
    reasons.push("workflow is missing permissions.id-token: write");
  }

  const environment = candidate?.environment ?? inferEnvironment(workflow, reasons);
  const permissions = inferPermissions(candidate, workflow?.signals, permissionMode);

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
  const scoring = scorePlan(
    pkg,
    candidate,
    workflow,
    workflowSelection,
    repository,
    permissions,
    reasons,
  );

  return compactPlan({
    command,
    confidence: scoring.confidence,
    environment,
    evidence: collectPlanEvidence(workflow, candidate),
    explain: scoring.explain,
    package: pkg,
    permissions,
    publishCandidate: candidate,
    reasons,
    repository,
    score: scoring.score,
    topologyStatus: workflowSelection.topologyStatus,
    trustArgs,
    workflow,
    workflowFile,
  });
}

function selectPackageWorkflow(
  workflows: readonly WorkflowInfo[],
  mappings: readonly PackagePublishMapping[],
  pkg: PackageInfo,
): WorkflowSelection {
  const mapping = mappings.find((candidate) => candidate.package === pkg);
  if (!mapping) {
    return selectWorkflow(workflows, undefined);
  }

  if (mapping.status === "ambiguous") {
    return {
      reasons: ["multiple publishing candidates detected for package"],
      topologyStatus: mapping.status,
    };
  }

  if (!mapping.selectedCandidate) {
    if (!workflows.some((workflow) => workflow.candidates.length > 0)) {
      return selectWorkflow(workflows, undefined);
    }

    return {
      reasons: ["publishing topology could not map a workflow candidate to this package"],
      topologyStatus: mapping.status,
    };
  }

  const workflow = workflows.find(
    (candidate) => candidate.fileName === mapping.selectedCandidate?.workflowFile,
  );

  if (!workflow) {
    return {
      reasons: [`workflow ${mapping.selectedCandidate.workflowFile} was not found`],
      topologyStatus: mapping.status,
    };
  }

  return {
    candidate: mapping.selectedCandidate,
    reasons: [],
    topologyStatus: mapping.status,
    workflow,
  };
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
  candidate: PublishCandidate | undefined,
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

  if (candidate) {
    const command = candidate.command ?? "";
    const allowStagePublish = /\bnpm\s+stage\s+publish\b/.test(command);
    return {
      allowPublish: candidate.tool !== "reusable-workflow" && !allowStagePublish,
      allowStagePublish,
    };
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

function scorePlan(
  pkg: PackageInfo,
  candidate: PublishCandidate | undefined,
  workflow: WorkflowInfo | undefined,
  workflowSelection: WorkflowSelection,
  repository: string | undefined,
  permissions: TrustPermissions,
  reasons: readonly string[],
): { confidence: Confidence; explain: readonly string[]; score: number } {
  const explain: string[] = [];
  let score = 0;

  if (pkg.publishable && pkg.name) {
    score += 20;
    explain.push("package is publishable and has an npm name");
  } else {
    explain.push("package is not publishable");
  }

  if (repository) {
    score += 15;
    explain.push(`GitHub repository resolved as ${repository}`);
  } else {
    explain.push("GitHub repository could not be resolved");
  }

  if (workflow) {
    score += 15;
    explain.push(`publishing workflow selected: ${workflow.fileName}`);
  } else {
    explain.push("publishing workflow was not selected");
  }

  if (candidate) {
    score += 15;
    explain.push(`workflow candidate selected from ${candidate.tool}`);
    if (candidate.kind === "direct") {
      score += 15;
      explain.push("candidate directly runs a publish command");
    } else if (candidate.kind === "reusable") {
      score -= 20;
      explain.push("candidate delegates to a reusable workflow and needs manual review");
    } else {
      score += 5;
      explain.push(`candidate uses indirect release tool ${candidate.tool}`);
    }
  } else if (workflow && isDirectPublishingWorkflow(workflow.signals)) {
    score += 20;
    explain.push("workflow-level fallback detected a direct publish command");
  } else if (workflow) {
    score += 5;
    explain.push("workflow-level fallback detected an indirect publish signal");
  }

  if (candidate?.hasIdTokenWrite ?? workflow?.signals.hasIdTokenWrite) {
    score += 15;
    explain.push("publishing workflow has permissions.id-token: write");
  } else {
    score -= 25;
    explain.push("publishing workflow is missing permissions.id-token: write");
  }

  if (permissions.allowPublish || permissions.allowStagePublish) {
    score += 10;
    explain.push("trusted publisher permissions can be inferred");
  } else {
    explain.push("trusted publisher permissions could not be inferred");
  }

  if (workflowSelection.topologyStatus) {
    explain.push(`publish topology status is ${workflowSelection.topologyStatus}`);
  }

  score -= Math.min(40, reasons.length * 8);

  if (workflowSelection.reasons.some((reason) => reason.startsWith("multiple"))) {
    score = Math.min(score, 45);
  }

  if (reasons.length > 0) {
    score = Math.min(score, 80);
  }

  if (candidate && candidate.kind !== "direct") {
    score = Math.min(score, 80);
  }

  if (
    !pkg.publishable ||
    !pkg.name ||
    !repository ||
    !workflow ||
    (!permissions.allowPublish && !permissions.allowStagePublish)
  ) {
    score = Math.min(score, 45);
  }

  const normalizedScore = Math.max(0, Math.min(100, score));
  return {
    confidence: normalizedScore >= 85 ? "high" : normalizedScore >= 50 ? "medium" : "low",
    explain,
    score: normalizedScore,
  };
}

function isDirectPublishingWorkflow(signals: WorkflowSignals): boolean {
  return signals.npmPublish || signals.npmStagePublish || signals.packageManagerPublish;
}

function compactPlan(plan: {
  readonly command: string | undefined;
  readonly confidence: Confidence;
  readonly environment: string | undefined;
  readonly evidence: readonly Evidence[];
  readonly explain: readonly string[];
  readonly package: PackageInfo;
  readonly permissions: TrustPermissions;
  readonly publishCandidate: PublishCandidate | undefined;
  readonly reasons: readonly string[];
  readonly repository: string | undefined;
  readonly score: number;
  readonly topologyStatus: PackagePublishMapping["status"] | undefined;
  readonly trustArgs: readonly string[] | undefined;
  readonly workflow: WorkflowInfo | undefined;
  readonly workflowFile: string | undefined;
}): TrustedPublisherPlan {
  const result: {
    command?: string;
    confidence: Confidence;
    environment?: string;
    evidence: readonly Evidence[];
    explain: readonly string[];
    package: PackageInfo;
    permissions: TrustPermissions;
    publishCandidate?: PublishCandidate;
    reasons: readonly string[];
    repository?: string;
    score: number;
    topologyStatus?: PackagePublishMapping["status"];
    trustArgs?: readonly string[];
    workflow?: WorkflowInfo;
    workflowFile?: string;
  } = {
    confidence: plan.confidence,
    evidence: plan.evidence,
    explain: plan.explain,
    package: plan.package,
    permissions: plan.permissions,
    reasons: plan.reasons,
    score: plan.score,
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

  if (plan.publishCandidate) {
    result.publishCandidate = plan.publishCandidate;
  }

  if (plan.topologyStatus) {
    result.topologyStatus = plan.topologyStatus;
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

function collectPlanEvidence(
  workflow: WorkflowInfo | undefined,
  candidate: PublishCandidate | undefined,
): readonly Evidence[] {
  if (candidate) {
    return candidate.evidence;
  }

  return workflow?.evidence ?? [];
}

function quoteForDisplay(value: string): string {
  if (/^[a-z0-9-]+$/i.test(value)) {
    return value;
  }

  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
