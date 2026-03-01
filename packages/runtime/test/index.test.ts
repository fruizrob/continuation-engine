import test from "node:test";
import assert from "node:assert/strict";

import type { EventLogEntry, ProgramArtifact } from "@unwinder/contracts";

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

function makeLoweredArtifact(): ProgramArtifact {
  return {
    version: "2.0",
    entry: "main",
    chunk: "const n = 1;",
    debugMap: {
      lowering: {
        version: 1,
        entryPc: 0,
        opcodes: [
          { pc: 0, op: "STMT", nextPc: 1 },
          { pc: 1, op: "CHECKPOINT", nextPc: 2, arg: { id: "tp-step" } },
          { pc: 2, op: "STMT", nextPc: 3 },
          { pc: 3, op: "BREAKPOINT", nextPc: 4, arg: { id: "bp-step" } },
          { pc: 4, op: "STMT", nextPc: -1 },
        ],
        pcToLoc: {
          "0": { line: 1, column: 0 },
          "1": { line: 2, column: 0 },
          "2": { line: 3, column: 0 },
          "3": { line: 4, column: 0 },
          "4": { line: 5, column: 0 },
        },
      },
    },
    irHash: "hash-lowered",
    instrumentationMode: "checkpoint-first",
  };
}

function getTransitionAssertions(log: EventLogEntry[]): EventLogEntry[] {
  return log.filter((entry) => entry.op === "opcode.transition.assert");
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

test("pc-driven step consumes lowered opcodes and emits loc + boundary pauses", () => {
  const session = createDebugSession(makeLoweredArtifact(), { mode: "debug" });
  const pausedReasons: string[] = [];

  session.on("paused", ({ reason }) => {
    if (reason) {
      pausedReasons.push(reason);
    }
  });

  session.run();

  const step1 = session.step();
  assert.equal(step1.status, "paused");
  assert.equal(step1.stepIndex, 1);
  assert.deepEqual(step1.loc, { line: 1, column: 0 });

  const step2 = session.step();
  assert.equal(step2.status, "paused");
  assert.equal(step2.stepIndex, 2);
  assert.deepEqual(step2.loc, { line: 2, column: 0 });

  const step3 = session.step();
  assert.equal(step3.status, "paused");
  assert.equal(step3.stepIndex, 3);
  assert.deepEqual(step3.loc, { line: 3, column: 0 });

  const step4 = session.step();
  assert.equal(step4.status, "paused");
  assert.equal(step4.stepIndex, 4);
  assert.deepEqual(step4.loc, { line: 4, column: 0 });

  const step5 = session.step();
  assert.equal(step5.status, "finished");
  assert.equal(step5.stepIndex, 5);
  assert.deepEqual(step5.loc, { line: 5, column: 0 });

  assert.ok(pausedReasons.includes("checkpoint:tp-step"));
  assert.ok(pausedReasons.includes("breakpoint:bp-step"));

  session.dispose();
});

test("pc-driven continue pauses on checkpoint/breakpoint and then finishes", () => {
  const session = createDebugSession(makeLoweredArtifact(), { mode: "debug" });
  session.run();

  const firstContinue = session.continue();
  assert.equal(firstContinue.status, "paused");
  assert.equal(firstContinue.reason, "checkpoint:tp-step");

  const secondContinue = session.continue();
  assert.equal(secondContinue.status, "paused");
  assert.equal(secondContinue.reason, "breakpoint:bp-step");

  const finalContinue = session.continue();
  assert.equal(finalContinue.status, "finished");

  session.dispose();
});

test("checkpoint/resume restores machine pc for lowerings", () => {
  const session = createDebugSession(makeLoweredArtifact(), { mode: "debug" });
  session.run();

  const firstStep = session.step();
  assert.equal(firstStep.status, "paused");
  assert.equal(firstStep.stepIndex, 1);

  const snapshotId = session.checkpoint("pc-save");

  const secondStep = session.step();
  assert.equal(secondStep.status, "paused");
  assert.equal(secondStep.stepIndex, 2);

  const resumed = session.resume(snapshotId);
  assert.equal(resumed.status, "resumed");

  const stepAfterResume = session.step();
  assert.equal(stepAfterResume.status, "paused");
  assert.equal(stepAfterResume.stepIndex, 2);
  assert.deepEqual(stepAfterResume.loc, { line: 2, column: 0 });

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

test("opcode transitions emit deterministic assertion log entries", () => {
  const session = createDebugSession(makeLoweredArtifact(), { mode: "debug", oneShotDefault: true });
  session.run();

  const first = session.continue();
  assert.equal(first.status, "paused");

  const second = session.continue();
  assert.equal(second.status, "paused");

  const final = session.continue();
  assert.equal(final.status, "finished");

  const assertions = getTransitionAssertions(session.getDeterminismLog());
  assert.equal(assertions.length, 5);
  assert.ok(assertions.every((entry) => {
    if (typeof entry.output !== "object" || entry.output === null) {
      return false;
    }

    const output = entry.output as { ok?: unknown };
    return output.ok === true;
  }));

  session.dispose();
});
