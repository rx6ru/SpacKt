import { describe, expect, it } from "vitest";
import { normalizeBackendOrigin, websocketOriginFromHTTP } from "./backend-origin";

describe("backend origin normalization", () => {
  it.each([
    ["http://localhost:8080", "http://localhost:8080"],
    ["http://localhost:8080/", "http://localhost:8080"],
    ["https://api.spackt.example", "https://api.spackt.example"],
    ["https://api.spackt.example/", "https://api.spackt.example"],
  ])("accepts an HTTP origin with an optional final slash: %s", (input, expected) => {
    expect(normalizeBackendOrigin(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "ws://localhost:8080",
    "wss://api.spackt.example",
    "http://user:pass@localhost:8080",
    "http://localhost:bad",
    "http://localhost:",
    "http://localhost:8080?",
    "http://localhost:8080#",
    "http://localhost:8080/api",
    "http://localhost:8080?debug=true",
    "http://localhost:8080#health",
    "http://localhost:8080\t",
    "https://api.spackt.example\n",
    "https://api.spackt.example/path\n",
    "ftp://api.spackt.example",
    "//api.spackt.example",
    "http:api.spackt.example",
    "http:/api.spackt.example",
    "http:\\api.spackt.example",
    "https:\\\\api.spackt.example",
    "localhost:8080",
  ])("rejects a value that is not a public HTTP origin: %s", (input) => {
    expect(() => normalizeBackendOrigin(input)).toThrow(/origin|url|api/i);
  });
});

describe("backend WebSocket origin", () => {
  it.each([
    ["http://localhost:8080", "ws://localhost:8080"],
    ["https://api.spackt.example", "wss://api.spackt.example"],
  ])("derives the WebSocket origin from %s", (input, expected) => {
    const origin = normalizeBackendOrigin(input);

    expect(websocketOriginFromHTTP(origin)).toBe(expected);
  });
});
