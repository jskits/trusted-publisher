import { readFileSync } from "node:fs";

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

describe("published package manifest", () => {
  it("does not expose pnpm catalog protocol dependencies to npm", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;

    for (const sectionName of dependencySections) {
      for (const [dependencyName, specifier] of Object.entries(manifest[sectionName] ?? {})) {
        expect(specifier, `${sectionName}.${dependencyName}`).not.toMatch(/^catalog:/);
      }
    }
  });
});
