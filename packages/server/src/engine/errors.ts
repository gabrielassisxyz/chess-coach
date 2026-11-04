export type EngineFaultReason = "timeout" | "exited" | "bad-bestmove" | "stopped";

export class EngineFault extends Error {
  constructor(
    readonly reason: EngineFaultReason,
    message: string,
  ) {
    super(message);
    this.name = "EngineFault";
  }
}
