// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Watchlist } from "./watchlist";

const storageKey = "spackt.watchlist.v1";
const defaultOrder = ["BTC-USD", "ETH-USD", "SOL-USD", "LINK-USD", "AVAX-USD"];

function renderWatchlist() {
  render(<Watchlist />);
}

function watchlist() {
  return screen.getByRole("list", { name: "Watchlist" });
}

function rows(): HTMLElement[] {
  return within(watchlist()).getAllByRole("listitem");
}

function rowFor(symbol: string): HTMLElement {
  return within(watchlist()).getByRole("listitem", { name: new RegExp(symbol) });
}

function rowOrder(): string[] {
  return rows().map((row) => {
    const symbol = defaultOrder.find((candidate) => row.textContent?.includes(candidate));
    if (!symbol) {
      throw new Error(`row has no known symbol: ${row.textContent ?? ""}`);
    }
    return symbol;
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Watchlist", () => {
  it("renders five named watchlist rows", () => {
    renderWatchlist();

    expect(rowOrder()).toEqual(defaultOrder);
  });

  it("keeps BTC-USD selected and live after stored order changes its row position", async () => {
    window.localStorage.setItem(storageKey, JSON.stringify(["SOL-USD", "BTC-USD", "ETH-USD", "LINK-USD", "AVAX-USD"]));

    renderWatchlist();

    await waitFor(() => expect(rowOrder()).toEqual(["SOL-USD", "BTC-USD", "ETH-USD", "LINK-USD", "AVAX-USD"]), {
      timeout: 100,
    });
    const btcRow = rowFor("BTC-USD");
    expect(btcRow.textContent).toContain("Selected");
    expect(btcRow.textContent).toContain("Live");
  });

  it("marks the four non-BTC rows as preview rows without feed navigation", () => {
    renderWatchlist();

    for (const symbol of ["ETH-USD", "SOL-USD", "LINK-USD", "AVAX-USD"]) {
      const row = rowFor(symbol);
      expect(row.textContent).toContain("Preview");
      expect(within(row).queryByRole("link")).toBeNull();
    }
  });

  it("shows move up and move down controls for every row", () => {
    renderWatchlist();

    for (const symbol of defaultOrder) {
      const row = rowFor(symbol);
      expect(within(row).getByRole("button", { name: `Move ${symbol} up` })).toBeTruthy();
      expect(within(row).getByRole("button", { name: `Move ${symbol} down` })).toBeTruthy();
    }
  });

  it("disables movement controls at the list boundaries", () => {
    renderWatchlist();

    expect(within(rowFor("BTC-USD")).getByRole("button", { name: "Move BTC-USD up" }).hasAttribute("disabled")).toBe(true);
    expect(within(rowFor("AVAX-USD")).getByRole("button", { name: "Move AVAX-USD down" }).hasAttribute("disabled")).toBe(true);
  });

  it("moves a row when the user activates a move control", () => {
    renderWatchlist();

    fireEvent.click(within(rowFor("ETH-USD")).getByRole("button", { name: "Move ETH-USD down" }));

    expect(rowOrder()).toEqual(["BTC-USD", "SOL-USD", "ETH-USD", "LINK-USD", "AVAX-USD"]);
  });

  it("keeps focus inside the moved row after a keyboard move", () => {
    renderWatchlist();
    const moveButton = within(rowFor("ETH-USD")).getByRole("button", { name: "Move ETH-USD down" });
    moveButton.focus();

    fireEvent.click(moveButton);

    expect(rowFor("ETH-USD").contains(document.activeElement)).toBe(true);
  });

  it("announces the moved row position", () => {
    renderWatchlist();

    fireEvent.click(within(rowFor("ETH-USD")).getByRole("button", { name: "Move ETH-USD down" }));

    expect(screen.getByRole("status").textContent).toContain("ETH-USD moved to position 3 of 5");
  });

  it("applies a valid saved order after mount", async () => {
    window.localStorage.setItem(storageKey, JSON.stringify(["LINK-USD", "AVAX-USD", "BTC-USD", "ETH-USD", "SOL-USD"]));

    renderWatchlist();

    await waitFor(() => expect(rowOrder()).toEqual(["LINK-USD", "AVAX-USD", "BTC-USD", "ETH-USD", "SOL-USD"]), {
      timeout: 100,
    });
  });

  it("falls back to the default order when saved order is invalid", () => {
    window.localStorage.setItem(storageKey, JSON.stringify(["BTC-USD", "BTC-USD", "SOL-USD", "LINK-USD", "AVAX-USD"]));

    renderWatchlist();

    expect(rowOrder()).toEqual(defaultOrder);
  });

  it("does not overwrite a saved order with the default order before hydration", () => {
    window.localStorage.setItem(storageKey, JSON.stringify(["SOL-USD", "BTC-USD", "ETH-USD", "LINK-USD", "AVAX-USD"]));
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    renderWatchlist();

    expect(setItemSpy).not.toHaveBeenCalledWith(storageKey, JSON.stringify(defaultOrder));
  });

  it("still reorders in memory when storage read and write fail", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked storage read");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked storage write");
    });

    renderWatchlist();
    fireEvent.click(within(rowFor("ETH-USD")).getByRole("button", { name: "Move ETH-USD down" }));

    expect(rowOrder()).toEqual(["BTC-USD", "SOL-USD", "ETH-USD", "LINK-USD", "AVAX-USD"]);
  });

  it("still reorders in memory when the storage property is blocked", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked storage property", "SecurityError");
    });

    renderWatchlist();
    fireEvent.click(within(rowFor("ETH-USD")).getByRole("button", { name: "Move ETH-USD down" }));

    expect(rowOrder()).toEqual(["BTC-USD", "SOL-USD", "ETH-USD", "LINK-USD", "AVAX-USD"]);
  });

  it("provides a named drag handle for each row", () => {
    renderWatchlist();

    for (const symbol of defaultOrder) {
      expect(within(rowFor(symbol)).getByRole("button", { name: `Drag ${symbol}` })).toBeTruthy();
    }
  });
});
