import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../src/index.js";

type CompilerDebugMap = {
  version: number;
  markers: Array<{ id: string; kind: string; loc?: { line: number; column: number } }>;
  metrics: {
    callCCRewrites: number;
    irInstructions: number;
    loweredOpcodes: number;
    loopEntries: number;
    tryEntries: number;
    functionEntries: number;
  };
  ir: {
    instructions: Array<{
      index: number;
      op: string;
      loc?: { line: number; column: number };
      arg?: Record<string, unknown>;
    }>;
  };
  lowering: {
    opcodes: Array<{
      pc: number;
      op: string;
      nextPc: number;
    }>;
  };
  stepMap: {
    locToPc: Record<string, number[]>;
    pcToLoc: Record<string, { line: number; column: number }>;
  };
};

test("compile rewrites callCC to __unwinder.callCC", () => {
  const source = "const k = callCC((cont) => cont);";
  const result = compile(source);

  assert.equal(result.diagnostics.length, 0);
  assert.match(result.artifact.chunk, /__unwinder\.callCC/);

  const debugMap = result.artifact.debugMap as CompilerDebugMap;
  assert.equal(debugMap.metrics.callCCRewrites, 1);
  assert.ok(debugMap.ir.instructions.some((instruction) => instruction.op === "CALL_CC"));
});

test("compile extracts delorean markers into debugMap", () => {
  const source = `
    delorean.insertTimepoint("tp1");
    delorean.insertBreakpoint("bp1");
  `;

  const result = compile(source);
  const debugMap = result.artifact.debugMap as CompilerDebugMap;

  assert.equal(debugMap.markers.length, 2);
  assert.deepEqual(
    debugMap.markers.map((marker) => ({ id: marker.id, kind: marker.kind })),
    [
      { id: "tp1", kind: "timepoint" },
      { id: "bp1", kind: "breakpoint" },
    ],
  );
  assert.ok(debugMap.ir.instructions.some((instruction) => instruction.op === "CHECKPOINT"));
  assert.ok(debugMap.ir.instructions.some((instruction) => instruction.op === "BREAKPOINT"));
});

test("compile emits warning diagnostic for dynamic marker id", () => {
  const source = "delorean.insertTimepoint(timepointId);";
  const result = compile(source);

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.severity, "warning");
  assert.equal(result.diagnostics[0]?.code, "DYNAMIC_TIMEPOINT_ID");
});

test("compile lowers control flow into IR and opcodes", () => {
  const source = `
    function workflow(items) {
      for (const item of items) {
        try {
          delorean.insertTimepoint("loop-tp");
          const k = callCC((cont) => cont);
          if (k) {
            return item;
          }
        } catch (error) {
          return error;
        } finally {
          delorean.insertBreakpoint("loop-bp");
        }
      }
      return null;
    }
  `;

  const result = compile(source);
  const debugMap = result.artifact.debugMap as CompilerDebugMap;
  const ops = debugMap.ir.instructions.map((instruction) => instruction.op);

  assert.ok(ops.includes("FN_ENTER"));
  assert.ok(ops.includes("LOOP_ENTER"));
  assert.ok(ops.includes("TRY_ENTER"));
  assert.ok(ops.includes("CATCH_ENTER"));
  assert.ok(ops.includes("FINALLY_ENTER"));
  assert.ok(ops.includes("CALL_CC"));
  assert.ok(ops.includes("CHECKPOINT"));
  assert.ok(ops.includes("BREAKPOINT"));

  assert.equal(debugMap.metrics.irInstructions, debugMap.ir.instructions.length);
  assert.equal(debugMap.metrics.loweredOpcodes, debugMap.lowering.opcodes.length);
  assert.ok(debugMap.metrics.loopEntries >= 1);
  assert.ok(debugMap.metrics.tryEntries >= 1);
  assert.ok(debugMap.metrics.functionEntries >= 1);
  assert.ok(debugMap.lowering.opcodes.every((opcode, index) => opcode.pc === index));
});

test("compile builds step map for opcode/source lookup", () => {
  const source = `
    const a = 1;
    delorean.insertTimepoint("tp-loc");
    const b = a + 2;
  `;

  const result = compile(source);
  const debugMap = result.artifact.debugMap as CompilerDebugMap;
  const checkpointInstruction = debugMap.ir.instructions.find((instruction) => instruction.op === "CHECKPOINT");

  assert.ok(checkpointInstruction);
  assert.ok(checkpointInstruction?.loc);

  const loc = checkpointInstruction.loc;
  const locKey = `${loc.line}:${loc.column}`;
  const pcsAtLoc = debugMap.stepMap.locToPc[locKey];

  assert.ok(Array.isArray(pcsAtLoc));
  assert.ok(pcsAtLoc.includes(checkpointInstruction.index));
  assert.deepEqual(debugMap.stepMap.pcToLoc[String(checkpointInstruction.index)], checkpointInstruction.loc);
});

test("compile returns parse diagnostic and fallback artifact on invalid source", () => {
  const source = "function broken( {";
  const result = compile(source);

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.severity, "error");
  assert.equal(result.artifact.chunk, source);
  assert.equal(typeof result.artifact.irHash, "string");
  assert.ok(result.artifact.irHash.length > 0);

  const debugMap = result.artifact.debugMap as CompilerDebugMap;
  assert.equal(debugMap.metrics.irInstructions, 0);
  assert.equal(debugMap.lowering.opcodes.length, 0);
});
