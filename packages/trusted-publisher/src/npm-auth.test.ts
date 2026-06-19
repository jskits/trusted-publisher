import { EventEmitter } from "node:events";

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcess);

import { createNpmCliClient } from "./npm.js";

describe("npm trust authentication", () => {
  const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  beforeEach(() => {
    childProcess.execFile.mockReset();
    childProcess.spawn.mockReset();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    restoreProperty(process.stdin, "isTTY", stdinIsTty);
    restoreProperty(process.stdout, "isTTY", stdoutIsTty);
    vi.restoreAllMocks();
  });

  it("runs one interactive trust request after a browser OTP challenge and retries JSON", async () => {
    childProcess.execFile
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(webOtpError());
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, { stdout: "[]" });
      });
    childProcess.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    const trusts = await createNpmCliClient().listTrust("@scope/a");

    expect(trusts).toEqual([]);
    expect(childProcess.spawn).toHaveBeenCalledWith("npm", ["trust", "list", "@scope/a"], {
      stdio: "inherit",
    });
    expect(childProcess.execFile).toHaveBeenCalledTimes(2);
  });

  it("returns actionable guidance when interactive authentication is disabled", async () => {
    childProcess.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(webOtpError());
    });

    const result = createNpmCliClient({ interactiveAuth: false }).listTrust("@scope/a");

    await expect(result).rejects.toThrow(
      "Run `npm trust list @scope/a` in an interactive terminal",
    );
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("refreshes authentication with a read-only trust request before retrying a mutation", async () => {
    childProcess.execFile
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(webOtpError());
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, { stdout: "" });
      });
    childProcess.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });
    const client = createNpmCliClient();

    await client.createTrust(createPlan());

    expect(childProcess.spawn).toHaveBeenCalledWith("npm", ["trust", "list", "@scope/a"], {
      stdio: "inherit",
    });
    expect(childProcess.execFile).toHaveBeenCalledTimes(2);
  });
});

function webOtpError(): Error & { stderr: string } {
  return Object.assign(new Error("Command failed: npm trust list @scope/a --json"), {
    stderr:
      "npm error code EOTP\n" +
      "npm error Open this URL in your browser to authenticate:\n" +
      "npm error https://www.npmjs.com/auth/cli/redacted",
  });
}

function createPlan() {
  return {
    confidence: "high" as const,
    evidence: [],
    explain: [],
    package: {
      directory: "/repo/packages/a",
      name: "@scope/a",
      private: false,
      publishable: true,
      relativePath: "packages/a",
      skipReasons: [],
      version: "1.0.0",
    },
    permissions: { allowPublish: true, allowStagePublish: false },
    reasons: [],
    repository: "owner/repo",
    score: 100,
    trustArgs: [
      "npm",
      "trust",
      "github",
      "@scope/a",
      "--repo",
      "owner/repo",
      "--file",
      "release.yml",
      "--allow-publish",
      "--yes",
    ],
    workflowFile: "release.yml",
  };
}

function restoreProperty(
  target: NodeJS.ReadStream | NodeJS.WriteStream,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }
  Reflect.deleteProperty(target, property);
}
