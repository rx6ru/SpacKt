export type FramePublisher<T> = {
  queue(value: T): void;
  flush(): void;
  dispose(): void;
};

export type FramePublisherOptions<T> = {
  requestFrame(callback: () => void): unknown;
  cancelFrame(id: unknown): void;
  publish(value: T): void;
};

export function createFramePublisher<T>(options: FramePublisherOptions<T>): FramePublisher<T> {
  let frame: { id: unknown } | null = null;
  let pending: { value: T } | null = null;
  let disposed = false;

  function publishPending(): void {
    if (!pending) return;
    const { value } = pending;
    pending = null;
    options.publish(value);
  }

  function cancelFrame(): void {
    const scheduled = frame;
    frame = null;
    if (scheduled) options.cancelFrame(scheduled.id);
  }

  return {
    queue(value) {
      if (disposed) return;
      pending = { value };
      if (frame) return;
      const scheduled: { id: unknown } = { id: undefined };
      frame = scheduled;
      scheduled.id = options.requestFrame(() => {
        if (disposed || frame !== scheduled) return;
        frame = null;
        publishPending();
      });
    },
    flush() {
      if (disposed) return;
      cancelFrame();
      publishPending();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = null;
      cancelFrame();
    },
  };
}
