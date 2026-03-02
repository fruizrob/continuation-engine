# Architecture (Current State)

Source of truth:
- `UNWINDER_V2_REBUILD_PLAN.md`

## Package roles
- `@unwinder/compiler`: source -> transformed JS artifact + debug metadata.
- `@unwinder/runtime`: in-memory debug session, checkpoint/resume, pc-driven stepping.
- `@unwinder/snapshot`: rooted graph capture/restore.
- `@unwinder/determinism`: deterministic event log controller.
- `@unwinder/node-runner`: `compile|run|replay` CLI and JSON reporting.
- `@unwinder/delorean-adapter`: Delorean-facing compile/session APIs.

## Compiler pipeline
1. Parse source with Babel.
2. Rewrite `callCC` to `__unwinder.callCC`.
3. Extract Delorean markers (`insertTimepoint`, `insertBreakpoint`).
4. Build continuation-oriented IR (`debugMap.ir.instructions`).
5. Lower IR to opcodes (`debugMap.lowering.opcodes`) with location maps (`pcToLoc`, `locToPc`).
6. Emit artifact hash from generated chunk + lowered opcodes.

## Runtime execution model
- Runtime reads `artifact.debugMap.lowering` as the machine program.
- `step()` advances exactly one opcode and returns source location when available.
- `continue()` advances until boundary (`CHECKPOINT`/`BREAKPOINT`) or finish.
- Each opcode transition emits deterministic assertion log entries:
  - `op = "opcode.transition.assert"`
  - includes transition validity checks (`pcMatchesOpcode`, `nextPcExists`).
- Checkpoints persist bindings and machine state (`machinePc`, `stepIndex`, `machineFinished`) for deterministic resume.

## Deterministic replay gate
- Node runner compares expected vs actual determinism logs (timestamp-insensitive comparison).
- Replay gate mismatch sets:
  - `report.replayGate.ok = false`
  - error event in `report.events`
  - error status in `report.resumeResult`
- CLI returns non-zero on replay gate mismatch.

## Node runner continue gates
- `--continue-gates N` runs up to `N` `continue()` calls after `resume()`.
- Results are stored in `report.continueResults`.
- This is required when replay assertions must include opcode transition logs, not only host-level events.

## Current constraints
- Runtime is in-memory only (no persisted timeline storage yet).
- Browser parity package exists, but Node runner is the primary validated path.
- Legacy `unwinder-engine@0.0.x` compatibility mode is not implemented.
