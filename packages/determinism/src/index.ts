import type { DebugSession, DeterminismController, EventLogEntry, EventLogKind } from "@unwinder/contracts";

type Controller = DeterminismController & {
  record(kind: EventLogKind, op: string, input: unknown, output: unknown): EventLogEntry;
};

export function createDeterminismController(clock: () => number = Date.now): Controller {
  let attachedSession: DebugSession | null = null;
  let sequence = 0;
  const log: EventLogEntry[] = [];

  return {
    attach(session: DebugSession): void {
      attachedSession = session;
    },
    detach(): void {
      attachedSession = null;
    },
    getLog(fromSeq = 0): EventLogEntry[] {
      return log.filter((entry) => entry.seq >= fromSeq);
    },
    replay(entries: EventLogEntry[]): void {
      log.length = 0;
      for (const entry of entries) {
        log.push({ ...entry });
      }
      sequence = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    },
    record(kind: EventLogKind, op: string, input: unknown, output: unknown): EventLogEntry {
      const entry: EventLogEntry = {
        seq: ++sequence,
        kind,
        op,
        input,
        output,
        timestampMs: clock(),
      };
      log.push(entry);

      return entry;
    },
  };
}
