"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { createInitialSnapshot, createMarketRuntime } from "../runtime/create-market-runtime";
import { createBrowserRuntimeOptions } from "../runtime/browser-options";
import { createFramePublisher } from "../store/frame-publisher";
import { createMarketStore } from "../store/market-store";
import { MarketConsole } from "../ui/market-console";
import type { MarketRuntime } from "../runtime/types";
import type { DebugCommand, MarketRuntimeSnapshot } from "../domain/market-view";
import type { Interval } from "../domain/model";

export function ClientEntry() {
  const initialSnapshot = useMemo(() => createInitialSnapshot("1m"), []);
  const store = useMemo(() => createMarketStore(initialSnapshot), [initialSnapshot]);
  const runtimeRef = useRef<MarketRuntime | null>(null);

  useEffect(() => {
    const runtime = createMarketRuntime(createBrowserRuntimeOptions("1m"));
    runtimeRef.current = runtime;
    const publisher = createFramePublisher<MarketRuntimeSnapshot>({
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id as number),
      publish: (snapshot) => store.setState(snapshot, true),
    });
    const unsubscribe = runtime.subscribe(() => publisher.queue(runtime.getSnapshot()));
    runtime.start();
    publisher.queue(runtime.getSnapshot());

    return () => {
      unsubscribe();
      publisher.dispose();
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, [store]);

  const selectInterval = useCallback((interval: Interval) => {
    runtimeRef.current?.selectInterval(interval);
  }, []);

  const retry = useCallback(() => {
    runtimeRef.current?.retry();
  }, []);

  const debug = useCallback((command: DebugCommand) => {
    runtimeRef.current?.debug(command);
  }, []);

  return (
    <MarketConsole
      store={store}
      onSelectInterval={selectInterval}
      onRetry={retry}
      onDebug={debug}
    />
  );
}
