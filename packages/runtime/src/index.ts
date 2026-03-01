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
};

type HandlerMap = {
  [K in SessionEvent]: Set<(payload: SessionEventPayloadMap[K]) => void>;
};

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

  private timelineId = 0;

  private stepIndex = 0;

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

  run(): RunResult {
    if (this.disposed) {
      this.record("run:error", { disposed: true }, { status: "error" });
      return { status: "error", value: "session disposed" };
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

    this.stepIndex += 1;
    this.record("step", { stepIndex: this.stepIndex }, { status: "paused" });
    return {
      status: "paused",
      stepIndex: this.stepIndex,
    };
  }

  continue(): ContinueResult {
    if (this.disposed) {
      this.record("continue:error", { disposed: true }, { status: "error" });
      return { status: "error", reason: "session disposed" };
    }

    this.record("continue", {}, { status: "paused" });
    return { status: "paused", reason: "awaiting checkpoint or resume" };
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
