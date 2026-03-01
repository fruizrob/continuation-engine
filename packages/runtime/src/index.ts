import type {
  CheckpointId,
  ContinueResult,
  DebugSession,
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

  run(): RunResult {
    if (this.disposed) {
      return { status: "error", value: "session disposed" };
    }

    this.controller.record("host", "run", { entry: this.artifact.entry }, { status: "running" });

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

    this.emit("paused", { reason });
  }

  step(): StepResult {
    if (this.disposed) {
      return { status: "error" };
    }

    this.stepIndex += 1;
    return {
      status: "paused",
      stepIndex: this.stepIndex,
    };
  }

  continue(): ContinueResult {
    if (this.disposed) {
      return { status: "error", reason: "session disposed" };
    }

    return { status: "paused", reason: "awaiting checkpoint or resume" };
  }

  checkpoint(id: CheckpointId, _meta?: Record<string, unknown>): SnapshotId {
    if (this.disposed) {
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

    return snapshotId;
  }

  resume(snapshotId: SnapshotId, patch?: HeapPatch): ResumeResult {
    if (this.disposed) {
      return { status: "error", timelineId: this.timelineId, snapshotId };
    }

    const checkpoint = this.checkpoints.get(snapshotId);
    if (!checkpoint) {
      this.emit("error", { message: `Snapshot not found: ${snapshotId}` });
      return { status: "error", timelineId: this.timelineId, snapshotId };
    }

    if (this.options.oneShotDefault !== false && checkpoint.consumed) {
      this.emit("error", { message: `Snapshot already consumed: ${snapshotId}` });
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

    return {
      status: "resumed",
      timelineId: this.timelineId,
      snapshotId,
    };
  }

  cloneContinuation(snapshotId: SnapshotId): SnapshotId {
    const checkpoint = this.checkpoints.get(snapshotId);
    if (!checkpoint) {
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

    return cloneId;
  }

  evaluate(expr: string, _frameId?: string): EvalResult {
    return evaluateWithScope(expr, this.bindings);
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

  dispose(): void {
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
