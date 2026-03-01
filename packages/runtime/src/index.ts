import type {
  CheckpointId,
  ContinueResult,
  DebugSession,
  EventLogEntry,
  EvalResult,
  HeapPatch,
  ProgramArtifact,
  ResumeResult,
  RootRef,
  RunResult,
  ScopeState,
  SessionEvent,
  SessionEventPayloadMap,
  SessionOptions,
  SnapshotId,
  SourceLoc,
  StepResult,
  UnsupportedRecord,
} from "@unwinder/contracts";
import { createDeterminismController } from "@unwinder/determinism";
import { captureHeap, restoreHeap } from "@unwinder/snapshot";

type CheckpointEntry = {
  checkpointId: CheckpointId;
  snapshotId: SnapshotId;
  consumed: boolean;
  bindings: Record<string, unknown>;
  machinePc: number;
  stepIndex: number;
  machineFinished: boolean;
};

type HandlerMap = {
  [K in SessionEvent]: Set<(payload: SessionEventPayloadMap[K]) => void>;
};

type RuntimeOpcode = {
  pc: number;
  op: string;
  nextPc: number;
  arg?: Record<string, unknown>;
};

type RuntimeMachine = {
  entryPc: number;
  opcodes: RuntimeOpcode[];
  opcodesByPc: Map<number, RuntimeOpcode>;
  pcToLoc: Record<string, SourceLoc>;
};

type AdvanceOutcome = {
  status: "paused" | "finished" | "error";
  reason?: string;
  loc?: SourceLoc;
  boundary: boolean;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceLoc(value: unknown): value is SourceLoc {
  if (!isObjectRecord(value)) {
    return false;
  }

  return typeof value.line === "number" && typeof value.column === "number";
}

function parsePcToLoc(raw: unknown): Record<string, SourceLoc> {
  if (!isObjectRecord(raw)) {
    return {};
  }

  const parsed: Record<string, SourceLoc> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isSourceLoc(value)) {
      continue;
    }
    parsed[key] = {
      line: value.line,
      column: value.column,
    };
  }

  return parsed;
}

function parseRuntimeOpcodes(raw: unknown): RuntimeOpcode[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const opcodes: RuntimeOpcode[] = [];
  for (const entry of raw) {
    if (!isObjectRecord(entry)) {
      continue;
    }

    if (
      typeof entry.pc !== "number" ||
      typeof entry.op !== "string" ||
      typeof entry.nextPc !== "number"
    ) {
      continue;
    }

    const opcode: RuntimeOpcode = {
      pc: entry.pc,
      op: entry.op,
      nextPc: entry.nextPc,
    };

    if (isObjectRecord(entry.arg)) {
      opcode.arg = entry.arg;
    }

    opcodes.push(opcode);
  }

  opcodes.sort((a, b) => a.pc - b.pc);
  return opcodes;
}

function readMachineFromArtifact(artifact: ProgramArtifact): RuntimeMachine | null {
  if (!isObjectRecord(artifact.debugMap)) {
    return null;
  }

  const lowering = artifact.debugMap.lowering;
  if (!isObjectRecord(lowering)) {
    return null;
  }

  const opcodes = parseRuntimeOpcodes(lowering.opcodes);
  if (opcodes.length === 0) {
    return null;
  }
  const firstOpcode = opcodes[0];
  if (!firstOpcode) {
    return null;
  }

  const opcodesByPc = new Map<number, RuntimeOpcode>();
  for (const opcode of opcodes) {
    opcodesByPc.set(opcode.pc, opcode);
  }

  const declaredEntryPc = typeof lowering.entryPc === "number" ? lowering.entryPc : firstOpcode.pc;
  const entryPc = opcodesByPc.has(declaredEntryPc) ? declaredEntryPc : firstOpcode.pc;

  const pcToLocFromLowering = parsePcToLoc(lowering.pcToLoc);
  const stepMap = artifact.debugMap.stepMap;
  const pcToLocFromStepMap = isObjectRecord(stepMap) ? parsePcToLoc(stepMap.pcToLoc) : {};
  const pcToLoc = Object.keys(pcToLocFromLowering).length > 0 ? pcToLocFromLowering : pcToLocFromStepMap;

  return {
    entryPc,
    opcodes,
    opcodesByPc,
    pcToLoc,
  };
}

function cloneBindings(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input));
}

function evaluateWithScope(expr: string, scope: Record<string, unknown>): EvalResult {
  try {
    const value = new Function("scope", `with (scope) { return (${expr}); }`)(scope);
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

class InMemoryDebugSession implements DebugSession {
  private readonly options: Required<Pick<SessionOptions, "mode">> & SessionOptions;

  private readonly machine: RuntimeMachine | null;

  private timelineId = 0;

  private stepIndex = 0;

  private machinePc = 0;

  private machineFinished = false;

  private readonly handlers: HandlerMap = {
    paused: new Set(),
    resumed: new Set(),
    checkpoint: new Set(),
    restored: new Set(),
    warning: new Set(),
    error: new Set(),
    finish: new Set(),
  };

  private readonly checkpoints = new Map<SnapshotId, CheckpointEntry>();

  private readonly controller = createDeterminismController();

  private snapshotSeq = 0;

  private disposed = false;

  private bindings: Record<string, unknown> = {};

  constructor(private readonly artifact: ProgramArtifact, options?: SessionOptions) {
    this.options = {
      mode: "debug",
      ...options,
    };
    this.machine = readMachineFromArtifact(artifact);
    this.machinePc = this.machine?.entryPc ?? 0;
    this.machineFinished = this.machine ? this.machine.opcodes.length === 0 : false;
    this.controller.attach(this);
  }

  private emit<E extends SessionEvent>(event: E, payload: SessionEventPayloadMap[E]): void {
    for (const handler of this.handlers[event]) {
      handler(payload);
    }
  }

  private record(op: string, input: unknown, output: unknown): void {
    this.controller.record("host", op, input, output);
  }

  private getCurrentLoc(pc: number): SourceLoc | undefined {
    return this.machine?.pcToLoc[String(pc)];
  }

  private recordOpcodeAssertion(
    mode: "step" | "continue",
    fromPc: number,
    opcode: RuntimeOpcode,
    checks: {
      pcMatchesOpcode: boolean;
      nextPcExists: boolean;
    },
  ): void {
    this.record(
      "opcode.transition.assert",
      {
        mode,
        fromPc,
        opcode: opcode.op,
        declaredPc: opcode.pc,
        declaredNextPc: opcode.nextPc,
      },
      {
        ok: checks.pcMatchesOpcode && checks.nextPcExists,
        checks,
      },
    );
  }

  private advanceMachine(mode: "step" | "continue"): AdvanceOutcome {
    if (!this.machine) {
      return {
        status: "paused",
        reason: "no-machine",
        boundary: false,
      };
    }

    if (this.machineFinished || this.machinePc === -1) {
      this.machineFinished = true;
      this.emit("finish", { value: undefined });
      return {
        status: "finished",
        boundary: false,
      };
    }

    const fromPc = this.machinePc;
    const opcode = this.machine.opcodesByPc.get(fromPc);
    if (!opcode) {
      this.record(
        "opcode.transition.assert",
        {
          mode,
          fromPc,
          opcode: "missing",
          declaredPc: fromPc,
          declaredNextPc: -1,
        },
        {
          ok: false,
          checks: {
            pcMatchesOpcode: false,
            nextPcExists: false,
          },
        },
      );
      this.emit("error", { message: `Opcode not found at pc=${fromPc}` });
      return {
        status: "error",
        reason: "opcode-missing",
        boundary: false,
      };
    }

    const checks = {
      pcMatchesOpcode: opcode.pc === fromPc,
      nextPcExists: opcode.nextPc === -1 || this.machine.opcodesByPc.has(opcode.nextPc),
    };
    this.recordOpcodeAssertion(mode, fromPc, opcode, checks);

    if (!checks.pcMatchesOpcode || !checks.nextPcExists) {
      this.emit("error", {
        message: `Invalid opcode transition from pc=${fromPc} to nextPc=${opcode.nextPc}`,
      });
      return {
        status: "error",
        reason: "opcode-transition-invalid",
        boundary: false,
      };
    }

    const loc = this.getCurrentLoc(fromPc);
    this.stepIndex += 1;
    this.machinePc = opcode.nextPc;
    this.machineFinished = opcode.nextPc === -1;

    if (opcode.op === "CHECKPOINT" || opcode.op === "BREAKPOINT") {
      const checkpointId = typeof opcode.arg?.id === "string" ? opcode.arg.id : undefined;
      const reasonPrefix = opcode.op === "CHECKPOINT" ? "checkpoint" : "breakpoint";
      const reason = checkpointId ? `${reasonPrefix}:${checkpointId}` : reasonPrefix;

      if (opcode.op === "CHECKPOINT") {
        if (checkpointId) {
          this.emit("paused", { reason, checkpointId });
        } else {
          this.emit("paused", { reason });
        }
      } else {
        this.emit("paused", { reason });
      }

      const paused: AdvanceOutcome = {
        status: "paused",
        reason,
        boundary: true,
      };
      if (loc) {
        paused.loc = loc;
      }
      return paused;
    }

    if (this.machineFinished) {
      this.emit("finish", { value: undefined });
      const finished: AdvanceOutcome = {
        status: "finished",
        boundary: false,
      };
      if (loc) {
        finished.loc = loc;
      }
      return finished;
    }

    const paused: AdvanceOutcome = {
      status: "paused",
      reason: "step",
      boundary: false,
    };
    if (loc) {
      paused.loc = loc;
    }
    return paused;
  }

  run(): RunResult {
    if (this.disposed) {
      this.record("run:error", { disposed: true }, { status: "error" });
      return { status: "error", value: "session disposed" };
    }

    if (this.machine) {
      this.machinePc = this.machine.entryPc;
      this.machineFinished = false;
      this.stepIndex = 0;
    }

    this.record("run", { entry: this.artifact.entry }, { status: "running" });

    if (this.options.mode === "run") {
      this.emit("finish", { value: undefined });
      return { status: "finished" };
    }

    return { status: "running" };
  }

  pause(reason = "manual"): void {
    if (this.disposed) {
      return;
    }

    this.record("pause", { reason }, { status: "paused" });
    this.emit("paused", { reason });
  }

  step(): StepResult {
    if (this.disposed) {
      this.record("step:error", { disposed: true }, { status: "error" });
      return { status: "error" };
    }

    if (!this.machine) {
      this.stepIndex += 1;
      this.record("step", { stepIndex: this.stepIndex }, { status: "paused" });
      return {
        status: "paused",
        stepIndex: this.stepIndex,
      };
    }

    const outcome = this.advanceMachine("step");
    if (outcome.status === "error") {
      this.record("step:error", { stepIndex: this.stepIndex }, { reason: outcome.reason });
      return { status: "error" };
    }

    if (outcome.status === "finished") {
      this.record("step", { stepIndex: this.stepIndex }, { status: "finished" });
      const result: StepResult = {
        status: "finished",
        stepIndex: this.stepIndex,
      };
      if (outcome.loc) {
        result.loc = outcome.loc;
      }
      return result;
    }

    this.record(
      "step",
      { stepIndex: this.stepIndex, reason: outcome.reason, pc: this.machinePc },
      { status: "paused" },
    );
    const result: StepResult = {
      status: "paused",
      stepIndex: this.stepIndex,
    };
    if (outcome.loc) {
      result.loc = outcome.loc;
    }
    return result;
  }

  continue(): ContinueResult {
    if (this.disposed) {
      this.record("continue:error", { disposed: true }, { status: "error" });
      return { status: "error", reason: "session disposed" };
    }

    if (!this.machine) {
      this.record("continue", {}, { status: "paused" });
      return { status: "paused", reason: "awaiting checkpoint or resume" };
    }

    let transitions = 0;
    for (;;) {
      const outcome = this.advanceMachine("continue");
      transitions += 1;

      if (outcome.status === "error") {
        this.record("continue:error", { transitions }, { reason: outcome.reason });
        return { status: "error", reason: outcome.reason ?? "continue-error" };
      }

      if (outcome.status === "finished") {
        this.record("continue", { transitions }, { status: "finished" });
        return { status: "finished" };
      }

      if (outcome.boundary) {
        this.record("continue", { transitions, reason: outcome.reason }, { status: "paused" });
        return { status: "paused", reason: outcome.reason ?? "paused" };
      }
    }
  }

  checkpoint(id: CheckpointId, _meta?: Record<string, unknown>): SnapshotId {
    if (this.disposed) {
      this.record("checkpoint:error", { checkpointId: id }, { reason: "disposed" });
      throw new Error("Session is disposed");
    }

    this.snapshotSeq += 1;
    const snapshotId = `${id}::${this.snapshotSeq}`;

    const roots: RootRef[] = [{ id: "bindings", path: "bindings", kind: "runtime" }];
    const heap = captureHeap(
      roots,
      {
        strategy: "rooted-graph",
        includeGlobals: false,
        maxGraphNodes: 10_000,
      },
      {
        bindings: this.bindings,
      },
    );

    this.checkpoints.set(snapshotId, {
      checkpointId: id,
      snapshotId,
      consumed: false,
      bindings: cloneBindings((restoreHeap(heap).state.bindings as Record<string, unknown>) ?? {}),
      machinePc: this.machinePc,
      stepIndex: this.stepIndex,
      machineFinished: this.machineFinished,
    });

    this.emit("checkpoint", {
      checkpointId: id,
      snapshotId,
    });
    this.record("checkpoint", { checkpointId: id }, { snapshotId });

    return snapshotId;
  }

  resume(snapshotId: SnapshotId, patch?: HeapPatch): ResumeResult {
    if (this.disposed) {
      this.record("resume:error", { snapshotId }, { reason: "disposed" });
      return { status: "error", timelineId: this.timelineId, snapshotId };
    }

    const checkpoint = this.checkpoints.get(snapshotId);
    if (!checkpoint) {
      this.emit("error", { message: `Snapshot not found: ${snapshotId}` });
      this.record("resume:error", { snapshotId }, { reason: "snapshot-missing" });
      return { status: "error", timelineId: this.timelineId, snapshotId };
    }

    if (this.options.oneShotDefault !== false && checkpoint.consumed) {
      this.emit("error", { message: `Snapshot already consumed: ${snapshotId}` });
      this.record("resume:error", { snapshotId }, { reason: "snapshot-consumed" });
      return { status: "error", timelineId: this.timelineId, snapshotId };
    }

    this.bindings = {
      ...cloneBindings(checkpoint.bindings),
      ...(patch ?? {}),
    };
    this.machinePc = checkpoint.machinePc;
    this.stepIndex = checkpoint.stepIndex;
    this.machineFinished = checkpoint.machineFinished;

    checkpoint.consumed = this.options.oneShotDefault !== false;
    this.timelineId += 1;

    const warnings: UnsupportedRecord[] = [];
    this.emit("restored", { snapshotId, warnings });
    this.emit("resumed", { snapshotId, timelineId: this.timelineId });
    this.record(
      "resume",
      { snapshotId, patchKeys: Object.keys(patch ?? {}) },
      { timelineId: this.timelineId },
    );

    return {
      status: "resumed",
      timelineId: this.timelineId,
      snapshotId,
    };
  }

  cloneContinuation(snapshotId: SnapshotId): SnapshotId {
    const checkpoint = this.checkpoints.get(snapshotId);
    if (!checkpoint) {
      this.record("clone:error", { snapshotId }, { reason: "snapshot-missing" });
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    this.snapshotSeq += 1;
    const cloneId = `${snapshotId}#clone${this.snapshotSeq}`;
    this.checkpoints.set(cloneId, {
      checkpointId: checkpoint.checkpointId,
      snapshotId: cloneId,
      consumed: false,
      bindings: cloneBindings(checkpoint.bindings),
      machinePc: checkpoint.machinePc,
      stepIndex: checkpoint.stepIndex,
      machineFinished: checkpoint.machineFinished,
    });
    this.record("clone", { snapshotId }, { cloneId });

    return cloneId;
  }

  evaluate(expr: string, _frameId?: string): EvalResult {
    const result = evaluateWithScope(expr, this.bindings);
    this.record(
      "evaluate",
      { expression: expr },
      { ok: result.ok, hasError: Boolean(result.error) },
    );
    return result;
  }

  inspect(frameId?: string): ScopeState {
    const state: ScopeState = {
      bindings: cloneBindings(this.bindings),
    };
    if (frameId) {
      state.frameId = frameId;
    }
    return state;
  }

  on<E extends SessionEvent>(
    event: E,
    handler: (payload: SessionEventPayloadMap[E]) => void,
  ): () => void {
    this.handlers[event].add(handler as (payload: SessionEventPayloadMap[keyof SessionEventPayloadMap]) => void);
    return () => {
      this.handlers[event].delete(
        handler as (payload: SessionEventPayloadMap[keyof SessionEventPayloadMap]) => void,
      );
    };
  }

  getDeterminismLog(fromSeq = 0): EventLogEntry[] {
    return this.controller.getLog(fromSeq);
  }

  loadDeterminismLog(entries: EventLogEntry[]): void {
    this.controller.replay(entries);
  }

  dispose(): void {
    this.record("dispose", {}, { checkpoints: this.checkpoints.size });
    this.disposed = true;
    this.checkpoints.clear();
    this.controller.detach();
    for (const set of Object.values(this.handlers)) {
      set.clear();
    }
  }
}

export function createDebugSession(
  artifact: ProgramArtifact,
  options?: SessionOptions,
): DebugSession {
  return new InMemoryDebugSession(artifact, options);
}
