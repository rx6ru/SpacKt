import { describe, expect, it, vi } from "vitest";
import { RequestOwner, type RequestScheduler, type RequestState, type RequestTask } from "./request-owner";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

class FakeScheduler implements RequestScheduler {
  nowMs = 0;
  private nextID = 1;
  private timers = new Map<number, { callback: () => void; dueMs: number }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextID++;
    this.timers.set(id, { callback, dueMs: this.nowMs + delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advanceBy(delayMs: number): void {
    this.nowMs += delayMs;
    for (;;) {
      const ready = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueMs <= this.nowMs)
        .sort((left, right) => left[1].dueMs - right[1].dueMs || left[0] - right[0]);
      if (ready.length === 0) {
        return;
      }
      const [id, timer] = ready[0];
      this.timers.delete(id);
      timer.callback();
    }
  }

  pendingDelays(): number[] {
    return [...this.timers.values()]
      .map((timer) => timer.dueMs - this.nowMs)
      .sort((left, right) => left - right);
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const task = <T>(
  result: Deferred<T>,
  accept: (value: T) => void = () => {},
): RequestTask<T> & { signals: AbortSignal[] } => {
  const signals: AbortSignal[] = [];
  return {
    signals,
    load(signal: AbortSignal) {
      signals.push(signal);
      return result.promise;
    },
    accept,
  };
};

describe("RequestOwner retry ownership", () => {
  it("uses the five-attempt delay schedule and then fails", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const attempts = Array.from({ length: 5 }, () => deferred<string>());
    let loads = 0;
    const failingTask: RequestTask<string> = {
      load() {
        return attempts[loads++].promise;
      },
      accept: vi.fn(),
    };

    owner.start(failingTask);
    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 1 });
    attempts[0].reject(new Error("first failed"));
    await flushMicrotasks();
    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 2 });
    expect(scheduler.pendingDelays()).toEqual([500]);

    scheduler.advanceBy(500);
    attempts[1].reject(new Error("second failed"));
    await flushMicrotasks();
    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 3 });
    expect(scheduler.pendingDelays()).toEqual([1_000]);

    scheduler.advanceBy(1_000);
    attempts[2].reject(new Error("third failed"));
    await flushMicrotasks();
    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 4 });
    expect(scheduler.pendingDelays()).toEqual([2_000]);

    scheduler.advanceBy(2_000);
    attempts[3].reject(new Error("fourth failed"));
    await flushMicrotasks();
    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 5 });
    expect(scheduler.pendingDelays()).toEqual([4_000]);

    scheduler.advanceBy(4_000);
    attempts[4].reject(new Error("final failed"));
    await flushMicrotasks();
    expect(owner.getState()).toMatchObject({ status: "failed", attemptsUsed: 5 });
    expect(owner.getState().error).toMatch(/final failed|request/i);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("recover replaces work without resetting the attempt budget and aborts the previous attempt", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const first = task(deferred<string>());
    const secondResult = deferred<string>();
    const secondAccept = vi.fn();
    const second = task(secondResult, secondAccept);

    owner.start(first);
    owner.recover(second);

    expect(first.signals[0].aborted).toBe(true);
    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 2 });
    expect(scheduler.pendingDelays()).toEqual([500]);

    scheduler.advanceBy(500);
    secondResult.resolve("ok");
    await flushMicrotasks();

    expect(secondAccept).toHaveBeenCalledWith("ok");
    expect(owner.getState()).toMatchObject({ status: "ready", attemptsUsed: 0, error: null });
  });

  it("ignores old success and failure callbacks after work is superseded", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const oldSuccess = deferred<string>();
    const oldSuccessAccept = vi.fn();
    const oldSuccessTask = task(oldSuccess, oldSuccessAccept);
    const currentAfterSuccess = deferred<string>();
    const currentAccept = vi.fn();
    const currentTask = task(currentAfterSuccess, currentAccept);

    owner.start(oldSuccessTask);
    owner.start(currentTask);
    oldSuccess.resolve("old");
    await flushMicrotasks();

    expect(oldSuccessAccept).not.toHaveBeenCalled();
    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 1 });

    const oldFailure = deferred<string>();
    owner.start(task(oldFailure, vi.fn()));
    owner.start(currentTask);
    oldFailure.reject(new Error("late old failure"));
    await flushMicrotasks();
    expect(scheduler.pendingCount()).toBe(0);
    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 1 });

    currentAfterSuccess.resolve("current");
    await flushMicrotasks();
    expect(currentAccept).toHaveBeenCalledWith("current");
    expect(owner.getState()).toMatchObject({ status: "ready", attemptsUsed: 0 });
  });

  it("treats accept errors as retryable failures", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const first = deferred<string>();
    const second = deferred<string>();
    let loads = 0;
    const accepts = vi.fn((value: string) => {
      if (value === "stale") {
        throw new Error("wrong session");
      }
    });
    owner.start({
      load: () => (loads++ === 0 ? first.promise : second.promise),
      accept: accepts,
    });

    first.resolve("stale");
    await flushMicrotasks();

    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 2 });
    expect(owner.getState().error).toMatch(/wrong session/);
    expect(scheduler.pendingDelays()).toEqual([500]);

    scheduler.advanceBy(500);
    second.resolve("fresh");
    await flushMicrotasks();

    expect(accepts).toHaveBeenLastCalledWith("fresh");
    expect(owner.getState()).toMatchObject({ status: "ready", attemptsUsed: 0, error: null });
  });

  it("cancel and dispose abort work clear timers and ignore later callbacks", async () => {
    const scheduler = new FakeScheduler();
    const onChange = vi.fn();
    const owner = new RequestOwner<string>({ scheduler, onChange });
    const result = deferred<string>();
    const accept = vi.fn();
    const active = task(result, accept);

    owner.start(active);
    owner.cancel();

    expect(active.signals[0].aborted).toBe(true);
    expect(owner.getState()).toMatchObject({ status: "idle", attemptsUsed: 0 });
    result.resolve("late");
    await flushMicrotasks();
    expect(accept).not.toHaveBeenCalled();

    owner.dispose();
    const disposedResult = deferred<string>();
    owner.start(task(disposedResult));
    disposedResult.resolve("ignored");
    await flushMicrotasks();

    expect(owner.getState()).toMatchObject({ status: "idle" });
    expect(scheduler.pendingCount()).toBe(0);
    const callsAfterDispose = onChange.mock.calls.length;
    owner.retry();
    expect(onChange).toHaveBeenCalledTimes(callsAfterDispose);
  });

  it("cancel clears a scheduled retry timer and prevents later timer work", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const first = deferred<string>();
    const later = deferred<string>();
    let loads = 0;
    owner.start({
      load: () => (loads++ === 0 ? first.promise : later.promise),
      accept: vi.fn(),
    });

    first.reject(new Error("network down"));
    await flushMicrotasks();
    expect(scheduler.pendingDelays()).toEqual([500]);

    owner.cancel();
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.advanceBy(500);

    expect(loads).toBe(1);
    expect(owner.getState()).toMatchObject({ status: "idle", attemptsUsed: 0 });
  });

  it("default cancel clears a scheduled retry and resets the episode budget", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const first = deferred<string>();
    owner.start({
      load: () => first.promise,
      accept: vi.fn(),
    });

    first.reject(new Error("offline"));
    await flushMicrotasks();
    expect(owner.getState()).toMatchObject({
      status: "loading",
      attemptsUsed: 2,
      error: "offline",
    });
    expect(scheduler.pendingDelays()).toEqual([500]);

    owner.cancel();

    expect(scheduler.pendingCount()).toBe(0);
    expect(owner.getState()).toMatchObject({
      status: "idle",
      attemptsUsed: 0,
      error: null,
    });
  });

  it("preserve-budget cancel clears a scheduled retry and recover uses the next delay", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const attempts = [deferred<string>(), deferred<string>()];
    let loads = 0;
    owner.start({
      load: () => attempts[loads++].promise,
      accept: vi.fn(),
    });

    attempts[0].reject(new Error("offline"));
    await flushMicrotasks();
    const generationBeforeCancel = owner.getState().generation;
    expect(scheduler.pendingDelays()).toEqual([500]);

    owner.cancel({ preserveBudget: true });

    expect(scheduler.pendingCount()).toBe(0);
    expect(owner.getState().generation).toBeGreaterThan(generationBeforeCancel);
    expect(owner.getState()).toMatchObject({
      status: "idle",
      attemptsUsed: 2,
      error: "offline",
    });
    scheduler.advanceBy(500);
    expect(loads).toBe(1);

    owner.recover();

    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 3 });
    expect(scheduler.pendingDelays()).toEqual([1_000]);
    scheduler.advanceBy(999);
    expect(loads).toBe(1);
    scheduler.advanceBy(1);
    expect(loads).toBe(2);
  });

  it("preserve-budget cancel aborts active work and ignores its late success", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const attempts = [deferred<string>(), deferred<string>()];
    const signals: AbortSignal[] = [];
    let loads = 0;
    const accept = vi.fn();
    owner.start({
      load(signal) {
        signals.push(signal);
        return attempts[loads++].promise;
      },
      accept,
    });

    attempts[0].reject(new Error("first failed"));
    await flushMicrotasks();
    scheduler.advanceBy(500);
    expect(loads).toBe(2);
    const generationBeforeCancel = owner.getState().generation;

    owner.cancel({ preserveBudget: true });

    expect(signals[1].aborted).toBe(true);
    expect(owner.getState().generation).toBeGreaterThan(generationBeforeCancel);
    expect(owner.getState()).toMatchObject({
      status: "idle",
      attemptsUsed: 2,
      error: "first failed",
    });
    attempts[1].resolve("late");
    await flushMicrotasks();
    expect(accept).not.toHaveBeenCalled();
    expect(owner.getState()).toMatchObject({
      status: "idle",
      attemptsUsed: 2,
      error: "first failed",
    });
  });

  it("preserve-budget cancel keeps an exhausted episode from automatic recovery", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const attempts = Array.from({ length: 6 }, () => deferred<string>());
    let loads = 0;
    owner.start({
      load: () => attempts[loads++].promise,
      accept: vi.fn(),
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      attempts[attempt].reject(new Error(`failed ${attempt}`));
      await flushMicrotasks();
      if (attempt < 4) {
        scheduler.advanceBy([500, 1_000, 2_000, 4_000][attempt]);
      }
    }
    expect(owner.getState()).toMatchObject({
      status: "failed",
      attemptsUsed: 5,
      error: "failed 4",
    });

    owner.cancel({ preserveBudget: true });
    owner.recover();

    expect(loads).toBe(5);
    expect(scheduler.pendingCount()).toBe(0);
    expect(owner.getState()).toMatchObject({
      status: "failed",
      attemptsUsed: 5,
      error: "failed 4",
    });
  });

  it("dispose clears a scheduled retry timer and prevents later timer work", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const first = deferred<string>();
    const later = deferred<string>();
    let loads = 0;
    owner.start({
      load: () => (loads++ === 0 ? first.promise : later.promise),
      accept: vi.fn(),
    });

    first.reject(new Error("network down"));
    await flushMicrotasks();
    expect(scheduler.pendingDelays()).toEqual([500]);

    owner.dispose();
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.advanceBy(500);

    expect(loads).toBe(1);
    expect(owner.getState()).toMatchObject({ status: "idle", attemptsUsed: 0 });
  });

  it("manual retry starts a fresh episode after five-attempt failure", async () => {
    const scheduler = new FakeScheduler();
    const owner = new RequestOwner<string>({ scheduler });
    const attempts = Array.from({ length: 6 }, () => deferred<string>());
    let loads = 0;
    const accept = vi.fn();
    const reusable: RequestTask<string> = {
      load: () => attempts[loads++].promise,
      accept,
    };

    owner.start(reusable);
    for (let attempt = 0; attempt < 5; attempt++) {
      attempts[attempt].reject(new Error(`failed ${attempt}`));
      await flushMicrotasks();
      if (attempt < 4) {
        scheduler.advanceBy([500, 1_000, 2_000, 4_000][attempt]);
      }
    }
    expect(owner.getState()).toMatchObject({ status: "failed", attemptsUsed: 5 });

    owner.retry();
    expect(owner.getState()).toMatchObject({ status: "loading", attemptsUsed: 1 });
    attempts[5].resolve("manual retry");
    await flushMicrotasks();

    expect(accept).toHaveBeenCalledWith("manual retry");
    expect(owner.getState()).toMatchObject({ status: "ready", attemptsUsed: 0 });
  });

  it("notifies observable state transitions without depending on incidental call count", async () => {
    const scheduler = new FakeScheduler();
    const states: RequestState[] = [];
    const owner = new RequestOwner<string>({
      scheduler,
      onChange: () => {
        states.push(owner.getState());
      },
    });
    const first = deferred<string>();
    const second = deferred<string>();
    let loads = 0;
    owner.start({
      load: () => (loads++ === 0 ? first.promise : second.promise),
      accept: vi.fn(),
    });

    first.reject(new Error("retry me"));
    await flushMicrotasks();
    scheduler.advanceBy(500);
    second.resolve("ok");
    await flushMicrotasks();
    owner.cancel();

    expect(states.some((state) => state.status === "loading" && state.attemptsUsed === 1)).toBe(true);
    expect(states.some((state) => state.status === "loading" && state.attemptsUsed === 2)).toBe(true);
    expect(states.some((state) => state.status === "ready" && state.attemptsUsed === 0)).toBe(true);
    expect(states.some((state) => state.status === "idle" && state.attemptsUsed === 0)).toBe(true);
  });

  it("returns copied state and keeps two owners independent", () => {
    const scheduler = new FakeScheduler();
    const left = new RequestOwner<string>({ scheduler });
    const right = new RequestOwner<string>({ scheduler });

    const snapshot = left.getState();
    snapshot.status = "failed";
    snapshot.error = "mutated";
    expect(left.getState()).toMatchObject({ status: "idle", error: null });

    left.start(task(deferred<string>()));
    expect(left.getState()).toMatchObject({ status: "loading", generation: 1 });
    expect(right.getState()).toMatchObject({ status: "idle", generation: 0 });
  });
});
