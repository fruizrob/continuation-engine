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

type InternalDebugMap = {
  version: 1;
  markers: DebugMarker[];
  metrics: {
    callCCRewrites: number;
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

function getMarkerFromCall(path: t.CallExpression): DebugMarker | null {
  if (!t.isMemberExpression(path.callee)) {
    return null;
  }

  if (path.callee.computed) {
    return null;
  }

  if (!t.isIdentifier(path.callee.object, { name: "delorean" })) {
    return null;
  }

  if (!t.isIdentifier(path.callee.property)) {
    return null;
  }

  const methodName = path.callee.property.name;
  if (methodName !== "insertTimepoint" && methodName !== "insertBreakpoint") {
    return null;
  }

  const firstArg = path.arguments.at(0);
  const id = t.isStringLiteral(firstArg)
    ? firstArg.value
    : `dynamic:${path.loc?.start.line ?? 0}:${path.loc?.start.column ?? 0}`;

  const marker: DebugMarker = {
    id,
    kind: methodName === "insertTimepoint" ? "timepoint" : "breakpoint",
  };
  const loc = toLoc(path.loc);
  if (loc) {
    marker.loc = loc;
  }

  return marker;
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

  const generated = generate(
    ast,
    {
      sourceMaps: options.sourceMap,
      retainLines: true,
      comments: true,
    },
    source,
  );

  const debugMap: InternalDebugMap = {
    version: 1,
    markers,
    metrics: {
      callCCRewrites,
    },
  };

  const artifact: ProgramArtifact = {
    version: "2.0" as const,
    entry: "main",
    chunk: generated.code,
    debugMap,
    irHash: hashArtifact(generated.code),
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
        debugMap: {
          version: 1,
          markers: [],
          metrics: {
            callCCRewrites: 0,
          },
        },
        irHash: hashArtifact(source),
        instrumentationMode: mergedOptions.instrumentation,
      },
      diagnostics,
    };
  }
}
