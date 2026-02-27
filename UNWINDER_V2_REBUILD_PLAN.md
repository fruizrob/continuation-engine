# Unwinder v2 Rebuild Plan (Research-Backed Implementation Spec)

Date: 2026-02-27
Owner Context: Delorean time-travel debugger integration
Status: Approved direction for implementation kickoff

## 1) Executive Summary
Unwinder v2 is a clean-break rebuild of `unwinder-engine`, optimized for Delorean’s core debugger flows:
1. Pause execution at explicit timepoints.
2. Jump back to prior checkpoints.
3. Apply state edits.
4. Resume deterministically.

This spec incorporates research findings from continuation systems (Racket/SML/Haskell/OCaml effects), JavaScript continuation/runtime research (Stopify, exceptional continuations), and deterministic replay systems (`rr`) to reduce implementation risk.

Primary product decisions:
1. Compatibility: **Clean break v2**.
2. Runtime order: **Node-first**, with an **early browser-compatibility spike**.
3. State strategy: **Hybrid deterministic replay model** (continuation token + rooted heap snapshot + deterministic event log), instead of relying on a single “full heap” assumption.

## 2) Ground Truth (Current Delorean/Unwinder Interface)
Preserve these integration facts while migrating:
1. Delorean imports `compile` and `vm` from `unwinder-engine`, executes compiled code via `eval`.
2. Continuation IDs are materialized as `continuations.kont{timepointId}` and resumed by invocation.
3. Source `callCC` is inserted by Delorean transform and rewritten by Unwinder compiler.
4. Existing heap model in Delorean tracks dependency roots, not full transparent engine heap.
5. Existing path has heavy `eval`, mutable globals, and DOM coupling.

Implication: v2 must provide a Delorean adapter preserving timepoint semantics without inheriting unsafe global/eval coupling.

## 3) Research Signals and Design Implications
### 3.1 Continuation semantics
1. Full first-class continuations are powerful but expensive and difficult to make transparent in JS hosts.
2. Pragmatic debugger runtimes favor controlled checkpoints + resumable machine state over unrestricted global continuation capture.
3. One-shot continuations reduce semantic ambiguity and memory pressure versus unrestricted multi-shot by default.

Design implication:
1. Default continuation token model is **one-shot**.
2. Multi-shot enabled only via explicit `cloneContinuation(token)` API and policy guard.

### 3.2 Determinism requirements
1. Time-travel debugging quality depends on deterministic replay, not only heap restore.
2. External nondeterminism (`Date.now`, RNG, timers, I/O callbacks, process/env reads) must be boundary-controlled and logged.

Design implication:
1. Introduce deterministic boundary contract.
2. Snapshot restore is necessary but insufficient without event log replay.

### 3.3 Browser/runtime parity
1. Node-first is correct for MVP velocity.
2. Browser runtime constraints (event loop timing, host objects) can invalidate assumptions if postponed too late.

Design implication:
1. Keep Node-first delivery, but run an early browser-compatibility spike before API lock.

## 4) Scope
### In scope (MVP to M2)
1. Compiler -> continuation IR -> resumable state-machine output.
2. Runtime `DebugSession` with pause/step/continue/checkpoint/resume.
3. Snapshot engine with rooted graph capture and restore.
4. Deterministic boundary/event-log layer for supported nondeterministic APIs.
5. Delorean adapter mapping existing timepoint semantics to v2 session APIs.

### Out of scope (MVP)
1. Transparent capture of all JS engine internals.
2. Legacy `unwinder-engine@0.0.x` API compatibility mode.
3. Production browser extension tooling.

## 5) Revised Architecture (with 6 deltas applied)
### Delta 1: Clean-break v2 API
No strict legacy API preservation. Provide migration adapter for Delorean only.

### Delta 2: Node-first + browser spike
Implementation order:
1. Node runtime MVP.
2. Early browser spike (API and serialization constraints).
3. Browser parity after Node/adapter stability.

### Delta 3: Hybrid replay model (replaces single full-heap assumption)
Canonical runtime state at checkpoint:
1. `ContinuationToken` (machine location + frame chain references).
2. `HeapSnapshot` from configured runtime roots.
3. `DeterministicEventLog` slice from session start to checkpoint.
4. `UnsupportedRegistry` entries for values not safely serializable/restorable.

Restore pipeline:
1. Load checkpoint metadata.
2. Restore snapshot graph.
3. Apply user patch overrides.
4. Rebind continuation token.
5. Rehydrate deterministic boundaries from event log.
6. Resume execution.

### Delta 4: One-shot by default
1. `resume(snapshotId)` consumes continuation token by default.
2. Explicit `cloneContinuation(snapshotId)` required for branching multi-shot resumes.
3. Timeline branching represented by new `timelineId` lineage.

### Delta 5: Deterministic boundary contract
Runtime adapters wrap and log:
1. Time (`Date.now`, `new Date`, `performance.now` where available).
2. RNG (`Math.random`, optional seeded PRNG mode).
3. Scheduler (`setTimeout`, `setInterval`, microtask sequencing hooks where controllable).
4. External side effects (gated wrappers; unsupported direct host effects produce warnings/events).

### Delta 6: Explicit checkpoint-first instrumentation
Phase order:
1. Instrument explicit Delorean checkpoints/breakpoints first.
2. Validate resume correctness end-to-end.
3. Expand instrumentation granularity only after deterministic and perf gates pass.

## 6) Package Layout
1. `packages/contracts`
2. `packages/compiler`
3. `packages/runtime`
4. `packages/snapshot`
5. `packages/determinism`
6. `packages/node-runner`
7. `packages/browser-runner`
8. `packages/delorean-adapter`

## 7) Public API Contracts
### 7.1 Compiler (`@unwinder/compiler`)
```ts
type CompileOptions = {
  target: "node" | "browser";
  sourceMap: boolean;
  instrumentation: "checkpoint-first" | "debug-full";
};

type ProgramArtifact = {
  version: "2.0";
  entry: string;
  chunk: string;
  sourceMap?: object;
  debugMap: DebugMap;
  irHash: string;
  instrumentationMode: CompileOptions["instrumentation"];
};

type CompileResult = {
  artifact: ProgramArtifact;
  diagnostics: Diagnostic[];
};

function compile(source: string, options?: CompileOptions): CompileResult;
```

### 7.2 Runtime (`@unwinder/runtime`)
```ts
type SessionOptions = {
  mode: "debug" | "run";
  clock?: () => number;
  maxSnapshots?: number;
  oneShotDefault?: boolean; // default true
};

type CheckpointId = string;
type SnapshotId = string;
type TimelineId = number;
type HeapPatch = Record<string, unknown>;

interface DebugSession {
  run(): RunResult;
  pause(reason?: string): void;
  step(): StepResult;
  continue(): ContinueResult;
  checkpoint(id: CheckpointId, meta?: Record<string, unknown>): SnapshotId;
  resume(snapshotId: SnapshotId, patch?: HeapPatch): ResumeResult; // one-shot consume
  cloneContinuation(snapshotId: SnapshotId): SnapshotId; // explicit multi-shot branch
  evaluate(expr: string, frameId?: string): EvalResult;
  inspect(frameId?: string): ScopeState;
  on(event: SessionEvent, handler: (payload: unknown) => void): () => void;
  dispose(): void;
}
```

### 7.3 Snapshot (`@unwinder/snapshot`)
```ts
type SnapshotOptions = {
  strategy: "rooted-graph";
  includeGlobals: boolean;
  maxGraphNodes: number;
};

type HeapSnapshot = {
  snapshotId: string;
  checkpointId: string;
  timelineId: number;
  timestampMs: number;
  roots: RootRef[];
  graph: ObjectRecord[];
  unsupported: UnsupportedRecord[];
};

function captureHeap(roots: RootRef[], opts: SnapshotOptions): HeapSnapshot;
function restoreHeap(snapshot: HeapSnapshot, patch?: HeapPatch): RestoreResult;
```

### 7.4 Determinism (`@unwinder/determinism`)
```ts
type EventLogEntry = {
  seq: number;
  kind: "clock" | "rng" | "timer" | "io" | "host";
  op: string;
  input: unknown;
  output: unknown;
  timestampMs: number;
};

interface DeterminismController {
  attach(session: DebugSession): void;
  detach(): void;
  getLog(fromSeq?: number): EventLogEntry[];
  replay(entries: EventLogEntry[]): void;
}
```

### 7.5 Delorean adapter (`@unwinder/delorean-adapter`)
```ts
type DeloreanCompileResult = {
  artifact: ProgramArtifact;
  timepointIndex: Record<string, TimepointMeta>;
};

function compileForDelorean(source: string, opts?: DeloreanCompileOptions): DeloreanCompileResult;
function createDeloreanSession(artifact: ProgramArtifact, opts?: SessionOptions): DebugSession;
function resumeTimepoint(session: DebugSession, timepointId: string, patch?: HeapPatch): ResumeResult;
```

UI compatibility fields to preserve:
1. `timeLineId`
2. `timePointId`
3. `timePointTimestamp`
4. `timePointLoc`

## 8) Data Model (Canonical)
1. `CheckpointRecord`: `checkpointId`, `snapshotId`, `timelineId`, `loc`, `timestampMs`, `eventSeq`
2. `ContinuationToken`: machine pointer + frame refs + consumption state (`fresh|consumed|cloned`)
3. `ObjectRecord`: `objectId`, `typeTag`, `props`, `prototypeRef`
4. `UnsupportedRecord`: `path`, `kind`, `reason`, `fallbackPolicy`
5. `DebugMap`: source location <-> machine step mapping
6. `EventLogEntry`: deterministic boundary trace row

## 9) Unsupported Value Policy
1. Functions: symbolic handle; preserve identity when resolvable in session registry.
2. DOM nodes: opaque placeholder + structured warning.
3. Native host objects: opaque placeholder + warning + policy tag.
4. WeakMap/WeakSet/WeakRef/FinalizationRegistry: unsupported in MVP restore fidelity; explicit warning.
5. Symbols: preserve global symbols by key; local symbols best effort only with warning.

No silent fallback allowed. Every unsupported capture/restore emits `warning` event + record.

## 10) Implementation Waves (Parallelized)
### Wave 0: Foundation (blocking)
1. Monorepo scaffold + TS strict configs + workspace tooling.
2. Contracts package finalized.
3. Delorean fixture corpus frozen from `HEAD` scenarios.
4. Acceptance harness with golden traces.

### Wave 0.5: Browser feasibility spike (short, parallel-safe)
1. Prototype minimal artifact run in browser harness.
2. Validate deterministic wrappers viability for timers/clock.
3. Produce parity risk report before API freeze.

### Wave 1: Parallel tracks
| Track | Focus | Depends On | Output |
|---|---|---|---|
| A | Compiler IR/lowering | Wave 0 | `@unwinder/compiler` + `debugMap` |
| B | Runtime engine | Wave 0 | `DebugSession` + one-shot continuation semantics |
| C | Snapshot graph | Wave 0 | rooted graph capture/restore + unsupported registry |
| D | Determinism | Wave 0 | boundary wrappers + event log/replay |
| E | Node runner | Wave 0 | CLI (`compile/run/replay`) + JSON reports |
| F | Delorean adapter | A+B+C+D minimal | timepoint mapping APIs + metadata compatibility |
| G | Quality/perf | Wave 0 | contracts, determinism tests, benchmarks |

### Wave 2: Convergence
1. Integrate A+B+C+D with E harness.
2. Integrate adapter (F) against Delorean corpus.
3. Resolve event/API mismatches.
4. Freeze v2 API and changelog.

### Wave 3: Browser parity
1. Implement `@unwinder/browser-runner` contracts.
2. Add browser serialization policies.
3. Execute Node-vs-browser parity suite.

## 11) Agent Task Packets
### Packet A: Compiler
1. Parse + transform entry.
2. Lower `callCC` and checkpoint markers to runtime ops.
3. Emit artifact (`irHash`, `debugMap`, instrumentation mode).
4. Tests: nested calls, loops, try/catch/finally, async boundaries.

### Packet B: Runtime
1. Implement `DebugSession` lifecycle.
2. Continuation capture/resume semantics with consume-on-resume.
3. Add `cloneContinuation` branching semantics.
4. Emit events: `paused`, `resumed`, `checkpoint`, `restored`, `warning`, `error`, `finish`.

### Packet C: Snapshot
1. Rooted graph traversal with cycle/identity preservation.
2. Restore pipeline + patch override merge.
3. Unsupported registry integration.
4. Snapshot size/latency instrumentation.

### Packet D: Determinism
1. Wrap nondeterministic APIs in runner contexts.
2. Log/replay mechanism with sequence IDs.
3. Determinism mismatch detector.
4. Fallback policy for uncontrolled host ops.

### Packet E: Node runner
1. CLI: `unwinder compile|run|replay`.
2. Machine-readable report (`trace`, `snapshots`, `warnings`, `perf`).
3. Fixture integration runner.

### Packet F: Delorean adapter
1. Replace eval/global flow with explicit session lifecycle.
2. Map insertTimepoint/insertBreakpoint -> `checkpoint`.
3. Map timepoint resume -> `resumeTimepoint` with patch support.
4. Preserve UI timeline fields.

### Packet G: Quality/perf
1. Contract tests from Delorean scenarios.
2. Property-based tests for resume determinism.
3. Benchmarks: compile latency, checkpoint latency, snapshot size, resume latency.

## 12) Testing Matrix
### Core semantics
1. `callCC` capture returns resumable continuation with correct frame restore.
2. Loop-branch resume preserves branch-local state.
3. Exception flow preserves catch/finally semantics across resume.
4. Multiple resumes require explicit clone and create distinct timelines.

### Snapshot
1. Cyclic graphs restore identity.
2. Arrays/maps/sets/dates/regexps restore correctly.
3. Unsupported values flagged explicitly.
4. Patch overrides applied after restore, before resume.

### Determinism
1. Same input + same log + same patch -> identical trace.
2. Uncontrolled nondeterministic operation -> deterministic warning/error contract.
3. Timer ordering and replay consistency within supported scheduler model.

### Delorean integration
1. Existing sample scenarios run through adapter with expected timeline metadata.
2. Breakpoint pause/resume works on selected timepoint.
3. “Fix bug” flow (patch value then resume) produces changed path deterministically.
4. Timeline branching produces distinct `timelineId` lineage.

### Stability
1. 100 repeated resume cycles under memory threshold.
2. No unbounded growth in event log under configured pruning policy.

## 13) Release Gates
1. M1: Node MVP (compiler/runtime/snapshot/determinism) + green core tests.
2. M2: Delorean adapter green on fixture corpus.
3. M3: Browser parity suite green.
4. M4: Migration docs + legacy deprecation notice.

## 14) Decision Log
### 2026-02-27
1. Clean-break v2 selected.
Reason: Legacy surface is unstable, low confidence refactor base.

2. Node-first delivery selected.
Reason: Fastest path to deterministic MVP and Delorean unblock.

3. Early browser spike added.
Reason: Prevent late parity surprises from host constraints.

4. Hybrid replay model selected.
Reason: Snapshot-only approach insufficient for deterministic replay guarantees.

5. One-shot continuation default selected.
Reason: Safer semantics and lower memory/complexity; explicit clone supports branching.

6. Explicit checkpoint-first instrumentation selected.
Reason: Delivers Delorean value first, postpones broad instrumentation risk.

## 15) Explicit Assumptions
1. TypeScript strict mode for all new packages.
2. Node 20+ baseline.
3. npm workspaces for MVP monorepo orchestration.
4. Delorean current WIP ignored; integration target is committed `HEAD` behavior.
5. Legacy `unwinder-engine@0.0.x` is reference-only.

## 16) Immediate Execution Checklist (next agent)
1. Use project directory `/Users/feliperuiz/fruizrob/continuation-engine` (renamed from `unwinder-v2`).
2. Initialize repository if missing: `git init /Users/feliperuiz/fruizrob/continuation-engine`.
3. Create package skeletons and contracts first.
4. Import Delorean fixture corpus and freeze expected traces.
5. Implement runtime+scheduler determinism boundaries before adapter wiring.
6. Deliver M1 acceptance report in machine-readable JSON.
