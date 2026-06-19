export const minimumNodeVersion = "22.14.0";
export const minimumNpmVersion = "11.15.0";

export interface RuntimePrerequisiteVersions {
  readonly nodeVersion: string;
  readonly npmVersion: string;
}

export interface RuntimePrerequisiteIssue {
  readonly found: string;
  readonly name: "Node.js" | "npm CLI";
  readonly required: string;
}

export function checkRuntimePrerequisites(
  versions: RuntimePrerequisiteVersions,
): RuntimePrerequisiteIssue[] {
  const issues: RuntimePrerequisiteIssue[] = [];

  if (compareVersions(versions.nodeVersion, minimumNodeVersion) < 0) {
    issues.push({
      found: versions.nodeVersion,
      name: "Node.js",
      required: minimumNodeVersion,
    });
  }

  if (compareVersions(versions.npmVersion, minimumNpmVersion) < 0) {
    issues.push({
      found: versions.npmVersion,
      name: "npm CLI",
      required: minimumNpmVersion,
    });
  }

  return issues;
}

export function formatRuntimePrerequisiteIssues(
  issues: readonly RuntimePrerequisiteIssue[],
): string {
  return issues
    .map((issue) => `${issue.name} >= ${issue.required} is required; found ${issue.found}.`)
    .join("\n");
}

function compareVersions(actual: string, minimum: string): number {
  const actualParts = parseVersion(actual);
  const minimumParts = parseVersion(minimum);

  if (!actualParts || !minimumParts) {
    return -1;
  }

  for (let index = 0; index < minimumParts.length; index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;

    if (actualPart > minimumPart) {
      return 1;
    }

    if (actualPart < minimumPart) {
      return -1;
    }
  }

  return 0;
}

function parseVersion(value: string): readonly number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) {
    return undefined;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
