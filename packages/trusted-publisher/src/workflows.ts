import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

import { parse as parseYaml } from "yaml";

import { asObject, type JsonObject } from "./json.js";

export interface WorkflowInfo {
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
  readonly semanticRelease: boolean;
}

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
  const strings = collectStrings(parsed);
  const runCommands = collectRunCommands(parsed);
  const uses = collectUses(parsed);

  return {
    fileName: basename(path),
    path,
    relativePath: relative(rootDir, path).split(sep).join("/"),
    signals: {
      changesetsAction: uses.some((value) => /changesets\/action/i.test(value)),
      environments: collectEnvironments(parsed),
      hasIdTokenWrite: hasIdTokenWrite(parsed),
      lernaPublish: runCommands.some((value) => /\blerna\s+publish\b/.test(value)),
      npmPublish: runCommands.some((value) => /\bnpm\s+publish\b/.test(value)),
      npmStagePublish: runCommands.some((value) => /\bnpm\s+stage\s+publish\b/.test(value)),
      nxReleasePublish: runCommands.some((value) => /\bnx\s+release\s+publish\b/.test(value)),
      packageManagerPublish: runCommands.some((value) =>
        /\b(?:pnpm\s+(?:-\w+\s+)*publish|yarn\s+npm\s+publish)\b/.test(value),
      ),
      semanticRelease: strings.some((value) => /\bsemantic-release\b/.test(value)),
    },
  };
}

function collectRunCommands(value: unknown): string[] {
  const commands: string[] = [];
  visit(value, (node) => {
    const object = asObject(node);
    if (typeof object?.run === "string") {
      commands.push(object.run);
    }
  });
  return commands;
}

function collectUses(value: unknown): string[] {
  const uses: string[] = [];
  visit(value, (node) => {
    const object = asObject(node);
    if (typeof object?.uses === "string") {
      uses.push(object.uses);
    }
  });
  return uses;
}

function collectStrings(value: unknown): string[] {
  const strings: string[] = [];
  visit(value, (node) => {
    if (typeof node === "string") {
      strings.push(node);
    }
  });
  return strings;
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
    const environment = asObject(job)?.environment;

    if (typeof environment === "string") {
      environments.add(environment);
      continue;
    }

    const name = asObject(environment)?.name;
    if (typeof name === "string") {
      environments.add(name);
    }
  }

  return [...environments].toSorted();
}

function visit(value: unknown, visitor: (value: unknown) => void): void {
  visitor(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, visitor);
    }
    return;
  }

  const object = asObject(value);
  if (!object) {
    return;
  }

  for (const item of Object.values(object)) {
    visit(item, visitor);
  }
}
