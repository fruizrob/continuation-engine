export class DebugSessionNotImplementedError extends Error {
  constructor() {
    super("@unwinder/runtime not implemented yet");
    this.name = "DebugSessionNotImplementedError";
  }
}
