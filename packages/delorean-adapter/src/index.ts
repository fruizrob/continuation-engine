import type {
  DebugSession,
  DeloreanCompileResult,
  HeapPatch,
  ProgramArtifact,
  ResumeResult,
  SessionOptions,
  SourceLoc,
  TimepointMeta,
} from "@unwinder/contracts";
import { compile } from "@unwinder/compiler";
import { createDebugSession } from "@unwinder/runtime";

type Marker = {
  id: string;
  kind: "timepoint" | "breakpoint";
  loc?: SourceLoc;
};

type DeloreanCompileOptions = {
  sourceMap?: boolean;
};

const sessionTimepointMap = new WeakMap<DebugSession, Map<string, string>>();

function buildTimepointIndex(markers: Marker[]): Record<string, TimepointMeta> {
  const index: Record<string, TimepointMeta> = {};

  for (const marker of markers) {
    const meta: TimepointMeta = {
      timepointId: marker.id,
      label: marker.kind,
    };
    if (marker.loc) {
      meta.loc = marker.loc;
    }
    index[marker.id] = meta;
  }

  return index;
}

function getMarkersFromArtifact(artifact: ProgramArtifact): Marker[] {
  const map = artifact.debugMap as {
    markers?: Marker[];
  };

  return Array.isArray(map.markers) ? map.markers : [];
}

export function compileForDelorean(
  source: string,
  opts?: DeloreanCompileOptions,
): DeloreanCompileResult {
  const result = compile(source, {
    target: "node",
    sourceMap: Boolean(opts?.sourceMap),
    instrumentation: "checkpoint-first",
  });

  return {
    artifact: result.artifact,
    timepointIndex: buildTimepointIndex(getMarkersFromArtifact(result.artifact)),
  };
}

export function createDeloreanSession(
  artifact: ProgramArtifact,
  opts?: SessionOptions,
): DebugSession {
  const session = createDebugSession(artifact, {
    mode: "debug",
    oneShotDefault: true,
    ...opts,
  });

  const map = new Map<string, string>();
  session.on("checkpoint", ({ checkpointId, snapshotId }) => {
    map.set(checkpointId, snapshotId);
  });

  sessionTimepointMap.set(session, map);
  return session;
}

export function resumeTimepoint(
  session: DebugSession,
  timepointId: string,
  patch?: HeapPatch,
): ResumeResult {
  const map = sessionTimepointMap.get(session);
  const snapshotId = map?.get(timepointId) ?? timepointId;
  return session.resume(snapshotId, patch);
}
