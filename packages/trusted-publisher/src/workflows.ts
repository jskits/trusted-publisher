import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

import { parse as parseYaml } from "yaml";

import { asObject, type JsonObject } from "./json.js";

export type EvidenceLevel = "info" | "negative" | "positive" | "warning";
export type PublishCandidateKind =
  | "changesets"
  | "direct"
  | "lerna"
  | "nx"
  | "reusable"
  | "semantic-release";
export type PublishTool =
  | "changesets"
  | "lerna"
  | "npm"
  | "nx"
  | "pnpm"
  | "reusable-workflow"
  | "semantic-release"
  | "yarn";
export type PackageSelectorKind = "all" | "filter" | "name" | "path" | "unknown";

export interface Evidence {
  readonly code: string;
  readonly level: EvidenceLevel;
  readonly message: string;
  readonly scoreDelta?: number;
  readonly source: EvidenceSource;
}

export interface EvidenceSource {
  readonly command?: string;
  readonly file: string;
  readonly jobId?: string;
  readonly reusableWorkflow?: string;
  readonly stepIndex?: number;
  readonly stepName?: string;
  readonly uses?: string;
}

export interface PackageSelector {
  readonly kind: PackageSelectorKind;
  readonly value?: string;
}

export interface PublishCandidate {
  readonly command?: string;
  readonly environment?: string;
  readonly evidence: readonly Evidence[];
  readonly hasIdTokenWrite: boolean;
  readonly jobId: string;
  readonly kind: PublishCandidateKind;
  readonly packageSelector: PackageSelector;
  readonly permissionsSource: "job" | "workflow" | "missing";
  readonly reusableWorkflow?: string;
  readonly stepIndex?: number;
  readonly stepName?: string;
  readonly tool: PublishTool;
  readonly workflowFile: string;
  readonly workingDirectory?: string;
}

export interface WorkflowInfo {
  readonly candidates: readonly PublishCandidate[];
  readonly evidence: readonly Evidence[];
  readonly fileName: string;
  readonly path: string;
  readonly relativePath: string;
  readonly signals: WorkflowSignals;
}

export interface WorkflowSignals {
  readonly changesetsAction: boolean;
  readonly environments: readonly string[];
  readonly hasIdTokenWrite: boolean;
  readonly lernaPublish: boolean;
  readonly npmPublish: boolean;
  readonly npmStagePublish: boolean;
  readonly nxReleasePublish: boolean;
  readonly packageManagerPublish: boolean;
  readonly reusableWorkflow: boolean;
  readonly semanticRelease: boolean;
}

interface WorkflowContext {
  readonly fileName: string;
  readonly relativePath: string;
  readonly rootDir: string;
}

interface JobContext extends WorkflowContext {
  readonly defaultWorkingDirectory?: string;
  readonly environment?: string;
  readonly hasIdTokenWrite: boolean;
  readonly jobId: string;
  readonly permissionsSource: "job" | "workflow" | "missing";
}

interface StepContext extends JobContext {
  readonly stepIndex: number;
  readonly stepName?: string;
  readonly workingDirectory?: string;
}

interface MatrixValue {
  readonly key: string;
  readonly value: string;
}

const packageMatrixKeys = new Set([
  "dir",
  "directory",
  "package",
  "packageName",
  "package_name",
  "packages",
  "path",
  "pkg",
  "workspace",
  "workspacePath",
  "workspace_path",
]);

export function discoverGitHubWorkflows(rootDir: string): WorkflowInfo[] {
  const workflowsDir = join(rootDir, ".github", "workflows");
  if (!existsSync(workflowsDir)) {
    return [];
  }

  return readdirSync(workflowsDir)
    .filter((fileName) => /\.ya?ml$/i.test(fileName))
    .toSorted()
    .map((fileName) => readWorkflow(rootDir, join(workflowsDir, fileName)));
}

function readWorkflow(rootDir: string, path: string): WorkflowInfo {
  const source = readFileSync(path, "utf8");
  const parsed = asObject(parseYaml(source)) ?? {};
  const context: WorkflowContext = {
    fileName: basename(path),
    relativePath: relative(rootDir, path).split(sep).join("/"),
    rootDir,
  };
  const candidates = collectPublishCandidates(parsed, context);
  const evidence = collectWorkflowEvidence(parsed, context, candidates);

  return {
    candidates,
    evidence,
    fileName: context.fileName,
    path,
    relativePath: context.relativePath,
    signals: buildWorkflowSignals(parsed, candidates),
  };
}

function collectPublishCandidates(
  workflow: JsonObject,
  context: WorkflowContext,
): PublishCandidate[] {
  const candidates: PublishCandidate[] = [];
  const jobs = asObject(workflow.jobs);
  if (!jobs) {
    return candidates;
  }

  const workflowHasIdTokenWrite = permissionsAllowIdToken(workflow.permissions);
  const workflowDefaults = readWorkingDirectory(asObject(workflow.defaults)?.run);

  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asObject(rawJob);
    if (!job) {
      continue;
    }

    const jobHasIdTokenWrite = permissionsAllowIdToken(job.permissions);
    const jobOrWorkflowHasIdTokenWrite = jobHasIdTokenWrite || workflowHasIdTokenWrite;
    const jobContext: {
      defaultWorkingDirectory?: string;
      environment?: string;
      fileName: string;
      hasIdTokenWrite: boolean;
      jobId: string;
      permissionsSource: "job" | "workflow" | "missing";
      relativePath: string;
      rootDir: string;
    } = {
      ...context,
      jobId,
      hasIdTokenWrite: jobOrWorkflowHasIdTokenWrite,
      permissionsSource: jobHasIdTokenWrite
        ? "job"
        : workflowHasIdTokenWrite
          ? "workflow"
          : "missing",
    };
    const defaultWorkingDirectory =
      readWorkingDirectory(asObject(job.defaults)?.run) ?? workflowDefaults;
    if (defaultWorkingDirectory) {
      jobContext.defaultWorkingDirectory = defaultWorkingDirectory;
    }
    const environment = readEnvironment(job);
    if (environment) {
      jobContext.environment = environment;
    }

    const jobUses = readString(job.uses);
    if (jobUses) {
      candidates.push(createReusableCandidate(jobUses, jobContext));
    }

    const matrixValues = collectMatrixValues(job);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((rawStep, stepIndex) => {
      const step = asObject(rawStep);
      if (!step) {
        return;
      }

      const stepContext: {
        defaultWorkingDirectory?: string;
        environment?: string;
        fileName: string;
        hasIdTokenWrite: boolean;
        jobId: string;
        permissionsSource: "job" | "workflow" | "missing";
        relativePath: string;
        rootDir: string;
        stepIndex: number;
        stepName?: string;
        workingDirectory?: string;
      } = {
        ...jobContext,
        stepIndex,
      };
      const stepName = readString(step.name);
      if (stepName) {
        stepContext.stepName = stepName;
      }
      const workingDirectory = readWorkingDirectory(step) ?? jobContext.defaultWorkingDirectory;
      if (workingDirectory) {
        stepContext.workingDirectory = workingDirectory;
      }

      const uses = readString(step.uses);
      if (uses) {
        const actionCandidate = candidateFromUses(uses, step, stepContext);
        if (actionCandidate) {
          candidates.push(actionCandidate);
        }
      }

      const command = readString(step.run);
      if (!command) {
        return;
      }

      const expandedContexts = expandMatrixStepContext(stepContext, matrixValues);
      for (const expandedContext of expandedContexts) {
        candidates.push(...candidatesFromCommand(command, expandedContext));
      }
    });
  }

  return candidates;
}

function collectWorkflowEvidence(
  workflow: JsonObject,
  context: WorkflowContext,
  candidates: readonly PublishCandidate[],
): Evidence[] {
  const evidence: Evidence[] = [];

  if (permissionsAllowIdToken(workflow.permissions)) {
    evidence.push({
      code: "workflow.permissions.id_token",
      level: "positive",
      message: `${context.fileName} grants permissions.id-token: write at workflow level.`,
      scoreDelta: 10,
      source: { file: context.relativePath },
    });
  }

  if (candidates.length === 0) {
    evidence.push({
      code: "workflow.publish.none",
      level: "info",
      message: `${context.fileName} has no publishing candidate.`,
      scoreDelta: -10,
      source: { file: context.relativePath },
    });
  }

  return [...evidence, ...candidates.flatMap((candidate) => candidate.evidence)];
}

function buildWorkflowSignals(
  workflow: JsonObject,
  candidates: readonly PublishCandidate[],
): WorkflowSignals {
  return {
    changesetsAction: candidates.some((candidate) => candidate.tool === "changesets"),
    environments: collectEnvironments(workflow),
    hasIdTokenWrite: hasIdTokenWrite(workflow),
    lernaPublish: candidates.some((candidate) => candidate.tool === "lerna"),
    npmPublish: candidates.some(
      (candidate) => candidate.tool === "npm" && candidate.kind === "direct",
    ),
    npmStagePublish: candidates.some((candidate) =>
      /\bnpm\s+stage\s+publish\b/.test(candidate.command ?? ""),
    ),
    nxReleasePublish: candidates.some((candidate) => candidate.tool === "nx"),
    packageManagerPublish: candidates.some(
      (candidate) => candidate.tool === "pnpm" || candidate.tool === "yarn",
    ),
    reusableWorkflow: candidates.some((candidate) => candidate.kind === "reusable"),
    semanticRelease: candidates.some((candidate) => candidate.tool === "semantic-release"),
  };
}

function candidateFromUses(
  uses: string,
  step: JsonObject,
  context: StepContext,
): PublishCandidate | undefined {
  if (/changesets\/action/i.test(uses)) {
    return makeCandidate({
      context,
      evidenceCode: "workflow.publish.changesets_action",
      kind: "changesets",
      message: `${context.fileName} uses changesets/action in ${formatStep(context)}.`,
      packageSelector: { kind: "all" },
      scoreDelta: 8,
      tool: "changesets",
      uses,
    });
  }

  if (isReusableWorkflowReference(uses)) {
    return createReusableCandidate(uses, context);
  }

  const publishInput = readString(asObject(step.with)?.publish);
  if (publishInput) {
    return candidatesFromCommand(publishInput, context)[0];
  }

  return undefined;
}

function createReusableCandidate(
  uses: string,
  context: JobContext | StepContext,
): PublishCandidate {
  const localReusableWorkflow = parseLocalReusableWorkflow(uses);
  return makeCandidate({
    context,
    evidenceCode: localReusableWorkflow ? "workflow.reusable.local" : "workflow.reusable.external",
    kind: "reusable",
    message: `${context.fileName} calls ${localReusableWorkflow ? "local" : "external"} reusable workflow ${uses}.`,
    packageSelector: { kind: "unknown" },
    reusableWorkflow: localReusableWorkflow ?? uses,
    scoreDelta: localReusableWorkflow ? -8 : -20,
    tool: "reusable-workflow",
    uses,
  });
}

function candidatesFromCommand(command: string, context: StepContext): PublishCandidate[] {
  const candidates: PublishCandidate[] = [];
  const normalized = command.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ");

  if (/\bnpm\s+stage\s+publish\b/.test(normalized)) {
    candidates.push(
      makeCommandCandidate({
        command,
        context,
        evidenceCode: "workflow.publish.npm_stage",
        message: `${context.fileName} runs npm stage publish in ${formatStep(context)}.`,
        packageSelector: inferPackageSelector(normalized, context.workingDirectory),
        scoreDelta: 18,
        tool: "npm",
      }),
    );
  }

  if (/\bnpm\s+publish\b/.test(normalized) && !/\byarn\b.*\bnpm\s+publish\b/.test(normalized)) {
    candidates.push(
      makeCommandCandidate({
        command,
        context,
        evidenceCode: "workflow.publish.npm",
        message: `${context.fileName} runs npm publish in ${formatStep(context)}.`,
        packageSelector: inferPackageSelector(normalized, context.workingDirectory),
        scoreDelta: 20,
        tool: "npm",
      }),
    );
  }

  if (/\bpnpm\b/.test(normalized) && /\bpublish\b/.test(normalized)) {
    candidates.push(
      makeCommandCandidate({
        command,
        context,
        evidenceCode: "workflow.publish.pnpm",
        message: `${context.fileName} runs pnpm publish in ${formatStep(context)}.`,
        packageSelector: inferPnpmSelector(normalized, context.workingDirectory),
        scoreDelta: 16,
        tool: "pnpm",
      }),
    );
  }

  if (
    /\byarn\b/.test(normalized) &&
    /\b(?:npm\s+publish|workspaces\s+foreach)\b/.test(normalized)
  ) {
    candidates.push(
      makeCommandCandidate({
        command,
        context,
        evidenceCode: "workflow.publish.yarn",
        message: `${context.fileName} runs yarn npm publish in ${formatStep(context)}.`,
        packageSelector: inferYarnSelector(normalized, context.workingDirectory),
        scoreDelta: 16,
        tool: "yarn",
      }),
    );
  }

  if (/\b(?:npx\s+)?semantic-release\b/.test(normalized)) {
    candidates.push(
      makeToolCandidate({
        command,
        context,
        evidenceCode: "workflow.publish.semantic_release",
        kind: "semantic-release",
        message: `${context.fileName} runs semantic-release in ${formatStep(context)}.`,
        packageSelector: { kind: "unknown" },
        scoreDelta: 6,
        tool: "semantic-release",
      }),
    );
  }

  if (/\blerna\s+publish\b/.test(normalized)) {
    candidates.push(
      makeToolCandidate({
        command,
        context,
        evidenceCode: "workflow.publish.lerna",
        kind: "lerna",
        message: `${context.fileName} runs lerna publish in ${formatStep(context)}.`,
        packageSelector: { kind: "all" },
        scoreDelta: 10,
        tool: "lerna",
      }),
    );
  }

  if (/\bnx\s+release(?:\s+publish)?\b/.test(normalized)) {
    candidates.push(
      makeToolCandidate({
        command,
        context,
        evidenceCode: "workflow.publish.nx",
        kind: "nx",
        message: `${context.fileName} runs nx release publish in ${formatStep(context)}.`,
        packageSelector: { kind: "all" },
        scoreDelta: 10,
        tool: "nx",
      }),
    );
  }

  return candidates;
}

function makeCommandCandidate(options: {
  readonly command: string;
  readonly context: StepContext;
  readonly evidenceCode: string;
  readonly message: string;
  readonly packageSelector: PackageSelector;
  readonly scoreDelta: number;
  readonly tool: "npm" | "pnpm" | "yarn";
}): PublishCandidate {
  return makeCandidate({
    command: options.command,
    context: options.context,
    evidenceCode: options.evidenceCode,
    kind: "direct",
    message: options.message,
    packageSelector: options.packageSelector,
    scoreDelta: options.scoreDelta,
    tool: options.tool,
  });
}

function makeToolCandidate(options: {
  readonly command: string;
  readonly context: StepContext;
  readonly evidenceCode: string;
  readonly kind: "changesets" | "lerna" | "nx" | "semantic-release";
  readonly message: string;
  readonly packageSelector: PackageSelector;
  readonly scoreDelta: number;
  readonly tool: "changesets" | "lerna" | "nx" | "semantic-release";
}): PublishCandidate {
  return makeCandidate(options);
}

function makeCandidate(options: {
  readonly command?: string;
  readonly context: JobContext | StepContext;
  readonly evidenceCode: string;
  readonly kind: PublishCandidateKind;
  readonly message: string;
  readonly packageSelector: PackageSelector;
  readonly reusableWorkflow?: string;
  readonly scoreDelta: number;
  readonly tool: PublishTool;
  readonly uses?: string;
}): PublishCandidate {
  const source: {
    command?: string;
    file: string;
    jobId: string;
    reusableWorkflow?: string;
    stepIndex?: number;
    stepName?: string;
    uses?: string;
  } = {
    file: options.context.relativePath,
    jobId: options.context.jobId,
  };

  if (options.command) {
    source.command = options.command;
  }
  if (options.reusableWorkflow) {
    source.reusableWorkflow = options.reusableWorkflow;
  }
  if ("stepIndex" in options.context) {
    source.stepIndex = options.context.stepIndex;
  }
  if ("stepName" in options.context && options.context.stepName) {
    source.stepName = options.context.stepName;
  }
  if (options.uses) {
    source.uses = options.uses;
  }

  const candidate: {
    command?: string;
    environment?: string;
    evidence: Evidence[];
    hasIdTokenWrite: boolean;
    jobId: string;
    kind: PublishCandidateKind;
    packageSelector: PackageSelector;
    permissionsSource: "job" | "workflow" | "missing";
    reusableWorkflow?: string;
    stepIndex?: number;
    stepName?: string;
    tool: PublishTool;
    workflowFile: string;
    workingDirectory?: string;
  } = {
    evidence: [
      {
        code: options.evidenceCode,
        level: options.scoreDelta >= 0 ? "positive" : "warning",
        message: options.message,
        scoreDelta: options.scoreDelta,
        source,
      },
      permissionEvidence(options.context),
    ],
    hasIdTokenWrite: options.context.hasIdTokenWrite,
    jobId: options.context.jobId,
    kind: options.kind,
    packageSelector: options.packageSelector,
    permissionsSource: options.context.permissionsSource,
    tool: options.tool,
    workflowFile: options.context.fileName,
  };

  if (options.command) {
    candidate.command = options.command;
  }
  if (options.context.environment) {
    candidate.environment = options.context.environment;
  }
  if (options.reusableWorkflow) {
    candidate.reusableWorkflow = options.reusableWorkflow;
  }
  if ("stepIndex" in options.context) {
    candidate.stepIndex = options.context.stepIndex;
  }
  if ("stepName" in options.context && options.context.stepName) {
    candidate.stepName = options.context.stepName;
  }
  if ("workingDirectory" in options.context && options.context.workingDirectory) {
    candidate.workingDirectory = options.context.workingDirectory;
  }

  return candidate;
}

function permissionEvidence(context: JobContext | StepContext): Evidence {
  if (context.hasIdTokenWrite) {
    return {
      code: `workflow.permissions.id_token.${context.permissionsSource}`,
      level: "positive",
      message: `Publishing job ${context.jobId} has permissions.id-token: write from ${context.permissionsSource} permissions.`,
      scoreDelta: 10,
      source: { file: context.relativePath, jobId: context.jobId },
    };
  }

  return {
    code: "workflow.permissions.id_token.missing",
    level: "negative",
    message: `Publishing job ${context.jobId} is missing permissions.id-token: write.`,
    scoreDelta: -30,
    source: { file: context.relativePath, jobId: context.jobId },
  };
}

function inferPackageSelector(
  command: string,
  workingDirectory: string | undefined,
): PackageSelector {
  if (/\s--workspaces(?:\s|$)|\s-ws(?:\s|$)/.test(command)) {
    return { kind: "all" };
  }

  const workspace = /(?:--workspace|-w)\s+["']?([^"'\s]+)["']?/.exec(command);
  if (workspace?.[1]) {
    return selectorFromValue(workspace[1]);
  }

  if (workingDirectory) {
    return selectorFromValue(workingDirectory);
  }

  return { kind: "unknown" };
}

function inferPnpmSelector(command: string, workingDirectory: string | undefined): PackageSelector {
  if (/\s(?:-r|--recursive)(?:\s|$)/.test(command)) {
    return { kind: "all" };
  }

  const filter = /(?:--filter|-F)\s+["']?([^"'\s]+)["']?/.exec(command);
  if (filter?.[1]) {
    return { kind: "filter", value: filter[1] };
  }

  if (workingDirectory) {
    return selectorFromValue(workingDirectory);
  }

  return { kind: "unknown" };
}

function inferYarnSelector(command: string, workingDirectory: string | undefined): PackageSelector {
  if (/\bworkspaces\s+foreach\b/.test(command)) {
    return { kind: "all" };
  }

  if (workingDirectory) {
    return selectorFromValue(workingDirectory);
  }

  return { kind: "unknown" };
}

function selectorFromValue(value: string): PackageSelector {
  if (value.startsWith("@") || /^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    return { kind: "name", value };
  }

  if (/[/.]/.test(value)) {
    return { kind: "path", value: value.replace(/^\.\//, "") };
  }

  return { kind: "unknown", value };
}

function expandMatrixStepContext(
  context: StepContext,
  matrixValues: readonly MatrixValue[],
): StepContext[] {
  if (matrixValues.length === 0) {
    return [context];
  }

  const valuesReferencedByCommand = matrixValues.filter((item) =>
    context.workingDirectory?.includes(`matrix.${item.key}`),
  );
  if (valuesReferencedByCommand.length === 0) {
    return [context];
  }

  return valuesReferencedByCommand.map((item) =>
    Object.assign({}, context, {
      workingDirectory: context.workingDirectory?.replace(
        new RegExp(`\\$\\{\\{\\s*matrix\\.${escapeRegExp(item.key)}\\s*}}`, "g"),
        item.value,
      ),
    }),
  );
}

function collectMatrixValues(job: JsonObject): MatrixValue[] {
  const matrix = asObject(asObject(job.strategy)?.matrix);
  if (!matrix) {
    return [];
  }

  const values: MatrixValue[] = [];
  for (const [key, value] of Object.entries(matrix)) {
    if (!packageMatrixKeys.has(key)) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          values.push({ key, value: item });
        }
      }
      continue;
    }

    if (typeof value === "string") {
      values.push({ key, value });
    }
  }

  return values;
}

function hasIdTokenWrite(workflow: JsonObject): boolean {
  if (permissionsAllowIdToken(workflow.permissions)) {
    return true;
  }

  const jobs = asObject(workflow.jobs);
  if (!jobs) {
    return false;
  }

  return Object.values(jobs).some((job) => permissionsAllowIdToken(asObject(job)?.permissions));
}

function permissionsAllowIdToken(value: unknown): boolean {
  const permissions = asObject(value);
  return permissions?.["id-token"] === "write";
}

function collectEnvironments(workflow: JsonObject): string[] {
  const environments = new Set<string>();
  const jobs = asObject(workflow.jobs);

  if (!jobs) {
    return [];
  }

  for (const job of Object.values(jobs)) {
    const environment = readEnvironment(asObject(job) ?? {});

    if (environment) {
      environments.add(environment);
    }
  }

  return [...environments].toSorted();
}

function readEnvironment(job: JsonObject): string | undefined {
  const environment = job.environment;

  if (typeof environment === "string") {
    return environment;
  }

  const name = asObject(environment)?.name;
  return typeof name === "string" ? name : undefined;
}

function readWorkingDirectory(value: unknown): string | undefined {
  const workingDirectory = asObject(value)?.["working-directory"];
  return typeof workingDirectory === "string" ? workingDirectory : undefined;
}

function isReusableWorkflowReference(value: string): boolean {
  return /\.ya?ml(?:@|$)/i.test(value) && /(?:^\.\/|\/\.github\/workflows\/)/.test(value);
}

function parseLocalReusableWorkflow(value: string): string | undefined {
  if (!value.startsWith("./")) {
    return undefined;
  }

  const withoutRef = value.split("@")[0] ?? value;
  if (!withoutRef.startsWith("./.github/workflows/")) {
    return undefined;
  }

  return withoutRef.replace(/^\.\//, "");
}

function formatStep(context: StepContext): string {
  return context.stepName
    ? `job ${context.jobId} step "${context.stepName}"`
    : `job ${context.jobId} step ${context.stepIndex + 1}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
