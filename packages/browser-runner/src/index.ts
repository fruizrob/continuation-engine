import type {
  HeapPatch,
  ProgramArtifact,
  ResumeResult,
  RunResult,
  ScopeState,
  SnapshotId,
} from "@unwinder/contracts";
import { createDebugSession } from "@unwinder/runtime";

export type BrowserRunnerOptions = {
  checkpointId?: string;
  patch?: HeapPatch;
  autoResume?: boolean;
};

export type BrowserRunnerReport = {
  runResult: RunResult;
  checkpointId: string;
  snapshotId: SnapshotId;
  resumeResult?: ResumeResult;
  scope: ScopeState;
};

export function runBrowserArtifact(
  artifact: ProgramArtifact,
  options: BrowserRunnerOptions = {},
): BrowserRunnerReport {
  const checkpointId = options.checkpointId ?? "browser-entry";
  const autoResume = options.autoResume !== false;

  const session = createDebugSession(artifact, {
    mode: "debug",
    oneShotDefault: true,
  });

  const runResult = session.run();
  const snapshotId = session.checkpoint(checkpointId);

  const report: BrowserRunnerReport = {
    runResult,
    checkpointId,
    snapshotId,
    scope: session.inspect(),
  };

  if (autoResume) {
    report.resumeResult = session.resume(snapshotId, options.patch);
    report.scope = session.inspect();
  }

  session.dispose();

  return report;
}
