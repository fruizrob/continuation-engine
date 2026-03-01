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
