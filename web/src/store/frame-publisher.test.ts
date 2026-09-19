import { describe, expect, it } from "vitest";
import { createFramePublisher } from "./frame-publisher";

type QueuedFrame = {
  id: number;
  callback: () => void;
  canceled: boolean;
};

function createFakeFrameClock() {
  let nextId = 1;
  const frames: QueuedFrame[] = [];
  const canceledIds: unknown[] = [];

  return {
    requestFrame(callback: () => void): unknown {
      const frame = { id: nextId, callback, canceled: false };
      nextId += 1;
      frames.push(frame);
      return frame.id;
    },
    cancelFrame(id: unknown): void {
      canceledIds.push(id);
      const frame = frames.find((queued) => queued.id === id);
      if (frame) {
        frame.canceled = true;
      }
    },
    pendingFrames(): QueuedFrame[] {
      return frames.filter((frame) => !frame.canceled);
    },
    canceledIds(): unknown[] {
      return canceledIds;
    },
    runFrame(id: number): void {
      const frame = frames.find((queued) => queued.id === id);
      if (!frame) {
        throw new Error(`missing frame ${id}`);
      }
      frame.callback();
    },
    runNextFrame(): void {
      const frame = frames.find((queued) => !queued.canceled);
      if (!frame) {
        throw new Error("missing pending frame");
      }
      frame.callback();
      frame.canceled = true;
    },
  };
}

describe("createFramePublisher", () => {
  it("publishes only the latest queued value on one frame", () => {
    const clock = createFakeFrameClock();
    const published: string[] = [];
    const publisher = createFramePublisher<string>({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      publish: (value) => published.push(value),
    });

    publisher.queue("first");
    publisher.queue("second");
    publisher.queue("latest");

    expect(clock.pendingFrames()).toHaveLength(1);
    expect(published).toEqual([]);

    clock.runNextFrame();

    expect(published).toEqual(["latest"]);
  });

  it("flushes the latest queued value immediately and cancels the queued frame", () => {
    const clock = createFakeFrameClock();
    const published: string[] = [];
    const publisher = createFramePublisher<string>({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      publish: (value) => published.push(value),
    });

    publisher.queue("old");
    publisher.queue("latest");
    publisher.flush();

    expect(published).toEqual(["latest"]);
    expect(clock.canceledIds()).toEqual([1]);
  });

  it("ignores a stale frame callback after flush publishes the pending value", () => {
    const clock = createFakeFrameClock();
    const published: string[] = [];
    const publisher = createFramePublisher<string>({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      publish: (value) => published.push(value),
    });

    publisher.queue("old");
    publisher.flush();
    publisher.queue("new");
    clock.runFrame(1);
    clock.runFrame(2);

    expect(published).toEqual(["old", "new"]);
  });

  it("drops pending work and ignores later queues after disposal", () => {
    const clock = createFakeFrameClock();
    const published: string[] = [];
    const publisher = createFramePublisher<string>({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      publish: (value) => published.push(value),
    });

    publisher.queue("pending");
    publisher.dispose();
    clock.runFrame(1);
    publisher.queue("ignored");
    publisher.flush();

    expect(published).toEqual([]);
    expect(clock.canceledIds()).toEqual([1]);
    expect(clock.pendingFrames()).toHaveLength(0);
  });

  it("publishes a reentrant queue on the next frame", () => {
    const clock = createFakeFrameClock();
    const published: string[] = [];
    const publisher = createFramePublisher<string>({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      publish: (value) => {
        published.push(value);
        if (value === "first") {
          publisher.queue("second");
        }
      },
    });

    publisher.queue("first");
    clock.runNextFrame();

    expect(published).toEqual(["first"]);
    expect(clock.pendingFrames()).toHaveLength(1);

    clock.runNextFrame();

    expect(published).toEqual(["first", "second"]);
  });
});
