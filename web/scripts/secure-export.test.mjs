import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { secureDirectory, secureHTML } from "./secure-export.mjs";

const apiOrigin = "https://api.spackt.example";
const wsOrigin = "wss://api.spackt.example";
const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("secureHTML", () => {
  it("adds the CSP meta before the first executable script", () => {
    const secured = secureHTML(pageHTML(`<script>console.log("boot")</script>`), apiOrigin);

    assert.ok(metaIndex(secured) >= 0);
    assert.ok(metaIndex(secured) < secured.indexOf("<script>"));
  });

  it("hashes inline scripts from their exact bytes", () => {
    const script = " console.log('x');\nconsole.log('y'); ";
    const secured = secureHTML(pageHTML(`<script>${script}</script>`), apiOrigin);

    assert.match(cspContent(secured), new RegExp(escapeRegExp(`'sha256-${sha256(script)}'`)));
    assert.ok(secured.includes(`<script>${script}</script>`));
  });

  it("keeps one hash when duplicate inline script bodies repeat", () => {
    const script = "console.log('same')";
    const secured = secureHTML(pageHTML(`<script>${script}</script><script>${script}</script>`), apiOrigin);
    const matches = cspContent(secured).match(new RegExp(escapeRegExp(`'sha256-${sha256(script)}'`), "g")) ?? [];

    assert.equal(matches.length, 1);
  });

  it("hashes each distinct inline script", () => {
    const first = "console.log('first')";
    const second = "console.log('second')";
    const secured = secureHTML(pageHTML(`<script>${first}</script><script>${second}</script>`), apiOrigin);
    const policy = cspContent(secured);

    assert.match(policy, new RegExp(escapeRegExp(`'sha256-${sha256(first)}'`)));
    assert.match(policy, new RegExp(escapeRegExp(`'sha256-${sha256(second)}'`)));
  });

  it("preserves external scripts without adding a hash for them", () => {
    const tag = `<script src="/_next/static/chunks/app.js"></script>`;
    const secured = secureHTML(pageHTML(tag), apiOrigin);

    assert.doesNotMatch(cspContent(secured), /sha256-/);
    assert.ok(secured.includes(tag));
  });

  it("permits only the configured HTTP and WebSocket connections", () => {
    const policy = cspContent(secureHTML(pageHTML(`<script>console.log("boot")</script>`), apiOrigin));

    assert.deepEqual(directiveTokens(policy, "connect-src"), [apiOrigin, wsOrigin]);
  });

  it("uses a ws connection source for an HTTP API origin", () => {
    const policy = cspContent(secureHTML(pageHTML(`<script>console.log("boot")</script>`), "http://localhost:8080"));

    assert.match(policy, directivePattern("connect-src", ["http://localhost:8080", "ws://localhost:8080"]));
  });

  it("does not permit unsafe inline or eval scripts", () => {
    const policy = cspContent(secureHTML(pageHTML(`<script>console.log("boot")</script>`), apiOrigin));
    const scriptSrc = directive(policy, "script-src");

    assert.doesNotMatch(scriptSrc, /'unsafe-inline'|'unsafe-eval'/);
  });

  it("keeps the required base policy directives", () => {
    const policy = cspContent(secureHTML(pageHTML(`<script>console.log("boot")</script>`), apiOrigin));

    assert.match(policy, directivePattern("default-src", ["'self'"]));
    assert.match(policy, directivePattern("object-src", ["'none'"]));
    assert.match(policy, directivePattern("base-uri", ["'none'"]));
    assert.match(policy, directivePattern("form-action", ["'none'"]));
    assert.match(policy, directivePattern("frame-src", ["'none'"]));
    assert.match(policy, directivePattern("img-src", ["'self'", "data:"]));
    assert.match(policy, directivePattern("font-src", ["'self'"]));
    assert.match(policy, directivePattern("style-src", ["'self'", "'unsafe-inline'"]));
  });

  it("writes one valid CSP meta whose decoded policy contains required directives", () => {
    const script = `console.log("boot")`;
    const secured = secureHTML(pageHTML(`<script>${script}</script>`), apiOrigin);
    const policy = cspContent(secured);

    assert.equal(cspMetaCount(secured), 1);
    assert.match(policy, directivePattern("script-src", ["'self'", `'sha256-${sha256(script)}'`]));
    assert.match(policy, directivePattern("connect-src", [apiOrigin, wsOrigin]));
    assert.match(policy, directivePattern("default-src", ["'self'"]));
  });

  it("throws when the API origin is invalid", () => {
    assert.throws(
      () => secureHTML(pageHTML(`<script>console.log("boot")</script>`), "https://api.spackt.example/path"),
      /origin|url|api/i,
    );
  });

  it("replaces one earlier generated policy when called again", () => {
    const once = secureHTML(pageHTML(`<script>console.log("boot")</script>`), apiOrigin);
    const twice = secureHTML(once, apiOrigin);

    assert.equal(cspMetaCount(twice), 1);
  });

  it("throws when the page has no head element", () => {
    assert.throws(() => secureHTML(`<main>No head</main>`, apiOrigin), /head/i);
  });
});

describe("secureDirectory", () => {
  it("updates nested HTML files and preserves non-HTML assets", async () => {
    const root = await tempDir();
    const nested = join(root, "nested");
    await mkdir(nested);
    await writeFile(join(root, "index.html"), pageHTML(`<script>console.log("index")</script>`));
    await writeFile(join(nested, "404.html"), pageHTML(`<script>console.log("not found")</script>`));
    await writeFile(join(root, "logo.svg"), "<svg></svg>");

    await secureDirectory(root, apiOrigin);

    assert.equal(cspMetaCount(await readFile(join(root, "index.html"), "utf8")), 1);
    assert.equal(cspMetaCount(await readFile(join(nested, "404.html"), "utf8")), 1);
    assert.equal(await readFile(join(root, "logo.svg"), "utf8"), "<svg></svg>");
  });

  it("rejects an invalid API origin before writing files", async () => {
    const root = await tempDir();
    const file = join(root, "index.html");
    const original = pageHTML(`<script>console.log("boot")</script>`);
    await writeFile(file, original);

    await assert.rejects(() => secureDirectory(root, "https://api.spackt.example/path"), /origin|url|api/i);
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("throws when the directory has no HTML files", async () => {
    const root = await tempDir();
    await writeFile(join(root, "readme.txt"), "asset only");

    await assert.rejects(() => secureDirectory(root, apiOrigin), /html/i);
  });

  it("does not follow symlinked directories", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(join(root, "index.html"), pageHTML(`<script>console.log("inside")</script>`));
    await writeFile(join(outside, "escape.html"), pageHTML(`<script>console.log("outside")</script>`));
    await symlink(outside, join(root, "linked"), "dir");

    await secureDirectory(root, apiOrigin);

    assert.equal(cspMetaCount(await readFile(join(root, "index.html"), "utf8")), 1);
    assert.equal(cspMetaCount(await readFile(join(outside, "escape.html"), "utf8")), 0);
  });
});

function pageHTML(headContent) {
  return `<!doctype html><html><head><title>SpacKt</title>${headContent}</head><body><main></main></body></html>`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("base64");
}

async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), "spackt-secure-export-"));
  tempRoots.push(root);
  return root;
}

function cspMetaCount(html) {
  return (html.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? []).length;
}

function metaIndex(html) {
  return html.search(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i);
}

function cspContent(html) {
  const meta = html.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i)?.[0];
  assert.ok(meta, "CSP meta is missing.");
  const raw = meta.match(/\bcontent=(["'])(.*?)\1/i)?.[2];
  assert.ok(raw, "CSP content is missing.");
  return decodeAttribute(raw);
}

function decodeAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function directive(policy, name) {
  return policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";
}

function directiveTokens(policy, name) {
  return directive(policy, name).split(/\s+/).slice(1);
}

function directivePattern(name, tokens) {
  const lookaheads = tokens.map((token) => `(?=[^;]*${escapeRegExp(token)})`).join("");
  return new RegExp(`${escapeRegExp(name)} ${lookaheads}[^;]*(?:;|$)`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
