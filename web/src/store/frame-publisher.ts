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
  void options;
  throw new Error("createFramePublisher is not implemented");
}
