import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProgramArtifact } from "@unwinder/contracts";

import { parsePatchInput, runNodeArtifact, runNodeCli } from "../src/index.js";

function createArtifact(): ProgramArtifact {
  return {
    version: "2.0",
    entry: "main",
    chunk: "const x = 1;",
    debugMap: {},
    irHash: "hash",
    instrumentationMode: "checkpoint-first",
  };
}

function repoRootFromPackage(): string {
  return path.resolve(process.cwd(), "../..");
}

function normalizeReportForGolden(report: unknown): unknown {
  return report;
}

test("parsePatchInput parses object JSON", () => {
  const patch = parsePatchInput('{"x": 1, "y": true}');
  assert.deepEqual(patch, { x: 1, y: true });
});

test("parsePatchInput rejects non-object JSON", () => {
  assert.throws(() => parsePatchInput("[]"), /Patch input must be a JSON object/);
});

test("runNodeArtifact compile command returns artifact without runtime state", () => {
  const report = runNodeArtifact(
    {
      source: "delorean.insertTimepoint('A')",
    },
    {
      command: "compile",
    },
  );

  assert.equal(report.command, "compile");
  assert.equal(report.diagnostics.length, 0);
  assert.equal(report.runResult, undefined);
  assert.equal(report.resumeResult, undefined);
});

test("runNodeArtifact run command resumes and applies patch", () => {
  const report = runNodeArtifact(
    {
      artifact: createArtifact(),
    },
    {
      command: "run",
      checkpointId: "tp-node",
      patch: { patched: 123 },
    },
  );

  assert.equal(report.command, "run");
  assert.equal(report.resumeResult?.status, "resumed");
  assert.equal(report.scope?.bindings.patched, 123);
  assert.ok(report.snapshotId);
});

test("runNodeArtifact replay command with unknown snapshot reports error", () => {
  const report = runNodeArtifact(
    {
      artifact: createArtifact(),
    },
    {
      command: "replay",
      snapshotId: "missing",
    },
  );

  assert.equal(report.resumeResult?.status, "error");
});

test("runNodeCli compile outputs JSON to stdout", async () => {
  const outputs: string[] = [];
  const errors: string[] = [];
  const io = {
    readFile: async (_path: string) => "delorean.insertTimepoint('A1');",
    writeFile: async (_path: string, _contents: string) => undefined,
    stdout: (message: string) => outputs.push(message),
    stderr: (message: string) => errors.push(message),
  };

  const exitCode = await runNodeCli(["compile", "input.js"], io);

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);
  assert.equal(outputs.length, 1);
  assert.match(outputs[0] ?? "", /"command": "compile"/);
});

test("runNodeCli writes output file when --out is provided", async () => {
  const files = new Map<string, string>();
  files.set("input.js", "delorean.insertTimepoint('B1');");

  const io = {
    readFile: async (filePath: string) => files.get(filePath) ?? "",
    writeFile: async (filePath: string, contents: string) => {
      files.set(filePath, contents);
    },
    stdout: (_message: string) => undefined,
    stderr: (_message: string) => undefined,
  };

  const exitCode = await runNodeCli(["run", "input.js", "--out", "report.json", "--patch", '{"v": 7}'], io);

  assert.equal(exitCode, 0);
  const content = files.get("report.json") ?? "";
  assert.match(content, /"command": "run"/);
  assert.match(content, /"v": 7/);
});

test("CLI executable entry unwinder compile works", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unwinder-cli-"));
  const inputFile = path.join(tempDir, "input.js");
  writeFileSync(inputFile, "delorean.insertTimepoint('CLI-TP');", "utf8");

  const cliPath = path.resolve(process.cwd(), "dist", "node-runner", "src", "cli.js");
  const result = spawnSync(process.execPath, [cliPath, "compile", inputFile], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"command": "compile"/);
});

test("node runner reports match golden fixtures", () => {
  const repoRoot = repoRootFromPackage();
  const sourcePath = path.join(repoRoot, "fixtures", "harness", "sources", "node-runner-basic.js");
  const source = readFileSync(sourcePath, "utf8");

  const compileReport = runNodeArtifact(
    { source },
    { command: "compile" },
  );
  const runReport = runNodeArtifact(
    { source },
    { command: "run", checkpointId: "golden-checkpoint", patch: { patched: 42 } },
  );
  const replayReport = runNodeArtifact(
    { source },
    { command: "replay", checkpointId: "golden-checkpoint", snapshotId: "missing-snapshot", patch: { patched: 42 } },
  );

  const goldenDir = path.join(repoRoot, "fixtures", "harness", "golden", "node-runner");
  const goldenCompile = JSON.parse(readFileSync(path.join(goldenDir, "compile.json"), "utf8"));
  const goldenRun = JSON.parse(readFileSync(path.join(goldenDir, "run.json"), "utf8"));
  const goldenReplay = JSON.parse(readFileSync(path.join(goldenDir, "replay.json"), "utf8"));

  assert.deepEqual(normalizeReportForGolden(compileReport), goldenCompile);
  assert.deepEqual(normalizeReportForGolden(runReport), goldenRun);
  assert.deepEqual(normalizeReportForGolden(replayReport), goldenReplay);
});
