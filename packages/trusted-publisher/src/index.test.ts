import { Writable } from "node:stream";

import { createProgram, readPackageVersion, runCli } from "./index.js";

class MemoryWritable extends Writable {
  public chunks: string[] = [];

  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: () => void,
  ): void {
    this.chunks.push(chunk.toString());
    done();
  }

  public override toString(): string {
    return this.chunks.join("");
  }
}

describe("trusted-publisher CLI", () => {
  it("creates the expected command", () => {
    const program = createProgram();

    expect(program.name()).toBe("trusted-publisher");
  });

  it("reads the package version", () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints the scan summary", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();

    await runCli({
      argv: ["--dry-run"],
      io: { stderr, stdout },
    });

    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toContain("trusted-publisher scan");
    expect(stdout.toString()).toContain("Dry run: no npm changes will be made.");
  });

  it("prints the version without treating Commander exit as a failure", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();

    await runCli({
      argv: ["--version"],
      io: { stderr, stdout },
    });

    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toMatch(/^0\.1\.0\n$/);
  });
});
