import type { ApplyResult, CheckedPlan } from "./apply.js";
import type { PackageClaimPlan, PackageClaimResult } from "./claim.js";
import type { WorkspaceDiscovery } from "./discovery.js";
import type { TrustedPublisherPlan } from "./planning.js";
import { resolvePublishTopology } from "./topology.js";
import { formatTrustFieldDiff } from "./trust-diff.js";

export interface MigrationReportInput {
  readonly checkedPlans?: readonly CheckedPlan[];
  readonly claimPlans?: readonly PackageClaimPlan[];
  readonly claimResults?: readonly PackageClaimResult[];
  readonly discovery: WorkspaceDiscovery;
  readonly plans: readonly TrustedPublisherPlan[];
  readonly results?: readonly ApplyResult[];
}

export function generateMigrationReport(input: MigrationReportInput): string {
  const topology = resolvePublishTopology(input.discovery);
  const lines: string[] = [];

  lines.push("# trusted-publisher Migration Report");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Repository root: \`${input.discovery.repository.rootDir}\``);
  lines.push(
    `- GitHub repository: \`${input.discovery.repository.githubRepository ?? "not detected"}\``,
  );
  lines.push(`- Packages discovered: ${input.discovery.packages.length}`);
  lines.push(
    `- Publishable packages: ${input.discovery.packages.filter((pkg) => pkg.publishable).length}`,
  );
  lines.push(`- GitHub workflows: ${input.discovery.workflows.length}`);
  lines.push(`- Publish topology: ${topology.kind}`);
  lines.push(
    `- Package claims needed: ${input.claimPlans?.filter((plan) => plan.action === "claim").length ?? 0}`,
  );
  lines.push("");

  lines.push("## Plans");
  lines.push("");
  lines.push("| Package | Confidence | Score | Workflow | Action |");
  lines.push("| --- | --- | ---: | --- | --- |");
  for (const plan of input.plans) {
    lines.push(
      `| ${escapeCell(plan.package.name ?? plan.package.relativePath)} | ${plan.confidence} | ${plan.score} | ${escapeCell(plan.workflowFile ?? "")} | ${escapeCell(plan.command ? "configure" : "review")} |`,
    );
  }
  lines.push("");

  lines.push("## Package Details");
  lines.push("");
  for (const plan of input.plans) {
    const checkedPlan = input.checkedPlans?.find((candidate) => candidate.plan === plan);
    const claimPlan = input.claimPlans?.find((candidate) => candidate.package === plan.package);
    const claimResult = input.claimResults?.find(
      (candidate) => candidate.claimPlan.package === plan.package,
    );
    const result = input.results?.find((candidate) => candidate.checkedPlan.plan === plan);
    const name = plan.package.name ?? plan.package.relativePath;

    lines.push(`### ${name}`);
    lines.push("");
    lines.push(`- Confidence: ${plan.confidence} (${plan.score})`);
    if (plan.workflowFile) {
      lines.push(`- Workflow: \`${plan.workflowFile}\``);
    }
    if (plan.environment) {
      lines.push(`- Environment: \`${plan.environment}\``);
    }
    lines.push(
      `- Permissions: publish=${plan.permissions.allowPublish}, stage=${plan.permissions.allowStagePublish}`,
    );
    if (claimPlan) {
      lines.push(`- Package claim action: ${claimPlan.action}`);
      lines.push(`- Package exists before claim: ${formatClaimPackageExists(claimPlan)}`);
      lines.push(`- Claim placeholder: ${claimPlan.version} (${claimPlan.tag})`);
    }
    if (claimResult) {
      lines.push(`- Package claim status: ${claimResult.status}`);
      if (claimResult.error) {
        lines.push(`- Package claim error: ${claimResult.error}`);
      }
    }
    if (checkedPlan) {
      lines.push(`- Npm check action: ${checkedPlan.action}`);
      lines.push(`- Package exists on npm: ${checkedPlan.packageExists ? "yes" : "no"}`);
      lines.push(`- Existing trusted publishers: ${checkedPlan.existingTrusts.length}`);
    }
    if (result) {
      lines.push(`- Apply status: ${result.status}`);
      if (result.error) {
        lines.push(`- Apply error: ${result.error}`);
      }
    }
    if (plan.command || claimPlan?.action === "claim") {
      lines.push("");
      lines.push("```sh");
      if (claimPlan?.action === "claim") {
        lines.push(claimPlan.command);
      }
      if (plan.command) {
        lines.push(plan.command);
      }
      lines.push("```");
    }
    appendList(lines, "Reasons", plan.reasons);
    appendList(lines, "Explain", plan.explain);
    if (checkedPlan?.trustDiffs.length) {
      lines.push("");
      lines.push("Trusted publisher drift:");
      for (const trustDiff of checkedPlan.trustDiffs) {
        const id = trustDiff.trust.id ?? "<unknown>";
        for (const fieldDiff of trustDiff.fields) {
          lines.push(`- ${id}: ${formatTrustFieldDiff(fieldDiff)}`);
        }
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function appendList(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) {
    return;
  }

  lines.push("");
  lines.push(`${title}:`);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}

function formatClaimPackageExists(claimPlan: PackageClaimPlan): string {
  if (claimPlan.packageExists === undefined) {
    return "not checked";
  }

  return claimPlan.packageExists ? "yes" : "no";
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
