import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const generatedPolicyPattern =
  /<meta\b(?=[^>]*\bdata-spackt-csp=["']1["'])(?=[^>]*\bhttp-equiv=["']Content-Security-Policy["'])[^>]*>\s*/gi;

export function secureHTML(html, apiOrigin) {
  const origin = normalizeBackendOrigin(apiOrigin);
  const websocketOrigin = websocketOriginFromHTTP(origin);
  const htmlWithoutOldPolicy = html.replace(generatedPolicyPattern, "");
  const headMatch = htmlWithoutOldPolicy.match(/<head\b[^>]*>/i);

  if (!headMatch || headMatch.index === undefined) {
    throw new Error("HTML page must contain a head element.");
  }

  const hashes = inlineScriptHashes(htmlWithoutOldPolicy);
  const policy = buildPolicy(origin, websocketOrigin, hashes);
  const meta = `<meta data-spackt-csp="1" http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`;
  const insertAt = headMatch.index + headMatch[0].length;

  return `${htmlWithoutOldPolicy.slice(0, insertAt)}${meta}${htmlWithoutOldPolicy.slice(insertAt)}`;
}

export async function secureDirectory(directory, apiOrigin) {
  const origin = normalizeBackendOrigin(apiOrigin);
  const htmlFiles = await collectHTMLFiles(directory);

  if (htmlFiles.length === 0) {
    throw new Error("Static export directory must contain at least one HTML file.");
  }

  const securedFiles = await Promise.all(
    htmlFiles.map(async (file) => ({
      file,
      html: secureHTML(await readFile(file, "utf8"), origin),
    })),
  );

  await Promise.all(securedFiles.map(({ file, html }) => writeFile(file, html)));
}

function normalizeBackendOrigin(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !/^https?:\/\//.test(value) ||
    /[\\\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new Error("NEXT_PUBLIC_API_URL must be an HTTP or HTTPS origin.");
  }

  let url;
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

function websocketOriginFromHTTP(origin) {
  const url = new URL(normalizeBackendOrigin(origin));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

function inlineScriptHashes(html) {
  const hashes = new Set();
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptPattern.exec(html)) !== null) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    if (hasScriptSourceAttribute(attributes)) {
      continue;
    }
    hashes.add(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
  }

  return [...hashes];
}

function hasScriptSourceAttribute(attributes) {
  let index = 0;

  while (index < attributes.length) {
    while (/\s/.test(attributes[index] ?? "")) {
      index += 1;
    }

    const nameStart = index;
    while (index < attributes.length && !/[\s=/>]/.test(attributes[index])) {
      index += 1;
    }
    if (nameStart === index) {
      index += 1;
      continue;
    }

    const name = attributes.slice(nameStart, index).toLowerCase();
    while (/\s/.test(attributes[index] ?? "")) {
      index += 1;
    }

    if (attributes[index] === "=") {
      index += 1;
      while (/\s/.test(attributes[index] ?? "")) {
        index += 1;
      }

      const quote = attributes[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        while (index < attributes.length && attributes[index] !== quote) {
          index += 1;
        }
        if (attributes[index] === quote) {
          index += 1;
        }
      } else {
        while (index < attributes.length && !/[\s>]/.test(attributes[index])) {
          index += 1;
        }
      }
    }

    if (name === "src") {
      return true;
    }
  }

  return false;
}

function buildPolicy(apiOrigin, websocketOrigin, scriptHashes) {
  const directives = [
    ["default-src", "'self'"],
    ["script-src", "'self'", ...scriptHashes],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:"],
    ["font-src", "'self'"],
    ["connect-src", apiOrigin, websocketOrigin],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'none'"],
    ["frame-src", "'none'"],
  ];

  return directives.map((tokens) => tokens.join(" ")).join("; ");
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function collectHTMLFiles(directory) {
  const files = [];
  await collectHTMLFilesInto(directory, files);
  return files;
}

async function collectHTMLFilesInto(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        return;
      }
      if (stats.isDirectory()) {
        await collectHTMLFilesInto(path, files);
        return;
      }
      if (stats.isFile() && entry.name.toLowerCase().endsWith(".html")) {
        files.push(path);
      }
    }),
  );
}

async function main() {
  const directory = process.argv[2] ?? "out";
  const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
  await secureDirectory(directory, apiOrigin);
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
