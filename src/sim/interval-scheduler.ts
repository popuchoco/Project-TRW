export type IntervalToken = number | object;
export type StartInterval = (callback: () => void, intervalMs: number) => IntervalToken;
export type StopInterval = (token: IntervalToken) => void;

export class IntervalScheduler {
  private token?: IntervalToken;

  constructor(
    private readonly callback: () => void,
    private readonly intervalMs: number,
    private readonly startInterval: StartInterval = (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
    private readonly stopInterval: StopInterval = (token) => globalThis.clearInterval(token as ReturnType<typeof setInterval>),
  ) {}

  start(): void {
    if (this.token !== undefined) return;
    this.token = this.startInterval(this.callback, this.intervalMs);
  }

  stop(): void {
    if (this.token === undefined) return;
    this.stopInterval(this.token);
    this.token = undefined;
  }
}
