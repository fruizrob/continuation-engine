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
