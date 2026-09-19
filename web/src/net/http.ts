import { decodeWire } from "./wire/schema";

const defaultTimeoutMs = 5_000;
const defaultMaxBytes = 2 * 1024 * 1024;

export type FetchOptions = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
};

export async function fetchWire(
  kind: Parameters<typeof decodeWire>[0],
  url: string,
  options: FetchOptions = {},
): Promise<Record<string, unknown>> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = positiveFiniteOrDefault(options.timeoutMs, defaultTimeoutMs);
  const maxBytes = positiveFiniteCappedOrDefault(options.maxBytes, defaultMaxBytes);
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let parentAbortListener: (() => void) | undefined;

  const abortPromise = new Promise<never>((_, reject) => {
    const abort = (reason: unknown) => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
      reject(toAbortError(reason));
    };

    timeoutId = setTimeout(() => {
      abort(new DOMException("fetchWire deadline exceeded", "TimeoutError"));
    }, timeoutMs);

    if (options.signal) {
      parentAbortListener = () => {
        abort(options.signal?.reason ?? new DOMException("Parent abort", "AbortError"));
      };
      options.signal.addEventListener("abort", parentAbortListener);
      if (options.signal.aborted) {
        parentAbortListener();
      }
    }

    controller.signal.addEventListener("abort", () => {
      reject(toAbortError(controller.signal.reason));
    });
  });

  try {
    const fetchPromise = fetcher(url, {
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    fetchPromise.catch(() => undefined);

    const response = await Promise.race([fetchPromise, abortPromise]);
    if (!response.ok) {
      cancelBody(response, `HTTP ${response.status}`);
      throw new Error(`HTTP ${response.status} while fetching ${kind}`);
    }

    const raw = await readBoundedBody(response, maxBytes, controller.signal, abortPromise);
    return decodeWire(kind, raw);
  } catch (error) {
    throw normalizeError(error, kind);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (options.signal && parentAbortListener) {
      options.signal.removeEventListener("abort", parentAbortListener);
    }
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  abortPromise: Promise<never>,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let releaseReader = true;

  try {
    while (true) {
      const readPromise = reader.read();
      readPromise.catch(() => undefined);
      const result = await Promise.race([readPromise, abortPromise]);

      if (result.done) {
        break;
      }

      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        releaseReader = false;
        void reader.cancel("response body exceeded byte limit").catch(() => undefined);
        throw new Error(`response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (signal.aborted) {
      releaseReader = false;
      void reader.cancel(signal.reason).catch(() => undefined);
    }
    throw error;
  } finally {
    if (releaseReader) {
      reader.releaseLock();
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (cause) {
    throw new Error("invalid UTF-8 response body", { cause });
  }
}

function cancelBody(response: Response, reason: string): void {
  if (!response.body) {
    return;
  }

  void response.body.cancel(reason).catch(() => undefined);
}

function positiveFiniteOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveFiniteCappedOrDefault(value: number | undefined, cap: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, cap)
    : cap;
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException("fetchWire aborted", "AbortError");
}

function normalizeError(error: unknown, kind: Parameters<typeof decodeWire>[0]): Error {
  if (error instanceof Error) {
    if (/json|schema|status|bytes|size|large|timeout|deadline|abort|http/i.test(error.message)) {
      return error;
    }
    return new Error(`failed to fetch ${kind}: ${error.message}`, { cause: error });
  }

  return new Error(`failed to fetch ${kind}`, { cause: error });
}
