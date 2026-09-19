import { afterEach, describe, expect, it, vi } from "vitest";
import type { Interval } from "../domain/model";
import type { MarketRuntimeOptions } from "./types";

type BrowserOptionsModule = {
  createBrowserRuntimeOptions(defaultInterval: Interval): MarketRuntimeOptions;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("createBrowserRuntimeOptions browser defaults", () => {
  it("uses the browser monotonic clock when the wall clock jumps", async () => {
    const performanceNow = vi.fn(() => 1_250);
    vi.stubGlobal("performance", { now: performanceNow });
    vi.spyOn(Date, "now").mockReturnValue(90_000);
    const options = await createOptions("1s");

    expect(options.clock.now()).toBe(1_250);

    performanceNow.mockReturnValue(1_280);
    vi.mocked(Date.now).mockReturnValue(12_000);
    expect(options.clock.now()).toBe(1_280);
  });

  it("builds HTTPS REST and WSS URLs with the default 500 candle history query", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test");
    const options = await createOptions("1m");

    expect(options.urls.websocket).toBe("wss://api.example.test/ws");
    expect(options.urls.meta).toBe("https://api.example.test/api/meta");
    expect(options.urls.book).toBe("https://api.example.test/api/book");
    expect(options.urls.trades).toBe("https://api.example.test/api/trades?limit=50");
    expect(options.urls.history("1m", 37)).toBe(
      "https://api.example.test/api/candles?interval=1m&limit=500&requestId=37",
    );
  });
});

describe("browser options module loading", () => {
  it("imports without reading browser globals eagerly", async () => {
    await expect(import("./browser-options")).resolves.toHaveProperty("createBrowserRuntimeOptions");
  });
});

async function createOptions(defaultInterval: Interval): Promise<MarketRuntimeOptions> {
  const fetcher = vi.fn<typeof fetch>();
  const windowStub = {
    fetch: fetcher,
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
  };
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("navigator", { onLine: true });

  const { createBrowserRuntimeOptions } = (await import("./browser-options")) as BrowserOptionsModule;
  return createBrowserRuntimeOptions(defaultInterval);
}
