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
  constructor(options: { scheduler: RequestScheduler; onChange?: () => void }) {
    void options;
  }

  start(task: RequestTask<T>): void {
    void task;
    throw new Error("Not implemented: RequestOwner.start");
  }

  recover(task?: RequestTask<T>): void {
    void task;
    throw new Error("Not implemented: RequestOwner.recover");
  }

  retry(): void {
    throw new Error("Not implemented: RequestOwner.retry");
  }

  cancel(): void {
    throw new Error("Not implemented: RequestOwner.cancel");
  }

  dispose(): void {
    throw new Error("Not implemented: RequestOwner.dispose");
  }

  getState(): RequestState {
    throw new Error("Not implemented: RequestOwner.getState");
  }
}
