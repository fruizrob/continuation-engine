# continuation-engine

Continuation/runtime project for deterministic time-travel debugging, rebuilt from scratch for Delorean integration.

Canonical spec:
- `UNWINDER_V2_REBUILD_PLAN.md`

## Workspace layout
- `packages/*`: core compiler/runtime/snapshot/determinism + runners + Delorean adapter
- `fixtures/delorean-head`: frozen Delorean integration scenarios (to import in Wave 0)
- `fixtures/harness`: acceptance harness and golden traces
- `docs`: architecture and contracts

## Current implementation status
- Compiler: rewrites `callCC`, extracts Delorean markers, emits IR + lowered opcodes in `artifact.debugMap`.
- Runtime: consumes `debugMap.lowering` for pc-driven `step()` / `continue()` with checkpoint/breakpoint pause boundaries.
- Determinism: logs host + opcode transition assertions (`opcode.transition.assert`) and supports replay comparison gates.
- Node runner: `compile|run|replay` flow with JSON reports, deterministic replay mismatch failures, and optional continue gates.

## Quick start
1. `npm install`
2. `npm run typecheck`
3. `npm run test`

## Node CLI
`@unwinder/node-runner` exposes the `unwinder` CLI:

- `unwinder compile <input.js>`
- `unwinder run <input.js> [--checkpoint <id>] [--patch '{"k":1}'] [--continue-gates <N>] [--out <report.json>]`
- `unwinder replay <input.js> [--checkpoint <id>] [--snapshot <id>] [--patch '{"k":1}'] [--continue-gates <N>] [--event-log <log.json>] [--out <report.json>]`

`--continue-gates <N>` executes up to `N` `continue()` transitions after resume and stores results in `continueResults`.
Use this mode when deterministic replay assertions must include opcode-transition events (`opcode.transition.assert`) end-to-end.

Example flow:
1. `unwinder run app.js --checkpoint entry --continue-gates 3 --out run-report.json`
2. Use `run-report.json.determinismLog` (or full report JSON) as replay baseline.
3. `unwinder replay app.js --checkpoint entry --continue-gates 3 --event-log run-report.json --out replay-report.json`

Replay returns exit code `1` when `replayGate.ok` is `false`.
