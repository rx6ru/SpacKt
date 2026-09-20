type FormatKind = "time" | "timeZone" | "dateTimeZone" | "year" | "month" | "day" | "minute";

const locale = "en-US";
const fallbackZone = "UTC";
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function formatLocalTime(timeMs: number | null | undefined): string {
  if (timeMs === null || timeMs === undefined) return "-";
  return formatDate(timeMs, "time");
}

export function formatLocalTimeWithZone(timeMs: number | null | undefined): string {
  if (timeMs === null || timeMs === undefined) return "-";
  return formatDate(timeMs, "timeZone");
}

export function formatLocalDateTimeWithZone(timeMs: number | null | undefined): string {
  if (timeMs === null || timeMs === undefined) return "-";
  return formatDate(timeMs, "dateTimeZone");
}

export function formatLocalYear(timeMs: number | null | undefined): string {
  if (timeMs === null || timeMs === undefined) return "-";
  return formatDate(timeMs, "year");
}

export function formatLocalMonth(timeMs: number | null | undefined): string {
  if (timeMs === null || timeMs === undefined) return "-";
  return formatDate(timeMs, "month");
}

export function formatLocalDay(timeMs: number | null | undefined): string {
  if (timeMs === null || timeMs === undefined) return "-";
  return formatDate(timeMs, "day");
}

export function formatLocalMinute(timeMs: number | null | undefined): string {
  if (timeMs === null || timeMs === undefined) return "-";
  return formatDate(timeMs, "minute");
}

function formatDate(timeMs: number, kind: FormatKind): string {
  const date = new Date(timeMs);
  if (Number.isNaN(date.getTime())) return "-";
  return formatter(kind).format(date);
}

function formatter(kind: FormatKind): Intl.DateTimeFormat {
  const zone = viewerTimeZone();
  const key = `${zone}:${kind}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(locale, { ...options(kind), timeZone: zone });
  formatterCache.set(key, created);
  return created;
}

function options(kind: FormatKind): Intl.DateTimeFormatOptions {
  switch (kind) {
    case "time":
      return { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
    case "timeZone":
      return { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" };
    case "dateTimeZone":
      return { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" };
    case "year":
      return { year: "numeric" };
    case "month":
      return { month: "short" };
    case "day":
      return { month: "short", day: "2-digit" };
    case "minute":
      return { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  }
}

function viewerTimeZone(): string {
  try {
    return new Intl.DateTimeFormat(locale).resolvedOptions().timeZone || fallbackZone;
  } catch {
    return fallbackZone;
  }
}
