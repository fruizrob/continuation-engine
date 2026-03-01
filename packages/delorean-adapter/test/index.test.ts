import test from "node:test";
import assert from "node:assert/strict";

import { compileForDelorean, createDeloreanSession, resumeTimepoint } from "../src/index.js";

test("compileForDelorean builds timepoint index from source markers", () => {
  const source = `
    const k = callCC((cont) => cont);
    delorean.insertTimepoint("A1");
    delorean.insertBreakpoint("B1");
  `;

  const result = compileForDelorean(source);

  assert.ok(result.timepointIndex.A1);
  assert.ok(result.timepointIndex.B1);
  assert.equal(result.timepointIndex.A1?.label, "timepoint");
  assert.match(result.artifact.chunk, /__unwinder\.callCC/);
});

test("resumeTimepoint resolves checkpoint id to snapshot id", () => {
  const source = `delorean.insertTimepoint("ResumeHere");`;
  const { artifact } = compileForDelorean(source);

  const session = createDeloreanSession(artifact, { mode: "debug" });
  session.checkpoint("ResumeHere");

  const resumed = resumeTimepoint(session, "ResumeHere", { fixed: true });
  assert.equal(resumed.status, "resumed");

  const scope = session.inspect();
  assert.equal(scope.bindings.fixed, true);

  session.dispose();
});

test("adapter/runtime integration supports timeline branching", () => {
  const source = `delorean.insertTimepoint("BranchPoint");`;
  const { artifact } = compileForDelorean(source);

  const session = createDeloreanSession(artifact, { mode: "debug", oneShotDefault: true });
  const baseSnapshot = session.checkpoint("BranchPoint");
  const branchSnapshot = session.cloneContinuation(baseSnapshot);

  const mainResume = resumeTimepoint(session, "BranchPoint", { branch: "main" });
  const altResume = session.resume(branchSnapshot, { branch: "alt" });

  assert.equal(mainResume.status, "resumed");
  assert.equal(altResume.status, "resumed");
  assert.notEqual(mainResume.timelineId, altResume.timelineId);
  assert.equal(session.inspect().bindings.branch, "alt");

  session.dispose();
});

test("adapter/runtime integration exposes deterministic event log assertions", () => {
  const source = `delorean.insertTimepoint("DeterministicPoint");`;
  const { artifact } = compileForDelorean(source);

  const session = createDeloreanSession(artifact, { mode: "debug", oneShotDefault: true });
  session.run();
  session.checkpoint("DeterministicPoint");
  resumeTimepoint(session, "DeterministicPoint", { a: 1, b: 2 });
  session.evaluate("a + b");

  const log = session.getDeterminismLog();
  const ops = log.map((entry) => entry.op);

  assert.ok(ops.includes("run"));
  assert.ok(ops.includes("checkpoint"));
  assert.ok(ops.includes("resume"));
  assert.ok(ops.includes("evaluate"));
  assert.ok(log.length >= 4);

  session.dispose();
});
