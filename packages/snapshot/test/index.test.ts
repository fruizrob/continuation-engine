import test from "node:test";
import assert from "node:assert/strict";

import { captureHeap, restoreHeap } from "../src/index.js";

test("captureHeap + restoreHeap roundtrip object graphs and patch", () => {
  const source = {
    bindings: {
      counter: 1,
      nested: { ok: true },
      list: [1, 2, 3],
    },
  };

  const snapshot = captureHeap(
    [{ id: "bindings", path: "bindings", kind: "runtime" }],
    {
      strategy: "rooted-graph",
      includeGlobals: false,
      maxGraphNodes: 100,
    },
    source,
  );

  const restored = restoreHeap(snapshot, { patched: true });
  assert.equal(restored.ok, true);
  assert.equal(restored.state.patched, true);

  const bindings = restored.state.bindings as {
    counter: number;
    nested: { ok: boolean };
    list: number[];
  };

  assert.equal(bindings.counter, 1);
  assert.equal(bindings.nested.ok, true);
  assert.deepEqual(bindings.list, [1, 2, 3]);
});

test("captureHeap tracks unsupported values", () => {
  const source = {
    bindings: {
      fn: () => 1,
      symbol: Symbol("x"),
    },
  };

  const snapshot = captureHeap(
    [{ id: "bindings", path: "bindings", kind: "runtime" }],
    {
      strategy: "rooted-graph",
      includeGlobals: false,
      maxGraphNodes: 100,
    },
    source,
  );

  assert.ok(snapshot.unsupported.length >= 2);
  assert.ok(snapshot.unsupported.some((entry) => entry.kind === "function"));
  assert.ok(snapshot.unsupported.some((entry) => entry.kind === "symbol"));
});

test("captureHeap marks missing roots as unsupported", () => {
  const snapshot = captureHeap(
    [{ id: "missing", path: "does.not.exist", kind: "runtime" }],
    {
      strategy: "rooted-graph",
      includeGlobals: false,
      maxGraphNodes: 100,
    },
    { bindings: {} },
  );

  assert.equal(snapshot.graph.length, 0);
  assert.equal(snapshot.unsupported.length, 1);
  assert.equal(snapshot.unsupported[0]?.kind, "missing-root");
});
