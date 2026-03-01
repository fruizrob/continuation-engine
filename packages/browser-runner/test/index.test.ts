import test from "node:test";
import assert from "node:assert/strict";

import type { ProgramArtifact } from "@unwinder/contracts";

import { runBrowserArtifact } from "../src/index.js";

function createArtifact(): ProgramArtifact {
  return {
    version: "2.0",
    entry: "main",
    chunk: "const value = 1;",
    debugMap: {},
    irHash: "hash",
    instrumentationMode: "checkpoint-first",
  };
}

test("runBrowserArtifact auto-resumes by default and applies patch", () => {
  const report = runBrowserArtifact(createArtifact(), {
    checkpointId: "browser-tp",
    patch: { browser: true },
  });

  assert.equal(report.checkpointId, "browser-tp");
  assert.equal(report.resumeResult?.status, "resumed");
  assert.equal(report.scope.bindings.browser, true);
});

test("runBrowserArtifact can skip resume", () => {
  const report = runBrowserArtifact(createArtifact(), {
    autoResume: false,
  });

  assert.equal(report.runResult.status, "running");
  assert.equal(report.resumeResult, undefined);
  assert.ok(report.snapshotId.length > 0);
});
