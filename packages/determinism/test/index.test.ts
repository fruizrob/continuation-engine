import test from "node:test";
import assert from "node:assert/strict";

import { createDeterminismController } from "../src/index.js";

test("determinism controller records sequential events", () => {
  let now = 100;
  const controller = createDeterminismController(() => {
    now += 5;
    return now;
  });

  const first = controller.record("clock", "Date.now", null, 101);
  const second = controller.record("rng", "Math.random", null, 0.5);

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.timestampMs, 105);
  assert.equal(second.timestampMs, 110);
});

test("determinism controller supports replay and filtering", () => {
  const controller = createDeterminismController(() => 1);
  controller.replay([
    {
      seq: 3,
      kind: "timer",
      op: "setTimeout",
      input: { ms: 1 },
      output: 123,
      timestampMs: 1,
    },
    {
      seq: 4,
      kind: "io",
      op: "readFile",
      input: "a.txt",
      output: "ok",
      timestampMs: 2,
    },
  ]);

  const from4 = controller.getLog(4);
  assert.equal(from4.length, 1);
  assert.equal(from4[0]?.op, "readFile");
});
