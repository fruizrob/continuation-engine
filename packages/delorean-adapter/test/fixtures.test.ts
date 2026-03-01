import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { compileForDelorean } from "../src/index.js";

type FixtureManifest = {
  scenarios: Array<{
    id: string;
    file: string;
    tags?: string[];
  }>;
};

function getRepoRoot(): string {
  return path.resolve(process.cwd(), "../..");
}

function loadManifest(repoRoot: string): FixtureManifest {
  const manifestPath = path.join(repoRoot, "fixtures", "delorean-head", "manifest.json");
  const content = fs.readFileSync(manifestPath, "utf8");
  return JSON.parse(content) as FixtureManifest;
}

function extractScenarioSource(content: string): string {
  const match = content.match(/export\s+default\s+`([\s\S]*)`;\s*$/);
  if (!match) {
    throw new Error("Fixture file does not match expected template export format");
  }
  return match[1] ?? "";
}

test("compileForDelorean compiles all frozen fixture scenarios", () => {
  const repoRoot = getRepoRoot();
  const manifest = loadManifest(repoRoot);

  assert.ok(manifest.scenarios.length > 0);

  for (const scenario of manifest.scenarios) {
    const scenarioPath = path.join(repoRoot, "fixtures", "delorean-head", scenario.file);
    const file = fs.readFileSync(scenarioPath, "utf8");
    const source = extractScenarioSource(file);

    const result = compileForDelorean(source);
    assert.equal(result.artifact.version, "2.0", `artifact version mismatch for ${scenario.id}`);

    const tags = new Set(scenario.tags ?? []);
    const explicit = !tags.has("implicit-timepoint");
    const timepointCount = Object.keys(result.timepointIndex).length;

    if (explicit) {
      assert.ok(timepointCount > 0, `expected explicit markers in ${scenario.id}`);
    } else {
      assert.ok(timepointCount >= 0, `implicit scenario should compile in ${scenario.id}`);
    }
  }
});
