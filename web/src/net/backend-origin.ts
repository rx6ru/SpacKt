export function normalizeBackendOrigin(value: string): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    !/^https?:\/\//.test(value) ||
    /[\\\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new Error("NEXT_PUBLIC_API_URL must be an HTTP or HTTPS origin.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_API_URL must be a valid absolute URL.");
  }

  const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/, 1)[0] ?? "";
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    authority.endsWith(":") ||
    url.pathname !== "/" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("NEXT_PUBLIC_API_URL must be an HTTP or HTTPS origin.");
  }

  return url.origin;
}

export function websocketOriginFromHTTP(origin: string): string {
  const normalized = normalizeBackendOrigin(origin);
  const url = new URL(normalized);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}
