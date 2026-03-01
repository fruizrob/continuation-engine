import test from "node:test";
import assert from "node:assert/strict";

import type { ProgramArtifact } from "@unwinder/contracts";

import { createDebugSession } from "../src/index.js";

function makeArtifact(): ProgramArtifact {
  return {
    version: "2.0",
    entry: "main",
    chunk: "const n = 1;",
    debugMap: {},
    irHash: "hash",
    instrumentationMode: "checkpoint-first",
  };
}

test("createDebugSession run/step/pause lifecycle", () => {
  const session = createDebugSession(makeArtifact(), { mode: "debug" });

  const runResult = session.run();
  assert.equal(runResult.status, "running");

  const stepResult = session.step();
  assert.equal(stepResult.status, "paused");
  assert.equal(stepResult.stepIndex, 1);

  let pausedReason = "";
  session.on("paused", ({ reason }) => {
    pausedReason = reason ?? "";
  });
  session.pause("manual-test");
  assert.equal(pausedReason, "manual-test");

  session.dispose();
});

test("checkpoint/resume applies patch and one-shot semantics", () => {
  const session = createDebugSession(makeArtifact(), { mode: "debug", oneShotDefault: true });

  const snapshotId = session.checkpoint("tp1");
  const resumed = session.resume(snapshotId, { updated: 42 });
  assert.equal(resumed.status, "resumed");

  const inspect = session.inspect();
  assert.equal(inspect.bindings.updated, 42);

  const secondResume = session.resume(snapshotId);
  assert.equal(secondResume.status, "error");

  session.dispose();
});

test("cloneContinuation allows replay after first resume", () => {
  const session = createDebugSession(makeArtifact(), { mode: "debug", oneShotDefault: true });

  const snapshotId = session.checkpoint("tp2");
  const cloneId = session.cloneContinuation(snapshotId);

  const first = session.resume(snapshotId, { value: 1 });
  const second = session.resume(cloneId, { value: 2 });

  assert.equal(first.status, "resumed");
  assert.equal(second.status, "resumed");
  assert.ok(second.timelineId > first.timelineId);

  session.dispose();
});

test("evaluate runs expression against restored scope", () => {
  const session = createDebugSession(makeArtifact(), { mode: "debug" });

  const snapshotId = session.checkpoint("tp3");
  session.resume(snapshotId, { a: 10, b: 32 });

  const evalResult = session.evaluate("a + b");
  assert.equal(evalResult.ok, true);
  assert.equal(evalResult.value, 42);

  session.dispose();
});
