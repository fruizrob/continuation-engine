import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const fixtureRoot = path.join(root, "fixtures", "delorean-head");
const manifestPath = path.join(fixtureRoot, "manifest.json");

if (!fs.existsSync(manifestPath)) {
  console.error(`Missing fixture manifest: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const errors = [];

if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) {
  errors.push("Manifest has no scenarios");
}

for (const scenario of manifest.scenarios ?? []) {
  const rel = scenario.file;
  const abs = path.join(fixtureRoot, rel);
  const tags = Array.isArray(scenario.tags) ? scenario.tags : [];
  if (!fs.existsSync(abs)) {
    errors.push(`Missing scenario file for '${scenario.id}': ${rel}`);
    continue;
  }

  const text = fs.readFileSync(abs, "utf8");
  const hasMarker =
    text.includes("delorean.insertTimepoint") ||
    text.includes("delorean.insertBreakpoint");
  const isImplicitScenario = tags.includes("implicit-timepoint");
  if (!hasMarker && !isImplicitScenario) {
    errors.push(`Scenario '${scenario.id}' has no delorean timepoint/breakpoint marker`);
  }
}

if (errors.length > 0) {
  for (const err of errors) {
    console.error(err);
  }
  process.exit(1);
}

console.log(`fixture-verify-ok scenarios=${manifest.scenarios.length}`);
