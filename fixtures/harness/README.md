# Acceptance Harness

Golden trace and replay acceptance harness.

Expected outputs:
- JSON trace files in `golden/`
- deterministic replay comparison reports

Quick checks:
- `npm run fixtures:verify`
- `npm run golden:refresh`

Golden fixtures:
- `sources/node-runner-basic.js`: canonical runner input for regression
- `golden/node-runner/*.json`: expected `compile|run|replay` reports
- `golden/node-runner/run-continue-gates.json`: run report with `continueGates` enabled
- `golden/node-runner/replay-continue-gates.json`: replay report with `continueGates` enabled to assert opcode-transition determinism

Regression intent:
1. `compile.json`, `run.json`, `replay.json` validate baseline compile/run/replay behavior.
2. `run-continue-gates.json`, `replay-continue-gates.json` lock deterministic replay behavior when opcode transition assertions are present.
