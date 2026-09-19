export type RequestTask<T> = {
  load: (signal: AbortSignal) => Promise<T>;
  accept: (value: T) => void;
};

export type RequestState = {
  status: "idle" | "loading" | "ready" | "failed";
  generation: number;
  attemptsUsed: number;
  error: string | null;
};

export type RequestScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export class RequestOwner<T> {
  private state: RequestState = { status: "idle", generation: 0, attemptsUsed: 0, error: null };
  private task: RequestTask<T> | null = null;
  private controller: AbortController | null = null;
  private timer: unknown = null;
  private disposed = false;

  constructor(private readonly options: { scheduler: RequestScheduler; onChange?: () => void }) {}

  start(task: RequestTask<T>): void {
    if (this.disposed) return;
    this.task = task;
    this.state.attemptsUsed = 0;
    this.state.error = null;
    this.nextAttempt();
  }

  recover(task?: RequestTask<T>): void {
    if (this.disposed) return;
    if (task) this.task = task;
    if (this.task) this.nextAttempt();
  }

  retry(): void {
    if (!this.disposed && this.task) this.start(this.task);
  }

  cancel(options?: { preserveBudget?: boolean }): void {
    void options;
    if (!this.disposed) this.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }

  getState(): RequestState {
    return { ...this.state };
  }

  private clear(): void {
    this.invalidate();
    this.state.status = "idle";
    this.state.attemptsUsed = 0;
    this.state.error = null;
    this.options.onChange?.();
  }

  private invalidate(): void {
    this.state.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.timer !== null) {
      this.options.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private nextAttempt(): void {
    const task = this.task;
    if (!task || this.disposed) return;
    this.invalidate();
    const delays = [0, 500, 1000, 2000, 4000];
    const delay = delays[this.state.attemptsUsed];
    if (delay === undefined) {
      this.state.status = "failed";
      this.options.onChange?.();
      return;
    }

    this.state.attemptsUsed += 1;
    this.state.status = "loading";
    const generation = this.state.generation;
    this.options.onChange?.();
    if (!this.isCurrent(generation)) return;
    if (delay === 0) {
      void this.load(task, generation);
    } else {
      this.timer = this.options.scheduler.setTimeout(() => {
        if (!this.isCurrent(generation)) return;
        this.timer = null;
        void this.load(task, generation);
      }, delay);
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.state.generation;
  }

  private async load(task: RequestTask<T>, generation: number): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      const value = await task.load(controller.signal);
      if (!this.isCurrent(generation)) return;
      task.accept(value);
      if (!this.isCurrent(generation)) return;
      this.controller = null;
      this.state.status = "ready";
      this.state.attemptsUsed = 0;
      this.state.error = null;
      this.options.onChange?.();
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.state.error = error instanceof Error ? error.message : "Request failed";
      this.nextAttempt();
    }
  }
}
