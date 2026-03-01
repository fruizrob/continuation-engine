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
