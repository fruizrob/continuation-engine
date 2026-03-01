import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

const sourcePath = path.join(repoRoot, "fixtures", "harness", "sources", "node-runner-basic.js");
const outputDir = path.join(repoRoot, "fixtures", "harness", "golden", "node-runner");

const source = await readFile(sourcePath, "utf8");

const nodeRunnerModulePath = path.join(
  repoRoot,
  "packages",
  "node-runner",
  "dist",
  "node-runner",
  "src",
  "index.js",
);

const { runNodeArtifact } = await import(nodeRunnerModulePath);

const compileReport = runNodeArtifact(
  { source },
  {
    command: "compile",
  },
);

const runReport = runNodeArtifact(
  { source },
  {
    command: "run",
    checkpointId: "golden-checkpoint",
    patch: { patched: 42 },
  },
);

const mismatchLog = [...(runReport.determinismLog ?? [])];
if (mismatchLog.length > 0) {
  mismatchLog[0] = {
    ...mismatchLog[0],
    op: "mismatch-op",
  };
}

const replayReport = runNodeArtifact(
  { source },
  {
    command: "replay",
    checkpointId: "golden-checkpoint",
    patch: { patched: 42 },
    expectedDeterminismLog: mismatchLog,
  },
);

await mkdir(outputDir, { recursive: true });

await writeFile(path.join(outputDir, "compile.json"), `${JSON.stringify(compileReport, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDir, "run.json"), `${JSON.stringify(runReport, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDir, "replay.json"), `${JSON.stringify(replayReport, null, 2)}\n`, "utf8");

process.stdout.write(`golden-refresh-ok ${outputDir}\n`);
