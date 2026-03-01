import { createHash } from "node:crypto";

import { parse } from "@babel/parser";
import generateModule from "@babel/generator";
import traverseModule, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";

import type {
  CompileOptions,
  CompileResult,
  Diagnostic,
  ProgramArtifact,
  SourceLoc,
} from "@unwinder/contracts";

const generate = "default" in generateModule ? generateModule.default : generateModule;
const traverse = "default" in traverseModule ? traverseModule.default : traverseModule;

type DebugMarker = {
  id: string;
  kind: "timepoint" | "breakpoint";
  loc?: SourceLoc;
};

type IROpcode =
  | "STMT"
  | "CALL_CC"
  | "CHECKPOINT"
  | "BREAKPOINT"
  | "LOOP_ENTER"
  | "LOOP_EXIT"
  | "TRY_ENTER"
  | "TRY_EXIT"
  | "CATCH_ENTER"
  | "CATCH_EXIT"
  | "FINALLY_ENTER"
  | "FINALLY_EXIT"
  | "FN_ENTER"
  | "FN_EXIT";

type IRInstruction = {
  index: number;
  op: IROpcode;
  loc?: SourceLoc;
  arg?: Record<string, unknown>;
};

type IRProgram = {
  version: 1;
  instructions: IRInstruction[];
};

type LoweredOpcode = {
  pc: number;
  op: IROpcode;
  nextPc: number;
  arg?: Record<string, unknown>;
};

type LoweredProgram = {
  version: 1;
  entryPc: number;
  opcodes: LoweredOpcode[];
  pcToLoc: Record<string, SourceLoc>;
  locToPc: Record<string, number[]>;
};

type InternalDebugMap = {
  version: 2;
  markers: DebugMarker[];
  metrics: {
    callCCRewrites: number;
    irInstructions: number;
    loweredOpcodes: number;
    loopEntries: number;
    tryEntries: number;
    functionEntries: number;
  };
  ir: IRProgram;
  lowering: LoweredProgram;
  stepMap: {
    pcToLoc: Record<string, SourceLoc>;
    locToPc: Record<string, number[]>;
  };
};

const DEFAULT_OPTIONS: CompileOptions = {
  target: "node",
  sourceMap: false,
  instrumentation: "checkpoint-first",
};

function toLoc(loc: t.SourceLocation | null | undefined): SourceLoc | undefined {
  if (!loc) {
    return undefined;
  }

  return {
    line: loc.start.line,
    column: loc.start.column,
  };
}

function hashArtifact(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildParseErrorDiagnostic(error: unknown): Diagnostic {
  if (!(error instanceof Error)) {
    return {
      code: "PARSE_UNKNOWN",
      message: "Unknown parse error",
      severity: "error",
    };
  }

  const diagnostic: Diagnostic = {
    code: "PARSE_ERROR",
    message: error.message,
    severity: "error",
  };

  const withLoc = error as Error & {
    loc?: {
      line: number;
      column: number;
    };
  };

  if (withLoc.loc) {
    diagnostic.loc = {
      line: withLoc.loc.line,
      column: withLoc.loc.column,
    };
  }

  return diagnostic;
}

function getMarkerFromCall(call: t.CallExpression): DebugMarker | null {
  if (!t.isMemberExpression(call.callee) || call.callee.computed) {
    return null;
  }

  if (!t.isIdentifier(call.callee.object, { name: "delorean" })) {
    return null;
  }

  if (!t.isIdentifier(call.callee.property)) {
    return null;
  }

  const methodName = call.callee.property.name;
  if (methodName !== "insertTimepoint" && methodName !== "insertBreakpoint") {
    return null;
  }

  const firstArg = call.arguments.at(0);
  const id = t.isStringLiteral(firstArg)
    ? firstArg.value
    : `dynamic:${call.loc?.start.line ?? 0}:${call.loc?.start.column ?? 0}`;

  const marker: DebugMarker = {
    id,
    kind: methodName === "insertTimepoint" ? "timepoint" : "breakpoint",
  };
  const loc = toLoc(call.loc);
  if (loc) {
    marker.loc = loc;
  }

  return marker;
}

function isRuntimeCallCCCallee(callee: t.CallExpression["callee"]): boolean {
  return (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.object, { name: "__unwinder" }) &&
    t.isIdentifier(callee.property, { name: "callCC" })
  );
}

function isLoopNode(node: t.Node): node is t.ForStatement | t.ForInStatement | t.ForOfStatement | t.WhileStatement | t.DoWhileStatement {
  return (
    t.isForStatement(node) ||
    t.isForInStatement(node) ||
    t.isForOfStatement(node) ||
    t.isWhileStatement(node) ||
    t.isDoWhileStatement(node)
  );
}

function getFunctionLabel(path: NodePath<t.Function>): string {
  if ((t.isFunctionDeclaration(path.node) || t.isFunctionExpression(path.node)) && path.node.id) {
    return path.node.id.name;
  }

  const parentNode = path.parentPath?.node;
  if (parentNode && t.isVariableDeclarator(parentNode) && t.isIdentifier(parentNode.id)) {
    return parentNode.id.name;
  }
  if (parentNode && t.isObjectProperty(parentNode) && t.isIdentifier(parentNode.key)) {
    return parentNode.key.name;
  }

  return "anonymous";
}

function pushInstruction(
  instructions: IRInstruction[],
  op: IROpcode,
  loc: t.SourceLocation | null | undefined,
  arg?: Record<string, unknown>,
): void {
  const instruction: IRInstruction = {
    index: instructions.length,
    op,
  };

  const normalizedLoc = toLoc(loc);
  if (normalizedLoc) {
    instruction.loc = normalizedLoc;
  }

  if (arg && Object.keys(arg).length > 0) {
    instruction.arg = arg;
  }

  instructions.push(instruction);
}

function buildIR(ast: t.File): IRProgram {
  const instructions: IRInstruction[] = [];

  traverse(ast, {
    enter(path: NodePath<t.Node>) {
      const { node } = path;

      if (t.isFunction(node)) {
        pushInstruction(instructions, "FN_ENTER", node.loc, { name: getFunctionLabel(path as NodePath<t.Function>) });
      }

      if (isLoopNode(node)) {
        pushInstruction(instructions, "LOOP_ENTER", node.loc, { kind: node.type });
      }

      if (t.isTryStatement(node)) {
        pushInstruction(instructions, "TRY_ENTER", node.loc);
      }

      if (t.isCatchClause(node)) {
        pushInstruction(instructions, "CATCH_ENTER", node.loc);
      }

      if (
        t.isBlockStatement(node) &&
        path.parentPath &&
        t.isTryStatement(path.parentPath.node) &&
        path.key === "finalizer"
      ) {
        pushInstruction(instructions, "FINALLY_ENTER", node.loc);
      }

      if (t.isCallExpression(node)) {
        const marker = getMarkerFromCall(node);
        if (marker) {
          pushInstruction(
            instructions,
            marker.kind === "timepoint" ? "CHECKPOINT" : "BREAKPOINT",
            node.loc,
            { id: marker.id },
          );
        }

        if (isRuntimeCallCCCallee(node.callee)) {
          pushInstruction(instructions, "CALL_CC", node.loc);
        }
      }

      if (path.isStatement()) {
        pushInstruction(instructions, "STMT", node.loc, { type: node.type });
      }
    },
    exit(path: NodePath<t.Node>) {
      const { node } = path;

      if (t.isFunction(node)) {
        pushInstruction(instructions, "FN_EXIT", node.loc, { name: getFunctionLabel(path as NodePath<t.Function>) });
      }

      if (isLoopNode(node)) {
        pushInstruction(instructions, "LOOP_EXIT", node.loc, { kind: node.type });
      }

      if (t.isCatchClause(node)) {
        pushInstruction(instructions, "CATCH_EXIT", node.loc);
      }

      if (
        t.isBlockStatement(node) &&
        path.parentPath &&
        t.isTryStatement(path.parentPath.node) &&
        path.key === "finalizer"
      ) {
        pushInstruction(instructions, "FINALLY_EXIT", node.loc);
      }

      if (t.isTryStatement(node)) {
        pushInstruction(instructions, "TRY_EXIT", node.loc);
      }
    },
  });

  return {
    version: 1,
    instructions,
  };
}

function lowerIR(program: IRProgram): LoweredProgram {
  const opcodes: LoweredOpcode[] = [];
  const pcToLoc: Record<string, SourceLoc> = {};
  const locToPc: Record<string, number[]> = {};

  for (const instruction of program.instructions) {
    const opcode: LoweredOpcode = {
      pc: instruction.index,
      op: instruction.op,
      nextPc:
        instruction.index + 1 < program.instructions.length
          ? instruction.index + 1
          : -1,
    };

    if (instruction.arg) {
      opcode.arg = instruction.arg;
    }

    if (instruction.loc) {
      const key = `${instruction.loc.line}:${instruction.loc.column}`;
      const existing = locToPc[key] ?? [];
      existing.push(instruction.index);
      locToPc[key] = existing;
      pcToLoc[String(instruction.index)] = instruction.loc;
    }

    opcodes.push(opcode);
  }

  return {
    version: 1,
    entryPc: 0,
    opcodes,
    pcToLoc,
    locToPc,
  };
}

function buildDebugMap(ast: t.File, markers: DebugMarker[], callCCRewrites: number): InternalDebugMap {
  const ir = buildIR(ast);
  const lowering = lowerIR(ir);

  const metrics = {
    callCCRewrites,
    irInstructions: ir.instructions.length,
    loweredOpcodes: lowering.opcodes.length,
    loopEntries: ir.instructions.filter((instruction) => instruction.op === "LOOP_ENTER").length,
    tryEntries: ir.instructions.filter((instruction) => instruction.op === "TRY_ENTER").length,
    functionEntries: ir.instructions.filter((instruction) => instruction.op === "FN_ENTER").length,
  };

  return {
    version: 2,
    markers,
    metrics,
    ir,
    lowering,
    stepMap: {
      pcToLoc: lowering.pcToLoc,
      locToPc: lowering.locToPc,
    },
  };
}

function createEmptyDebugMap(): InternalDebugMap {
  const emptyIr: IRProgram = {
    version: 1,
    instructions: [],
  };
  const emptyLowering: LoweredProgram = {
    version: 1,
    entryPc: 0,
    opcodes: [],
    pcToLoc: {},
    locToPc: {},
  };

  return {
    version: 2,
    markers: [],
    metrics: {
      callCCRewrites: 0,
      irInstructions: 0,
      loweredOpcodes: 0,
      loopEntries: 0,
      tryEntries: 0,
      functionEntries: 0,
    },
    ir: emptyIr,
    lowering: emptyLowering,
    stepMap: {
      pcToLoc: emptyLowering.pcToLoc,
      locToPc: emptyLowering.locToPc,
    },
  };
}

function compileWithBabel(source: string, options: CompileOptions): CompileResult {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });

  let callCCRewrites = 0;
  const markers: DebugMarker[] = [];
  const diagnostics: Diagnostic[] = [];

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const marker = getMarkerFromCall(path.node);
      if (marker) {
        markers.push(marker);
        if (marker.id.startsWith("dynamic:")) {
          const warning: Diagnostic = {
            code: "DYNAMIC_TIMEPOINT_ID",
            message: "Dynamic timepoint/breakpoint id detected; deterministic mapping may degrade",
            severity: "warning",
          };
          if (marker.loc) {
            warning.loc = marker.loc;
          }
          diagnostics.push(warning);
        }
      }

      if (t.isIdentifier(path.node.callee, { name: "callCC" })) {
        path.node.callee = t.memberExpression(t.identifier("__unwinder"), t.identifier("callCC"));
        callCCRewrites += 1;
      }
    },
  });

  const debugMap = buildDebugMap(ast, markers, callCCRewrites);

  const generated = generate(
    ast,
    {
      sourceMaps: options.sourceMap,
      retainLines: true,
      comments: true,
    },
    source,
  );

  const artifact: ProgramArtifact = {
    version: "2.0" as const,
    entry: "main",
    chunk: generated.code,
    debugMap,
    irHash: hashArtifact(`${generated.code}\n${JSON.stringify(debugMap.lowering.opcodes)}`),
    instrumentationMode: options.instrumentation,
  };
  if (generated.map) {
    artifact.sourceMap = generated.map;
  }

  return {
    artifact,
    diagnostics,
  };
}

export function compile(source: string, options?: CompileOptions): CompileResult {
  const mergedOptions: CompileOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  try {
    return compileWithBabel(source, mergedOptions);
  } catch (error) {
    const diagnostics = [buildParseErrorDiagnostic(error)];
    return {
      artifact: {
        version: "2.0",
        entry: "main",
        chunk: source,
        debugMap: createEmptyDebugMap(),
        irHash: hashArtifact(source),
        instrumentationMode: mergedOptions.instrumentation,
      },
      diagnostics,
    };
  }
}
