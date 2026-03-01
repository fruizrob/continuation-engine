import { readFile, writeFile } from "node:fs/promises";

import { compile } from "@unwinder/compiler";
import type {
  CompileOptions,
  Diagnostic,
  HeapPatch,
  ProgramArtifact,
  ResumeResult,
  RunResult,
  ScopeState,
  SessionEvent,
} from "@unwinder/contracts";
import { createDebugSession } from "@unwinder/runtime";

export type RunnerCommand = "compile" | "run" | "replay";

export type RunnerEvent = {
  event: SessionEvent;
  payload: unknown;
};

export type NodeRunnerInput = {
  source?: string;
  artifact?: ProgramArtifact;
};

export type NodeRunnerOptions = {
  command?: RunnerCommand;
  compileOptions?: Partial<CompileOptions>;
  checkpointId?: string;
  snapshotId?: string;
  patch?: HeapPatch;
};

export type NodeRunnerReport = {
  command: RunnerCommand;
  artifact: ProgramArtifact;
  diagnostics: Diagnostic[];
  events: RunnerEvent[];
  runResult?: RunResult;
  checkpointId?: string;
  snapshotId?: string;
  resumeResult?: ResumeResult;
  scope?: ScopeState;
};

export type CliIo = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  stdout(message: string): void;
  stderr(message: string): void;
};

type ParsedCliArgs = {
  command: RunnerCommand;
  filePath: string;
  checkpointId?: string;
  snapshotId?: string;
  outFile?: string;
  patch?: HeapPatch;
};

const DEFAULT_COMPILE_OPTIONS: CompileOptions = {
  target: "node",
  sourceMap: false,
  instrumentation: "checkpoint-first",
};

const SESSION_EVENTS: SessionEvent[] = [
  "paused",
  "resumed",
  "checkpoint",
  "restored",
  "warning",
  "error",
  "finish",
];

function resolveArtifact(
  input: NodeRunnerInput,
  compileOptions?: Partial<CompileOptions>,
): { artifact: ProgramArtifact; diagnostics: Diagnostic[] } {
  if (input.artifact) {
    return {
      artifact: input.artifact,
      diagnostics: [],
    };
  }

  if (typeof input.source !== "string") {
    throw new Error("Node runner requires either source or artifact input");
  }

  const compileResult = compile(input.source, {
    ...DEFAULT_COMPILE_OPTIONS,
    ...compileOptions,
  });

  return {
    artifact: compileResult.artifact,
    diagnostics: compileResult.diagnostics,
  };
}

function registerEventCollection(
  session: ReturnType<typeof createDebugSession>,
  events: RunnerEvent[],
): void {
  for (const event of SESSION_EVENTS) {
    session.on(event, (payload) => {
      events.push({
        event,
        payload,
      });
    });
  }
}

function validatePatch(value: unknown): asserts value is HeapPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Patch input must be a JSON object");
  }
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  const [commandRaw, filePath, ...rest] = argv;
  if (!commandRaw || (commandRaw !== "compile" && commandRaw !== "run" && commandRaw !== "replay")) {
    throw new Error("Unknown command. Use one of: compile, run, replay");
  }

  if (!filePath) {
    throw new Error("Missing input file path");
  }

  const parsed: ParsedCliArgs = {
    command: commandRaw,
    filePath,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const next = rest[index + 1];

    if (!token || !token.startsWith("--")) {
      continue;
    }

    if (!next) {
      throw new Error(`Missing value for option ${token}`);
    }

    if (token === "--checkpoint") {
      parsed.checkpointId = next;
      index += 1;
      continue;
    }

    if (token === "--snapshot") {
      parsed.snapshotId = next;
      index += 1;
      continue;
    }

    if (token === "--out") {
      parsed.outFile = next;
      index += 1;
      continue;
    }

    if (token === "--patch") {
      parsed.patch = parsePatchInput(next);
      index += 1;
      continue;
    }

    throw new Error(`Unsupported option: ${token}`);
  }

  return parsed;
}

export function parsePatchInput(raw?: string): HeapPatch {
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid patch JSON: ${message}`);
  }

  validatePatch(parsed);
  return parsed;
}

export function runNodeArtifact(input: NodeRunnerInput, options: NodeRunnerOptions = {}): NodeRunnerReport {
  const command = options.command ?? "run";
  const { artifact, diagnostics } = resolveArtifact(input, options.compileOptions);

  const report: NodeRunnerReport = {
    command,
    artifact,
    diagnostics,
    events: [],
  };

  if (command === "compile") {
    return report;
  }

  const session = createDebugSession(artifact, {
    mode: "debug",
    oneShotDefault: true,
  });

  registerEventCollection(session, report.events);

  report.runResult = session.run();

  const checkpointId = options.checkpointId ?? "entry";
  const createdSnapshotId = session.checkpoint(checkpointId);
  report.checkpointId = checkpointId;

  const snapshotId = command === "replay" && options.snapshotId ? options.snapshotId : createdSnapshotId;
  report.snapshotId = snapshotId;

  report.resumeResult = session.resume(snapshotId, options.patch);
  report.scope = session.inspect();

  session.dispose();

  return report;
}

function createDefaultIo(): CliIo {
  return {
    readFile: async (path: string) => readFile(path, "utf8"),
    writeFile: async (path: string, contents: string) => {
      await writeFile(path, contents, "utf8");
    },
    stdout: (message: string) => {
      process.stdout.write(`${message}\n`);
    },
    stderr: (message: string) => {
      process.stderr.write(`${message}\n`);
    },
  };
}

export async function runNodeCli(argv: string[], io: CliIo = createDefaultIo()): Promise<number> {
  try {
    const parsed = parseCliArgs(argv);
    const source = await io.readFile(parsed.filePath);

    const runnerOptions: NodeRunnerOptions = {
      command: parsed.command,
    };
    if (parsed.checkpointId) {
      runnerOptions.checkpointId = parsed.checkpointId;
    }
    if (parsed.snapshotId) {
      runnerOptions.snapshotId = parsed.snapshotId;
    }
    if (parsed.patch) {
      runnerOptions.patch = parsed.patch;
    }

    const report = runNodeArtifact(
      { source },
      runnerOptions,
    );

    const payload = JSON.stringify(report, null, 2);
    if (parsed.outFile) {
      await io.writeFile(parsed.outFile, `${payload}\n`);
    } else {
      io.stdout(payload);
    }

    return report.resumeResult?.status === "error" ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(message);
    return 1;
  }
}
