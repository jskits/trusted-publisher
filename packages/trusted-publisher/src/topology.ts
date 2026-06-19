import type { WorkspaceDiscovery } from "./discovery.js";
import type { PackageInfo } from "./packages.js";
import type { PublishCandidate } from "./workflows.js";

export type PublishTopologyKind = "conflict" | "global" | "hybrid" | "per-package" | "unknown";
export type PackagePublishStatus = "ambiguous" | "matched" | "unmatched";

export interface PackagePublishMapping {
  readonly candidates: readonly PublishCandidate[];
  readonly package: PackageInfo;
  readonly selectedCandidate?: PublishCandidate;
  readonly status: PackagePublishStatus;
}

export interface PublishTopology {
  readonly conflicts: readonly PackagePublishMapping[];
  readonly globalCandidates: readonly PublishCandidate[];
  readonly kind: PublishTopologyKind;
  readonly mappings: readonly PackagePublishMapping[];
  readonly unknownCandidates: readonly PublishCandidate[];
}

export function resolvePublishTopology(discovery: WorkspaceDiscovery): PublishTopology {
  const publishablePackages = discovery.packages.filter(
    (pkg) => pkg.publishable && Boolean(pkg.name),
  );
  const candidates = discovery.workflows.flatMap((workflow) => workflow.candidates);
  const globalCandidates = candidates.filter(
    (candidate) => candidate.packageSelector.kind === "all",
  );
  const unknownCandidates = candidates.filter(
    (candidate) => candidate.packageSelector.kind === "unknown",
  );
  const mappings = publishablePackages.map((pkg) =>
    createPackageMapping(
      pkg,
      candidates.filter((candidate) => matchesPackage(candidate, pkg)),
    ),
  );
  const conflicts = mappings.filter((mapping) => mapping.status === "ambiguous");

  return {
    conflicts,
    globalCandidates,
    kind: determineTopologyKind(mappings, globalCandidates),
    mappings,
    unknownCandidates,
  };
}

function createPackageMapping(
  pkg: PackageInfo,
  candidates: readonly PublishCandidate[],
): PackagePublishMapping {
  const result: {
    candidates: readonly PublishCandidate[];
    package: PackageInfo;
    selectedCandidate?: PublishCandidate;
    status: PackagePublishStatus;
  } = {
    candidates,
    package: pkg,
    status:
      candidates.length === 0 ? "unmatched" : candidates.length === 1 ? "matched" : "ambiguous",
  };

  if (candidates.length === 1 && candidates[0]) {
    result.selectedCandidate = candidates[0];
  }

  return result;
}

function determineTopologyKind(
  mappings: readonly PackagePublishMapping[],
  globalCandidates: readonly PublishCandidate[],
): PublishTopologyKind {
  if (mappings.every((mapping) => mapping.status === "unmatched")) {
    return "unknown";
  }

  if (mappings.some((mapping) => mapping.status === "ambiguous")) {
    return "conflict";
  }

  const matchedMappings = mappings.filter((mapping) => mapping.status === "matched");
  const allMatched = matchedMappings.length === mappings.length;
  const hasGlobal = globalCandidates.length > 0;
  const selectedCandidates = new Set(matchedMappings.map((mapping) => mapping.selectedCandidate));
  const hasSpecific = matchedMappings.some((mapping) =>
    mapping.candidates.some((candidate) => candidate.packageSelector.kind !== "all"),
  );

  if (allMatched && selectedCandidates.size === 1) {
    return "global";
  }

  if (!hasGlobal && hasSpecific && allMatched) {
    return "per-package";
  }

  if (matchedMappings.length > 0) {
    return "hybrid";
  }

  return "unknown";
}

function matchesPackage(candidate: PublishCandidate, pkg: PackageInfo): boolean {
  const selector = candidate.packageSelector;

  if (selector.kind === "all") {
    return true;
  }

  if (!selector.value) {
    return false;
  }

  if (selector.kind === "name") {
    return selector.value === pkg.name;
  }

  if (selector.kind === "path") {
    return normalizePath(selector.value) === normalizePath(pkg.relativePath);
  }

  if (selector.kind === "filter") {
    return matchesFilter(selector.value, pkg);
  }

  return false;
}

function matchesFilter(filter: string, pkg: PackageInfo): boolean {
  if (filter === pkg.name || filter === pkg.relativePath) {
    return true;
  }

  if (filter.includes("*") && pkg.name) {
    return globToRegExp(filter).test(pkg.name) || globToRegExp(filter).test(pkg.relativePath);
  }

  return normalizePath(filter) === normalizePath(pkg.relativePath);
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, ".*")}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
