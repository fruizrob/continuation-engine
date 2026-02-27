export type TargetRuntime = "node" | "browser";
export type InstrumentationMode = "checkpoint-first" | "debug-full";

export type SourceLoc = {
  line: number;
  column: number;
};

export type CompileOptions = {
  target: TargetRuntime;
  sourceMap: boolean;
  instrumentation: InstrumentationMode;
};

export type DebugMap = Record<string, unknown>;

export type Diagnostic = {
  code: string;
  message: string;
  severity: "error" | "warning";
  loc?: SourceLoc;
};

export type ProgramArtifact = {
  version: "2.0";
  entry: string;
  chunk: string;
  sourceMap?: object;
  debugMap: DebugMap;
  irHash: string;
  instrumentationMode: InstrumentationMode;
};

export type CompileResult = {
  artifact: ProgramArtifact;
  diagnostics: Diagnostic[];
};

export type CheckpointId = string;
export type SnapshotId = string;
export type TimelineId = number;
export type FrameId = string;
export type HeapPatch = Record<string, unknown>;

export type RunResult = {
  status: "running" | "paused" | "finished" | "error";
  value?: unknown;
};

export type StepResult = {
  status: "paused" | "finished" | "error";
  stepIndex?: number;
  loc?: SourceLoc;
};

export type ContinueResult = {
  status: "paused" | "finished" | "error";
  reason?: string;
};

export type ResumeResult = {
  status: "resumed" | "finished" | "error";
  timelineId: TimelineId;
  snapshotId: SnapshotId;
};

export type EvalResult = {
  ok: boolean;
  value?: unknown;
  error?: string;
};

export type ScopeState = {
  frameId?: FrameId;
  bindings: Record<string, unknown>;
};

export type RootRef = {
  id: string;
  path: string;
  kind: "frame" | "global" | "runtime";
};

export type PropertyRecord = {
  key: string;
  valueRef?: string;
  primitive?: unknown;
  writable?: boolean;
  enumerable?: boolean;
  configurable?: boolean;
};

export type ObjectRecord = {
  objectId: string;
  typeTag: string;
  props: PropertyRecord[];
  prototypeRef?: string;
};

export type UnsupportedRecord = {
  path: string;
  kind: string;
  reason: string;
  fallbackPolicy: "placeholder" | "drop" | "error";
};

export type SnapshotOptions = {
  strategy: "rooted-graph";
  includeGlobals: boolean;
  maxGraphNodes: number;
};

export type HeapSnapshot = {
  snapshotId: SnapshotId;
  checkpointId: CheckpointId;
  timelineId: TimelineId;
  timestampMs: number;
  roots: RootRef[];
  graph: ObjectRecord[];
  unsupported: UnsupportedRecord[];
};

export type RestoreResult = {
  ok: boolean;
  warnings: UnsupportedRecord[];
};

export type SessionEvent =
  | "paused"
  | "resumed"
  | "checkpoint"
  | "restored"
  | "warning"
  | "error"
  | "finish";

export type SessionOptions = {
  mode: "debug" | "run";
  clock?: () => number;
  maxSnapshots?: number;
  oneShotDefault?: boolean;
};

export type SessionEventPayloadMap = {
  paused: { reason?: string; checkpointId?: CheckpointId };
  resumed: { snapshotId: SnapshotId; timelineId: TimelineId };
  checkpoint: { checkpointId: CheckpointId; snapshotId: SnapshotId };
  restored: { snapshotId: SnapshotId; warnings: UnsupportedRecord[] };
  warning: { message: string; data?: unknown };
  error: { message: string; cause?: unknown };
  finish: { value?: unknown };
};

export interface DebugSession {
  run(): RunResult;
  pause(reason?: string): void;
  step(): StepResult;
  continue(): ContinueResult;
  checkpoint(id: CheckpointId, meta?: Record<string, unknown>): SnapshotId;
  resume(snapshotId: SnapshotId, patch?: HeapPatch): ResumeResult;
  cloneContinuation(snapshotId: SnapshotId): SnapshotId;
  evaluate(expr: string, frameId?: FrameId): EvalResult;
  inspect(frameId?: FrameId): ScopeState;
  on<E extends SessionEvent>(
    event: E,
    handler: (payload: SessionEventPayloadMap[E]) => void,
  ): () => void;
  dispose(): void;
}

export type ContinuationToken = {
  snapshotId: SnapshotId;
  frameRefs: FrameId[];
  machinePointer: string;
  state: "fresh" | "consumed" | "cloned";
};

export type CheckpointRecord = {
  checkpointId: CheckpointId;
  snapshotId: SnapshotId;
  timelineId: TimelineId;
  loc?: SourceLoc;
  timestampMs: number;
  eventSeq: number;
};

export type EventLogKind = "clock" | "rng" | "timer" | "io" | "host";

export type EventLogEntry = {
  seq: number;
  kind: EventLogKind;
  op: string;
  input: unknown;
  output: unknown;
  timestampMs: number;
};

export interface DeterminismController {
  attach(session: DebugSession): void;
  detach(): void;
  getLog(fromSeq?: number): EventLogEntry[];
  replay(entries: EventLogEntry[]): void;
}

export type TimepointMeta = {
  timepointId: string;
  loc?: SourceLoc;
  label?: string;
};

export type DeloreanCompileResult = {
  artifact: ProgramArtifact;
  timepointIndex: Record<string, TimepointMeta>;
};
