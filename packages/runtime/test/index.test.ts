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
  assert.equal(session.inspect().bindings.value, 2);

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

test("timeline branching keeps distinct timeline ids and consumed semantics", () => {
  const session = createDebugSession(makeArtifact(), { mode: "debug", oneShotDefault: true });

  const baseSnapshot = session.checkpoint("branch-base");
  const branchSnapshot = session.cloneContinuation(baseSnapshot);

  const mainBranchResume = session.resume(baseSnapshot, { branch: "main" });
  const altBranchResume = session.resume(branchSnapshot, { branch: "alt" });
  const consumedResume = session.resume(baseSnapshot, { branch: "invalid" });

  assert.equal(mainBranchResume.status, "resumed");
  assert.equal(altBranchResume.status, "resumed");
  assert.notEqual(mainBranchResume.timelineId, altBranchResume.timelineId);
  assert.equal(consumedResume.status, "error");
  assert.equal(session.inspect().bindings.branch, "alt");

  session.dispose();
});

test("determinism log captures operation sequence and supports replay loading", () => {
  const session = createDebugSession(makeArtifact(), { mode: "debug", oneShotDefault: true });
  const runResult = session.run();
  assert.equal(runResult.status, "running");

  const snapshot = session.checkpoint("determinism");
  const resumeResult = session.resume(snapshot, { x: 10, y: 2 });
  assert.equal(resumeResult.status, "resumed");

  const evalResult = session.evaluate("x / y");
  assert.equal(evalResult.ok, true);
  assert.equal(evalResult.value, 5);

  const log = session.getDeterminismLog();
  const ops = log.map((entry) => entry.op);
  assert.ok(ops.includes("run"));
  assert.ok(ops.includes("checkpoint"));
  assert.ok(ops.includes("resume"));
  assert.ok(ops.includes("evaluate"));

  const replaySession = createDebugSession(makeArtifact(), { mode: "debug", oneShotDefault: true });
  replaySession.loadDeterminismLog(log);
  assert.deepEqual(replaySession.getDeterminismLog(), log);

  session.dispose();
  replaySession.dispose();
});
