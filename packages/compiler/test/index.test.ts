import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../src/index.js";

test("compile rewrites callCC to __unwinder.callCC", () => {
  const source = "const k = callCC((cont) => cont);";
  const result = compile(source);

  assert.equal(result.diagnostics.length, 0);
  assert.match(result.artifact.chunk, /__unwinder\.callCC/);

  const debugMap = result.artifact.debugMap as {
    metrics: { callCCRewrites: number };
  };
  assert.equal(debugMap.metrics.callCCRewrites, 1);
});

test("compile extracts delorean markers into debugMap", () => {
  const source = `
    delorean.insertTimepoint("tp1");
    delorean.insertBreakpoint("bp1");
  `;

  const result = compile(source);
  const debugMap = result.artifact.debugMap as {
    markers: Array<{ id: string; kind: string }>;
  };

  assert.equal(debugMap.markers.length, 2);
  assert.deepEqual(
    debugMap.markers.map((marker) => ({ id: marker.id, kind: marker.kind })),
    [
      { id: "tp1", kind: "timepoint" },
      { id: "bp1", kind: "breakpoint" },
    ],
  );
});

test("compile emits warning diagnostic for dynamic marker id", () => {
  const source = "delorean.insertTimepoint(timepointId);";
  const result = compile(source);

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.severity, "warning");
  assert.equal(result.diagnostics[0]?.code, "DYNAMIC_TIMEPOINT_ID");
});

test("compile returns parse diagnostic and fallback artifact on invalid source", () => {
  const source = "function broken( {";
  const result = compile(source);

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.severity, "error");
  assert.equal(result.artifact.chunk, source);
  assert.equal(typeof result.artifact.irHash, "string");
  assert.ok(result.artifact.irHash.length > 0);
});
