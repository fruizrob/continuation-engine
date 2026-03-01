# continuation-engine

Continuation/runtime project for deterministic time-travel debugging, rebuilt from scratch for Delorean integration.

Canonical spec:
- `UNWINDER_V2_REBUILD_PLAN.md`

## Workspace layout
- `packages/*`: core compiler/runtime/snapshot/determinism + runners + Delorean adapter
- `fixtures/delorean-head`: frozen Delorean integration scenarios (to import in Wave 0)
- `fixtures/harness`: acceptance harness and golden traces
- `docs`: architecture and contracts

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
