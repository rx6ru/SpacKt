"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { TriangleDownIcon, TriangleUpIcon } from "@radix-ui/react-icons";
import {
  defaultWatchlistOrder,
  moveWatchlistItem,
  readWatchlistOrder,
  type WatchlistSymbol,
} from "../domain/watchlist";

const storageKey = "spackt.watchlist.v1";

type WatchlistState = {
  order: readonly WatchlistSymbol[];
  announcement: string;
  dragging: WatchlistSymbol | null;
  dropIndex: number | null;
  focusSymbol: WatchlistSymbol | null;
};

type StoragePort = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type WatchlistStore = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WatchlistState;
  hydrate(storage: StoragePort | null): void;
  move(symbol: WatchlistSymbol, targetIndex: number): void;
  startDrag(symbol: WatchlistSymbol): void;
  updateDropIndex(index: number | null): void;
  endDrag(symbol: WatchlistSymbol): void;
  cancelDrag(): void;
  clearFocus(symbol: WatchlistSymbol): void;
};

export function Watchlist() {
  const store = useMemo(() => createWatchlistStore(), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const rowRefs = useRef(new Map<WatchlistSymbol, HTMLLIElement>());
  const activePointerRef = useRef<number | null>(null);
  const activeHandleRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    if (!snapshot.focusSymbol) return;
    rowRefs.current.get(snapshot.focusSymbol)?.focus();
    store.clearFocus(snapshot.focusSymbol);
  }, [snapshot.focusSymbol, store]);

  function setRowRef(symbol: WatchlistSymbol) {
    return (node: HTMLLIElement | null) => {
      if (node) {
        rowRefs.current.set(symbol, node);
      } else {
        rowRefs.current.delete(symbol);
      }
    };
  }

  function dropIndexForY(clientY: number): number | null {
    const entries = snapshot.order
      .map((symbol) => rowRefs.current.get(symbol))
      .filter((row): row is HTMLLIElement => row !== undefined);
    const rowIndex = entries.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    });
    if (rowIndex >= 0) return rowIndex;
    const first = entries[0]?.getBoundingClientRect();
    if (first && clientY < first.top) return 0;
    return entries.length > 0 ? entries.length - 1 : null;
  }

  function releaseActivePointer() {
    const pointerId = activePointerRef.current;
    const handle = activeHandleRef.current;
    if (pointerId !== null && handle?.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    activePointerRef.current = null;
    activeHandleRef.current = null;
  }

  function cancelActiveDrag() {
    releaseActivePointer();
    store.cancelDrag();
  }

  useEffect(() => {
    let storage: StoragePort | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    store.hydrate(storage);

    return () => {
      releaseActivePointer();
      store.cancelDrag();
    };
  }, [store]);

  return (
    <section className="panel watchlist-panel" aria-label="Watchlist">
      <div className="panel-heading">
        <div>
          <h2>Watchlist</h2>
          <p>BTC-USD is the only live market.</p>
        </div>
      </div>
      <ol className="watchlist-list" aria-label="Watchlist">
        {snapshot.order.map((symbol, index) => {
          const selected = symbol === "BTC-USD";
          const dragging = snapshot.dragging === symbol;
          const dropTarget = snapshot.dropIndex === index && snapshot.dragging !== null;

          return (
            <li
              key={symbol}
              ref={setRowRef(symbol)}
              className={selected ? "watchlist-row selected" : "watchlist-row"}
              data-dragging={dragging ? "true" : undefined}
              data-drop-target={dropTarget ? "true" : undefined}
              tabIndex={-1}
              aria-label={`${symbol} ${selected ? "Selected Live" : "Preview"}`}
            >
              <button
                type="button"
                className="drag-handle"
                aria-label={`Drag ${symbol}`}
                onPointerDown={(event) => {
                  if (!event.isPrimary) return;
                  activePointerRef.current = event.pointerId;
                  activeHandleRef.current = event.currentTarget;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  store.startDrag(symbol);
                  store.updateDropIndex(index);
                }}
                onPointerMove={(event) => {
                  if (activePointerRef.current !== event.pointerId) return;
                  store.updateDropIndex(dropIndexForY(event.clientY));
                }}
                onPointerUp={(event) => {
                  if (activePointerRef.current !== event.pointerId) return;
                  releaseActivePointer();
                  store.endDrag(symbol);
                }}
                onPointerCancel={(event) => {
                  if (activePointerRef.current === event.pointerId) {
                    cancelActiveDrag();
                  }
                }}
                onLostPointerCapture={(event) => {
                  if (activePointerRef.current === event.pointerId) {
                    cancelActiveDrag();
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || snapshot.dragging !== symbol) return;
                  event.preventDefault();
                  event.stopPropagation();
                  cancelActiveDrag();
                }}
              >
                <span aria-hidden="true">::</span>
              </button>
              <span className="watchlist-symbol">{symbol}</span>
              <strong>{selected ? "Selected · Live" : "Preview"}</strong>
              <div className="watchlist-actions">
                <button
                  type="button"
                  className="icon-action watchlist-move"
                  aria-label={`Move ${symbol} up`}
                  disabled={index === 0}
                  onClick={() => store.move(symbol, index - 1)}
                >
                  <TriangleUpIcon aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-action watchlist-move"
                  aria-label={`Move ${symbol} down`}
                  disabled={index === snapshot.order.length - 1}
                  onClick={() => store.move(symbol, index + 1)}
                >
                  <TriangleDownIcon aria-hidden="true" />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="watchlist-status" role="status" aria-live="polite">{snapshot.announcement}</div>
    </section>
  );
}

function createWatchlistStore(): WatchlistStore {
  let storage: StoragePort | null = null;
  let state: WatchlistState = {
    order: [...defaultWatchlistOrder],
    announcement: "",
    dragging: null,
    dropIndex: null,
    focusSymbol: null,
  };
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) listener();
  }

  function setState(next: WatchlistState) {
    state = next;
    emit();
  }

  function save(order: readonly WatchlistSymbol[]) {
    if (!storage) return;
    try {
      storage.setItem(storageKey, JSON.stringify(order));
    } catch {
      storage = null;
    }
  }

  function commitMove(symbol: WatchlistSymbol, targetIndex: number) {
    const nextOrder = moveWatchlistItem(state.order, symbol, targetIndex);
    const position = nextOrder.indexOf(symbol);
    setState({
      ...state,
      order: nextOrder,
      announcement: `${symbol} moved to position ${position + 1} of ${nextOrder.length}`,
      dragging: null,
      dropIndex: null,
      focusSymbol: symbol,
    });
    save(nextOrder);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    hydrate(nextStorage) {
      storage = nextStorage;
      let saved: string | null = null;
      if (storage) {
        try {
          saved = storage.getItem(storageKey);
        } catch {
          storage = null;
        }
      }
      setState({ ...state, order: readWatchlistOrder(saved) });
    },
    move(symbol, targetIndex) {
      commitMove(symbol, targetIndex);
    },
    startDrag(symbol) {
      setState({ ...state, dragging: symbol, dropIndex: state.order.indexOf(symbol) });
    },
    updateDropIndex(index) {
      if (state.dropIndex === index) return;
      setState({ ...state, dropIndex: index });
    },
    endDrag(symbol) {
      if (state.dropIndex === null || state.dropIndex === state.order.indexOf(symbol)) {
        setState({ ...state, dragging: null, dropIndex: null });
        return;
      }
      commitMove(symbol, state.dropIndex);
    },
    cancelDrag() {
      setState({ ...state, dragging: null, dropIndex: null });
    },
    clearFocus(symbol) {
      if (state.focusSymbol !== symbol) return;
      state = { ...state, focusSymbol: null };
    },
  };
}
