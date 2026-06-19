import { checkRuntimePrerequisites, formatRuntimePrerequisiteIssues } from "./prerequisites.js";

describe("runtime prerequisites", () => {
  it("accepts supported Node.js and npm CLI versions", () => {
    expect(
      checkRuntimePrerequisites({
        nodeVersion: "22.14.0",
        npmVersion: "11.15.0",
      }),
    ).toEqual([]);
  });

  it("reports unsupported runtime versions", () => {
    const issues = checkRuntimePrerequisites({
      nodeVersion: "20.19.0",
      npmVersion: "10.9.0",
    });

    expect(formatRuntimePrerequisiteIssues(issues)).toBe(
      [
        "Node.js >= 22.14.0 is required; found 20.19.0.",
        "npm CLI >= 11.15.0 is required; found 10.9.0.",
      ].join("\n"),
    );
  });
});
